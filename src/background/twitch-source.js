// Twitch IRC-over-WebSocket source. Runs in the service worker so it is immune
// to the host page's connect-src CSP and works identically from a kick.com tab.
(function (FCM) {
  'use strict';

  FCM.twitchSource = {
    /**
     * @param {string} channel      channel login, already normalized
     * @param {object} sink         the narrow surface the worker exposes
     * @param {object} conn         mutable connection record owned by the caller
     * @param {object|null} auth    { token, login } for a connected account.
     *   Reading chat needs no account, but Twitch only sends USERSTATE — the
     *   one thing that says whether this viewer can moderate — on an
     *   authenticated connection, so the token is used when there is one.
     */
    connect(channel, sink, conn, auth) {
      if (conn.ws) {
        try { conn.forceClose = true; conn.ws.close(); } catch (e) { /* already gone */ }
      }
      conn.forceClose = false;
      conn.channel = channel;
      conn.auth = auth || null;

      sink.status('connecting');
      let ws;
      try {
        ws = new WebSocket(FCM.TWITCH_IRC_URL);
      } catch (e) {
        sink.sys(`Twitch: could not open a connection (${e.message})`);
        sink.status('error');
        return;
      }
      conn.ws = ws;

      ws.onopen = () => {
        // Tags and commands must be requested before JOIN or PRIVMSG lines
        // arrive without @badges / @emotes / @display-name.
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        if (conn.auth && conn.auth.token && conn.auth.login) {
          ws.send(`PASS oauth:${conn.auth.token}`);
          ws.send(`NICK ${conn.auth.login}`);
        } else {
          // Twitch's anonymous read-only login: any justinfanNNNN nick. It is
          // randomised so two tabs never collide on the same connection.
          const nick = `justinfan${Math.floor(10000 + Math.random() * 80000)}`;
          ws.send(`PASS oauth:${nick}`);
          ws.send(`NICK ${nick}`);
        }
        ws.send(`JOIN #${channel}`);
      };

      ws.onmessage = (e) => {
        String(e.data).split('\r\n').filter((l) => l.trim()).forEach((raw) => {
          const { tags, prefix, command, params } = FCM.parseIrcLine(raw);

          if (command === 'PING') { ws.send('PONG :tmi.twitch.tv'); return; }
          if (command === 'RECONNECT') {
            sink.sys('Twitch: server asked us to reconnect');
            try { ws.close(); } catch (_) { /* closing anyway */ }
            return;
          }

          if (command === 'NOTICE') {
            const noticeText = params[params.length - 1] || '';
            // A stale token would otherwise leave the feed silently empty, so
            // drop the credentials and come back anonymously.
            if (/login authentication failed|improperly formatted auth/i.test(noticeText)) {
              sink.sys('Twitch: sign-in was rejected — reading chat anonymously');
              sink.authRejected();
              conn.auth = null;
              conn.forceClose = true;
              try { ws.close(); } catch (e) { /* already closing */ }
              conn.forceClose = false;
              setTimeout(() => {
                if (conn.channel === channel) FCM.twitchSource.connect(channel, sink, conn, null);
              }, 400);
              return;
            }
            if (noticeText) sink.sys(`Twitch: ${noticeText}`);
            return;
          }

          // USERSTATE arrives after JOIN on an authenticated connection and is
          // what tells us whether this viewer can moderate here.
          if (command === 'USERSTATE' || command === 'GLOBALUSERSTATE') {
            const badgeTag = tags.badges || '';
            sink.moderator(
              tags.mod === '1'
              || badgeTag.includes('broadcaster/')
              || badgeTag.includes('moderator/')
            );
            return;
          }

          if (command === 'CLEARCHAT') {
            const target = params[1] || '';
            if (target) {
              sink.deleteUser(target);
              const seconds = tags['ban-duration'];
              sink.event(seconds
                ? `${target} was timed out for ${seconds}s.`
                : `${target} was banned.`);
            } else {
              sink.event('Chat was cleared by a moderator.');
            }
            return;
          }

          if (command === 'CLEARMSG') {
            const targetId = tags['target-msg-id'];
            if (targetId) sink.deleteMsg(targetId);
            return;
          }

          if (command === 'ROOMSTATE') {
            if (tags['room-id']) sink.roomId(tags['room-id']);
            return;
          }

          // 366 = end of NAMES, i.e. the JOIN completed.
          if (command === '366') {
            conn.attempt = 0;
            sink.status('connected');
            sink.sys(`Connected to Twitch: ${channel}`);
            sink.joined();
            return;
          }

          if (command === 'USERNOTICE') {
            const notice = FCM.twitchUserNoticeSummary(tags, (params[1] || '').trim());
            if (notice) sink.event(notice);
            return;
          }

          if (command !== 'PRIVMSG') return;

          const badgesTag = tags.badges || '';
          const displayName = tags['display-name'] || FCM.ircNick(prefix) || 'unknown';
          const text = (params[1] || '').trim();
          if (!text) return;

          if (tags.bits && Number(tags.bits) > 0) {
            sink.event(`${displayName} cheered ${tags.bits} bits!`);
          }
          if (tags['custom-reward-id']) {
            sink.event(`${displayName} redeemed a channel point reward.`);
          }

          sink.chat({
            platform: 'twitch',
            author: displayName,
            text,
            color: tags.color || '',
            badgesRaw: badgesTag,
            badgeClass: FCM.twitchBadgeClass(badgesTag, tags),
            messageId: tags.id || null,
            userId: tags['user-id'] || null,
            emoteMap: FCM.parseTwitchEmoteMap(tags.emotes),
            timestamp: Number(tags['tmi-sent-ts']) || null,
          });
        });
      };

      ws.onerror = () => sink.sys('Twitch: connection error');

      ws.onclose = () => {
        if (conn.ws === ws) conn.ws = null;
        if (conn.forceClose) return;
        sink.status('disconnected');
        sink.sys('Twitch: disconnected');
        if ((conn.attempt || 0) >= FCM.MAX_RECONNECT_ATTEMPTS) {
          sink.sys('Twitch: reconnect limit reached (reconnect from the overlay to retry)');
          return;
        }
        const delay = FCM.backoffDelay(conn.attempt || 0);
        sink.sys(`Twitch: reconnecting in ${Math.round(delay / 1000)}s...`);
        conn.retryTimer = setTimeout(() => {
          if (conn.forceClose) return;
          conn.attempt = (conn.attempt || 0) + 1;
          FCM.twitchSource.connect(channel, sink, conn, conn.auth);
        }, delay);
      };
    },

    disconnect(conn) {
      conn.forceClose = true;
      if (conn.retryTimer) { clearTimeout(conn.retryTimer); conn.retryTimer = null; }
      if (conn.ws) { try { conn.ws.close(); } catch (e) { /* already gone */ } conn.ws = null; }
    },

    // Chatterino's recent-messages service replays the last lines of a channel
    // as raw IRC, so the exact same parser handles history and live messages.
    async fetchHistory(channel, sink, limit) {
      try {
        const r = await fetch(
          `https://recent-messages.robotty.de/api/v2/recent-messages/${encodeURIComponent(channel)}?limit=${limit}`
        );
        if (!r.ok) return;
        const data = await r.json();
        const messages = data.messages || [];
        if (!messages.length) return;

        const rows = [];
        messages.forEach((raw) => {
          const { tags, prefix, command, params } = FCM.parseIrcLine(raw);
          if (command !== 'PRIVMSG') return;
          const text = params[1] || '';
          if (!text) return;
          const badgesTag = tags.badges || '';
          rows.push({
            platform: 'twitch',
            author: tags['display-name'] || FCM.ircNick(prefix) || 'unknown',
            text,
            color: tags.color || '',
            badgesRaw: badgesTag,
            badgeClass: FCM.twitchBadgeClass(badgesTag, tags),
            messageId: tags.id || null,
            userId: tags['user-id'] || null,
            emoteMap: FCM.parseTwitchEmoteMap(tags.emotes),
            // robotty replays the original send time; without it every history
            // line would be stamped with the moment the overlay opened.
            timestamp: Number(tags['rm-received-ts']) || Number(tags['tmi-sent-ts']) || null,
            history: true,
          });
        });

        if (rows.length) {
          sink.sys(`Loaded ${rows.length} Twitch history messages`);
          sink.batch(rows);
        }
      } catch (e) {
        // History is a nicety; a failure here must not stop the live feed.
      }
    },
  };
})(self.FCM);
