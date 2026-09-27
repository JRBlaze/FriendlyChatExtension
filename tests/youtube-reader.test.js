const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const VIDEO = 'AbCdEfGhI_1';
const OTHER = 'bBcDeFgHi-2';
const RUN = '1234567890abcdef1234567890abcdef';
const URL_TEXT = `https://www.youtube.com/live_chat?v=${VIDEO}&embed_domain=www.twitch.tv#fcm-youtube=${RUN}`;
const copy = value => JSON.parse(JSON.stringify(value));

function load(context, file) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: path.join(ROOT, file) });
}

function shared() {
  const context = vm.createContext({ URL, FCM: {} });
  context.self = context;
  load(context, 'src/shared/youtube.js');
  return context.FCM.youtube;
}

function element(tagName, childNodes = [], attributes = {}) {
  return { nodeType: 1, tagName, childNodes, getAttribute: key => attributes[key] ?? null };
}
const text = value => ({ nodeType: 3, nodeValue: value });
function row(id, options = {}) {
  const attributes = { id };
  const result = element('YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER', [], attributes);
  result.attributes = attributes;
  result.deleted = !!options.deleted;
  result.author = options.author === undefined ? element('SPAN', [text('Viewer')]) : options.author;
  result.body = options.body === undefined ? element('SPAN', [text('A synthetic chat message')]) : options.body;
  result.hasAttribute = key => key === 'is-deleted' && result.deleted;
  result.querySelector = selector => selector === '#author-name' ? result.author : result.body;
  return result;
}

function event() {
  const listeners = new Set(), all = [];
  return { listeners, all, addListener(fn) { listeners.add(fn); all.push(fn); },
    removeListener(fn) { listeners.delete(fn); }, fire(value) { for (const fn of [...listeners]) fn(value); } };
}

function reader(options = {}) {
  const state = { rows: options.rows || [], ready: options.ready ?? true, posts: [], connects: 0,
    disconnects: 0, observers: [], timers: new Map(), pageEvents: new Map(), failPost: false, failDisconnect: false,
    captureQueries: 0 };
  let serial = 0;
  function timer(fn, delay, kind) { const id = ++serial; state.timers.set(id, { fn, delay, kind }); return id; }
  const port = { onMessage: event(), onDisconnect: event(), postMessage(message) {
    if (state.failPost) throw Error('Relay gone');
    state.posts.push(copy(message));
  }, disconnect() { state.disconnects++; if (state.failDisconnect) throw Error('Context gone'); } };
  const window = {
    addEventListener(type, fn) { state.pageEvents.set(type, fn); },
    removeEventListener(type, fn) { if (state.pageEvents.get(type) === fn) state.pageEvents.delete(type); },
  };
  window.top = options.topLevel ? window : {};
  const context = vm.createContext({ URL, FCM: {}, window, location: { href: options.url || URL_TEXT + (options.sending ? '&role=sender' : '') },
    Date: class extends Date { static now() { return 1700000000000; } },
    chrome: { runtime: { connect(argument) {
      state.connects++; assert.equal(argument.name, 'fcm-youtube-reader');
      if (options.failConnect) throw Error('No extension'); return port;
    } } },
    document: { documentElement: {}, querySelector(selector) {
      state.captureQueries++;
      assert.equal(selector, 'yt-live-chat-item-list-renderer'); return state.ready ? {} : null;
    }, querySelectorAll(selector) {
      state.captureQueries++;
      assert.equal(selector, context.FCM.youtube.ROW_SELECTOR); return state.rows;
    } },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.disconnected = false; state.observers.push(this); }
      observe(target, config) { this.target = target; this.config = copy(config); }
      disconnect() { this.disconnected = true; }
    },
    setTimeout: (fn, delay) => timer(fn, delay, 'timeout'),
    clearTimeout: id => state.timers.delete(id),
    setInterval: (fn, delay) => timer(fn, delay, 'interval'),
    clearInterval: id => state.timers.delete(id),
  });
  context.self = context;
  load(context, 'src/shared/youtube.js');
  load(context, 'src/content/youtube-reader.js');
  state.context = context;
  state.port = port;
  state.ack = () => port.onMessage.fire({ type: 'reader-ready', run: RUN, videoId: VIDEO });
  state.tick = (delay, kind = 'timeout') => {
    const match = [...state.timers].find(([, value]) => value.delay === delay && value.kind === kind);
    assert.ok(match, `Missing ${kind} timer ${delay}`);
    if (kind === 'timeout') state.timers.delete(match[0]);
    match[1].fn();
  };
  state.change = () => { for (const observer of state.observers) if (!observer.disconnected) observer.fn(); };
  return state;
}

function validBatch(api) {
  return { type: 'batch', run: RUN, videoId: VIDEO, ready: true,
    messages: [copy(api.parseRow(row('message_1'), VIDEO, 123))], deleted: [`youtube:${VIDEO}:removed_1`] };
}

async function run() {
  const api = shared();
  assert.equal(api.videoId(`  ${VIDEO}  `), VIDEO, 'IDs retain case');
  for (const url of [`https://www.youtube.com/watch?v=${VIDEO}&feature=share`,
    `https://youtube.com/live/${VIDEO}`, `https://m.youtube.com/watch?v=${VIDEO}`,
    `https://www.youtube.com/live_chat?v=${VIDEO}`, `https://youtu.be/${VIDEO}?si=share`]) {
    assert.equal(api.videoId(url), VIDEO);
  }
  for (const input of [undefined, null, 42, {}, 'x'.repeat(2049), 'not a url',
    `http://youtube.com/watch?v=${VIDEO}`, `https://name@youtube.com/watch?v=${VIDEO}`,
    `https://:pass@youtube.com/watch?v=${VIDEO}`, `https://youtube.com:8080/watch?v=${VIDEO}`,
    `https://youtube.com.evil.test/watch?v=${VIDEO}`, 'https://youtube.com/@channel/live',
    'https://youtube.com/watch', 'https://youtu.be/', `https://youtu.be/${VIDEO}/extra`,
    `https://youtube.com/live/${VIDEO}/extra`, 'https://youtube.com/shorts/invalid']) {
    assert.throws(() => api.videoId(input));
  }

  for (const input of [VIDEO, `https://www.youtube.com/watch?v=${VIDEO}`, `https://youtu.be/${VIDEO}`]) {
    assert.deepEqual(copy(api.parseInput(input)), { videoId: VIDEO });
  }
  const channelId = 'UC' + 'AbCdEfGhIjKlMnOpQrStUv';
  for (const [input, channelUrl] of [
    [' https://www.youtube.com/@Agent00 ', 'https://www.youtube.com/@Agent00'],
    ['https://youtube.com/@Agent00/live?feature=share#chat', 'https://www.youtube.com/@Agent00'],
    ['https://m.youtube.com/@Agent00/streams/', 'https://www.youtube.com/@Agent00'],
    [`https://youtube.com/channel/${channelId}/videos`, `https://www.youtube.com/channel/${channelId}`],
    ['https://youtube.com/c/Example.Name/featured', 'https://www.youtube.com/c/Example.Name'],
    ['https://youtube.com/user/Example_Name/', 'https://www.youtube.com/user/Example_Name'],
    ['https://youtube.com/@日本語/live', 'https://www.youtube.com/@%E6%97%A5%E6%9C%AC%E8%AA%9E'],
    ['https://youtube.com/%40Agent00/', 'https://www.youtube.com/@Agent00'],
  ]) assert.deepEqual(copy(api.parseInput(input)), { channelUrl }, input);
  for (const input of [null, 42, {}, 'x'.repeat(2049), 'not a url', '@Agent00',
    'http://youtube.com/@Agent00', 'https://name@youtube.com/@Agent00', 'https://:pass@youtube.com/@Agent00',
    'https://youtube.com:444/@Agent00', 'https://youtube.com.evil.test/@Agent00', 'https://youtu.be/@Agent00',
    'https://youtube.com/', 'https://youtube.com/@', 'https://youtube.com/@Agent00/about',
    'https://youtube.com/@Agent00/live/extra', 'https://youtube.com/@Agent00//live',
    'https://youtube.com/@A%2FB', 'https://youtube.com/@A%5CB', 'https://youtube.com/@A%20B',
    'https://youtube.com/@%ZZ', 'https://youtube.com/@A%00B', 'https://youtube.com/channel/short',
    'https://youtube.com/channel/XX' + 'a'.repeat(22), 'https://youtube.com/c/',
    'https://youtube.com/unknown/Example', 'https://youtube.com/user/name/extra',
    'https://youtube.com/@' + 'a'.repeat(101), 'https://youtube.com/watch?v=invalid']) {
    assert.throws(() => api.parseInput(input), /YouTube live video or channel URL/, String(input));
  }

  const body = element('SPAN', [text('  Hello\u0000 '), element('IMG', [], { alt: '😀', src: 'https://untrusted.test/image' }),
    element('BR'), element('A', [text('<script>literal</script>')], { href: 'javascript:bad()' }),
    element('IMG'), element('SCRIPT', [text('do not copy')]), element('STYLE', [text('do not copy')]),
    element('TEMPLATE', [text('do not copy')]), { nodeType: 8, nodeValue: 'comment' }, text('  ')]);
  const parsed = copy(api.parseRow(row('abc+=/_-', { body }), VIDEO, 123));
  assert.deepEqual(parsed, { platform: 'youtube', id: `youtube:${VIDEO}:abc+=/_-`, username: 'Viewer', displayName: 'Viewer',
    text: 'Hello 😀\n<script>literal</script>', ts: 123, badges: [], readOnly: true });
  assert.notEqual(api.parseRow(row('same'), VIDEO, 123).id, api.parseRow(row('same'), OTHER, 123).id,
    'message IDs cannot collide between videos');
  for (const id of [null, '', 'has spaces', 'x'.repeat(201), '<html>', 'id:colon']) assert.equal(api.rowId(row(id), VIDEO), '');
  assert.equal(api.parseRow(row(null), VIDEO, 1), null);
  assert.equal(api.parseRow(row('deleted', { deleted: true }), VIDEO, 1), null);
  assert.equal(api.parseRow(row('no-author', { author: null }), VIDEO, 1), null);
  assert.equal(api.parseRow(row('no-text', { body: null }), VIDEO, 1), null);
  assert.equal(api.parseRow(row('whitespace', { body: element('SPAN', [text(' \n ')]) }), VIDEO, 1), null);
  const bounded = api.parseRow(row('long', { author: element('SPAN', [text('n'.repeat(200))]),
    body: element('SPAN', [text('a'.repeat(1999) + ' ' + 'b'.repeat(5000))]) }), VIDEO, 1);
  assert.equal(bounded.displayName.length, 100);
  assert.equal(bounded.text.length, 1999, 'truncation does not leave invalid trailing whitespace');
  const emojiBound = api.parseRow(row('emoji-bound', { body: element('SPAN', [element('IMG', [], { alt: 'x'.repeat(3000) })]) }), VIDEO, 1);
  assert.equal(emojiBound.text.length, 2000);
  let deep = element('SPAN', [text('too deep')]);
  for (let i = 0; i < 1200; i++) deep = element('SPAN', [deep]);
  assert.equal(api.parseRow(row('deep', { body: deep }), VIDEO, 1), null, 'deep markup is bounded without recursion');
  const broad = api.parseRow(row('broad', { body: element('SPAN', Array.from({ length: 2000 }, () => text('x'))) }), VIDEO, 1);
  assert.equal(broad.text.length, 999, 'node work is capped independently of characters');

  const batch = validBatch(api);
  batch.messages[0].platform = 'twitch'; batch.messages[0].readOnly = false;
  batch.messages[0].html = '<img onerror=bad()>'; batch.messages[0].badges = ['moderator'];
  const safe = copy(api.sanitizeBatch(batch, VIDEO, RUN));
  assert.equal(safe.messages[0].platform, 'youtube');
  assert.equal(safe.messages[0].readOnly, true);
  assert.deepEqual(safe.messages[0].badges, []);
  assert.equal('html' in safe.messages[0], false);
  const empty = { type: 'batch', run: RUN, videoId: VIDEO, ready: false, messages: [], deleted: [] };
  assert.deepEqual(copy(api.sanitizeBatch(empty, VIDEO, RUN)), empty);
  const mutations = [b => null, b => ({ ...b, type: 'send' }), b => ({ ...b, videoId: OTHER }),
    b => ({ ...b, run: 'f'.repeat(32) }), b => ({ ...b, ready: 'yes' }),
    b => ({ ...b, messages: null }), b => ({ ...b, messages: Array(101).fill(b.messages[0]) }),
    b => ({ ...b, deleted: null }), b => ({ ...b, deleted: Array(101).fill(b.deleted[0]) }),
    b => ({ ...b, messages: [null] }), b => ({ ...b, deleted: [123] }),
    b => ({ ...b, deleted: [`youtube:${OTHER}:id`] }), b => ({ ...b, deleted: [`youtube:${VIDEO}:bad id`] })];
  for (const mutate of mutations) assert.equal(api.sanitizeBatch(mutate(validBatch(api)), VIDEO, RUN), null);
  assert.equal(api.sanitizeBatch(validBatch(api), 'invalid', RUN), null);
  assert.equal(api.sanitizeBatch(validBatch(api), VIDEO, 'invalid'), null);
  for (const [key, values] of Object.entries({ id: [null, 'not-namespaced', `youtube:${OTHER}:id`, `youtube:${VIDEO}:bad id`],
    username: [null, '', 'x'.repeat(101), ' name', '\u0000name'], displayName: [null, 'x'.repeat(101)],
    text: [null, '', 'x'.repeat(2001), 'a\u0000b'], ts: [null, '123', 1.5, Infinity, -1] })) {
    for (const value of values) { const candidate = validBatch(api); candidate.messages[0][key] = value;
      assert.equal(api.sanitizeBatch(candidate, VIDEO, RUN), null, `invalid ${key}`); }
  }
  const atLimit = validBatch(api); atLimit.messages = Array.from({ length: 100 }, () => atLimit.messages[0]);
  atLimit.deleted = Array(100).fill(atLimit.deleted[0]);
  assert.ok(api.sanitizeBatch(atLimit, VIDEO, RUN));

  // No capture on ordinary YouTube tabs, replay pages, unmarked frames, or malformed markers.
  assert.equal(reader({ topLevel: true }).connects, 0);
  for (const url of [URL_TEXT.replace('https:', 'http:'), URL_TEXT.replace('www.youtube.com', 'evil.test'),
    URL_TEXT.replace('/live_chat?', '/live_chat_replay?'), URL_TEXT.replace(`#fcm-youtube=${RUN}`, ''),
    URL_TEXT.replace(RUN, RUN.toUpperCase()), URL_TEXT + '&extra=1', URL_TEXT + '&role=capture',
    URL_TEXT + '&role=sender&role=sender', URL_TEXT + '&role=Sender', URL_TEXT.replace(`v=${VIDEO}&`, ''),
    URL_TEXT.replace(`v=${VIDEO}`, `v=${VIDEO}&v=${OTHER}`), URL_TEXT.replace(VIDEO, 'invalid'),
    URL_TEXT.replace(VIDEO, encodeURIComponent(`https://youtu.be/${VIDEO}`))]) {
    assert.equal(reader({ url }).connects, 0, url);
  }
  assert.equal(reader({ failConnect: true }).timers.size, 0);
  const timedOut = reader(); timedOut.tick(10000);
  assert.equal(timedOut.disconnects, 1); assert.equal(timedOut.timers.size, 0);
  assert.equal(timedOut.pageEvents.size, 0);
  timedOut.port.onMessage.all[0]({ type: 'reader-ready', run: RUN, videoId: VIDEO });
  assert.equal(timedOut.observers.length, 0, 'late acknowledgement cannot revive a stopped reader');
  assert.equal(timedOut.timers.size, 0);
  const earlyDisconnect = reader(); earlyDisconnect.port.onDisconnect.fire();
  assert.equal(earlyDisconnect.disconnects, 0); assert.equal(earlyDisconnect.timers.size, 0);

  const captureOnly = reader({ rows: [row('repeated_1'), row('repeated_2')] });
  captureOnly.context.FCM.createYouTubeSender = () => { throw Error('Capture must never construct a sender'); };
  captureOnly.ack();
  captureOnly.port.onMessage.fire({ cmd: 'send', videoId: VIDEO, run: RUN, sequence: 1, capability: 1, text: 'Ignored' });
  assert.equal(captureOnly.posts.flatMap(batch => batch.messages).length, 2,
    'identical message content with different server IDs remains two legitimate messages');
  const recycled = captureOnly.rows[0]; recycled.attributes.id = 'reused_node_new_message';
  captureOnly.tick(5000, 'interval');
  assert.equal(captureOnly.posts.at(-1).messages[0].id, `youtube:${VIDEO}:reused_node_new_message`,
    'recycled native nodes do not cause message suppression');
  captureOnly.port.onDisconnect.fire();

  const provisional = row('temporary_outbound');
  const senderOnly = reader({ sending: true, rows: [provisional] });
  let refreshes = 0, destroys = 0;
  senderOnly.context.FCM.createYouTubeSender = options => {
    options.onState({ available: true });
    return { refresh() { refreshes++; }, send() {}, destroy() { destroys++; } };
  };
  senderOnly.ack(); provisional.attributes.id = 'confirmed_outbound'; senderOnly.change(); senderOnly.tick(100);
  senderOnly.tick(5000, 'interval');
  assert.equal(refreshes, 3); assert.equal(senderOnly.captureQueries, 0, 'sender never inspects row DOM');
  assert.deepEqual(senderOnly.posts.map(message => message.type), ['send-state'],
    'provisional and confirmed sender DOM rows cannot escape as capture batches');
  senderOnly.port.onDisconnect.fire(); assert.equal(destroys, 1);
  const unavailableSender = reader({ sending: true }); unavailableSender.ack();
  assert.equal(unavailableSender.captureQueries, 0, 'missing native sender never falls back to capture');
  unavailableSender.port.onDisconnect.fire();

  const first = row('first'), later = row('later', { body: null });
  const live = reader({ rows: [first, row(null), later], ready: false });
  assert.equal(live.posts.length, 0, 'reader waits for relay acknowledgement');
  for (const message of [null, {}, { type: 'other' }, { type: 'reader-ready', videoId: OTHER, run: RUN },
    { type: 'reader-ready', videoId: VIDEO, run: '0'.repeat(32) }]) live.port.onMessage.fire(message);
  assert.equal(live.posts.length, 0);
  live.ack();
  assert.equal(live.posts.length, 1); assert.equal(live.posts[0].ready, false);
  assert.deepEqual(live.posts[0].messages.map(message => message.id), [`youtube:${VIDEO}:first`]);
  assert.equal(live.observers[0].config.characterData, true);
  assert.deepEqual(live.observers[0].config.attributeFilter, ['is-deleted']);
  live.ack(); assert.equal(live.observers.length, 1, 'duplicate acknowledgement cannot create another observer');
  live.ready = true;
  later.body = element('SPAN', [text('filled after initial insertion')]);
  live.change(); live.change();
  assert.equal([...live.timers.values()].filter(timer => timer.delay === 100).length, 1, 'mutations coalesce');
  live.tick(100);
  assert.equal(live.posts.at(-1).ready, true);
  assert.equal(live.posts.at(-1).messages[0].text, 'filled after initial insertion');
  live.rows = [row('first'), later]; live.tick(5000, 'interval');
  assert.equal(live.posts.at(-1).messages.length, 0, 'recreated rows dedupe by message ID, not DOM node identity');
  live.rows = [later]; live.tick(5000, 'interval');
  assert.deepEqual(live.posts.at(-1).deleted, [], 'history virtualization is not a deletion');
  later.deleted = true; live.change(); live.tick(100);
  assert.deepEqual(live.posts.at(-1).deleted, [`youtube:${VIDEO}:later`]);
  live.tick(5000, 'interval'); assert.deepEqual(live.posts.at(-1).deleted, [], 'deletion dedupes');
  later.deleted = false; live.tick(5000, 'interval');
  assert.equal(live.posts.at(-1).messages.length, 0, 'deleted IDs are not resurrected');
  const heartbeatCallback = [...live.timers.values()].find(timer => timer.kind === 'interval').fn;
  const mutationCallback = live.observers[0].fn;
  const stopCallback = live.pageEvents.get('pagehide');
  live.change(); stopCallback(); stopCallback(); heartbeatCallback(); mutationCallback();
  assert.equal(live.disconnects, 1); assert.equal(live.timers.size, 0);
  assert.equal(live.observers[0].disconnected, true);
  assert.equal(live.port.onMessage.listeners.size, 0);
  assert.equal(live.port.onDisconnect.listeners.size, 0);

  const navigated = reader(); navigated.ack(); navigated.context.location.href = URL_TEXT.replace(VIDEO, OTHER);
  navigated.tick(5000, 'interval'); assert.equal(navigated.disconnects, 1);
  const failed = reader({ rows: Array.from({ length: 101 }, (_, i) => row('fail_' + i)) });
  failed.failPost = true; failed.failDisconnect = true; failed.ack();
  assert.equal(failed.disconnects, 1); assert.equal(failed.timers.size, 0); assert.equal(failed.posts.length, 0);
  const emptyFailure = reader(); emptyFailure.failPost = true; emptyFailure.ack();
  assert.equal(emptyFailure.disconnects, 1);

  const busy = reader({ rows: Array.from({ length: 1005 }, (_, i) => row('busy_' + i)) }); busy.ack();
  assert.equal(busy.posts.flatMap(batch => batch.messages).length, 1000);
  assert.equal(busy.posts[0].messages[0].id, `youtube:${VIDEO}:busy_5`);
  assert.ok(busy.posts.every(batch => batch.messages.length <= 100 && batch.deleted.length <= 100));
  assert.ok(busy.posts.every(batch => api.sanitizeBatch(batch, VIDEO, RUN)), 'all emitted batches satisfy the relay contract');
  for (let round = 1; round <= 4; round++) {
    busy.rows = Array.from({ length: 1000 }, (_, i) => row(`round_${round}_${i}`, { deleted: round === 4 }));
    busy.tick(5000, 'interval');
  }
  busy.rows = [row('busy_5'), row('round_4_0')]; busy.tick(5000, 'interval');
  assert.deepEqual(busy.posts.at(-1).messages.map(message => message.id), [`youtube:${VIDEO}:busy_5`],
    '4000-ID cap evicts old entries and retains recent deletion tombstones');
  busy.port.onDisconnect.fire(); assert.equal(busy.timers.size, 0);
  console.log('YouTube parser and reader: all assertions passed.');
}

module.exports = run;
module.exports.fixture = reader;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
