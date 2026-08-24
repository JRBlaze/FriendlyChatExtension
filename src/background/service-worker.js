// FriendlyChatExtension — background service worker.
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
  '/src/background/moderation.js'
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
    event: (text) => send(session, { type: 'event', platform, text }),
    chat: (msg) => send(session, { type: 'chat', msg }),
    batch: (rows) => send(session, { type: 'batch', rows }),
    emotes: (kind, store) => send(session, { type: 'emotes', platform, kind, store }),
    deleteMsg: (messageId) => send(session, { type: 'deleteMsg', platform, messageId: String(messageId) }),
    deleteUser: (username) => send(session, { type: 'deleteUser', platform, username: String(username) }),
    status: (state) => {
      conn.state = state;
      send(session, { type: 'status', platform, state, channel: conn.channel });
    },
    roomId: (id) => { conn.roomId = id || null; },
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
    joined: (chatroomId) => { onJoined(session, platform, chatroomId); },
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
  } else {
    FCM.emoteLoader.kickNative(channel).then((store) => {
      if (Object.keys(store).length) sink.emotes('native', store);
    });
  }

  if (settings.thirdPartyEmotes) {
    // conn.roomId is the channel's numeric id on its own platform: Twitch's
    // room-id tag, or Kick's user_id. Every third-party provider keys channel
    // sets by that, not by the channel name.
    FCM.emoteLoader
      .thirdParty(platform, channel, conn.roomId)
      .then((store) => {
        const count = Object.keys(store).length;
        if (count) {
          sink.emotes('thirdparty', store);
          sink.sys(`Loaded ${count} third-party emotes for ${FCM.PLATFORM_META[platform].name} (7TV/BTTV/FFZ)`);
        }
      });
  }
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
        session.hints = Array.isArray(msg.hints) ? msg.hints.slice(0, 40) : [];

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
          if (isNew && !(session.counterpart && session.counterpart.exists)) {
            await refreshCounterpart(session);
          }
        }
        break;

      case 'join':
        joinChannel(session, msg.platform, msg.channel);
        break;

      case 'leave':
        leaveChannel(session, msg.platform);
        break;

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
        const results = {};
        // Run the platforms in parallel so a slow one does not delay the other.
        await Promise.all(wanted.map(async (platform) => {
          const conn = session.conns[platform];
          if (!conn || !conn.channel) { results[platform] = { ok: false, reason: 'no-channel' }; return; }
          results[platform] = await FCM.sendMessage(platform, text, conn, settings);
        }));
        send(session, { type: 'sendResult', id: msg.id, results });
        break;
      }

      case 'setLink': {
        // A manual mapping wins over every guess, for good.
        const target = FCM.normalizeChannel(msg.target);
        if (target) {
          await FCM.links.set(session.site, session.hostChannel, {
            channel: target, match: 'manual', manual: true,
          });
        } else {
          await FCM.links.set(session.site, session.hostChannel, {
            none: true, manual: true,
          });
        }
        await refreshCounterpart(session, { announce: true });
        break;
      }

      case 'clearLink':
        await FCM.links.clear(session.site, session.hostChannel);
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
  if (!msg || msg.cmd !== 'status') return undefined;
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
