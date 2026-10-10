// Offline YouTube mention replies and moderation boundaries. No live accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

function element(tag = 'div') {
  const classes = new Set(), listeners = new Map();
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, parentElement: null,
    innerHTML: '', textContent: '', value: '', selectionStart: 0, clientHeight: 400, offsetHeight: 40,
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
    removeEventListener() {}, focus() {}, remove() {}, setAttribute(key, value) { this[key] = value; },
    setSelectionRange(start) { this.selectionStart = start; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 240, bottom: 120, width: 240, height: 120 }; },
    matches(selector) { return selector.startsWith('.') && this.classList.contains(selector.slice(1)); },
    closest(selector) { return this.matches(selector) ? this : this.parentElement && this.parentElement.closest(selector); },
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches?.(selector) ? [child] : []), ...(child.querySelectorAll?.(selector) || [])]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    fire(type, target = this) { let result; for (const fn of listeners.get(type) || []) result = fn({ type, target, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} }); return result; },
  };
  Object.defineProperty(node, 'childNodes', { get: () => node.children });
  node.getAttribute = key => node[key] ?? null;
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
    document: { createElement: element, createTextNode: text => ({ nodeType: 3, textContent: text }) }, navigator: { clipboard: { writeText: async name => { if (context.rejectCopy) throw Error('Clipboard unavailable'); context.copied = name; } } }, window: { getSelection: () => null, open: (...args) => { context.opened = args; } } });
  context.self = context;
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/util.js',
    'src/shared/irc.js', 'src/shared/youtube.js', 'src/shared/emote-parsers.js', 'src/content/render.js', 'src/content/compose.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  const FCM = context.FCM;
  FCM.PLATFORM_META.youtube = { name: 'YouTube', short: 'YT', color: '#ff0000', host: 'youtube.com' };
  FCM.setViewSettings(FCM.DEFAULT_SETTINGS);
  return { FCM, context, timers };
}

async function run() {
  const { FCM, timers, context: fixtureContext } = fixture();
  FCM.setEmotes('twitch', 'thirdparty', { Kappa: { url: 'https://example.test/emote.png', source: '7TV' } });
  const text = 'Kappa 😀 <img src=x onerror=alert(1)> @Viewer https://giphy.com/gifs/test';
  const body = FCM.renderMessageBody('youtube', text, { emotes: { Kappa: { url: 'https://example.test/emote.png' } },
    gifs: [{ url: 'https://media.giphy.com/media/test/giphy.gif', start: 0, end: 4 }], bits: 100 });
  assert.match(body.html, /Kappa 😀 &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(body.html, /class="fcm-link"/);
  assert.doesNotMatch(body.html, /<img|fcm-gif/, 'links and mentions never unlock other providers');
  assert.equal(body.mentioned, false);
  for (const empty of [null, undefined, '']) assert.equal(FCM.renderMessageBody('youtube', empty).html, '');

  const url = 'https://yt3.ggpht.com/fixture=s48';
  const emoteText = '😀 :wave: <unsafe> :wave:';
  const youtubeEmotes = [{ start: 3, end: 9, url }, { start: 19, end: 25, url }];
  const rich = FCM.renderMessageBody('youtube', emoteText, { youtubeEmotes });
  assert.equal((rich.html.match(/class="fcm-emote youtube-emote"/g) || []).length, 2);
  assert.match(rich.html, /😀 <img/);
  assert.match(rich.html, /&lt;unsafe&gt;/);
  assert.match(rich.html, /alt=":wave:" loading="lazy" referrerpolicy="no-referrer"/);
  assert.equal(rich.mentioned, false);
  assert.equal(FCM.renderMessageBody('youtube', ':wave:', { youtubeEmotes: [{ start: 0, end: 6, url: 'javascript:bad()' }] }).html, ':wave:');
  const quote = FCM.renderMessageBody('youtube', '<"x>', { youtubeEmotes: [{ start: 0, end: 4, url }] });
  assert.match(quote.html, /alt="&lt;&quot;x&gt;"/);
  const emoteRow = FCM.buildMessageEl({ platform: 'youtube', author: 'EmojiViewer', text: emoteText,
    youtubeEmotes, timestamp: 1 }, new Set(['youtube']));
  assert.match(emoteRow.innerHTML, /youtube-emote/);
  const failed = element('img'); failed.className = 'fcm-emote youtube-emote'; failed.alt = ':wave:';
  let replacement; failed.replaceWith = node => { replacement = node; };
  emoteRow.fire('error', failed);
  assert.equal(replacement.textContent, ':wave:', 'failed downloads leave readable names without retry');
  replacement = null; emoteRow.fire('error', element()); assert.equal(replacement, null);


  FCM.setYouTubeIdentity('@Viewer猫');
  FCM.setViewSettings({ highlightNames: 'Viewer' });
  const mentioned = FCM.renderMessageBody('youtube', 'hello @Viewer猫 https://example.com/?q=<tag>', {});
  assert.equal(mentioned.mentioned, true);
  assert.match(mentioned.html, /class="fcm-mention">@Viewer猫/);
  assert.match(mentioned.html, /rel="noopener noreferrer"/);
  assert.equal(FCM.renderMessageBody('youtube', '@Viewer猫x').mentioned, false);
  const own = FCM.buildMessageEl({ platform: 'youtube', author: '@Viewer猫', text: '@Viewer猫' });
  assert.equal(own.classList.contains('fcm-mentioned'), false);
  const other = FCM.buildMessageEl({ platform: 'youtube', author: '@Other', text: '@Viewer猫' });
  assert.equal(other.classList.contains('fcm-mentioned'), true);
  assert.match(FCM.renderMessageBody('youtube', '@Other猫').html, /fcm-mention-youtube/);
  FCM.setYouTubeIdentity('');
  assert.equal(FCM.renderMessageBody('youtube', '@Viewer猫').mentioned, false);
  FCM.setViewSettings({ highlightNames: 'Chosen' });
  assert.equal(FCM.renderMessageBody('youtube', '@Chosen').mentioned, true);
  assert.equal(FCM.renderMessageBody('twitch', 'Hi @Chosen!').mentioned, true);
  assert.match(FCM.renderMessageBody('kick', '@OtherUser').html, /fcm-mention-kick/);
  assert.equal(FCM.renderMessageBody('youtube', 'prefixChosen ChosenSuffix').mentioned, false);
  assert.equal(FCM.renderMessageBody('youtube', 'prefix@Chosen').mentioned, true);
  assert.equal(FCM.renderMessageBody('youtube', 'Chosen').mentioned, true);
  FCM.resetChannelView();
  FCM.setViewSettings(FCM.DEFAULT_SETTINGS);
  assert.equal(FCM.renderBadges('youtube', [{ type: 'admin', label: 'Admin' }]), '');
  assert.match(FCM.renderBadges('youtube', [{ type: 'owner', label: 'Owner <script>', url }, { type: 'member', label: 'Member (6 months)', url }]), /Owner &lt;script&gt;/);
  const eventRow = FCM.buildMessageEl({ platform: 'youtube', author: 'Supporter', text: 'Hi', youtubeBadges: [{ type: 'verified', label: 'Verified', url }],
    youtubeEvent: { kind: 'superchat', amount: '$5 <script>', header: 'Thank you <img>' } });
  assert.match(eventRow.innerHTML, /Super Chat/); assert.match(eventRow.innerHTML, /\$5 &lt;script&gt;/);
  assert.match(eventRow.innerHTML, /Thank you &lt;img&gt;/); assert.match(eventRow.innerHTML, /class="fcm-badge-img youtube-badge"/);
  assert.match(eventRow.innerHTML, /alt=""[^>]*referrerpolicy="no-referrer"/);
  assert.doesNotMatch(eventRow.innerHTML, />VERIFIED</);
  assert.equal(eventRow.classList.contains('fcm-youtube-event'), true);
  for (const type of ['owner', 'moderator', 'member', 'verified']) {
    assert.equal(FCM.renderBadges('youtube', [{ type, label: type }]), '', 'no text fallback');
    assert.equal(FCM.renderBadges('youtube', [{ type, label: type, url: 'https://evil.test/badge' }]), '');
    assert.match(FCM.renderBadges('youtube', [{ type, label: type, url }]), /<img /);
  }
  const fallbackRow = FCM.buildMessageEl({ platform: 'youtube', author: 'Viewer', text: 'hello', badgeClass: 'moderator' });
  assert.doesNotMatch(fallbackRow.innerHTML, /fcm-chip-moderator|>MODERATOR</);
  const brokenBadge = element('img'); brokenBadge.className = 'fcm-badge-img youtube-badge';
  let badgeRemoved = 0, groupRemoved = 0;
  const group = { childElementCount: 2, remove() { groupRemoved++; } };
  brokenBadge.parentElement = group;
  brokenBadge.remove = () => { badgeRemoved++; group.childElementCount--; };
  eventRow.fire('error', brokenBadge);
  assert.equal(badgeRemoved, 1); assert.equal(groupRemoved, 0, 'working sibling badges remain');
  eventRow.fire('error', brokenBadge);
  assert.equal(badgeRemoved, 2); assert.equal(groupRemoved, 1, 'empty badge wrapper is removed without text');
  const headerOnly = FCM.buildMessageEl({ platform: 'youtube', author: 'Member', text: 'Joined', youtubeEvent: { kind: 'membership', header: 'Joined' } });
  assert.equal((headerOnly.innerHTML.match(/Joined/g) || []).length, 1, 'event header is not repeated as body');
  const stickerOnly = FCM.buildMessageEl({ platform: 'youtube', author: 'Fan', text: 'Super Sticker', youtubeEvent: { kind: 'sticker' } });
  assert.equal((stickerOnly.innerHTML.match(/Super Sticker/g) || []).length, 1, 'generic sticker fallback is shown once');

  FCM.forgetChatters('youtube');
  const row = FCM.buildMessageEl({ platform: 'youtube', messageId: 'youtube:AbCdEfGhIJK:one',
    author: 'Viewer <script>', login: '@Viewer', timestamp: 1, text, readOnly: true }, new Set(['youtube']));
  assert.equal(row.dataset.platform, 'youtube');
  assert.equal(row.dataset.msgId, 'youtube:AbCdEfGhIJK:one');
  assert.match(row.innerHTML, /click to reply on YouTube/);
  assert.doesNotMatch(row.innerHTML, /fcm-chip-youtube|>YT<\/span>/, 'YouTube authors have no extra platform badge');
  assert.match(row.innerHTML, /fcm-dot-youtube/, 'the platform dot still identifies YouTube messages');
  assert.equal(FCM.renderBadges('youtube', [{ type: 'moderator' }]), '', 'unlabelled role metadata is ignored');
  assert.match(row.innerHTML, /Viewer &lt;script&gt;/);
  assert.doesNotMatch(row.innerHTML, /replies and moderation unavailable/);
  assert.equal(FCM.recentChatters().length, 1, 'YouTube authors become mention candidates');
  FCM.rememberChatter('youtube', '@ReadOnly');
  FCM.rememberChatter('youtube', 'ReadOnly');
  assert.equal(FCM.recentChatters().at(-1).name, 'ReadOnly', 'a leading @ is normalized before deduplication');
  FCM.rememberChatter('youtube', '@');
  FCM.rememberChatter('youtube', null);
  FCM.rememberChatter('unrecognized', 'ReadOnly');
  assert.equal(FCM.recentChatters().length, 2);
  for (const platform of ['twitch', 'kick']) {
    const native = FCM.buildMessageEl({ platform, author: 'Active', text: 'hello', messageId: platform }, new Set([platform]));
    assert.match(native.innerHTML, /click for reply/);
  }
  assert.equal(FCM.recentChatters().length, 4, 'chatters from all three platforms are retained');
  FCM.forgetChatters('youtube');
  assert.deepEqual(Array.from(FCM.recentChatters(), c => c.platform), ['twitch', 'kick']);

  const panel = element(), input = element('input'), feed = element();
  const replies = [], profiles = [], moderation = [];
  let allowModeration = true;
  const compose = FCM.createCompose({ panel, inputEl: input, feedEl: feed, emoteBtn: element('button'), toast() {}, hostPlatform: 'twitch',
    onReplyTo: (...args) => replies.push(args), onProfile: async (...args) => { profiles.push(args); return null; },
    canModerate: () => allowModeration, onModerate: (...args) => moderation.push(args) });
  input.value = 'keep my draft';
  for (const platform of ['unrecognized']) {
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
  const sourceYT = element(), authorYT = element('span');
  sourceYT.className = 'fcm-msg'; sourceYT.dataset = { platform: 'youtube', msgId: 'yt-row' };
  authorYT.className = 'fcm-author'; authorYT.dataset = { platform: 'youtube', name: '@Viewer-猫' };
  sourceYT.appendChild(authorYT); feed.appendChild(sourceYT);
  feed.fire('click', authorYT);
  assert.equal(input.value, 'keep my draft @Viewer-猫 ');
  assert.deepEqual(replies.pop(), ['youtube', 'Viewer-猫', undefined]);
  feed.fire('click', authorYT);
  assert.equal(input.value, 'keep my draft @Viewer-猫 ', 'repeated clicking never duplicates a Unicode mention');
  replies.pop();
  assert.equal(compose.modBarFor(sourceYT), null, 'YouTube never gains moderator controls');
  assert.equal(panel.children[1].classList.contains('fcm-hidden'), true, 'YouTube name click directly prepares the reply');
  feed.fire('contextmenu', authorYT);
  assert.equal(panel.children[1].classList.contains('fcm-hidden'), false);
  const menuText = panel.children[1].children.map(node => node.textContent).join(' ');
  assert.match(menuText, /Recent messages/);
  assert.equal(profiles.length, 0); assert.equal(moderation.length, 0);
  const copyAction = panel.children[1].children.find(node => node.textContent === 'Copy username');
  assert.ok(copyAction); copyAction.fire('click');
  assert.equal(fixtureContext.copied, '@Viewer-猫');
  feed.fire('contextmenu', element('span'));
  const beforeEmpty = input.value;
  compose.insertMention('@', 'youtube');
  assert.equal(input.value, beforeEmpty, 'empty normalized names cannot arm a reply');
  assert.equal(profiles.length, 0); assert.equal(moderation.length, 0);
  for (const platform of ['twitch', 'kick', undefined]) compose.insertMention('Writable', platform);
  assert.deepEqual(replies.map(args => args[0]), ['twitch', 'kick']);

  // Include YouTube without allowing an unknown platform to become a reply destination.
  FCM.recentChatters = () => [{ name: 'ViewerBad', platform: 'unknown', time: 4 }, { name: 'ViewerYT', platform: 'youtube', time: 3 },
    { name: 'ViewerTW', platform: 'twitch', time: 2 }, { name: 'ViewerKI', platform: 'kick', time: 1 }];
  input.value = '@Viewer'; input.selectionStart = input.value.length;
  compose.updateAutocomplete();
  assert.match(panel.children[0].innerHTML, /ViewerYT/);
  assert.doesNotMatch(panel.children[0].innerHTML, /ViewerBad/);
  assert.match(panel.children[0].innerHTML, /ViewerTW/); assert.match(panel.children[0].innerHTML, /ViewerKI/);
  compose.handleKey({ key: 'Tab', preventDefault() {} });
  assert.equal(replies.at(-1)[0], 'youtube');
  assert.equal(input.value, '@ViewerYT ');
  input.value = 'before @Viewer after'; input.selectionStart = 'before @Viewer'.length;
  compose.updateAutocomplete();
  const beforeStale = replies.length;
  FCM.recentChatters = () => [];
  compose.handleKey({ key: 'Tab', preventDefault() {} });
  assert.equal(input.value, 'before @Viewer after', 'stale suggestions cannot turn into replies after source removal');
  assert.equal(replies.length, beforeStale);

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
    source.dataset.user = 'active'; source.dataset.msgId = 'native'; author.dataset.name = 'Active'; allowModeration = true;
    const previous = panel.children[1].children.length;
    feed.fire('click', author);
    const actions = panel.children[1].children.slice(previous);
    assert.ok(actions.some(node => node.textContent === `Open their ${platform === 'twitch' ? 'Twitch' : 'Kick'} channel`));
    for (const action of actions) {
      if (action.classList.contains('fcm-um-action')) action.fire('click');
      if (action.classList.contains('fcm-um-timeouts')) for (const button of action.children) button.fire('click');
    }
    assert.ok(fixtureContext.opened[0].startsWith(platform === 'twitch' ? 'https://www.twitch.tv/' : 'https://kick.com/'));
    assert.ok(moderation.length > 0, 'native platform menu retains moderation actions');
    moderation.length = 0;
    delete source.dataset.msgId;
    const beforeMissingId = panel.children[1].children.length;
    feed.fire('click', author);
    const noDelete = panel.children[1].children.slice(beforeMissingId).find(node => node.textContent === 'Delete this message');
    assert.equal(noDelete.disabled, true, 'native menu cannot delete a message without its ID');
    fixtureContext.rejectCopy = true;
    actions.find(node => node.textContent === 'Copy username').fire('click');
    await Promise.resolve(); fixtureContext.rejectCopy = false;

  }
  // Copy only the selected message body, including rich-text alternatives.
  for (const platform of ['twitch', 'kick', 'youtube']) {
    const copyPanel = element(), draft = element('input'), copyFeed = element(), notices = [];
    draft.value = 'My unsent draft';
    const copier = FCM.createCompose({ panel: copyPanel, inputEl: draft, feedEl: copyFeed,
      emoteBtn: element('button'), toast: value => notices.push(value), canModerate: () => false,
      onReplyTo: () => assert.fail('Copy must not prepare a reply') });
    const source = element(), author = element('span'), body = element('span');
    source.className = 'fcm-msg'; source.dataset = { platform, user: 'raider' };
    author.className = 'fcm-author'; author.dataset = { platform, name: 'Raider' };
    body.className = 'fcm-body'; source.appendChild(author); source.appendChild(body); copyFeed.appendChild(source);
    const txt = value => ({ nodeType: 3, nodeValue: value });
    const image = element('img'); image.alt = 'RaidHype';
    const mention = element('span'); mention.appendChild(txt('@Streamer'));
    const link = element('a'); link.appendChild(txt('https://example.com/raid'));
    body.appendChild(txt('  RAID <3  ')); body.appendChild(image); body.appendChild(txt(' '));
    body.appendChild(mention); body.appendChild(element('br')); body.appendChild(link); body.appendChild(txt(' 😀 '));
    const cheer = element('span'), cheerImage = element('img'), amount = element('span');
    cheerImage.alt = 'Cheer100'; amount.className = 'fcm-cheer-amount'; amount.appendChild(txt('100'));
    cheer.appendChild(cheerImage); cheer.appendChild(amount); body.appendChild(cheer);
    const gif = element('span'), gifImage = element('img'), gifLabel = element('span');
    gifImage.alt = 'GIF'; gifLabel.className = 'fcm-gif-label'; gifLabel.appendChild(txt('GIF'));
    gif.appendChild(gifImage); gif.appendChild(gifLabel); body.appendChild(gif);
    body.appendChild(element('img')); body.appendChild({ nodeType: 8, nodeValue: 'comment' });
    const openCopy = target => {
      const count = copyPanel.children[1].children.length;
      copyFeed.fire('contextmenu', target);
      const action = copyPanel.children[1].children.slice(count).find(node => node.textContent === 'Copy message');
      assert.ok(action, 'right-clicking a message or its author offers Copy message'); return action;
    };
    fixtureContext.copied = 'untouched';
    const action = openCopy(image);
    assert.equal(fixtureContext.copied, 'untouched', 'opening the menu cannot write to the clipboard');
    await action.fire('click');
    assert.equal(fixtureContext.copied, '  RAID <3  RaidHype @Streamer\nhttps://example.com/raid 😀 Cheer100GIF');
    assert.equal(notices.at(-1), 'Message copied'); assert.equal(draft.value, 'My unsent draft');
    assert.equal(copyPanel.children[1].classList.contains('fcm-hidden'), true);
    fixtureContext.rejectCopy = true; await openCopy(author).fire('click');
    assert.match(notices.at(-1), /Could not copy/); fixtureContext.rejectCopy = false;
    const clipboard = fixtureContext.navigator.clipboard; delete fixtureContext.navigator.clipboard;
    await openCopy(body).fire('click'); assert.match(notices.at(-1), /Could not copy/);
    fixtureContext.navigator.clipboard = clipboard;
    const beforeDeleted = fixtureContext.copied, stale = openCopy(body);
    source.classList.add('fcm-deleted'); await stale.fire('click');
    assert.equal(fixtureContext.copied, beforeDeleted); assert.match(notices.at(-1), /no longer available/);
    assert.equal(openCopy(body).disabled, true);
    source.classList.remove('fcm-deleted'); body.children = [txt('  ')];
    assert.equal(openCopy(body).disabled, true, 'empty messages do not replace the clipboard');
    source.children = [author]; assert.equal(openCopy(author).disabled, true, 'missing body disables Copy');
    copyFeed.fire('contextmenu', element());
    const noAuthor = element(); noAuthor.className = 'fcm-msg'; copyFeed.fire('contextmenu', noAuthor);
    copier.closeAll();
  }
  const css = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
  assert.match(css, /\.fcm-youtube-event-label[^}]*font-weight:\s*700/);
  assert.match(css, /\.fcm-mention-youtube[^}]*var\(--youtube-text\)/);
  console.log('YouTube mention replies and moderation boundaries passed.');
}

module.exports = run;
module.exports.fixture = fixture;
module.exports.element = element;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
