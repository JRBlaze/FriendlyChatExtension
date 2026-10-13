// Kick chat via their Pusher WebSocket (anonymous, read-only).
(function (FCM) {
  'use strict';

  // Stay below Chrome's worker idle window and honor a shorter server timeout.
  const KICK_PING_MS = 25 * 1000;
  const KICK_PONG_MS = 30 * 1000;

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

      if (conn.realtimeCleanup) { conn.realtimeCleanup(); conn.realtimeCleanup = null; }

      if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
      if (conn.pongTimer) { clearTimeout(conn.pongTimer); conn.pongTimer = null; }
      if (conn.ws) {
        try { conn.ws.close(); } catch (e) { /* already gone */ }
      }
      if (conn.retryTimer) { clearTimeout(conn.retryTimer); conn.retryTimer = null; }
      conn.forceClose = false;
      conn.connectedAt = 0;
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
        const exhausted = (conn.attempt || 0) >= FCM.MAX_RECONNECT_ATTEMPTS;
        const delay = exhausted ? FCM.RECONNECT_COOLDOWN_MS : FCM.backoffDelay(conn.attempt || 0);
        sink.status('disconnected');
        sink.sys(exhausted
          ? `Kick: ${why}; reconnect limit reached — retrying in 5 minutes (or reconnect from the overlay now)`
          : `Kick: ${why} — trying again in ${Math.round(delay / 1000)}s...`);
        conn.retryTimer = setTimeout(() => {
          if (!current() || conn.forceClose || conn.channel !== channel) return;
          conn.retryTimer = null;
          conn.attempt = exhausted ? 0 : (conn.attempt || 0) + 1;
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

      // Kick can retire its public Pusher app. Negotiate a current Pusher app
      // after that rejection; this provider accepts browser-extension origins.
      // The descriptor is anonymous and contains no account credentials.
      let request = null, requestTimer = null;
      conn.realtimeCleanup = () => {
        if (request) request.abort();
        if (requestTimer) clearTimeout(requestTimer);
      };
      let socketUrl = FCM.KICK_PUSHER_URL;
      if (conn.useRealtime) {
        try {
          conn.realtimeClientId = conn.realtimeClientId || crypto.randomUUID();
          const route = channelId ? '/channels/' + encodeURIComponent(channelId) + '/chat/connection' : '/connection';
          const controller = new AbortController();
          request = controller;
          requestTimer = setTimeout(() => controller.abort(), 10000);
          const response = await fetch('https://web.kick.com/api/v1/realtime' + route, {
            method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
            headers: { 'Content-Type': 'application/json' }, signal: request.signal,
            body: JSON.stringify({
              client: { id: conn.realtimeClientId, type: 'web' },
              capabilities: { accepted_providers: [{ provider: 'pusher' }] },
            }),
          });
          if (!response.ok) throw new Error('realtime request refused');
          const descriptor = (await response.json()).data;
          if (!current() || conn.forceClose) return;
          const app = descriptor && descriptor.mode === 'websocket' && Array.isArray(descriptor.connections)
            && descriptor.connections.find(item => item && item.provider === 'pusher');
          const credentials = app && app.credentials;
          if (!credentials || typeof credentials.app_key !== 'string' || !/^[a-zA-Z0-9]+$/.test(credentials.app_key)
              || typeof credentials.cluster !== 'string' || !/^[a-z0-9-]+$/.test(credentials.cluster)) {
            throw new Error('invalid Pusher descriptor');
          }
          socketUrl = 'wss://ws-' + credentials.cluster + '.pusher.com/app/' + credentials.app_key
            + '?protocol=7&client=js&version=7.4.0&flash=false';
        } catch (e) {
          // Do not log response bodies or arbitrary server/error text.
          if (current() && !conn.forceClose) retryLater('could not prepare the current chat connection');
          return;
        } finally {
          clearTimeout(requestTimer);
          requestTimer = null;
          request = null;
        }
      }

      let ws;
      try {
        ws = new WebSocket(socketUrl);
      } catch (e) {
        retryLater(`could not open a connection (${e.message})`);
        return;
      }
      conn.ws = ws;
      // This socket's own keepalive. Kept in the closure as well as on `conn`
      // so a close arriving after a newer socket has installed its own cannot
      // stop the live one pinging — Pusher drops a room that goes quiet.
      let myPing = null;
      let myPong = null;
      let switchingTransport = false;
      const clearPong = () => {
        if (!myPong) return;
        clearTimeout(myPong);
        if (conn.pongTimer === myPong) conn.pongTimer = null;
        myPong = null;
      };

      ws.onmessage = (e) => {
        if (!current()) return;
        const msg = FCM.safeJsonParse(e.data, null);
        if (!msg || !msg.event) return;
        // Any valid server event proves liveness, including chat in a busy room.
        clearPong();

        if (msg.event === 'pusher:error') {
          const error = typeof msg.data === 'string' ? FCM.safeJsonParse(msg.data, {}) : msg.data;
          if (error && error.code === 4001 && !conn.useRealtime) {
            conn.useRealtime = true;
            switchingTransport = true;
            sink.sys('Kick: chat service changed — switching to its current connection');
          } else {
            sink.sys('Kick: chat connection rejected');
          }
          ws.close();
          return;
        }

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
          // Pusher advertises this in seconds. Missing or invalid values use a
          // safe default; a longer value must not let Chrome idle the worker.
          const details = FCM.safeJsonParse(msg.data, {});
          const activity = details && details.activity_timeout;
          const pingMs = typeof activity === 'number' && Number.isFinite(activity) && activity > 0
            ? Math.min(KICK_PING_MS, activity * 1000) : KICK_PING_MS;
          if (conn.pingTimer) clearInterval(conn.pingTimer);
          myPing = setInterval(() => {
            if (!current() || ws.readyState !== WebSocket.OPEN || myPong) return;
            ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
            // A socket can stay OPEN after the network disappears. Do not keep
            // postponing this deadline with more pings and display green forever.
            myPong = setTimeout(() => {
              if (!current()) return;
              sink.sys('Kick: connection timed out — reconnecting');
              ws.close();
            }, KICK_PONG_MS);
            conn.pongTimer = myPong;
          }, pingMs);
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
        //
        // The label on one is a guess, and is marked as one. A message carries
        // an emote's id and its name and says nothing about which set it came
        // from, so "this channel's" is only the likeliest answer — and for a
        // collectible it is the wrong one. The real list knows, and is allowed
        // to correct a guess when it lands.
        const learned = {};
        const guess = (id, name) => {
          learned[name] = {
            url: `https://files.kick.com/emotes/${id}/fullsize`,
            source: 'Kick Channel',
            learned: true,
          };
        };
        if (Array.isArray(payload.emotes)) {
          payload.emotes.forEach((em) => {
            if (em && em.id && em.name) guess(em.id, em.name);
          });
        }
        for (const m of text.matchAll(/\[emote:(\d+):([^\]]+)\]/g)) {
          const id = m[1];
          const name = m[2];
          if (!learned[name]) guess(id, name);
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
        if (current() && conn.ws === ws && conn.realtimeCleanup) { conn.realtimeCleanup(); conn.realtimeCleanup = null; }
        clearPong();
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
        // retried more slowly, then paused before the next bounded retry cycle.
        if (conn.connectedAt && Date.now() - conn.connectedAt >= FCM.STABLE_CONNECTION_MS) {
          conn.attempt = 0;
        }
        conn.connectedAt = 0;
        sink.status('disconnected');
        sink.sys('Kick: disconnected');
        const exhausted = (conn.attempt || 0) >= FCM.MAX_RECONNECT_ATTEMPTS;
        const delay = switchingTransport ? 0 : exhausted ? FCM.RECONNECT_COOLDOWN_MS : FCM.backoffDelay(conn.attempt || 0);
        sink.sys(exhausted
          ? 'Kick: reconnect limit reached — retrying in 5 minutes (or reconnect from the overlay now)'
          : `Kick: reconnecting in ${Math.round(delay / 1000)}s...`);
        conn.retryTimer = setTimeout(() => {
          if (!current() || conn.forceClose || conn.channel !== channel) return;
          conn.retryTimer = null;
          conn.attempt = exhausted ? 0 : (conn.attempt || 0) + 1;
          FCM.kickSource.connect(channel, sink, conn, conn.auth);
        }, delay);
      };
    },

    disconnect(conn) {
      // Retiring the generation makes every handler still attached to the
      // outgoing socket inert, whatever order they fire in.
      conn.generation = (conn.generation || 0) + 1;
      conn.forceClose = true;
      if (conn.realtimeCleanup) { conn.realtimeCleanup(); conn.realtimeCleanup = null; }
      if (conn.retryTimer) { clearTimeout(conn.retryTimer); conn.retryTimer = null; }
      if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = null; }
      if (conn.pongTimer) { clearTimeout(conn.pongTimer); conn.pongTimer = null; }
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
