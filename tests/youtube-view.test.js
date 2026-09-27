// Offline read-only YouTube rendering and composer boundaries. No live accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

function element(tag = 'div') {
  const classes = new Set(), listeners = new Map();
  const node = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, parentElement: null,
    innerHTML: '', textContent: '', value: '', selectionStart: 0, clientHeight: 400, offsetHeight: 40,
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
    removeEventListener() {}, focus() {}, remove() {}, setAttribute(key, value) { this[key] = value; },
    setSelectionRange(start) { this.selectionStart = start; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 240, bottom: 120, width: 240, height: 120 }; },
    matches(selector) { return selector.startsWith('.') && this.classList.contains(selector.slice(1)); },
    closest(selector) { return this.matches(selector) ? this : this.parentElement && this.parentElement.closest(selector); },
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    fire(type, target = this) { for (const fn of listeners.get(type) || []) fn({ target, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} }); },
  };
  node.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
    toggle: (value, on) => on ? classes.add(value) : classes.delete(value) };
  Object.defineProperty(node, 'className', { get: () => [...classes].join(' '), set: value => {
    classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(item => classes.add(item));
  } });
  return node;
}

function fixture() {
  const timers = [];
  const context = vm.createContext({ console, URL, URLSearchParams,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    chrome: { storage: { sync: { get: async () => ({}) } } },
    document: { createElement: element }, window: { getSelection: () => null } });
  context.self = context;
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/util.js',
    'src/shared/irc.js', 'src/shared/emote-parsers.js', 'src/content/render.js', 'src/content/compose.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  const FCM = context.FCM;
  FCM.PLATFORM_META.youtube = { name: 'YouTube', short: 'YT', color: '#ff0000', host: 'youtube.com' };
  FCM.setViewSettings(FCM.DEFAULT_SETTINGS);
  return { FCM, context, timers };
}

async function run() {
  const { FCM, timers } = fixture();
  FCM.setEmotes('twitch', 'thirdparty', { Kappa: { url: 'https://example.test/emote.png', source: '7TV' } });
  const text = 'Kappa 😀 <img src=x onerror=alert(1)> @Viewer https://giphy.com/gifs/test';
  const body = FCM.renderMessageBody('youtube', text, { emotes: { Kappa: { url: 'https://example.test/emote.png' } },
    gifs: [{ url: 'https://media.giphy.com/media/test/giphy.gif', start: 0, end: 4 }], bits: 100 });
  assert.equal(body.html, FCM.escapeHtml(text), 'YouTube remains escaped plain text without substitutions or links');
  assert.equal(body.mentioned, false);
  for (const empty of [null, undefined, '']) assert.equal(FCM.renderMessageBody('youtube', empty).html, '');
  const row = FCM.buildMessageEl({ platform: 'youtube', messageId: 'youtube:AbCdEfGhIJK:one',
    author: 'Viewer <script>', login: '@Viewer', timestamp: 1, text, readOnly: true }, new Set(['youtube']));
  assert.equal(row.dataset.platform, 'youtube');
  assert.equal(row.dataset.msgId, 'youtube:AbCdEfGhIJK:one');
  assert.match(row.innerHTML, /YouTube.*replies and moderation unavailable/);
  assert.doesNotMatch(row.innerHTML, /fcm-chip-youtube|>YT<\/span>/, 'YouTube authors have no extra platform badge');
  assert.match(row.innerHTML, /fcm-dot-youtube/, 'the platform dot still identifies YouTube messages');
  assert.equal(FCM.renderBadges('youtube', [{ type: 'moderator' }]), '', 'native metadata cannot recreate the YouTube badge');
  assert.match(row.innerHTML, /Viewer &lt;script&gt;/);
  assert.doesNotMatch(row.innerHTML, /click for reply/);
  assert.equal(FCM.recentChatters().length, 0, 'read-only authors never become reply candidates');
  FCM.rememberChatter('youtube', 'ReadOnly');
  FCM.rememberChatter('unrecognized', 'ReadOnly');
  assert.equal(FCM.recentChatters().length, 0);
  for (const platform of ['twitch', 'kick']) {
    const native = FCM.buildMessageEl({ platform, author: 'Active', text: 'hello', messageId: platform }, new Set([platform]));
    assert.match(native.innerHTML, /click for reply/);
  }
  assert.equal(FCM.recentChatters().length, 2, 'existing writable chatters are retained');

  const panel = element(), input = element('input'), feed = element();
  const replies = [], profiles = [], moderation = [];
  let allowModeration = true;
  const compose = FCM.createCompose({ panel, inputEl: input, feedEl: feed, emoteBtn: element('button'), toast() {},
    onReplyTo: (...args) => replies.push(args), onProfile: async (...args) => { profiles.push(args); return null; },
    canModerate: () => allowModeration, onModerate: (...args) => moderation.push(args) });
  input.value = 'keep my draft';
  for (const platform of ['youtube', 'unrecognized']) {
    compose.insertMention('ReadOnly', platform, 'id');
    assert.equal(input.value, 'keep my draft');
    assert.equal(replies.length, 0);
    const source = element(), author = element('span');
    source.className = 'fcm-msg'; source.dataset = { platform, user: 'reader', msgId: 'id' };
    author.className = 'fcm-author'; author.dataset = { platform, name: 'Reader' };
    source.appendChild(author); feed.appendChild(source);
    feed.fire('click', author);
    assert.equal(panel.children[1].classList.contains('fcm-hidden'), true, 'no read-only user menu');
    assert.equal(compose.modBarFor(source), null, 'even stale moderation permission cannot enable YouTube tools');
  }
  assert.equal(profiles.length, 0); assert.equal(moderation.length, 0);
  for (const platform of ['twitch', 'kick', undefined]) compose.insertMention('Writable', platform);
  assert.deepEqual(replies.map(args => args[0]), ['twitch', 'kick']);

  // Also reject a stale or externally supplied autocomplete entry, independently of the renderer guard.
  FCM.recentChatters = () => [{ name: 'ViewerYT', platform: 'youtube', time: 3 },
    { name: 'ViewerTW', platform: 'twitch', time: 2 }, { name: 'ViewerKI', platform: 'kick', time: 1 }];
  input.value = '@Viewer'; input.selectionStart = input.value.length;
  compose.updateAutocomplete();
  assert.doesNotMatch(panel.children[0].innerHTML, /ViewerYT/);
  assert.match(panel.children[0].innerHTML, /ViewerTW/); assert.match(panel.children[0].innerHTML, /ViewerKI/);
  compose.handleKey({ key: 'Tab', preventDefault() {} });
  assert.equal(replies.at(-1)[0], 'twitch');
  for (const platform of ['twitch', 'kick']) {
    const source = element(), author = element('span');
    source.className = 'fcm-msg'; source.dataset = { platform, user: 'active', msgId: 'native' };
    author.className = 'fcm-author'; author.dataset = { platform, name: 'Active' };
    source.appendChild(author); feed.appendChild(source);
    const bar = compose.modBarFor(source);
    assert.ok(bar);
    bar.children[0].fire('click');
    assert.deepEqual(JSON.parse(JSON.stringify(moderation.pop())), [platform, 'delete',
      { username: 'Active', userId: '', messageId: 'native' }]);
    bar.children[1].fire('click');
    assert.deepEqual(JSON.parse(JSON.stringify(moderation.pop())), [platform, 'timeout',
      { seconds: 600, username: 'Active', userId: '', messageId: 'native' }]);
    const ban = bar.children[2];
    ban.fire('click');
    assert.equal(ban.textContent, 'Ban?'); assert.equal(moderation.length, 0);
    ban.fire('click');
    assert.equal(ban.textContent, 'Ban');
    assert.deepEqual(JSON.parse(JSON.stringify(moderation.pop())), [platform, 'ban',
      { username: 'Active', userId: '', messageId: 'native' }]);
    ban.fire('click');
    const disarm = timers.findLast(timer => timer.ms === 3000 && timer.fn);
    assert.ok(disarm); disarm.fn();
    assert.equal(ban.textContent, 'Ban'); assert.equal(bar.dataset.armed, '');
    assert.equal(moderation.length, 0, 'the first ban click expires without an action');
    delete source.dataset.msgId;
    assert.equal(compose.modBarFor(source).children.length, 2, 'missing message ID offers no delete');
    FCM.QUICK_TIMEOUT_SECONDS = 3600;
    assert.equal(compose.modBarFor(source).children[0].textContent, '1h');
    FCM.QUICK_TIMEOUT_SECONDS = 5;
    assert.equal(compose.modBarFor(source).children[0].textContent, '5s');
    FCM.QUICK_TIMEOUT_SECONDS = 600;
    allowModeration = false;
    assert.equal(compose.modBarFor(source), null);
    feed.fire('click', author);
    assert.equal(profiles.at(-1)[0], platform, 'existing profile menu still opens');
    compose.closeAll(); allowModeration = true;
    author.dataset.name = ''; feed.fire('click', author);
    source.dataset.user = '';
    assert.equal(compose.modBarFor(source), null, 'missing target identity cannot offer moderation');
  }
  console.log('YouTube view and read-only composer boundaries passed.');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
