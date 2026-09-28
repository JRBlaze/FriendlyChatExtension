'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const VIDEO = 'abcdefghijk';
const RUN = 'a'.repeat(32);
const RUN2 = 'b'.repeat(32);
const CHANNEL = 'https://www.youtube.com/@SyntheticChannel';

function event() {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); },
    removeListener(fn) { const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1); },
    emit(...args) { return [...listeners].map(fn => fn(...args)); } };
}
function port(name, sender) {
  return {
    name, sender, onMessage: event(), onDisconnect: event(), sent: [], closed: false,
    failPost: false, failDisconnect: false,
    postMessage(message) { if (this.failPost) throw Error('closed'); this.sent.push(message); },
    disconnect() {
      if (this.failDisconnect) throw Error('closed');
      if (!this.closed) { this.closed = true; this.onDisconnect.emit(); }
    },
  };
}
function sender(overrides = {}) {
  return { id: 'extension', tab: { id: 1 }, frameId: 0, url: 'https://www.twitch.tv/channel', ...overrides };
}
function readerSender(overrides = {}) {
  return sender({ frameId: 3, url: `https://www.youtube.com/live_chat?v=${VIDEO}&embed_domain=www.twitch.tv#fcm-youtube=${RUN}`, ...overrides });
}
function youtube() {
  return {
    videoId(value) { if (!/^[A-Za-z0-9_-]{11}$/.test(value)) throw Error('invalid'); return value; },
    parseInput(value) { return value === CHANNEL ? { channelUrl: CHANNEL } : { videoId: this.videoId(value) }; },
    sanitizeBatch(value, video, run) {
      if (!value || value.type !== 'batch' || value.videoId !== video || value.run !== run || value.invalid) return null;
      return { type: 'batch', videoId: video, run, messages: [], deleted: [], ready: value.ready === true };
    },
  };
}
function evaluate(file, context) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: path.join(ROOT, file) });
}
function scripting() {
  const registered = [];
  return { registered, queries: 0, writes: 0,
    async getRegisteredContentScripts({ ids }) { this.queries++; return registered.filter(script => ids.includes(script.id)); },
    async registerContentScripts(scripts) { this.writes++; registered.push(...scripts); },
  };
}
function relay(withPermissionEvents = false) {
  const chrome = {
    runtime: { id: 'extension', onConnect: event(), onMessage: event() },
    permissions: { contains: async () => true,
      ...(withPermissionEvents ? { onAdded: event(), onRemoved: event() } : {}) },
    scripting: scripting(),
  };
  const context = vm.createContext({ chrome, FCM: { youtube: youtube() }, URL, Map, Set });
  evaluate('src/background/youtube-relay.js', context);
  const add = p => { chrome.runtime.onConnect.emit(p); return p; };
  const host = (s = sender()) => add(port('fcm-youtube-host', s));
  const reader = (s = readerSender()) => add(port('fcm-youtube-reader', s));
  const start = (p, run = RUN) => p.onMessage.emit({ cmd: 'start', videoId: VIDEO, run });
  return { chrome, add, host, reader, start };
}
function clock() {
  let next = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fire(delay) {
      const found = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(found, `expected timer ${delay}`);
      timers.delete(found[0]); found[1].fn();
    },
  };
}
function source(useDefaultDocument = false) {
  const time = clock();
  const frames = [];
  const doc = {
    location: { hostname: 'www.twitch.tv' },
    createElement(tag) {
      assert.equal(tag, 'iframe');
      return { style: {}, removed: false, remove() { this.removed = true; } };
    },
    body: { append(frame) { frames.push(frame); } },
  };
  let nonce = 0;
  const chrome = {
    runtime: {
      ports: [],
      async sendMessage(message) { assert.equal(message.cmd, 'youtubePermission'); return { granted: true }; },
      connect({ name }) { const p = port(name); this.ports.push(p); return p; },
    },
  };
  const context = vm.createContext({
    FCM: { youtube: youtube() }, chrome, document: doc, URL, Uint8Array,
    crypto: { getRandomValues(array) { return array.fill(++nonce); } },
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
  });
  evaluate('src/content/youtube-source.js', context);
  const statuses = [], batches = [];
  const options = { onStatus: value => statuses.push(value), onBatch: value => batches.push(value) };
  if (!useDefaultDocument) options.document = doc;
  const control = context.FCM.createYouTubeSource(options);
  const activePort = () => chrome.runtime.ports.at(-1);
  const message = (type, extra = {}, p = activePort()) => p.onMessage.emit({ type, videoId: VIDEO, run: p.sent[0].run, ...extra });
  return { context, control, statuses, batches, chrome, doc, frames, time, activePort, message };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function run() {
  // Runtime sender trust boundary: exact extension, tab, frame and HTTPS host.
  {
    const r = relay();
    const other = r.add(port('other', null));
    assert.equal(other.closed, false);
    const invalid = [undefined, null, {}, sender({ id: 'foreign' }), sender({ tab: null }),
      sender({ tab: { id: -1 } }), sender({ tab: { id: '1' } }), sender({ frameId: 2 }),
      sender({ frameId: null }), sender({ url: 'not a URL' }), sender({ url: 'http://www.twitch.tv/channel' }),
      sender({ url: 'https://www.twitch.tv:444/channel' }), sender({ url: 'https://name@www.twitch.tv/channel' }),
      sender({ url: 'https://:secret@www.twitch.tv/channel' }), sender({ url: 'https://www.twitch.tv.evil.test/' })];
    for (const value of invalid) assert.equal(r.add(port('fcm-youtube-host', value)).closed, true);
    for (const host of ['twitch.tv', 'www.twitch.tv', 'kick.com', 'www.kick.com']) {
      const p = r.host(sender({ url: `https://${host}/channel` }));
      assert.equal(p.closed, false); p.disconnect();
    }
    const broken = port('fcm-youtube-host', null); broken.failDisconnect = true; r.add(broken);
    const badReaders = [readerSender({ frameId: 0 }), readerSender({ frameId: -1 }),
      readerSender({ url: `https://youtube.com/live_chat?v=${VIDEO}#fcm-youtube=${RUN}` }),
      readerSender({ url: `https://www.youtube.com/watch?v=${VIDEO}#fcm-youtube=${RUN}` }),
      readerSender({ url: `https://www.youtube.com/live_chat?v=${VIDEO}&v=${VIDEO}#fcm-youtube=${RUN}` }),
      readerSender({ url: `https://www.youtube.com/live_chat#fcm-youtube=${RUN}` }),
      readerSender({ url: `https://www.youtube.com/live_chat?v=${VIDEO}#fcm-youtube=bad` })];
    for (const value of badReaders) assert.equal(r.reader(value).closed, true);
    assert.equal(r.reader().closed, true, 'no registered host');
  }
  // Permission checks are read-only; grant requests remain in extension UI.
  {
    const r = relay();
    const listener = r.chrome.runtime.onMessage.listeners[0];
    let response;
    const respond = value => { response = value; };
    assert.equal(listener(null, null, respond), false);
    assert.equal(listener({}, sender(), respond), false);
    assert.equal(listener({ cmd: 'youtubePermission' }, null, respond), false);
    assert.equal(response.granted, false);
    assert.equal(listener({ cmd: 'youtubePermission' }, sender(), respond), true);
    await settle(); assert.equal(response.granted, true);
    r.chrome.permissions.contains = async () => 'truthy';
    listener({ cmd: 'youtubePermission' }, sender(), respond); await settle(); assert.equal(response.granted, false);
    r.chrome.permissions.contains = async () => { throw Error('unavailable'); };
    listener({ cmd: 'youtubePermission' }, sender(), respond); await settle(); assert.equal(response.granted, false);
    r.chrome.permissions.contains = () => { throw Error('missing'); };
    assert.equal(listener({ cmd: 'youtubePermission' }, sender(), respond), false);
  }
  // Optional permission does not become a static install grant: registration
  // happens only after a granted Start, is single-flight and survives a restart.
  {
    const r = relay(); const listener = r.chrome.runtime.onMessage.listeners[0];
    assert.equal(r.chrome.scripting.queries, 0); assert.equal(r.chrome.scripting.writes, 0);
    const responses = [];
    r.chrome.permissions.contains = async () => false;
    listener({ cmd: 'youtubePermission' }, sender(), result => responses.push(result));
    await settle(); assert.equal(responses[0].granted, false); assert.equal(r.chrome.scripting.queries, 0);
    r.chrome.permissions.contains = async () => true;
    for (let i = 0; i < 3; i++) listener({ cmd: 'youtubePermission' }, sender({ tab: { id: i } }), result => responses.push(result));
    await settle(); assert.equal(r.chrome.scripting.queries, 1); assert.equal(r.chrome.scripting.writes, 1);
    assert.equal(responses.length, 4); assert.ok(responses.slice(1).every(response => response.granted));
    const script = r.chrome.scripting.registered[0];
    assert.equal(script.id, 'fcm-youtube-reader'); assert.equal(script.matches.join(), 'https://www.youtube.com/live_chat*');
    assert.equal(script.js.join(), 'src/shared/namespace.js,src/shared/youtube.js,src/content/youtube-send.js,src/content/youtube-access.js,src/content/youtube-reader.js');
    assert.equal(script.allFrames, true); assert.equal(script.runAt, 'document_idle'); assert.equal(script.persistAcrossSessions, false);
    listener({ cmd: 'youtubePermission' }, sender(), result => responses.push(result)); await settle();
    assert.equal(r.chrome.scripting.queries, 2); assert.equal(r.chrome.scripting.writes, 1);
    const restarted = relay(); restarted.chrome.scripting = r.chrome.scripting;
    restarted.chrome.runtime.onMessage.listeners[0]({ cmd: 'youtubePermission' }, sender(), result => responses.push(result)); await settle();
    assert.equal(r.chrome.scripting.writes, 1, 'worker restart reuses registered script');
    for (const failure of ['query', 'write']) {
      const broken = relay(); const read = broken.chrome.runtime.onMessage.listeners[0]; const api = broken.chrome.scripting;
      const method = failure === 'query' ? 'getRegisteredContentScripts' : 'registerContentScripts';
      const original = api[method]; api[method] = async () => { throw Error('unavailable'); };
      let response; read({ cmd: 'youtubePermission' }, sender(), result => { response = result; }); await settle();
      assert.equal(response.error, 'reader-registration');
      api[method] = original; read({ cmd: 'youtubePermission' }, sender(), result => { response = result; }); await settle();
      assert.equal(response.granted, true); assert.equal(response.error, undefined, 'registration failure is retryable');
    }
  }
  // One host/reader per tab and generation; stale and competing readers fail closed.
  {
    const r = relay(); const host = r.host();
    for (const value of [null, {}, { cmd: 'else' }, { cmd: 'start' },
      { cmd: 'start', videoId: 4, run: RUN }, { cmd: 'start', videoId: 'bad', run: RUN },
      { cmd: 'start', videoId: VIDEO }, { cmd: 'start', videoId: VIDEO, run: false },
      { cmd: 'start', videoId: VIDEO, run: 'bad' }]) host.onMessage.emit(value);
    assert.equal(host.sent.length, 0);
    r.start(host);
    assert.equal(host.sent[0].type, 'host-ready');
    assert.equal(r.reader(readerSender({ tab: { id: 2 } })).closed, true, 'cross-tab rejected');
    assert.equal(r.reader(readerSender({ url: `https://www.youtube.com/live_chat?v=ZYXWVUTSRQP#fcm-youtube=${RUN}` })).closed, true);
    assert.equal(r.reader(readerSender({ url: `https://www.youtube.com/live_chat?v=${VIDEO}#fcm-youtube=${RUN2}` })).closed, true);
    const reader = r.reader(); assert.equal(reader.sent[0].type, 'reader-ready');
    assert.equal(r.reader(readerSender({ frameId: 4 })).closed, true, 'competing frame rejected');
    reader.onMessage.emit({ type: 'batch', videoId: VIDEO, run: RUN, ready: true });
    assert.equal(host.sent.at(-1).ready, true);
    const count = host.sent.length;
    reader.onMessage.emit({ type: 'batch', videoId: VIDEO, run: RUN2 });
    assert.equal(host.sent.length, count);
    r.start(host, RUN2);
    assert.equal(reader.closed, true);
    reader.onMessage.emit({ type: 'batch', videoId: VIDEO, run: RUN });
    reader.onDisconnect.emit();
    const reader2 = r.reader(readerSender({ url: `https://www.youtube.com/live_chat?v=${VIDEO}#fcm-youtube=${RUN2}` }));
    reader2.disconnect(); assert.equal(host.sent.at(-1).type, 'reader-disconnected');
    const reader3 = r.reader(readerSender({ url: `https://www.youtube.com/live_chat?v=${VIDEO}#fcm-youtube=${RUN2}` }));
    const replacement = r.host();
    assert.equal(host.closed, true); assert.equal(reader3.closed, true);
    host.onMessage.emit({ cmd: 'start', videoId: VIDEO, run: RUN });
    reader3.onMessage.emit({ type: 'batch', videoId: VIDEO, run: RUN2 });
    assert.equal(replacement.sent.length, 0);
    r.start(replacement); const last = r.reader(); replacement.disconnect(); assert.equal(last.closed, true);
  }
  // Posting/disconnect failures always release the other endpoint.
  {
    let r = relay(); let host = r.host(); host.failPost = true; r.start(host); assert.equal(host.closed, true);
    r = relay(); host = r.host(); r.start(host); let reader = r.reader();
    host.failPost = true; reader.onMessage.emit({ type: 'batch', videoId: VIDEO, run: RUN });
    assert.equal(reader.closed, true); assert.equal(host.closed, true);
    r = relay(); host = r.host(); r.start(host); reader = r.reader();
    host.failPost = true; reader.disconnect(); assert.equal(host.closed, true);
    for (const hostFails of [false, true]) {
      r = relay(); host = r.host(); r.start(host); host.failPost = hostFails;
      reader = port('fcm-youtube-reader', readerSender()); reader.failPost = true; r.add(reader);
      assert.equal(reader.closed, true);
      if (hostFails) assert.equal(host.closed, true);
      else assert.equal(host.sent.at(-1).type, 'reader-disconnected');
    }
  }
  // Hidden frame starts only after host acknowledgement; batches and cleanup are scoped.
  {
    const s = source(true);
    assert.equal(await s.control.start(VIDEO), true);
    assert.equal(s.frames.length, 0);
    const p = s.activePort();
    p.onMessage.emit(null);
    s.message('host-ready', { videoId: 'ZYXWVUTSRQP' }); s.message('host-ready', { run: RUN });
    assert.equal(s.frames.length, 0);
    s.message('host-ready'); s.message('host-ready');
    assert.equal(s.frames.length, 2);
    const frame = s.frames[0]; const url = new URL(frame.src);
    assert.equal(url.searchParams.get('embed_domain'), 'www.twitch.tv');
    assert.equal(url.searchParams.get('v'), VIDEO);
    assert.equal(url.hash, '#fcm-youtube=' + p.sent[0].run);
    assert.equal(new URL(s.frames[1].src).hash, url.hash + '&role=sender');
    assert.equal(frame.referrerPolicy, 'origin'); assert.equal(frame.style.cssText, 'display: none !important;');
    s.message('unknown'); s.message('batch', { invalid: true }); assert.equal(s.batches.length, 0);
    s.message('batch', { ready: false }); assert.equal(s.batches.length, 1);
    assert.equal(s.statuses.at(-1).state, 'connecting');
    s.message('batch', { ready: true }); assert.equal(s.statuses.at(-1).state, 'connected');
    assert.equal(s.time.timers.size, 1);
    s.control.stop(); assert.equal(frame.removed, true); assert.equal(p.closed, true); assert.equal(s.time.timers.size, 0);
    assert.equal(s.frames[1].removed, true, 'stop removes both role-bound frames');
    s.message('batch', { ready: true }, p); assert.equal(s.batches.length, 2);
    p.onDisconnect.emit();
    s.control.destroy(); assert.equal(await s.control.start(VIDEO), false);
  }
  // Permission denial, invalid inputs and cancellation of pending awaits make no frame.
  {
    const s = source();
    assert.equal(await s.control.start('bad'), false); assert.equal(s.statuses.at(-1).state, 'error');
    for (const value of [null, { granted: false }, { granted: 'yes' }]) {
      s.chrome.runtime.sendMessage = async () => value;
      assert.equal(await s.control.start(VIDEO), false); assert.equal(s.statuses.at(-1).state, 'permission');
    }
    s.chrome.runtime.sendMessage = async () => { throw Error('closed'); };
    assert.equal(await s.control.start(VIDEO), false); assert.equal(s.statuses.at(-1).state, 'error');
    s.chrome.runtime.sendMessage = async () => ({ granted: true, error: 'reader-registration' });
    assert.equal(await s.control.start(VIDEO), false); assert.equal(s.statuses.at(-1).state, 'error');
    let resolve, reject;
    s.chrome.runtime.sendMessage = () => new Promise((yes, no) => { resolve = yes; reject = no; });
    const pending = s.control.start(VIDEO); s.control.stop(); resolve({ granted: true });
    assert.equal(await pending, false); assert.equal(s.statuses.at(-1).state, 'stopped');
    const pending2 = s.control.start(VIDEO); s.control.destroy(); reject(Error('late'));
    assert.equal(await pending2, false); assert.equal(s.statuses.at(-1).state, 'stopped');
    assert.equal(s.frames.length, 0); assert.equal(s.chrome.runtime.ports.length, 0);
  }
  // Channel lookup happens only after permission and never creates a frame
  // until it has a strictly validated video ID and host acknowledgement.
  {
    const s = source(), requests = [];
    s.chrome.runtime.sendMessage = async message => {
      requests.push(JSON.parse(JSON.stringify(message)));
      return message.cmd === 'youtubePermission' ? { granted: true } : { videoId: VIDEO };
    };
    assert.equal(await s.control.start(CHANNEL), true);
    assert.deepEqual(requests, [{ cmd: 'youtubePermission' }, { cmd: 'youtubeResolve', channelUrl: CHANNEL }]);
    assert.ok(s.statuses.some(value => /Finding.*live/.test(value.text)));
    assert.equal(s.activePort().sent[0].videoId, VIDEO);
    assert.equal(s.frames.length, 0);
    s.message('host-ready'); assert.equal(new URL(s.frames[0].src).searchParams.get('v'), VIDEO);
    s.control.stop(); requests.length = 0;
    assert.equal(await s.control.start(VIDEO), true);
    assert.deepEqual(requests, [{ cmd: 'youtubePermission' }], 'direct videos do not invoke channel lookup');
    s.control.destroy();
    const denied = source();
    denied.chrome.runtime.sendMessage = async message => {
      assert.equal(message.cmd, 'youtubePermission'); return { granted: false };
    };
    assert.equal(await denied.control.start(CHANNEL), false);
    assert.equal(denied.chrome.runtime.ports.length, 0);
  }
  // Lookup failures use fixed explanations without copying service/page text.
  for (const [result, expected] of [
    [{ error: 'not-live' }, /No current live/], [{ error: 'ambiguous' }, /More than one/],
    [{ error: 'unavailable' }, /could not be checked/], [{ error: 'busy' }, /already in progress/],
    [{ error: 'permission' }, /Allow YouTube access/], [{ error: '<unsafe>' }, /could not be checked/],
    [null, /could not be checked/], [{}, /could not be checked/],
    [{ videoId: 123 }, /could not be checked/], [{ videoId: 'short' }, /could not be checked/],
    [{ videoId: `https://youtu.be/${VIDEO}` }, /could not be checked/],
    [{ videoId: ' ' + VIDEO }, /could not be checked/],
    [{ videoId: VIDEO, error: 'not-live' }, /No current live/],
  ]) {
    const s = source();
    s.chrome.runtime.sendMessage = async message => message.cmd === 'youtubePermission' ? { granted: true } : result;
    assert.equal(await s.control.start(CHANNEL), false);
    assert.match(s.statuses.at(-1).text, expected);
    assert.equal(s.statuses.at(-1).state, result && result.error === 'permission' ? 'permission' : 'error');
    assert.equal(s.chrome.runtime.ports.length, 0); assert.equal(s.frames.length, 0);
  }
  // Stop, destroy, and replacing the input invalidate pending channel results.
  {
    const s = source(); let resolve, reject;
    s.chrome.runtime.sendMessage = message => message.cmd === 'youtubePermission'
      ? Promise.resolve({ granted: true }) : new Promise((yes, no) => { resolve = yes; reject = no; });
    let pending = s.control.start(CHANNEL); await settle();
    s.control.stop(); resolve({ videoId: VIDEO });
    assert.equal(await pending, false); assert.equal(s.statuses.at(-1).state, 'stopped');
    pending = s.control.start(CHANNEL); await settle();
    assert.equal(await s.control.start(VIDEO), true); const replacement = s.activePort();
    resolve({ videoId: 'ZYXWVUTSRQP' }); assert.equal(await pending, false);
    assert.equal(s.activePort(), replacement); assert.equal(s.chrome.runtime.ports.length, 1);
    pending = s.control.start(CHANNEL); await settle(); reject(Error('network detail'));
    assert.equal(await pending, false); assert.match(s.statuses.at(-1).text, /could not be checked/);
    pending = s.control.start(CHANNEL); await settle(); s.control.destroy(); reject(Error('late'));
    assert.equal(await pending, false); assert.equal(s.statuses.at(-1).state, 'stopped');
    assert.equal(s.frames.length, 0);
  }
  // Timeout and worker/reader loss use three bounded retries, with fresh nonces.
  {
    const s = source(); await s.control.start(VIDEO); const first = s.activePort();
    s.message('host-ready'); s.time.fire(20000); assert.equal(s.frames[0].removed, true);
    s.time.fire(2000); await settle(); const second = s.activePort(); assert.notEqual(first.sent[0].run, second.sent[0].run);
    s.message('host-ready', {}, first); assert.equal(s.frames.length, 2, 'stale attempt ignored');
    first.onDisconnect.emit();
    s.message('host-ready'); s.message('batch', { ready: true }); s.time.fire(120000);
    s.time.fire(4000); await settle(); s.message('reader-disconnected');
    s.time.fire(8000); await settle(); s.activePort().disconnect();
    assert.equal(s.statuses.at(-1).state, 'error'); assert.equal(s.time.timers.size, 0);
    s.control.stop();
  }
  // Reentrant/new starts cannot revive an old attempt, including queued timers.
  {
    const s = source(); await s.control.start(VIDEO);
    const lateTimeout = [...s.time.timers.values()][0].fn;
    s.activePort().disconnect(); const lateRetry = [...s.time.timers.values()][0].fn;
    await s.control.start(VIDEO); lateTimeout(); lateRetry();
    assert.equal(s.chrome.runtime.ports.length, 2);
    s.control.destroy(); assert.equal(s.time.timers.size, 0);
  }
  // Missing runtime/DOM facilities fail visibly and remain recoverable/cleanable.
  {
    const s = source(); s.chrome.runtime.connect = () => { throw Error('worker missing'); };
    assert.equal(await s.control.start(VIDEO), true);
    assert.equal(s.statuses.at(-1).state, 'connecting'); s.control.stop();
    const s2 = source(); await s2.control.start(VIDEO); s2.doc.body.append = () => { throw Error('detached document'); };
    s2.message('host-ready'); assert.equal(s2.activePort().closed, true); assert.equal(s2.time.timers.size, 1);
    s2.control.stop();
    const partial = source(); await partial.control.start(VIDEO);
    const append = partial.doc.body.append;
    partial.doc.body.append = frame => { append(frame); if (partial.frames.length === 2) throw Error('second frame failed'); };
    partial.message('host-ready');
    assert.equal(partial.frames.length, 2); assert.ok(partial.frames.every(frame => frame.removed));
    assert.equal(partial.activePort().closed, true, 'second-frame insertion failure releases the complete pair');
    partial.control.stop();
    const s3 = source(); await s3.control.start(VIDEO); const p = s3.activePort();
    p.failDisconnect = true; s3.control.stop(); assert.equal(s3.time.timers.size, 0);
    const s4 = source(); const connect = s4.chrome.runtime.connect;
    s4.chrome.runtime.connect = function (options) { const result = connect.call(this, options); result.failPost = true; return result; };
    await s4.control.start(VIDEO); assert.equal(s4.activePort().closed, true); s4.control.stop();
  }

  // The production parser, reader, relay and source together, with only Chrome
  // transport and DOM stubbed. Port delivery is asynchronous, as in the browser.
  for (const useChannel of [false, true]) {
    const pairs = [], frames = [], statuses = [], batches = [], lookups = [];
    const owner = 'UC' + 'a'.repeat(22);
    const hostSender = sender({ url: 'https://kick.com/channel' });
    const hostTime = clock();
    let background;
    function context(values) {
      const sandbox = vm.createContext({ URL, Uint8Array, ...values, FCM: {} });
      sandbox.self = sandbox;
      evaluate('src/shared/youtube.js', sandbox);
      return sandbox;
    }
    function restartBackground() {
      background = { runtime: { id: 'extension', onConnect: event(), onMessage: event() },
        permissions: { contains: async () => true, onAdded: event(), onRemoved: event() }, scripting: scripting() };
      const workerContext = context({ chrome: background, TextDecoder, AbortController, setTimeout, clearTimeout,
        async fetch(url, options) {
          lookups.push(url); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
          const streams = url === CHANNEL + '/streams?hl=en';
          assert.ok(streams || url === `https://www.youtube.com/watch?v=${VIDEO}&hl=en`, 'only canonical YouTube pages are fetched');
          const data = streams ? {
            metadata: { channelMetadataRenderer: { externalId: owner } },
            contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: {
              selected: true, endpoint: { browseEndpoint: { browseId: owner }, commandMetadata: { webCommandMetadata: { url: '/@SyntheticChannel/streams' } } },
              content: { richGridRenderer: { contents: [{ richItemRenderer: { content: { videoRenderer: {
                videoId: VIDEO, thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: 'LIVE' } }],
              } } } }] } },
            } }] } },
          } : {
            playabilityStatus: { status: 'OK' }, videoDetails: { videoId: VIDEO, channelId: owner, isLiveContent: true },
            microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true } } },
          };
          const name = streams ? 'ytInitialData' : 'ytInitialPlayerResponse';
          const response = new Response('<script>var ' + name + ' = ' + JSON.stringify(data) + ';</script>',
            { headers: { 'content-type': 'text/html' } });
          Object.defineProperty(response, 'url', { value: url });
          return response;
        },
      });
      evaluate('src/background/youtube-lookup.js', workerContext);
      evaluate('src/background/youtube-relay.js', workerContext);
    }
    function runtime(forSender) {
      return {
        sendMessage(message) {
          return new Promise(resolve => background.runtime.onMessage.emit(message, forSender, resolve));
        },
        connect({ name }) {
          const content = port(name), worker = port(name, forSender);
          const owner = background;
          pairs.push({ content, worker, name });
          content.postMessage = message => {
            if (content.closed) throw Error('closed');
            queueMicrotask(() => { if (!worker.closed) worker.onMessage.emit(message); });
          };
          worker.postMessage = message => {
            if (worker.closed) throw Error('closed');
            queueMicrotask(() => { if (!content.closed) content.onMessage.emit(message); });
          };
          const close = () => {
            if (content.closed) return;
            content.closed = true; worker.closed = true;
            queueMicrotask(() => { content.onDisconnect.emit(); worker.onDisconnect.emit(); });
          };
          content.disconnect = close; worker.disconnect = close;
          queueMicrotask(() => owner.runtime.onConnect.emit(worker));
          return content;
        },
      };
    }
    const textNode = text => ({ nodeType: 1, tagName: 'SPAN', childNodes: [{ nodeType: 3, nodeValue: text }] });
    const makeRow = (id, message = 'Hello <script> 🙂') => ({
      id, message, deleted: false, tagName: 'yt-live-chat-text-message-renderer',
      getAttribute(name) { return name === 'id' ? this.id : null; },
      hasAttribute(name) { return name === 'is-deleted' && this.deleted; },
      querySelectorAll: () => [{ getAttribute: key => ({ type: 'moderator', 'aria-label': 'Moderator' })[key],
        querySelector: () => ({ getAttribute: () => 'https://yt3.ggpht.com/fixture-badge=s16' }) }],
      querySelector(selector) {
        if (selector === '#purchase-amount') return textNode('$5.00');
        if (!['#author-name', '#message'].includes(selector)) return null;
        if (selector === '#author-name' || this.id !== 'test-row-1') return textNode(selector === '#author-name' ? 'Test Author' : this.message);
        return { nodeType: 1, tagName: 'SPAN', childNodes: [textNode('Hello <script> '),
          { nodeType: 1, tagName: 'IMG', getAttribute: name => ({ alt: '🙂', class: 'emoji', src: 'https://yt3.ggpht.com/fixture=s48' })[name] || null }] };
      },
    });
    const row = makeRow('test-row-1'); row.tagName = 'yt-live-chat-paid-message-renderer';
    function loadFrame(frame) {
      const childTime = clock(), pagehide = event();
      const nativeNode = (text = '', tagName = 'DIV', parentElement = null) => ({
        textContent: text, tagName, isConnected: true, parentElement, style: {}, attributes: new Map(),
        hasAttribute(name) { return this.attributes.has(name); },
        getAttribute(name) { return this.attributes.get(name) ?? null; },
      });
      const nativeRoot = nativeNode(), nativeAuthor = nativeNode(frame.src.endsWith('&role=sender') ? '@SyntheticViewer' : '@CaptureOnlyViewer');
      const nativeInput = nativeNode(), nativeButton = nativeNode();
      const nativeChip = nativeNode('', 'YT-LIVE-CHAT-AUTHOR-CHIP', nativeRoot);
      const nativeButtonWrap = nativeNode('', 'DIV', nativeRoot);
      nativeChip.attributes.set('hidden', '');
      nativeAuthor.parentElement = nativeChip;
      nativeInput.parentElement = nativeRoot;
      nativeInput.attributes.set('contenteditable', 'true');
      nativeButton.parentElement = nativeButtonWrap;
      nativeButtonWrap.style.display = 'none';
      frame.nativeRoot = nativeRoot;
      frame.rows = [row]; frame.rowQueries = 0;
      frame.sentTexts = [];
      frame.enableNativeSend = true;
      nativeInput.dispatchEvent = () => {
        if (frame.enableNativeSend) {
          nativeButton.disabled = !nativeInput.textContent;
          nativeButtonWrap.style.display = nativeInput.textContent ? 'block' : 'none';
        }
      };
      nativeButton.disabled = true;
      nativeButton.click = () => {
        frame.provisional = makeRow('temporary_outbound', nativeInput.textContent);
        frame.rows.push(frame.provisional);
        frame.sentTexts.push(nativeInput.textContent); nativeInput.textContent = '';
        nativeButton.disabled = true; nativeButtonWrap.style.display = 'none';
      };
      nativeRoot.querySelector = selector => ({ '#author-name': nativeAuthor,
        'yt-live-chat-text-input-field-renderer div#input[contenteditable]': nativeInput,
        '#send-button button': nativeButton })[selector] || null;
      const childWindow = { top: {}, addEventListener: (_, fn) => pagehide.addListener(fn),
        removeEventListener: (_, fn) => pagehide.removeListener(fn) };
      let mutation;
      const childContext = context({
        window: childWindow, location: { href: frame.src }, chrome: { runtime: runtime(readerSender({ url: frame.src, frameId: frames.length + 2 })) },
        document: { documentElement: {}, querySelector: selector => selector === 'yt-live-chat-message-input-renderer' ? nativeRoot : {},
          querySelectorAll: () => { frame.rowQueries++; return frame.rows; },
          defaultView: { getComputedStyle(node) {
            let visibility = 'visible';
            for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
              if (ancestor.style.visibility) { visibility = ancestor.style.visibility; break; }
            }
            // Display is not inherited; the sender walks ancestors itself.
            return { display: node.style.display || (node.hasAttribute('hidden') ? 'none' : 'block'), visibility };
          } },
        },
        InputEvent: class { constructor(type, values) { this.type = type; Object.assign(this, values); } },
        MutationObserver: class {
          constructor(fn) { mutation = fn; }
          observe() {}
          disconnect() { frame.observerStopped = true; }
        },
        setTimeout: childTime.setTimeout, clearTimeout: childTime.clearTimeout,
        setInterval: childTime.setTimeout, clearInterval: childTime.clearTimeout,
      });
      frame.time = childTime; frame.pagehide = pagehide; frame.mutate = () => mutation();
      evaluate('src/content/youtube-send.js', childContext);
      evaluate('src/content/youtube-reader.js', childContext);
    }
    const ownerDocument = {
      location: { hostname: 'kick.com' },
      createElement: () => ({ style: {}, remove() { this.removed = true; this.pagehide.emit(); } }),
      body: { append(frame) { frames.push(frame); loadFrame(frame); } },
    };
    restartBackground();
    let nonce = 0;
    const hostContext = context({
      document: ownerDocument, chrome: { runtime: runtime(hostSender) },
      crypto: { getRandomValues: values => values.fill(++nonce) },
      setTimeout: hostTime.setTimeout, clearTimeout: hostTime.clearTimeout,
    });
    evaluate('src/content/youtube-source.js', hostContext);
    const control = hostContext.FCM.createYouTubeSource({ onBatch: batch => batches.push(batch), onStatus: status => statuses.push(status) });
    const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    assert.equal(await control.start(useChannel ? CHANNEL : `https://www.youtube.com/watch?v=${VIDEO}`), true);
    assert.equal(lookups.length, useChannel ? 2 : 0);
    await drain();
    assert.equal(frames.length, 2); assert.equal(new URL(frames[0].src).searchParams.get('embed_domain'), 'kick.com');
    assert.equal(statuses.at(-1).state, 'connected');
    assert.equal(batches.length, 1); assert.equal(batches[0].messages.length, 1);
    const message = batches[0].messages[0];
    assert.equal(message.id, `youtube:${VIDEO}:test-row-1`); assert.equal(message.displayName, 'Test Author');
    assert.equal(message.text, 'Hello <script> 🙂'); assert.equal(message.readOnly, true); assert.equal(message.platform, 'youtube');
    assert.deepEqual(JSON.parse(JSON.stringify(message.youtubeEmotes)), [{ start: 15, end: 17, url: 'https://yt3.ggpht.com/fixture=s48' }],
      'image metadata survives reader, background relay and host sanitization');
    assert.equal(message.youtubeEvent.amount, '$5.00');
    assert.deepEqual(JSON.parse(JSON.stringify(message.youtubeBadges)), [{ type: 'moderator', label: 'Moderator',
      url: 'https://yt3.ggpht.com/fixture-badge=s16' }], 'badge images survive transport without granting actions');
    assert.equal(control.getSendState().available, true);
    assert.equal(control.getSendState().accountLabel, '@SyntheticViewer', 'selection identity comes exclusively from the actual sender frame');
    assert.equal(frames[0].style.cssText, 'display: none !important;', 'the host frame stays hidden while its own composer can be ready');
    frames[1].nativeRoot.style.display = 'none';
    frames[1].mutate(); frames[1].time.fire(100); await drain();
    assert.equal(control.getSendState().reason, 'restricted', 'a CSS-hidden native composer cannot be sent through');
    assert.equal((await control.send('Blocked by native CSS')).outcome, 'not-sent');
    assert.deepEqual(frames[1].sentTexts, []);
    frames[1].nativeRoot.style.display = 'block';
    frames[1].mutate(); frames[1].time.fire(100); await drain();
    assert.equal(control.getSendState().available, true, 'the hidden account chip and idle Send wrapper do not block the usable native editor');
    const initialSourceId = control.getSendState().sourceId;
    const sending = control.send('One isolated synthetic send'); await drain();
    assert.equal((await sending).outcome, 'submitted');
    assert.deepEqual(frames[1].sentTexts, ['One isolated synthetic send']);
    assert.deepEqual(frames[0].sentTexts, [], 'capture frame never performs native sends');
    const beforeEcho = batches.length;
    frames[1].mutate(); frames[1].time.fire(100); await drain();
    frames[1].provisional.id = 'confirmed_outbound';
    frames[1].mutate(); frames[1].time.fire(100); await drain();
    assert.equal(frames[1].rowQueries, 0, 'sender reader never queries provisional or confirmed native rows');
    assert.equal(batches.length, beforeEcho, 'temporary-to-server row identity changes in sender DOM emit no capture');
    frames[0].rows.push(makeRow('confirmed_outbound', 'One isolated synthetic send'),
      makeRow('legitimate_repeat', 'One isolated synthetic send'));
    frames[0].mutate(); frames[0].time.fire(100); await drain();
    assert.deepEqual(Array.from(batches.at(-1).messages, value => value.id),
      [`youtube:${VIDEO}:confirmed_outbound`, `youtube:${VIDEO}:legitimate_repeat`],
      'confirmed messages with identical content and distinct IDs both reach the feed');
    assert.equal(control.getSendState().sourceId, initialSourceId);
    assert.equal(control.getSendState().available, true, 'native busy/completion messages restore the same ready account');
    row.deleted = true; frames[0].mutate(); frames[0].time.fire(100); await drain();
    assert.equal(batches.at(-1).deleted[0], message.id);
    assert.equal(batches.at(-1).messages.length, 0);
    const staleReader = pairs.find(pair => pair.name === 'fcm-youtube-reader');
    for (const pair of pairs) pair.worker.disconnect();
    restartBackground(); await drain();
    assert.equal(statuses.at(-1).state, 'connecting'); assert.equal(frames[0].removed, true);
    hostTime.fire(2000); await drain();
    assert.equal(frames.length, 4); assert.equal(statuses.at(-1).state, 'connected');
    assert.notEqual(control.getSendState().sourceId, initialSourceId);
    assert.deepEqual(frames[3].sentTexts, [], 'worker reconnect never repeats the native send');
    assert.notEqual(new URL(frames[0].src).hash, new URL(frames[2].src).hash);
    const delivered = batches.length;
    staleReader.worker.onMessage.emit({ type: 'batch', videoId: VIDEO, run: new URL(frames[0].src).hash.slice(13), messages: [message], deleted: [], ready: true });
    await drain(); assert.equal(batches.length, delivered, 'old worker/frame cannot send after restart');
    frames[3].enableNativeSend = false;
    const cancelledSend = control.send('Cancel before native activation'); await drain();
    assert.equal(control.getSendState().reason, 'busy');
    background.permissions.contains = async () => false;
    background.permissions.onRemoved.emit({ origins: ['https://www.youtube.com/*'] }); await drain();
    assert.equal((await cancelledSend).outcome, 'uncertain', 'a handed-off send is never falsely labelled safe to retry');
    assert.deepEqual(frames[3].sentTexts, [], 'revocation destroys pending native preparation before the button can be activated');
    assert.equal(frames[3].time.timers.size, 0);
    hostTime.fire(4000); await drain();
    assert.equal(frames.length, 4, 'permission is checked before rebuilding a disconnected reader');
    assert.equal(statuses.at(-1).state, 'permission');
    control.destroy(); await drain();
    assert.equal(hostTime.timers.size, 0);
    for (const frame of frames) {
      assert.equal(frame.removed, true); assert.equal(frame.observerStopped, true); assert.equal(frame.time.timers.size, 0);
    }
    for (const pair of pairs) assert.equal(pair.content.closed, true);
    assert.equal(lookups.length, useChannel ? 2 : 0, 'reconnect does not poll or repeat channel lookup');
  }
}

module.exports = { run, relay, source, port, sender, readerSender, settle, VIDEO, RUN, RUN2 };
if (require.main === module) run().then(() => console.log('YouTube transport tests passed'), error => { console.error(error); process.exitCode = 1; });
