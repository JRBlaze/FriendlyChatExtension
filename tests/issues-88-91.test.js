// Offline regressions for the November issue batch. No real accounts or sends.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const { fixture, element } = require('./youtube-view.test');

function nativeNotices() {
  let observe;
  const events = [], list = {};
  const context = vm.createContext({ FCM: {}, URL, document: {},
    MutationObserver: class { constructor(fn) { observe = fn; } observe() {} disconnect() {} },
  }); context.self = context;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/shared/constants.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/native-events.js'), 'utf8'), context, { filename: 'src/content/native-events.js' });
  const watcher = context.FCM.createNativeEventWatcher({ id: 'twitch', messageList: () => list }, text => events.push(text));
  watcher.start();
  const notice = (text, href, message = false) => ({ nodeType: 1, textContent: text, innerText: text,
    matches: () => true, querySelector: () => message ? {} : null,
    querySelectorAll: () => href === null ? [] : (Array.isArray(href) ? href : [href]).map(value => ({ getAttribute: () => value })),
  });
  const add = node => observe([{ addedNodes: [node] }]);
  return { events, watcher, notice, add };
}

function inputFixture(mode, text, start, end, maxLength = 480) {
  const listeners = new Map();
  const node = value => ({ nodeType: 3, nodeName: '#text', nodeValue: value });
  let range;
  const selection = { rangeCount: 1, getRangeAt: () => range,
    removeAllRanges() {}, addRange(next) { range = next; },
    getComposedRanges: () => [range] };
  const doc = { getSelection: () => selection,
    createTextNode: node, createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } }),
    createRange: () => ({ setStart(n, o) { this.startContainer = n; this.startOffset = o; },
      setEnd(n, o) { this.endContainer = n; this.endOffset = o; } }) };
  const el = { nodeType: 1, nodeName: 'DIV', childNodes: [node(text)], ownerDocument: doc,
    classList: { toggle() {} }, contains(n) { return n === this || this.childNodes.includes(n); },
    replaceChildren(fragment) { this.childNodes = fragment.children; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
  };
  const root = { nodeType: 11, contains: n => el.contains(n) };
  if (mode === 'chrome') root.getSelection = () => selection;
  el.getRootNode = () => root;
  range = { startContainer: el.childNodes[0], startOffset: start, endContainer: el.childNodes[0], endOffset: end };
  const context = vm.createContext({ document: doc, FCM: {}, Event: class { constructor(type) { this.type = type; } } });
  context.self = context;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/emote-input.js'), 'utf8'), context, { filename: 'src/content/emote-input.js' });
  context.FCM.makeEmoteInput(el, { maxLength });
  return { el, paste(text) { let prevented = false;
    listeners.get('paste')({ clipboardData: { getData: () => text }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true); }, listeners, selection };
}

async function run() {
  for (const mode of ['chrome', 'firefox']) {
    const f = inputFixture(mode, '!yw', 0, 3);
    f.paste("You're welcome!");
    assert.equal(f.el.value, "You're welcome!");
    assert.equal(f.el.selectionStart, 15);
    assert.equal(f.el.selectionEnd, 15);
    const middle = inputFixture(mode, 'before !yw after', 7, 10);
    middle.paste('hello\nfriend');
    assert.equal(middle.el.value, 'before hello friend after');
    const collapsed = inputFixture(mode, 'abcd', 2, 2, 6);
    collapsed.paste('xyz');
    assert.equal(collapsed.el.value, 'abxyzc');
    const plain = inputFixture(mode, 'abcd', 2, 2, 0);
    plain.paste('X'); assert.equal(plain.el.value, 'abXcd');
    plain.listeners.get('paste')({});
    plain.selection.rangeCount = 0;
    plain.selection.getComposedRanges = () => [];
    assert.equal(plain.el.selectionEnd, 5);
    const emote = inputFixture(mode, '', 0, 0);
    emote.el.childNodes = [{ nodeType: 3, nodeName: '#text', nodeValue: 'before ' },
      { nodeType: 1, nodeName: 'IMG', alt: 'Kappa', classList: { contains: () => true } },
      { nodeType: 3, nodeName: '#text', nodeValue: ' after' }];
    emote.selection.addRange({ startContainer: emote.el, startOffset: 1, endContainer: emote.el, endOffset: 2 });
    assert.equal(emote.el.selectionStart, 7); assert.equal(emote.el.selectionEnd, 12);
    emote.paste('replacement'); assert.equal(emote.el.value, 'before replacement after');
    plain.selection.rangeCount = 1;
    plain.selection.getRangeAt = () => ({ startContainer: {}, startOffset: 0, endContainer: {}, endOffset: 0 });
    plain.selection.getComposedRanges = () => [];
    assert.equal(plain.el.selectionEnd, 5);
  }
  const { FCM, context } = fixture();
  const panel = element(), feed = element(), input = element();
  const replies = [], toasts = [];
  FCM.createCompose({ panel, feedEl: feed, inputEl: input, hostPlatform: 'twitch',
    canModerate: () => false, toast: text => toasts.push(text), onReplyTo: (...args) => replies.push(args) });
  feed.fire('mouseover', element());
  for (const platform of ['twitch', 'kick', 'youtube', 'unknown']) {
    const row = element(), author = element(), body = element();
    row.className = 'fcm-msg'; row.dataset = { platform, msgId: 'exact-id' };
    author.className = 'fcm-author'; author.dataset = { name: 'Viewer', platform };
    body.className = 'fcm-body'; body.appendChild({ nodeType: 3, nodeValue: 'message to copy', matches: () => false });
    row.appendChild(author); row.appendChild(body); feed.appendChild(row);
    feed.fire('mouseover', row); feed.fire('mouseover', row); feed.fire('focusin', row);
    const bar = row.querySelector('.fcm-row-actions');
    if (platform === 'unknown') { assert.equal(bar, null); continue; }
    assert.equal(row.querySelectorAll('.fcm-row-actions').length, 1);
    input.value = 'draft';
    bar.children[0].fire('click');
    assert.deepEqual(replies.at(-1), [platform, 'Viewer', 'exact-id']);
    assert.equal(input.value, 'draft @Viewer ');
    await bar.children[1].fire('click'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.copied, 'message to copy');
    assert.equal(toasts.at(-1), 'Message copied');
    context.rejectCopy = true; await bar.children[1].fire('click'); await new Promise(resolve => setImmediate(resolve)); context.rejectCopy = false;
    assert.match(toasts.at(-1), /Could not copy/);
    row.classList.add('fcm-deleted'); await bar.children[1].fire('click'); await new Promise(resolve => setImmediate(resolve));
    assert.match(toasts.at(-1), /no longer available/);
    const before = replies.length; bar.children[0].fire('click'); assert.equal(replies.length, before);
  }
  const nameless = element(); nameless.className = 'fcm-msg'; nameless.dataset.platform = 'twitch';
  feed.fire('mouseover', nameless); assert.equal(nameless.querySelector('.fcm-row-actions'), null);
  const css = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
  assert.match(css, /\.fcm-row-actions\s*\{[^}]*display: none/);
  assert.match(css, /\.fcm-msg:hover \.fcm-row-actions/);
  assert.match(css, /\.fcm-msg:focus-within \.fcm-row-actions/);
  assert.match(css, /\.fcm-chatmodes\s*\{[^}]*overflow-wrap: anywhere/);
  const n = nativeNotices();
  n.add(n.notice('Give Target a shoutout!', '/target'));
  assert.deepEqual(n.events, ['Give Target a shoutout! https://www.twitch.tv/target']);
  n.add(n.notice('Give Target a shoutout!', '/target')); assert.equal(n.events.length, 1);
  for (const [text, href, message] of [
    ['normal notice', '/target'], ['shoutout', null], ['shoutout', 'javascript:bad'],
    ['shoutout', 'https://evil.test/target'], ['shoutout', '/settings/profile'],
    ['shoutout', 'https://['], ['shoutout', '/directory'], ['', null],
    ['shoutout', '/target', true], ['shoutout' + 'x'.repeat(500), '/target'],
  ]) { n.add(n.notice(text, href, message)); assert.equal(n.events.length, 1); }
  n.add(n.notice('Target was shouted out!', 'https://www.twitch.tv/target'));
  assert.equal(n.events.length, 2);
  n.add(n.notice('Moderator gave Target a shoutout!', ['/moderatorname', '/target', '/target']));
  assert.equal(n.events.at(-1), 'Moderator gave Target a shoutout! https://www.twitch.tv/moderatorname https://www.twitch.tv/target');
  n.watcher.stop();
  assert.deepEqual(Array.from(FCM.chatModeLabels('twitch', {
    'followers-only': '10', 'subs-only': '1', 'emote-only': '1', slow: '30', r9k: '1',
  })), ['Followers only (10m)', 'Subscribers only', 'Emotes only', 'Slow mode (30s)', 'Unique messages']);
  assert.deepEqual(Array.from(FCM.chatModeLabels('twitch', { 'followers-only': '0' })), ['Followers only']);
  assert.deepEqual(Array.from(FCM.chatModeLabels('twitch', { 'followers-only': '-1', slow: '0' })), []);
  assert.deepEqual(Array.from(FCM.chatModeLabels('kick', {
    followers_mode: true, following_min_duration: 5, subscribers_mode: true, emotes_mode: true,
    slow_mode: true, message_interval: 15,
  })), ['Followers only (5m)', 'Subscribers only', 'Emotes only', 'Slow mode (15s)']);
  assert.deepEqual(Array.from(FCM.chatModeLabels('kick', { slow_mode: true })), ['Slow mode']);
  assert.deepEqual(Array.from(FCM.chatModeLabels('kick', {
    followers_mode: { enabled: true, min_duration: 12 }, subscribers_mode: { enabled: true },
    emotes_mode: { enabled: false }, slow_mode: { enabled: true, message_interval: 25 },
  })), ['Followers only (12m)', 'Subscribers only', 'Slow mode (25s)']);
  for (const platform of ['twitch', 'kick', 'unknown']) {
    assert.deepEqual(Array.from(FCM.chatModeLabels(platform, {})), []);
    assert.deepEqual(Array.from(FCM.chatModeLabels(platform, { followers_mode: false, slow: 'bad' })), []);
  }
  for (const [browser, loadPath] of [['chrome', 'worker'], ['firefox', 'scripts']]) {
    const pair = require('./endtoend').bootPair('/streamer', { browser, loadPath });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      pair.liveIrc()[0].push('@subs-only=1 :tmi.twitch.tv ROOMSTATE #streamer');
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.deepEqual(Array.from(pair.overlays.at(-1).statuses.at(-1).modes), ['Subscribers only']);
      const reloaded = await pair.reloadPage();
      assert.ok(reloaded.statuses.some(status => status.modes?.includes('Subscribers only')));
    } finally { pair.teardown(); }
    const w = require('./background').bootWorker({ browser, loadPath });
    try {
      w.connect();
      vm.runInContext("sessions.get(1).site = 'twitch'; sessions.get(1).hostChannel = 'streamer'; sessions.get(1).conns.twitch.channel = 'streamer'; globalThis.modeSink = makeSink(sessions.get(1), 'twitch');", w.sandbox);
      w.sandbox.modeSink.chatModes({ 'subs-only': '1', slow: '10' });
      assert.deepEqual(Array.from(w.last('status').modes), ['Subscribers only', 'Slow mode (10s)']);
      w.sandbox.modeSink.chatModes({ slow: '0' });
      assert.deepEqual(Array.from(w.last('status').modes), ['Subscribers only']);
      await w.send({ cmd: 'hello', site: 'twitch', channel: 'streamer', hints: [] });
      assert.deepEqual(Array.from(w.last('ready').connections.twitch.modes), ['Subscribers only']);
      const stale = w.sandbox.modeSink;
      await w.send({ cmd: 'leave', platform: 'twitch' });
      const before = w.posted.length; stale.chatModes({ 'subs-only': '1' }); assert.equal(w.posted.length, before);
      vm.runInContext("globalThis.modeSink = makeSink(sessions.get(1), 'twitch');", w.sandbox);
      w.sandbox.modeSink.chatModes({ slow: '20' });
      assert.deepEqual(Array.from(w.last('status').modes), ['Slow mode (20s)'], 'leave resets previous room restrictions');
      const conn = vm.runInContext('sessions.get(1).conns.twitch', w.sandbox);
      w.sandbox.FCM.twitchSource.connect('streamer', w.sandbox.modeSink, conn, null);
      w.socketFor('irc').push('@subs-only=1;slow=0 :tmi.twitch.tv ROOMSTATE #streamer');
      assert.deepEqual(Array.from(w.last('status').modes), ['Subscribers only']);
      w.sandbox.FCM.kickApi.channel = async () => ({ id: 123, user_id: 456, chatroom: { id: 789, subscribers_mode: true } });
      vm.runInContext("globalThis.kickSink = makeSink(sessions.get(1), 'kick');", w.sandbox);
      const kickConn = vm.runInContext('sessions.get(1).conns.kick', w.sandbox);
      await w.sandbox.FCM.kickSource.connect('streamer', w.sandbox.kickSink, kickConn, null);
      assert.deepEqual(Array.from(w.last('status').modes), ['Subscribers only']);
      w.sockets.at(-1).push(JSON.stringify({ event: 'App\\Events\\ChatroomUpdatedEvent', data: JSON.stringify({ chatroom: { subscribers_mode: false, emotes_mode: true } }) }));
      assert.deepEqual(Array.from(w.last('status').modes), ['Emotes only']);
      w.sockets.at(-1).push(JSON.stringify({ event: 'App\\Events\\ChatroomUpdatedEvent', data: JSON.stringify({
        id: 789, subscribers_mode: { enabled: true }, emotes_mode: { enabled: false }, slow_mode: { enabled: true, message_interval: 20 },
      }) }));
      assert.deepEqual(Array.from(w.last('status').modes), ['Subscribers only', 'Slow mode (20s)']);
      w.sockets.at(-1).push(JSON.stringify({ event: 'App\\Events\\ChatroomUpdatedEvent', data: 'null' }));
    } finally { w.teardown(); }
    const ui = require('./youtube-sending-ui.test').fixture({ browser });
    ui.api.setStatus('twitch', 'connected', 'example', ['Followers only', 'Slow mode (10s)']);
    const modes = ui.nodes.get('.fcm-chatmodes');
    assert.equal(modes.textContent, 'Twitch: Followers only · Slow mode (10s)');
    assert.equal(modes.classList.contains('fcm-hidden'), false);
    ui.api.setStatus('kick', 'connected', 'other', ['Subscribers only']);
    assert.match(modes.textContent, /Kick: Subscribers only/);
    ui.api.setStatus('twitch', 'idle'); assert.equal(modes.textContent, 'Kick: Subscribers only');
    ui.api.setStatus('kick', 'idle'); assert.equal(modes.textContent, '');
    assert.equal(modes.classList.contains('fcm-hidden'), true); ui.api.destroy();
  }
  console.log('Issues #88-91 regression tests passed.');
}
module.exports = { run, inputFixture };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
