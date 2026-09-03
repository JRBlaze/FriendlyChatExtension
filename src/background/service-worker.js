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
  '/src/shared/clips.js',
  '/src/background/discovery.js',
  '/src/background/emotes.js',
  '/src/background/twitch-source.js',
  '/src/background/kick-source.js',
  '/src/background/auth.js',
  '/src/background/send.js',
  '/src/background/moderation.js',
  '/src/background/profile.js',
  '/src/background/emote-cache.js',
  '/src/background/clips.js',
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
    channelId: null,
    subscriberBadges: null,
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

function post(session, payload) {
  if (!session.port) return;
  try {
    session.port.postMessage(payload);
  } catch (e) {
    // The tab navigated away between the socket firing and this post.
    session.port = null;
  }
}

// Everything outside a sink still posts unconditionally: account summaries,
// counterpart offers, update notices and the port's own replies are about the
// tab rather than about one channel's chat connection.
const send = post;

/**
 * A sink is the narrow surface a chat source talks to. It tags everything with
 * the platform and forwards it to the tab that asked for the connection.
 *
 * Every sink belongs to one generation of one connection. Joining and leaving
 * both retire the generation before them, and work that was already in flight
 * when that happened — a history fetch, an emote lookup, a socket read not yet
 * dispatched, a reconnect timer — finishes afterwards. Delivering it then would
 * put one streamer's chat, history and emotes into the panel under the next
 * streamer's name, which is worse than not delivering it at all: the viewer has
 * no way to tell that what they are reading is not this channel. So a retired
 * sink goes quiet, and stops writing to the connection record as well.
 *
 * @param {number} [generation] the generation to belong to. Pass it explicitly
 *   from anything that builds a sink *after* an await, since by then
 *   `conn.joinSeq` may already be the next channel's.
 */
function makeSink(session, platform, generation) {
  const conn = session.conns[platform];
  const mine = generation === undefined ? (conn.joinSeq || 0) : generation;
  const current = () => (conn.joinSeq || 0) === mine;
  const send = (target, payload) => { if (current()) post(target, payload); };
  return {
    generation: mine,
    current,
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
      if (!current()) return;
      conn.state = state;
      send(session, { type: 'status', platform, state, channel: conn.channel });
    },
    roomId: (id) => {
      if (!current()) return;
      const next = id || null;
      const changed = conn.roomId !== next;
      conn.roomId = next;
      // The channel's own emotes cannot be asked for until Twitch has said
      // which channel this is, and it says so after the join.
      if (changed && next && platform === 'twitch') {
        loadTwitchEmotes(session, platform, mine).catch(() => {});
        loadCheermotes(session, platform, mine).catch(() => {});
        loadSubscription(session, platform, mine).catch(() => {});
        // The third-party providers key a channel's set by this id too, and on
        // Twitch it can arrive after the join has already asked without it.
        loadThirdPartyEmotes(session, platform, mine).catch(() => {});
      }
    },
    // The sets this account may use, which arrive with USERSTATE.
    emoteSets: (ids) => {
      if (!current()) return;
      const known = conn.emoteSets || [];
      const merged = Array.from(new Set([...known, ...(ids || [])]));
      if (merged.length === known.length) return;
      conn.emoteSets = merged;
      loadTwitchEmotes(session, platform, mine).catch(() => {});
    },
    moderator: (can) => {
      if (!current()) return;
      const next = !!can;
      if (conn.canModerate === next) return;
      conn.canModerate = next;
      send(session, { type: 'moderator', platform, canModerate: next });
    },
    // This viewer's own subscription to the channel, as the badges on their
    // USERSTATE describe it. Helix is asked separately once the room is known,
    // and the two are merged before anything is told.
    subscription: (fromBadges) => {
      if (!current()) return;
      conn.subBadges = fromBadges || null;
      postSubscription(session, platform, mine);
    },
    authRejected: () => {
      if (!current()) return;
      conn.auth = null;
      FCM.auth.clear(platform).then(async () => {
        send(session, { type: 'auth', accounts: await FCM.auth.summary() });
      });
    },
    joined: (chatroomId) => {
      if (!current()) return;
      // Kept rather than only passed on: a later replay — a tab reloading onto
      // a chat that is already connected — has no second chance to learn it
      // without reopening the socket.
      if (chatroomId) conn.chatroomId = chatroomId;
      onJoined(session, platform, mine);
    },
  };
}

// Everything that should happen once, after a channel is actually joined:
// history replay and the emote sets the renderer needs.
async function onJoined(session, platform, generation) {
  const conn = session.conns[platform];
  const channel = conn.channel;
  if (!channel) return;
  const sink = makeSink(session, platform, generation);
  const settings = await FCM.loadSettings();
  // Reading the settings takes real milliseconds, and clicking through
  // channels can retire this join inside them.
  if (!sink.current()) return;

  if (settings.showHistory) {
    if (platform === 'twitch') {
      FCM.twitchSource.fetchHistory(channel, sink, FCM.TWITCH_HISTORY_LIMIT);
    } else {
      // The channel's id, not the chatroom's — they are different numbers and
      // the history endpoint only answers to the first.
      FCM.kickSource.fetchHistory(conn.channelId, sink, FCM.KICK_HISTORY_LIMIT);
    }
  }

  if (platform === 'twitch') {
    FCM.twitchApi.badges(channel).then((badges) => {
      // Badges are a straight swap in the view, so the previous channel's
      // arriving late would relabel everyone in this one.
      if (!sink.current()) return;
      send(session, { type: 'badges', platform: 'twitch', badges });
    });
    loadTwitchEmotes(session, platform, sink.generation).catch(() => {});
  } else {
    // The channel's own subscriber badges, read off its record on connect. A
    // straight swap in the view, like Twitch's, so only this channel's.
    send(session, {
      type: 'badges', platform: 'kick', badges: { subscriber: conn.subscriberBadges || [] },
    });
    FCM.emoteLoader.kickNative(channel).then(async (store) => {
      if (!sink.current()) return;
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
    loadKickStanding(session, sink.generation).catch(() => {});
  }

  // Last visit's lists, sent before anything is fetched. The view merges rather
  // than replaces, so the real answer lands on top of this a moment later and
  // anything new appears then — nothing here is treated as final.
  sendCachedEmotes(session, platform, sink.generation).catch(() => {});

  loadThirdPartyEmotes(session, platform, sink.generation).catch(() => {});
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
async function loadThirdPartyEmotes(session, platform, generation) {
  const conn = session.conns[platform];
  if (!conn || !conn.channel) return;
  const sink = makeSink(session, platform, generation);
  const settings = await FCM.loadSettings();
  if (!settings.thirdPartyEmotes || !sink.current()) return;

  const channel = conn.channel;
  const attempt = `${channel}:${conn.roomId || ''}`;
  if (conn.thirdPartyFor === attempt) return;
  conn.thirdPartyFor = attempt;

  const store = await FCM.emoteLoader.thirdParty(platform, channel, conn.roomId);
  // Left the channel while the providers were answering. The generation catches
  // leaving and coming back as well, which the name on its own does not.
  if (conn.channel !== channel || !sink.current()) return;
  const count = Object.keys(store).length;
  if (!count) return;

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
async function sendCachedEmotes(session, platform, generation) {
  const conn = session.conns[platform];
  if (!conn || !conn.channel) return;
  const channel = conn.channel;
  const sink = makeSink(session, platform, generation);
  const kinds = await FCM.emoteCache.read(platform, channel, await accountIdFor(platform));
  if (!kinds) return;
  // The channel may have been left while storage was being read.
  if (session.conns[platform].channel !== channel || !sink.current()) return;
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

// Where Kick says who this viewer is in a room. Only ever answered to the
// browser session that asks, which is what makes the tab the one that can.
function kickStandingUrl(channel) {
  return `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}/me`;
}

/**
 * Acts on Kick's answer about this viewer's standing in the channel.
 *
 * Only ever turns the tools **on**. Kick documents none of the field names
 * this is read out of, so a spelling that has moved would otherwise take a
 * broadcaster's own tools away — and being wrong in the direction of "we did
 * not manage to work it out" is the only acceptable way to be wrong here.
 * Every join starts from false and leaving clears it, so nothing stale
 * survives a channel change.
 *
 * @param {object} standing from FCM.readKickStanding
 * @param {object|null} record the connected Kick account, if there is one
 */
function applyKickStanding(session, sink, standing, record) {
  const conn = session.conns.kick;
  if (!conn || !sink.current() || !standing || !standing.known) return;
  const connected = !!(record && record.accessToken);
  const mine = FCM.normalizeChannel((record && record.login) || '');
  const theirs = FCM.normalizeChannel(standing.username || '');

  // Said at most once per channel: these are explanations, not status.
  const explain = (text) => {
    if (conn.saidStanding) return;
    conn.saidStanding = true;
    sink.sys(text);
  };

  // The answer describes whoever is signed in to kick.com in this browser, and
  // the moderation calls go out as whichever account the extension holds a
  // token for. When those are two different people, acting on this would offer
  // tools that act as somebody else — and quietly fail.
  if (connected && mine && theirs && mine !== theirs) {
    explain(`Kick: this browser is signed in as ${standing.username}, but the connected `
      + `account is ${record.login} — moderation would act as the connected one, so the `
      + 'tools are left off here');
    return;
  }

  if (!standing.canModerate) return;

  // Kick says they moderate here, and the tools act through the connected
  // account's token. Without one there is nothing to offer — and saying so is
  // worth a line, because a moderator with no account connected is exactly the
  // person who would otherwise wonder where the buttons went.
  if (!connected) {
    explain('Kick: you moderate this channel — connect a Kick account in settings to '
      + 'moderate from here');
    return;
  }
  sink.moderator(true);
}

/**
 * Whether this viewer moderates the Kick channel that has just been joined.
 *
 * Kick answers this only to the signed-in web session, and only when that
 * session arrives as a bearer token. The extension's own token is an OAuth
 * token for Kick's public API, which that endpoint does not read. What it does
 * read is the `session_token` cookie kick.com sets, sent back as an
 * Authorization header — which is what Kick's own site does. The cookie is
 * not HttpOnly, and the `cookies` permission lets the worker read it, so the
 * worker can ask for itself: one request, and the answer is the same one the
 * tab would get.
 *
 * This is the route that works when Kick is merged into a Twitch tab, where
 * there is no kick.com page to ask. The tab is still asked when the worker
 * cannot find out — no cookie, or Kick declining — because a content script
 * on kick.com reads the same cookie without needing any permission at all.
 */
async function loadKickStanding(session, generation) {
  const conn = session.conns.kick;
  if (!conn || !conn.channel) return;
  const channel = conn.channel;
  const sink = makeSink(session, 'kick', generation);
  const [record, headers] = await Promise.all([FCM.auth.get('kick'), kickSessionHeaders()]);
  if (!sink.current() || conn.channel !== channel) return;

  const data = await FCM.getJson(kickStandingUrl(channel), { headers, credentials: 'include' });
  if (!sink.current() || conn.channel !== channel) return;
  const standing = FCM.readKickStanding(data);
  if (standing.known) {
    // `/me` never says whose standing it is, and the guard against acting as
    // somebody else needs the name. Only worth a request when there are tools
    // to guard; a failure leaves the name unknown, which is where it was.
    if (!standing.username && standing.canModerate && headers.Authorization) {
      const who = await FCM.getJson('https://kick.com/api/v1/user', { headers, credentials: 'include' });
      if (!sink.current() || conn.channel !== channel) return;
      standing.username = String(FCM.usernameFrom(who) || '');
    }
    applyKickStanding(session, sink, standing, record);
    return;
  }

  send(session, { type: 'needKickModerator', channel });
}

/**
 * The headers a request to kick.com's own API needs to be answered as the
 * signed-in viewer: the session cookie, as the bearer token Kick reads it as.
 * Just the Accept header when there is no session to send.
 */
async function kickSessionHeaders() {
  const headers = { Accept: 'application/json' };
  try {
    if (!chrome.cookies || !chrome.cookies.get) return headers;
    const cookie = await chrome.cookies.get({ url: 'https://kick.com/', name: 'session_token' });
    const value = cookie && cookie.value ? String(cookie.value) : '';
    if (value) headers.Authorization = `Bearer ${decodeURIComponentSafe(value)}`;
  } catch (e) {
    // No cookie access, or no cookie: the tab is asked instead.
  }
  return headers;
}

// A cookie value that was not percent-encoded is still a cookie value.
function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch (e) { return value; }
}

/**
 * The Cheermotes this channel accepts: the prefixes, so a Cheer can be told
 * apart from an ordinary word ending in digits before the message is sent, and
 * the tiers under each one, so a Cheer that arrives is drawn as the animation
 * it is rather than left in the feed as the text somebody typed.
 *
 * Worth asking the channel rather than assuming the global set, because a
 * broadcaster's own Cheermotes are exactly the ones a regular of that channel
 * types — and they are the ones with no picture anywhere else. A failure here
 * is not worth reporting: the overlay falls back to the global prefix list,
 * which still routes a Cheer correctly, and a Cheer with no tier known simply
 * stays as text, which is what it did before.
 */
async function loadCheermotes(session, platform, generation) {
  const conn = session.conns[platform];
  if (!conn || platform !== 'twitch' || !conn.roomId) return;
  const sink = makeSink(session, platform, generation);
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
  const tiers = FCM.parseCheermoteTiers(data);
  // Merged with the global list rather than replacing it: the API answers for
  // this channel, and a viewer who types a global Cheermote it omitted should
  // still have it recognised.
  const merged = Array.from(new Set([...FCM.GLOBAL_CHEERMOTES, ...prefixes]));
  // A custom prefix belongs to the channel that accepts it; the next channel
  // would recognise a word as a Cheer that it will not take.
  if (!sink.current()) return;
  send(session, { type: 'cheermotes', platform, prefixes: merged, tiers });
}

/**
 * What is known about this viewer's subscription to the channel, from both
 * the places Twitch says it, merged into one answer.
 *
 * The badges on USERSTATE say the tier for anyone wearing the subscriber
 * badge, and the months for anyone at all. Helix says the tier outright —
 * including for a founder, whose badge does not — but needs a scope the token
 * may not carry. Whichever knows the tier wins, and Helix knows better.
 *
 * @returns {{tier: number, months: number, subscribed: boolean,
 *   founder: boolean, isGift: boolean, source: string}|null} null while
 *   nothing has been learnt yet
 */
function mergedSubscription(conn) {
  const badges = conn.subBadges;
  const api = conn.subApi;
  if (badges === undefined && api === undefined) return null;
  const subscribed = !!(badges || (api && api.tier));
  return {
    subscribed,
    tier: (api && api.tier) || (badges && badges.tier) || 0,
    months: (badges && badges.months) || 0,
    founder: !!(badges && badges.founder),
    isGift: !!(api && api.isGift),
    source: api ? 'helix' : 'badges',
  };
}

function postSubscription(session, platform, generation) {
  const conn = session.conns[platform];
  const sink = makeSink(session, platform, generation);
  if (!sink.current()) return;
  const merged = mergedSubscription(conn);
  if (!merged) return;
  const key = JSON.stringify(merged);
  // Said once per change. USERSTATE arrives with every message this viewer
  // sends, and repeating the same answer would repeat the feed line that
  // announces it.
  if (conn.subAnnounced === key) return;
  conn.subAnnounced = key;
  conn.subscription = merged;
  send(session, { type: 'subscription', platform, subscription: merged });
}

/**
 * Asks Helix whether this viewer subscribes to the channel, and at which tier.
 *
 * Only with a token carrying `user:read:subscriptions`, which is requested at
 * sign-in; a token from before that scope existed simply leaves the badges to
 * answer. A 404 is Twitch's way of saying "not subscribed", and is an answer.
 */
async function loadSubscription(session, platform, generation) {
  const conn = session.conns[platform];
  if (!conn || platform !== 'twitch' || !conn.roomId) return;
  const sink = makeSink(session, platform, generation);
  const record = await FCM.auth.get('twitch');
  if (!record || !record.accessToken || !record.userId) return;
  const scopes = record.scopes || [];
  if (scopes.length && !scopes.includes('user:read:subscriptions')) return;
  const roomId = conn.roomId;
  const { reachable, data } = await FCM.getJsonResult(
    `${FCM.TWITCH_HELIX}/subscriptions/user`
    + `?broadcaster_id=${encodeURIComponent(roomId)}`
    + `&user_id=${encodeURIComponent(record.userId)}`,
    {
      headers: {
        Authorization: `Bearer ${record.accessToken}`,
        'Client-Id': record.clientId,
      },
    }
  );
  // The channel may have changed while Twitch was answering, and nobody
  // answering at all is not "not subscribed".
  if (!sink.current() || conn.roomId !== roomId || !reachable) return;
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  conn.subApi = entry
    ? { tier: FCM.TWITCH_TIER_NAMES[entry.tier] || 0, isGift: !!entry.is_gift }
    : { tier: 0, isGift: false };
  postSubscription(session, platform, generation);
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
async function loadTwitchEmotes(session, platform, generation) {
  const conn = session.conns[platform];
  if (!conn || platform !== 'twitch') return;
  const sink = makeSink(session, platform, generation);
  // One at a time, per connection.
  //
  // All three triggers land within a few milliseconds of a join, so all three
  // passes used to run at once: three times the Helix requests on every channel
  // change, against a bucket shared with everything else the account does. And
  // the pass started before Twitch had listed the account's emote sets builds a
  // strictly smaller store than the one started after — so when it finished
  // last it overwrote the bigger answer in the cache, and the next visit opened
  // with fewer emotes than the last one had already found.
  //
  // Queued rather than dropped, because each pass knows something the one
  // before it did not.
  conn.emoteChain = (conn.emoteChain || Promise.resolve())
    .catch(() => {})
    .then(() => loadTwitchEmotesNow(session, platform, generation, sink));
  return conn.emoteChain;
}

async function loadTwitchEmotesNow(session, platform, generation, sink) {
  const conn = session.conns[platform];
  if (!sink.current()) return;
  // Read now, not after the fetch. Everything below belongs to the channel this
  // was asked for, and by the time Twitch answers `conn` may describe the next
  // one — which is how one channel's emote list came to be sent to, and
  // cached under, another.
  const channel = conn.channel;
  const settings = await FCM.loadSettings();
  if (!sink.current()) return;
  const record = await FCM.auth.get('twitch');
  // Whatever this account signed in with, which is stored alongside the token.
  // Nothing is fetched to fill a gap here: every Helix call below needs that
  // token as well as the id, so a viewer with no account has nothing to ask
  // with and asking the proxy would buy an empty answer either way.
  const clientId = (record && record.clientId) || settings.twitchClientId || '';

  const store = await FCM.emoteLoader.twitchNative({
    clientId,
    token: record && record.accessToken,
    userId: record && record.userId,
    broadcasterId: conn.roomId,
    setIds: conn.emoteSets,
  });

  if (!sink.current()) return;
  const count = Object.keys(store).length;
  const signedOut = !record || !record.accessToken;
  if (!count) {
    // Nothing came back at all. Said here rather than below, because every line
    // that explained this sat under this return and so was never reached — a
    // signed-out viewer, who is the likeliest person to get an empty answer
    // from Twitch, was left with no Twitch emotes in the picker and nothing on
    // screen saying why.
    if (signedOut && !conn.announcedEmotes) {
      conn.announcedEmotes = true;
      sink.sys('No Twitch emotes could be loaded — connect a Twitch account in '
        + 'settings to load yours');
    }
    return;
  }
  // Only the first pass is worth saying out loud; the later ones are top-ups.
  sink.emotes('native', store);
  // Cached against the account as well as the channel: this list is the answer
  // to what *this* viewer may send here, and it grows across the three passes,
  // so the last and largest one is what ends up stored.
  // Only when this pass found at least as much as the best one so far. The
  // passes are not equal — an earlier one runs before Twitch has said which
  // sets this account may send — and the cache is what the next visit opens
  // with.
  if (count >= (conn.emoteBest || 0)) {
    conn.emoteBest = count;
    FCM.emoteCache
      .write(platform, channel, (record && record.userId) || '', 'native', store)
      .catch(() => {});
  }
  if (conn.announcedEmotes) return;
  conn.announcedEmotes = true;

  if (signedOut) {
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
  conn.channelId = null;
  conn.subscriberBadges = null;
  conn.roomId = null;
  conn.auth = null;
  conn.state = 'idle';
  // What has already been fetched, and what has already been said about it.
  // Left set, a channel joined again would be skipped as already done.
  conn.thirdPartyFor = null;
  conn.announcedThirdParty = false;
  conn.announcedEmotes = false;
  // The largest emote list seen for the channel being left says nothing about
  // the next one.
  conn.emoteBest = 0;
  if (conn.canModerate) {
    conn.canModerate = false;
    send(session, { type: 'moderator', platform, canModerate: false });
  }
  // The same for whether they moderate the channel being left, and for
  // anything already explained about it.
  conn.saidStanding = false;
  // Whatever was learnt about this viewer's subscription was about the channel
  // being left.
  conn.subBadges = undefined;
  conn.subApi = undefined;
  conn.subAnnounced = '';
  conn.subscription = null;
  if (had && !silent) {
    send(session, { type: 'sys', text: `Left ${FCM.PLATFORM_META[platform].name}: ${had}` });
    send(session, { type: 'status', platform, state: 'idle', channel: null });
  }
}

/**
 * Opens this platform's chat again, now that the account behind it has changed.
 *
 * A socket reads its token once, when it opens. A chat joined before an account
 * was connected is still the anonymous one, and stays anonymous however many
 * scopes have since been granted: Twitch sends USERSTATE only on an
 * authenticated connection, so there is no moderator standing, no list of the
 * emote sets this viewer may send, and their own messages come back without
 * their badges. Connecting an account in the settings sheet lit up the send
 * targets and changed nothing else until the page was reloaded.
 *
 * Leaving first is what makes this work: joinChannel returns early for a
 * channel it believes it is already connected to.
 */
function rejoinForAuth(session, platform) {
  const conn = session.conns[platform];
  const channel = conn && conn.channel;
  if (!channel) return;
  leaveChannel(session, platform, { silent: true });
  joinChannel(session, platform, channel).catch(() => {});
}

function teardown(session) {
  FCM.PLATFORMS.forEach((p) => leaveChannel(session, p, { silent: true }));
  if (session.livePollTimer) { clearInterval(session.livePollTimer); session.livePollTimer = null; }
}

// ── Counterpart discovery ─────────────────────────────────────────────────────

async function refreshCounterpart(session, { announce = false } = {}) {
  if (!session.site || !session.hostChannel) return;
  // The channel this answer will be about. Working out who a streamer is on the
  // other platform takes a page scan and up to two network round trips, and the
  // viewer can click through to the next channel inside that. Applying the
  // answer then does not just mislabel a chip: `autoConnectHost` acts on it, so
  // the panel would open one streamer's chat on another streamer's page and
  // present it as theirs. Anything resolved for a channel that has been left is
  // dropped.
  const site = session.site;
  const channel = session.hostChannel;
  const previous = session.counterpart;
  let summary = null;
  try {
    summary = await FCM.resolveCounterpart({
      platform: site,
      channel,
      hints: session.hints,
    });
  } catch (e) {
    summary = null;
  }
  if (session.site !== site || session.hostChannel !== channel) return;
  session.counterpart = summary;

  // A counterpart that has changed to somebody else, with the other platform
  // still connected to who it used to be.
  //
  // Which happens on a first visit as a matter of course: the same-name guess
  // is made before the page has drawn the streamer's own links, so a channel
  // whose Kick account is not simply their Twitch name is paired with whoever
  // does hold that name — and with cross-connect set to always, that stranger's
  // chat is joined and announced a second and a half before the page says who
  // the streamer actually is. Correcting the chip while leaving the wrong chat
  // merged into the feed is the worst of both. Leaving it first is what lets
  // the overlay connect the right one, since it only offers to when the other
  // platform has nothing joined.
  const other = FCM.otherPlatform(site);
  const otherConn = session.conns[other];
  const wasChannel = previous && FCM.normalizeChannel(previous.channel || '');
  const nowChannel = summary && FCM.normalizeChannel(summary.channel || '');
  const joined = otherConn && FCM.normalizeChannel(otherConn.channel || '');
  if (joined && wasChannel && nowChannel && joined === wasChannel && joined !== nowChannel) {
    leaveChannel(session, other);
  }

  const wasLive = !!(previous && previous.live);
  const isLive = !!(summary && summary.live);
  // Announce on the first resolve, and afterwards only when the other channel
  // has actually crossed from offline to live.
  const changed = announce || !previous || wasLive !== isLive
    // One appearing or disappearing counts too. Without this a lookup that
    // found nothing where there had been something cleared the worker's copy
    // and told nobody, so the panel went on showing a counterpart the worker no
    // longer had while the popup, which asks the worker, said there was none.
    || !!previous !== !!summary
    || (previous && summary && previous.channel !== summary.channel);

  if (changed) {
    send(session, {
      type: 'counterpart',
      counterpart: summary,
      hostPlatform: site,
      hostChannel: channel,
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
  syncHeartbeat();

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
        // What the last update check found, so a panel opening on a new page
        // shows the strip at once. The popup reads the same stored answer.
        FCM.updateStatus().then((status) => {
          if (status && status.available) post(session, { type: 'update', status });
        }).catch(() => {});
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
              // A reloaded page has to be told again, the same as the badge.
              subscription: session.conns[p].subscription || null,
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
            Promise.resolve(onJoined(session, p)).catch(() => {});
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

      case 'clip': {
        // What a clip somebody linked actually is, for the card under the
        // row. Answered with null when the platform has nothing to say, and
        // the row simply stays a link.
        const clip = await FCM.lookupClip(msg.platform, msg.clipId);
        send(session, { type: 'clip', id: msg.id, clip });
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
          // The chat this tab is already in was joined without the account.
          rejoinForAuth(session, msg.platform);
        } catch (e) {
          const explained = FCM.explainAuthFailure(msg.platform, e.message, e.authUrl, {
            redirect: e.usedRedirect,
            detail: e.detail,
          });
          send(session, { type: 'auth', accounts: await FCM.auth.summary() });
          send(session, { type: 'authError', platform: msg.platform, ...explained });
        }
        break;
      }

      case 'disconnectAccount':
        await FCM.auth.clear(msg.platform);
        // And the other way: a socket opened with a token that has just been
        // taken away would go on claiming this viewer can moderate here.
        rejoinForAuth(session, msg.platform);
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

      case 'kickModerator': {
        // The tab asked Kick, from the page's own origin, whether this viewer
        // moderates the channel — the one place Kick will answer it.
        //
        // This is a claim from the page, so it only ever turns the tools on,
        // and turning them on is not the same as being allowed to use them:
        // every action still goes to Kick with the connected account's token
        // and is refused there if it is not true.
        const conn = session.conns.kick;
        const want = FCM.normalizeChannel(msg.channel || '');
        if (!conn || !conn.channel || !want) break;
        if (FCM.normalizeChannel(conn.channel) !== want) break;
        applyKickStanding(session, makeSink(session, 'kick'), {
          known: true,
          canModerate: !!msg.canModerate,
          username: String(msg.username || ''),
        }, await FCM.auth.get('kick'));
        break;
      }

      case 'cacheKickEmotes': {
        // The tab fetched what Kick's edge would not hand this worker. It is
        // still this channel's list and still worth having next time.
        const conn = session.conns.kick;
        const want = FCM.normalizeChannel(msg.channel || '');
        if (!conn || !conn.channel || !want) break;
        if (FCM.normalizeChannel(conn.channel) !== want) break;
        await FCM.emoteCache.write(
          'kick', conn.channel, await accountIdFor('kick'), 'native', msg.store
        );
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
        syncHeartbeat();
      }
    }, 5000);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = sessions.get(tabId);
  if (!session) return;
  teardown(session);
  sessions.delete(tabId);
  syncHeartbeat();
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

/**
 * An account the token store gave up on, told to every open tab.
 *
 * Nothing asked for it to go — a refresh was refused because the token had been
 * revoked elsewhere — so nothing is waiting to repaint. Until this, the panel
 * went on offering to send as an account that was already gone, and said so in
 * the tooltip, and only found out when a message came back refused.
 */
FCM.auth.onCleared = async () => {
  const accounts = await FCM.auth.summary();
  sessions.forEach((session) => send(session, { type: 'auth', accounts }));
};

/**
 * A periodic alarm gives the worker a heartbeat even if a channel goes silent.
 *
 * Only while there is a tab to serve. Created unconditionally it went on firing
 * twice a minute for the life of the browser with every Twitch and Kick tab
 * long since closed — nearly three thousand service-worker cold starts a day,
 * each one loading the whole background bundle to find there was nothing to do.
 */
function syncHeartbeat() {
  try {
    if (sessions.size) chrome.alarms.create('fcm-heartbeat', { periodInMinutes: 0.5 });
    else chrome.alarms.clear('fcm-heartbeat');
  } catch (e) { /* no alarms available */ }
}

// Registered at the top level either way, so a wake from an alarm that is
// already scheduled always finds a handler.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (FCM.isUpdateAlarm(alarm.name)) {
    // Told to every open overlay as well as painted on the toolbar icon: the
    // icon is only there for people who pinned it, and the overlay is where
    // everyone else is looking.
    FCM.checkForUpdate().then((status) => {
      if (!status || !status.available) return;
      sessions.forEach((session) => post(session, { type: 'update', status }));
    }).catch(() => {});
    return;
  }
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
