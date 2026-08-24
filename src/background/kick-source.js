// Kick chat via their Pusher WebSocket (anonymous, read-only).
(function (FCM) {
  'use strict';

  const KICK_PING_MS = 4 * 60 * 1000;

  FCM.kickSource = {
    /**
     * @param {object|null} auth { token } for a connected account. Kick reports
     *   whether this viewer moderates the channel only on an authenticated
     *   read of the channel record, so the token is used when there is one.
     */
    async connect(channel, sink, conn, auth) {
      // See twitch-source for why a shared flag is not enough: close() is
      // asynchronous, so the previous socket's onclose runs after this call has
      // reset the flag and would schedule a reconnect to the old channel.
      // This matters more here, because the channel lookup below is awaited,
      // leaving a much wider window for a second switch to arrive.
      const generation = (conn.generation || 0) + 1;
      conn.generation = generation;
      const current = () => conn.generation === generation;

      if (conn.ws) {
        try { conn.ws.close(); } catch (e) { /* already gone */ }
      }
      if (conn.retryTimer) { clearTimeout(conn.retryTimer); conn.retryTimer = null; }
      conn.forceClose = false;
      conn.channel = channel;
      conn.auth = auth || null;

      sink.status('connecting');
      sink.sys(`Connecting to Kick: ${channel}...`);

      const info = await FCM.kickApi.channel(channel, {
        token: conn.auth ? conn.auth.token : null,
      });
      // The channel may have changed entirely while that was in flight.
      if (!current()) return;
      if (!info) {
        sink.sys('Kick: could not load channel information');
        sink.status('error');
        return;
      }
      const chatroomId = info.chatroom?.id;
      if (!chatroomId) {
        sink.sys('Kick: could not find that channel');
        sink.status('error');
        return;
      }
      const channelId = info.id || info.channel_id || null;
      conn.chatroomId = chatroomId;
      // A late resolve must not open a socket the caller has already dropped.
      if (conn.forceClose || !current()) return;

      sink.roomId(String(info.user_id || channelId || ''));

      // Kick marks the viewer's own standing on the channel record, and the
      // broadcaster always moderates their own room.
      const me = FCM.normalizeChannel(conn.auth ? conn.auth.login : '');
      sink.moderator(!!conn.auth && (
        (me && me === FCM.normalizeChannel(info.slug || channel))
        || info.is_moderator === true
        || (info.chatroom && (
          info.chatroom.is_moderator === true
          || info.chatroom.is_current_user_moderator === true
        ))
      ));

      let ws;
      try {
        ws = new WebSocket(FCM.KICK_PUSHER_URL);
      } catch (e) {
        sink.sys(`Kick: could not open a connection (${e.message})`);
        sink.status('error');
        return;
      }
      conn.ws = ws;

      ws.onmessage = (e) => {
        if (!current()) return;
        const msg = FCM.safeJsonParse(e.data, null);
        if (!msg || !msg.event) return;

        if (msg.event === 'pusher:connection_established') {
          ws.send(JSON.stringify({
            event: 'pusher:subscribe',
            data: { auth: '', channel: `chatrooms.${chatroomId}.v2` },
          }));
          if (channelId) {
            ws.send(JSON.stringify({
              event: 'pusher:subscribe',
              data: { auth: '', channel: `channel.${channelId}` },
            }));
          }
          conn.attempt = 0;
          sink.status('connected');
          sink.sys(`Connected to Kick: ${channel}`);
          // Idle rooms otherwise get dropped by Pusher's inactivity timeout.
          if (conn.pingTimer) clearInterval(conn.pingTimer);
          conn.pingTimer = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
          }, KICK_PING_MS);
          sink.joined(chatroomId);
          return;
        }

        if (msg.event === 'pusher:ping') {
          ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
          return;
        }
        if (FCM.isPusherProtocolEvent(msg.event)) return;

        const payload = FCM.safeJsonParse(msg.data, {});

        if (msg.event === 'App\\Events\\MessageDeletedEvent') {
          const deletedId = (payload && payload.message && payload.message.id) || (payload && payload.id);
          if (deletedId) sink.deleteMsg(deletedId);
          return;
        }
        if (msg.event === 'App\\Events\\UserBannedEvent') {
          const banned = FCM.usernameFrom(payload && payload.user)
            || FCM.usernameFrom(payload && payload.banned_user);
          if (banned) sink.deleteUser(banned);
        }

        if (msg.event !== 'App\\Events\\ChatMessageEvent') {
          const summary = FCM.formatKickEventSummary(msg.event, payload || {});
          if (summary) sink.event(summary);
          return;
        }

        const text = payload.content || '';
        if (!text) return;
        const badges = (payload.sender && payload.sender.identity && payload.sender.identity.badges) || [];

        // Emotes seen in a live message top up the store, so one posted before
        // the full list finishes loading still renders as an image.
        const learned = {};
        if (Array.isArray(payload.emotes)) {
          payload.emotes.forEach((em) => {
            if (em && em.id && em.name) {
              learned[em.name] = {
                url: `https://files.kick.com/emotes/${em.id}/fullsize`,
                source: 'Kick Channel',
              };
            }
          });
        }
        for (const m of text.matchAll(/\[emote:(\d+):([^\]]+)\]/g)) {
          const id = m[1];
          const name = m[2];
          if (!learned[name]) {
            learned[name] = { url: `https://files.kick.com/emotes/${id}/fullsize`, source: 'Kick Channel' };
          }
        }
        if (Object.keys(learned).length) sink.emotes('native', learned);

        sink.chat({
          platform: 'kick',
          author: (payload.sender && payload.sender.username) || 'unknown',
          text,
          color: (payload.sender && payload.sender.identity && payload.sender.identity.color) || '',
          badgesRaw: badges,
          badgeClass: FCM.kickBadgeClass(badges),
          messageId: payload.id || payload.message_id || null,
          userId: (payload.sender && (payload.sender.id || payload.sender.user_id)) || null,
          emotes: payload.emotes || [],
          timestamp: payload.created_at ? Date.parse(payload.created_at) : null,
        });
      };

      ws.onerror = () => { if (current()) sink.sys('Kick: connection error'); };

      ws.onclose = () => {
        if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
        if (conn.ws === ws) conn.ws = null;
        // Superseded by a newer socket: say nothing, retry nothing.
        if (!current()) return;
        if (conn.forceClose) return;
        sink.status('disconnected');
        sink.sys('Kick: disconnected');
        if ((conn.attempt || 0) >= FCM.MAX_RECONNECT_ATTEMPTS) {
          sink.sys('Kick: reconnect limit reached (reconnect from the overlay to retry)');
          return;
        }
        const delay = FCM.backoffDelay(conn.attempt || 0);
        sink.sys(`Kick: reconnecting in ${Math.round(delay / 1000)}s...`);
        conn.retryTimer = setTimeout(() => {
          if (!current() || conn.forceClose || conn.channel !== channel) return;
          conn.attempt = (conn.attempt || 0) + 1;
          FCM.kickSource.connect(channel, sink, conn, conn.auth);
        }, delay);
      };
    },

    disconnect(conn) {
      // Retiring the generation makes every handler still attached to the
      // outgoing socket inert, whatever order they fire in.
      conn.generation = (conn.generation || 0) + 1;
      conn.forceClose = true;
      if (conn.retryTimer) { clearTimeout(conn.retryTimer); conn.retryTimer = null; }
      if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
      if (conn.ws) { try { conn.ws.close(); } catch (e) { /* already gone */ } conn.ws = null; }
    },

    async fetchHistory(chatroomId, sink, limit) {
      try {
        const r = await fetch(
          `https://kick.com/api/v2/channels/${encodeURIComponent(chatroomId)}/messages?limit=${limit}`
        );
        if (!r.ok) return;
        const data = await r.json();
        const messages = (data.data && data.data.messages) || data.messages || [];
        if (!messages.length) return;

        const rows = [];
        // Kick returns newest first; reverse so the oldest ends up at the top.
        [...messages].reverse().forEach((msg) => {
          const text = msg.content || '';
          if (!text) return;
          const sender = msg.sender || (msg.metadata && msg.metadata.sender) || {};
          const badges = (sender.identity && sender.identity.badges) || [];
          rows.push({
            platform: 'kick',
            author: sender.username || 'unknown',
            text,
            color: (sender.identity && sender.identity.color) || '',
            badgesRaw: badges,
            badgeClass: FCM.kickBadgeClass(badges),
            messageId: msg.id || msg.message_id || null,
            userId: sender.id || sender.user_id || null,
            emotes: msg.emotes || (msg.metadata && msg.metadata.emotes) || [],
            timestamp: msg.created_at ? Date.parse(msg.created_at) : null,
            history: true,
          });
        });

        if (rows.length) {
          sink.sys(`Loaded ${rows.length} Kick history messages`);
          sink.batch(rows);
        }
      } catch (e) {
        // History is optional; the live feed carries on without it.
      }
    },
  };
})(self.FCM);
