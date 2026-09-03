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

      // Kick's edge refuses plenty of requests that did not come from a tab,
      // so a lookup that failed is usually temporary and worth asking again.
      // A retry has to actually ask, though: a failed lookup is remembered as
      // "no such channel" for longer than the first few backoffs, and answering
      // the retry from that would make every attempt fail the same way.
      const info = await FCM.kickApi.channel(channel, {
        token: conn.auth ? conn.auth.token : null,
        maxAge: conn.attempt ? 0 : FCM.LIVE_CACHE_TTL_MS,
      });
      // The channel may have changed entirely while that was in flight.
      if (!current()) return;

      /**
       * Tries again later, on the same terms a dropped socket gets.
       *
       * Everything before the socket exists used to give up permanently on the
       * first failure, while the status chip went on saying it was trying —
       * so the Kick half of the feed was silent for the life of the page and
       * nothing said why.
       */
      const retryLater = (why) => {
        if ((conn.attempt || 0) >= FCM.MAX_RECONNECT_ATTEMPTS) {
          sink.sys(`Kick: ${why} — giving up (reconnect from the overlay to retry)`);
          sink.status('error');
          return;
        }
        const delay = FCM.backoffDelay(conn.attempt || 0);
        sink.status('disconnected');
        sink.sys(`Kick: ${why} — trying again in ${Math.round(delay / 1000)}s...`);
        conn.retryTimer = setTimeout(() => {
          if (!current() || conn.forceClose || conn.channel !== channel) return;
          conn.attempt = (conn.attempt || 0) + 1;
          FCM.kickSource.connect(channel, sink, conn, conn.auth);
        }, delay);
      };

      if (!info) {
        retryLater('could not load channel information');
        return;
      }
      const chatroomId = info.chatroom?.id;
      if (!chatroomId) {
        // The channel loaded and has no chatroom. That is an answer rather than
        // a failure, and asking again will not change it.
        sink.sys('Kick: could not find that channel');
        sink.status('error');
        return;
      }
      const channelId = info.id || info.channel_id || null;
      conn.chatroomId = chatroomId;
      // Kept because the history endpoint is keyed by it and by nothing else
      // this connection holds; see fetchHistory for why the two ids are not
      // interchangeable.
      conn.channelId = channelId;
      // What a subscriber's badge looks like here, by months. Sent to the view
      // once the room is joined; it is the one badge Kick draws from a picture
      // the channel chose rather than an icon of its own.
      conn.subscriberBadges = FCM.kickSubscriberBadges(info);
      // A late resolve must not open a socket the caller has already dropped.
      if (conn.forceClose || !current()) return;

      sink.roomId(String(info.user_id || channelId || ''));

      // The one thing this record can settle: the broadcaster always moderates
      // their own room, and their name is the channel's name.
      //
      // It cannot settle anything about an ordinary moderator. This record
      // describes the channel rather than the person reading it, and Kick will
      // only say who *you* are in a room to the browser session that asks — so
      // an ordinary moderator is answered by `loadKickStanding` in the worker,
      // which asks through the tab. Kick has been known to mark these flags on
      // a channel record all the same, so they are still read here.
      //
      // Raised only, never lowered. The flag starts false on every join, and a
      // `false` from here would arrive after a reconnect and undo the answer
      // the page had already given — taking a moderator's tools away mid-stream
      // and putting the "tools enabled" line in the feed a second time when
      // they came back.
      const me = FCM.normalizeChannel(conn.auth ? conn.auth.login : '');
      const ownRoom = !!(me && me === FCM.normalizeChannel(info.slug || channel));
      const marked = info.is_moderator === true
        || (info.chatroom && (
          info.chatroom.is_moderator === true
          || info.chatroom.is_current_user_moderator === true
        ));
      if (conn.auth && (ownRoom || marked)) sink.moderator(true);

      let ws;
      try {
        ws = new WebSocket(FCM.KICK_PUSHER_URL);
      } catch (e) {
        retryLater(`could not open a connection (${e.message})`);
        return;
      }
      conn.ws = ws;
      // This socket's own keepalive. Kept in the closure as well as on `conn`
      // so a close arriving after a newer socket has installed its own cannot
      // stop the live one pinging — Pusher drops a room that goes quiet.
      let myPing = null;

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
          // Noted, not forgiven; see the close handler.
          conn.connectedAt = Date.now();
          sink.status('connected');
          sink.sys(`Connected to Kick: ${channel}`);
          // Idle rooms otherwise get dropped by Pusher's inactivity timeout.
          if (conn.pingTimer) clearInterval(conn.pingTimer);
          myPing = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
          }, KICK_PING_MS);
          conn.pingTimer = myPing;
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
        const badges = FCM.kickBadgeList(payload.sender && payload.sender.identity);

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
          reply: FCM.kickReplyContext(payload),
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
        // This socket's keepalive, not whatever is on `conn` now.
        if (myPing) {
          clearInterval(myPing);
          if (conn.pingTimer === myPing) conn.pingTimer = null;
          myPing = null;
        }
        if (conn.ws === ws) conn.ws = null;
        // Superseded by a newer socket: say nothing, retry nothing.
        if (!current()) return;
        if (conn.forceClose) return;
        // A connection that stayed up starts the next backoff from scratch; one
        // that fell over immediately does not, so a room that will not hold is
        // retried more and more slowly and eventually left alone.
        if (conn.connectedAt && Date.now() - conn.connectedAt >= FCM.STABLE_CONNECTION_MS) {
          conn.attempt = 0;
        }
        conn.connectedAt = 0;
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

    /**
     * The last few messages of a channel's chat, replayed into the feed.
     *
     * Keyed by the channel's own id — the `id` on the channel record — and not
     * by the chatroom's, which is a different number and the one everything
     * else here uses: the Pusher room is `chatrooms.<chatroom id>.v2`, so the
     * chatroom id was the id in hand and the one this asked with. Kick answers
     * that with `200 OK` and an empty list rather than an error, so there was
     * nothing to notice: no history arrived, nothing said why, and the feed
     * after a reload started blank while Twitch's filled in beside it.
     *
     * @param {number|string} channelId the channel's id, not the chatroom's
     */
    async fetchHistory(channelId, sink, limit) {
      if (!channelId) return;
      try {
        const r = await fetch(
          `https://kick.com/api/v2/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`
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
          const badges = FCM.kickBadgeList(sender.identity);
          rows.push({
            platform: 'kick',
            author: sender.username || 'unknown',
            text,
            reply: FCM.kickReplyContext(msg),
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
