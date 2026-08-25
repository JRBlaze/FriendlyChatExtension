// Runs the real content script against the real service worker.
//
// The suites elsewhere test each side against a stub of the other, which is
// where a bug that lives in the *timing between* them can hide. Here both
// halves are the shipped code, joined by a port that delivers asynchronously
// the way a real one does, over sockets that report their close a tick after
// being asked to — which is what makes navigation races reproducible.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSocketClass(registry) {
  function FakeWebSocket(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    this.openedAt = registry.length;
    registry.push(this);
    setTimeout(() => {
      if (this.closed) return;
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }, 0);
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  FakeWebSocket.prototype.send = function (d) { this.sent.push(String(d)); };
  FakeWebSocket.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    // Asynchronous, as the real thing is.
    setTimeout(() => { if (this.onclose) this.onclose(); }, 0);
  };
  FakeWebSocket.prototype.push = function (d) { if (this.onmessage) this.onmessage({ data: d }); };
  FakeWebSocket.prototype.drop = function () {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  };
  return FakeWebSocket;
}

/**
 * Boots the worker and one tab's content script, wired together.
 * @param {string} startPath the channel path the tab opens on
 */
function bootPair(startPath) {
  const sockets = [];
  const FakeWebSocket = makeSocketClass(sockets);
  const storage = { local: {}, sync: {} };
  const timers = new Set();
  const track = {
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.add(t); return t; },
    clearTimeout: (t) => { clearTimeout(t); timers.delete(t); },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; },
    clearInterval: (t) => { clearInterval(t); timers.delete(t); },
  };

  // chrome.storage is genuinely asynchronous and takes real milliseconds. The
  // worker awaits it twice between leaving a channel and connecting to the next
  // one, so that latency is the window a stale join can finish inside.
  const STORAGE_LATENCY_MS = 12;
  const storageApi = (area) => ({
    get: async (key) => {
      await wait(STORAGE_LATENCY_MS);
      return { [key]: storage[area][key] };
    },
    set: async (obj) => {
      await wait(STORAGE_LATENCY_MS);
      Object.assign(storage[area], obj);
    },
  });

  // ── Worker ────────────────────────────────────────────────────────────────
  const workerListeners = {};
  const workerSandbox = {
    console, URL, URLSearchParams, TextEncoder,
    WebSocket: FakeWebSocket,
    ...track,
    crypto: { getRandomValues: (a) => a, subtle: { digest: async () => new ArrayBuffer(32) } },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    fetch: async (url) => {
      const u = String(url);
      if (u.includes('gql.twitch.tv')) {
        return { ok: true, json: async () => ({ data: { user: null } }) };
      }
      if (/kick\.com\/api\/v\d\/channels\/([^/?]+)$/.test(u)) {
        const slug = u.match(/channels\/([^/?]+)$/)[1];
        return {
          ok: true,
          json: async () => ({
            id: 9, user_id: 77, slug, chatroom: { id: 55 }, livestream: null,
            user: { username: slug },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    chrome: {
      runtime: {
        onConnect: { addListener: (fn) => { workerListeners.connect = fn; } },
        onMessage: { addListener: () => {} },
        lastError: null,
      },
      tabs: { onRemoved: { addListener: () => {} } },
      alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
      storage: { local: storageApi('local'), sync: storageApi('sync') },
      identity: { getRedirectURL: () => 'https://ext.chromiumapp.org/' },
    },
    importScripts: (...paths) => {
      paths.forEach((rel) => {
        const file = String(rel).replace(/^\//, '');
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'),
          workerSandbox, { filename: file });
      });
    },
  };
  workerSandbox.self = workerSandbox;
  workerSandbox.globalThis = workerSandbox;
  vm.createContext(workerSandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8'),
    workerSandbox, { filename: 'service-worker.js' }
  );

  // ── One port, both ends, delivering asynchronously ────────────────────────
  const portLog = [];
  function makePort(tabId) {
    let contentRecv = null;
    let workerRecv = null;
    let workerGone = null;
    let contentGone = null;
    let dead = false;

    const contentEnd = {
      postMessage(msg) {
        if (dead) return;
        portLog.push({ dir: 'to-worker', msg });
        track.setTimeout(() => { if (!dead && workerRecv) workerRecv(msg); }, 0);
      },
      disconnect() {
        if (dead) return;
        dead = true;
        track.setTimeout(() => { if (workerGone) workerGone(); }, 0);
      },
      onMessage: { addListener: (fn) => { contentRecv = fn; } },
      onDisconnect: { addListener: (fn) => { contentGone = fn; } },
    };

    const workerEnd = {
      name: 'fcm',
      sender: { tab: { id: tabId } },
      postMessage(msg) {
        if (dead) return;
        portLog.push({ dir: 'to-tab', msg });
        track.setTimeout(() => { if (!dead && contentRecv) contentRecv(msg); }, 0);
      },
      onMessage: { addListener: (fn) => { workerRecv = fn; } },
      onDisconnect: { addListener: (fn) => { workerGone = fn; } },
    };
    contentEnd.__kill = () => { dead = true; if (contentGone) contentGone(); };
    return { contentEnd, workerEnd };
  }

  // ── Content script ────────────────────────────────────────────────────────
  const location = {
    hostname: 'www.twitch.tv',
    pathname: startPath,
    get href() { return 'https://www.twitch.tv' + this.pathname; },
  };
  const overlays = [];
  // A page reload is a second content script against the same worker, so the
  // whole content half is built by a function rather than once inline.
  let pollers = [];
  let livePorts = [];

  function makeContent() {
  pollers = [];
  livePorts = [];
  const contentSandbox = {
    console, URL, URLSearchParams,
    ...track,
    location,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: {
      documentElement: { appendChild() {}, className: '', dataset: {}, getAttribute: () => null },
      body: { className: '' },
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        dataset: {}, style: {}, appendChild() {}, addEventListener() {},
        classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      }),
    },
    chrome: {
      runtime: {
        connect() {
          const { contentEnd, workerEnd } = makePort(1);
          // The worker sees the connection the way Chrome delivers it.
          workerListeners.connect(workerEnd);
          livePorts.push(contentEnd);
          return contentEnd;
        },
      },
      storage: {
        sync: storageApi('sync'), local: storageApi('local'),
        onChanged: { addListener() {} },
      },
    },
  };
  contentSandbox.self = contentSandbox;
  contentSandbox.globalThis = contentSandbox;
  // The URL poller boot installs must be reachable from the test.
  contentSandbox.setInterval = (fn, ms) => {
    if (ms === 600) pollers.push(fn);
    return track.setInterval(fn, ms);
  };
  vm.createContext(contentSandbox);

  [
    'src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/util.js',
    'src/shared/irc.js', 'src/shared/emote-parsers.js', 'src/shared/kick-events.js',
    'src/content/sites.js',
  ].forEach((rel) => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), contentSandbox, { filename: rel });
  });

  contentSandbox.FCM.createOverlay = (opts) => {
    const o = {
      channel: opts.channel, destroyed: false, statuses: [],
      // What the page was actually given, which is the whole question a reload
      // asks: a fresh page gets none of this unless the worker sends it again.
      batches: [], emoteSets: [], badgeSets: [],
      mount: async () => o,
      destroy() { o.destroyed = true; },
      sys() {}, event() {}, chat() {},
      batch(rows) { o.batches.push(rows || []); },
      setEmotes(platform, kind, store) { o.emoteSets.push({ platform, kind, store }); },
      setBadges(platform, badges) { o.badgeSets.push({ platform, badges }); },
      deleteMessage() {}, deleteUser() {}, setCounterpart() {}, setAccounts() {},
      setModerator() {}, modResult() {}, sendResult() {}, applyStoredSettings() {}, toast() {},
      setStatus(platform, state, channel) { o.statuses.push({ platform, state, channel }); },
    };
    overlays.push(o);
    return o;
  };

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/boot.js'), 'utf8'),
    contentSandbox, { filename: 'boot.js' });
  }

  makeContent();

  return {
    sockets, overlays, portLog, location,
    async navigateTo(pathname) {
      location.pathname = pathname;
      pollers.forEach((fn) => fn());
      await wait(150);
    },
    /**
     * Reloads the page: the document goes away, taking its port with it, and a
     * new content script starts against the same worker — whose sockets never
     * noticed. Nothing re-joins, which is what makes this worth testing.
     */
    async reloadPage() {
      livePorts.forEach((p) => { try { p.disconnect(); } catch (e) { /* already gone */ } });
      makeContent();
      await wait(400);
      return overlays[overlays.length - 1];
    },
    ircSockets() { return sockets.filter((s) => s.url.includes('irc-ws')); },
    joins() {
      return this.ircSockets().flatMap((s) => s.sent.filter((l) => l.startsWith('JOIN ')));
    },
    liveIrc() { return this.ircSockets().filter((s) => !s.closed); },
    teardown() { timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); },
  };
}

module.exports = { bootPair, wait };
