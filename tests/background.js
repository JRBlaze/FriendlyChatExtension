// Integration harness for the background service worker.
//
// It loads the real service-worker.js with chrome.*, WebSocket and fetch
// stubbed, then drives it exactly as a content script does: connect a port,
// say hello, join channels, push raw socket frames in, and read back what the
// worker posts to the tab. Nothing here touches the network.
//
// It boots the Chrome way unless asked otherwise. `loadPath: 'scripts'` boots
// the same files the way Firefox's event page runs them instead (see
// tests/load-background.js), and `browser: 'firefox'` makes the extension API
// answer the way Firefox's does where the two differ.
const pack = require('../tools/pack.js');
const { loadBackground, backgroundManifest, extensionOrigin } = require('./load-background.js');

/**
 * Whether a granted host pattern covers a wanted one, the way Firefox's
 * permissions.contains answers: a grant covers every pattern it subsumes, not
 * only one written the same. `*://*.twitch.tv/*` covers `https://www.twitch.tv/*`
 * and `https://gql.twitch.tv/*`; `*://www.twitch.tv/*` covers
 * `https://www.twitch.tv/*` and nothing on any other twitch.tv address;
 * `https://www.twitch.tv/*` covers neither `http://` nor `*://`.
 *
 * Just enough of match patterns for the ones the extension asks about: a
 * scheme or `*`, a host or `*.` in front of one, and a path.
 */
function patternCovers(granted, wanted) {
  if (granted === wanted) return true;
  const parts = (p) => /^(\*|[a-z-]+):\/\/([^/]+)(\/.*)$/.exec(String(p));
  const g = parts(granted);
  const w = parts(wanted);
  if (!g || !w) return false;
  const scheme = g[1] === w[1] || (g[1] === '*' && ['http', 'https'].includes(w[1]));
  const host = g[2] === w[2]
    || (g[2].startsWith('*.') && (w[2] === g[2].slice(2) || w[2].endsWith(g[2].slice(1))));
  const pathCovered = g[3] === '/*' || g[3] === w[3];
  return scheme && host && pathCovered;
}

function makeFakeSocket(registry) {
  function FakeWebSocket(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closed = false;
    registry.push(this);
    setTimeout(() => {
      if (this.closed) return;
      this.readyState = FakeWebSocket.OPEN;
      if (this.onopen) this.onopen();
    }, 0);
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  FakeWebSocket.prototype.send = function (data) { this.sent.push(String(data)); };
  // close() marks the socket shut straight away but reports it a tick later,
  // exactly as a real WebSocket does. That gap is where a stale onclose can run
  // after its replacement has already been created, so the fake has to have it
  // or the race it causes cannot be reproduced.
  FakeWebSocket.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    setTimeout(() => { if (this.onclose) this.onclose(); }, 0);
  };
  // Test-side helpers.
  FakeWebSocket.prototype.push = function (data) {
    if (this.onmessage) this.onmessage({ data });
  };
  FakeWebSocket.prototype.drop = function () {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose();
  };
  return FakeWebSocket;
}

/**
 * Boots the worker in an isolated context.
 * @param {object} opts
 *   fetchImpl, hold, cookies, twitchClips, kickClips, kickHistory, twitchHistory
 *     — the network and cookie jar, as before;
 *   loadPath — 'worker' (default: Chrome's service worker) or 'scripts'
 *     (Firefox's event page);
 *   browser — 'chrome' (default) or 'firefox': where runtime.getURL says the
 *     extension is served from, which is what FCM.BROWSER is worked out from;
 *   manifest — the Chrome manifest to boot under (default: the repository's);
 *   grants — the origins and permissions permissions.contains reports as
 *     granted (default: every one, as on an install nothing has been revoked);
 *   redirectUrl — what identity.getRedirectURL answers (default: a
 *     chromiumapp.org address, or this add-on's allizom.org one on Firefox);
 *   seed — `{ local, sync }`, what storage already holds when the background
 *     starts, for anything it reads on its very first run;
 *   updateUrl — on the Firefox load path, what the manifest names as its
 *     update_url in place of tools/pack.js's (null: a package without one);
 *   alarms — `{ name: info }`, alarms an earlier run left scheduled, which
 *     outlive the background they were made in
 * What it hands back also carries `badge`, the toolbar badge as last painted,
 * and `permissionChecks`, every question put to permissions.contains.
 */
function bootWorker(opts = {}) {
  const sockets = [];
  const FakeWebSocket = makeFakeSocket(sockets);
  // Copied all the way down: the storage stub hands out what it holds rather
  // than copies, so a worker that changed a seeded record would otherwise be
  // changing the seed every later boot is handed as well.
  const seeded = (area) => JSON.parse(JSON.stringify((opts.seed && opts.seed[area]) || {}));
  const storage = { local: seeded('local'), sync: seeded('sync') };
  const badge = { text: '', color: null, textColor: null };
  const permissionChecks = [];
  const posted = [];
  const fetchCalls = [];
  const timers = { intervals: new Set(), timeouts: new Set() };
  const browser = opts.browser === 'firefox' ? 'firefox' : 'chrome';
  const manifest = backgroundManifest(opts);

  const listeners = {};
  const alarms = new Map(Object.entries(JSON.parse(JSON.stringify(opts.alarms || {}))));
  const chrome = {
    runtime: {
      onConnect: { addListener: (fn) => { listeners.connect = fn; } },
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      lastError: null,
      getURL: (p = '') => `${extensionOrigin(browser)}/${String(p).replace(/^\//, '')}`,
      // A fresh copy each time, as the browser hands out, so nothing a test
      // does to one can change what the next caller reads.
      getManifest: () => JSON.parse(JSON.stringify(manifest)),
    },
    tabs: { onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } } },
    // Alarms are kept rather than only noted, because whether one exists is
    // the whole question for both the heartbeat and the update check.
    alarms: {
      create: (name, info) => { alarms.set(name, info); listeners.alarmInfo = { name, info }; },
      clear: async (name) => alarms.delete(name),
      get: async (name) => alarms.get(name) || undefined,
      onAlarm: { addListener: (fn) => { listeners.alarm = fn; } },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: storage.local[key] }),
        set: async (obj) => { Object.assign(storage.local, obj); },
        remove: async (key) => { delete storage.local[key]; },
      },
      sync: {
        get: async (key) => ({ [key]: storage.sync[key] }),
        set: async (obj) => { Object.assign(storage.sync, obj); },
      },
    },
    // Everything granted unless a test lists what is. Firefox lets a user take
    // any host back at any time, so "not granted" has to be something a test
    // can say. The list is read on every question, so a test can grant or take
    // back a host by changing the array it passed, then fire the event Firefox
    // would (listeners.permissionsAdded / permissionsRemoved). Every question
    // is noted, so a test can also say that one was never asked. A granted
    // origin answers for every origin it covers (patternCovers), as in Firefox.
    permissions: {
      contains: async ({ origins = [], permissions = [] } = {}) => {
        permissionChecks.push([...origins, ...permissions]);
        return !Array.isArray(opts.grants)
          || (origins.every((wanted) => opts.grants.some((granted) => patternCovers(granted, wanted)))
            && permissions.every((wanted) => opts.grants.includes(wanted)));
      },
      onAdded: { addListener: (fn) => { listeners.permissionsAdded = fn; } },
      onRemoved: { addListener: (fn) => { listeners.permissionsRemoved = fn; } },
    },
    identity: {
      getRedirectURL: () => opts.redirectUrl
        || (browser === 'firefox' ? pack.firefoxRedirectUrl() : 'https://ext.chromiumapp.org/'),
    },
    // The toolbar badge, kept as the browser would show it: the update check
    // paints a dot there, and on Firefox the site-access check paints over it.
    action: {
      setBadgeText: async ({ text }) => { badge.text = text; },
      setBadgeBackgroundColor: async ({ color }) => { badge.color = color; },
      setBadgeTextColor: async ({ color }) => { badge.textColor = color; },
    },
    // The browser's cookie jar, as far as the worker can see it: only what a
    // test put there under `opts.cookies`, keyed by name.
    cookies: {
      get: async ({ name }) => (opts.cookies && opts.cookies[name] !== undefined
        ? { name, value: String(opts.cookies[name]) } : null),
    },
  };

  const defaultFetch = async (url, init) => {
    const u = String(url);
    fetchCalls.push({ url: u, init });
    if (u.includes('gql.twitch.tv')) {
      const body = JSON.parse(init.body);
      const query = Array.isArray(body) ? '' : String(body.query || '');
      if (query.includes('clip(slug:')) {
        const slug = body.variables && body.variables.s;
        const known = opts.twitchClips && opts.twitchClips[slug];
        return { ok: true, json: async () => ({ data: { clip: known || null } }) };
      }
      if (query.includes('badges')) {
        return { ok: true, json: async () => ({ data: { badges: [], user: { broadcastBadges: [] } } }) };
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            user: {
              id: '1', login: 'somechannel', displayName: 'SomeChannel',
              profileImageURL: '', stream: null,
            },
          },
        }),
      };
    }
    if (/kick\.com\/api\/v\d\/channels\/([^/?]+)$/.test(u)) {
      const slug = u.match(/channels\/([^/?]+)$/)[1];
      return {
        ok: true,
        json: async () => ({
          id: 9, user_id: 77, slug,
          chatroom: { id: 55 },
          livestream: { session_title: 'live!', viewer_count: 10, categories: [{ name: 'IRL' }] },
          user: { username: slug, profile_pic: '' },
        }),
      };
    }
    if (/kick\.com\/api\/v2\/clips\/([^/?]+)$/.test(u)) {
      const id = u.match(/clips\/([^/?]+)$/)[1];
      const known = opts.kickClips && opts.kickClips[id];
      if (!known) return { ok: false, status: 404, json: async () => ({ message: '' }) };
      return { ok: true, json: async () => ({ clip: known }) };
    }
    if (u.includes('/messages?limit=')) {
      return { ok: true, json: async () => ({ data: { messages: opts.kickHistory || [] } }) };
    }
    if (u.includes('recent-messages.robotty.de')) {
      return { ok: true, json: async () => ({ messages: opts.twitchHistory || [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  /**
   * The default responses, but with a request held open until the test lets it
   * go.
   *
   * `opts.hold(url)` returns a promise for the calls it wants to stall and
   * nothing for the rest. Every channel-switch race in the worker lives in the
   * window between asking for something and being answered, so a test can only
   * reach it by holding that window open on purpose.
   */
  const heldFetch = async (url, init) => {
    const gate = opts.hold && opts.hold(String(url));
    if (gate) await gate;
    return defaultFetch(url, init);
  };

  const sandbox = {
    console,
    URL,
    WebSocket: FakeWebSocket,
    chrome,
    crypto: { getRandomValues: (a) => a, subtle: { digest: async () => new ArrayBuffer(32) } },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TextEncoder,
    fetch: opts.fetchImpl || (opts.hold ? heldFetch : defaultFetch),
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.timeouts.add(t); return t; },
    clearTimeout: (t) => { clearTimeout(t); timers.timeouts.delete(t); },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.intervals.add(t); return t; },
    clearInterval: (t) => { clearInterval(t); timers.intervals.delete(t); },
  };

  const { loaded } = loadBackground(sandbox, { loadPath: opts.loadPath, manifest });

  // Stands in for one tab's end of the port. Each tab gets its own inbox, which
  // is what makes it possible to prove that two open streams stay separate.
  function makeTab(tabId) {
    const inbox = [];
    const tabPort = {
      name: 'fcm',
      sender: { tab: { id: tabId } },
      postMessage: (m) => { inbox.push(m); posted.push(m); },
      onMessage: { addListener: (fn) => { tabPort._recv = fn; } },
      onDisconnect: { addListener: (fn) => { tabPort._gone = fn; } },
    };

    return {
      id: tabId,
      port: tabPort,
      inbox,
      connect() { listeners.connect(tabPort); return this; },
      send(msg) { return tabPort._recv(msg); },
      disconnect() { if (tabPort._gone) tabPort._gone(); },
      of(type) { return inbox.filter((m) => m.type === type); },
      last(type) { const all = this.of(type); return all[all.length - 1]; },
      clear() { inbox.length = 0; },
    };
  }

  const port = makeTab(1);

  return {
    sandbox, sockets, posted, fetchCalls, storage, listeners, timers, makeTab, alarms,
    manifest, loaded, loadPath: opts.loadPath || 'worker', browser, badge, permissionChecks,
    port: port.port,
    connect() { port.connect(); return port.port; },
    send(msg) { return port.send(msg); },
    of(type) { return posted.filter((m) => m.type === type); },
    last(type) { const all = this.of(type); return all[all.length - 1]; },
    clear() { posted.length = 0; port.clear(); },
    socketFor(fragment) { return sockets.find((s) => s.url.includes(fragment)); },
    socketsFor(fragment) { return sockets.filter((s) => s.url.includes(fragment)); },
    teardown() {
      timers.intervals.forEach((t) => clearInterval(t));
      timers.timeouts.forEach((t) => clearTimeout(t));
    },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { bootWorker, wait, patternCovers };
