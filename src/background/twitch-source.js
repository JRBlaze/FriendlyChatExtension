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
      // Every socket gets its own number, and every handler below checks it is
      // still the current one before doing anything.
      //
      // A shared "closing on purpose" flag is not enough. close() is
      // asynchronous, so the previous socket's onclose runs *after* this call
      // has already reset that flag — at which point the drop looks unexpected
      // and it schedules a reconnect to the channel it was opened for. That
      // reconnect closes this socket, whose onclose does the same in reverse,
      // and the two channels trade places forever.
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
        if (!current()) { try { ws.close(); } catch (e) { /* fine */ } return; }
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
        if (!current()) return;
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
              // Left set: connect() clears it. Clearing it here would make this
              // socket's own onclose read as an unexpected drop and queue a
              // second reconnect alongside the one below.
              conn.forceClose = true;
              try { ws.close(); } catch (e) { /* already closing */ }
              setTimeout(() => {
                if (current() && conn.channel === channel) {
                  FCM.twitchSource.connect(channel, sink, conn, null);
                }
              }, 400);
              return;
            }
            if (noticeText) sink.sys(`Twitch: ${noticeText}`);
            return;
          }

          // USERSTATE arrives after JOIN on an authenticated connection and is
          // what tells us whether this viewer can moderate here.
          if (command === 'USERSTATE' || command === 'GLOBALUSERSTATE') {
            // Only the channel-scoped USERSTATE can answer this. GLOBALUSERSTATE
            // describes the account rather than the room — it carries no `mod`
            // tag and only global badges — and it arrives before the join, so
            // letting it answer took the moderation controls out of the user
            // menu on every reconnect and left the worker refusing commands
            // until USERSTATE landed.
            if (command === 'USERSTATE') {
              const badgeTag = tags.badges || '';
              sink.moderator(
                tags.mod === '1'
                || badgeTag.includes('broadcaster/')
                || badgeTag.includes('moderator/')
              );
            }
            // Twitch lists the emote sets this account may use here, and it is
            // the one place it says so without a special scope. It arrives
            // after the join rather than with it, which is why the emote load
            // has to be able to happen twice.
            if (tags['emote-sets']) {
              sink.emoteSets(String(tags['emote-sets']).split(',').filter(Boolean));
            }
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
            // Noted, not forgiven: the attempt count is cleared in onclose, and
            // only if this connection lasted long enough to have been one.
            conn.connectedAt = Date.now();
            sink.status('connected');
            sink.sys(`Connected to Twitch: ${channel}`);
            sink.joined();
            return;
          }

          if (command === 'USERNOTICE') {
            // The summary is ours and the message under it is the viewer's, so
            // they are kept apart: only the second half is run through the
            // emote pipeline, and a display name that happens to spell an
            // emote name stays a name.
            const said = FCM.parseIrcAction(params[1] || '').text.trim();
            const notice = FCM.twitchUserNoticeSummary(tags);
            if (notice) {
              sink.event(notice, {
                body: said,
                emoteMap: FCM.parseTwitchEmoteMap(tags.emotes),
              });
            }
            return;
          }

          if (command !== 'PRIVMSG') return;

          const badgesTag = tags.badges || '';
          const displayName = tags['display-name'] || FCM.ircNick(prefix) || 'unknown';
          // `/me` is a PRIVMSG wearing a CTCP wrapper. It has to come off here,
          // before the emptiness check and before the emote positions in the
          // tags are handed on, because those are counted from the text inside
          // the wrapper rather than from the line as sent.
          const spoken = FCM.parseIrcAction(params[1] || '');
          // Not trimmed. Twitch counts its emote positions from the body as
          // sent, so taking a leading space off shifts every one of them: a
          // message of " Kappa" drew a stray "K" and an emote labelled "appa".
          // The history replay never trimmed, so the same line rendered one way
          // above and another below in the same feed. Emptiness is judged on a
          // trimmed copy, which is the only thing the trim was ever for.
          const text = spoken.text;
          if (!text.trim()) return;

          if (tags.bits && Number(tags.bits) > 0) {
            sink.event(`${displayName} cheered ${tags.bits} bits!`);
          }
          if (tags['custom-reward-id']) {
            sink.event(`${displayName} redeemed a channel point reward.`);
          }

          sink.chat({
            platform: 'twitch',
            author: displayName,
            // CLEARCHAT names the login, and a display name is only the same
            // string when it is plain ASCII. Somebody whose name is written in
            // Cyrillic or Japanese was never dimmed when they were timed out,
            // so the feed went on showing messages the platform had removed.
            login: FCM.ircNick(prefix) || '',
            text,
            action: spoken.action,
            reply: FCM.twitchReplyContext(tags),
            // Twitch's own answer to "has this person ever spoken here before".
            // It is the only trustworthy one: the feed has seen this channel
            // for as long as the panel has been open, and Twitch has seen it
            // since the channel existed.
            firstMessage: tags['first-msg'] === '1',
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

      ws.onerror = () => { if (current()) sink.sys('Twitch: connection error'); };

      ws.onclose = () => {
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
        sink.sys('Twitch: disconnected');
        if ((conn.attempt || 0) >= FCM.MAX_RECONNECT_ATTEMPTS) {
          sink.sys('Twitch: reconnect limit reached (reconnect from the overlay to retry)');
          return;
        }
        const delay = FCM.backoffDelay(conn.attempt || 0);
        sink.sys(`Twitch: reconnecting in ${Math.round(delay / 1000)}s...`);
        conn.retryTimer = setTimeout(() => {
          // The channel may have changed while this was pending.
          if (!current() || conn.forceClose || conn.channel !== channel) return;
          conn.attempt = (conn.attempt || 0) + 1;
          FCM.twitchSource.connect(channel, sink, conn, conn.auth);
        }, delay);
      };
    },

    disconnect(conn) {
      // Retiring the generation makes every handler still attached to the
      // outgoing socket inert, whatever order they fire in.
      conn.generation = (conn.generation || 0) + 1;
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
          const spoken = FCM.parseIrcAction(params[1] || '');
          const text = spoken.text;
          if (!text) return;
          const badgesTag = tags.badges || '';
          rows.push({
            platform: 'twitch',
            author: tags['display-name'] || FCM.ircNick(prefix) || 'unknown',
            // Same as the live path: a timeout names the login, and the
            // replayed messages are the ones most likely to be timed out.
            login: FCM.ircNick(prefix) || '',
            text,
            action: spoken.action,
            reply: FCM.twitchReplyContext(tags),
            // Deliberately not carried into the replay, even though the tag
            // is there. The highlight is a prompt to do something — say hello,
            // keep an eye on them — and acting on it is meaningless for a
            // message from an hour ago that the same person has already
            // followed with a dozen more. Twitch's own chat does not mark
            // history either.
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
