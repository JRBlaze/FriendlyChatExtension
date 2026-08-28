// Friendly Chat Extension — background service worker.
//
// Every network connection lives here rather than in the content script. Two
// reasons: the host page's connect-src CSP cannot interfere, and a Kick socket
// opened from a twitch.tv tab (or the reverse) is a plain cross-origin request
// that only the extension's host permissions can make.
importScripts(
  '/src/shared/namespace.js',
  '/src/shared/constants.js',
  '/src/shared/util.js',
  '/src/shared/irc.js',
  '/src/shared/emote-parsers.js',
  '/src/shared/kick-events.js',
  '/src/background/discovery.js',
  '/src/background/emotes.js',
  '/src/background/twitch-source.js',
  '/src/background/kick-source.js',
  '/src/background/auth.js',
  '/src/background/send.js',
  '/src/background/moderation.js',
  '/src/background/profile.js',
  '/src/background/emote-cache.js',
  '/src/background/updates.js'
);

const FCM = self.FCM;

/** @type {Map<number, Session>} tabId -> session */
const sessions = new Map();

function newConn(platform) {
  return {
    platform,
    channel: null,
    ws: null,
    forceClose: false,
    attempt: 0,
    retryTimer: null,
    pingTimer: null,
    chatroomId: null,
    roomId: null,
    auth: null,
    canModerate: false,
    state: 'idle',
  };
}

function createSession(tabId, port) {
  return {
    tabId,
    port,
    site: null,
    hostChannel: null,
    hints: [],
    conns: { twitch: newConn('twitch'), kick: newConn('kick') },
    counterpart: null,
    livePollTimer: null,
    emoteStore: { twitch: {}, kick: {} },
  };
}

function send(session, payload) {
  if (!session.port) return;
  try {
    session.port.postMessage(payload);
  } catch (e) {
    // The tab navigated away between the socket firing and this post.
    session.port = null;
  }
}

// A sink is the narrow surface a chat source talks to. It tags everything with
// the platform and forwards it to the tab that asked for the connection.
function makeSink(session, platform) {
  const conn = session.conns[platform];
  return {
    sys: (text) => send(session, { type: 'sys', text }),
    // `meta` carries the half of an event the viewer actually typed — the
    // message under a resub, the text of an announcement — kept apart from
    // our summary so only that half is drawn with emotes.
    event: (text, meta) => send(session, { type: 'event', platform, text, meta: meta || null }),
    chat: (msg) => send(session, { type: 'chat', msg }),
    batch: (rows) => send(session, { type: 'batch', rows }),
    emotes: (kind, store) => send(session, { type: 'emotes', platform, kind, store }),
    deleteMsg: (messageId) => send(session, { type: 'deleteMsg', platform, messageId: String(messageId) }),
    deleteUser: (username) => send(session, { type: 'deleteUser', platform, username: String(username) }),
    status: (state) => {
      conn.state = state;
      send(session, { type: 'status', platform, state, channel: conn.channel });
    },
    roomId: (id) => {
      const next = id || null;
      const changed = conn.roomId !== next;
      conn.roomId = next;
      // The channel's own emotes cannot be asked for until Twitch has said
      // which channel this is, and it says so after the join.
      if (changed && next && platform === 'twitch') {
        loadTwitchEmotes(session, platform).catch(() => {});
        loadCheermotes(session, platform).catch(() => {});
        // The third-party providers key a channel's set by this id too, and on
        // Twitch it can arrive after the join has already asked without it.
        loadThirdPartyEmotes(session, platform).catch(() => {});
      }
    },
    // The sets this account may use, which arrive with USERSTATE.
    emoteSets: (ids) => {
      const known = conn.emoteSets || [];
      const merged = Array.from(new Set([...known, ...(ids || [])]));
      if (merged.length === known.length) return;
      conn.emoteSets = merged;
      loadTwitchEmotes(session, platform).catch(() => {});
    },
    moderator: (can) => {
      const next = !!can;
      if (conn.canModerate === next) return;
      conn.canModerate = next;
      send(session, { type: 'moderator', platform, canModerate: next });
    },
    authRejected: () => {
      conn.auth = null;
      FCM.auth.clear(platform).then(async () => {
        send(session, { type: 'auth', accounts: await FCM.auth.summary() });
      });
    },
    joined: (chatroomId) => {
      // Kept, not just passed on: it is what a later replay needs to ask Kick
      // for this channel's history again, and there is no second chance to
      // learn it without reopening the socket.
      if (chatroomId) conn.chatroomId = chatroomId;
      onJoined(session, platform, chatroomId);
    },
  };
}

// Everything that should happen once, after a channel is actually joined:
// history replay and the emote sets the renderer needs.
async function onJoined(session, platform, chatroomId) {
  const conn = session.conns[platform];
  const channel = conn.channel;
  if (!channel) return;
  const sink = makeSink(session, platform);
  const settings = await FCM.loadSettings();

  if (settings.showHistory) {
    if (platform === 'twitch') {
      FCM.twitchSource.fetchHistory(channel, sink, FCM.TWITCH_HISTORY_LIMIT);
    } else {
      FCM.kickSource.fetchHistory(chatroomId || conn.chatroomId, sink, FCM.KICK_HISTORY_LIMIT);
    }
  }

  if (platform === 'twitch') {
    FCM.twitchApi.badges(channel).then((badges) => {
      send(session, { type: 'badges', platform: 'twitch', badges });
    });
    loadTwitchEmotes(session, platform).catch(() => {});
  } else {
    FCM.emoteLoader.kickNative(channel).then(async (store) => {
      if (Object.keys(store).length) {
        sink.emotes('native', store);
        sink.sys(`Loaded ${Object.keys(store).length} Kick emotes for this channel`);
        await FCM.emoteCache.write(platform, channel, await accountIdFor(platform), 'native', store);
        return;
      }
      // Kick sits behind Cloudflare, which can refuse a request that did not
      // come from a browser tab. The page itself is a browser tab, so it is
      // asked to fetch the same list from its own origin.
      send(session, { type: 'needKickEmotes', channel });
    });
  }

  // Last visit's lists, sent before anything is fetched. The view merges rather
  // than replaces, so the real answer lands on top of this a moment later and
  // anything new appears then — nothing here is treated as final.
  sendCachedEmotes(session, platform).catch(() => {});

  loadThirdPartyEmotes(session, platform).catch(() => {});
}

/**
 * The 7TV, BTTV and FFZ emotes for this channel.
 *
 * Runs on join, and again if the channel's numeric id arrives afterwards.
 *
 * That second run is the whole point. Every provider keys a channel's set by
 * the platform's own numeric id, and on Twitch that id comes from ROOMSTATE,
 * which is not ordered against the 366 that says the join finished. When 366
 * came first — often — this ran with no id, fetched only the providers' global
 * sets, and nothing ever went back for the channel's own. The emotes people
 * actually came for were missing, and reloading the page only helped because it
 * re-ran the race.
 *
 * Guarded by which id it last ran for, so the ordinary case is still one pass
 * and the second only happens when it would ask a different question.
 */
async function loadThirdPartyEmotes(session, platform) {
  const conn = session.conns[platform];
  if (!conn || !conn.channel) return;
  const settings = await FCM.loadSettings();
  if (!settings.thirdPartyEmotes) return;

  const channel = conn.channel;
  const attempt = `${channel}:${conn.roomId || ''}`;
  if (conn.thirdPartyFor === attempt) return;
  conn.thirdPartyFor = attempt;

  const store = await FCM.emoteLoader.thirdParty(platform, channel, conn.roomId);
  // Left the channel while the providers were answering.
  if (conn.channel !== channel) return;
  const count = Object.keys(store).length;
  if (!count) return;

  const sink = makeSink(session, platform);
  sink.emotes('thirdparty', store);
  // Only the first pass is worth saying out loud; the one that follows an id
  // arriving is a top-up, the same as the native emote loads.
  if (!conn.announcedThirdParty) {
    conn.announcedThirdParty = true;
    sink.sys(`Loaded ${count} third-party emotes for ${FCM.PLATFORM_META[platform].name} (7TV/BTTV/FFZ)`);
  }
  await FCM.emoteCache.write(platform, channel, await accountIdFor(platform), 'thirdparty', store);
}

// Which account the cached lists belong to. Twitch's answer to "what may this
// viewer send here" is about the viewer as much as the channel, so a cache
// shared between two accounts would offer emotes the other one cannot use.
async function accountIdFor(platform) {
  const record = await FCM.auth.get(platform);
  return (record && record.userId) || '';
}

/**
 * Sends whatever was cached for this channel, immediately.
 *
 * Only ever an opening bid. Every list here is fetched again straight
 * afterwards, and the view merges, so this fills the gap at the start of a
 * visit without being able to hold a stale answer in place.
 */
async function sendCachedEmotes(session, platform) {
  const conn = session.conns[platform];
  if (!conn || !conn.channel) return;
  const channel = conn.channel;
  const kinds = await FCM.emoteCache.read(platform, channel, await accountIdFor(platform));
  if (!kinds) return;
  // The channel may have been left while storage was being read.
  if (session.conns[platform].channel !== channel) return;
  const sink = makeSink(session, platform);
  let total = 0;
  ['native', 'thirdparty'].forEach((kind) => {
    const store = kinds[kind];
    const count = store ? Object.keys(store).length : 0;
    if (!count) return;
    sink.emotes(kind, store);
    total += count;
  });
  if (total) sink.sys(`${total} emotes ready from last time — checking for new ones`);
}

/**
 * The Cheermote prefixes this channel accepts, so a Cheer can be told apart
 * from an ordinary word ending in digits before the message is sent.
 *
 * Worth asking the channel rather than assuming the global set, because a
 * broadcaster's own Cheermotes are exactly the ones a regular of that channel
 * types. A failure here is not worth reporting: the overlay falls back to the
 * global list, which covers everything except those custom prefixes.
 */
async function loadCheermotes(session, platform) {
  const conn = session.conns[platform];
  if (!conn || platform !== 'twitch' || !conn.roomId) return;
  const record = await FCM.auth.get('twitch');
  if (!record || !record.accessToken) return;
  const data = await FCM.getJson(
    `${FCM.TWITCH_HELIX}/bits/cheermotes?broadcaster_id=${encodeURIComponent(conn.roomId)}`,
    {
      headers: {
        Authorization: `Bearer ${record.accessToken}`,
        'Client-Id': record.clientId,
      },
    }
  );
  const prefixes = Array.isArray(data && data.data)
    ? data.data.map((entry) => entry && entry.prefix).filter(Boolean)
    : [];
  if (!prefixes.length) return;
  // Merged with the global list rather than replacing it: the API answers for
  // this channel, and a viewer who types a global Cheermote it omitted should
  // still have it recognised.
  const merged = Array.from(new Set([...FCM.GLOBAL_CHEERMOTES, ...prefixes]));
  send(session, { type: 'cheermotes', platform, prefixes: merged });
}

/**
 * Loads the Twitch emotes this viewer may use, and does it again whenever
 * something new is learnt.
 *
 * It runs on join, again when Twitch says which channel this is, and again when
 * USERSTATE lists the account's emote sets — because those three facts arrive
 * separately and each unlocks a different part of the answer. Sending a partial
 * store more than once is safe: the view merges emotes rather than replacing
 * them, so each pass adds and nothing is ever lost.
 */
async function loadTwitchEmotes(session, platform) {
  const conn = session.conns[platform];
  if (!conn || platform !== 'twitch') return;
  const settings = await FCM.loadSettings();
  const record = await FCM.auth.get('twitch');
  const clientId = (record && record.clientId)
    || settings.twitchClientId
    || FCM.DEFAULT_TWITCH_CLIENT_ID;

  const store = await FCM.emoteLoader.twitchNative({
    clientId,
    token: record && record.accessToken,
    userId: record && record.userId,
    broadcasterId: conn.roomId,
    setIds: conn.emoteSets,
  });

  const count = Object.keys(store).length;
  if (!count) return;
  // Only the first pass is worth saying out loud; the later ones are top-ups.
  const sink = makeSink(session, platform);
  sink.emotes('native', store);
  // Cached against the account as well as the channel: this list is the answer
  // to what *this* viewer may send here, and it grows across the three passes,
  // so the last and largest one is what ends up stored.
  FCM.emoteCache
    .write(platform, conn.channel, (record && record.userId) || '', 'native', store)
    .catch(() => {});
  if (conn.announcedEmotes) return;
  conn.announcedEmotes = true;

  if (!record || !record.accessToken) {
    sink.sys(`Loaded ${count} Twitch emotes — connect a Twitch account for your own subs and follows`);
    return;
  }
  // A token from before this scope was asked for still works for everything
  // else, so it is worth saying what is missing rather than quietly loading
  // less than the viewer expects.
  const scopes = record.scopes || [];
  if (scopes.length && !scopes.includes('user:read:emotes')) {
    sink.sys(`Loaded ${count} Twitch emotes. Reconnect your Twitch account in settings to `
      + 'include the emotes from every channel you subscribe to.');
    return;
  }
  sink.sys(`Loaded ${count} of your Twitch emotes (global, channel, subs, follows and rewards)`);
}

async function joinChannel(session, platform, channel) {
  const norm = FCM.normalizeChannel(channel);
  if (!norm) return;
  const conn = session.conns[platform];
  if (conn.channel === norm && conn.ws && conn.state === 'connected') return;

  leaveChannel(session, platform, { silent: true });

  // Claimed after leaving, since leaving retires the previous holder. Two
  // storage reads sit between here and opening the socket, and they take real
  // milliseconds: clicking through channels quickly starts a second join while
  // the first is still inside them, and without this the slower one finishes
  // last and connects to the channel already left.
  const seq = (conn.joinSeq || 0) + 1;
  conn.joinSeq = seq;
  conn.attempt = 0;

  // Chat reads fine without an account. The token is only used so the platform
  // will say whether this viewer can moderate here — and, on Twitch, so their
  // own messages come back with their real badges.
  const settings = await FCM.loadSettings();
  const record = await FCM.auth.usable(platform, settings);
  if (conn.joinSeq !== seq) return;

  const auth = record
    ? { token: record.accessToken, login: record.login || '' }
    : null;

  const sink = makeSink(session, platform);
  if (platform === 'twitch') FCM.twitchSource.connect(norm, sink, conn, auth);
  else FCM.kickSource.connect(norm, sink, conn, auth);
}

function leaveChannel(session, platform, { silent = false } = {}) {
  const conn = session.conns[platform];
  // Retires any join still working its way through its awaits, so it cannot
  // reconnect a channel that has just been left.
  conn.joinSeq = (conn.joinSeq || 0) + 1;
  if (platform === 'twitch') FCM.twitchSource.disconnect(conn);
  else FCM.kickSource.disconnect(conn);
  const had = conn.channel;
  conn.channel = null;
  conn.chatroomId = null;
  conn.roomId = null;
  conn.auth = null;
  conn.state = 'idle';
  // What has already been fetched, and what has already been said about it.
  // Left set, a channel joined again would be skipped as already done.
  conn.thirdPartyFor = null;
  conn.announcedThirdParty = false;
  conn.announcedEmotes = false;
  if (conn.canModerate) {
    conn.canModerate = false;
    send(session, { type: 'moderator', platform, canModerate: false });
  }
  if (had && !silent) {
    send(session, { type: 'sys', text: `Left ${FCM.PLATFORM_META[platform].name}: ${had}` });
    send(session, { type: 'status', platform, state: 'idle', channel: null });
  }
}

function teardown(session) {
  FCM.PLATFORMS.forEach((p) => leaveChannel(session, p, { silent: true }));
  if (session.livePollTimer) { clearInterval(session.livePollTimer); session.livePollTimer = null; }
}

// ── Counterpart discovery ─────────────────────────────────────────────────────

async function refreshCounterpart(session, { announce = false } = {}) {
  if (!session.site || !session.hostChannel) return;
  const previous = session.counterpart;
  let summary = null;
  try {
    summary = await FCM.resolveCounterpart({
      platform: session.site,
      channel: session.hostChannel,
      hints: session.hints,
    });
  } catch (e) {
    summary = null;
  }
  session.counterpart = summary;

  const wasLive = !!(previous && previous.live);
  const isLive = !!(summary && summary.live);
  // Announce on the first resolve, and afterwards only when the other channel
  // has actually crossed from offline to live.
  const changed = announce || !previous || wasLive !== isLive
    || (previous && summary && previous.channel !== summary.channel);

  if (changed) {
    send(session, {
      type: 'counterpart',
      counterpart: summary,
      hostPlatform: session.site,
      hostChannel: session.hostChannel,
      wentLive: isLive && !wasLive && !!previous,
    });
  }
}

function startLivePolling(session) {
  if (session.livePollTimer) clearInterval(session.livePollTimer);
  if (!session.hostChannel) return;
  session.livePollTimer = setInterval(() => {
    // Skip while the other chat is already connected — nothing left to offer.
    const other = FCM.otherPlatform(session.site);
    if (session.conns[other].channel) return;
    refreshCounterpart(session);
  }, FCM.LIVE_POLL_MS);
}

// ── Port protocol ─────────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fcm') return;
  const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
  if (tabId == null) return;

  // A reload replaces the port but should not orphan live sockets.
  const existing = sessions.get(tabId);
  const session = existing || createSession(tabId, port);
  session.port = port;
  sessions.set(tabId, session);

  port.onMessage.addListener(async (msg) => {
    if (!msg || !msg.cmd) return;

    // Anything naming a platform must name one that exists. A bad value here
    // would take the whole worker down, and with it every other tab's chat, so
    // it is checked once rather than in each handler.
    if ('platform' in msg && !FCM.PLATFORMS.includes(msg.platform)) return;

    try {
      await handleCommand(session, msg);
    } catch (e) {
      // One malformed command must never leave the worker — and every session
      // it owns — in a broken state.
      send(session, { type: 'sys', text: `[Merged] Something went wrong handling ${msg.cmd}` });
    }
  });

  async function handleCommand(session, msg) {
    switch (msg.cmd) {
      case 'ping':
        // Keeps the service worker alive while sockets are open.
        send(session, { type: 'pong' });
        break;

      case 'hello': {
        const site = msg.site;
        const channel = FCM.normalizeChannel(msg.channel);
        const changedChannel = session.hostChannel !== channel || session.site !== site;
        session.site = site;
        // Links that arrive with the announcement of a channel are discarded,
        // whatever the page sent. They can only have been read at the moment the
        // address changed, which on a single-page app is before the page it
        // names exists — so they describe the channel just left.
        //
        // The page half no longer sends any, and this does not depend on that.
        // Reloading an extension leaves the old content script running in every
        // tab already open until each one is reloaded, so the worker is the
        // half that can be sure it is current, and it is the half that decides.
        // The scans send them separately, once there is a page to read.
        session.hints = [];

        if (changedChannel) {
          teardown(session);
          session.hostChannel = channel;
          session.counterpart = null;
        }

        send(session, {
          type: 'ready',
          site,
          channel,
          connections: FCM.PLATFORMS.reduce((acc, p) => {
            acc[p] = {
              channel: session.conns[p].channel,
              state: session.conns[p].state,
              canModerate: session.conns[p].canModerate,
            };
            return acc;
          }, {}),
        });

        if (!channel) break;

        // A reload is a new page on the same channel. The sockets in here carry
        // on regardless, so nothing re-joins — and history, badges and emotes
        // only ever happened on a join. The tab was reconnecting to a live chat
        // and showing nothing that arrived before it loaded, with an empty
        // emote picker. Everything a fresh page needs is sent again.
        //
        // Safe to repeat: the feed drops messages it has already seen, emote
        // stores merge rather than replace, and badges are a straight swap. A
        // page that already had all of it ends up exactly where it was.
        if (!changedChannel) {
          FCM.PLATFORMS.forEach((p) => {
            const live = session.conns[p];
            if (!live.channel || live.state !== 'connected') return;
            live.announcedEmotes = false;
            Promise.resolve(onJoined(session, p, live.chatroomId)).catch(() => {});
          });
        }

        if (changedChannel) {
          await refreshCounterpart(session, { announce: true });
          startLivePolling(session);
        } else {
          // A soft navigation or a port reconnect: replay what we already know
          // so the fresh overlay shows the same state without re-probing.
          send(session, {
            type: 'counterpart',
            counterpart: session.counterpart,
            hostPlatform: session.site,
            hostChannel: session.hostChannel,
            wentLive: false,
          });
        }
        break;
      }

      case 'hints':
        // The channel page finished rendering its about/social panels.
        if (Array.isArray(msg.hints) && msg.hints.length) {
          const merged = Array.from(new Set([...session.hints, ...msg.hints])).slice(0, 40);
          const isNew = merged.length !== session.hints.length;
          session.hints = merged;
          // Re-resolved whenever the page turns up something new, including
          // when an answer has already been found. It used to stop at the first
          // answer, which meant a wrong one could never be corrected — and the
          // wrong ones came from exactly here, before the page had rendered.
          // A link the streamer put on the page in front of you outranks a
          // guess, and a mapping set by hand still outranks both.
          if (isNew) await refreshCounterpart(session);
        }
        break;

      case 'join':
        joinChannel(session, msg.platform, msg.channel);
        break;

      case 'leave':
        leaveChannel(session, msg.platform);
        break;

      case 'profile': {
        // The channel the follow date is being asked about. Twitch wants the
        // broadcaster's id and Kick wants the slug, so each is given what it
        // asks for rather than one being converted into the other.
        const on = session.conns[msg.platform] || {};
        const where = msg.platform === 'twitch' ? on.roomId : on.channel;
        // Whether this viewer moderates here decides how an empty follow list
        // is read: "they do not follow" for a mod, "not allowed to know" for
        // anyone else. The two are opposite answers in the same shape.
        const profile = await FCM.lookupProfile(
          msg.platform, msg.username, where, !!on.canModerate
        );
        send(session, {
          type: 'profile',
          id: msg.id,
          platform: msg.platform,
          username: msg.username,
          profile,
        });
        break;
      }

      case 'recheck':
        await refreshCounterpart(session, { announce: true });
        break;

      case 'authStatus':
        send(session, { type: 'auth', accounts: await FCM.auth.summary() });
        break;

      case 'connectAccount': {
        const settings = await FCM.loadSettings();
        try {
          const result = await FCM.auth.connect(msg.platform, settings);
          send(session, { type: 'auth', accounts: await FCM.auth.summary() });
          send(session, {
            type: 'sys',
            text: `[Account] Connected ${FCM.PLATFORM_META[msg.platform].name}`
              + `${result.login ? ` as ${result.login}` : ''}`,
          });
        } catch (e) {
          const explained = FCM.explainAuthFailure(msg.platform, e.message, e.authUrl);
          send(session, { type: 'auth', accounts: await FCM.auth.summary() });
          send(session, { type: 'authError', platform: msg.platform, ...explained });
        }
        break;
      }

      case 'disconnectAccount':
        await FCM.auth.clear(msg.platform);
        send(session, { type: 'auth', accounts: await FCM.auth.summary() });
        send(session, {
          type: 'sys',
          text: `[Account] Disconnected ${FCM.PLATFORM_META[msg.platform].name}`,
        });
        break;

      case 'moderate': {
        const settings = await FCM.loadSettings();
        const platform = msg.platform;
        const conn = session.conns[platform];
        let result;
        if (!conn || !conn.channel) {
          result = { ok: false, reason: 'no-channel' };
        } else if (!conn.canModerate) {
          // The buttons are only offered to moderators, but the check is
          // repeated here so a stale overlay cannot act on stale permissions.
          result = { ok: false, reason: 'refused', detail: 'you are not a moderator here' };
        } else {
          result = await FCM.moderate(platform, msg.action, msg.opts || {}, conn, settings);
        }
        // The wording is worked out once, here, so the feed line and the toast
        // in the overlay always say the same thing.
        const text = FCM.describeModeration(platform, result);
        send(session, { type: 'modResult', id: msg.id, platform, result, text });
        send(session, { type: 'sys', text });
        break;
      }

      case 'send': {
        const settings = await FCM.loadSettings();
        const text = String(msg.text || '').trim();
        const wanted = Array.isArray(msg.targets) ? msg.targets : [];
        // Which message, if any, each target is replying to. Sent per platform
        // because the two feeds are different rooms: a reply on Twitch has
        // nothing to thread onto in a Kick chatroom.
        const replies = (msg.replies && typeof msg.replies === 'object') ? msg.replies : {};
        const results = {};
        // Run the platforms in parallel so a slow one does not delay the other.
        await Promise.all(wanted.map(async (platform) => {
          const conn = session.conns[platform];
          if (!conn || !conn.channel) { results[platform] = { ok: false, reason: 'no-channel' }; return; }
          results[platform] = await FCM.sendMessage(platform, text, conn, settings, {
            replyToId: replies[platform] || '',
          });
        }));
        send(session, { type: 'sendResult', id: msg.id, results });
        break;
      }

      case 'setLink': {
        // A manual mapping wins over every guess, for good, and is recorded
        // from both ends so the same pair works whichever side you arrive on.
        const target = FCM.normalizeChannel(msg.target);
        await FCM.links.setManual(session.site, session.hostChannel, target);

        // Correcting a link while merged with the channel it used to name
        // would leave the wrong chat in the feed and the right one offered in
        // a prompt beside it. The only thing ever joined on the other platform
        // is the counterpart, so a counterpart that has just changed is reason
        // enough to leave — and saying so, rather than doing it quietly.
        const other = FCM.otherPlatform(session.site);
        const conn = session.conns[other];
        if (conn.channel && conn.channel !== target) leaveChannel(session, other);

        await refreshCounterpart(session, { announce: true });
        break;
      }

      case 'clearLink':
        await FCM.links.clearPair(session.site, session.hostChannel);
        await refreshCounterpart(session, { announce: true });
        break;

      default:
        break;
    }
  }

  port.onDisconnect.addListener(() => {
    // A tab that reconnects opens a new port before the old one reports its
    // disconnect, so this must not clear a port that has already been replaced.
    if (session.port !== port) return;
    // Navigating within the SPA reconnects almost immediately; give the tab a
    // moment before dropping its sockets so a soft nav does not restart chat.
    session.port = null;
    setTimeout(() => {
      const current = sessions.get(tabId);
      if (current && !current.port) {
        teardown(current);
        sessions.delete(tabId);
      }
    }, 5000);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = sessions.get(tabId);
  if (!session) return;
  teardown(session);
  sessions.delete(tabId);
});

// Popup and options page ask for a snapshot rather than holding a port.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;

  // The popup's release questions. Answered from what the last check stored,
  // except for 'updateCheck', which is the user asking to look now.
  if (msg.cmd === 'updateStatus') {
    FCM.updateStatus().then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (msg.cmd === 'updateCheck') {
    FCM.checkForUpdate(true).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (msg.cmd === 'updateDismiss') {
    FCM.dismissUpdate(msg.version).then(() => sendResponse({ ok: true })).catch(() => sendResponse(null));
    return true;
  }

  if (msg.cmd !== 'status') return undefined;
  const tabId = msg.tabId;
  const session = sessions.get(tabId);
  sendResponse(session ? {
    site: session.site,
    channel: session.hostChannel,
    counterpart: session.counterpart,
    connections: FCM.PLATFORMS.reduce((acc, p) => {
      acc[p] = {
        channel: session.conns[p].channel,
        state: session.conns[p].state,
        canModerate: session.conns[p].canModerate,
      };
      return acc;
    }, {}),
  } : null);
  return true;
});

// A periodic alarm gives the worker a heartbeat even if a channel goes silent.
chrome.alarms.create('fcm-heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (FCM.isUpdateAlarm(alarm.name)) { FCM.checkForUpdate().catch(() => {}); return; }
  if (alarm.name !== 'fcm-heartbeat') return;
  sessions.forEach((session) => {
    FCM.PLATFORMS.forEach((p) => {
      const conn = session.conns[p];
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN && p === 'twitch') {
        try { conn.ws.send('PING :tmi.twitch.tv'); } catch (e) { /* socket is closing */ }
      }
    });
  });
});

// Whether there is a newer release than the one running. Nothing here installs
// it — an extension cannot replace itself — but the badge and the popup turn
// "go and look" into two clicks.
FCM.watchForUpdates();
