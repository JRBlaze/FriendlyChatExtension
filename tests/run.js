// Offline test suite. Nothing here touches the network: every platform
// response is stubbed, so the parsers, the renderer and the cross-platform
// matcher are all driven exactly as the extension drives them.
//
//   node tests/run.js            run everything
//   node tests/run.js irc        run one suite (irc, kick, render, discovery, sites)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; return; }
  failed++;
  failures.push(`${label}\n      expected: ${b}\n      actual:   ${a}`);
}

function ok(value, label) {
  if (value) { passed++; return; }
  failed++;
  failures.push(`${label}\n      expected truthy, got: ${JSON.stringify(value)}`);
}

function contains(haystack, needle, label) {
  if (String(haystack).includes(needle)) { passed++; return; }
  failed++;
  failures.push(`${label}\n      expected to contain: ${needle}\n      actual: ${haystack}`);
}

function missing(haystack, needle, label) {
  if (!String(haystack).includes(needle)) { passed++; return; }
  failed++;
  failures.push(`${label}\n      expected NOT to contain: ${needle}\n      actual: ${haystack}`);
}

// ── Sandbox ───────────────────────────────────────────────────────────────────

function makeSandbox(extra = {}) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    WebSocket: function () {},
    ...extra,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function load(sandbox, ...relPaths) {
  relPaths.forEach((rel) => {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, sandbox, { filename: rel });
  });
  return sandbox.FCM;
}

const SHARED = [
  'src/shared/namespace.js',
  'src/shared/constants.js',
  'src/shared/util.js',
  'src/shared/irc.js',
  'src/shared/emote-parsers.js',
  'src/shared/kick-events.js',
];

// ── Suites ────────────────────────────────────────────────────────────────────

const suites = {};

suites.irc = function () {
  const FCM = load(makeSandbox(), ...SHARED);

  const line = '@badge-info=subscriber/13;badges=subscriber/12,premium/1;color=#1E90FF;'
    + 'display-name=SomeUser;emotes=25:0-4/1902:12-16;id=abc-123;mod=0;room-id=71092938;'
    + 'subscriber=1;tmi-sent-ts=1700000000000;user-id=555 '
    + ':someuser!someuser@someuser.tmi.twitch.tv PRIVMSG #xqc :Kappa hello Keepo there';

  const parsed = FCM.parseIrcLine(line);
  eq(parsed.command, 'PRIVMSG', 'irc: command is read from structure');
  eq(parsed.params[0], '#xqc', 'irc: channel param');
  eq(parsed.params[1], 'Kappa hello Keepo there', 'irc: trailing param keeps its spaces');
  eq(parsed.tags['display-name'], 'SomeUser', 'irc: display-name tag');
  eq(parsed.tags['tmi-sent-ts'], '1700000000000', 'irc: timestamp tag');
  eq(FCM.ircNick(parsed.prefix), 'someuser', 'irc: nick from prefix');

  // A message that merely contains a command word must not be mistaken for one.
  const trap = FCM.parseIrcLine(
    '@display-name=Troll :troll!troll@troll.tmi.twitch.tv PRIVMSG #xqc :USERSTATE lol'
  );
  eq(trap.command, 'PRIVMSG', 'irc: USERSTATE inside a message is still a PRIVMSG');

  // IRCv3 tag escaping.
  const escaped = FCM.parseIrcLine('@system-msg=hello\\sworld\\:x :tmi.twitch.tv USERNOTICE #c');
  eq(escaped.tags['system-msg'], 'hello world;x', 'irc: tag values are unescaped');

  const emoteMap = FCM.parseTwitchEmoteMap('25:0-4/1902:12-16');
  eq(emoteMap[0], { id: '25', end: 4 }, 'irc: emote map start index');
  eq(emoteMap[12], { id: '1902', end: 16 }, 'irc: emote map second emote');
  eq(FCM.parseTwitchEmoteMap(''), null, 'irc: empty emote tag gives null');

  eq(FCM.twitchBadgeClass('moderator/1'), 'mod', 'irc: moderator badge');
  eq(FCM.twitchBadgeClass('subscriber/12,premium/1'), 'sub', 'irc: subscriber badge');
  eq(FCM.twitchBadgeClass('vip/1'), 'vip', 'irc: vip badge');
  eq(FCM.twitchBadgeClass(''), null, 'irc: no badge');

  const raid = FCM.twitchUserNoticeSummary({
    'msg-id': 'raid', 'display-name': 'Streamer', 'msg-param-viewerCount': '1200',
  });
  eq(raid, 'Streamer is raiding with 1200 viewers.', 'irc: raid summary');

  const resub = FCM.twitchUserNoticeSummary({
    'msg-id': 'resub', 'display-name': 'Fan', 'msg-param-cumulative-months': '24',
    'msg-param-sub-plan': '2000',
  });
  eq(resub, 'Fan resubscribed (24 months) (Tier 2).', 'irc: resub summary');
};

suites.kick = function () {
  const FCM = load(makeSandbox(), ...SHARED);

  eq(
    FCM.formatKickEventSummary('App\\Events\\SubscriptionEvent', { username: 'Someone' }),
    'Someone subscribed.',
    'kick: subscription event'
  );
  eq(
    FCM.formatKickEventSummary('App\\Events\\GiftedSubscriptionsEvent', {
      gifter_username: 'Whale', gifted_usernames: ['a', 'b', 'c'],
    }),
    'Whale gifted 3 subs.',
    'kick: gifted subs event'
  );
  eq(
    FCM.formatKickEventSummary('App\\Events\\ChatroomClearEvent', {}),
    'Chat was cleared by a moderator.',
    'kick: chat clear event'
  );
  eq(
    FCM.formatKickEventSummary('App\\Events\\LivestreamUpdated', {}),
    '',
    'kick: housekeeping events are dropped'
  );

  ok(FCM.isPusherProtocolEvent('pusher:ping'), 'kick: pusher protocol event detected');
  ok(FCM.isPusherProtocolEvent('pusher_internal:subscription_succeeded'), 'kick: internal event detected');
  ok(!FCM.isPusherProtocolEvent('App\\Events\\ChatMessageEvent'), 'kick: chat event is not protocol');

  eq(FCM.kickBadgeClass([{ type: 'subscriber' }]), 'sub', 'kick: subscriber badge class');
  eq(FCM.kickBadgeClass([{ type: 'moderator' }, { type: 'subscriber' }]), 'mod', 'kick: mod wins');
  eq(FCM.kickBadgeClass([]), null, 'kick: no badges');

  // The real shape returned by kick.com/emotes/<slug>.
  const store = FCM.parseKickEmotePayload([
    { id: 668, emotes: [{ id: 4001, name: 'xqcL' }, { id: 4002, name: 'xqcCheer' }] },
    { id: 'Global', name: 'Global', emotes: [{ id: 1, name: 'emojiOne' }] },
    { id: 'Emoji', name: 'Emojis', emotes: [{ id: 2, name: 'smile' }] },
  ]);
  eq(store.xqcL.url, 'https://files.kick.com/emotes/4001/fullsize', 'kick: channel emote url');
  eq(store.xqcL.source, 'Kick Channel', 'kick: channel emote source');
  eq(store.emojiOne.source, 'Kick Global', 'kick: global emote source');
  eq(store.smile.source, 'Kick Emoji', 'kick: emoji set source');

  // Non-numeric ids do not resolve on the CDN and must be skipped.
  const skipped = FCM.parseKickEmotePayload([{ id: 1, emotes: [{ id: 'abc', name: 'bogus' }] }]);
  eq(Object.keys(skipped).length, 0, 'kick: non-numeric emote ids are skipped');
};

// Enough of a DOM for the row builders, which only set properties on the node
// they create. Reading back innerHTML is what the assertions check.
function stubDocument() {
  return {
    createElement: () => ({ dataset: {}, className: '', innerHTML: '', style: {} }),
  };
}

suites.render = function () {
  const sandbox = makeSandbox({
    chrome: { storage: { sync: { get: async () => ({}) } } },
    document: stubDocument(),
  });
  const FCM = load(sandbox, ...SHARED, 'src/content/render.js');

  FCM.setViewSettings({ ...FCM.DEFAULT_SETTINGS, highlightNames: 'MyName' });

  // Twitch emotes come from codepoint positions in the tag.
  const tw = FCM.renderMessageBody('twitch', 'Kappa hello', {
    emoteMap: FCM.parseTwitchEmoteMap('25:0-4'),
  });
  contains(tw.html, 'static-cdn.jtvnw.net/emoticons/v2/25/', 'render: twitch emote image');
  contains(tw.html, 'alt="Kappa"', 'render: twitch emote alt text');
  contains(tw.html, ' hello', 'render: text after the emote survives');

  // Positions are codepoint indices, so an emoji earlier in the line must not
  // shift the emote.
  const shifted = FCM.renderMessageBody('twitch', '\u{1F600} Kappa', {
    emoteMap: { 2: { id: '25', end: 6 } },
  });
  contains(shifted.html, 'alt="Kappa"', 'render: emote position is codepoint-based, not UTF-16');

  // Kick emotes arrive as inline tokens.
  const kick = FCM.renderMessageBody('kick', 'hey [emote:37226:emojiKEK] there', { emotes: [] });
  contains(kick.html, 'files.kick.com/emotes/37226/fullsize', 'render: kick inline emote token');
  contains(kick.html, 'alt="emojiKEK"', 'render: kick emote name');
  missing(kick.html, '[emote:', 'render: the raw token is replaced');

  // Third-party emotes match on the whole word only.
  FCM.setEmotes('twitch', 'thirdparty', { PogU: { url: 'https://cdn.7tv/pogu.webp', source: '7TV' } });
  const seventv = FCM.renderMessageBody('twitch', 'that was PogU honestly', {});
  contains(seventv.html, 'cdn.7tv/pogu.webp', 'render: 7TV emote by name');
  const partial = FCM.renderMessageBody('twitch', 'PogUUU', {});
  missing(partial.html, 'cdn.7tv/pogu.webp', 'render: partial word is not an emote');

  // Links.
  const link = FCM.renderMessageBody('twitch', 'see https://example.com/a?b=1&c=2 now', {});
  contains(link.html, 'href="https://example.com/a?b=1&amp;c=2"', 'render: link href is escaped once');
  contains(link.html, 'rel="noopener noreferrer"', 'render: link is safe to click');
  const bracketed = FCM.renderMessageBody('twitch', '(https://example.com)', {});
  contains(bracketed.html, 'href="https://example.com"', 'render: trailing bracket is not part of the link');

  // Mentions.
  const mention = FCM.renderMessageBody('twitch', 'hey @MyName how are you', {});
  ok(mention.mentioned, 'render: mention detected');
  contains(mention.html, 'fcm-mention', 'render: mention is highlighted');
  const notMention = FCM.renderMessageBody('twitch', 'MyNameIsLong', {});
  ok(!notMention.mentioned, 'render: a longer word is not a mention');

  // Escaping: a message must never be able to inject markup.
  const xss = FCM.renderMessageBody('twitch', '<img src=x onerror=alert(1)> & "quoted"', {});
  missing(xss.html, '<img src=x', 'render: raw HTML in a message is escaped');
  contains(xss.html, '&lt;img', 'render: angle brackets escaped');
  contains(xss.html, '&amp;', 'render: ampersand escaped');

  // An emote name containing characters HTML escaping rewrites.
  FCM.setEmotes('kick', 'thirdparty', { '<3': { url: 'https://cdn/heart.png', source: '7TV' } });
  const tricky = FCM.renderMessageBody('kick', 'love <3 you', {});
  contains(tricky.html, 'alt="&lt;3"', 'render: emote alt text is escaped');
  contains(tricky.html, 'cdn/heart.png', 'render: emote with symbol name still resolves');

  // Badges.
  FCM.setBadges('twitch', {
    global: { moderator: { 1: { image_url_1x: 'https://badge/mod.png' } } },
    channel: { subscriber: { 12: { image_url_1x: 'https://badge/sub12.png' } } },
  });
  const badgeHtml = FCM.renderBadges('twitch', 'moderator/1,subscriber/12');
  contains(badgeHtml, 'badge/mod.png', 'render: global badge image');
  contains(badgeHtml, 'badge/sub12.png', 'render: channel badge overrides global set');
  eq(FCM.renderBadges('twitch', 'mystery/9'), '',
    'render: a decorative badge set with no image is dropped, not shown raw');
  contains(FCM.renderBadges('twitch', 'moderator/9'), 'MOD',
    'render: a role badge with no image falls back to a short label');

  const kickBadges = FCM.renderBadges('kick', [{ type: 'moderator' }, { type: 'og' }]);
  contains(kickBadges, 'MOD', 'render: kick moderator label');
  contains(kickBadges, 'OG', 'render: kick unknown-type label is derived');

  // System rows get a platform label out of the text.
  eq(FCM.formatSystemMessage('Kick: disconnected').type, 'error', 'render: disconnect is an error row');
  eq(FCM.formatSystemMessage('Kick: disconnected').label, 'Kick', 'render: platform label extracted');
  eq(FCM.formatSystemMessage('[Merged] Watching Twitch/xqc').label, 'Merged', 'render: bracket label');
  eq(FCM.formatSystemMessage('Loaded 60 Twitch history messages').type, 'history', 'render: history row');

  // System and event rows carry the same SYSTEM / EVENT tag the desktop app
  // shows, which is what keeps them from reading like a viewer's message.
  const sysRow = FCM.buildSysEl('Kick: disconnected');
  contains(sysRow.innerHTML, 'fcm-sys-tag">SYSTEM<', 'render: system rows are tagged SYSTEM');
  contains(sysRow.innerHTML, 'fcm-sys-error">Kick<', 'render: system row label chip');
  contains(sysRow.innerHTML, 'fcm-sys-body">disconnected<', 'render: prefix is stripped from the body');
  eq(sysRow.className, 'fcm-sys fcm-sys-error', 'render: error rows get the error class');

  const eventRow = FCM.buildEventEl('twitch', 'Someone subscribed.', new Set(['twitch']));
  contains(eventRow.innerHTML, 'fcm-sys-tag">EVENT<', 'render: event rows are tagged EVENT');
  contains(eventRow.innerHTML, 'fcm-sys-twitch">Twitch<', 'render: event row names its platform');
  eq(eventRow.dataset.platform, 'twitch', 'render: event rows are filterable by platform');

  // The role chip is a fallback only, so a Kick row never reads "SUBSUBname".
  const kickRow = FCM.buildMessageEl({
    platform: 'kick', author: 'someone', text: 'hi',
    badgesRaw: [{ type: 'subscriber' }], badgeClass: 'sub',
  }, new Set(['kick']));
  eq((kickRow.innerHTML.match(/SUB/g) || []).length, 1, 'render: role is labelled exactly once');
  contains(kickRow.innerHTML, 'data-name="someone"', 'render: author carries its own name for the menu');

  const twitchRow = FCM.buildMessageEl({
    platform: 'twitch', author: 'mod', text: 'hi',
    badgesRaw: 'moderator/1', badgeClass: 'mod',
  }, new Set(['twitch']));
  contains(twitchRow.innerHTML, 'badge/mod.png', 'render: twitch badge image used');
  missing(twitchRow.innerHTML, 'fcm-chip-mod', 'render: no duplicate chip beside a badge image');

  // Timestamps and badges are always in the markup; the toggles hide them with
  // CSS so switching one off applies to messages already on screen.
  const withTime = FCM.buildMessageEl({
    platform: 'twitch', author: 'someone', text: 'hi',
    badgesRaw: 'moderator/1', timestamp: 1700000000000,
  }, new Set(['twitch']));
  contains(withTime.innerHTML, 'fcm-time', 'render: the timestamp is always built');
  contains(withTime.innerHTML, 'fcm-badges', 'render: badges are always built');

  FCM.setViewSettings({ ...FCM.DEFAULT_SETTINGS, timestamps: false, showBadges: false });
  const hidden = FCM.buildMessageEl({
    platform: 'twitch', author: 'someone', text: 'hi',
    badgesRaw: 'moderator/1', timestamp: 1700000000000,
  }, new Set(['twitch']));
  contains(hidden.innerHTML, 'fcm-time',
    'render: hiding timestamps is a CSS concern, not a build-time one');
  contains(hidden.innerHTML, 'fcm-badges',
    'render: hiding badges is a CSS concern, not a build-time one');
  FCM.setViewSettings({ ...FCM.DEFAULT_SETTINGS, highlightNames: 'MyName' });

  // Chatters seen in the feed become @mention candidates.
  ok(FCM.recentChatters().some((c) => c.name === 'someone' && c.platform === 'kick'),
    'render: authors are remembered for @ autocomplete');
  ok(FCM.recentChatters().some((c) => c.name === 'mod' && c.platform === 'twitch'),
    'render: both platforms contribute chatters');

  // ── Name colours are made readable without being taken away ────────────────
  //
  // Twitch and Kick both let people choose their own name colour, and plenty
  // choose one that lands near 2:1 against a dark feed. The colour is theirs, so
  // only its lightness moves, and only as far as it has to.
  (function authorColours() {
    const BACKDROP = { dark: [13, 13, 15], light: [245, 247, 251] };
    const srgb = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const parts = (value) => {
      const style = FCM.authorColorStyle(value);
      const d = /--author-dark:(#[0-9a-f]{6})/.exec(style);
      const l = /--author-light:(#[0-9a-f]{6})/.exec(style);
      return { style, dark: d && d[1], light: l && l[1] };
    };
    // Hue is what makes a name recognisable, so it is what must survive.
    const hueOf = ([r, g, b]) => {
      const max = Math.max(r, g, b); const min = Math.min(r, g, b);
      if (max === min) return null;
      const d = max - min;
      let h;
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
      return Math.round(h * 360);
    };

    eq(FCM.authorColorStyle(''), '', 'render: no name colour means no inline style');
    eq(FCM.authorColorStyle('red'), '', 'render: a colour that is not a hex triple is ignored');
    eq(FCM.authorColorStyle('#12345'), '', 'render: a malformed hex is ignored');

    // Every colour a platform might hand over, readable on both themes.
    ['#0000FF', '#8A2BE2', '#FF0000', '#1E90FF', '#00FF7F', '#FFFFFF', '#000000',
      '#B22222', '#DAA520', '#2E8B57', '#4B0082', '#556B2F'].forEach((c) => {
      const p = parts(c);
      ok(ratio(rgbOf(p.dark), BACKDROP.dark) >= 4.5,
        `render: ${c} is readable on the dark feed (${ratio(rgbOf(p.dark), BACKDROP.dark).toFixed(2)})`);
      ok(ratio(rgbOf(p.light), BACKDROP.light) >= 4.5,
        `render: ${c} is readable on the light feed (${ratio(rgbOf(p.light), BACKDROP.light).toFixed(2)})`);
      const original = hueOf(rgbOf(c.toLowerCase()));
      if (original !== null) {
        // Within a couple of degrees: the round trip through HSL and back to
        // whole bytes moves a hue by one now and then, which no one can see.
        const drift = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
        ok(drift(hueOf(rgbOf(p.dark)), original) <= 2,
          `render: ${c} keeps its hue on dark (${hueOf(rgbOf(p.dark))} vs ${original})`);
        ok(drift(hueOf(rgbOf(p.light)), original) <= 2,
          `render: ${c} keeps its hue on light (${hueOf(rgbOf(p.light))} vs ${original})`);
      }
    });

    // A colour that already reads well is left exactly as it was given.
    eq(parts('#1E90FF').dark, '#1e90ff', 'render: a readable colour is not touched');
    eq(parts('#B22222').light, '#b22222', 'render: nor on the theme where it already works');

    // And the extremes, which have no hue to preserve, still come back legible.
    ok(parts('#000000').dark !== '#000000', 'render: black is lifted off a dark feed');
    ok(parts('#FFFFFF').light !== '#ffffff', 'render: white is dropped onto a light feed');
  })();
};

suites.settings = function () {
  // Two toggles flipped in quick succession must both survive: the second save
  // has to see the first one's result, not the state from before it.
  const store = {};
  const sandbox = makeSandbox({
    chrome: {
      storage: {
        sync: {
          get: async (key) => {
            // A real storage round-trip is not instantaneous, which is exactly
            // what lets an unserialised read-modify-write lose an update.
            await new Promise((r) => setTimeout(r, 5));
            return { [key]: store[key] };
          },
          set: async (obj) => {
            await new Promise((r) => setTimeout(r, 5));
            Object.assign(store, obj);
          },
        },
      },
    },
  });
  const FCM = load(sandbox, ...SHARED);

  return (async () => {
    const [a, b] = await Promise.all([
      FCM.saveSettings({ showBadges: false }),
      FCM.saveSettings({ timestamps: false }),
    ]);
    const saved = await FCM.loadSettings();
    eq(saved.showBadges, false, 'settings: the first concurrent change survives');
    eq(saved.timestamps, false, 'settings: the second concurrent change survives');
    eq(b.showBadges, false, 'settings: the later save saw the earlier one');
    ok(a && b, 'settings: both saves resolve');

    // Untouched defaults are preserved rather than dropped by a partial patch.
    eq(saved.maxMessages, FCM.DEFAULT_SETTINGS.maxMessages,
      'settings: a partial patch keeps the other values');

    await FCM.saveSettings({ showBadges: true });
    eq((await FCM.loadSettings()).showBadges, true, 'settings: values can be turned back on');
    eq((await FCM.loadSettings()).timestamps, false,
      'settings: turning one back on leaves the other alone');
  })();
};

suites.compose = function () {
  const sandbox = makeSandbox({
    chrome: { storage: { sync: { get: async () => ({}) } } },
    document: { ...stubDocument(), querySelector: () => null },
  });
  const FCM = load(sandbox, ...SHARED, 'src/content/render.js', 'src/content/compose.js');
  FCM.setViewSettings(FCM.DEFAULT_SETTINGS);

  FCM.setEmotes('twitch', 'native', { Kappa: { url: 'https://t/kappa.png', source: 'Twitch' } });
  FCM.setEmotes('twitch', 'thirdparty', {
    PogU: { url: 'https://7tv/pogu.webp', source: '7TV' },
    // Same name in a second store: the first one wins, and it appears once.
    Kappa: { url: 'https://7tv/kappa.webp', source: '7TV' },
  });
  FCM.setEmotes('kick', 'native', { emojiKEK: { url: 'https://k/kek.png', source: 'Kick Global' } });

  const entries = FCM.allEmoteEntries();
  const names = entries.map((e) => e.name);
  eq(names.filter((n) => n === 'Kappa').length, 1, 'compose: duplicate emote names are de-duplicated');
  eq(entries.find((e) => e.name === 'Kappa').source, 'Twitch',
    'compose: the native store wins over third-party for the same name');
  ok(names.includes('PogU'), 'compose: third-party emotes are offered');
  ok(names.includes('emojiKEK'), 'compose: emotes from both platforms are offered');
  ok(entries.every((e) => e.url), 'compose: every offered emote has an image');

  // The picker groups by source, so every entry needs one.
  ok(entries.every((e) => e.source), 'compose: every emote reports a source for grouping');

  FCM.rememberChatter('twitch', 'Alice');
  FCM.rememberChatter('kick', 'alice');
  FCM.rememberChatter('twitch', 'Alice');
  const alices = FCM.recentChatters().filter((c) => c.name.toLowerCase() === 'alice');
  eq(alices.length, 2, 'compose: the same name on two platforms is two chatters');
};

// A reply has to land in the chat the person actually spoke in. The routing
// itself lives in the overlay, but it is driven entirely by the platform that
// compose.js reports, so that is what gets pinned down here.
suites.reply = function () {
  function fakeEl(tag = 'div') {
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {}, style: {}, innerHTML: '', textContent: '',
      value: '', selectionStart: 0, placeholder: '',
      clientHeight: 400, offsetHeight: 40,
      appendChild(c) { this.children.push(c); return c; },
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      focus() {}, remove() {}, closest() { return null; },
      setSelectionRange(a) { this.selectionStart = a; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 240, height: 120 }; },
    };
    const classes = new Set();
    node.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, f) => (f ? classes.add(c) : classes.delete(c)),
    };
    Object.defineProperty(node, 'className', {
      get: () => [...classes].join(' '),
      set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    });
    return node;
  }

  const sandbox = makeSandbox({
    chrome: { storage: { sync: { get: async () => ({}) } } },
    document: { createElement: (t) => fakeEl(t) },
    window: { getSelection: () => null },
  });
  const FCM = load(sandbox, ...SHARED, 'src/content/render.js', 'src/content/compose.js');
  FCM.setViewSettings(FCM.DEFAULT_SETTINGS);
  FCM.setEmotes('twitch', 'thirdparty', { PogU: { url: 'https://7tv/pogu.webp', source: '7TV' } });

  const replies = [];
  const inputEl = fakeEl('input');
  const compose = FCM.createCompose({
    panel: fakeEl(), inputEl, feedEl: fakeEl(), emoteBtn: fakeEl('button'),
    toast: () => {},
    onReplyTo: (platform, name) => replies.push({ platform, name }),
  });

  // 1. Replying from the username menu reports the platform that person is on.
  compose.insertMention('KickViewer', 'kick');
  eq(replies.pop(), { platform: 'kick', name: 'KickViewer' },
    'reply: the menu reply names the platform the person spoke on');
  eq(inputEl.value, '@KickViewer ', 'reply: the mention is inserted');

  compose.insertMention('TwitchViewer', 'twitch');
  eq(replies.pop(), { platform: 'twitch', name: 'TwitchViewer' },
    'reply: the other direction reports Twitch');
  eq(inputEl.value, '@KickViewer @TwitchViewer ',
    'reply: a second reply is appended, so both people are addressed');

  // 2. Completing a @name from the suggestion list scopes it the same way.
  FCM.rememberChatter('kick', 'kekwenjoyer');
  inputEl.value = '@kekw';
  inputEl.selectionStart = 5;
  replies.length = 0;
  const tab = { key: 'Tab', preventDefault() {} };
  // The input handler is wired to the real element, so drive it directly.
  compose.updateAutocomplete();
  ok(compose.isPopupOpen(), 'reply: the mention list opens for @kekw');
  ok(compose.handleKey(tab), 'reply: Tab completes from the mention list');
  eq(inputEl.value, '@kekwenjoyer ', 'reply: Tab inserted the full name');
  eq(replies.pop(), { platform: 'kick', name: 'kekwenjoyer' },
    'reply: an autocompleted mention scopes the send to that person\'s platform');

  // 3. Completing an emote is not addressing anyone, so it must not scope.
  inputEl.value = ':pog';
  inputEl.selectionStart = 4;
  replies.length = 0;
  compose.updateAutocomplete();
  ok(compose.isPopupOpen(), 'reply: the emote list opens for :pog');
  compose.handleKey(tab);
  eq(inputEl.value, 'PogU ', 'reply: Tab inserted the emote');
  eq(replies.length, 0, 'reply: completing an emote does not scope the send');

  // 4. A mention with no platform (typed by hand, never completed) cannot be
  //    attributed, so it leaves the targets alone.
  replies.length = 0;
  compose.insertMention('SomeoneTypedByHand');
  eq(replies.length, 0, 'reply: an unattributed mention does not scope the send');
};

// The OAuth flow redirects through the platforms' own login pages, which the
// content script matches. Mounting a chat overlay on top of a sign-in form is
// never right, so those paths must not read as channels.
suites.authpages = function () {
  const FCM = load(makeSandbox(), ...SHARED, 'src/background/discovery.js');

  const twitchNonChannels = [
    'login', 'signup', 'logout', 'oauth2', 'authorize', 'connect', 'activate',
    'settings', 'directory', 'dashboard', 'checkout', 'subscribe',
  ];
  twitchNonChannels.forEach((path) => {
    ok(FCM.TWITCH_RESERVED.has(path), `authpages: twitch.tv/${path} is not treated as a channel`);
    eq(FCM.slugFromUrl(`https://www.twitch.tv/${path}`, 'twitch'), null,
      `authpages: twitch.tv/${path} yields no counterpart candidate`);
  });

  const kickNonChannels = ['login', 'signup', 'logout', 'oauth', 'authorize', 'account', 'verify'];
  kickNonChannels.forEach((path) => {
    ok(FCM.KICK_RESERVED.has(path), `authpages: kick.com/${path} is not treated as a channel`);
    eq(FCM.slugFromUrl(`https://kick.com/${path}`, 'kick'), null,
      `authpages: kick.com/${path} yields no counterpart candidate`);
  });

  // Real channels must still work — the guard must not be over-broad.
  ['somechannel', 'xqc', 'a_streamer', 'logan'].forEach((name) => {
    ok(!FCM.TWITCH_RESERVED.has(name), `authpages: twitch.tv/${name} is still a channel`);
    eq(FCM.slugFromUrl(`https://www.twitch.tv/${name}`, 'twitch'), name,
      `authpages: twitch.tv/${name} still resolves`);
  });

  // Names that merely start with a reserved word are not reserved.
  ['loginbob', 'connorlogin', 'signupguy'].forEach((name) => {
    ok(!FCM.TWITCH_RESERVED.has(name), `authpages: ${name} is a channel, not a reserved page`);
  });

  // And the per-site URL parsers agree.
  ['twitch', 'kick'].forEach((id) => {
    const sandbox = makeSandbox({
      location: { hostname: id === 'twitch' ? 'www.twitch.tv' : 'kick.com', pathname: '/' },
      document: { querySelector: () => null, querySelectorAll: () => [] },
      window: {},
    });
    const S = load(sandbox, ...SHARED, 'src/content/sites.js');
    ['/login', '/signup', '/oauth2/authorize'].forEach((path) => {
      sandbox.location.pathname = path;
      eq(S.SITES[id].channelFromUrl(), null, `authpages: ${id}${path} mounts nothing`);
    });
    sandbox.location.pathname = '/realchannel';
    eq(S.SITES[id].channelFromUrl(), 'realchannel', `authpages: ${id} still finds a real channel`);
  });
};

suites.sites = function () {
  const FCM = load(makeSandbox(), ...SHARED, 'src/background/discovery.js');

  eq(FCM.slugFromUrl('https://kick.com/xqc', 'kick'), 'xqc', 'sites: kick url');
  eq(FCM.slugFromUrl('https://www.kick.com/Some-User/', 'kick'), 'some-user', 'sites: kick url is lowercased');
  eq(FCM.slugFromUrl('https://www.twitch.tv/xqc?tt_medium=x', 'twitch'), 'xqc', 'sites: twitch url with query');
  eq(FCM.slugFromUrl('https://twitch.tv/directory/game/Chess', 'twitch'), null, 'sites: reserved path rejected');
  eq(FCM.slugFromUrl('https://kick.com/browse', 'kick'), null, 'sites: kick reserved path rejected');
  eq(FCM.slugFromUrl('https://example.com/xqc', 'kick'), null, 'sites: wrong host rejected');
  eq(FCM.slugFromUrl('https://kick.com/', 'kick'), null, 'sites: bare host rejected');
  eq(FCM.slugFromUrl('not a url', 'kick'), null, 'sites: garbage rejected');
  eq(FCM.slugFromUrl('https://kick.com/a', 'kick'), null, 'sites: one-character slug rejected');

  // The URL parsers used by the content script.
  ['twitch', 'kick'].forEach((id) => {
    const cases = id === 'twitch'
      ? [
        ['/xqc', 'xqc'],
        ['/xqc/videos', 'xqc'],
        ['/popout/xqc/chat', 'xqc'],
        ['/moderator/xqc', 'xqc'],
        ['/directory/following', null],
        ['/settings/profile', null],
        ['/', null],
      ]
      : [
        ['/xqc', 'xqc'],
        ['/some-user', 'some-user'],
        ['/browse', null],
        ['/category/irl', null],
        ['/', null],
      ];

    const sandbox = makeSandbox({
      location: { hostname: id === 'twitch' ? 'www.twitch.tv' : 'kick.com', pathname: '/' },
      document: { querySelector: () => null, querySelectorAll: () => [] },
      window: {},
    });
    const S = load(sandbox, ...SHARED, 'src/content/sites.js');
    cases.forEach(([pathname, expected]) => {
      sandbox.location.pathname = pathname;
      eq(S.SITES[id].channelFromUrl(), expected, `sites: ${id} ${pathname}`);
    });
  });
};

suites.discovery = function () {
  // Stubs standing in for the two platform APIs and chrome.storage.local.
  function build({ kickChannels = {}, twitchUsers = {}, storage = {} } = {}) {
    const store = { ...storage };
    const calls = [];

    const sandbox = makeSandbox({
      chrome: {
        storage: {
          local: {
            get: async (key) => ({ [key]: store[key] }),
            set: async (obj) => { Object.assign(store, obj); },
          },
        },
      },
      fetch: async (url, init) => {
        calls.push(String(url));
        if (String(url).includes('gql.twitch.tv')) {
          const body = JSON.parse(init.body);
          const login = Array.isArray(body)
            ? body[0].variables.channelLogin
            : body.variables.l;
          const query = Array.isArray(body) ? '' : String(body.query || '');
          const data = { user: twitchUsers[login] || null };
          // The badge query asks for a different shape from the same endpoint.
          if (query.includes('broadcastBadges')) {
            data.user = {
              broadcastBadges: [
                { setID: 'subscriber', version: '12', title: '1-Year Sub', imageURL: 'https://cdn/sub12.png' },
              ],
            };
          }
          if (query.includes('badges{')) {
            data.badges = [
              { setID: 'moderator', version: '1', title: 'Moderator', imageURL: 'https://cdn/mod.png' },
              { setID: 'subscriber', version: '0', title: 'Sub', imageURL: 'https://cdn/sub0.png' },
            ];
          }
          return { ok: true, json: async () => ({ data }) };
        }
        const m = String(url).match(/kick\.com\/api\/v\d\/channels\/([^/?]+)/);
        if (m) {
          const data = kickChannels[m[1]];
          return data
            ? { ok: true, json: async () => data }
            : { ok: false, status: 404, json: async () => ({}) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });
    return { FCM: load(sandbox, ...SHARED, 'src/background/discovery.js'), store, calls };
  }

  // Mirrors the real kick.com/api/v2/channels/<slug> shape. The response
  // carries its own canonical slug, which is what summarize() reports back.
  function kickChannel(slug, displayName, live) {
    return {
      id: 668, user_id: 676, slug,
      chatroom: { id: 668 },
      livestream: live
        ? { session_title: 'juicer time', viewer_count: 12345, categories: [{ name: 'Just Chatting' }] }
        : null,
      user: { username: displayName, profile_pic: 'https://kick/pic.png' },
    };
  }

  const KICK_XQC = kickChannel('xqc', 'xQc', true);

  return (async () => {
    // 1. Same name on both platforms, live on the other side.
    {
      const { FCM } = build({ kickChannels: { xqc: KICK_XQC } });
      const found = await FCM.resolveCounterpart({ platform: 'twitch', channel: 'xqc', hints: [] });
      ok(found, 'discovery: same-name counterpart found');
      eq(found.platform, 'kick', 'discovery: counterpart platform');
      eq(found.channel, 'xqc', 'discovery: counterpart channel');
      eq(found.live, true, 'discovery: counterpart is live');
      eq(found.viewers, 12345, 'discovery: viewer count carried through');
      eq(found.category, 'Just Chatting', 'discovery: category carried through');
      eq(found.displayName, 'xQc', 'discovery: display name from the user object');
      eq(found.match, 'same-name', 'discovery: match reason');
    }

    // 2. A different name, discovered from a link on the channel page.
    {
      const { FCM } = build({
        kickChannels: { therealstreamer: kickChannel('therealstreamer', 'TheRealStreamer', false) },
      });
      const found = await FCM.resolveCounterpart({
        platform: 'twitch',
        channel: 'streamerguy',
        hints: ['https://kick.com/therealstreamer', 'https://kick.com/browse'],
      });
      ok(found, 'discovery: page-link counterpart found');
      eq(found.channel, 'therealstreamer', 'discovery: slug taken from the page link');
      eq(found.match, 'page-link', 'discovery: match reason is the page link');
      eq(found.live, false, 'discovery: offline counterpart reported as offline');
    }

    // 3. Nothing on the other platform.
    {
      const { FCM, store } = build({});
      const found = await FCM.resolveCounterpart({ platform: 'twitch', channel: 'nobody', hints: [] });
      eq(found, null, 'discovery: no counterpart returns null');
      const links = store[FCM.STORAGE_KEYS.links];
      eq(links['twitch:nobody'].none, true, 'discovery: the miss is cached so it is not re-probed');
    }

    // 4. Kick -> Twitch, the other direction.
    {
      const { FCM } = build({
        twitchUsers: {
          bigstreamer: {
            id: '1', login: 'bigstreamer', displayName: 'BigStreamer',
            profileImageURL: 'https://twitch/pic.png',
            stream: { id: '9', viewersCount: 40857, title: 'big stream', game: { name: 'Counter-Strike' } },
          },
        },
      });
      const found = await FCM.resolveCounterpart({ platform: 'kick', channel: 'bigstreamer', hints: [] });
      ok(found, 'discovery: kick -> twitch counterpart found');
      eq(found.platform, 'twitch', 'discovery: reverse direction platform');
      eq(found.live, true, 'discovery: reverse direction live state');
      eq(found.category, 'Counter-Strike', 'discovery: reverse direction category');
      eq(found.url, 'https://www.twitch.tv/bigstreamer', 'discovery: reverse direction url');
    }

    // 5. A manual mapping beats both the page link and the same-name guess.
    {
      const { FCM } = build({
        kickChannels: { chosen: kickChannel('chosen', 'Chosen', false), xqc: KICK_XQC },
        storage: {
          fcm_channel_links_v1: {
            'twitch:xqc': { channel: 'chosen', match: 'manual', manual: true, at: Date.now() },
          },
        },
      });
      const found = await FCM.resolveCounterpart({
        platform: 'twitch', channel: 'xqc', hints: ['https://kick.com/xqc'],
      });
      eq(found.channel, 'chosen', 'discovery: manual mapping wins');
      eq(found.match, 'manual', 'discovery: manual match reason');
    }

    // 6. A manual "no counterpart" mapping suppresses the lookup entirely.
    {
      const { FCM, calls } = build({
        kickChannels: { xqc: KICK_XQC },
        storage: {
          fcm_channel_links_v1: {
            'twitch:xqc': { none: true, manual: true, at: Date.now() },
          },
        },
      });
      const found = await FCM.resolveCounterpart({ platform: 'twitch', channel: 'xqc', hints: [] });
      eq(found, null, 'discovery: manual opt-out returns null');
      eq(calls.length, 0, 'discovery: manual opt-out makes no network calls');
    }

    // 7. Reserved paths in the hints never become candidates.
    {
      const { FCM } = build({ kickChannels: { settings: KICK_XQC } });
      const found = await FCM.resolveCounterpart({
        platform: 'twitch', channel: 'someone', hints: ['https://kick.com/settings'],
      });
      eq(found, null, 'discovery: a reserved-path hint is ignored');
    }

    // 8. Badges come from GQL, and the global set is fetched only once.
    {
      const { FCM, calls } = build({});
      const first = await FCM.twitchApi.badges('somechannel');
      eq(first.global.moderator['1'].image_url_1x, 'https://cdn/mod.png', 'badges: global badge mapped');
      eq(first.channel.subscriber['12'].image_url_1x, 'https://cdn/sub12.png', 'badges: channel badge mapped');
      eq(first.global.subscriber['0'].title, 'Sub', 'badges: title carried through');

      const second = await FCM.twitchApi.badges('another');
      eq(second.global.moderator['1'].image_url_1x, 'https://cdn/mod.png', 'badges: global set reused');
      eq(second.channel.subscriber['12'].image_url_1x, 'https://cdn/sub12.png', 'badges: second channel set');
      eq(calls.length, 2, 'badges: one request per channel, not one per badge set');
    }
  })();
};

suites.emotes = function () {
  function build() {
    const calls = [];
    const sandbox = makeSandbox({
      fetch: async (url) => {
        calls.push(String(url));
        const u = String(url);
        if (u === 'https://7tv.io/v3/emote-sets/global') {
          return { ok: true, json: async () => ({
            emotes: [{ name: 'GlobalPog', data: { host: { url: '//cdn.7tv.app/emote/1', files: [{ name: '2x.webp' }] } } }],
          }) };
        }
        if (/7tv\.io\/v3\/users\//.test(u)) {
          return { ok: true, json: async () => ({
            emote_set: { emotes: [{ name: 'ChannelPog', data: { host: { url: '//cdn.7tv.app/emote/2', files: [{ name: '2x.webp' }] } } }] },
          }) };
        }
        if (u.includes('betterttv.net/3/cached/emotes/global')) {
          return { ok: true, json: async () => ([{ code: 'bttvGlobal', id: 'b1' }]) };
        }
        if (u.includes('betterttv.net/3/cached/users/twitch/')) {
          return { ok: true, json: async () => ({ channelEmotes: [{ code: 'bttvChan', id: 'b2' }], sharedEmotes: [] }) };
        }
        if (u.includes('frankerfacez.com')) {
          return { ok: true, json: async () => ({
            sets: { 1: { emoticons: [{ name: 'ffzEmote', urls: { 2: '//cdn.ffz/2.png' } }] } },
          }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });
    return { FCM: load(sandbox, ...SHARED, 'src/background/emotes.js'), calls };
  }

  return (async () => {
    {
      const { FCM, calls } = build();
      const store = await FCM.emoteLoader.thirdParty('twitch', 'somechannel', '71092938');
      eq(store.GlobalPog.url, 'https://cdn.7tv.app/emote/1/2x.webp', 'emotes: 7TV global url built from host+file');
      eq(store.GlobalPog.source, '7TV', 'emotes: 7TV source label');
      eq(store.ChannelPog.url, 'https://cdn.7tv.app/emote/2/2x.webp', 'emotes: 7TV channel set');
      eq(store.bttvGlobal.url, 'https://cdn.betterttv.net/emote/b1/2x', 'emotes: BTTV global');
      eq(store.bttvChan.url, 'https://cdn.betterttv.net/emote/b2/2x', 'emotes: BTTV channel');
      eq(store.ffzEmote.url, 'https://cdn.ffz/2.png', 'emotes: FFZ protocol-relative url fixed up');
      ok(calls.includes('https://7tv.io/v3/users/twitch/71092938'),
        'emotes: 7TV twitch lookup uses the numeric user id');
    }

    {
      // 7TV's Kick integration 404s on a slug, so it must get the numeric id.
      const { FCM, calls } = build();
      const store = await FCM.emoteLoader.thirdParty('kick', 'xqc', '676');
      ok(calls.includes('https://7tv.io/v3/users/kick/676'),
        'emotes: 7TV kick lookup uses the numeric user id, not the slug');
      ok(!calls.some((c) => c.includes('/users/kick/xqc')),
        'emotes: the kick slug is never used as a 7TV key');
      ok(!calls.some((c) => c.includes('betterttv') || c.includes('frankerfacez')),
        'emotes: BTTV and FFZ are skipped for Kick (they are Twitch-keyed)');
      eq(store.ChannelPog.source, '7TV', 'emotes: kick channel 7TV set loaded');
    }

    {
      // A provider that fails must not take the others down with it.
      const sandbox = makeSandbox({
        fetch: async (url) => {
          if (String(url).includes('7tv.io/v3/emote-sets/global')) throw new Error('network down');
          if (String(url).includes('betterttv.net/3/cached/emotes/global')) {
            return { ok: true, json: async () => ([{ code: 'survivor', id: 'x1' }]) };
          }
          return { ok: false, status: 500, json: async () => ({}) };
        },
      });
      const FCM = load(sandbox, ...SHARED, 'src/background/emotes.js');
      const store = await FCM.emoteLoader.thirdParty('twitch', 'chan', '1');
      eq(store.survivor.url, 'https://cdn.betterttv.net/emote/x1/2x',
        'emotes: a failing provider does not block the rest');
    }
  })();
};

suites.theme = function () {
  // Builds a page whose <html> carries the given marks and whose chat sits
  // inside a container painted the given colour.
  function pageWith({ htmlClass = '', htmlAttrs = {}, bodyClass = '', chain = [] }) {
    const styles = new Map();
    const make = (bg) => {
      const el = { parentElement: null, className: '', dataset: {}, getAttribute: () => null };
      styles.set(el, { backgroundColor: bg });
      return el;
    };
    const nodes = chain.map(make);
    nodes.forEach((el, i) => { el.parentElement = nodes[i + 1] || null; });

    const body = make('rgba(0, 0, 0, 0)');
    body.className = bodyClass;
    if (nodes.length) nodes[nodes.length - 1].parentElement = body;

    const root = {
      className: htmlClass,
      dataset: htmlAttrs.dataset || {},
      getAttribute: (k) => htmlAttrs[k] || null,
      parentElement: null,
    };
    styles.set(root, { backgroundColor: 'rgba(0, 0, 0, 0)' });
    body.parentElement = root;

    return {
      sandbox: {
        document: { documentElement: root, body },
        getComputedStyle: (el) => styles.get(el) || { backgroundColor: '' },
        window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
      },
      chat: nodes[0] || body,
    };
  }

  function detect(spec) {
    const page = pageWith(spec);
    const sandbox = makeSandbox({
      ...page.sandbox,
      MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    });
    sandbox.window.matchMedia = page.sandbox.window.matchMedia;
    const FCM = load(sandbox, ...SHARED, 'src/content/sites.js');
    return FCM.detectSiteTheme(page.chat);
  }

  // Twitch marks the root element; Kick uses a Tailwind-style class.
  eq(detect({ htmlClass: 'tw-root--theme-dark' }), 'dark', 'theme: Twitch dark class');
  eq(detect({ htmlClass: 'tw-root--theme-light' }), 'light', 'theme: Twitch light class');
  eq(detect({ htmlAttrs: { 'data-a-theme': 'dark' } }), 'dark', 'theme: Twitch theme attribute');
  eq(detect({ htmlClass: 'dark' }), 'dark', 'theme: Kick dark class');
  eq(detect({ htmlClass: 'light' }), 'light', 'theme: Kick light class');
  eq(detect({ htmlAttrs: { dataset: { theme: 'light' } } }), 'light', 'theme: data-theme attribute');

  // With no marks at all, what the page is actually painted decides it. This
  // is what keeps working when either site renames its classes.
  eq(detect({ chain: ['rgb(24, 24, 27)'] }), 'dark', 'theme: a dark background reads as dark');
  eq(detect({ chain: ['rgb(255, 255, 255)'] }), 'light', 'theme: a white background reads as light');
  eq(detect({ chain: ['rgb(240, 240, 245)'] }), 'light', 'theme: an off-white background reads as light');
  eq(detect({ chain: ['rgb(14, 14, 16)'] }), 'dark', 'theme: near-black reads as dark');

  // A transparent element paints nothing, so the search continues upward.
  eq(detect({ chain: ['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'] }), 'light',
    'theme: a transparent child defers to the first painted ancestor');
  eq(detect({ chain: ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgb(20, 20, 20)'] }), 'dark',
    'theme: it keeps climbing past every transparent layer');

  // A class name that merely contains the word must not win.
  eq(detect({ htmlClass: 'darkroom-player', chain: ['rgb(255, 255, 255)'] }), 'light',
    'theme: "darkroom" is not a dark-mode marker');
  eq(detect({ htmlClass: 'has-light-sidebar', chain: ['rgb(255,255,255)'] }), 'light',
    'theme: hyphenated markers still resolve sensibly');
};

suites.native = function () {
  // A fake page just detailed enough for the region code: boxes, parents and
  // children. Every rect is [top, height]; width and left are fixed, because
  // nothing here turns on them beyond "is this a real element".
  function el({ rect = [0, 0], text = '', attrs = {}, kids = [] } = {}) {
    const node = {
      children: [],
      parentElement: null,
      style: {},
      textContent: text,
      // Real nodes carry this, and both the card cache and the cheap menu check
      // read it to tell "still in the page" from "swapped out by a re-render".
      isConnected: true,
      nodeType: 1,
      events: [],
      dispatchEvent(e) { node.events.push(e.type); return true; },
      clicks: 0,
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      // Only ever asked for the media that proves a card has something in it.
      querySelector(sel) {
        return node.query && sel.split(',').some((s) => s.trim() === node.query)
          ? node.children[0] || null
          : null;
      },
      getBoundingClientRect() {
        const [top, height] = this.rect;
        return { top, height, bottom: top + height, left: 900, right: 1240, width: 340 };
      },
      click() { this.clicks++; },
    };
    node.rect = rect;
    kids.forEach((k) => { k.parentElement = node; node.children.push(k); });
    return node;
  }

  function page(root, dialogs = []) {
    const body = el({ rect: [0, 900], kids: [root] });
    const html = el({ rect: [0, 900], kids: [body] });
    return {
      body,
      document: {
        body,
        documentElement: html,
        querySelectorAll: () => dialogs,
      },
      window: {},
      getComputedStyle: (node) => ({ position: node.position || 'static' }),
    };
  }

  function bridgeFor(doc, site) {
    const { body, ...rest } = doc;
    function FakeEvent(type) { this.type = type; }
    const sandbox = makeSandbox({
      ...rest,
      window: { ...(rest.window || {}), MouseEvent: FakeEvent, PointerEvent: FakeEvent },
    });
    const FCM = load(sandbox, ...SHARED, 'src/content/native.js');
    return { FCM, bridge: FCM.createNativeBridge(site), body };
  }

  // ── Splitting the message list's own siblings ───────────────────────────────

  // Twitch's shape: the cards sit above the list, the composer below it, and an
  // absolutely-positioned viewer-card layer covers the lot. The list itself is
  // three wrappers deep, so the search has to climb to reach the level where
  // the siblings that matter actually live.
  const card = el({ rect: [262, 69] });
  const spacer = el({ rect: [331, 0] });
  const container = el({ rect: [331, 40] });
  const scroller = el({ rect: [331, 141], kids: [container] });
  const listWrap = el({ rect: [331, 141], kids: [scroller] });
  const notifications = el({ rect: [262, 0] });
  const input = el({ rect: [472, 191] });
  const viewerCard = el({ rect: [262, 401] });
  const content = el({
    rect: [262, 401],
    kids: [card, spacer, listWrap, notifications, input, viewerCard],
  });

  const tw = bridgeFor(page(content), {});
  const split = tw.FCM.splitChatSiblings(container);

  eq(split.above.length, 1, 'native: one card above the message list');
  ok(split.above[0] === card, 'native: the card above is the highlight stack');
  eq(split.below.length, 1, 'native: one element below the message list');
  ok(split.below[0] === input, 'native: the element below is the composer');

  // Everything the split deliberately leaves out.
  ok(!split.above.includes(spacer), 'native: a zero-height sibling is not a card');
  ok(!split.below.includes(notifications), 'native: an empty notifications slot is not a bar');
  ok(!split.above.includes(viewerCard) && !split.below.includes(viewerCard),
    'native: a layer overlapping the messages is neither above nor below');

  // Kick's shape: nothing qualifies at the list's own level, and the footer is
  // one further up.
  const kickPin = el({ rect: [110, 0] });
  const kickMessages = el({ rect: [110, 496] });
  const kickOverlay = el({ rect: [110, 12] });
  const kickWrap = el({ rect: [110, 496], kids: [kickOverlay, kickMessages] });
  const kickFooter = el({ rect: [606, 114] });
  const kickCol = el({ rect: [60, 660], kids: [kickPin, kickWrap, kickFooter] });
  const kickSplit = bridgeFor(page(kickCol), {}).FCM.splitChatSiblings(kickMessages);
  eq(kickSplit.above.length, 0, 'native: an empty pinned slot leaves nothing above');
  ok(kickSplit.below[0] === kickFooter, 'native: the climb reaches the footer a level up');

  // The same page once a pinned message arrives.
  kickPin.rect = [110, 54];
  kickWrap.rect = [164, 442];
  kickMessages.rect = [164, 442];
  kickOverlay.rect = [164, 12];
  const kickPinned = bridgeFor(page(kickCol), {}).FCM.splitChatSiblings(kickMessages);
  ok(kickPinned.above[0] === kickPin, 'native: a pinned message is found once it has height');

  // ── Kick's other card slot: a banner drawn over the top of the messages ────
  //
  // Kick does not push the chat down for a pinned message; it floats one over
  // the message list. That is still a card the overlay must not cover, and it
  // has to be told apart from the full-height layers both sites park there.
  {
    const list = el({ rect: [110, 496] });
    const banner = el({ rect: [110, 82], text: 'Pinned by moderator' });
    const emptySlot = el({ rect: [110, 12] });
    const bottomPill = el({ rect: [590, 30], text: 'scroll to bottom' });
    const fullLayer = el({ rect: [110, 496], text: 'viewer card' });
    const wrap = el({ rect: [110, 496], kids: [banner, emptySlot, bottomPill, fullLayer, list] });
    el({ rect: [60, 660], kids: [wrap] });

    const split = bridgeFor(page(wrap), {}).FCM.splitChatSiblings(list);
    eq(split.above.length, 1, 'native: exactly one banner is counted over the messages');
    ok(split.above[0] === banner, 'native: and it is the one with a pinned message in it');
    ok(!split.above.includes(emptySlot),
      'native: an empty slot at the top is padding, not a card');
    ok(!split.above.includes(fullLayer),
      'native: a layer covering the whole list is not a banner');
    ok(!split.above.includes(bottomPill),
      'native: something floating at the bottom is not a banner either');
  }

  // The guards on that, one at a time.
  {
    const build = (spec) => {
      const list = el({ rect: [110, 496] });
      const cand = el(spec);
      const wrap = el({ rect: [110, 496], kids: [cand, list] });
      el({ rect: [60, 660], kids: [wrap] });
      return { split: bridgeFor(page(wrap), {}).FCM.splitChatSiblings(list), cand };
    };
    let r = build({ rect: [110, 82], text: 'Pinned by moderator' });
    ok(r.split.above[0] === r.cand, 'native: a banner hugging the top counts');

    r = build({ rect: [110, 82] });
    eq(r.split.above.length, 0, 'native: a banner with nothing in it does not');

    r = build({ rect: [110, 14], text: 'x' });
    eq(r.split.above.length, 0, 'native: nor one too short to be a card');

    r = build({ rect: [180, 82], text: 'Pinned' });
    eq(r.split.above.length, 0, 'native: nor one floating away from the top');

    r = build({ rect: [110, 300], text: 'covers half the list' });
    eq(r.split.above.length, 0, 'native: nor one swallowing half the messages');

    // Content can be an image rather than text — a card is still a card.
    const list = el({ rect: [110, 496] });
    const withImg = el({ rect: [110, 82] });
    const img = el({ rect: [112, 60] });
    img.tagName = 'IMG';
    withImg.children.push(img); img.parentElement = withImg;
    withImg.query = 'img';
    const wrap = el({ rect: [110, 496], kids: [withImg, list] });
    el({ rect: [60, 660], kids: [wrap] });
    ok(bridgeFor(page(wrap), {}).FCM.splitChatSiblings(list).above[0] === withImg,
      'native: a banner whose content is an image counts too');
  }

  // A message list with no siblings anywhere around it.
  const lonely = el({ rect: [100, 300] });
  const lonelyWrap = el({ rect: [100, 300], kids: [lonely] });
  const lonelySplit = bridgeFor(page(lonelyWrap), {}).FCM.splitChatSiblings(lonely);
  eq(lonelySplit.above.length, 0, 'native: nothing above means nothing to reveal');
  eq(lonelySplit.below.length, 0, 'native: nothing below either');

  // ── The card block as one box ───────────────────────────────────────────────

  const second = el({ rect: [200, 62] });
  const stacked = el({ rect: [200, 500], kids: [card, second, listWrap, input] });
  const stackedBridge = bridgeFor(page(stacked), { messageList: () => container }).bridge;
  const cards = stackedBridge.cards();
  eq(cards.top, 200, 'native: the card block starts at the topmost card');
  eq(cards.bottom, 331, 'native: and ends at the lowest');
  eq(cards.height, 131, 'native: which is the strip to leave to the site');
  eq(cards.elements.length, 2, 'native: both cards are kept, to be shown through');

  ok(bridgeFor(page(lonelyWrap), { messageList: () => lonely }).bridge.cards() === null,
    'native: no cards means no inset');
  ok(bridgeFor(page(content), { messageList: () => null }).bridge.cards() === null,
    'native: a chat whose message list cannot be found asks for nothing');

  // ── Balances ────────────────────────────────────────────────────────────────

  const FCM = bridgeFor(page(content), {}).FCM;
  const read = (spec) => FCM.readNativeBalance(el(spec));
  eq(read({ text: '12,480' }), '12,480', 'native: a plain balance is taken as it is');
  eq(read({ text: '12.4K' }), '12.4K', 'native: an abbreviated balance survives');
  eq(read({ text: ' 350 ' }), '350', 'native: surrounding whitespace is dropped');
  eq(read({ text: 'Kicks 350' }), '350', 'native: a number inside a label is found');
  eq(read({ text: '', attrs: { 'aria-label': 'Channel Points Balance: 1,234' } }), '1,234',
    'native: the accessible name is read when the node has no text of its own');
  eq(read({ text: 'Bits and Points Balances' }), '',
    'native: a control with no number reports no balance');
  eq(FCM.readNativeBalance(null), '', 'native: a missing control reports no balance');

  // ── Driving the site's own controls ─────────────────────────────────────────

  function controlPage({ claim = true } = {}) {
    const points = el({ rect: [620, 32], text: '4,201' });
    const bits = el({ rect: [620, 32], text: '350' });
    const open = el({ rect: [620, 32], attrs: { 'aria-label': 'Bits and Points Balances' } });
    const cheer = el({ rect: [580, 32], attrs: { 'aria-label': 'Cheer' } });
    const chest = el({ rect: claim ? [620, 32] : [0, 0] });
    const body = el({ rect: [262, 401] });
    const site = {
      messageList: () => container,
      nativeChatBody: () => body,
      nativeControls: () => ({
        pointsValue: points, bitsValue: bits, openBalances: open, cheer, claim: chest,
      }),
    };
    return { site, points, bits, open, cheer, chest, body };
  }

  const withClaim = controlPage();
  const cb = bridgeFor(page(content), withClaim.site).bridge;
  eq(cb.stats(), { points: '4,201', bits: '350', hasPoints: true, hasBits: true, canClaim: true, hasMenu: true },
    'native: both balances and a waiting bonus are reported');

  ok(cb.activate('points'), 'native: the rewards control is there to click');
  eq(withClaim.open.clicks, 1, 'native: and the click goes to the site’s own button');
  // Radix, which Kick builds with, opens on pointerdown rather than on click.
  // A bare click() is why its Kicks button did nothing at all.
  eq(withClaim.open.events, ['pointerdown', 'mousedown', 'pointerup', 'mouseup'],
    'native: a control is pressed the way a mouse presses it, not just clicked');
  ok(cb.activate('bits'), 'native: the cheer control is there to click');
  eq(withClaim.cheer.clicks, 1, 'native: and that click goes to the cheer button');
  ok(cb.activate('claim'), 'native: the bonus is there to claim');
  eq(withClaim.chest.clicks, 1, 'native: and that click goes to the chest');

  const noClaim = controlPage({ claim: false });
  const nb = bridgeFor(page(content), noClaim.site).bridge;
  eq(nb.stats().canClaim, false, 'native: an unrendered chest is no bonus');
  ok(!nb.activate('claim'), 'native: and claiming it is refused rather than sent nowhere');
  eq(noClaim.chest.clicks, 0, 'native: a control that is not on screen is never clicked');

  const bare = bridgeFor(page(content), { messageList: () => container }).bridge;
  eq(bare.stats(), { points: '', bits: '', hasPoints: false, hasBits: false, canClaim: false, hasMenu: false },
    'native: a site with no controls of its own reports nothing');
  ok(!bare.activate('points'), 'native: and offers nothing to click');

  // A site adapter that throws must not take the overlay down with it.
  const angry = bridgeFor(page(content), {
    messageList: () => container,
    nativeControls: () => { throw new Error('selectors moved'); },
  }).bridge;
  eq(angry.stats(), { points: '', bits: '', hasPoints: false, hasBits: false, canClaim: false, hasMenu: false },
    'native: a throwing adapter reads as no controls');

  // Kick's Kicks button is labelled "Get KICKs" and shows no balance. A control
  // with nothing to count is still a control, and reporting the two separately
  // is what keeps it on the row.
  {
    const wordy = el({ rect: [620, 32], text: 'Get KICKs' });
    const numeric = el({ rect: [620, 32], text: '4.6K' });
    const rig = bridgeFor(page(content, []), {
      messageList: () => container,
      nativeControls: () => ({ pointsValue: numeric, bitsValue: wordy, openBalances: numeric, cheer: wordy, claim: null }),
    }).bridge;
    const st = rig.stats();
    eq(st.points, '4.6K', 'native: a control showing a balance reports it');
    eq(st.bits, '', 'native: one showing only words reports no balance');
    eq(st.hasBits, true, 'native: but is still reported as being there');
    eq(st.hasPoints, true, 'native: as is the other');
  }

  // ── Hiding the site's chat without hiding its cards ─────────────────────────

  const vis = controlPage();
  const visBridge = bridgeFor(page(stacked), { ...vis.site, messageList: () => container }).bridge;

  const block = visBridge.cards().elements;
  visBridge.setNativeHidden(true, block);
  eq(vis.body.style.visibility, 'hidden', 'native: the site’s own chat is hidden');
  eq(card.style.visibility, 'visible', 'native: but its cards are forced back into view');
  eq(second.style.visibility, 'visible', 'native: every card in the block, not only the first');

  visBridge.setNativeHidden(true, []);
  eq(vis.body.style.visibility, 'hidden', 'native: the chat stays hidden with the reveal off');
  eq(card.style.visibility, '', 'native: and the cards go back to being hidden with it');

  // A card the site swapped out is released and the new one takes over, which
  // is what keeps a hype train that starts mid-stream from staying hidden.
  visBridge.setNativeHidden(true, block);
  visBridge.setNativeHidden(true, [second]);
  eq(card.style.visibility, '', 'native: a card no longer in the block stops being forced');
  eq(second.style.visibility, 'visible', 'native: and the one still there stays forced');

  visBridge.setNativeHidden(true, block);
  visBridge.setNativeHidden(false, block);
  eq(vis.body.style.visibility, '', 'native: showing the chat again clears the override');
  eq(card.style.visibility, '', 'native: and the cards stop being forced');

  visBridge.setNativeHidden(true, block);
  visBridge.release();
  eq(vis.body.style.visibility, '', 'native: release puts the chat back');
  eq(card.style.visibility, '', 'native: and every card it touched');

  // ── Standing aside for the site's own menus ─────────────────────────────────

  const box = { left: 900, right: 1240, top: 260, bottom: 660 };
  const furniture = el({ rect: [200, 400] });
  const menu = el({ rect: [300, 300] });
  const tooltip = el({ rect: [300, 20] });
  const elsewhere = el({ rect: [1000, 300] });

  // Anything already on screen when the overlay mounts is the page's own
  // furniture. Treating it as a menu would leave the panel invisible for good.
  const seeded = bridgeFor(page(content, [furniture]), {}).bridge;
  ok(seeded.dialogOver(box) === null, 'native: a popup present at mount never triggers a peek');

  const menus = [];
  const watcher = bridgeFor(page(content, menus), {}).bridge;
  ok(watcher.dialogOver(box) === null, 'native: nothing open, nothing to stand aside for');

  menus.push(tooltip);
  ok(watcher.dialogOver(box) === null, 'native: a tooltip-sized popup is not worth hiding for');

  menus.push(elsewhere);
  ok(watcher.dialogOver(box) === null, 'native: a menu that misses the panel is left alone');

  menus.push(menu);
  ok(watcher.dialogOver(box) === menu, 'native: a menu over the panel is found');
  ok(watcher.dialogOver(null) === null, 'native: a closed panel covers nothing');

  menus.length = 0;
  ok(watcher.dialogOver(box) === null, 'native: closing the menu ends the peek');

  // ── A menu the site gives no role to, and reuses ──────────────────────────
  //
  // Twitch names its rewards panel `role="dialog"`. Kick names nothing and
  // portals a Radix dialog to the end of <body> — a full-screen backdrop plus a
  // panel centred on the window, so only the backdrop overlaps the chat column
  // at all. And Radix leaves a closed dialog mounted and reuses it, so "was it
  // just added" is a question that can only be answered once. What is asked
  // instead is whether it just *opened*.
  {
    // A backdrop the page keeps mounted and toggles, the way Radix does.
    const backdrop = el({ rect: [0, 720] });
    backdrop.position = 'fixed';
    backdrop.rect = [0, 0];                     // mounted but closed
    const doc = page(content, []);
    doc.body.children.push(backdrop);
    backdrop.parentElement = doc.body;
    const rig = bridgeFor(doc, {});
    const b = rig.bridge;

    ok(b.dialogOver(box) === null, 'native: a closed backdrop is not a menu');

    b.expectMenu();
    backdrop.rect = [0, 720];                   // opened
    ok(b.dialogOver(box) === backdrop,
      'native: an unlabelled backdrop that just opened is found');
    eq(b.dialogStillOpen(), true, 'native: and is then tracked the cheap way');

    backdrop.rect = [0, 0];                     // closed again, still mounted
    eq(b.dialogStillOpen(), false, 'native: closing it ends the peek');

    // The reuse that broke this: the same element opening a second time.
    b.expectMenu();
    backdrop.rect = [0, 720];
    ok(b.dialogOver(box) === backdrop,
      'native: the same element opening again is found again');
  }

  // Something already on screen is the page's own furniture, not a menu.
  {
    const standing = el({ rect: [0, 720] });
    standing.position = 'fixed';
    const doc = page(content, []);
    doc.body.children.push(standing);
    standing.parentElement = doc.body;
    const rig = bridgeFor(doc, {});
    ok(rig.bridge.dialogOver(box) === null,
      'native: a layer that was already open when the overlay mounted is ignored');
    rig.bridge.expectMenu();
    ok(rig.bridge.dialogOver(box) === null, 'native: and stays ignored while it stays open');
  }

  // Everything a portalled candidate still has to clear.
  {
    const reject = (label, rect, position) => {
      const node = el({ rect: [0, 0] });
      node.position = position;
      const doc = page(content, []);
      doc.body.children.push(node);
      node.parentElement = doc.body;
      const rig = bridgeFor(doc, {});
      rig.bridge.expectMenu();
      node.rect = rect;
      ok(rig.bridge.dialogOver(box) === null, `native: ${label}`);
    };
    reject('a body child in normal flow is not a menu', [0, 720], 'static');
    reject('a popup too small to be a menu is not one', [300, 30], 'fixed');
    reject('a menu that misses the panel is not one', [1000, 300], 'fixed');
  }

  // The cheap check used while a menu is open, which is what keeps the tick off
  // a document-wide query for as long as one is up.
  const live = [];
  const cheap = bridgeFor(page(content, live), {}).bridge;
  eq(cheap.dialogStillOpen(), false, 'native: nothing open, nothing to stay aside for');

  const openMenu = el({ rect: [300, 300] });
  openMenu.parentElement = content;
  live.push(openMenu);
  ok(cheap.dialogOver(box) === openMenu, 'native: the menu is found by the full scan');
  eq(cheap.dialogStillOpen(), true, 'native: and the cheap check agrees it is still up');

  openMenu.rect = [300, 10];
  eq(cheap.dialogStillOpen(), false, 'native: a menu collapsed to nothing counts as closed');
  eq(cheap.dialogStillOpen(), false, 'native: and stays closed once let go of');

  // A menu the site removes outright, which is the usual way one closes.
  const removed = el({ rect: [300, 300] });
  live.length = 0;
  live.push(removed);
  ok(cheap.dialogOver(box) === removed, 'native: the replacement menu is found');
  removed.isConnected = false;
  eq(cheap.dialogStillOpen(), false, 'native: a menu taken out of the page counts as closed');
};

suites.auth = function () {
  function build({ redirect, launchError, tokenResponse, configResponse } = {}) {
    const store = {};
    const calls = [];
    const sandbox = makeSandbox({
      chrome: {
        identity: {
          getRedirectURL: () => 'https://abcd.chromiumapp.org/',
          launchWebAuthFlow: (opts, cb) => {
            calls.push({ authUrl: opts.url, interactive: opts.interactive });
            if (launchError) { sandbox.chrome.runtime.lastError = { message: launchError }; cb(); return; }
            cb(typeof redirect === 'function' ? redirect(opts.url) : redirect);
          },
        },
        runtime: { lastError: null },
        tabs: {
          onUpdated: { addListener: (fn) => { sandbox.__onUpdated = fn; }, removeListener: () => {} },
          onRemoved: { addListener: () => {}, removeListener: () => {} },
          remove: () => {},
          get: () => {},
          create: (opts, cb) => {
            calls.push({ tabUrl: opts.url });
            cb({ id: 7 });
            // Stand in for the browser reaching the redirect: nothing is
            // listening there, but the tab's URL still changes to it.
            const back = typeof redirect === 'function' ? redirect(opts.url) : redirect;
            setTimeout(() => sandbox.__onUpdated(7, { url: back }, { id: 7, url: back }), 0);
          },
        },
        storage: {
          local: {
            get: async (k) => ({ [k]: store[k] }),
            set: async (o) => { Object.assign(store, o); },
          },
          sync: { get: async () => ({}), set: async () => {} },
        },
      },
      crypto: {
        getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = i; return a; },
        subtle: { digest: async () => new Uint8Array(32).buffer },
      },
      btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      TextEncoder,
      fetch: async (url, init) => {
        const u = String(url);
        calls.push({ url: u, method: (init && init.method) || 'GET', body: init && init.body });
        if (u.includes('/oauth2/validate')) {
          return { ok: true, json: async () => ({ user_id: '55', login: 'me', scopes: ['chat:edit'], expires_in: 3600 }) };
        }
        if (u.includes('/kick-config')) {
          return { ok: true, json: async () => (configResponse || { client_id: 'kick-cid' }) };
        }
        if (u.includes('/kick-token') || u.includes('/kick-refresh')) {
          const body = tokenResponse || { access_token: 'KA', refresh_token: 'KR', expires_in: 3600 };
          return { ok: !body.error, json: async () => body };
        }
        if (u.includes('/users')) {
          return { ok: true, json: async () => ({ data: [{ name: 'kickme', user_id: 7 }] }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });
    const FCM = load(sandbox, ...SHARED, 'src/background/auth.js');
    return { FCM, store, calls, sandbox };
  }

  return (async () => {
    const FCM_SHARED = 'http://localhost:8080/friendly-chat.html';

    // ── Twitch implicit grant ──
    {
      const { FCM, store, calls } = build({
        redirect: (url) => {
          const state = new URL(url).searchParams.get('state');
          return 'https://abcd.chromiumapp.org/#access_token=TW&state=' + state;
        },
      });
      const result = await FCM.auth.connect('twitch', {});
      eq(result.login, 'me', 'auth: twitch reports who signed in');

      const authUrl = new URL(calls[0].authUrl);
      eq(authUrl.searchParams.get('response_type'), 'token', 'auth: twitch uses the implicit grant');
      eq(authUrl.searchParams.get('redirect_uri'), 'https://abcd.chromiumapp.org/',
        'auth: the extension redirect is what gets registered');
      ok(authUrl.searchParams.get('scope').includes('moderator:manage:banned_users'),
        'auth: moderation scope is requested, or the mod tools could never appear');
      ok(authUrl.searchParams.get('scope').includes('user:write:chat'),
        'auth: sending scope is requested');
      ok(authUrl.searchParams.get('state'), 'auth: a state value is sent');

      const saved = store[FCM.STORAGE_KEYS.auth].twitch;
      eq(saved.accessToken, 'TW', 'auth: the token is stored');
      eq(saved.userId, '55', 'auth: the account id is stored for sending');
      ok(saved.expiresAt > Date.now(), 'auth: an expiry is recorded');

      const summary = await FCM.auth.summary();
      eq(summary.twitch.connected, true, 'auth: the summary reports connected');
      eq(summary.twitch.token, undefined, 'auth: the summary never carries the token itself');
    }

    // ── A mismatched state must be refused ──
    {
      const { FCM } = build({ redirect: 'https://abcd.chromiumapp.org/#access_token=TW&state=wrong' });
      let threw = '';
      try { await FCM.auth.connect('twitch', {}); } catch (e) { threw = e.message; }
      contains(threw, 'did not match', 'auth: a forged or stale response is rejected');
    }

    // ── The provider refusing is reported, not swallowed ──
    {
      const { FCM } = build({ redirect: 'https://abcd.chromiumapp.org/#error=access_denied' });
      let threw = '';
      try { await FCM.auth.connect('twitch', {}); } catch (e) { threw = e.message; }
      contains(threw, 'access_denied', 'auth: a refusal surfaces its reason');
    }

    // ── A closed sign-in window is reported ──
    {
      const { FCM } = build({ redirect: undefined });
      let threw = '';
      try { await FCM.auth.connect('twitch', {}); } catch (e) { threw = e.message; }
      contains(threw, 'closed', 'auth: closing the window is explained');
    }

    // ── Kick PKCE ──
    {
      const { FCM, store, calls } = build({
        redirect: (url) => {
          const state = new URL(url).searchParams.get('state');
          return 'https://abcd.chromiumapp.org/?code=CODE&state=' + state;
        },
      });
      await FCM.auth.connect('kick', { kickRedirect: 'extension' });

      const authCall = calls.find((c) => c.authUrl);
      const authUrl = new URL(authCall.authUrl);
      eq(authUrl.searchParams.get('response_type'), 'code', 'auth: kick uses the code flow');
      eq(authUrl.searchParams.get('code_challenge_method'), 'S256', 'auth: with PKCE');
      ok(authUrl.searchParams.get('code_challenge'), 'auth: a challenge is sent');
      ok(authUrl.searchParams.get('scope').includes('moderation:ban'),
        'auth: kick moderation scope is requested');

      const exchange = calls.find((c) => c.url && c.url.includes('/kick-token'));
      ok(exchange, 'auth: the code is exchanged through the proxy, never in the browser');
      const sent = JSON.parse(exchange.body);
      eq(sent.code, 'CODE', 'auth: the code is passed on');
      ok(sent.code_verifier, 'auth: the verifier is passed on');
      eq(sent.redirect_uri, 'https://abcd.chromiumapp.org/', 'auth: the redirect must match');

      const saved = store[FCM.STORAGE_KEYS.auth].kick;
      eq(saved.accessToken, 'KA', 'auth: kick token stored');
      eq(saved.refreshToken, 'KR', 'auth: kick refresh token stored');
      eq(saved.login, 'kickme', 'auth: the kick account is named');
    }

    // ── The proxy is asked first, and it wins ──
    {
      const { FCM, calls } = build({
        configResponse: { client_id: 'proxy-says-this-one' },
        redirect: (url) => 'https://abcd.chromiumapp.org/?code=CODE&state='
          + new URL(url).searchParams.get('state'),
      });
      await FCM.auth.connect('kick', { kickRedirect: 'extension' });
      const authCall = calls.find((c) => c.authUrl);
      eq(new URL(authCall.authUrl).searchParams.get('client_id'), 'proxy-says-this-one',
        'auth: the proxy decides which Kick application is used');
    }

    // ── No client id is kept in the extension, so the proxy is required ──
    {
      const { FCM, calls } = build({
        configResponse: {},
        redirect: (url) => 'https://abcd.chromiumapp.org/?code=CODE&state='
          + new URL(url).searchParams.get('state'),
      });
      let threw = '';
      try {
        await FCM.auth.connect('kick', { kickRedirect: 'extension' });
      } catch (e) { threw = e.message; }
      contains(threw, 'proxy', 'auth: an unreachable proxy is named as the problem');
      // Failing here is the point. Guessing at a client id would send the user
      // through the whole consent flow only to fail at the exchange, which
      // also runs through the proxy.
      ok(!calls.some((c) => c.authUrl), 'auth: and no sign-in is started at all');

      eq(FCM.DEFAULT_KICK_CLIENT_ID, undefined,
        'auth: the extension keeps no copy of the Kick client id');
    }

    // ── The default: reuse the redirect the desktop app already registered ──
    {
      const { FCM, calls } = build({
        redirect: (url) => FCM_SHARED + '?code=CODE&state='
          + encodeURIComponent(new URL(url).searchParams.get('state')),
      });
      await FCM.auth.connect('kick', {});
      const opened = calls.find((c) => c.tabUrl);
      ok(opened, 'kickshared: sign-in opens a tab, since chrome.identity cannot end on localhost');
      const authUrl = new URL(opened.tabUrl);
      eq(authUrl.searchParams.get('redirect_uri'), FCM_SHARED,
        "kickshared: Kick is told to use the desktop app's already-registered URL");
      eq(authUrl.searchParams.get('code_challenge_method'), 'S256', 'kickshared: still PKCE');

      const exchange = JSON.parse(calls.find((c) => c.url && c.url.includes('/kick-token')).body);
      eq(exchange.redirect_uri, FCM_SHARED,
        'kickshared: the exchange repeats it, as Kick requires');
      ok(exchange.code_verifier, 'kickshared: the verifier goes to the worker, never the secret');

      const summary = await FCM.auth.summary();
      eq(summary.kick.connected, true, 'kickshared: the account ends up connected');
    }

    // ── Straight back to the extension: one hop, id-specific URL ──
    {
      const { FCM, calls } = build({
        redirect: (url) => 'https://abcd.chromiumapp.org/?code=CODE&state='
          + encodeURIComponent(new URL(url).searchParams.get('state')),
      });
      await FCM.auth.connect('kick', { kickRedirect: 'extension' });
      const authUrl = new URL(calls.find((c) => c.authUrl).authUrl);
      eq(authUrl.searchParams.get('redirect_uri'), 'https://abcd.chromiumapp.org/',
        'kickredirect: the extension is the redirect by default');
      ok(!authUrl.searchParams.get('state').includes('~'),
        'kickredirect: no forwarding target is needed in state');
      const exchange = JSON.parse(calls.find((c) => c.url && c.url.includes('/kick-token')).body);
      eq(exchange.redirect_uri, 'https://abcd.chromiumapp.org/',
        'kickredirect: the exchange repeats the same redirect, as Kick requires');
    }

    // ── Via the worker: one fixed URL registered with Kick, forever ──
    {
      const { FCM, calls } = build({
        redirect: (url) => 'https://abcd.chromiumapp.org/?code=CODE&state='
          + encodeURIComponent(new URL(url).searchParams.get('state')),
      });
      await FCM.auth.connect('kick', {
        kickRedirect: 'proxy',
        kickProxyUrl: 'https://proxy.example',
      });
      const authUrl = new URL(calls.find((c) => c.authUrl).authUrl);
      eq(authUrl.searchParams.get('redirect_uri'), 'https://proxy.example/kick-callback',
        'kickredirect: Kick is told to return to the worker');

      // The worker learns where to forward from state, so it has to be in there.
      const state = authUrl.searchParams.get('state');
      ok(state.includes('~'), 'kickredirect: state carries the forwarding target');
      const encoded = state.slice(state.indexOf('~') + 1);
      const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64').toString();
      eq(decoded, 'https://abcd.chromiumapp.org/',
        'kickredirect: and it decodes back to the extension');
      ok(/^https:\/\/[a-z]+\.chromiumapp\.org\/?$/.test(decoded),
        'kickredirect: the target is a chromiumapp.org URL, which is all the worker will forward to');

      const exchange = JSON.parse(calls.find((c) => c.url && c.url.includes('/kick-token')).body);
      eq(exchange.redirect_uri, 'https://proxy.example/kick-callback',
        'kickredirect: the exchange uses the worker URL too, or Kick rejects it');
    }

    // ── The worker's hint about what to fix is passed on ──
    {
      const { FCM } = build({
        redirect: (url) => 'https://abcd.chromiumapp.org/?code=CODE&state='
          + encodeURIComponent(new URL(url).searchParams.get('state')),
        tokenResponse: { error: 'invalid_request', hint: 'redirect_uri did not match' },
      });
      let threw = '';
      try { await FCM.auth.connect('kick', { kickRedirect: 'extension' }); } catch (e) { threw = e.message; }
      contains(threw, 'invalid_request', 'kickredirect: the failure names what Kick said');
      contains(threw, 'redirect_uri did not match',
        "kickredirect: and carries the worker's hint about what to fix");
    }

    // ── usable(): a live token passes straight through ──
    {
      const { FCM } = build({});
      await FCM.auth.set('twitch', { accessToken: 'T', expiresAt: Date.now() + 600000 });
      const rec = await FCM.auth.usable('twitch', {});
      eq(rec.accessToken, 'T', 'auth: a live token is handed back');
    }

    // ── usable(): an expired Twitch token cannot be refreshed, so it is dropped ──
    {
      const { FCM } = build({});
      await FCM.auth.set('twitch', { accessToken: 'T', expiresAt: Date.now() - 1000 });
      const rec = await FCM.auth.usable('twitch', {});
      eq(rec, null, 'auth: an expired implicit token is discarded');
      eq((await FCM.auth.summary()).twitch.connected, false,
        'auth: and the UI stops claiming a connection');
    }

    // ── usable(): an expiring Kick token refreshes silently ──
    {
      const { FCM } = build({ tokenResponse: { access_token: 'KA2', refresh_token: 'KR2', expires_in: 3600 } });
      await FCM.auth.set('kick', { accessToken: 'old', refreshToken: 'KR', expiresAt: Date.now() - 1000 });
      const rec = await FCM.auth.usable('kick', {});
      eq(rec.accessToken, 'KA2', 'auth: kick refreshes rather than logging the user out');
      eq(rec.refreshToken, 'KR2', 'auth: the rotated refresh token is kept');
    }

    // ── usable(): a refresh that fails logs out cleanly ──
    {
      const { FCM } = build({ tokenResponse: { error: 'invalid_grant' } });
      await FCM.auth.set('kick', { accessToken: 'old', refreshToken: 'KR', expiresAt: Date.now() - 1000 });
      eq(await FCM.auth.usable('kick', {}), null, 'auth: an unrefreshable token is cleared');
    }

    // ── A token with no expiry at all is treated as live ──
    {
      const { FCM } = build({});
      await FCM.auth.set('twitch', { accessToken: 'T', expiresAt: 0 });
      ok(await FCM.auth.usable('twitch', {}), 'auth: a token with no stated expiry still works');
    }

    // ── Failures are explained in terms of what to do about them ──
    {
      const { FCM } = build({});
      const tw = FCM.explainAuthFailure('twitch', 'Authorization page could not be loaded.');
      eq(tw.needsRedirectSetup, true,
        'auth: Twitch refusing to render the page is read as an unregistered redirect');
      contains(tw.message, 'redirect URL', 'auth: and the message says so plainly');
      contains(tw.redirectUri, '.chromiumapp.org/',
        'auth: the exact URL to register comes with it');

      contains(tw.message, 'redirect_mismatch',
        'auth: the message names the symptom the user would actually have seen');

      const kick = FCM.explainAuthFailure('kick', 'invalid redirect uri');
      eq(kick.needsRedirectSetup, true, 'auth: Kick naming the redirect is read the same way');
      contains(kick.message, 'Kick', 'auth: and names the platform');

      const cancelled = FCM.explainAuthFailure('twitch', 'The sign-in window was closed before it finished.');
      eq(cancelled.needsRedirectSetup, false, 'auth: a cancelled sign-in is not a setup problem');
      contains(cancelled.message, 'cancelled', 'auth: and says it was cancelled');

      const other = FCM.explainAuthFailure('twitch', 'something else entirely');
      eq(other.needsRedirectSetup, false, 'auth: an unrecognised failure is not blamed on the redirect');
      contains(other.message, 'something else entirely', 'auth: but still reports what happened');
    }

    // ── Disconnecting removes only that platform ──
    {
      const { FCM } = build({});
      await FCM.auth.set('twitch', { accessToken: 'T' });
      await FCM.auth.set('kick', { accessToken: 'K' });
      await FCM.auth.clear('twitch');
      const summary = await FCM.auth.summary();
      eq(summary.twitch.connected, false, 'auth: the disconnected platform is gone');
      eq(summary.kick.connected, true, 'auth: the other platform is untouched');
    }
  })();
};

suites.send = function () {
  function build(responder) {
    const calls = [];
    const cleared = [];
    const sandbox = makeSandbox({
      chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } },
      fetch: async (url, init) => {
        calls.push({ url: String(url), method: init.method, body: init.body, headers: init.headers });
        return responder ? responder(String(url), init) : { ok: true, json: async () => ({}) };
      },
    });
    const FCM = load(sandbox, ...SHARED, 'src/background/send.js');
    FCM.auth = {
      usable: async (p) => ({
        accessToken: p === 'twitch' ? 'TW' : 'KK',
        clientId: 'cid',
        userId: p === 'twitch' ? '55' : '66',
      }),
      clear: async (p) => { cleared.push(p); },
    };
    return { FCM, calls, cleared };
  }

  return (async () => {
    // ── Twitch ──
    {
      const { FCM, calls } = build(() => ({ ok: true, json: async () => ({ data: [{ is_sent: true }] }) }));
      const r = await FCM.sendMessage('twitch', 'hello there', { roomId: '4242' }, {});
      eq(r.ok, true, 'send: twitch accepts');
      const call = calls[0];
      ok(call.url.endsWith('/chat/messages'), 'send: twitch uses the chat messages endpoint');
      eq(call.method, 'POST', 'send: as a POST');
      const body = JSON.parse(call.body);
      eq(body.broadcaster_id, '4242', 'send: addressed to the joined channel');
      eq(body.sender_id, '55', 'send: sent as the connected account');
      eq(body.message, 'hello there', 'send: the text is passed through unchanged');
      eq(call.headers['Client-Id'], 'cid', 'send: the client id that owns the token is used');
    }

    // Twitch accepting the request but dropping the message is not success.
    {
      const { FCM } = build(() => ({
        ok: true,
        json: async () => ({ data: [{ is_sent: false, drop_reason: { message: 'blocked term' } }] }),
      }));
      const r = await FCM.sendMessage('twitch', 'x', { roomId: '1' }, {});
      eq(r.ok, false, 'send: a dropped message is not reported as sent');
      eq(r.reason, 'dropped', 'send: and is labelled as dropped');
      contains(r.detail, 'blocked term', 'send: with the reason Twitch gave');
    }

    // A dead token is cleared so the UI stops offering it.
    {
      const { FCM, cleared } = build(() => ({ ok: false, status: 401, json: async () => ({}) }));
      const r = await FCM.sendMessage('twitch', 'x', { roomId: '1' }, {});
      eq(r.reason, 'expired', 'send: a 401 is reported as an expired sign-in');
      eq(cleared, ['twitch'], 'send: and the dead token is discarded');
    }

    // A refusal carries the platform's own words.
    {
      const { FCM } = build(() => ({ ok: false, status: 400, json: async () => ({ message: 'slow mode' }) }));
      const r = await FCM.sendMessage('twitch', 'x', { roomId: '1' }, {});
      eq(r.reason, 'rejected', 'send: a refusal is reported');
      contains(r.detail, 'slow mode', 'send: with the platform message');
    }

    // The network being down is its own case.
    {
      const sandbox = makeSandbox({
        chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } },
        fetch: async () => { throw new Error('offline'); },
      });
      const FCM = load(sandbox, ...SHARED, 'src/background/send.js');
      FCM.auth = { usable: async () => ({ accessToken: 'T', clientId: 'c', userId: '1' }), clear: async () => {} };
      const r = await FCM.sendMessage('twitch', 'x', { roomId: '1' }, {});
      eq(r.reason, 'network', 'send: a network failure is distinguished from a refusal');
    }

    // ── Kick ──
    {
      const { FCM, calls } = build(() => ({ ok: true, json: async () => ({ data: { is_sent: true } }) }));
      const r = await FCM.sendMessage('kick', 'hey', { roomId: '77' }, {});
      eq(r.ok, true, 'send: kick accepts');
      const body = JSON.parse(calls[0].body);
      eq(body.type, 'user', 'send: kick messages are sent as the user');
      eq(body.content, 'hey', 'send: the text is passed through');
      eq(body.broadcaster_user_id, 77, 'send: kick wants the broadcaster id as a number');
    }

    // ── Guards ──
    {
      const { FCM, calls } = build();
      eq((await FCM.sendMessage('twitch', 'x', { roomId: null }, {})).reason, 'no-channel',
        'send: nothing is sent without a joined channel');
      eq(calls.length, 0, 'send: and no request is made');
      eq((await FCM.sendMessage('youtube', 'x', { roomId: '1' }, {})).reason, 'unsupported',
        'send: an unknown platform is refused');
    }

    // A missing account is refused before any request.
    {
      const { FCM, calls } = build();
      FCM.auth.usable = async () => null;
      eq((await FCM.sendMessage('twitch', 'x', { roomId: '1' }, {})).reason, 'not-connected',
        'send: no account means no send');
      eq(calls.length, 0, 'send: and no request is made');
    }
  })();
};

// Everything the extension renders arrives from somewhere it does not control:
// chat text, display names, emote payloads, badge lists, API responses. This
// suite feeds each of those the shapes that break naive parsers.
suites.resilience = function () {
  const sandbox = makeSandbox({
    chrome: { storage: { sync: { get: async () => ({}) } } },
    document: stubDocument(),
  });
  const FCM = load(sandbox, ...SHARED, 'src/content/render.js');
  FCM.setViewSettings(FCM.DEFAULT_SETTINGS);

  // ── Malformed IRC must never throw ──────────────────────────────────────────
  const brokenLines = [
    '', ' ', '@', '@;;;', '@=', ':', '::', '@a=b', '@a=b :', '@a=b :nick',
    'PRIVMSG', ':nick PRIVMSG', ':nick PRIVMSG #chan',
    '@badges= :n!n@n PRIVMSG #c :',
    '@emotes=notanumber:0-4 :n!n@n PRIVMSG #c :hi',
    '@emotes=25:x-y :n!n@n PRIVMSG #c :hi',
    '@emotes=25: :n!n@n PRIVMSG #c :hi',
    '@emotes=25:5-1 :n!n@n PRIVMSG #c :hi',
    '@tmi-sent-ts=notanumber :n!n@n PRIVMSG #c :hi',
    ':tmi.twitch.tv CLEARCHAT',
    ':tmi.twitch.tv CLEARMSG #c',
    '@a=' + 'x'.repeat(5000) + ' :n!n@n PRIVMSG #c :hi',
  ];
  let threw = null;
  brokenLines.forEach((line) => {
    try {
      const parsed = FCM.parseIrcLine(line);
      FCM.parseTwitchEmoteMap(parsed.tags.emotes);
      FCM.twitchBadgeClass(parsed.tags.badges || '', parsed.tags);
      FCM.twitchUserNoticeSummary(parsed.tags, parsed.params[1] || '');
    } catch (e) {
      threw = line + ' -> ' + e.message;
    }
  });
  eq(threw, null, 'resilience: no malformed IRC line throws');

  // An out-of-order emote range must not produce a broken token stream.
  const backwards = FCM.renderMessageBody('twitch', 'hello world', {
    emoteMap: { 5: { id: '1', end: 1 } },
  });
  ok(typeof backwards.html === 'string', 'resilience: a backwards emote range still renders');

  // A range past the end of the string must not run away.
  const past = FCM.renderMessageBody('twitch', 'hi', { emoteMap: { 0: { id: '1', end: 999 } } });
  ok(typeof past.html === 'string', 'resilience: an emote range past the end terminates');

  // ── Malformed Kick payloads ────────────────────────────────────────────────
  const badEmoteSets = [
    null, undefined, 0, '', 'string', [], {}, [null], [{}], [{ emotes: null }],
    [{ emotes: [null, undefined, 0, 'x'] }],
    [{ emotes: [{ id: null, name: 'x' }, { id: 1, name: null }] }],
    { data: null }, { data: 'nope' }, { emotes: 5 },
  ];
  threw = null;
  badEmoteSets.forEach((payload) => {
    try { FCM.parseKickEmotePayload(payload); } catch (e) { threw = JSON.stringify(payload) + ' -> ' + e.message; }
  });
  eq(threw, null, 'resilience: no emote payload shape throws');

  threw = null;
  [null, undefined, 'x', 5, {}, [null], [{}], [{ name: 'x' }], [{ id: 1 }]].forEach((meta) => {
    try { FCM.normalizeKickEmoteMeta(meta); } catch (e) { threw = String(e.message); }
  });
  eq(threw, null, 'resilience: no emote metadata shape throws');

  threw = null;
  [null, undefined, 'x', 5, {}, [], [null], [{ type: null }], [{ type: {} }]].forEach((badges) => {
    try { FCM.kickBadgeClass(badges); FCM.renderBadges('kick', badges); } catch (e) { threw = String(e.message); }
  });
  eq(threw, null, 'resilience: no badge shape throws');

  threw = null;
  ['', 'x', 'a/', '/1', 'a/1/2', ',,,', 'a/1,,b/2'].forEach((tag) => {
    try { FCM.renderBadges('twitch', tag); } catch (e) { threw = tag + ' -> ' + e.message; }
  });
  eq(threw, null, 'resilience: no twitch badge tag throws');

  threw = null;
  ['App\\Events\\X', '', null, undefined, 'pusher:ping'].forEach((name) => {
    [null, undefined, {}, { user: 5 }, { recipients: 'x' }, { gifted_usernames: {} }].forEach((p) => {
      try { FCM.formatKickEventSummary(name, p); } catch (e) { threw = name + ' -> ' + e.message; }
    });
  });
  eq(threw, null, 'resilience: no kick event shape throws');

  // ── Hostile content must render as text, never as markup ───────────────────
  const attacks = [
    '<img src=x onerror=alert(1)>',
    '"><script>alert(1)</script>',
    "'><svg/onload=alert(1)>",
    '</span><span class="fcm-author">impostor',
    'javascript:alert(1)',
    '<iframe src="javascript:alert(1)">',
    '&lt;already escaped&gt;',
    ' [31m',
  ];
  // Tags the renderer is allowed to emit. Anything else in the output came
  // from the content, which is exactly what must never happen.
  const ALLOWED_TAGS = ['span', '/span', 'img', 'a', '/a', 'div', '/div', 'b', '/b'];
  function onlyExpectedTags(html) {
    const tags = String(html).match(/<\/?[a-zA-Z][^\s>]*/g) || [];
    return tags.every((t) => ALLOWED_TAGS.includes(t.slice(1).toLowerCase()));
  }

  attacks.forEach((attack) => {
    const body = FCM.renderMessageBody('twitch', attack, {});
    ok(onlyExpectedTags(body.html),
      `resilience: a hostile message body produces no unexpected element (${attack})`);
    missing(body.html, '<img src=x', 'resilience: markup in a message body is inert');
    missing(body.html, '<script', 'resilience: script tags in a body are inert');
    missing(body.html, '<svg', 'resilience: svg in a body is inert');
    missing(body.html, '<iframe', 'resilience: iframes in a body are inert');
  });

  // The same content in a display name, which lands inside an attribute.
  attacks.forEach((attack) => {
    const el = FCM.buildMessageEl({
      platform: 'twitch', author: attack, text: 'hi', badgesRaw: '', messageId: attack,
    }, new Set(['twitch']));
    // The strongest statement available without a parser: every tag in the
    // output is one the renderer itself emits. An injected element of any kind
    // would show up here.
    ok(onlyExpectedTags(el.innerHTML),
      `resilience: a hostile username produces no unexpected element (${attack})`);
    missing(el.innerHTML, '" onerror=', 'resilience: a username cannot open a new attribute');
  });

  // And in an emote name and url, which land in src/alt/title.
  FCM.setEmotes('twitch', 'thirdparty', {
    'evil"onerror="alert(1)': { url: 'https://cdn/x.png', source: '7TV' },
    safe: { url: 'https://cdn/x.png" onerror="alert(1)', source: '"><b>' },
  });
  const emoteHtml = FCM.renderMessageBody('twitch', 'evil"onerror="alert(1) safe', {});
  missing(emoteHtml.html, '"onerror="', 'resilience: an emote name cannot break out of its attribute');
  missing(emoteHtml.html, '" onerror="', 'resilience: an emote url cannot break out of its attribute');
  missing(emoteHtml.html, '"><b>', 'resilience: an emote source cannot break out of its attribute');
  contains(emoteHtml.html, '&quot;', 'resilience: quotes in emote fields are escaped');

  // A malicious badge image url lands in src.
  const badgeHtml = FCM.renderBadges('kick', [{ type: 'mod', image_url: 'x" onerror="alert(1)' }]);
  missing(badgeHtml, '" onerror="', 'resilience: a badge url cannot break out of its attribute');
  contains(badgeHtml, '&quot;', 'resilience: quotes in a badge url are escaped');

  // A link whose text is hostile.
  const linky = FCM.renderMessageBody('twitch', 'https://x.test/"><script>alert(1)</script>', {});
  missing(linky.html, '<script', 'resilience: a hostile url is escaped inside the anchor');

  // ── Size and unicode ───────────────────────────────────────────────────────
  const huge = 'a'.repeat(50000);
  const t0 = Date.now();
  const hugeBody = FCM.renderMessageBody('twitch', huge, {});
  ok(Date.now() - t0 < 500, 'resilience: a 50k-character message renders quickly');
  ok(hugeBody.html.length >= huge.length, 'resilience: and renders in full');

  const manyWords = new Array(5000).fill('word').join(' ');
  const t1 = Date.now();
  FCM.renderMessageBody('twitch', manyWords, {});
  ok(Date.now() - t1 < 500, 'resilience: a 5000-word message renders quickly');

  const unicode = [
    '\u{1F600}\u{1F1FA}\u{1F1F8}\u{1F468}‍\u{1F469}‍\u{1F467}',
    '‮reversed text‬',
    ' null ',
    'ź́́́́',
    '\uD83D',
  ];
  threw = null;
  unicode.forEach((text) => {
    try {
      FCM.renderMessageBody('twitch', text, { emoteMap: { 0: { id: '1', end: 1 } } });
      FCM.renderMessageBody('kick', text, { emotes: [] });
    } catch (e) { threw = e.message; }
  });
  eq(threw, null, 'resilience: unusual unicode does not throw');

  // Emoji before an emote must not shift it, since Twitch counts codepoints.
  const shifted = FCM.renderMessageBody('twitch', '\u{1F600}\u{1F600} Kappa', {
    emoteMap: { 3: { id: '25', end: 7 } },
  });
  contains(shifted.html, 'alt="Kappa"', 'resilience: astral emoji do not shift emote positions');

  // ── A mention pattern must not be breakable by regex metacharacters ────────
  FCM.setViewSettings({ ...FCM.DEFAULT_SETTINGS, highlightNames: 'a.b*c, (paren, [brack' });
  threw = null;
  try {
    const m = FCM.renderMessageBody('twitch', 'hello a.b*c and (paren', {});
    ok(typeof m.html === 'string', 'resilience: regex characters in a highlight name are escaped');
  } catch (e) { threw = e.message; }
  eq(threw, null, 'resilience: a hostile highlight name does not throw');
  FCM.setViewSettings(FCM.DEFAULT_SETTINGS);

  // ── System message formatting on odd input ────────────────────────────────
  threw = null;
  [null, undefined, '', '[', '[]', '[unclosed', ':', 'Twitch:', 'x'.repeat(10000)].forEach((txt) => {
    try { FCM.formatSystemMessage(txt); FCM.buildSysEl(txt); } catch (e) { threw = String(txt) + ' -> ' + e.message; }
  });
  eq(threw, null, 'resilience: no status text shape throws');

  // ── URL parsing on rubbish ────────────────────────────────────────────────
  threw = null;
  ['', 'x', '//', 'http://', 'https://[', 'kick.com', null, undefined, 123].forEach((u) => {
    try { FCM.slugFromUrl && FCM.slugFromUrl(u, 'kick'); } catch (e) { threw = String(u) + ' -> ' + e.message; }
  });
  eq(threw, null, 'resilience: no url shape throws the slug parser');
};

// The background worker facing platforms that are down, slow, or lying.
suites.errors = function () {
  const { bootWorker, wait } = require('./background.js');

  return (async () => {
    // ── Every request failing must not stop chat from connecting ──
    {
      const w = bootWorker({ fetchImpl: async () => { throw new Error('offline'); } });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'somechannel', hints: [] });
        await wait(80);
        ok(w.last('ready'), 'errors: the tab is still answered when every lookup fails');
        eq(w.last('counterpart').counterpart, null, 'errors: no counterpart is claimed');

        w.send({ cmd: 'join', platform: 'twitch', channel: 'somechannel' });
        await wait(40);
        ok(w.socketFor('irc-ws'), 'errors: chat still connects with the network flaky');
      } finally { w.teardown(); }
    }

    // ── Malformed JSON from the platforms ──
    {
      const w = bootWorker({
        fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
      });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'somechannel', hints: [] });
        await wait(80);
        ok(w.last('ready'), 'errors: unparseable responses do not wedge the worker');
      } finally { w.teardown(); }
    }

    // ── Kick returning a channel with no chatroom ──
    {
      const w = bootWorker({
        fetchImpl: async (url) => {
          if (String(url).includes('/channels/')) {
            return { ok: true, json: async () => ({ id: 1, slug: 'x' }) };
          }
          return { ok: false, status: 404, json: async () => ({}) };
        },
      });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'somechannel', hints: [] });
        await wait(60);
        w.clear();
        w.send({ cmd: 'join', platform: 'kick', channel: 'somechannel' });
        await wait(80);
        ok(w.of('sys').some((s) => /could not find|could not load/i.test(s.text)),
          'errors: a channel with no chatroom is reported, not left hanging');
        eq(w.last('status').state, 'error', 'errors: and the status says error');
      } finally { w.teardown(); }
    }

    // ── Garbage arriving on the sockets ──
    {
      const w = bootWorker();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'somechannel', hints: [] });
        await wait(60);
        w.send({ cmd: 'join', platform: 'twitch', channel: 'somechannel' });
        w.send({ cmd: 'join', platform: 'kick', channel: 'somechannel' });
        await wait(120);

        const irc = w.socketFor('irc-ws');
        const pusher = w.socketFor('pusher.com');
        pusher.push(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
        await wait(40);
        w.clear();

        let broke = null;
        try {
          ['', '\r\n', 'garbage', '@@@@', ':::', ' '].forEach((junk) => irc.push(junk));
          [
            '', 'not json', '{', '[]', 'null', '{"event":null}', '{"event":123}',
            '{"event":"App\\\\Events\\\\ChatMessageEvent"}',
            '{"event":"App\\\\Events\\\\ChatMessageEvent","data":"not json"}',
            '{"event":"App\\\\Events\\\\ChatMessageEvent","data":"{}"}',
            '{"event":"App\\\\Events\\\\ChatMessageEvent","data":"{\\"content\\":null}"}',
            '{"event":"App\\\\Events\\\\MessageDeletedEvent","data":"{}"}',
            '{"event":"App\\\\Events\\\\UserBannedEvent","data":"{}"}',
          ].forEach((junk) => pusher.push(junk));
        } catch (e) { broke = e.message; }
        eq(broke, null, 'errors: junk on either socket never throws');
        eq(w.of('chat').length, 0, 'errors: and produces no bogus messages');

        // The sockets still work afterwards.
        irc.push('@display-name=Real;id=r1 :n!n@n PRIVMSG #somechannel :still working\r\n');
        eq(w.last('chat').msg.author, 'Real', 'errors: a real message after the junk still arrives');
      } finally { w.teardown(); }
    }

    // ── A command for a platform that was never joined ──
    {
      const w = bootWorker();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'somechannel', hints: [] });
        await wait(60);
        w.clear();
        w.send({ cmd: 'send', id: 's1', text: 'hi', targets: ['twitch', 'kick'] });
        await wait(60);
        const res = w.last('sendResult');
        eq(res.results.twitch.reason, 'no-channel', 'errors: sending to an unjoined channel is refused');
        eq(res.results.kick.reason, 'no-channel', 'errors: for both platforms');
      } finally { w.teardown(); }
    }

    // ── Nonsense commands must be ignored, not crash the worker ──
    {
      const w = bootWorker();
      try {
        w.connect();
        let broke = null;
        try {
          [
            null, undefined, {}, { cmd: null }, { cmd: 'nope' },
            { cmd: 'join' }, { cmd: 'join', platform: 'nope', channel: 'x' },
            { cmd: 'leave' }, { cmd: 'moderate' }, { cmd: 'send' },
            { cmd: 'hello' }, { cmd: 'hints', hints: 'notanarray' },
          ].forEach((msg) => w.send(msg));
          await wait(60);
        } catch (e) { broke = e.message; }
        eq(broke, null, 'errors: malformed commands are ignored without throwing');

        // Still alive.
        w.send({ cmd: 'hello', site: 'twitch', channel: 'aftergarbage', hints: [] });
        await wait(60);
        eq(w.last('ready').channel, 'aftergarbage', 'errors: the worker still works afterwards');
      } finally { w.teardown(); }
    }
  })();
};

// The feed is what has to stay bounded and accurate while a busy channel pours
// into it, so its queue, dedupe and trim are driven directly here.
suites.feed = function () {
  function fakeNode(tag) {
    const node = {
      tagName: tag || 'DIV',
      children: [],
      dataset: {},
      style: {},
      innerHTML: '',
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 100,
      appendChild(child) {
        if (child.__fragment) {
          child.children.forEach((c) => { c.parentNode = this; this.children.push(c); });
          child.children = [];
          return child;
        }
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        return child;
      },
      replaceChildren() { this.children = []; },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        // Only the shapes feed.js actually uses.
        const platform = (/data-platform="([^"]+)"/.exec(sel) || [])[1];
        const msgId = (/data-msg-id="([^"]+)"/.exec(sel) || [])[1];
        const wantsMsg = sel.includes('.fcm-msg');
        const wantsEmpty = sel.includes('.fcm-empty');
        return this.children.filter((c) => {
          if (wantsEmpty) return c.className === 'fcm-empty';
          if (wantsMsg && !String(c.className).includes('fcm-msg')) return false;
          if (platform && c.dataset.platform !== platform) return false;
          if (msgId && c.dataset.msgId !== msgId) return false;
          return true;
        });
      },
    };
    Object.defineProperty(node, 'childElementCount', { get: () => node.children.length });
    Object.defineProperty(node, 'firstElementChild', { get: () => node.children[0] || null });
    const classes = new Set();
    node.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, f) => (f ? classes.add(c) : classes.delete(c)),
    };
    Object.defineProperty(node, 'className', {
      get: () => [...classes].join(' '),
      set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    });
    return node;
  }

  function build(settings) {
    const feedEl = fakeNode();
    const frames = [];
    const sandbox = makeSandbox({
      chrome: { storage: { sync: { get: async () => ({}) } } },
      document: {
        hidden: false,
        createElement: (t) => fakeNode(t),
        createDocumentFragment: () => {
          const f = fakeNode();
          f.__fragment = true;
          return f;
        },
      },
      window: { requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; } },
    });
    const FCM = load(sandbox, ...SHARED, 'src/content/render.js', 'src/content/feed.js');
    FCM.setViewSettings(FCM.DEFAULT_SETTINGS);
    const current = { ...FCM.DEFAULT_SETTINGS, ...(settings || {}) };
    const feed = FCM.createFeed(feedEl, () => current);
    return {
      FCM, feed, feedEl, current,
      flush() { const pending = frames.splice(0); pending.forEach((fn) => fn()); },
    };
  }

  const filter = new Set(['twitch', 'kick']);
  const FCM_MIN_MESSAGES = build().FCM.MAX_MESSAGES_MIN;

  // ── Duplicates are dropped, and only real duplicates ──
  {
    const t = build();
    const first = t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'm1' }, filter);
    const again = t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'm1' }, filter);
    ok(first, 'feed: the first copy is accepted');
    eq(again, null, 'feed: the same id twice is dropped');
    eq(t.feed.count, 1, 'feed: and is not counted');

    // The same id on the other platform is a different message.
    ok(t.feed.addMessage({ platform: 'kick', author: 'a', text: 'x', messageId: 'm1' }, filter),
      'feed: the same id on another platform is kept');

    // Messages with no id at all cannot be deduped and must all be kept.
    ok(t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'y' }, filter), 'feed: an id-less message is kept');
    ok(t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'y' }, filter), 'feed: and so is the next one');
    eq(t.feed.count, 4, 'feed: the count reflects what was accepted');
  }

  // ── The queue is bounded even before it reaches the DOM ──
  {
    const t = build({ maxMessages: 100 });
    for (let i = 0; i < 500; i++) {
      t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'q' + i }, filter);
    }
    // Nothing has been flushed yet — a hidden tab does exactly this.
    t.flush();
    eq(t.feedEl.childElementCount, 100, 'feed: a burst larger than the cap lands at the cap');
    eq(t.feed.count, 500, 'feed: but every message is still counted');
  }

  // ── Trim keeps the newest. 100 is the floor the setting clamps to, so that
  //    is what a "small" feed actually means. ──
  {
    const t = build({ maxMessages: 100 });
    for (let i = 0; i < 250; i++) {
      t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'msg' + i, messageId: 't' + i }, filter);
      t.flush();
    }
    eq(t.feedEl.childElementCount, 100, 'feed: the cap holds across many flushes');
    const last = t.feedEl.children[t.feedEl.children.length - 1];
    eq(last.dataset.msgId, 't249', 'feed: the newest message is the one kept');
    eq(t.feedEl.children[0].dataset.msgId, 't150', 'feed: the oldest beyond the cap are dropped');
  }

  // ── Lowering the cap trims immediately ──
  {
    const t = build({ maxMessages: 500 });
    for (let i = 0; i < 500; i++) {
      t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'c' + i }, filter);
    }
    t.flush();
    eq(t.feedEl.childElementCount, 500, 'feed: filled to the cap');
    t.current.maxMessages = 100;
    t.feed.trim();
    eq(t.feedEl.childElementCount, 100, 'feed: lowering the cap trims what is already there');
  }

  // ── A cap below the allowed floor is raised, not honoured ──
  {
    const t = build({ maxMessages: 5 });
    for (let i = 0; i < 150; i++) {
      t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'lo' + i }, filter);
    }
    t.flush();
    eq(t.feedEl.childElementCount, FCM_MIN_MESSAGES,
      'feed: a cap under the floor is clamped up rather than starving the feed');
  }

  // ── An out-of-range cap falls back rather than emptying the feed ──
  {
    const t = build({ maxMessages: 'nonsense' });
    for (let i = 0; i < 20; i++) {
      t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'n' + i }, filter);
    }
    t.flush();
    eq(t.feedEl.childElementCount, 20, 'feed: a nonsense cap does not throw messages away');
  }

  // ── Filtering hides rather than deletes ──
  {
    const t = build();
    t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'f1' }, filter);
    t.feed.addMessage({ platform: 'kick', author: 'b', text: 'y', messageId: 'f2' }, filter);
    t.flush();
    t.feed.applyFilter(new Set(['twitch']));
    const kickRow = t.feedEl.children.find((c) => c.dataset.platform === 'kick');
    const twitchRow = t.feedEl.children.find((c) => c.dataset.platform === 'twitch');
    ok(kickRow.classList.contains('fcm-hide'), 'feed: the filtered platform is hidden');
    ok(!twitchRow.classList.contains('fcm-hide'), 'feed: the kept platform stays visible');
    eq(t.feedEl.childElementCount, 2, 'feed: filtering removes nothing');

    t.feed.applyFilter(new Set(['twitch', 'kick']));
    ok(!kickRow.classList.contains('fcm-hide'), 'feed: unfiltering brings it back');
  }

  // ── Leaving a platform drops its rows and forgets its ids ──
  {
    const t = build();
    t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'd1' }, filter);
    t.feed.addMessage({ platform: 'kick', author: 'b', text: 'y', messageId: 'd2' }, filter);
    t.flush();
    t.feed.dropPlatform('kick');
    eq(t.feedEl.childElementCount, 1, 'feed: only that platform is dropped');
    eq(t.feedEl.children[0].dataset.platform, 'twitch', 'feed: the other platform survives');

    // Rejoining replays history, which must not be swallowed as already seen.
    ok(t.feed.addMessage({ platform: 'kick', author: 'b', text: 'y', messageId: 'd2' }, filter),
      'feed: a replayed message is accepted after leaving');
    // The other platform is still deduped.
    eq(t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'd1' }, filter), null,
      'feed: the platform that stayed is still deduped');
  }

  // ── Moderation marks ──
  {
    const t = build();
    t.feed.addMessage({ platform: 'twitch', author: 'Bad', text: 'x', messageId: 'x1' }, filter);
    t.feed.addMessage({ platform: 'twitch', author: 'Bad', text: 'y', messageId: 'x2' }, filter);
    t.feed.addMessage({ platform: 'twitch', author: 'Good', text: 'z', messageId: 'x3' }, filter);
    t.feed.addMessage({ platform: 'kick', author: 'Bad', text: 'w', messageId: 'x4' }, filter);
    t.flush();

    t.feed.markUserDeleted('twitch', 'BAD');
    const deleted = t.feedEl.children.filter((c) => c.classList.contains('fcm-deleted'));
    eq(deleted.length, 2, 'feed: every message from that user is struck, case-insensitively');
    ok(deleted.every((c) => c.dataset.platform === 'twitch'),
      'feed: and only on the platform they were timed out on');

    t.feed.markMessageDeleted('twitch', 'x3');
    ok(t.feedEl.children.find((c) => c.dataset.msgId === 'x3').classList.contains('fcm-deleted'),
      'feed: a single message can be struck by id');

    // A hostile id must not break the lookup.
    let threw = null;
    try {
      t.feed.markMessageDeleted('twitch', 'a"]');
      t.feed.markUserDeleted('twitch', '');
      t.feed.markUserDeleted('twitch', null);
    } catch (e) { threw = e.message; }
    eq(threw, null, 'feed: an odd id or name does not throw');
  }

  // ── The dedupe set stays bounded over a long session ──
  {
    const t = build({ maxMessages: 100 });
    const limit = t.FCM.SEEN_MESSAGE_LIMIT;
    for (let i = 0; i < limit + 500; i++) {
      t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 's' + i }, filter);
    }
    t.flush();
    // The oldest ids have been forgotten, which is the intended trade: bounded
    // memory in exchange for a duplicate only if one arrives thousands late.
    ok(t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 's0' }, filter),
      'feed: very old ids are eventually forgotten, keeping the set bounded');
    eq(t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 's' + (limit + 499) }, filter),
      null, 'feed: recent ids are still deduped');
  }

  // ── Clearing resets everything ──
  {
    const t = build();
    t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'z1' }, filter);
    t.flush();
    t.feed.clear();
    eq(t.feedEl.childElementCount, 0, 'feed: clearing empties the feed');
    eq(t.feed.count, 0, 'feed: and resets the count');
    ok(t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'z1' }, filter),
      'feed: and forgets what it had seen');
  }

  // ── The queue drains even when no animation frame ever arrives ──
  //
  // A frame stops being delivered whenever the page is not being drawn, and not
  // only when the tab is hidden: a window fully covered by another one is
  // occluded with `document.hidden` still false. Worse, that can begin *after*
  // a frame has been asked for, so picking between a frame and a timer at the
  // moment of scheduling is not enough — the frame that never arrives leaves the
  // queue permanently unscheduled and the feed stops drawing for good.
  function drainRig({ frameFires }) {
    const feedEl = fakeNode();
    const frames = [];
    const timeouts = [];
    const sandbox = makeSandbox({
      chrome: { storage: { sync: { get: async () => ({}) } } },
      document: {
        hidden: false,
        createElement: (t) => fakeNode(t),
        createDocumentFragment: () => { const f = fakeNode(); f.__fragment = true; return f; },
      },
      window: {
        requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
        cancelAnimationFrame: (id) => { frames[id - 1] = null; },
      },
    });
    sandbox.setTimeout = (fn) => { timeouts.push(fn); return timeouts.length; };
    sandbox.clearTimeout = (id) => { if (id) timeouts[id - 1] = null; };
    const FCM = load(sandbox, ...SHARED, 'src/content/render.js', 'src/content/feed.js');
    FCM.setViewSettings(FCM.DEFAULT_SETTINGS);
    const feed = FCM.createFeed(feedEl, () => FCM.DEFAULT_SETTINGS);
    const fire = (list) => list.forEach((fn) => { if (fn) fn(); });
    return { feedEl, feed, frames, timeouts, fireFrames: () => fire(frames), fireTimers: () => fire(timeouts) };
  }

  // A window that stops being drawn: the frame never comes, the timer saves it.
  {
    const t = drainRig({});
    t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'h1' }, filter);
    ok(t.frames.length > 0, 'feed: a frame is asked for');
    ok(t.timeouts.filter(Boolean).length > 0, 'feed: and a timer alongside it');
    t.fireTimers();
    eq(t.feedEl.childElementCount, 1, 'feed: the timer drains the queue when no frame arrives');

    // The real damage was to everything after it: with the queue stuck, no
    // later message ever rescheduled a flush.
    t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'y', messageId: 'h2' }, filter);
    t.fireTimers();
    eq(t.feedEl.childElementCount, 2, 'feed: and the next message still lands after that');
  }

  // A window that is being drawn: the frame wins and the timer is cancelled, so
  // the fallback costs nothing when it is not needed.
  {
    const t = drainRig({});
    t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'v1' }, filter);
    t.fireFrames();
    eq(t.feedEl.childElementCount, 1, 'feed: a frame drains the queue');
    eq(t.timeouts.filter(Boolean).length, 0, 'feed: and cancels the timer it raced');

    // Firing the cancelled timer too must not double-flush or throw.
    t.fireTimers();
    eq(t.feedEl.childElementCount, 1, 'feed: a cancelled timer does nothing if it fires anyway');
  }
};

// Moving between channels on the same site. Twitch and Kick are single-page
// apps, so this is a URL change rather than a page load, and everything from
// the channel being left has to stop before the new one starts.
suites.navigation = function () {
  function boot(startPath, options = {}) {
    const ports = [];
    const timers = { intervals: [], timeouts: [] };
    const location = {
      hostname: 'www.twitch.tv',
      pathname: startPath,
      get href() { return 'https://www.twitch.tv' + this.pathname; },
    };

    const sandbox = makeSandbox({
      location,
      window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
      document: {
        documentElement: { appendChild() {}, className: '', dataset: {}, getAttribute: () => null },
        body: { className: '' },
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ dataset: {}, style: {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, appendChild() {}, addEventListener() {} }),
      },
      chrome: {
        runtime: {
          connect() {
            const p = {
              id: ports.length + 1,
              sent: [],
              disconnected: false,
              postMessage(m) { if (!this.disconnected) this.sent.push(m); },
              disconnect() { this.disconnected = true; },
              onMessage: { addListener: (fn) => { p._recv = fn; } },
              onDisconnect: { addListener: (fn) => { p._gone = fn; } },
            };
            ports.push(p);
            return p;
          },
        },
        storage: {
          sync: { get: async () => ({}), set: async () => {} },
          local: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener() {} },
        },
      },
    });
    sandbox.setInterval = (fn, ms) => { timers.intervals.push({ fn, ms }); return timers.intervals.length; };
    sandbox.clearInterval = () => {};
    sandbox.setTimeout = (fn, ms) => { timers.timeouts.push({ fn, ms, cancelled: false }); return timers.timeouts.length; };
    sandbox.clearTimeout = (id) => { if (timers.timeouts[id - 1]) timers.timeouts[id - 1].cancelled = true; };

    const FCM = load(sandbox, ...SHARED, 'src/content/sites.js');

    // A stand-in overlay: boot only needs it to mount, take messages and go away.
    const overlays = [];
    // Mounting is genuinely asynchronous — it reads settings and geometry out of
    // chrome.storage — so a navigation can overtake one that is still in flight.
    // With slowMount the test decides when each mount finishes, which is what
    // makes that window reproducible instead of a matter of luck.
    const gates = [];
    FCM.createOverlay = (opts) => {
      const o = {
        channel: opts.channel,
        destroyed: false,
        statuses: [],
        mount: () => (options.slowMount
          ? new Promise((resolve) => { gates.push(() => resolve(o)); })
          : Promise.resolve(o)),
        destroy() { o.destroyed = true; },
        sys() {}, event() {}, chat() {}, batch() {}, setEmotes() {}, setBadges() {},
        deleteMessage() {}, deleteUser() {}, setCounterpart() {}, setAccounts() {},
        setModerator() {}, modResult() {}, sendResult() {}, applyStoredSettings() {}, toast() {},
        setStatus(platform, state, channel) { o.statuses.push({ platform, state, channel }); },
      };
      overlays.push(o);
      return o;
    };

    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/boot.js'), 'utf8'),
      sandbox, { filename: 'boot.js' });

    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

    return {
      FCM, ports, overlays, timers, location, flush, gates,
      // The SPA nav poll boot installs.
      async navigateTo(pathname) {
        location.pathname = pathname;
        timers.intervals.filter((t) => t.ms === 600).forEach((t) => t.fn());
        await flush();
      },
      // The same poll, without waiting for what it starts to finish — so a
      // second navigation can be fired while the first is still mounting.
      navigateNow(pathname) {
        location.pathname = pathname;
        timers.intervals.filter((t) => t.ms === 600).forEach((t) => t.fn());
      },
      releaseMount(i) { if (gates[i]) gates[i](); },
      live() { return ports.filter((p) => !p.disconnected); },
      joinsFor(port) { return port.sent.filter((m) => m.cmd === 'join').map((m) => m.channel); },
      allJoins() { return ports.flatMap((p) => p.sent.filter((m) => m.cmd === 'join').map((m) => m.channel)); },
      hellos() { return ports.flatMap((p) => p.sent.filter((m) => m.cmd === 'hello').map((m) => m.channel)); },
      runTimersOfLength(ms) {
        timers.timeouts.filter((t) => t.ms === ms && !t.cancelled).forEach((t) => t.fn());
      },
    };
  }

  return (async () => {
    // ── The reported bug: switching channels must not go back to the old one ──
    {
      const t = boot('/alpha');
      await t.flush();
      // Pretend the worker confirmed the join, as it does in practice.
      t.ports[0]._recv({ type: 'ready', site: 'twitch', channel: 'alpha', connections: {} });
      await t.flush();
      t.ports[0]._recv({ type: 'status', platform: 'twitch', state: 'connected', channel: 'alpha' });
      await t.flush();
      eq(t.hellos(), ['alpha'], 'nav: the first channel is announced once');

      const firstPort = t.ports[0];
      await t.navigateTo('/bravo');

      ok(firstPort.disconnected,
        'nav: the port carrying the old channel is closed, not left listening');
      eq(t.live().length, 1, 'nav: exactly one port is live afterwards');
      eq(t.hellos().filter((c) => c === 'bravo').length, 1, 'nav: the new channel is announced');

      // The heart of it: anything still arriving from the old channel must be
      // ignored rather than applied to the new overlay.
      firstPort._recv({ type: 'status', platform: 'twitch', state: 'connected', channel: 'alpha' });
      firstPort._recv({ type: 'ready', site: 'twitch', channel: 'alpha', connections: { twitch: { channel: 'alpha', state: 'connected' } } });
      await t.flush();

      const newPort = t.live()[0];
      eq(t.joinsFor(newPort).filter((c) => c === 'alpha').length, 0,
        'nav: no join for the old channel is ever issued on the new port');

      // And the worker confirming the new channel joins that one, not the old.
      newPort._recv({ type: 'ready', site: 'twitch', channel: 'bravo', connections: {} });
      await t.flush();
      eq(t.joinsFor(newPort), ['bravo'], 'nav: only the new channel is joined');
    }

    // ── The old overlay is torn down, exactly one is left ──
    {
      const t = boot('/alpha');
      await t.flush();
      await t.navigateTo('/bravo');
      eq(t.overlays.length, 2, 'nav: a fresh overlay is built for the new channel');
      eq(t.overlays[0].destroyed, true, 'nav: the old overlay is destroyed');
      eq(t.overlays[1].destroyed, false, 'nav: the new one is live');
      eq(t.overlays[1].channel, 'bravo', 'nav: and it is for the new channel');
    }

    // ── Hopping quickly through several channels settles on the last ──
    {
      const t = boot('/alpha');
      await t.flush();
      await t.navigateTo('/bravo');
      await t.navigateTo('/charlie');
      await t.navigateTo('/delta');

      eq(t.live().length, 1, 'nav: rapid hops leave a single live port');
      const last = t.live()[0];
      last._recv({ type: 'ready', site: 'twitch', channel: 'delta', connections: {} });
      await t.flush();
      eq(t.joinsFor(last), ['delta'], 'nav: only the channel actually on screen is joined');
      eq(t.overlays.filter((o) => !o.destroyed).length, 1, 'nav: one overlay survives');
      eq(t.overlays.filter((o) => !o.destroyed)[0].channel, 'delta', 'nav: and it is the last one');
    }

    // ── A stale hint scan must not report the old channel's links ──
    {
      const t = boot('/alpha');
      await t.flush();
      await t.navigateTo('/bravo');
      // Fire every hint scan that was scheduled, including alpha's.
      [1500, 4000, 9000].forEach((ms) => t.runTimersOfLength(ms));
      await t.flush();
      const stale = t.ports[0].sent.filter((m) => m.cmd === 'hints');
      eq(stale.length, 0, 'nav: the old channel\'s hint scans do not fire on its dead port');
    }

    // ── Leaving for a non-channel page drops everything ──
    {
      const t = boot('/alpha');
      await t.flush();
      await t.navigateTo('/directory/following');
      eq(t.hellos().slice(-1)[0], '', 'nav: the worker is told there is no channel');
      ok(t.ports[0].disconnected, 'nav: and the port is closed');
      eq(t.overlays.filter((o) => !o.destroyed).length, 0, 'nav: no overlay is left behind');

      // Coming back to a channel starts cleanly.
      await t.navigateTo('/echo');
      eq(t.live().length, 1, 'nav: returning to a channel opens one port');
      eq(t.hellos().slice(-1)[0], 'echo', 'nav: and announces that channel');
    }

    // ── A navigation that overtakes one still mounting ──
    //
    // mount() reads settings and geometry out of chrome.storage, so it takes
    // real milliseconds, and a second navigation lands inside that window. Both
    // halves have to be right: the overlay left behind is the one that call
    // built, not whatever the module variable points at by the time it resumes.
    {
      const t = boot('/alpha', { slowMount: true });
      await t.flush();
      eq(t.overlays.length, 1, 'nav: the first overlay is created');

      t.navigateNow('/bravo');
      await t.flush();
      eq(t.overlays.length, 2, 'nav: the second is created while the first is still mounting');

      // The overtaken mount finishes first, then the one that owns the page.
      t.releaseMount(0);
      await t.flush();
      t.releaseMount(1);
      await t.flush();

      const alive = t.overlays.filter((o) => !o.destroyed);
      eq(alive.length, 1, 'nav: an overtaken mount leaves exactly one overlay alive');
      eq(alive.length === 1 ? alive[0].channel : null, 'bravo',
        'nav: and it is the channel actually on screen, not the one that was overtaken');
      eq(t.overlays[0].destroyed, true, 'nav: the overtaken overlay is the one torn down');
    }

    // ── Three navigations stacked inside each other ──
    {
      const t = boot('/alpha', { slowMount: true });
      await t.flush();
      t.navigateNow('/bravo');
      await t.flush();
      t.navigateNow('/charlie');
      await t.flush();
      eq(t.overlays.length, 3, 'nav: one overlay per navigation');

      [0, 1, 2].forEach((i) => t.releaseMount(i));
      await t.flush();

      const alive = t.overlays.filter((o) => !o.destroyed);
      eq(alive.length, 1, 'nav: stacked mounts still settle on one overlay');
      eq(alive.length === 1 ? alive[0].channel : null, 'charlie', 'nav: the last one wins');
    }

    // ── Navigating to the same channel again is a no-op ──
    {
      const t = boot('/alpha');
      await t.flush();
      const before = t.ports.length;
      await t.navigateTo('/alpha');
      eq(t.ports.length, before, 'nav: re-entering the same channel does not reconnect');
      eq(t.overlays.length, 1, 'nav: nor rebuild the overlay');
    }
  })();
};

suites.moderation = function () {
  function build() {
    const calls = [];
    const auth = {
      twitch: { accessToken: 'TW', clientId: 'cid', userId: '100', login: 'modperson' },
      kick: { accessToken: 'KK', userId: '200', login: 'modperson' },
    };
    const sandbox = makeSandbox({
      chrome: {
        storage: {
          local: { get: async () => ({}), set: async () => {} },
          sync: { get: async () => ({}), set: async () => {} },
        },
      },
      fetch: async (url, init = {}) => {
        const u = String(url);
        calls.push({ url: u, method: init.method || 'GET', body: init.body, headers: init.headers });
        if (u.includes('/helix/users?login=')) {
          return { ok: true, json: async () => ({ data: [{ id: '999' }] }) };
        }
        if (/kick\.com\/api\/v\d\/channels\//.test(u)) {
          return { ok: true, json: async () => ({ id: 1, user_id: 888, slug: 'target', chatroom: { id: 2 } }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const FCM = load(sandbox, ...SHARED, 'src/background/discovery.js', 'src/background/moderation.js');
    // Stand in for the real token store.
    FCM.auth = { usable: async (p) => auth[p] };
    return { FCM, calls, auth };
  }

  return (async () => {
    // ── Twitch ──
    {
      const { FCM, calls } = build();
      const conn = { roomId: '4242' };

      const timeout = await FCM.moderate('twitch', 'timeout',
        { username: 'baduser', userId: '999', seconds: 600 }, conn, {});
      eq(timeout.ok, true, 'mod: twitch timeout succeeds');
      const call = calls[calls.length - 1];
      ok(call.url.includes('/moderation/bans'), 'mod: twitch timeout hits the bans endpoint');
      ok(call.url.includes('broadcaster_id=4242'), 'mod: the broadcaster is the joined channel');
      ok(call.url.includes('moderator_id=100'), 'mod: the moderator is the connected account');
      eq(JSON.parse(call.body).data, { user_id: '999', duration: 600 },
        'mod: duration in seconds is what makes it a timeout');

      calls.length = 0;
      await FCM.moderate('twitch', 'ban', { username: 'baduser', userId: '999' }, conn, {});
      eq(JSON.parse(calls[calls.length - 1].body).data, { user_id: '999' },
        'mod: a ban is the same call without a duration');

      calls.length = 0;
      await FCM.moderate('twitch', 'unban', { username: 'baduser', userId: '999' }, conn, {});
      eq(calls[calls.length - 1].method, 'DELETE', 'mod: unban is a DELETE');
      ok(calls[calls.length - 1].url.includes('user_id=999'), 'mod: unban names the user');

      calls.length = 0;
      await FCM.moderate('twitch', 'delete', { username: 'baduser', messageId: 'abc-1' }, conn, {});
      const del = calls[calls.length - 1];
      eq(del.method, 'DELETE', 'mod: delete is a DELETE');
      ok(del.url.includes('/moderation/chat'), 'mod: delete hits the chat endpoint');
      ok(del.url.includes('message_id=abc-1'), 'mod: delete names the message');

      // Without a message id there is nothing to delete, and no call is made.
      calls.length = 0;
      const noMsg = await FCM.moderate('twitch', 'delete', { username: 'x' }, conn, {});
      eq(noMsg.reason, 'no-message', 'mod: delete without an id is refused');
      eq(calls.length, 0, 'mod: and makes no request');

      // A username with no id still resolves before acting.
      calls.length = 0;
      await FCM.moderate('twitch', 'ban', { username: 'baduser' }, conn, {});
      ok(calls[0].url.includes('/helix/users?login=baduser'),
        'mod: an unknown user id is looked up first');
    }

    // ── Kick ──
    {
      const { FCM, calls } = build();
      const conn = { roomId: '77' };

      await FCM.moderate('kick', 'timeout', { username: 'baduser', userId: '888', seconds: 600 }, conn, {});
      const call = calls[calls.length - 1];
      ok(call.url.includes('/moderation/bans'), 'mod: kick timeout hits the bans endpoint');
      const body = JSON.parse(call.body);
      eq(body.broadcaster_user_id, 77, 'mod: kick names the broadcaster numerically');
      eq(body.user_id, 888, 'mod: kick names the target numerically');
      // Kick counts timeouts in minutes, not seconds — passing 600 straight
      // through would be a ten-hour timeout instead of ten minutes.
      eq(body.duration, 10, 'mod: kick durations are converted to whole minutes');

      calls.length = 0;
      await FCM.moderate('kick', 'timeout', { username: 'u', userId: '1', seconds: 30 }, conn, {});
      eq(JSON.parse(calls[calls.length - 1].body).duration, 1,
        'mod: a sub-minute timeout rounds up to one minute rather than to zero');

      calls.length = 0;
      await FCM.moderate('kick', 'unban', { username: 'u', userId: '1' }, conn, {});
      eq(calls[calls.length - 1].method, 'DELETE', 'mod: kick unban is a DELETE');
      eq(JSON.parse(calls[calls.length - 1].body).duration, undefined,
        'mod: an unban carries no duration');

      calls.length = 0;
      await FCM.moderate('kick', 'delete', { username: 'u', messageId: 'k-9' }, conn, {});
      ok(calls[calls.length - 1].url.endsWith('/chat/k-9'), 'mod: kick delete names the message');
      eq(calls[calls.length - 1].method, 'DELETE', 'mod: kick delete is a DELETE');

      calls.length = 0;
      await FCM.moderate('kick', 'ban', { username: 'target' }, conn, {});
      ok(calls[0].url.includes('/channels/target'), 'mod: kick resolves a username to its id');
      eq(JSON.parse(calls[calls.length - 1].body).user_id, 888, 'mod: and uses the resolved id');
    }

    // ── Guards ──
    {
      const { FCM } = build();
      eq((await FCM.moderate('twitch', 'ban', { username: 'x' }, { roomId: null }, {})).reason,
        'no-channel', 'mod: nothing happens without a joined channel');
      eq((await FCM.moderate('youtube', 'ban', {}, { roomId: '1' }, {})).reason,
        'unsupported', 'mod: an unknown platform is refused');
    }

    // ── Wording ──
    {
      const { FCM } = build();
      eq(FCM.describeModeration('twitch', { ok: true, action: 'timeout', target: 'bob', seconds: 600 }),
        'Twitch: timed bob out for 10m', 'mod: a timeout reads in minutes');
      eq(FCM.describeModeration('kick', { ok: true, action: 'timeout', target: 'bob', seconds: 3600 }),
        'Kick: timed bob out for 1h', 'mod: an hour reads as hours');
      eq(FCM.describeModeration('twitch', { ok: true, action: 'ban', target: 'bob' }),
        'Twitch: banned bob', 'mod: a ban says so plainly');
      eq(FCM.describeModeration('twitch', { ok: false, reason: 'refused', detail: 'nope' }),
        'Twitch: nope', 'mod: a refusal repeats what the platform said');
      eq(FCM.describeModeration('kick', { ok: false, reason: 'not-connected' }),
        'Kick: connect a Kick account to moderate', 'mod: a missing account is explained');
    }
  })();
};

// Several streams open at once is the normal case for anyone watching more
// than one person, so the worker has to keep every tab's sockets, channels and
// counterpart state strictly apart.
// Switching channels on the same site. The socket for the channel being left
// closes asynchronously, so its close handler runs *after* the replacement has
// been created — which is where a reconnect to the old channel used to be
// scheduled, and the two channels then traded places forever.
suites.channelswitch = function () {
  const { bootWorker, wait } = require('./background.js');

  return (async () => {
    // ── Twitch ──
    {
      const w = bootWorker();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        await wait(60);
        w.send({ cmd: 'join', platform: 'twitch', channel: 'alpha' });
        await wait(40);
        const first = w.socketFor('irc-ws');
        ok(first.sent.includes('JOIN #alpha'), 'switch: joined the first channel');

        // Navigate. The old socket's close is still in flight at this point.
        w.clear();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'bravo', hints: [] });
        await wait(60);
        w.send({ cmd: 'join', platform: 'twitch', channel: 'bravo' });

        // Let every pending close and any backoff timer run.
        await wait(400);

        const ircs = w.socketsFor('irc-ws');
        const joined = ircs.flatMap((sock) => sock.sent.filter((line) => line.startsWith('JOIN ')));
        eq(joined.filter((j) => j === 'JOIN #alpha').length, 1,
          'switch: the old channel is joined once and never re-joined');
        eq(joined.filter((j) => j === 'JOIN #bravo').length, 1,
          'switch: the new channel is joined exactly once');

        const live = ircs.filter((sock) => !sock.closed);
        eq(live.length, 1, 'switch: exactly one socket is left open');
        ok(live[0].sent.includes('JOIN #bravo'), 'switch: and it is on the new channel');

        // Nothing should be telling the tab it dropped, or counting down to a
        // reconnect, for a channel it deliberately left.
        ok(!w.of('sys').some((m) => /reconnecting in/.test(m.text)),
          'switch: no reconnect is announced for the channel that was left');
        ok(!w.of('sys').some((m) => /Connected to Twitch: alpha/.test(m.text)),
          'switch: the old channel never reports connecting again');
      } finally { w.teardown(); }
    }

    // ── Kick, where the channel lookup is awaited and the window is wider ──
    {
      const w = bootWorker();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'alpha', hints: [] });
        await wait(60);
        w.send({ cmd: 'join', platform: 'kick', channel: 'alpha' });
        await wait(80);
        const first = w.socketFor('pusher.com');
        first.push(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
        await wait(40);

        w.clear();
        w.send({ cmd: 'hello', site: 'kick', channel: 'bravo', hints: [] });
        await wait(40);
        w.send({ cmd: 'join', platform: 'kick', channel: 'bravo' });
        await wait(400);

        const live = w.socketsFor('pusher.com').filter((sock) => !sock.closed);
        eq(live.length, 1, 'switch: kick leaves exactly one socket open');
        ok(!w.of('sys').some((m) => /reconnecting in/.test(m.text)),
          'switch: kick announces no reconnect for the channel that was left');
      } finally { w.teardown(); }
    }

    // ── Hopping quickly through several channels ──
    {
      const w = bootWorker();
      try {
        w.connect();
        for (const name of ['alpha', 'bravo', 'charlie', 'delta']) {
          w.send({ cmd: 'hello', site: 'twitch', channel: name, hints: [] });
          w.send({ cmd: 'join', platform: 'twitch', channel: name });
          await wait(30);
        }
        await wait(500);

        const ircs = w.socketsFor('irc-ws');
        const live = ircs.filter((sock) => !sock.closed);
        eq(live.length, 1, 'switch: four hops leave one socket');
        ok(live[0].sent.includes('JOIN #delta'), 'switch: on the last channel');

        // Every earlier channel must have been joined exactly once.
        const joined = ircs.flatMap((s) => s.sent.filter((l) => l.startsWith('JOIN ')));
        ['alpha', 'bravo', 'charlie', 'delta'].forEach((name) => {
          eq(joined.filter((j) => j === `JOIN #${name}`).length, 1,
            `switch: ${name} is joined exactly once across the whole sequence`);
        });
      } finally { w.teardown(); }
    }

    // ── A genuine drop still reconnects, so the guard is not too broad ──
    {
      const w = bootWorker();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        await wait(60);
        w.send({ cmd: 'join', platform: 'twitch', channel: 'alpha' });
        await wait(40);
        w.clear();
        // The network dropping, rather than us closing it.
        w.socketFor('irc-ws').drop();
        await wait(40);
        ok(w.of('sys').some((m) => /reconnecting in/.test(m.text)),
          'switch: an unexpected drop still schedules a reconnect');
      } finally { w.teardown(); }
    }
  })();
};

// The real content script driving the real service worker, over a port that
// delivers asynchronously and storage that takes real milliseconds. Every other
// suite tests one side against a stub of the other, which is exactly where a
// bug living in the timing *between* them can hide — as one did.
suites.endtoend = function () {
  const { bootPair, wait } = require('./endtoend.js');

  return (async () => {
    // ── Opening a channel, then moving to another ──
    {
      const t = bootPair('/alpha');
      try {
        await wait(300);
        eq(t.joins(), ['JOIN #alpha'], 'e2e: the first channel is joined');
        eq(t.liveIrc().length, 1, 'e2e: on one socket');

        await t.navigateTo('/bravo');
        await wait(2000);

        eq(t.joins(), ['JOIN #alpha', 'JOIN #bravo'],
          'e2e: each channel is joined exactly once, in order');
        eq(t.liveIrc().length, 1, 'e2e: one socket is left open');
        ok(t.liveIrc()[0].sent.includes('JOIN #bravo'),
          'e2e: and it is on the channel now being watched');
        ok(!t.liveIrc()[0].sent.includes('JOIN #alpha'),
          'e2e: never back on the channel that was left');
      } finally { t.teardown(); }
    }

    // ── Clicking through before the first join has finished ──
    // This is the case that produced the reported loop: the join for the first
    // channel was still inside its storage reads when the second began.
    {
      const t = bootPair('/alpha');
      try {
        await wait(20);
        await t.navigateTo('/bravo');
        await wait(2500);

        eq(t.joins(), ['JOIN #bravo'],
          'e2e: interrupting a join mid-flight joins only the channel landed on');
        eq(t.ircSockets().length, 1, 'e2e: and opens only one socket');
        eq(t.liveIrc().length, 1, 'e2e: which stays open');

        // The churn the loop showed up as: connecting, dropping, connecting again.
        const statuses = t.portLog
          .filter((e) => e.dir === 'to-tab' && e.msg.type === 'status')
          .map((e) => e.msg.state);
        eq(statuses.filter((st) => st === 'disconnected').length, 0,
          'e2e: nothing ever reports disconnected, so there is no reconnect churn');
        ok(statuses.filter((st) => st === 'connecting').length <= 2,
          'e2e: and it does not keep re-announcing a connection attempt');
      } finally { t.teardown(); }
    }

    // ── Hopping through several channels quickly ──
    {
      const t = bootPair('/alpha');
      try {
        await wait(20);
        await t.navigateTo('/bravo');
        await t.navigateTo('/charlie');
        await t.navigateTo('/delta');
        await wait(2500);

        eq(t.liveIrc().length, 1, 'e2e: four quick hops leave one socket');
        ok(t.liveIrc()[0].sent.includes('JOIN #delta'), 'e2e: on the last channel');

        const joined = t.joins();
        ['alpha', 'bravo', 'charlie'].forEach((name) => {
          ok(!t.liveIrc()[0].sent.includes(`JOIN #${name}`),
            `e2e: the surviving socket is not on ${name}`);
        });
        eq(joined.filter((j) => j === 'JOIN #delta').length, 1,
          'e2e: the final channel is joined exactly once, not repeatedly');

        const disconnects = t.portLog
          .filter((e) => e.dir === 'to-tab' && e.msg.type === 'status' && e.msg.state === 'disconnected');
        eq(disconnects.length, 0, 'e2e: no drop is ever reported across the whole sequence');
      } finally { t.teardown(); }
    }

    // ── Going back to a channel already visited ──
    {
      const t = bootPair('/alpha');
      try {
        await wait(300);
        await t.navigateTo('/bravo');
        await wait(400);
        await t.navigateTo('/alpha');
        await wait(2000);

        eq(t.liveIrc().length, 1, 'e2e: returning to an earlier channel leaves one socket');
        const live = t.liveIrc()[0];
        ok(live.sent.includes('JOIN #alpha'), 'e2e: on the channel returned to');
        ok(!live.sent.includes('JOIN #bravo'), 'e2e: and not the one left behind');
      } finally { t.teardown(); }
    }
  })();
};

suites.multitab = function () {
  const { bootWorker, wait } = require('./background.js');

  return (async () => {
    const w = bootWorker();
    try {
      const a = w.makeTab(1).connect();
      const b = w.makeTab(2).connect();
      const c = w.makeTab(3).connect();

      a.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
      b.send({ cmd: 'hello', site: 'twitch', channel: 'bravo', hints: [] });
      c.send({ cmd: 'hello', site: 'kick', channel: 'charlie', hints: [] });
      await wait(80);

      eq(a.last('ready').channel, 'alpha', 'multitab: tab 1 adopted its own channel');
      eq(b.last('ready').channel, 'bravo', 'multitab: tab 2 adopted its own channel');
      eq(c.last('ready').channel, 'charlie', 'multitab: tab 3 adopted its own channel');
      eq(c.last('ready').site, 'kick', 'multitab: a Kick tab and a Twitch tab coexist');

      // Each tab only ever hears about its own channel.
      ok(a.of('ready').every((m) => m.channel === 'alpha'), 'multitab: tab 1 hears only alpha');
      ok(b.of('ready').every((m) => m.channel === 'bravo'), 'multitab: tab 2 hears only bravo');

      // ── each tab gets its own socket ──
      a.send({ cmd: 'join', platform: 'twitch', channel: 'alpha' });
      b.send({ cmd: 'join', platform: 'twitch', channel: 'bravo' });
      await wait(60);
      const ircs = w.socketsFor('irc-ws');
      eq(ircs.length, 2, 'multitab: two tabs mean two independent IRC sockets');
      ok(ircs[0].sent.includes('JOIN #alpha'), 'multitab: the first socket joined alpha');
      ok(ircs[1].sent.includes('JOIN #bravo'), 'multitab: the second socket joined bravo');

      // ── a message on one socket reaches only that tab ──
      a.clear(); b.clear();
      ircs[0].push('@display-name=AlphaViewer;id=a1 :x!x@x.tmi.twitch.tv PRIVMSG #alpha :hi from alpha\r\n');
      ircs[1].push('@display-name=BravoViewer;id=b1 :y!y@y.tmi.twitch.tv PRIVMSG #bravo :hi from bravo\r\n');
      await wait(20);

      eq(a.of('chat').length, 1, 'multitab: tab 1 received exactly one message');
      eq(b.of('chat').length, 1, 'multitab: tab 2 received exactly one message');
      eq(a.last('chat').msg.author, 'AlphaViewer', 'multitab: and it was its own');
      eq(b.last('chat').msg.author, 'BravoViewer', 'multitab: and it was its own');
      ok(!a.inbox.some((m) => JSON.stringify(m).includes('bravo')),
        'multitab: nothing from the other tab leaked into tab 1');
      ok(!b.inbox.some((m) => JSON.stringify(m).includes('alpha')),
        'multitab: nothing from the other tab leaked into tab 2');

      // ── two tabs on the same channel each keep their own connection ──
      const d = w.makeTab(4).connect();
      d.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
      await wait(60);
      d.send({ cmd: 'join', platform: 'twitch', channel: 'alpha' });
      await wait(60);
      eq(w.socketsFor('irc-ws').length, 3,
        'multitab: the same channel in two tabs does not share one socket');

      a.clear(); d.clear();
      const alphaSockets = w.socketsFor('irc-ws').filter((s) => s.sent.includes('JOIN #alpha'));
      eq(alphaSockets.length, 2, 'multitab: both alpha tabs joined independently');

      // ── closing one tab leaves the others untouched ──
      a.clear(); b.clear(); d.clear();
      w.listeners.tabRemoved(1);
      await wait(30);
      ok(alphaSockets[0].closed, 'multitab: the closed tab dropped its socket');
      ok(!ircs[1].closed, 'multitab: the other tab kept its socket');

      b.clear();
      ircs[1].push('@display-name=StillHere;id=b2 :y!y@y.tmi.twitch.tv PRIVMSG #bravo :still going\r\n');
      await wait(20);
      eq(b.last('chat').msg.author, 'StillHere', 'multitab: the surviving tab still receives chat');

      // The tab that is gone hears nothing more.
      eq(a.of('chat').length, 0, 'multitab: the closed tab receives nothing');

      // ── the popup asks per tab, and gets that tab's answer ──
      let snapA; let snapB;
      w.listeners.message({ cmd: 'status', tabId: 1 }, {}, (r) => { snapA = r; });
      w.listeners.message({ cmd: 'status', tabId: 2 }, {}, (r) => { snapB = r; });
      eq(snapA, null, 'multitab: the closed tab has no session');
      eq(snapB.channel, 'bravo', 'multitab: the open tab reports its own channel');

      // ── a port dropping and coming back does not orphan the others ──
      b.disconnect();
      await wait(30);
      const stillOpen = w.socketsFor('irc-ws').filter((s) => !s.closed).length;
      ok(stillOpen >= 1, 'multitab: a dropped port keeps its sockets during the grace period');
      // Reconnecting within the grace period keeps the session alive.
      b.connect();
      b.send({ cmd: 'hello', site: 'twitch', channel: 'bravo', hints: [] });
      await wait(60);
      eq(b.last('ready').connections.twitch.channel, 'bravo',
        'multitab: a reconnecting tab is handed its session back');
    } finally {
      w.teardown();
    }
  })();
};

suites.background = function () {
  const { bootWorker, wait } = require('./background.js');

  return (async () => {
    const w = bootWorker();
    try {
      w.connect();

      // ── hello: the worker adopts the channel and answers with its state ──
      w.send({ cmd: 'hello', site: 'twitch', channel: 'SomeChannel', hints: [] });
      await wait(60);
      const ready = w.last('ready');
      ok(ready, 'bg: hello is answered with ready');
      eq(ready.channel, 'somechannel', 'bg: the channel is normalised');
      eq(ready.connections.twitch.channel, null, 'bg: nothing is joined yet');

      // The counterpart lookup runs on adoption.
      const cp = w.last('counterpart');
      ok(cp, 'bg: the counterpart is resolved on hello');
      eq(cp.counterpart.platform, 'kick', 'bg: the counterpart is the other platform');
      eq(cp.counterpart.live, true, 'bg: its live state is reported');

      // ── join twitch: the IRC handshake goes out in the right order ──
      w.clear();
      w.send({ cmd: 'join', platform: 'twitch', channel: 'somechannel' });
      await wait(30);
      const irc = w.socketFor('irc-ws.chat.twitch.tv');
      ok(irc, 'bg: a Twitch IRC socket is opened');
      ok(irc.sent[0].startsWith('CAP REQ'),
        'bg: capabilities are requested before anything else, or messages arrive untagged');
      ok(/^PASS oauth:justinfan\d+$/.test(irc.sent[1]), 'bg: anonymous PASS');
      ok(/^NICK justinfan\d+$/.test(irc.sent[2]), 'bg: anonymous NICK matching the PASS');
      eq(irc.sent[3], 'JOIN #somechannel', 'bg: joins the requested channel');

      // ── a PING must be answered or Twitch drops the connection ──
      irc.push('PING :tmi.twitch.tv\r\n');
      ok(irc.sent.includes('PONG :tmi.twitch.tv'), 'bg: server PING is answered with PONG');

      // ── a real tagged message becomes a normalised chat row ──
      irc.push('@badges=moderator/1;color=#FF0000;display-name=ModPerson;emotes=25:0-4;'
        + 'id=msg-1;room-id=4242;tmi-sent-ts=1700000000000;user-id=9 '
        + ':modperson!modperson@modperson.tmi.twitch.tv PRIVMSG #somechannel :Kappa hello\r\n');
      const chat = w.last('chat');
      ok(chat, 'bg: a PRIVMSG becomes a chat message');
      eq(chat.msg.author, 'ModPerson', 'bg: display name is used');
      eq(chat.msg.platform, 'twitch', 'bg: tagged with its platform');
      eq(chat.msg.badgeClass, 'mod', 'bg: role derived from badges');
      eq(chat.msg.color, '#FF0000', 'bg: the name colour survives');
      eq(chat.msg.messageId, 'msg-1', 'bg: message id kept for dedupe and deletion');
      eq(chat.msg.emoteMap[0].id, '25', 'bg: emote positions parsed');
      eq(chat.msg.timestamp, 1700000000000, 'bg: the original send time is kept');

      // Messages for a channel are not filtered by room, but ROOMSTATE gives us
      // the broadcaster id every third-party emote provider is keyed by.
      irc.push('@room-id=4242 :tmi.twitch.tv ROOMSTATE #somechannel\r\n');

      // ── moderation events dim the right rows ──
      irc.push('@ban-duration=60 :tmi.twitch.tv CLEARCHAT #somechannel :baduser\r\n');
      eq(w.last('deleteUser').username, 'baduser', 'bg: a timeout marks that user deleted');
      ok(w.of('event').some((e) => /timed out for 60s/.test(e.text)), 'bg: the timeout is announced');

      irc.push('@target-msg-id=msg-1 :tmi.twitch.tv CLEARMSG #somechannel :hello\r\n');
      eq(w.last('deleteMsg').messageId, 'msg-1', 'bg: a single deleted message is marked');

      irc.push(':tmi.twitch.tv CLEARCHAT #somechannel\r\n');
      ok(w.of('event').some((e) => /cleared by a moderator/.test(e.text)), 'bg: a full clear is announced');

      // ── end of NAMES marks the join complete ──
      w.clear();
      irc.push(':tmi.twitch.tv 366 justinfan1 #somechannel :End of /NAMES list\r\n');
      await wait(60);
      ok(w.of('status').some((s) => s.state === 'connected'), 'bg: the join is reported as connected');
      ok(w.of('sys').some((s) => /Connected to Twitch/.test(s.text)), 'bg: and said so in the feed');

      // ── join kick from a twitch tab: cross-origin, which is why it lives here ──
      w.clear();
      w.send({ cmd: 'join', platform: 'kick', channel: 'somechannel' });
      await wait(80);
      const pusher = w.socketFor('ws-us2.pusher.com');
      ok(pusher, 'bg: a Kick Pusher socket is opened from a Twitch tab');

      pusher.push(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
      await wait(40);
      const subs = pusher.sent.map((s) => JSON.parse(s)).filter((m) => m.event === 'pusher:subscribe');
      eq(subs.length, 2, 'bg: subscribes to both the chatroom and the channel');
      eq(subs[0].data.channel, 'chatrooms.55.v2', 'bg: chatroom subscription uses the chatroom id');
      eq(subs[1].data.channel, 'channel.9', 'bg: channel subscription uses the channel id');

      // Pusher pings must be ponged or the socket is dropped as idle.
      pusher.push(JSON.stringify({ event: 'pusher:ping', data: '{}' }));
      ok(pusher.sent.some((s) => JSON.parse(s).event === 'pusher:pong'), 'bg: Pusher ping is ponged');

      w.clear();
      pusher.push(JSON.stringify({
        event: 'App\\Events\\ChatMessageEvent',
        data: JSON.stringify({
          id: 'k-1', content: 'hi [emote:42:kekw]', created_at: '2026-01-01T00:00:00Z',
          sender: { id: 7, username: 'KickPerson', identity: { color: '#00FF00', badges: [{ type: 'vip' }] } },
          emotes: [{ id: 42, name: 'kekw' }],
        }),
      }));
      const kmsg = w.last('chat');
      eq(kmsg.msg.platform, 'kick', 'bg: kick messages are tagged kick');
      eq(kmsg.msg.author, 'KickPerson', 'bg: kick sender name');
      eq(kmsg.msg.badgeClass, 'vip', 'bg: kick role derived from badges');
      eq(kmsg.msg.messageId, 'k-1', 'bg: kick message id');
      const learned = w.last('emotes');
      eq(learned.store.kekw.url, 'https://files.kick.com/emotes/42/fullsize',
        'bg: emotes seen in a live message are learned');

      // Housekeeping events are dropped rather than spamming the feed.
      w.clear();
      pusher.push(JSON.stringify({ event: 'App\\Events\\LivestreamUpdated', data: '{}' }));
      eq(w.of('event').length, 0, 'bg: housekeeping events produce no row');

      // ── both platforms are live in one session ──
      w.clear();
      w.send({ cmd: 'hello', site: 'twitch', channel: 'somechannel', hints: [] });
      await wait(40);
      const state = w.last('ready');
      eq(state.connections.twitch.channel, 'somechannel', 'bg: twitch stays joined across a re-hello');
      eq(state.connections.kick.channel, 'somechannel', 'bg: kick stays joined across a re-hello');

      // ── leaving drops the socket and reports idle ──
      w.clear();
      w.send({ cmd: 'leave', platform: 'kick' });
      await wait(30);
      ok(pusher.closed, 'bg: leaving closes the socket');
      eq(w.last('status').state, 'idle', 'bg: leaving reports idle');

      // ── an unexpected drop schedules a reconnect; a deliberate one does not ──
      w.clear();
      irc.drop();
      await wait(30);
      ok(w.of('sys').some((s) => /reconnecting in/.test(s.text)),
        'bg: an unexpected drop schedules a reconnect');

      w.clear();
      w.send({ cmd: 'leave', platform: 'twitch' });
      await wait(30);
      const before = w.sockets.length;
      await wait(120);
      eq(w.sockets.length, before, 'bg: a deliberate leave does not reconnect');

      // ── switching channel tears the old session down ──
      w.clear();
      w.send({ cmd: 'hello', site: 'twitch', channel: 'otherchannel', hints: [] });
      await wait(60);
      eq(w.last('ready').channel, 'otherchannel', 'bg: a new channel is adopted');

      // ── closing the tab cleans everything up ──
      w.listeners.tabRemoved(1);
      eq(w.timers.intervals.size >= 0, true, 'bg: tab removal runs teardown without throwing');

      // ── moderation is refused unless the platform said this viewer is a mod ──
      w.clear();
      w.send({ cmd: 'hello', site: 'twitch', channel: 'somechannel', hints: [] });
      await wait(40);
      w.send({ cmd: 'join', platform: 'twitch', channel: 'somechannel' });
      await wait(40);
      w.clear();
      w.send({
        cmd: 'moderate', id: 'm1', platform: 'twitch', action: 'ban',
        opts: { username: 'someone' },
      });
      await wait(60);
      const refused = w.last('modResult');
      ok(refused, 'bg: a moderation attempt is answered');
      eq(refused.result.ok, false, 'bg: moderation is refused without the badge');
      contains(refused.text, 'not a moderator',
        'bg: and says why, rather than failing silently');

      // USERSTATE is what grants it, so the overlay is told the moment it lands.
      const irc2 = w.sockets.filter((s) => s.url.includes('irc-ws')).slice(-1)[0];
      w.clear();
      const userstate = '@badges=moderator/1;mod=1 :tmi.twitch.tv USERSTATE #somechannel\r\n';
      irc2.push(userstate);
      eq(w.last('moderator').canModerate, true, 'bg: USERSTATE grants moderator tools');
      const grants = w.of('moderator').length;
      irc2.push(userstate);
      eq(w.of('moderator').length, grants, 'bg: an unchanged status is not re-announced');

      // Leaving takes the tools away again.
      w.clear();
      w.send({ cmd: 'leave', platform: 'twitch' });
      await wait(30);
      eq(w.last('moderator').canModerate, false, 'bg: leaving revokes the tools');

      // ── the popup can read a snapshot without holding a port ──
      let snapshot;
      w.listeners.message({ cmd: 'status', tabId: 1 }, {}, (r) => { snapshot = r; });
      eq(snapshot, null, 'bg: a closed tab has no session left');
    } finally {
      w.teardown();
    }
  })();
};

// ── Runner ────────────────────────────────────────────────────────────────────

(async function main() {
  const only = process.argv[2];
  const names = only ? [only] : Object.keys(suites);

  for (const name of names) {
    if (!suites[name]) {
      console.error(`Unknown suite: ${name}. Available: ${Object.keys(suites).join(', ')}`);
      process.exit(2);
    }
    const before = failed;
    try {
      await suites[name]();
    } catch (e) {
      failed++;
      failures.push(`${name}: threw ${e.stack}`);
    }
    const mark = failed === before ? 'pass' : 'FAIL';
    console.log(`  ${mark}  ${name}`);
  }

  console.log('');
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    console.log('');
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
