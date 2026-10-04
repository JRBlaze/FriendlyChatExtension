const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

function fixture() {
  const observers = [], timers = new Map(), prompts = [], events = [];
  const list = {};
  const context = vm.createContext({ FCM: {}, document: { body: {} },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() { this.disconnected = true; }
    },
    setInterval(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  context.self = context;
  const file = path.join(ROOT, 'src/content/native-events.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const watcher = context.FCM.createNativeEventWatcher({ id: 'twitch', messageList: () => list },
    text => events.push(text), prompt => prompts.push(prompt));
  return { FCM: context.FCM, watcher, observers, timers, prompts, events };
}

function row(text, buttons = []) {
  let layoutReads = 0;
  const result = { nodeType: 1, textContent: text, childNodes: [
    { nodeType: 3, nodeValue: text }, ...buttons,
  ], matches: () => false, querySelector: () => null,
    querySelectorAll: selector => selector === 'button' ? buttons : [],
    get innerText() { layoutReads++; return text; },
    layoutReads: () => layoutReads,
  };
  return result;
}

function button(label, aria = '') {
  return { nodeType: 1, tagName: 'BUTTON', textContent: label,
    childNodes: [{ nodeType: 3, nodeValue: label }], getAttribute: () => aria };
}

function historyElement(tag = 'div') {
  const classes = new Set(), attributes = {}, listeners = new Map();
  const node = { nodeType: 1, tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, textContent: '',
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    setAttribute(key, value) { attributes[key] = String(value); },
    getAttribute(key) { return attributes[key] ?? null; },
    hasAttribute(key) { return Object.prototype.hasOwnProperty.call(attributes, key); },
    removeAttribute(key) { delete attributes[key]; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400 }; },
    matches(selector) {
      if (selector === 'img[data-fcm-src]') return this.tagName === 'IMG' && this.hasAttribute('data-fcm-src');
      if (selector === '.fcm-msg[data-platform="youtube"]') return classes.has('fcm-msg') && this.dataset.platform === 'youtube';
      return selector.startsWith('.') && classes.has(selector.slice(1));
    },
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); },
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    cloneNode(deep) {
      const clone = historyElement(tag); clone.className = this.className;
      clone.dataset = { ...this.dataset }; clone.style = { ...this.style }; clone.textContent = this.textContent;
      for (const [key, value] of Object.entries(attributes)) clone.setAttribute(key, value);
      if (deep) this.children.forEach(child => clone.appendChild(child.cloneNode(true)));
      return clone;
    },
    fire(type, target) { listeners.get(type)?.({ type, target, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} }); },
  };
  node.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
  Object.defineProperty(node, 'className', { get: () => [...classes].join(' '), set: value => {
    classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(item => classes.add(item));
  } });
  Object.defineProperty(node, 'childNodes', { get: () => node.children });
  Object.defineProperty(node, 'innerHTML', { set() { node.children = []; }, get: () => '' });
  return node;
}

function historyTests() {
  const context = vm.createContext({ document: { createElement: historyElement }, navigator: {}, window: {},
    setTimeout() { return 1; }, clearTimeout() {} });
  context.self = context;
  for (const name of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/util.js', 'src/content/compose.js']) {
    const file = path.join(ROOT, name);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  context.FCM.view = { settings: context.FCM.DEFAULT_SETTINGS };
  const panel = historyElement(), feed = historyElement(), body = historyElement('span');
  body.className = 'fcm-body';
  const message = historyElement(); message.className = 'fcm-msg';
  message.dataset = { platform: 'youtube', user: 'viewer', msgId: 'fixture' };
  const author = historyElement('span'); author.className = 'fcm-author';
  author.dataset = { platform: 'youtube', name: 'Viewer' };
  message.appendChild(author); message.appendChild(body); feed.appendChild(message);
  const suspended = historyElement('img'), active = historyElement('img'), ordinary = historyElement('img');
  suspended.setAttribute('data-fcm-src', 'https://example.test/emote.gif?a=1&b=2');
  suspended.setAttribute('data-fcm-width', '36px'); suspended.setAttribute('data-fcm-height', '');
  suspended.style = { width: '45px', height: '22px' };
  active.setAttribute('data-fcm-src', 'https://example.test/active.webp');
  active.setAttribute('src', 'https://example.test/active.webp'); active.style = { width: '24px', height: '24px' };
  ordinary.setAttribute('src', 'https://example.test/ordinary.png');
  for (const image of [suspended, active, ordinary]) { image.setAttribute('alt', 'Kappa'); body.appendChild(image); }
  context.FCM.createCompose({ panel, feedEl: feed, inputEl: historyElement('input'), toast() {} });
  feed.fire('contextmenu', author);
  const history = panel.querySelector('.fcm-um-htext');
  assert.ok(history);
  assert.equal(history.children[0].getAttribute('src'), suspended.getAttribute('data-fcm-src'),
    'an offscreen emote loads its original URL when shown in author history');
  assert.equal(history.children[0].style.width, '36px');
  assert.equal(history.children[0].style.height, '');
  for (const attribute of ['data-fcm-src', 'data-fcm-width', 'data-fcm-height']) {
    assert.equal(history.children[0].hasAttribute(attribute), false);
  }
  assert.equal(history.children[1].getAttribute('src'), active.getAttribute('src'));
  assert.deepEqual(history.children[1].style, active.style, 'active image sizing remains intact');
  assert.equal(history.children[1].hasAttribute('data-fcm-src'), false);
  assert.equal(history.children[2].getAttribute('src'), ordinary.getAttribute('src'));
  assert.equal(suspended.getAttribute('src'), null, 'opening history does not reactivate the original offscreen image');
  assert.equal(suspended.getAttribute('data-fcm-width'), '36px');
  assert.equal(suspended.style.width, '45px');
}

function renderTests() {
  const context = vm.createContext({ document: { createElement() {
    return { dataset: {}, classList: { add() {} }, addEventListener() {} };
  } }, URL });
  context.self = context;
  for (const name of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/youtube.js',
    'src/shared/youtube-links.js', 'src/shared/util.js', 'src/shared/irc.js',
    'src/shared/emote-parsers.js', 'src/shared/kick-events.js', 'src/shared/clips.js', 'src/content/render.js']) {
    const file = path.join(ROOT, name);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  const FCM = context.FCM;
  FCM.setViewSettings(FCM.DEFAULT_SETTINGS);
  const providerUrl = 'https://example.test/image.gif?a=1&b="quoted"';
  FCM.setEmotes('twitch', 'thirdparty', { Pog: { url: providerUrl, source: '7TV' } });
  FCM.setCheermotes([{ prefix: 'Cheer', minBits: 1, color: '#979797', url: providerUrl }]);
  const cases = [
    { platform: 'twitch', text: 'K"<&', emoteMap: { 0: { id: '25', end: 3 } }, gigantifiedEmote: true },
    { platform: 'twitch', text: 'Pog' },
    { platform: 'kick', text: '[emote:25:Kappa]' },
    { platform: 'youtube', text: ':yt:', youtubeEmotes: [{ start: 0, end: 4,
      url: 'https://yt3.ggpht.com/fixture=s48' }] },
    { platform: 'twitch', text: 'GIF', gifs: [{ start: 0, end: 2, id: 'fixture',
      url: 'https://media.giphy.com/media/fixture/giphy.gif?a=1&b=2' }] },
    { platform: 'twitch', text: 'Cheer100', bits: 100 },
  ];
  for (const msg of cases) {
    const ordinary = FCM.renderMessageBody(msg.platform, msg.text, msg);
    assert.ok(ordinary.html.includes(' src="'), 'the existing default renders an active image source');
    assert.equal(ordinary.html.includes('data-fcm-src='), false);
    const deferred = FCM.renderMessageBody(msg.platform, msg.text, msg, true);
    assert.equal(deferred.html.includes(' src="'), false, 'deferred body images never start a request');
    assert.ok(deferred.html.includes(' data-fcm-src="'));
    assert.equal(deferred.html.split(' data-fcm-src=').join(' src='), ordinary.html,
      'deferral changes only the image source attribute, not links, escaping or presentation');
    assert.equal(deferred.mentioned, ordinary.mentioned);
    assert.equal(FCM.renderMessageBody(msg.platform, msg.text, msg, false).html, ordinary.html,
      'explicit false retains the default rendering contract');
    const input = { ...msg, author: 'Viewer', messageId: 'fixture' };
    const defaultRow = FCM.buildMessageEl(input);
    const explicitRow = FCM.buildMessageEl(input, null, false);
    const deferredRow = FCM.buildMessageEl(input, null, true);
    assert.equal(explicitRow.innerHTML, defaultRow.innerHTML);
    assert.equal(deferredRow.innerHTML.split(' data-fcm-src=').join(' src='), defaultRow.innerHTML,
      'the message builder forwards deferral to each body image path');
    assert.equal(deferredRow.dataset.msgId, 'fixture');
  }
  assert.ok(FCM.renderMessageBody('twitch', 'Pog', {}, true).html.includes('a=1&amp;b=&quot;quoted&quot;'));
  assert.ok(FCM.renderMessageBody('twitch', 'K"<&', cases[0], true).html.includes('alt="K&quot;&lt;&amp;"'));
  assert.ok(FCM.renderMessageBody('youtube', ':yt:', cases[3], true).html.includes('referrerpolicy="no-referrer"'));
  assert.equal(FCM.renderMessageBody('twitch', 'plain').html, 'plain');
  assert.equal(FCM.renderMessageBody('unknown', '<plain>', {}, true).html, '&lt;plain&gt;');
  assert.equal(FCM.renderLinkedText('plain'), 'plain', 'linked text remains independent of image deferral');
  const filtered = FCM.buildMessageEl({ platform: 'twitch', text: 'Pog', firstMessage: true,
    userId: '123', badgeClass: 'mod' }, new Set(['kick']));
  assert.ok(filtered.className.includes('fcm-hide'));
  assert.ok(filtered.className.includes('fcm-first'));
  assert.equal(filtered.dataset.user, '');
  assert.equal(filtered.dataset.userId, '123');
  assert.ok(filtered.innerHTML.includes('fcm-first-tag'));
  assert.ok(filtered.innerHTML.includes('fcm-chip-mod'));
  assert.ok(filtered.innerHTML.includes(' src="'), 'an omitted deferral flag keeps filtered-row rendering compatible');
}

function run() {
  const f = fixture();
  const ordinary = row('Viewer: Kappa '.repeat(32));
  const reply = row('Viewer: hello', [button('Reply')]);
  const dismissal = row('Your watch streak is ready', [button("Don't Share")]);
  for (const candidate of [ordinary, reply, dismissal]) {
    assert.equal(f.FCM.readNativePrompt(candidate), null);
    assert.equal(candidate.layoutReads(), 0, 'a row without Share never reads layout-dependent text');
  }
  assert.equal(f.FCM.readNativePrompt({ nodeType: 1 }), null);
  const share = button('Share');
  const prompt = row('Your watch streak is ready', [button('Not now'), share]);
  assert.equal(f.FCM.readNativePrompt(prompt).share, share);
  assert.equal(prompt.layoutReads(), 1, 'a real share prompt still reads the displayed text');
  assert.equal(f.FCM.readNativePrompt(row('x'.repeat(401), [share])), null);
  assert.equal(f.FCM.readNativePrompt(row('', [share])), null);
  f.watcher.start();
  assert.equal(f.observers.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.observers[0].options)), { childList: true });
  const busyRows = Array.from({ length: 2000 }, () => row('Kappa '.repeat(100)));
  f.observers[0].callback([{ addedNodes: busyRows }]);
  assert.equal(busyRows.reduce((count, candidate) => count + candidate.layoutReads(), 0), 0,
    'emote-heavy native traffic performs no displayed-text reads for ordinary chat');
  assert.equal(f.events.length, 0);
  assert.equal(f.prompts.length, 0);
  f.observers[0].callback([{ addedNodes: [prompt] }]);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].text, 'Your watch streak is ready');
  f.observers[0].callback([{ addedNodes: [prompt] }]);
  assert.equal(f.prompts.length, 1, 'a redrawn prompt is still offered once');
  f.watcher.stop();
  assert.equal(f.observers[0].disconnected, true);
  assert.equal(f.timers.size, 0);
  historyTests();
  renderTests();
  console.log('Native chat performance tests passed.');
}

module.exports = { run, fixture };
if (require.main === module) run();
