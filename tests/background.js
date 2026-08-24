// Integration harness for the background service worker.
//
// It loads the real service-worker.js with chrome.*, WebSocket and fetch
// stubbed, then drives it exactly as a content script does: connect a port,
// say hello, join channels, push raw socket frames in, and read back what the
// worker posts to the tab. Nothing here touches the network.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

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
 * @param {object} opts { fetchImpl }
 */
function bootWorker(opts = {}) {
  const sockets = [];
  const FakeWebSocket = makeFakeSocket(sockets);
  const storage = { local: {}, sync: {} };
  const posted = [];
  const fetchCalls = [];
  const timers = { intervals: new Set(), timeouts: new Set() };

  const listeners = {};
  const chrome = {
    runtime: {
      onConnect: { addListener: (fn) => { listeners.connect = fn; } },
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      lastError: null,
    },
    tabs: { onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } } },
    alarms: {
      create: (name, info) => { listeners.alarmInfo = { name, info }; },
      onAlarm: { addListener: (fn) => { listeners.alarm = fn; } },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: storage.local[key] }),
        set: async (obj) => { Object.assign(storage.local, obj); },
      },
      sync: {
        get: async (key) => ({ [key]: storage.sync[key] }),
        set: async (obj) => { Object.assign(storage.sync, obj); },
      },
    },
    identity: { getRedirectURL: () => 'https://ext.chromiumapp.org/' },
  };

  const defaultFetch = async (url, init) => {
    const u = String(url);
    fetchCalls.push({ url: u, init });
    if (u.includes('gql.twitch.tv')) {
      const body = JSON.parse(init.body);
      const query = Array.isArray(body) ? '' : String(body.query || '');
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
    if (u.includes('/messages?limit=')) {
      return { ok: true, json: async () => ({ data: { messages: [] } }) };
    }
    if (u.includes('recent-messages.robotty.de')) {
      return { ok: true, json: async () => ({ messages: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const sandbox = {
    console,
    URL,
    WebSocket: FakeWebSocket,
    chrome,
    crypto: { getRandomValues: (a) => a, subtle: { digest: async () => new ArrayBuffer(32) } },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TextEncoder,
    fetch: opts.fetchImpl || defaultFetch,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.timeouts.add(t); return t; },
    clearTimeout: (t) => { clearTimeout(t); timers.timeouts.delete(t); },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.intervals.add(t); return t; },
    clearInterval: (t) => { clearInterval(t); timers.intervals.delete(t); },
    importScripts: (...paths) => {
      paths.forEach((p) => {
        const rel = String(p).replace(/^\//, '');
        vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
      });
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8'),
    sandbox,
    { filename: 'service-worker.js' }
  );

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
    sandbox, sockets, posted, fetchCalls, storage, listeners, timers, makeTab,
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

module.exports = { bootWorker, wait };
