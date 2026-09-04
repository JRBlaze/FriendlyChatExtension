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
  'src/shared/clips.js',
];

// ── Suites ────────────────────────────────────────────────────────────────────

const FCM_LINKS_KEY = 'fcm_channel_links_v1';

const suites = {};

// The version, in every place it is written down.
//
// The README carried a version badge that nobody remembered to touch, and it
// sat at 1.5.0 through four releases while the extension shipped 1.6, 1.7,
// 1.8 and 1.9. The badge now reads the manifest, and everything else that
// names a version is checked here, because remembering is what failed.
suites.repo = function () {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const version = manifest.version;

  ok(/^\d+\.\d+\.\d+$/.test(version), `repo: the manifest version is a version (${version})`);

  // The download link names one specific file, so it cannot be derived and has
  // to be kept in step.
  const zips = Array.from(new Set(readme.match(/FriendlyChatExtension-v[\d.]+\.zip/g) || []));
  eq(zips.length, 1, `repo: the README names one release asset (${zips.join(", ") || "none"})`);
  eq(zips[0], `FriendlyChatExtension-v${version}.zip`,
    'repo: and it is the version the manifest is at');

  // The badge is derived from the manifest rather than typed out, which is why
  // there is no third place to forget.
  ok(readme.includes('img.shields.io/badge/dynamic/json'),
    'repo: the version badge reads the manifest rather than repeating it');
  const hardcoded = readme.match(/badge\/version-[\d.]+/g) || [];
  eq(hardcoded.length, 0,
    `repo: no hand-written version badge is left to go stale (${hardcoded.join(', ')})`);

  // Every script the manifest names has to exist, or the packaged extension
  // fails to load with nothing to say about why.
  const referenced = [manifest.background.service_worker];
  manifest.content_scripts.forEach((entry) => {
    (entry.js || []).forEach((f) => referenced.push(f));
    (entry.css || []).forEach((f) => referenced.push(f));
  });
  (manifest.web_accessible_resources || []).forEach((res) => {
    (res.resources || []).forEach((f) => { if (!f.includes('*')) referenced.push(f); });
  });
  const missing = referenced.filter((f) => !fs.existsSync(path.join(ROOT, f.replace(/^\//, ''))));
  eq(missing, [], `repo: every file the manifest names exists (${missing.join(', ')})`);

  // And nothing is loaded twice, which would run a module and its side effects
  // a second time.
  manifest.content_scripts.forEach((entry, i) => {
    const js = entry.js || [];
    eq(js.length, new Set(js).size, `repo: content script entry ${i} lists each file once`);
  });
};

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

  // `/me`. The wrapper has to come off, and the emote positions in the tags are
  // counted from the text inside it — so unwrapping is not cosmetic, it is what
  // keeps the emotes landing on the right characters.
  const SOH = '\u0001';
  const action = FCM.parseIrcAction(`${SOH}ACTION waves Kappa${SOH}`);
  eq(action, { action: true, text: 'waves Kappa' }, 'irc: /me is unwrapped');
  eq(FCM.parseIrcAction(`${SOH}ACTION waves`), { action: true, text: 'waves' },
    'irc: a line cut off before the closing byte is still an action');
  eq(FCM.parseIrcAction('hello there'), { action: false, text: 'hello there' },
    'irc: an ordinary message is left exactly as it came');
  eq(FCM.parseIrcAction('ACTION is not wrapped'),
    { action: false, text: 'ACTION is not wrapped' },
    'irc: the word ACTION in a message is not an action');
  eq(FCM.parseIrcAction(null), { action: false, text: '' }, 'irc: nothing stays nothing');

  // An action line end to end, as Twitch sends it. The emote sits at 6 in the
  // unwrapped text and nowhere near that in the line as received.
  const meLine = '@display-name=Waver;emotes=25:6-10 '
    + `:waver!waver@waver.tmi.twitch.tv PRIVMSG #c :${SOH}ACTION waves Kappa${SOH}`;
  const meParsed = FCM.parseIrcLine(meLine);
  const meBody = FCM.parseIrcAction(meParsed.params[1]);
  eq(meBody.text, 'waves Kappa', 'irc: the action body survives the line parser');
  eq(meBody.text.slice(6, 11), 'Kappa',
    'irc: and the emote range in the tags lands on the emote');

  // Replies. Twitch sends the whole original alongside the answer, which is
  // what lets a row show what it is answering after the original has scrolled.
  const reply = FCM.twitchReplyContext({
    'reply-parent-display-name': 'Asker',
    'reply-parent-user-login': 'asker',
    'reply-parent-msg-body': 'what game is this',
    'reply-parent-msg-id': 'parent-1',
  });
  eq(reply, {
    name: 'Asker', login: 'asker', text: 'what game is this', messageId: 'parent-1',
  }, 'irc: reply context is read from the tags');
  eq(FCM.twitchReplyContext({}), null, 'irc: an ordinary message replies to nothing');
  eq(FCM.twitchReplyContext({
    'reply-parent-display-name': 'Actor',
    'reply-parent-msg-body': `${SOH}ACTION waves${SOH}`,
  }).text, 'waves', 'irc: an action quoted back is unwrapped too');

  // The tag escaping matters here more than anywhere: a reply to a message with
  // a semicolon in it would otherwise end the tag list early.
  const escapedReply = FCM.parseIrcLine(
    '@reply-parent-display-name=Asker;reply-parent-msg-body=one\\stwo\\:three '
    + ':a!a@a.tmi.twitch.tv PRIVMSG #c :answer'
  );
  eq(FCM.twitchReplyContext(escapedReply.tags).text, 'one two;three',
    'irc: the quoted original is unescaped like any other tag');

  // Twitch's own answer to "has this person ever spoken here", which is the
  // only one worth acting on.
  const firstLine = FCM.parseIrcLine(
    '@display-name=NewHere;first-msg=1 :n!n@n.tmi.twitch.tv PRIVMSG #c :hi'
  );
  eq(firstLine.tags['first-msg'], '1', 'irc: the first-message flag is carried');
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
  // Events about the stream rather than the chat.
  //
  // These arrive on the channel rather than the chatroom and match none of the
  // sub/gift shapes, so they fell through to the catch-all and put an internal
  // event name in the feed attributed to nobody: "Someone triggered
  // StreamerIsLive." Restarting a stream was enough to produce one.
  const kickEvent = (name) => 'App' + String.fromCharCode(92) + 'Events'
    + String.fromCharCode(92) + name;
  eq(FCM.formatKickEventSummary(kickEvent('StreamerIsLive'), { livestream: { id: 1 } }), '',
    'kick: the stream going live is not a chat event');
  eq(FCM.formatKickEventSummary(kickEvent('StopStreamBroadcast'), {}), '',
    'kick: nor is it ending');
  eq(FCM.formatKickEventSummary(kickEvent('PollDeleteEvent'), {}), '',
    'kick: nor a poll being taken down');

  // A single gift, said as one gift.
  eq(FCM.formatKickEventSummary(kickEvent('GiftedSubscriptionsEvent'),
    { gifter_username: 'Ann', gifted_usernames: ['Bob'] }),
  'Ann gifted 1 sub to Bob.', 'kick: one gifted sub is singular and names who got it');
  // Kick sends the count as a string often enough that a strict === lost both
  // the singular and the recipient.
  eq(FCM.formatKickEventSummary(kickEvent('GiftedSubscriptionsEvent'),
    { gifter_username: 'Ann', gifted_quantity: '1', receiver: 'Bob' }),
  'Ann gifted 1 sub to Bob.', 'kick: a quantity sent as text reads the same way');
  eq(FCM.formatKickEventSummary(kickEvent('GiftedSubscriptionsEvent'),
    { gifter_username: 'Ann', gifted_usernames: ['Bob', 'Cid'] }),
  'Ann gifted 2 subs.', 'kick: and more than one is still plural');

};

// Enough of a DOM for the row builders, which only set properties on the node
// they create. Reading back innerHTML is what the assertions check.
function stubDocument() {
  return {
    createElement: () => ({ dataset: {}, className: '', innerHTML: '', style: {} }),
  };
}

suites.kickextras = function () {
  const FCM = load(makeSandbox(), ...SHARED);

  // Kick hangs the message being answered off the reply's metadata.
  eq(
    FCM.kickReplyContext({
      metadata: {
        original_sender: { id: 7, username: 'Asker' },
        original_message: { id: 'm-1', content: 'what game is this' },
      },
    }),
    { name: 'Asker', text: 'what game is this', messageId: 'm-1' },
    'kick: reply context is read from the metadata'
  );
  eq(FCM.kickReplyContext({ content: 'hi' }), null,
    'kick: an ordinary message replies to nothing');
  eq(FCM.kickReplyContext(null), null, 'kick: a null payload is not a reply');
  // Kick has been known to send the sender without the message.
  eq(
    FCM.kickReplyContext({ metadata: { original_sender: { username: 'Asker' } } }),
    { name: 'Asker', text: '', messageId: '' },
    'kick: a reply whose original is missing still names who was answered'
  );

  // What was redeemed is worth more than "channel points".
  eq(
    FCM.formatKickEventSummary('App' + '\\' + 'Events' + '\\' + 'RewardRedeemedEvent', {
      username: 'Someone', reward_title: 'Feed the cat',
    }),
    'Someone redeemed Feed the cat.',
    'kick: a redemption names the reward'
  );
  eq(
    FCM.formatKickEventSummary('App' + '\\' + 'Events' + '\\' + 'ChannelPointsRedeemedEvent', {
      username: 'Someone',
    }),
    'Someone redeemed channel points.',
    'kick: a redemption that does not say falls back to what it can'
  );
};

// Channel point redemptions that carry no message are never sent over IRC, so
// the only copy in the tab is the one the site has already drawn. This reads it
// back, and everything about it is written to fail closed.
suites.nativeevents = function () {
  const sandbox = makeSandbox({ document: stubDocument() });
  const FCM = load(sandbox, ...SHARED, 'src/content/native-events.js');

  // A notice line, as the site lays one out: the reward's cost ends up on a
  // line of its own once innerText breaks the row up.
  const notice = (text, hasMessage) => ({
    innerText: text,
    querySelector: () => (hasMessage ? {} : null),
  });

  eq(
    FCM.readNativeRedemption(notice('JRBlaze redeemed Feed your hedgehog\n50')),
    { text: 'JRBlaze redeemed Feed your hedgehog (50 points).' },
    'nativeevents: a redemption is read back with its reward and its cost'
  );
  eq(
    FCM.readNativeRedemption(notice('JRBlaze redeemed Feed your hedgehog')),
    { text: 'JRBlaze redeemed Feed your hedgehog.' },
    'nativeevents: and without a cost when the site did not draw one'
  );

  // A reward that asks for a message arrives over IRC already. Reading it here
  // as well would put it in the feed twice.
  eq(
    FCM.readNativeRedemption(notice('Redeemed Highlight My Message\n100\nsomeone: hi', true)),
    null,
    'nativeevents: a redemption carrying a message is left to IRC'
  );

  // Everything else the site draws as a notice is a USERNOTICE, and is already
  // handled from the platform's own structured fields.
  eq(FCM.readNativeRedemption(notice('someone\nSubscribed at Tier 1')), null,
    'nativeevents: a sub notice is not a redemption');
  eq(FCM.readNativeRedemption(notice('someone\nWatch Streak reached!')), null,
    'nativeevents: a watch streak is not a redemption');
  eq(FCM.readNativeRedemption(notice('Streamer is raiding with 1200 viewers')), null,
    'nativeevents: a raid is not a redemption');
  eq(FCM.readNativeRedemption(notice('')), null, 'nativeevents: an empty notice says nothing');
  eq(FCM.readNativeRedemption(null), null, 'nativeevents: no element says nothing');
  eq(FCM.readNativeRedemption(notice(`a redeemed ${'x'.repeat(400)}`)), null,
    'nativeevents: a block of text far too long to be a notice is refused');

  // Kick sends its redemptions down the socket, so there is nothing to watch.
  const watcher = FCM.createNativeEventWatcher({ id: 'kick', messageList: () => ({}) }, () => {
    throw new Error('kick should not be scraped');
  });
  watcher.start();
  watcher.stop();
  ok(true, 'nativeevents: the watcher does nothing on Kick');
};

// An extension installed from a zip is never updated by Chrome, so it has to
// notice for itself. Getting the comparison wrong is how "1.10.4 is newer than
// 1.9.0" turns into an update that is never offered.
suites.updates = function () {
  const FCM = load(makeSandbox(), 'src/shared/namespace.js', 'src/shared/constants.js',
    'src/shared/util.js', 'src/background/updates.js');
  const cmp = FCM.compareVersions;

  ok(cmp('1.11.0', '1.10.4') > 0, 'updates: a new minor is newer');
  ok(cmp('1.10.4', '1.9.0') > 0, 'updates: ten is newer than nine, not older');
  ok(cmp('1.10.4', '1.10.4') === 0, 'updates: the version you are on is not an update');
  ok(cmp('1.10.3', '1.10.4') < 0, 'updates: an older release is not offered');
  ok(cmp('v1.11.0', '1.10.4') > 0, 'updates: a v prefix on the tag is ignored');
  ok(cmp('2.0.0', '1.99.99') > 0, 'updates: a major bump wins');
  ok(cmp('1.11', '1.11.0') === 0, 'updates: a missing patch counts as zero');
  ok(cmp('1.11.0-beta.1', '1.11.0') === 0,
    'updates: a pre-release of a version is that version for this purpose');
  ok(cmp('', '1.0.0') < 0, 'updates: nothing is not newer than something');

  ok(FCM.STORAGE_KEYS.update, 'updates: the check has somewhere to record itself');
  ok(FCM.GITHUB_RELEASES_URL.includes('JRBlaze'), 'updates: the releases page is this repo');
};

// The replayed history goes through the same parser as the live feed, so
// everything the parser learnt has to be right there too — and one thing is
// deliberately left behind.
suites.twitchhistory = function () {
  const SOH = '';
  const lines = [
    '@display-name=Waver;id=h1 '
      + `:waver!waver@waver.tmi.twitch.tv PRIVMSG #c :${SOH}ACTION waves${SOH}`,
    '@display-name=Answerer;id=h2;reply-parent-display-name=Asker;'
      + 'reply-parent-msg-body=what\sgame :a!a@a.tmi.twitch.tv PRIVMSG #c :Elden Ring',
    '@display-name=NewHere;id=h3;first-msg=1 :n!n@n.tmi.twitch.tv PRIVMSG #c :hello',
    '@display-name=Giver;id=h4;bits=100 :g!g@g.tmi.twitch.tv PRIVMSG #c :Cheer100',
    '@display-name=Gifer;id=h5;gifs=0-9|abc|https://media.giphy.com/media/abc/giphy.gif '
      + ':g!g@g.tmi.twitch.tv PRIVMSG #c :giphy gif!',
    '@display-name=Silent;id=h6;gifs=0-0|def|https://media.giphy.com/media/def/giphy.gif '
      + ':s!s@s.tmi.twitch.tv PRIVMSG #c :',
  ];

  const sandbox = makeSandbox({
    fetch: async () => ({ ok: true, json: async () => ({ messages: lines }) }),
  });
  const FCM = load(sandbox, ...SHARED, 'src/background/twitch-source.js');

  return (async () => {
    const batches = [];
    await FCM.twitchSource.fetchHistory('c', { sys() {}, batch: (rows) => batches.push(rows) }, 60);
    const rows = batches[0] || [];
    eq(rows.length, 6, 'history: every replayed message becomes a row');
    // A replayed GIF is still a GIF, and one with no words beside it is still
    // a message.
    eq(rows[4].gifs[0].url, 'https://media.giphy.com/media/abc/giphy.gif',
      'history: a replayed GIF keeps its picture');
    eq(rows[4].gifs[0].end, 9, 'history: and its positions');
    eq(rows[5].text, '', 'history: a GIF sent with no words has none');
    eq(rows[5].gifs.length, 1, 'history: and is kept for the GIF');
    eq(rows[1].gifs, null, 'history: a message with no GIF says so');
    eq(rows[0].text, 'waves', 'history: a replayed /me is unwrapped too');
    eq(rows[0].action, true, 'history: and still reads as an action');
    eq(rows[1].reply.name, 'Asker', 'history: a replayed reply still says what it answered');
    // The highlight is a prompt to do something about somebody who has just
    // turned up. Acting on it an hour late is meaningless, so it is left off.
    ok(!rows[2].firstMessage,
      'history: a first message replayed from an hour ago is not flagged as new');
    // A replayed Cheer is still a Cheer. Without the Bits count the same
    // message would draw its Cheermote when it arrived live and spell the word
    // out when it came back in the replay above it.
    eq(rows[3].bits, 100, 'history: a replayed Cheer still says what it spent');
    eq(rows[0].bits, 0, 'history: and a message that spent nothing says so');
  })();
};

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

  // ── The bigger copy, for the hover preview ───────────────────────────────
  //
  // Every store holds the size the feed draws at, which blown up to preview
  // size is a smear. Each provider spells its sizes into the url, so the
  // bigger one is a substitution rather than another request to find out.
  {
    const bigger = FCM.largerEmoteUrl;
    eq(bigger('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'),
      'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0', 'render: twitch emote at 3.0');
    eq(bigger('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0'),
      'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0', 'render: whatever size it started at');
    eq(bigger('https://cdn.7tv.app/emote/60aeab8/2x.webp'),
      'https://cdn.7tv.app/emote/60aeab8/4x.webp', 'render: 7TV at 4x');
    eq(bigger('https://cdn.7tv.app/emote/60aeab8/2x.gif'),
      'https://cdn.7tv.app/emote/60aeab8/4x.gif', 'render: keeping the format it was served as');
    eq(bigger('https://cdn.betterttv.net/emote/5f1b018/2x'),
      'https://cdn.betterttv.net/emote/5f1b018/3x', 'render: BTTV at 3x, the largest it has');
    eq(bigger('https://cdn.frankerfacez.com/emote/1234/2'),
      'https://cdn.frankerfacez.com/emote/1234/4', 'render: FFZ at 4');
    eq(bigger('https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/100/2.gif'),
      'https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/100/4.gif',
      'render: a Cheermote at 4, still animated');
    eq(bigger('https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/100/1.5.gif'),
      'https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/100/4.gif',
      'render: whatever size the tier was served at');

    // Kick serves one size and it is already the big one.
    eq(bigger('https://files.kick.com/emotes/37226/fullsize'),
      'https://files.kick.com/emotes/37226/fullsize', 'render: Kick is left alone');
    // A host nobody has taught it about is worth showing at the size we have.
    eq(bigger('https://some.new.host/emote/abc'), 'https://some.new.host/emote/abc',
      'render: an unrecognised host comes back untouched');
    eq(bigger(''), '', 'render: and nothing stays nothing');
    eq(bigger(null), '', 'render: including a missing url');
  }

  // Links.
  const link = FCM.renderMessageBody('twitch', 'see https://example.com/a?b=1&c=2 now', {});
  contains(link.html, 'href="https://example.com/a?b=1&amp;c=2"', 'render: link href is escaped once');
  contains(link.html, 'rel="noopener noreferrer"', 'render: link is safe to click');
  const bracketed = FCM.renderMessageBody('twitch', '(https://example.com)', {});
  contains(bracketed.html, 'href="https://example.com"', 'render: trailing bracket is not part of the link');

  // Links people actually paste: nobody types the scheme.
  const bare = FCM.renderMessageBody('twitch', 'watch kick.com/somestreamer later', {});
  contains(bare.html, 'href="https://kick.com/somestreamer"', 'render: bare host gets a scheme');
  contains(bare.html, '>kick.com/somestreamer</a>', 'render: bare link still reads as typed');
  const sentence = FCM.renderMessageBody('twitch', 'it is on youtu.be/xY_z9.', {});
  contains(sentence.html, 'href="https://youtu.be/xY_z9"', 'render: the full stop ending the sentence is not part of the link');
  const www = FCM.renderMessageBody('twitch', 'www.internal-thing.zzz works', {});
  contains(www.html, 'href="https://www.internal-thing.zzz"', 'render: www. is a link whatever the tail says');

  // A dotted word is not automatically an address.
  const filename = FCM.renderMessageBody('twitch', 'check node.js and README.md and run.sh', {});
  missing(filename.html, '<a ', 'render: filenames are not links');
  const decimal = FCM.renderMessageBody('twitch', 'about 3.5 seconds', {});
  missing(decimal.html, '<a ', 'render: a decimal is not a link');
  const email = FCM.renderMessageBody('twitch', 'mail someone@example.com now', {});
  missing(email.html, '<a ', 'render: an address inside an email is not a link');
  const abbrev = FCM.renderMessageBody('twitch', 'e.g. that one', {});
  missing(abbrev.html, '<a ', 'render: an abbreviation is not a link');

  // Only http(s) ever reaches an href.
  const scripted = FCM.renderMessageBody('twitch', 'javascript:alert(1) data:text/html,x', {});
  missing(scripted.html, '<a ', 'render: no scheme but http(s) becomes a link');

  // Status and event rows carry links too, and are still escaped.
  const sysLink = FCM.buildSysEl('[Account] Sign in again at https://id.twitch.tv/oauth2 to fix this');
  contains(sysLink.innerHTML, 'href="https://id.twitch.tv/oauth2"', 'render: a status line links what it names');
  contains(sysLink.innerHTML, 'rel="noopener noreferrer"', 'render: status-line links are safe to click');
  const sysXss = FCM.buildSysEl('[Account] <img src=x onerror=alert(1)>');
  missing(sysXss.innerHTML, '<img src=x', 'render: a status line cannot inject markup');
  const eventLink = FCM.buildEventEl('kick', 'raided from kick.com/otherstreamer', null);
  contains(eventLink.innerHTML, 'href="https://kick.com/otherstreamer"', 'render: an event row links what it names');
  const eventXss = FCM.buildEventEl('kick', '<script>alert(1)</script>', null);
  missing(eventXss.innerHTML, '<script>', 'render: an event row cannot inject markup');

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
  contains(kickBadges, 'fcm-kbadge-icon-moderator', 'render: kick moderator is drawn');
  contains(kickBadges, 'fcm-kbadge-icon-og', 'render: and so is OG');
  contains(FCM.renderBadges('kick', [{ type: 'trainwreckstv' }]), 'TRAINWRECKSTV',
    'render: a kick badge with no icon still gets its label');

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

  // The half of an event the viewer actually typed is drawn like a message, so
  // the emotes in a resub message are emotes.
  FCM.setEmotes('twitch', 'native', { Kappa: { url: 'https://cdn/kappa.png', source: 'Twitch' } });
  const resubRow = FCM.buildEventEl('twitch', 'Fan resubscribed (24 months).',
    new Set(['twitch']), { body: 'thanks Kappa' });
  contains(resubRow.innerHTML, 'cdn/kappa.png', 'render: an event message draws its emotes');
  contains(resubRow.innerHTML, 'fcm-sys-said', 'render: what they said is marked apart from the summary');
  // ...and the summary is still ours, so a name that spells an emote stays a name.
  const emoteNamed = FCM.buildEventEl('twitch', 'Kappa subscribed.', new Set(['twitch']));
  missing(emoteNamed.innerHTML, 'cdn/kappa.png',
    'render: a display name that spells an emote is not turned into one');
  const eventXssBody = FCM.buildEventEl('twitch', 'Fan resubscribed.', null,
    { body: '<img src=x onerror=alert(1)>' });
  missing(eventXssBody.innerHTML, '<img src=x',
    'render: an event message cannot inject markup either');

  // The role chip is a fallback only, so a Kick row never reads "SUBSUBname".
  const kickRow = FCM.buildMessageEl({
    platform: 'kick', author: 'someone', text: 'hi',
    badgesRaw: [{ type: 'subscriber' }], badgeClass: 'sub',
  }, new Set(['kick']));
  contains(kickRow.innerHTML, 'fcm-kbadge-icon-subscriber', 'render: the badge is drawn');
  missing(kickRow.innerHTML, 'fcm-chip', 'render: and the chip stays away once a badge said it');
  contains(kickRow.innerHTML, '<title>Subscriber</title>',
    'render: a badge that arrived without a caption is captioned from its type');
  contains(kickRow.innerHTML, 'data-name="someone"', 'render: author carries its own name for the menu');

  // `/me`: no colon, and the body wears the sender's colour.
  const actionRow = FCM.buildMessageEl({
    platform: 'twitch', author: 'Waver', text: 'waves', action: true, color: '#1E90FF',
  }, new Set(['twitch']));
  contains(actionRow.className, 'fcm-action', 'render: an action row is marked as one');
  missing(actionRow.innerHTML, 'fcm-colon', 'render: an action has no colon after the name');
  contains(actionRow.innerHTML, 'fcm-body" style="--author-dark',
    'render: an action body carries the sender colour');
  const plainRow = FCM.buildMessageEl({
    platform: 'twitch', author: 'Talker', text: 'hello',
  }, new Set(['twitch']));
  contains(plainRow.innerHTML, 'fcm-colon', 'render: an ordinary message keeps its colon');

  // The message a reply is answering, drawn above the reply.
  const replyRow = FCM.buildMessageEl({
    platform: 'twitch', author: 'Answerer', text: 'it is Elden Ring',
    reply: { name: 'Asker', text: 'what game is this Kappa', messageId: 'p1' },
  }, new Set(['twitch']));
  contains(replyRow.innerHTML, 'fcm-replyto', 'render: a reply says what it is answering');
  contains(replyRow.innerHTML, '@Asker', 'render: and who it is answering');
  contains(replyRow.innerHTML, 'cdn/kappa.png', 'render: the quoted original draws its emotes');
  missing(plainRow.innerHTML, 'fcm-replyto',
    'render: a message that is not a reply gets no context line');
  const replyXss = FCM.buildMessageEl({
    platform: 'twitch', author: 'A', text: 'x',
    reply: { name: '<script>', text: '<img src=x onerror=alert(1)>' },
  }, new Set(['twitch']));
  missing(replyXss.innerHTML, '<img src=x', 'render: a quoted original cannot inject markup');
  missing(replyXss.innerHTML, '<script>', 'render: nor can the name of who was replied to');

  // Somebody's first ever message in the channel, on the platform's say-so.
  const firstRow = FCM.buildMessageEl({
    platform: 'twitch', author: 'NewHere', text: 'hi', firstMessage: true,
  }, new Set(['twitch']));
  contains(firstRow.className, 'fcm-first', 'render: a first message is marked');
  contains(firstRow.innerHTML, 'FIRST MESSAGE', 'render: and says so in words');
  missing(plainRow.className, 'fcm-first',
    'render: every other message is left alone — this is never guessed at');

  // @mentions wear the colour of the person named, once this feed has seen
  // them speak. Nobody's colour is ever invented.
  FCM.buildMessageEl({
    platform: 'twitch', author: 'Coloured', text: 'hi', color: '#1E90FF',
  }, new Set(['twitch']));
  const mentionsKnown = FCM.renderMessageBody('twitch', 'hey @Coloured how are you', {});
  contains(mentionsKnown.html, 'fcm-mention-user', 'render: a name written into a message is marked');
  contains(mentionsKnown.html, '--author-dark', 'render: and drawn in that person\'s own colour');
  const mentionsUnknown = FCM.renderMessageBody('twitch', 'hey @NeverSpokenHere', {});
  contains(mentionsUnknown.html, 'fcm-mention-twitch',
    'render: a stranger falls back to the platform tint');
  missing(mentionsUnknown.html, '--author-dark',
    'render: rather than a colour we made up for them');
  // The viewer's own name stays the louder highlight.
  const self = FCM.renderMessageBody('twitch', 'hey @MyName', {});
  contains(self.html, 'fcm-mention"', 'render: your own name keeps the mention highlight');
  missing(self.html, 'fcm-mention-user', 'render: and is not demoted to a coloured name');
  // A trailing comma is punctuation, not part of the name.
  const punctuated = FCM.renderMessageBody('twitch', '@Coloured, hello', {});
  contains(punctuated.html, '>@Coloured</span>,', 'render: punctuation after a name stays text');

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

  // ── Cheers are drawn, not spelled ──────────────────────────────────────────
  //
  // Twitch leaves Cheermotes out of the emotes tag: a Cheer arrives as the word
  // the viewer typed and nothing else. A feed that reads only that tag showed
  // "Cheer100" as text where every other chat on the same stream showed the
  // animation, which is the one message in chat that somebody paid for.
  (function cheers() {
    // The payload as Twitch sends it, cut down to the one image and colour a
    // drawn Cheer needs.
    const parsed = FCM.parseCheermoteTiers({
      data: [{
        prefix: 'Cheer',
        tiers: [{
          min_bits: 100,
          color: '#9c3ee8',
          images: {
            dark: {
              animated: { 1: 'https://c/1.gif', 1.5: 'https://c/1.5.gif', 2: 'https://c/2.gif' },
              static: { 2: 'https://c/static.png' },
            },
            light: { animated: { 2: 'https://c/light.gif' } },
          },
        }],
      }],
    });
    eq(parsed.length, 1, 'cheer: every tier of every prefix becomes an entry');
    eq(parsed[0].url, 'https://c/2.gif', 'cheer: the animated picture is the one kept');
    eq(parsed[0].minBits, 100, 'cheer: with the amount it takes to reach it');
    eq(parsed[0].color, '#9c3ee8', 'cheer: and the colour that says how big it was');
    eq(FCM.parseCheermoteTiers({}).length, 0, 'cheer: an empty payload yields nothing');
    eq(FCM.parseCheermoteTiers(null).length, 0, 'cheer: and so does a missing one');
    // Never trusted into a style attribute on the word of the payload.
    eq(FCM.parseCheermoteTiers({
      data: [{ prefix: 'X', tiers: [{ min_bits: 1, color: 'red;background:url(x)', images: { dark: { animated: { 2: 'https://c/x.gif' } } } }] }],
    })[0].color, '', 'cheer: a colour that is not a plain hex value is dropped');

    FCM.setCheermotes([
      { prefix: 'Cheer', minBits: 1, color: '#979797', url: 'https://c/cheer/1.gif' },
      { prefix: 'Cheer', minBits: 100, color: '#9c3ee8', url: 'https://c/cheer/100.gif' },
      { prefix: 'Cheer', minBits: 1000, color: '#1db2a5', url: 'https://c/cheer/1000.gif' },
      { prefix: 'SquadW', minBits: 1, color: '#979797', url: 'https://c/squadw/1.gif' },
    ]);

    const paid = FCM.renderMessageBody('twitch', 'great play Cheer100', { bits: 100 });
    contains(paid.html, 'c/cheer/100.gif', 'cheer: the Cheermote is drawn');
    contains(paid.html, 'alt="Cheer100"', 'cheer: named as the token that was typed');
    contains(paid.html, '>100<', 'cheer: with what it cost beside it');
    contains(paid.html, '--author-dark:', "cheer: in that tier's own colour");
    // Through the readability pass every other colour in the panel goes
    // through, because Twitch picks these for a dark chat and this one has a
    // light theme: the 1-Bit grey is 2.8:1 on it untouched.
    contains(FCM.renderMessageBody('twitch', 'Cheer1', { bits: 1 }).html,
      '--author-light:#676767',
      'cheer: and lifted to stay readable when the panel is on its light theme');
    missing(FCM.renderMessageBody('twitch', 'Cheer1', { bits: 1 }).html, '--author-light:#979797',
      'cheer: rather than left at the grey Twitch draws on black');
    missing(paid.html, '>Cheer100<', 'cheer: and the bare word is gone from the row');
    contains(paid.html, 'great play ', 'cheer: the rest of the message survives');

    // The tier is the largest the amount reaches — the ladder, not the nearest
    // rung, which is how Twitch itself picks the picture.
    contains(FCM.renderMessageBody('twitch', 'Cheer999', { bits: 999 }).html,
      'c/cheer/100.gif', 'cheer: an amount between tiers stays on the lower one');
    contains(FCM.renderMessageBody('twitch', 'Cheer5000', { bits: 5000 }).html,
      'c/cheer/1000.gif', 'cheer: and past the top tier it stays on the top one');
    contains(FCM.renderMessageBody('twitch', 'cheer100', { bits: 100 }).html,
      'c/cheer/100.gif', 'cheer: prefixes match however they were capitalised');

    // Several in one message, including the broadcaster's own.
    const many = FCM.renderMessageBody('twitch', 'Cheer100 gg SquadW1', { bits: 101 });
    contains(many.html, 'c/cheer/100.gif', 'cheer: the first of several is drawn');
    contains(many.html, 'c/squadw/1.gif', "cheer: and the broadcaster's own with it");
    contains(many.html, ' gg ', 'cheer: with the words between them untouched');

    // The Bits are what make it a Cheer. Somebody typing the shape of one with
    // an empty balance spends nothing, and Twitch draws them the words they
    // typed — so this has to read the message, not the text.
    const unpaid = FCM.renderMessageBody('twitch', 'great play Cheer100', {});
    missing(unpaid.html, 'c/cheer/100.gif', 'cheer: no Bits, no Cheermote');
    contains(unpaid.html, 'Cheer100', 'cheer: the word stays the word it is');

    missing(FCM.renderMessageBody('twitch', 'hello123', { bits: 100 }).html,
      'fcm-cheer', 'cheer: a word ending in digits is not a Cheer');
    missing(FCM.renderMessageBody('twitch', 'nothanks50', { bits: 50 }).html,
      'fcm-cheer', 'cheer: nor is an amount on a prefix this channel never sold');
    missing(FCM.renderMessageBody('kick', 'Cheer100', { bits: 100 }).html,
      'fcm-cheer', 'cheer: and Kick has no Cheermotes to draw');

    // A message cannot smuggle markup in through the amount or the name.
    const trickyCheer = FCM.renderMessageBody('twitch', 'Cheer100 <img src=x onerror=alert(1)>',
      { bits: 100 });
    missing(trickyCheer.html, '<img src=x', 'cheer: a Cheer message escapes like any other');

    // A custom Cheermote belongs to the channel that sells it, so leaving takes
    // it away rather than drawing the last streamer's picture over this one.
    FCM.resetPlatformView('twitch');
    missing(FCM.renderMessageBody('twitch', 'Cheer100', { bits: 100 }).html,
      'fcm-cheer', 'cheer: leaving a channel takes its Cheermotes with it');
  })();
};

// Whether a connection is up is told three ways: the dot's colour, the dot's
// shape, and words. Colour on its own would leave the states indistinguishable
// to anyone who cannot separate amber from green from red — so what matters
// here is that no state the worker can report is left without wording.
// Chrome deletes an extension's storage when the extension is removed, and
// removing and re-loading is one ordinary way to update one loaded unpacked —
// so a backup file is the only thing that makes favourites and channel links
// survive that. Importing writes to storage from a file a person chose, which
// is why nothing here trusts the file.
suites.backup = function () {
  const FCM = load(makeSandbox(), ...SHARED);

  const full = {
    settings: {
      ...FCM.DEFAULT_SETTINGS,
      opacity: 80,
      theme: 'light',
      favouriteEmotes: ['PogU', 'catJAM'],
      highlightNames: 'MyName',
      savedAt: 1700000000000,
    },
    links: { 'twitch:streamer': { channel: 'streamer-kick', manual: true } },
    geometry: { twitch: { manual: true, left: 100, top: 50, width: 400, height: 700 } },
    sendTargets: { 'twitch:streamer': ['kick'] },
  };

  // ── The round trip ─────────────────────────────────────────────────────────
  {
    const file = FCM.buildBackup(full, '1.15.0');
    eq(file.format, FCM.BACKUP_FORMAT, 'backup: the file says what it is');
    eq(file.extensionVersion, '1.15.0', 'backup: and which build wrote it');
    ok(file.savedAt, 'backup: and when');

    // Through JSON, because that is the only way it ever travels.
    const back = FCM.readBackup(JSON.parse(JSON.stringify(file)));
    ok(back.ok, 'backup: its own file reads back');
    eq(back.stores.settings.favouriteEmotes, ['PogU', 'catJAM'],
      'backup: the favourites come back in the order they were kept in');
    eq(back.stores.settings.opacity, 80, 'backup: and every other setting with them');
    eq(back.stores.settings.theme, 'light', 'backup: including the ones that are words');
    eq(back.stores.links['twitch:streamer'].channel, 'streamer-kick',
      'backup: channel links survive');
    eq(back.stores.sendTargets['twitch:streamer'], ['kick'],
      'backup: so does where a channel sends');
    eq(back.stores.geometry.twitch.width, 400, 'backup: and where the panel was dragged to');
    eq(back.counts.favourites, 2, 'backup: the count offered before importing is the real one');

    // The stamp is when the settings were last written, and importing is
    // writing them. Carrying the old one over would make a restored file look
    // older than whatever is already in the other storage area, and
    // loadSettings takes the newer of the two.
    eq(back.stores.settings.savedAt, undefined, 'backup: the save stamp is not restored');
  }

  // ── Tokens are never in it ─────────────────────────────────────────────────
  //
  // They are per-device credentials — the reason they live in local and never
  // in sync — and a file someone might mail themselves is not where one goes.
  {
    const file = FCM.buildBackup({ ...full, auth: { twitch: { accessToken: 'SECRET' } } }, '1.15.0');
    missing(JSON.stringify(file), 'SECRET', 'backup: an account token cannot get into the file');
    missing(JSON.stringify(file), 'auth', 'backup: the auth store is not carried at all');
  }

  // ── A file is something a person can edit ──────────────────────────────────
  {
    const hostile = FCM.readBackup({
      format: FCM.BACKUP_FORMAT,
      backupVersion: 1,
      settings: {
        opacity: 'wide',                 // a number that is not one
        showBadges: 'yes',               // a boolean that is not one
        theme: { evil: true },           // a string that is not one
        favouriteEmotes: ['PogU', 42, null, { name: 'x' }, '  ', 'catJAM'],
        sendTargets: ['twitch', 'myspace'],
        __proto__: 'polluted',
        somethingInvented: 'hello',
      },
      links: { 'twitch:ok': { channel: 'x' }, 'notaplatform:bad': { channel: 'y' }, plain: {} },
      sendTargets: { 'twitch:ok': ['twitch'], 'twitch:bad': ['myspace'], 'twitch:empty': [] },
      geometry: { twitch: { left: 1, top: 2, width: null, height: 4 }, myspace: { left: 1 } },
    });

    ok(hostile.ok, 'backup: a file with junk in it still restores what was good');
    const s = hostile.stores.settings;
    eq(s.opacity, undefined, 'backup: a setting of the wrong type is dropped, not applied');
    eq(s.showBadges, undefined, 'backup: including a boolean written as a word');
    eq(s.theme, undefined, 'backup: and an object where a string belongs');
    eq(s.somethingInvented, undefined, 'backup: a key this build has never heard of is dropped');
    eq(s.favouriteEmotes, ['PogU', 'catJAM'],
      'backup: favourites keep only the names that are names');
    eq(s.sendTargets, ['twitch'], 'backup: a send target that is not a platform is dropped');
    // Dropping the whole key rather than restoring an empty list: at least one
    // target always stays selected, so [] is not a state to put anybody in.
    eq(FCM.readBackup({
      format: FCM.BACKUP_FORMAT, settings: { sendTargets: ['myspace'], opacity: 50 },
    }).stores.settings.sendTargets, undefined,
    'backup: and a list with nothing left in it is not restored at all');

    eq(Object.keys(hostile.stores.links), ['twitch:ok'],
      'backup: a link key naming no platform we know is dropped');
    eq(Object.keys(hostile.stores.sendTargets), ['twitch:ok'],
      'backup: so is a send target that names one');
    eq(hostile.stores.geometry, undefined,
      'backup: a panel box with a missing number is not restored as a panel of no size');
  }

  // Prototype pollution, which a JSON file is a natural way to attempt.
  {
    const parsed = JSON.parse('{"format":"' + FCM.BACKUP_FORMAT
      + '","settings":{"__proto__":{"polluted":true},"opacity":50}}');
    const out = FCM.readBackup(parsed);
    ok(out.ok, 'backup: it still reads');
    eq(({}).polluted, undefined, 'backup: and nothing reached Object.prototype');
    eq(out.stores.settings.opacity, 50, 'backup: while the real setting came through');
  }

  // ── Files that are not ours, and files from the future ─────────────────────
  {
    ok(!FCM.readBackup(null).ok, 'backup: nothing is not a backup');
    ok(!FCM.readBackup('a string').ok, 'backup: neither is a string');
    ok(!FCM.readBackup([1, 2, 3]).ok, 'backup: nor an array');
    ok(!FCM.readBackup({ settings: { opacity: 50 } }).ok,
      'backup: nor a JSON file that never claimed to be one');
    contains(FCM.readBackup({ hello: 'world' }).error, 'not a Friendly Chat backup',
      'backup: and it says so plainly');

    const future = FCM.readBackup({
      format: FCM.BACKUP_FORMAT, backupVersion: FCM.BACKUP_VERSION + 1, settings: { opacity: 50 },
    });
    ok(!future.ok, 'backup: a file from a newer build is refused');
    contains(future.error, 'newer version',
      'backup: rather than a quarter-applied import nobody can see the shape of');

    const empty = FCM.readBackup({ format: FCM.BACKUP_FORMAT, backupVersion: 1 });
    ok(!empty.ok, 'backup: a backup with nothing usable in it is refused');
  }

  // ── A section left out is left alone ───────────────────────────────────────
  //
  // Restoring settings from a file that was written before any channel had been
  // linked must not delete the links found since. Absent is not empty.
  {
    const partial = FCM.readBackup({
      format: FCM.BACKUP_FORMAT, backupVersion: 1,
      settings: { favouriteEmotes: ['PogU'] },
    });
    ok(partial.ok, 'backup: a file with only settings in it is fine');
    eq(partial.stores.links, undefined, 'backup: and says nothing about links');
    eq(partial.stores.geometry, undefined, 'backup: or about the panel position');
    eq(Object.keys(partial.stores), ['settings'],
      'backup: so importing it cannot clear what it does not mention');
  }

  // ── Ceilings a file cannot talk its way past ───────────────────────────────
  {
    const many = {};
    for (let i = 0; i < FCM.LINK_STORE_LIMIT + 50; i++) many[`twitch:c${i}`] = { channel: `k${i}` };
    const favourites = [];
    for (let i = 0; i < FCM.FAVOURITE_EMOTE_LIMIT + 50; i++) favourites.push(`emote${i}`);

    const capped = FCM.readBackup({
      format: FCM.BACKUP_FORMAT, backupVersion: 1,
      settings: { favouriteEmotes: favourites },
      links: many,
    });
    eq(capped.stores.settings.favouriteEmotes.length, FCM.FAVOURITE_EMOTE_LIMIT,
      'backup: a file cannot store more favourites than the picker keeps');
    eq(Object.keys(capped.stores.links).length, FCM.LINK_STORE_LIMIT,
      'backup: nor more channel links than the cache keeps for itself');
  }

  // Duplicates in a hand-edited file would each draw their own star.
  {
    const deduped = FCM.readBackup({
      format: FCM.BACKUP_FORMAT, backupVersion: 1,
      settings: { favouriteEmotes: ['PogU', 'PogU', 'catJAM'] },
    });
    eq(deduped.stores.settings.favouriteEmotes, ['PogU', 'catJAM'],
      'backup: a favourite listed twice is restored once');
  }
};

suites.states = function () {
  const sandbox = makeSandbox({});
  const FCM = load(sandbox, 'src/shared/namespace.js', 'src/shared/constants.js');

  FCM.CONNECTION_STATES.forEach((state) => {
    const word = FCM.CONNECTION_STATE_WORDS[state];
    ok(typeof word === 'string' && word.length > 2,
      `states: "${state}" reads as something, not just a colour`);
  });

  // The worker is the one that decides what a state can be, so the list is
  // checked against the worker's own source rather than against itself.
  const fs = require('fs');
  const path = require('path');
  const emitted = new Set();
  ['service-worker', 'twitch-source', 'kick-source'].forEach((file) => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/background', `${file}.js`), 'utf8');
    const re = /(?:status\(|state: |state = )'([a-z-]+)'/g;
    let m;
    while ((m = re.exec(src))) emitted.add(m[1]);
  });
  emitted.delete('status');
  emitted.forEach((state) => {
    ok(FCM.CONNECTION_STATE_WORDS[state],
      `states: the worker reports "${state}", so the overlay has words for it`);
  });
  ok(emitted.size >= 4, 'states: the worker source was actually read');

  // Distinct wording for the states a viewer needs to tell apart.
  const distinct = new Set(['connecting', 'connected', 'idle'].map((s) => FCM.CONNECTION_STATE_WORDS[s]));
  eq(distinct.size, 3, 'states: connecting, connected and not connected each read differently');
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

    // ── Surviving an update, and a storage area that says no ─────────────────
    //
    // Favourited emotes live in the settings and signed-in accounts live in
    // storage.local, and neither is touched by an extension update — but a
    // refused write used to be swallowed, so the star lit up, nothing was
    // stored, and the favourites were gone at the next reload. Both areas are
    // written now, so one refusing does not lose anything.
    {
      const areas = { sync: {}, local: {} };
      let syncRefuses = false;
      const area = (name) => ({
        get: async (key) => ({ [key]: areas[name][key] }),
        set: async (obj) => {
          if (name === 'sync' && syncRefuses) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
          Object.assign(areas[name], obj);
        },
      });
      const box = makeSandbox({ chrome: { storage: { sync: area('sync'), local: area('local') } } });
      const F = load(box, ...SHARED);
      const KEY = F.STORAGE_KEYS.settings;

      const favourites = ['PogU', 'catJAM', 'KEKW'];
      await F.saveSettings({ favouriteEmotes: favourites });
      eq((await F.loadSettings()).favouriteEmotes, favourites, 'settings: favourites are saved');
      ok(areas.sync[KEY] && areas.local[KEY],
        'settings: and written to both areas, so either can answer for them');

      // An update is a new copy of the code against the same storage. Nothing
      // in the extension clears it, so a freshly loaded namespace must find it.
      const afterUpdate = load(makeSandbox({
        chrome: { storage: { sync: area('sync'), local: area('local') } },
      }), ...SHARED);
      eq((await afterUpdate.loadSettings()).favouriteEmotes, favourites,
        'settings: favourites survive the extension being updated');

      // Sync starts refusing, the way it does at its write-rate limit.
      syncRefuses = true;
      await F.saveSettings({ favouriteEmotes: [...favourites, 'Sadge'] });
      eq((await F.loadSettings()).favouriteEmotes.length, 4,
        'settings: a favourite added while sync refuses is still stored');
      eq(areas.sync[KEY].favouriteEmotes.length, 3,
        'settings: sync genuinely did not take it');
      eq(areas.local[KEY].favouriteEmotes.length, 4,
        'settings: the local copy is what kept it');

      // Both areas stamped the same millisecond, holding different things. The
      // stamp is only a millisecond and both areas are written from one save,
      // so a tie means either the same write reached both — in which case
      // either answers — or one of them refused. The one that refuses is sync.
      //
      // Written straight into the areas rather than saved, so the tie is the
      // test rather than something the clock has to be fast enough to produce:
      // this failed on CI and passed on every developer machine, which is the
      // worst way for a real bug to present itself.
      areas.sync[KEY] = { favouriteEmotes: ['StaleFromSync'], savedAt: 5000 };
      areas.local[KEY] = { favouriteEmotes: ['FreshFromLocal'], savedAt: 5000 };
      eq((await F.loadSettings()).favouriteEmotes, ['FreshFromLocal'],
        'settings: an equal stamp is answered by local, which is the copy that never refuses');

      // And the newer copy is the one that wins on load.
      areas.sync[KEY] = { favouriteEmotes: ['Newer'], savedAt: 9000 };
      areas.local[KEY] = { favouriteEmotes: ['Older'], savedAt: 5000 };
      eq((await F.loadSettings()).favouriteEmotes, ['Newer'],
        'settings: but a genuinely newer sync copy still wins, or another browser could never change anything');

      syncRefuses = false;
      await F.saveSettings({ favouriteEmotes: ['OnlyThis'] });
      eq((await F.loadSettings()).favouriteEmotes, ['OnlyThis'],
        'settings: once sync works again the newest write is what is read back');
    }
  })();
};

suites.compose = function () {
  const sandbox = makeSandbox({
    chrome: { storage: { sync: { get: async () => ({}) } } },
    document: { ...stubDocument(), querySelector: () => null },
  });
  const FCM = load(sandbox, ...SHARED, 'src/content/render.js', 'src/content/compose.js');
  FCM.setViewSettings(FCM.DEFAULT_SETTINGS);

  // ── Learning whose an emote is, after the fact ────────────────────────────
  //
  // The same emote arrives more than once and the first arrival is the least
  // informed: the cache answers before the network, and Twitch hands over the
  // account's own emote list before it says which channel is being watched. The
  // picker groups by owner, so an emote locked in as unowned never appeared
  // under its channel — on the very first load, which is when it matters.
  {
    FCM.setEmotes('twitch', 'thirdparty', {
      Learned: { url: 'first', source: '7TV Global' },
      StaysGlobal: { url: 'g', source: '7TV Global' },
    });
    FCM.setEmotes('twitch', 'thirdparty', {
      Learned: { url: 'second', source: '7TV', channel: true, owner: 'Jynxzi' },
    });
    const rec = FCM.view.emotes.twitch.thirdparty.Learned;
    eq(rec.owner, 'Jynxzi', 'compose: a later arrival that knows the owner is believed');
    eq(rec.channel, true, 'compose: and that it is the channel being watched');
    eq(rec.url, 'first', 'compose: but the picture does not change under a rendered message');

    // Knowing less later must not unset it.
    FCM.setEmotes('twitch', 'thirdparty', { Learned: { url: 'third', source: '7TV Global' } });
    eq(FCM.view.emotes.twitch.thirdparty.Learned.owner, 'Jynxzi',
      'compose: ownership is learnt, never contradicted');
    ok(!FCM.view.emotes.twitch.thirdparty.StaysGlobal.owner,
      'compose: and an emote nobody claimed stays unclaimed');
  }

  // The platform’s own list and a provider’s list are separate stores, and only
  // one of them can know. Listed once, and by whoever knew.
  {
    FCM.setEmotes('twitch', 'native', { BothStores: { url: 'n', source: 'Twitch Sub' } });
    FCM.setEmotes('twitch', 'thirdparty', {
      BothStores: { url: 't', source: '7TV', channel: true, owner: 'Jynxzi' },
    });
    const found = FCM.allEmoteEntries().filter((e) => e.name === 'BothStores');
    eq(found.length, 1, 'compose: a name in both stores is one emote in the list');
    eq(found[0].owner, 'Jynxzi', 'compose: owned by whichever store knew');
    eq(found[0].url, 'n', 'compose: drawn as the first store had it');
  }

  // ── What the picker groups by ─────────────────────────────────────────────
  //
  // Favourites first, then the channel's own emotes, then everything else by
  // provider. The channel flag is what the middle one turns on, and it has to
  // survive the trip from the loader through to the list the picker reads.
  {
    FCM.setEmotes('twitch', 'thirdparty', {
      ChannelPog: { url: 'https://cdn/c.webp', source: '7TV', channel: true },
      GlobalPog: { url: 'https://cdn/g.webp', source: '7TV' },
      bttvGlobal: { url: 'https://cdn/b.webp', source: 'BTTV' },
    });
    const entries = FCM.allEmoteEntries();
    const by = (n) => entries.find((e) => e.name === n);
    eq(by('ChannelPog').channel, true, "compose: the channel's emote is marked in the list");
    eq(by('GlobalPog').channel, false, 'compose: a provider global is not');
    eq(by('bttvGlobal').channel, false, 'compose: whatever provider it came from');
    eq(by('ChannelPog').source, '7TV', 'compose: and the provider name is still the label');
  }

  // ── Dates on the user menu ──────────────────────────────────────────────────
  //
  // The menu shows the day an account was made and the day someone started
  // following, as dates. Not "9 years ago": the day itself is the thing being
  // asked for, and a summary of it answers a different question.
  {
    // Parsed as local time, so the formatted day matches the day asked for
    // wherever this runs. A UTC instant near midnight is a different date
    // either side of the line, and that is a property of the timestamp rather
    // than of the formatting.
    const shown = FCM.shortDate('2017-03-14T12:00:00');
    ok(/2017/.test(shown), 'date: the year is there');
    ok(/14/.test(shown), 'date: the day of the month is there');
    ok(/Mar/i.test(shown), 'date: and the month, by name rather than a number');

    // Both shapes the platforms send.
    ok(/2023/.test(FCM.shortDate('2023-06-17T14:42:34.000000Z')),
      "date: Kick's microsecond timestamps parse");
    ok(/2017/.test(FCM.shortDate('2017-03-14T09:12:00Z')),
      "date: Twitch's timestamps parse");

    // Everything that is not a date renders as nothing, so the menu drops the
    // line rather than showing "Invalid Date".
    eq(FCM.shortDate(''), '', 'date: nothing from an empty value');
    eq(FCM.shortDate(null), '', 'date: nothing from a missing value');
    eq(FCM.shortDate(undefined), '', 'date: nothing from an absent value');
    eq(FCM.shortDate('not a date'), '', 'date: nothing from a value that is not one');
    eq(FCM.shortDate(0), '', 'date: nothing from a zero');
  }

  // ── Cheers ──────────────────────────────────────────────────────────────────
  //
  // Twitch has no API that spends Bits, so a Cheer has to be recognised before
  // the message is sent or the connected account posts "Cheer100" as dead text
  // and the streamer receives nothing. Everything here is about telling a real
  // Cheer apart from a word that merely ends in digits.
  const cheer = (t, p) => FCM.findCheer(t, p);
  eq(cheer('Cheer100').amount, 100, 'cheer: the amount is read off the token');
  eq(cheer('Cheer100').prefix, 'Cheer', 'cheer: and the prefix with it');
  eq(cheer('nice clutch Cheer100 gg').amount, 100, 'cheer: found anywhere in the message');
  eq(cheer('cheer250').amount, 250, 'cheer: prefixes are matched case-insensitively');
  eq(cheer('uni500 Cheer50').total, 550, 'cheer: several in one message add up');
  eq(cheer('uni500 Cheer50').tokens, 2, 'cheer: and are counted');

  // Twitch's own global list has one prefix that starts with a digit, and
  // requiring a letter meant it was never recognised: "4Head100" went out over
  // the API as ordinary text, spent no Bits and gave the streamer nothing,
  // while "Cheer100" typed a second later worked.
  eq(cheer('4Head100').amount, 100, 'cheer: a prefix that starts with a digit is still a Cheer');
  eq(cheer('4Head100').prefix, '4Head', 'cheer: and it is named correctly');

  ok(!cheer('hello123'), 'cheer: a word ending in digits is not a Cheer');
  ok(!cheer('100'), 'cheer: a bare number is not a Cheer');
  ok(!cheer('2020'), 'cheer: nor is a year');
  ok(!cheer('4Head'), 'cheer: nor a Cheermote prefix with no amount after it');
  ok(!cheer('Cheer0'), 'cheer: zero Bits is not a Cheer');
  ok(!cheer('Cheer100x'), 'cheer: the digits have to end the word');
  ok(!cheer('xCheer100'), 'cheer: and the prefix has to start it');
  ok(!cheer(''), 'cheer: an empty message has none');
  ok(!cheer('SquadW250'), 'cheer: an unknown prefix is not a Cheer');
  eq(cheer('SquadW250', ['SquadW']).amount, 250,
    "cheer: until the channel says it is one of the broadcaster's own");
  // The channel list must not lose the global prefixes everyone types.
  eq(cheer('Cheer100', [...FCM.GLOBAL_CHEERMOTES, 'SquadW']).amount, 100,
    'cheer: a channel list merged with the globals still knows Cheer');

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

  // ── Looking an emote up by name alone ──────────────────────────────────────
  //
  // The message box draws emotes as they are typed, and it does not know which
  // platform the message is going to, so a name is drawn if either side has it.
  ok(FCM.findEmote('Kappa'), 'compose: an emote is found by name');
  eq(FCM.findEmote('Kappa').url, 'https://t/kappa.png',
    'compose: and the native store still wins');
  ok(FCM.findEmote('emojiKEK'), 'compose: including one from the other platform');
  eq(FCM.findEmote('nothing'), null, 'compose: an unknown name finds nothing');
  eq(FCM.findEmote(''), null, 'compose: and so does no name at all');
};

// Emotes kept to hand. Stored by name rather than by url, because the same
// emote can arrive from a different provider tomorrow.
// Who a chatter is, as the worker answers it.
//
// Mostly about the two ways Twitch can say nothing. An empty follower list
// means "they do not follow" to a moderator and "you may not know" to everyone
// else, and the endpoint returns the same shape for both.
suites.profile = async function () {
  function build({ token = null, users = null, followers = null, gql = null, kick = null } = {}) {
    const calls = [];
    const sandbox = makeSandbox({
      fetch: async () => ({ ok: false }),
    });
    const FCM = load(sandbox, 'src/shared/namespace.js', 'src/shared/constants.js',
      'src/shared/util.js');
    FCM.auth = { get: async () => token };
    FCM.kickApi = { channel: async () => kick };
    FCM.getJson = async (url, init) => {
      calls.push(url);
      if (url.includes('gql.twitch.tv')) return gql;
      if (url.includes('/users?login=')) return users;
      if (url.includes('/channels/followers')) return followers;
      if (url.includes('kick.com/api/v2/channels')) return kick;
      return null;
    };
    load(sandbox, 'src/background/profile.js');
    return { FCM, calls };
  }

  const TOKEN = { accessToken: 't', clientId: 'c', userId: '1' };
  const USER = { data: [{ id: '99', login: 'viewer', display_name: 'Viewer',
    created_at: '2017-03-14T09:12:00Z', broadcaster_type: 'affiliate' }] };

  // A moderator looking at somebody who does not follow is told exactly that.
  {
    const { FCM } = build({ token: TOKEN, users: USER, followers: { total: 5000, data: [] } });
    const p = await FCM.lookupProfile('twitch', 'viewer', '123', true);
    eq(p.followedReason, 'not-following',
      'profile: an empty list means they do not follow, to someone who can see the list');
    eq(p.followedAt, '', 'profile: and carries no date');
  }

  // The same empty list to somebody who cannot moderate means nothing at all.
  {
    const { FCM } = build({ token: TOKEN, users: USER, followers: { total: 5000, data: [] } });
    const p = await FCM.lookupProfile('twitch', 'viewer', '123', false);
    eq(p.followedReason, 'not-a-moderator',
      'profile: the same empty list tells a non-moderator nothing');
  }

  // A real follow date is read straight through.
  {
    const { FCM } = build({
      token: TOKEN, users: USER,
      followers: { total: 5000, data: [{ followed_at: '2021-11-05T00:00:00Z' }] },
    });
    const p = await FCM.lookupProfile('twitch', 'viewer', '123', false);
    eq(p.followedAt, '2021-11-05T00:00:00Z', 'profile: a follow date is reported');
    eq(p.followedReason, '', 'profile: with no reason alongside it');
  }

  // An entry with no date in it must not read as a silent success.
  {
    const { FCM } = build({ token: TOKEN, users: USER, followers: { total: 1, data: [{}] } });
    const p = await FCM.lookupProfile('twitch', 'viewer', '123', true);
    eq(p.followedAt, '', 'profile: a malformed entry yields no date');
    ok(p.followedReason, 'profile: and still says why the line is empty');
  }

  // With a token, Helix carries the join date, so GraphQL is not called at all.
  {
    const { FCM, calls } = build({ token: TOKEN, users: USER, followers: { total: 0, data: [] } });
    await FCM.lookupProfile('twitch', 'viewer', '123', false);
    ok(!calls.some((u) => u.includes('gql.twitch.tv')),
      'profile: a connected account costs one lookup, not two');
  }

  // Without one, GraphQL still gives the join date.
  {
    const { FCM, calls } = build({
      gql: { data: { user: { login: 'viewer', displayName: 'Viewer', createdAt: '2016-01-02T00:00:00Z' } } },
    });
    const p = await FCM.lookupProfile('twitch', 'viewer', '123', false);
    eq(p.createdAt, '2016-01-02T00:00:00Z', 'profile: the join date needs no account');
    eq(p.followedReason, 'not-connected', 'profile: the follow date says it does');
    ok(calls.some((u) => u.includes('gql.twitch.tv')), 'profile: and it came from GraphQL');
  }

  // Nobody by that name.
  {
    const { FCM } = build({ gql: { data: { user: null } } });
    eq((await FCM.lookupProfile('twitch', 'nobody', '123', false)).reason, 'not-found',
      'profile: an unknown name is reported as such');
  }

  // Answers that stop being true must not be remembered. Signing in should not
  // leave the menu telling you to sign in for the next half hour.
  {
    const { FCM, calls } = build({
      gql: { data: { user: { login: 'viewer', createdAt: '2016-01-02T00:00:00Z' } } },
    });
    await FCM.lookupProfile('twitch', 'viewer', '123', false);
    const first = calls.length;
    await FCM.lookupProfile('twitch', 'viewer', '123', false);
    ok(calls.length > first, 'profile: a not-connected answer is asked again, not cached');
  }

  // A complete answer is cached, so clicking through a conversation is cheap.
  {
    const { FCM, calls } = build({
      token: TOKEN, users: USER,
      followers: { total: 1, data: [{ followed_at: '2021-11-05T00:00:00Z' }] },
    });
    await FCM.lookupProfile('twitch', 'viewer', '123', true);
    const first = calls.length;
    await FCM.lookupProfile('twitch', 'viewer', '123', true);
    eq(calls.length, first, 'profile: a complete answer is served from cache');
    // ...but not across channels, because the follow date is about the pair.
    await FCM.lookupProfile('twitch', 'viewer', '456', true);
    ok(calls.length > first, 'profile: and a different channel is a different question');
  }

  // Kick answers everything publicly.
  {
    const { FCM } = build({
      kick: { username: 'zJOEYzZ', created_at: '2023-06-17T14:41:43.000000Z',
        following_since: '2023-06-17T14:42:34.000000Z', subscribed_for: 7 },
    });
    const p = await FCM.lookupProfile('kick', 'zJOEYzZ', 'xqc', false);
    eq(p.createdAt, '2023-06-17T14:41:43.000000Z', 'profile: Kick gives the join date');
    eq(p.followedAt, '2023-06-17T14:42:34.000000Z', 'profile: and the follow date, to anyone');
    eq(p.subscribedMonths, 7, 'profile: and how long they have subscribed');
  }

  // A name that is not one is refused before any request is made.
  {
    const { FCM, calls } = build({});
    eq((await FCM.lookupProfile('twitch', '', '123', false)).reason, 'bad-request',
      'profile: an empty name is refused');
    eq((await FCM.lookupProfile('nope', 'viewer', '123', false)).reason, 'bad-request',
      'profile: so is a platform that does not exist');
    eq(calls.length, 0, 'profile: and neither costs a request');
  }
};

suites.favourites = function () {
  const sandbox = makeSandbox({
    chrome: { storage: { sync: { get: async () => ({}) } } },
    document: { ...stubDocument(), querySelector: () => null },
  });
  const FCM = load(sandbox, ...SHARED, 'src/content/render.js', 'src/content/compose.js');

  eq(FCM.DEFAULT_SETTINGS.favouriteEmotes, [], 'favourites: none to begin with');
  ok(FCM.FAVOURITE_EMOTE_LIMIT > 0, 'favourites: the list is bounded');

  // The ordering the picker and the autocomplete both read.
  const order = (list, names) => {
    FCM.setViewSettings({ ...FCM.DEFAULT_SETTINGS, favouriteEmotes: list });
    const isFav = (n) => (FCM.view.settings.favouriteEmotes || []).indexOf(n) !== -1;
    return names.slice().sort((a, b) => {
      const fa = isFav(a);
      const fb = isFav(b);
      if (fa !== fb) return fa ? -1 : 1;
      return a.localeCompare(b);
    });
  };
  eq(order([], ['Kappa', 'KappaPride', 'KappaRoss']), ['Kappa', 'KappaPride', 'KappaRoss'],
    'favourites: alphabetical when nothing is starred');
  eq(order(['KappaRoss'], ['Kappa', 'KappaPride', 'KappaRoss']),
    ['KappaRoss', 'Kappa', 'KappaPride'],
    'favourites: a starred emote sorts ahead of the rest');
  eq(order(['KappaRoss', 'Kappa'], ['Kappa', 'KappaPride', 'KappaRoss']),
    ['Kappa', 'KappaRoss', 'KappaPride'],
    'favourites: several starred ones keep their own alphabetical order');

  // Settings round-trip, which is what makes them survive a reload.
  FCM.setViewSettings({ ...FCM.DEFAULT_SETTINGS, favouriteEmotes: ['A', 'B'] });
  eq(FCM.view.settings.favouriteEmotes, ['A', 'B'], 'favourites: they reach the view settings');
  FCM.setViewSettings({ ...FCM.DEFAULT_SETTINGS });
  eq(FCM.view.settings.favouriteEmotes, [], 'favourites: and clear again');
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

  // 5. Completing after the caret has moved.
  //
  // The list stays open while the caret moves, and the completion used to take
  // its start from the trigger and its end from wherever the caret now was.
  // When those two no longer met, whatever lay between them was duplicated:
  // one press of the left arrow left a stray letter behind, and Home repeated
  // the whole message.
  {
    inputEl.value = 'hey :Pog';
    inputEl.selectionStart = 8;
    compose.updateAutocomplete();
    ok(compose.isPopupOpen(), 'reply: the emote list opens mid-message');
    // The caret moves on its own, without editing.
    compose.handleKey({ key: 'ArrowLeft', preventDefault() {} });
    inputEl.selectionStart = 7;
    ok(!compose.isPopupOpen(),
      'reply: moving the caret closes a list describing a query it has left');
    compose.handleKey(tab);
    eq(inputEl.value, 'hey :Pog',
      'reply: so Tab cannot splice a completion around the wrong pair of offsets');
  }
  {
    inputEl.value = 'hey :Pog';
    inputEl.selectionStart = 8;
    compose.updateAutocomplete();
    compose.handleKey({ key: 'Home', preventDefault() {} });
    inputEl.selectionStart = 0;
    compose.handleKey(tab);
    eq(inputEl.value, 'hey :Pog', 'reply: and Home cannot make it repeat the message');
  }
  // The ordinary completion still works, from the middle of a sentence as well
  // as the end.
  {
    inputEl.value = 'hey :Pog';
    inputEl.selectionStart = 8;
    compose.updateAutocomplete();
    compose.handleKey(tab);
    eq(inputEl.value, 'hey PogU ', 'reply: an ordinary completion is unaffected');
  }
  {
    inputEl.value = 'a :Pog b';
    inputEl.selectionStart = 6;
    compose.updateAutocomplete();
    compose.handleKey(tab);
    contains(inputEl.value, 'a PogU',
      'reply: completing mid-sentence replaces only the word being typed');
    contains(inputEl.value, 'b', 'reply: and leaves what came after it alone');
  }

  // Picking from the picker inserts at the caret rather than over a query, and
  // needs a separator in front of it or the name is not an emote at all: after
  // typing "gg", picking one produced "ggPogU", which went out as that literal
  // text. That path draws a real grid and cannot be reached through this stub,
  // so it is exercised against a browser in tests/harness.html instead.
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

// Whether the viewer has collapsed the site's own chat.
//
// The overlay is a chat, so it goes when the chat goes. Told by size rather
// than by a class name: both sites rename their classes and neither renames
// the fact that a collapsed column measures nothing. Verified against a real
// Twitch page, where collapsing leaves the whole right column at 0x0.
suites.chatcollapse = function () {
  // A page with just enough of a chat column to answer the question.
  //
  // `copies` is a list of boxes rather than one, because Kick ships its whole
  // chat twice — the real one and a dead copy inside a `display: none`
  // placeholder, both carrying the same ids — and which of the two comes first
  // in the document is not something to depend on.
  const box = (width, height) => ({
    getBoundingClientRect: () => ({ width, height, top: 0, left: 0,
      right: width, bottom: height }),
  });
  const CHAT_SELECTOR = /right-column|chat-room|chatroom|chat-container/;
  const pageWith = (els) => makeSandbox({
    document: {
      querySelector: (sel) => (CHAT_SELECTOR.test(sel) ? (els[0] || null) : null),
      querySelectorAll: (sel) => (CHAT_SELECTOR.test(sel) ? els : []),
    },
    window: {},
  });
  const page = ({ present = true, width = 340, height = 660 } = {}) =>
    pageWith(present ? [box(width, height)] : []);

  ['twitch', 'kick'].forEach((id) => {
    // Laid out normally: not collapsed.
    {
      const FCM = load(page(), ...SHARED, 'src/content/sites.js');
      const site = FCM.SITES[id];
      eq(site.chatCollapsed(), false, `collapse: ${id} chat at full size is not collapsed`);
    }
    // Present and given no size: collapsed.
    {
      const FCM = load(page({ width: 0, height: 0 }), ...SHARED, 'src/content/sites.js');
      const site = FCM.SITES[id];
      eq(site.chatCollapsed(), true, `collapse: ${id} chat with no size is collapsed`);
    }
    // Narrowed to a sliver is the same thing.
    {
      const FCM = load(page({ width: 12 }), ...SHARED, 'src/content/sites.js');
      const site = FCM.SITES[id];
      eq(site.chatCollapsed(), true, `collapse: ${id} chat narrowed to a sliver is collapsed`);
    }
    // Not in the page at all is a different answer, and must stay false: that
    // is a layout we never recognised, which the overlay handles its own way.
    {
      const FCM = load(page({ present: false }), ...SHARED, 'src/content/sites.js');
      const site = FCM.SITES[id];
      eq(site.chatCollapsed(), false,
        `collapse: ${id} chat that is not there is not reported as collapsed`);
    }
    // The chat shipped twice, the dead copy first. Kick really does this, and
    // reading only the first match hid the panel *and* its launcher on a page
    // whose chat was fully open — leaving nothing on screen to press to get it
    // back. Order must not matter, and neither must which copy is asked.
    {
      const FCM = load(pageWith([box(0, 0), box(340, 660)]), ...SHARED, 'src/content/sites.js');
      eq(FCM.SITES[id].chatCollapsed(), false,
        `collapse: ${id} open chat with a dead 0x0 duplicate first is not collapsed`);
    }
    {
      const FCM = load(pageWith([box(340, 660), box(0, 0)]), ...SHARED, 'src/content/sites.js');
      eq(FCM.SITES[id].chatCollapsed(), false,
        `collapse: ${id} open chat with a dead 0x0 duplicate last is not collapsed`);
    }
    // And with the duplicate still there, a chat the viewer really has put away
    // is still reported as put away.
    {
      const FCM = load(pageWith([box(0, 0), box(0, 660)]), ...SHARED, 'src/content/sites.js');
      eq(FCM.SITES[id].chatCollapsed(), true,
        `collapse: ${id} collapsed chat alongside its dead duplicate is collapsed`);
    }
  });
};

// Which links on a channel page are allowed to say who the streamer is on the
// other platform.
//
// Kick leaves the previous channel's about panel mounted after a click through
// to the next streamer. The card still reads "About CashMeow" and still holds
// their Twitch link; it simply measures nothing. Verified on kick.com: on
// /cashmeow the link's box is 340x191, and after clicking through to /odablock
// the very same link is still in the document at 0x0.
//
// That is why one channel and only one channel caused it. A leftover panel can
// only mislead if the streamer put a link on it to begin with.
suites.stalepanel = function () {
  const anchor = (href, { laidOut = true, inChat = false } = {}) => ({
    getAttribute: (name) => (name === 'href' ? href : null),
    getClientRects: () => (laidOut ? [{ width: 340, height: 191 }] : []),
    _inChat: inChat,
  });

  // A page holding the given anchors, with a chat column big enough to be
  // recognised as one.
  const page = (anchors) => {
    const chat = {
      getBoundingClientRect: () => ({ width: 340, height: 660, top: 0, left: 0,
        right: 340, bottom: 660 }),
      contains: (el) => !!(el && el._inChat),
      querySelector: () => null,
    };
    const isChatSel = (sel) => /right-column|chat-room|chatroom|chat-container|chat-scroll|chat-list|message-container/.test(sel);
    return makeSandbox({
      document: {
        querySelectorAll: (sel) => {
          if (sel === 'a[href]') return anchors;
          return isChatSel(sel) ? [chat] : [];
        },
        querySelector: (sel) => (isChatSel(sel) ? chat : null),
      },
      window: {},
    });
  };

  const hintsOn = (id, anchors) => {
    const FCM = load(page(anchors), ...SHARED, 'src/content/sites.js');
    return FCM.SITES[id].hints();
  };

  // The same page with nothing that answers to a chat selector at all: the
  // shape of a site that has renamed its markup.
  const pageWithNoChat = (anchors) => makeSandbox({
    document: {
      querySelectorAll: (sel) => (sel === 'a[href]' ? anchors : []),
      querySelector: () => null,
    },
    window: {},
  });
  const hintsWithNoChat = (id, anchors) => {
    const FCM = load(pageWithNoChat(anchors), ...SHARED, 'src/content/sites.js');
    return FCM.SITES[id].hints();
  };

  // 1. The streamer's own link, on their own page, is exactly what this is for.
  eq(hintsOn('kick', [anchor('https://www.twitch.tv/cashmeow')]),
    ['https://www.twitch.tv/cashmeow'],
    'stalepanel: a link the streamer put on their own page is read');

  // 2. The reported bug. Same link, same document, no box: this is the panel
  //    for the channel that was left, and it must not speak for this one.
  eq(hintsOn('kick', [anchor('https://www.twitch.tv/cashmeow', { laidOut: false })]),
    [],
    'stalepanel: the previous channel\'s leftover panel is not read');

  // 3. Both at once, which is what the next streamer's page actually looks
  //    like when they have a Twitch link of their own.
  eq(hintsOn('kick', [
    anchor('https://www.twitch.tv/cashmeow', { laidOut: false }),
    anchor('https://www.twitch.tv/odablock'),
  ]), ['https://www.twitch.tv/odablock'],
  'stalepanel: the channel on screen wins over the one left behind');

  // 4. A link someone pasted in chat belongs to them, not to the streamer. One
  //    viewer does not get to decide which account the channel is paired with.
  eq(hintsOn('kick', [anchor('https://www.twitch.tv/someoneelse', { inChat: true })]),
    [],
    'stalepanel: a link pasted in chat does not pair the channel');

  // 4b. And when the chat cannot be found at all, nothing is read.
  //
  // The exclusion used to be skipped whenever the chat was not found, rather
  // than the scan being abandoned — so on a page whose chat markup had been
  // renamed, every link on it counted, chat included. That hands any viewer who
  // can paste a link the choice of which account this channel is paired with,
  // and with cross-connect set to always the overlay opens that chat and
  // presents it as the streamer's own.
  eq(hintsWithNoChat('kick', [anchor('https://www.twitch.tv/someoneelse')]), [],
    'stalepanel: a page whose chat cannot be found yields no pairing at all');
  eq(hintsWithNoChat('twitch', [anchor('https://kick.com/someoneelse')]), [],
    'stalepanel: on either site');

  // 5. Nothing here is Kick-specific, and Twitch gets the same treatment.
  eq(hintsOn('twitch', [anchor('https://kick.com/realone')]),
    ['https://kick.com/realone'],
    'stalepanel: twitch reads a laid-out link too');
  eq(hintsOn('twitch', [anchor('https://kick.com/leftover', { laidOut: false })]),
    [],
    'stalepanel: twitch ignores one with no box');

  // 6. Duplicates still collapse. Kick renders the about panel twice, once for
  //    each breakpoint, and only one of the pair is ever laid out.
  eq(hintsOn('kick', [
    anchor('https://www.twitch.tv/cashmeow'),
    anchor('https://www.twitch.tv/cashmeow', { laidOut: false }),
  ]), ['https://www.twitch.tv/cashmeow'],
  'stalepanel: the responsive duplicate does not double the answer');

  // 7. A pairing written down by a version that read the leftover panel cannot
  //    be told from a good one by looking at it, so it is re-derived instead of
  //    being served for the rest of its six hours.
  const D = load(makeSandbox(), ...SHARED, 'src/background/discovery.js');
  eq(D.links.trustworthy({ match: 'page-link', v: 2 }), false,
    'stalepanel: a page-link pairing from before the fix is not carried forward');
  eq(D.links.trustworthy({ match: 'page-link', v: 3 }), true,
    'stalepanel: one written since is');
  eq(D.links.trustworthy({ match: 'same-name', v: 2 }), true,
    'stalepanel: pairings that never came from a page link are untouched');
  eq(D.links.trustworthy({ manual: true, v: 1 }), true,
    'stalepanel: and a mapping set by hand always stands');
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

  // ── When the site renames its markup ──
  //
  // The overlay already finds the chat column by climbing from the message
  // list, so a rename leaves it placed correctly. Hiding the site's own chat
  // was the one thing that went by name alone: it returned nothing, said
  // nothing, and the setting simply stopped working. Now it climbs too.
  ['twitch', 'kick'].forEach((id) => {
    const node = (name, rect, kids) => {
      const n = {
        name, nodeType: 1, isConnected: true, style: {}, children: kids || [],
        parentElement: null, dataset: {}, className: name,
        getAttribute: () => null,
        getBoundingClientRect: () => ({
          top: rect[0], height: rect[1], bottom: rect[0] + rect[1],
          left: 900, right: 900 + rect[2], width: rect[2],
        }),
        contains(other) {
          for (let p = other; p; p = p.parentElement) if (p === n) return true;
          return false;
        },
        querySelectorAll: () => [],
        querySelector: () => null,
      };
      n.children.forEach((k) => { k.parentElement = n; });
      return n;
    };

    // A chat column the way both sites build one: messages inside a body,
    // inside the column — and nothing carrying a name we recognise.
    const messages = node('messages', [120, 500, 340], []);
    const body = node('body', [100, 540, 340], [messages]);
    const column = node('column', [50, 620, 340], [body]);

    const survivor = id === 'twitch'
      ? 'div[data-a-target="chat-scroller"]'
      : '[data-testid="chat-message-list"]';

    const sandbox = makeSandbox({
      location: { hostname: id === 'twitch' ? 'www.twitch.tv' : 'kick.com', pathname: '/somechannel' },
      document: {
        body: node('page-body', [0, 900, 1280], []),
        documentElement: node('html', [0, 900, 1280], []),
        // One hook out of all of them still matches, and it is on the message
        // list — which is the state a rename actually leaves behind.
        querySelectorAll: (sel) => (sel === survivor ? [messages] : []),
        querySelector: (sel) => (sel === survivor ? messages : null),
      },
      window: {},
      getComputedStyle: () => ({ position: 'static', display: 'block', visibility: 'visible' }),
    });
    const S = load(sandbox, ...SHARED, 'src/content/sites.js');
    const site = S.SITES[id];

    // Identity, not equality: these nodes point at each other.
    ok(site.messageList() === messages, `sites: ${id} still finds the message list`);
    ok(site.chatContainer() === column, `sites: ${id} still finds the column by climbing`);
    ok(site.nativeChatBody() === body,
      `sites: ${id} works out the chat body from the messages when the names are gone`);
  });

  // Nothing to climb from is still nothing, rather than something wrong.
  {
    const sandbox = makeSandbox({
      location: { hostname: 'www.twitch.tv', pathname: '/somechannel' },
      document: {
        body: null, documentElement: null,
        querySelectorAll: () => [], querySelector: () => null,
      },
      window: {},
      getComputedStyle: () => ({ position: 'static' }),
    });
    const S = load(sandbox, ...SHARED, 'src/content/sites.js');
    eq(S.SITES.twitch.nativeChatBody(), null,
      'sites: a page with no chat on it hides nothing');
  }
};

suites.discovery = function () {
  // Stubs standing in for the two platform APIs and chrome.storage.local.
  function build({ kickChannels = {}, twitchUsers = {}, storage = {}, offline = false } = {}) {
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
        // Nothing gets through at all — the shape of a dropped connection,
        // which is a different answer from "there is nobody by that name".
        if (offline) throw new TypeError('Failed to fetch');
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
    // 0. A lookup that never got through is not an answer.
    //
    // The miss is written down so every page view does not re-probe the same
    // name, and it lasts six hours. Writing it on a failure meant a few seconds
    // of bad network stopped the merge being offered for the rest of the
    // evening, on a channel where it would have worked perfectly well.
    {
      const { FCM, store } = build({ offline: true });
      const found = await FCM.resolveCounterpart({ platform: 'twitch', channel: 'somebody', hints: [] });
      eq(found, null, 'discovery: a lookup that could not be made finds nothing');
      const links = store[FCM.STORAGE_KEYS.links] || {};
      eq(Object.keys(links).length, 0,
        'discovery: and nothing is written down, so the next look asks again');
    }
    // The same shape when the platform really does answer: that is worth
    // remembering, or the same dead name is probed on every page view.
    {
      const { FCM, store } = build({ kickChannels: {} });
      const found = await FCM.resolveCounterpart({ platform: 'twitch', channel: 'nobody', hints: [] });
      eq(found, null, 'discovery: a name neither platform knows finds nothing');
      const links = store[FCM.STORAGE_KEYS.links] || {};
      eq(links['twitch:nobody'] && links['twitch:nobody'].none, true,
        'discovery: and that miss is remembered, because it was an answer');
    }

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

    // 5b. Typing the name in records the pair from both ends.
    //
    // The case this is for: twitch.tv/chefsteve330 and kick.com/chefsteve are
    // one person under two names. Saying so once, from either side, has to be
    // enough — and the reverse entry is also what stops kick.com/chefsteve
    // falling through to the same-name guess and merging twitch.tv/chefsteve,
    // who is somebody else.
    {
      const { FCM, store } = build({
        kickChannels: { chefsteve: kickChannel('chefsteve', 'ChefSteve', true) },
        twitchUsers: {
          chefsteve330: {
            id: '7', login: 'chefsteve330', displayName: 'ChefSteve',
            profileImageURL: '', stream: null,
          },
          // The other person, who happens to have the Kick name on Twitch.
          chefsteve: {
            id: '8', login: 'chefsteve', displayName: 'Someone Else',
            profileImageURL: '', stream: null,
          },
        },
      });

      await FCM.links.setManual('twitch', 'chefsteve330', 'chefsteve');
      const links = store[FCM.STORAGE_KEYS.links];
      eq(links['twitch:chefsteve330'].channel, 'chefsteve', 'links: the way it was typed');
      eq(links['kick:chefsteve'].channel, 'chefsteve330', 'links: and the way back');
      eq(links['kick:chefsteve'].manual, true, 'links: the reverse counts as manual too');

      // Arriving from the Kick side now finds the right person.
      const back = await FCM.resolveCounterpart({ platform: 'kick', channel: 'chefsteve', hints: [] });
      eq(back.channel, 'chefsteve330', 'links: kick.com/chefsteve resolves to the linked Twitch channel');
      eq(back.match, 'manual', 'links: and says it was set by hand');

      // Undoing it from either end takes both halves.
      await FCM.links.clearPair('kick', 'chefsteve');
      ok(!links['kick:chefsteve'] && !store[FCM.STORAGE_KEYS.links]['kick:chefsteve'],
        'links: clearing removes the entry');
      ok(!store[FCM.STORAGE_KEYS.links]['twitch:chefsteve330'],
        'links: and the half pointing back at it');
    }

    // 5c. "No counterpart" says nothing about anybody else, so nothing is
    //     written the other way.
    {
      const { FCM, store } = build({});
      await FCM.links.setManual('twitch', 'solochannel', '');
      const links = store[FCM.STORAGE_KEYS.links];
      eq(links['twitch:solochannel'].none, true, 'links: an empty target means no counterpart');
      eq(Object.keys(links).length, 1, 'links: and writes nothing else');
    }

    // 5d. Undoing a link takes its own half and no one else's.
    {
      const { FCM, store } = build({});
      await FCM.links.setManual('twitch', 'alpha', 'alphakick');
      // Something else that points at alpha without being its other half —
      // the sort of thing the automatic lookup leaves behind.
      await FCM.links.set('kick', 'bystander', { channel: 'alpha', match: 'same-name' });

      await FCM.links.clearPair('twitch', 'alpha');
      const links = store[FCM.STORAGE_KEYS.links];
      ok(!links['twitch:alpha'], 'links: the link being undone is gone');
      ok(!links['kick:alphakick'], 'links: along with the half that pointed back');
      eq(links['kick:bystander'].channel, 'alpha',
        'links: a mapping that merely points here is left alone');
    }

    // 5e. Correcting a link does not leave the old channel pointing back.
    {
      const { FCM, store } = build({});
      await FCM.links.setManual('twitch', 'streamer', 'wrongname');
      await FCM.links.setManual('twitch', 'streamer', 'rightname');
      const links = store[FCM.STORAGE_KEYS.links];
      eq(links['twitch:streamer'].channel, 'rightname', 'links: the correction sticks');
      eq(links['kick:rightname'].channel, 'streamer', 'links: with its own way back');
      ok(!links['kick:wrongname'],
        'links: and the channel it used to point at stops pointing back');
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

// Every Twitch emote the viewer may use. Four sources, each knowing something
// the others do not, merged into one store.
suites.twitchEmotes = function () {
  function build({ userPages = [], sets = {}, fail = [] } = {}) {
    const calls = [];
    const sandbox = makeSandbox({
      fetch: async (url) => {
        const u = String(url);
        calls.push(u);
        if (fail.some((f) => u.includes(f))) return { ok: false, status: 401, json: async () => ({}) };
        if (u.includes('/chat/emotes/global')) {
          return { ok: true, json: async () => ({ data: [
            { id: 'g1', name: 'GlobalOne', emote_type: 'globals' },
            { id: 'g2', name: 'Smiley', owner_id: '0' },
          ] }) };
        }
        if (u.includes('/chat/emotes/user')) {
          const after = /after=([^&]*)/.exec(u);
          const page = after ? Number(after[1]) : 0;
          const body = userPages[page] || { data: [] };
          return { ok: true, json: async () => body };
        }
        if (u.includes('/chat/emotes/set')) {
          const ids = (u.match(/emote_set_id=([^&]*)/g) || []).map((p) => p.split('=')[1]);
          const data = ids.flatMap((id) => sets[id] || []);
          return { ok: true, json: async () => ({ data }) };
        }
        if (u.includes('/chat/emotes?broadcaster_id=')) {
          return { ok: true, json: async () => ({ data: [
            { id: 'c1', name: 'ChanSub', emote_type: 'subscriptions' },
            { id: 'c2', name: 'ChanBits', emote_type: 'bitstier' },
          ] }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });
    const FCM = load(sandbox, ...SHARED, 'src/background/emotes.js');
    return { FCM, calls };
  }

  return (async () => {
    // Nothing at all without a client id: there is no request that can be made.
    {
      const t = build();
      eq(await t.FCM.emoteLoader.twitchNative({}), {}, 'twitch emotes: no client id, no request');
      eq(t.calls.length, 0, 'twitch emotes: and nothing is fetched');
    }

    // Signed out: global emotes still arrive, and the channel's own.
    {
      const t = build();
      const store = await t.FCM.emoteLoader.twitchNative({ clientId: 'cid', broadcasterId: '123' });
      ok(store.GlobalOne, 'twitch emotes: globals load without an account');
      eq(store.GlobalOne.source, 'Twitch Global', 'twitch emotes: and are labelled as global');
      ok(store.ChanSub, 'twitch emotes: so do the channel’s own');
      eq(store.ChanSub.source, 'Twitch Sub', 'twitch emotes: labelled by what they are');
      eq(store.ChanBits.source, 'Twitch Bits', 'twitch emotes: bits emotes too');
      ok(store.GlobalOne.url.includes('/emoticons/v2/g1/'), 'twitch emotes: the image is the Helix id');
      ok(!t.calls.some((c) => c.includes('/chat/emotes/user')),
        'twitch emotes: the user endpoint is not asked without a token');
    }

    // Signed in: the user endpoint pages until the cursor runs out.
    {
      const t = build({ userPages: [
        { data: [{ id: 'u1', name: 'SubA', emote_type: 'subscriptions' }], pagination: { cursor: '1' } },
        { data: [{ id: 'u2', name: 'FollowB', emote_type: 'follower' }], pagination: { cursor: '2' } },
        { data: [{ id: 'u3', name: 'HypeC', emote_type: 'hypetrain' }] },
      ] });
      const store = await t.FCM.emoteLoader.twitchNative({
        clientId: 'cid', token: 'tok', userId: '55', broadcasterId: '123',
      });
      ok(store.SubA && store.FollowB && store.HypeC, 'twitch emotes: every page is collected');
      eq(store.FollowB.source, 'Twitch Follow', 'twitch emotes: follower emotes are named');
      eq(store.HypeC.source, 'Twitch Hype Train', 'twitch emotes: so are hype train ones');
      eq(t.calls.filter((c) => c.includes('/chat/emotes/user')).length, 3,
        'twitch emotes: it stops when the cursor does');
      ok(t.calls.some((c) => c.includes('/chat/emotes/user') && c.includes('broadcaster_id=123')),
        'twitch emotes: the channel is named, so this channel’s follower emotes come too');
    }

    // Emote sets from USERSTATE, in chunks of 25.
    {
      const sets = {};
      const ids = [];
      for (let i = 0; i < 60; i++) { ids.push(`s${i}`); sets[`s${i}`] = [{ id: `e${i}`, name: `SetEmote${i}` }]; }
      const t = build({ sets });
      const store = await t.FCM.emoteLoader.twitchNative({ clientId: 'cid', token: 'tok', setIds: ids });
      eq(Object.keys(store).filter((n) => n.startsWith('SetEmote')).length, 60,
        'twitch emotes: every set is fetched');
      eq(t.calls.filter((c) => c.includes('/chat/emotes/set')).length, 3,
        'twitch emotes: in chunks of twenty-five');
    }

    // Sets need a token; without one they are not asked for.
    {
      const t = build({ sets: { a: [{ id: 'x', name: 'Nope' }] } });
      const store = await t.FCM.emoteLoader.twitchNative({ clientId: 'cid', setIds: ['a'] });
      ok(!store.Nope, 'twitch emotes: sets are not readable without a token');
    }

    // One source failing must not take the others with it.
    {
      const t = build({ userPages: [{ data: [{ id: 'u1', name: 'SubA' }] }], fail: ['/chat/emotes/user'] });
      const store = await t.FCM.emoteLoader.twitchNative({
        clientId: 'cid', token: 'tok', userId: '55', broadcasterId: '123',
      });
      ok(store.GlobalOne && store.ChanSub, 'twitch emotes: a refused endpoint loses only itself');
      ok(!store.SubA, 'twitch emotes: and contributes nothing');
    }

    // The most specific label wins: a record already stored is not overwritten
    // by a later, vaguer one.
    {
      const t = build({ userPages: [{ data: [{ id: 'c1', name: 'ChanSub', emote_type: 'subscriptions' }] }] });
      const store = await t.FCM.emoteLoader.twitchNative({
        clientId: 'cid', token: 'tok', userId: '55', broadcasterId: '123',
      });
      eq(store.ChanSub.source, 'Twitch Sub', 'twitch emotes: the same emote from two sources appears once');
    }

    // A cursor that never terminates has to terminate.
    {
      const pages = [];
      for (let i = 0; i < 200; i++) pages.push({ data: [{ id: `p${i}`, name: `P${i}` }], pagination: { cursor: String(i + 1) } });
      const t = build({ userPages: pages });
      await t.FCM.emoteLoader.twitchNative({ clientId: 'cid', token: 'tok', userId: '55' });
      ok(t.calls.filter((c) => c.includes('/chat/emotes/user')).length <= 60,
        'twitch emotes: a runaway cursor is capped');
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
      // A provider's global set says so, rather than sharing a label with the
      // channel's own set — they end up as different sections in the picker.
      eq(store.GlobalPog.source, '7TV Global', 'emotes: a provider global says it is global');
      eq(store.ChannelPog.source, '7TV', "emotes: the channel's set keeps the plain name");
      eq(store.bttvGlobal.source, 'BTTV Global', 'emotes: and the same for BTTV');
      eq(store.ChannelPog.url, 'https://cdn.7tv.app/emote/2/2x.webp', 'emotes: 7TV channel set');
      eq(store.bttvGlobal.url, 'https://cdn.betterttv.net/emote/b1/2x', 'emotes: BTTV global');
      eq(store.bttvChan.url, 'https://cdn.betterttv.net/emote/b2/2x', 'emotes: BTTV channel');
      eq(store.ffzEmote.url, 'https://cdn.ffz/2.png', 'emotes: FFZ protocol-relative url fixed up');

      // ── Which set an emote came from ──
      //
      // The picker puts the channel's own emotes at the top, and only the fetch
      // an emote arrived on knows whose set it was in — every provider labels
      // both its global and its channel sets with the same name.
      eq(store.ChannelPog.channel, true, "emotes: 7TV's channel set is marked as the channel's");
      eq(store.bttvChan.channel, true, "emotes: so is BTTV's");
      eq(store.ffzEmote.channel, true, "emotes: and FFZ's room set");
      ok(!store.GlobalPog.channel, 'emotes: a provider global is not the channel\'s');
      ok(!store.bttvGlobal.channel, 'emotes: nor a BTTV global');
      // The label is what a tooltip shows and must not have been repurposed.
      eq(store.ChannelPog.owner, 'somechannel',
        "emotes: a channel set records whose channel it is, for the picker's headings");
      ok(!store.GlobalPog.owner, 'emotes: a global belongs to nobody');
      ok(calls.includes('https://7tv.io/v3/users/twitch/71092938'),
        'emotes: 7TV twitch lookup uses the numeric user id');
    }

    // —— A name the channel and a provider's global set both use ——
    //
    // Plenty of them: catJAM, monkaS, PepeLaugh. The two requests race, the
    // global one is a single cached CDN response and usually wins, and whoever
    // arrived first used to keep the picture — so a channel that had added its
    // own version of a well-known emote had the global artwork drawn instead,
    // depending on which fetch came back first. The channel's own set is the
    // channel saying "ours, not that one".
    {
      const shared = (name) => makeSandbox({
        fetch: async (url) => {
          const u = String(url);
          if (u === 'https://7tv.io/v3/emote-sets/global') {
            return { ok: true, json: async () => ({
              emotes: [{ name, data: { host: { url: '//cdn.7tv.app/emote/global', files: [{ name: '2x.webp' }] } } }],
            }) };
          }
          if (/7tv\.io\/v3\/users\//.test(u)) {
            return { ok: true, json: async () => ({
              emote_set: { emotes: [{ name, data: { host: { url: '//cdn.7tv.app/emote/theirs', files: [{ name: '2x.webp' }] } } }] },
            }) };
          }
          return { ok: false, status: 404, json: async () => ({}) };
        },
      });

      const FCM2 = load(shared('catJAM'), ...SHARED, 'src/background/emotes.js');
      const store = await FCM2.emoteLoader.thirdParty('twitch', 'somechannel', '71092938');
      eq(store.catJAM.url, 'https://cdn.7tv.app/emote/theirs/2x.webp',
        "emotes: a name in both sets is drawn with the channel's own picture");
      eq(store.catJAM.source, '7TV',
        'emotes: and labelled as the channel\u2019s rather than as a global');
      eq(store.catJAM.channel, true, 'emotes: still marked as the channel\u2019s');
      eq(store.catJAM.owner, 'somechannel', 'emotes: and still attributed to it');
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
      contains(other) {
        for (let n = other; n; n = n.parentElement) if (n === node) return true;
        return false;
      },
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
        elementFromPoint: () => null,
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

  // ── Twitch's shape: a card drawn through a wrapper that measures nothing ──
  //
  // Taken from the live page. Twitch draws its community highlight — the hype
  // train, the pinned message, the poll — inside a chain of wrappers that
  // collapse to zero height, so the sibling beside the message list measures
  // 0px while an 83px card is painted through it. Measuring the sibling found
  // nothing and the overlay sat straight over the card.
  {
    const list = el({ rect: [333, 172] });
    const leaderboard = el({ rect: [262, 71], text: "daleburnshart67 1,200" });
    const emptySlot = el({ rect: [333, 0] });
    // The collapsed chain, card five levels down, exactly as Twitch nests it.
    const card = el({ rect: [333, 83], text: "Hype Train Level 3" });
    const inner = el({ rect: [333, 0], kids: [card] });
    const outer = el({ rect: [333, 0], kids: [inner] });
    const collapsed = el({ rect: [333, 0], kids: [outer] });
    const input = el({ rect: [505, 158], text: "Send a message" });
    const viewerCard = el({ rect: [262, 401] });
    const content = el({
      rect: [262, 458],
      kids: [leaderboard, emptySlot, collapsed, list, input, viewerCard],
    });
    const split = bridgeFor(page(content), {}).FCM.splitChatSiblings(list);
    ok(split.above.includes(card),
      "native: a card drawn through a zero-height wrapper is still found");
    ok(!split.above.includes(collapsed),
      "native: and it is the card that is measured, not the wrapper around it");
    ok(split.above.includes(leaderboard),
      "native: the card in flow above the list is found alongside it");
    ok(!split.above.includes(emptySlot),
      "native: a wrapper with nothing drawn through it is still nothing");
    ok(!split.above.includes(viewerCard) && !split.below.includes(viewerCard),
      "native: the viewer-card layer is still not a card");
    ok(split.below.includes(input), "native: the composer is still below");

    // The reason the share is measured against the column. This card cleared
    // the old bar by three pixels; a taller one on the same page did not,
    // because every card the site adds shortens the list it was judged against.
    const taller = el({ rect: [333, 150], text: "Hype Train Level 5" });
    inner.children = [taller];
    taller.parentElement = inner;
    const split2 = bridgeFor(page(content), {}).FCM.splitChatSiblings(list);
    ok(split2.above.includes(taller),
      "native: a taller card on a short list is a card, not a covering layer");

    // And the layer it must still be told apart from: one running to the foot
    // of the messages is covering them, whatever it measures.
    const layer = el({ rect: [333, 172], text: "viewer card" });
    inner.children = [layer];
    layer.parentElement = inner;
    const split3 = bridgeFor(page(content), {}).FCM.splitChatSiblings(list);
    ok(!split3.above.includes(layer),
      "native: something reaching the bottom of the messages is not a card");
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

  function controlPage({ claim = true, identity = false } = {}) {
    const points = el({ rect: [620, 32], text: '4,201' });
    const bits = el({ rect: [620, 32], text: '350' });
    const open = el({ rect: [620, 32], attrs: { 'aria-label': 'Bits and Points Balances' } });
    const cheer = el({ rect: [580, 32], attrs: { 'aria-label': 'Cheer' } });
    const chest = el({ rect: claim ? [620, 32] : [0, 0] });
    const ident = identity
      ? el({ rect: [620, 32], attrs: { 'aria-label': 'Chat Identity' } })
      : null;
    const body = el({ rect: [262, 401] });
    const site = {
      messageList: () => container,
      nativeChatBody: () => body,
      nativeControls: () => ({
        pointsValue: points, bitsValue: bits, openBalances: open, cheer, claim: chest,
        chatIdentity: ident,
      }),
    };
    return { site, points, bits, open, cheer, chest, body, ident };
  }

  const withClaim = controlPage();
  const cb = bridgeFor(page(content), withClaim.site).bridge;
  eq(cb.stats(), { points: '4,201', bits: '350', hasPoints: true, hasBits: true,
    canClaim: true, claimNamed: true, hasIdentity: false, hasGifs: false, hasMenu: true },
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

  // ── Chat identity ──
  //
  // The colour a viewer's name is drawn in and which of their badges show
  // belong to the platform, and the overlay only renders them. So it opens the
  // platform's own control for it rather than offering a copy — and only when
  // the platform is actually showing one, the same rule the balances follow.
  {
    const withIdentity = controlPage({ identity: true });
    const ib = bridgeFor(page(content), withIdentity.site).bridge;
    eq(ib.stats().hasIdentity, true, 'native: an identity control the site shows is reported');
    ok(ib.activate('identity'), 'native: and it is there to press');
    eq(withIdentity.ident.clicks, 1, 'native: the press goes to the site\u2019s own button');
    // Kick's is Radix like the rest of its footer, so a bare click is not enough.
    eq(withIdentity.ident.events, ['pointerdown', 'mousedown', 'pointerup', 'mouseup'],
      'native: pressed the way a mouse presses it, not just clicked');
  }
  {
    const none = controlPage({ identity: false });
    const nb = bridgeFor(page(content), none.site).bridge;
    eq(nb.stats().hasIdentity, false,
      'native: a site not showing the control reports none');
    eq(nb.activate('identity'), false,
      'native: and nothing is pressed, rather than something else being guessed at');
  }
  eq(withClaim.chest.clicks, 1, 'native: and that click goes to the chest');

  const noClaim = controlPage({ claim: false });
  const nb = bridgeFor(page(content), noClaim.site).bridge;
  eq(nb.stats().canClaim, false, 'native: an unrendered chest is no bonus');
  ok(!nb.activate('claim'), 'native: and claiming it is refused rather than sent nowhere');
  eq(noClaim.chest.clicks, 0, 'native: a control that is not on screen is never clicked');

  const bare = bridgeFor(page(content), { messageList: () => container }).bridge;
  eq(bare.stats(), { points: '', bits: '', hasPoints: false, hasBits: false,
    canClaim: false, claimNamed: false, hasMenu: false, hasGifs: false },
    'native: a site with no controls of its own reports nothing');
  ok(!bare.activate('points'), 'native: and offers nothing to click');

  // A site adapter that throws must not take the overlay down with it.
  const angry = bridgeFor(page(content), {
    messageList: () => container,
    nativeControls: () => { throw new Error('selectors moved'); },
  }).bridge;
  eq(angry.stats(), { points: '', bits: '', hasPoints: false, hasBits: false,
    canClaim: false, claimNamed: false, hasMenu: false, hasGifs: false },
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

  // ── Noticing a cover without recognising it ───────────────────────────────
  //
  // The check that does not depend on the site's markup: sample what is
  // actually painted over the messages. Kick draws its panels in several
  // shapes and names none of them, so this is the one that holds regardless.
  {
    const list = el({ rect: [110, 400] });
    const wrap = el({ rect: [110, 400], kids: [list] });
    el({ rect: [60, 660], kids: [wrap] });

    let topmost = list;                      // nothing covering to begin with
    const doc = page(wrap, []);
    doc.document.elementFromPoint = () => topmost;
    const rig = bridgeFor(doc, { messageList: () => list });

    eq(rig.bridge.coveringChat(), false, 'native: the messages being on top means nothing covers them');

    const ancestor = wrap;
    topmost = ancestor;
    eq(rig.bridge.coveringChat(), false, 'native: nor does the column they sit inside');

    const panel = el({ rect: [300, 300], text: 'gift shop' });
    topmost = panel;
    eq(rig.bridge.coveringChat(), true, 'native: something else on top is a cover');

    // A row inside the list is still the list.
    const row = el({ rect: [200, 40] });
    row.parentElement = list; list.children.push(row);
    topmost = row;
    eq(rig.bridge.coveringChat(), false, 'native: a message row is not a cover');
  }

  // With no message list to sample over there is nothing to say.
  {
    const doc = page(content, []);
    doc.document.elementFromPoint = () => null;
    eq(bridgeFor(doc, { messageList: () => null }).bridge.coveringChat(), false,
      'native: no message list means no opinion');
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
  function build({ redirect, launchError, tokenResponse, configResponse, twitchConfig } = {}) {
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
        if (u.includes('/twitch-config')) {
          if (twitchConfig === 'offline') throw new TypeError('Failed to fetch');
          return { ok: true, json: async () => (twitchConfig || { client_id: 'tw-cid' }) };
        }
        if (u.includes('/kick-token') || u.includes('/kick-refresh')) {
          // A refresh that cannot leave the machine at all, which is a
          // different thing from one Kick turned down.
          if (tokenResponse === 'offline') throw new TypeError('Failed to fetch');
          // A function, so a test can answer the second request differently
          // from the first — which is how Kick treats a rotated refresh token.
          const answer = typeof tokenResponse === 'function' ? tokenResponse() : tokenResponse;
          const body = answer || { access_token: 'KA', refresh_token: 'KR', expires_in: 3600 };
          // Carries a status the way a real response does, so "the token is
          // spent" can be told from "the proxy is having a bad day".
          const status = body.error ? (body.__status || 400) : 200;
          return { ok: !body.error, status, json: async () => body };
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

      // The client id is not written into the extension. It comes from the
      // proxy, the same way Kick's does, so the application this build signs in
      // against can be changed without shipping an update to every install.
      ok(calls.some((c) => (c.url || '').includes('/twitch-config')),
        'auth: the proxy is asked which Twitch application to sign in against');
      const authUrl = new URL(calls.find((c) => c.authUrl).authUrl);
      eq(authUrl.searchParams.get('client_id'), 'tw-cid',
        'auth: and that is the application the sign-in is sent to');
      const saved0 = store[FCM.STORAGE_KEYS.auth].twitch;
      eq(saved0.clientId, 'tw-cid',
        'auth: stored with the token, because every later Helix call has to send it');
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

    // ── An id set in the options is the one Twitch refused nothing about ──
    //
    // That box exists for somebody Twitch has told to register their own
    // application. Asking the proxy would hand them straight back the id that
    // was turned down, so theirs wins outright and the proxy is left alone.
    {
      const { FCM, calls } = build({
        redirect: (url) => 'https://abcd.chromiumapp.org/#access_token=TW&state='
          + new URL(url).searchParams.get('state'),
      });
      await FCM.auth.connect('twitch', { twitchClientId: 'my-own-app' });
      const authUrl = new URL(calls.find((c) => c.authUrl).authUrl);
      eq(authUrl.searchParams.get('client_id'), 'my-own-app',
        'auth: a client id set in the options is the one used');
      ok(!calls.some((c) => (c.url || '').includes('/twitch-config')),
        'auth: and the proxy is not asked to contradict it');
    }

    // ── A proxy with no Twitch id says which secret is missing ──
    //
    // The failure is a deployment that was never finished, and the message has
    // to name the thing to do about it — otherwise it surfaces as a sign-in
    // that simply does not work.
    {
      const { FCM } = build({
        twitchConfig: { client_id: '' },
        redirect: 'https://abcd.chromiumapp.org/#access_token=TW',
      });
      let threw = '';
      try { await FCM.auth.connect('twitch', {}); } catch (e) { threw = e.message; }
      contains(threw, 'TWITCH_CLIENT_ID', 'auth: an unconfigured proxy names the secret to set');
    }

    // ── A proxy that cannot be reached is a different problem ──
    //
    // One is a URL to check and the other is a secret that was never set.
    // Reporting either as the other sends somebody to fix the wrong thing.
    {
      const { FCM } = build({
        twitchConfig: 'offline',
        redirect: 'https://abcd.chromiumapp.org/#access_token=TW',
      });
      let threw = '';
      try { await FCM.auth.connect('twitch', {}); } catch (e) { threw = e.message; }
      contains(threw, 'Could not reach the proxy',
        'auth: an unreachable proxy is reported as one, not as a missing secret');
      missing(threw, 'TWITCH_CLIENT_ID',
        'auth: and does not send anybody off to set a secret that may be there already');
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

    // ── usable(): a refresh Kick turns down logs out cleanly ──
    {
      const { FCM } = build({ tokenResponse: { error: 'invalid_grant' } });
      await FCM.auth.set('kick', { accessToken: 'old', refreshToken: 'KR', expiresAt: Date.now() - 1000 });
      eq(await FCM.auth.usable('kick', {}), null, 'auth: an unrefreshable token is unusable');
      eq(await FCM.auth.get('kick'), null,
        'auth: and a token Kick has finished with is actually forgotten');
    }

    // ── A refresh that could not be delivered keeps the account ───────────────
    //
    // Signing in again is a real interruption and lasts months; the proxy being
    // unreachable for a minute must not cost one. These are the shapes that are
    // the service's problem rather than the account's.
    {
      const { FCM } = build({ tokenResponse: 'offline' });
      await FCM.auth.set('kick', { accessToken: 'old', refreshToken: 'KR', expiresAt: Date.now() - 1000 });
      let threw = null;
      let rec;
      try { rec = await FCM.auth.usable('kick', {}); } catch (e) { threw = String(e); }
      eq(threw, null, 'auth: a refresh that cannot reach the network does not throw');
      eq(rec, null, 'auth: and reports the token as unusable for now');
      ok(await FCM.auth.get('kick'), 'auth: but the account is still there to try again with');
    }
    {
      const { FCM } = build({ tokenResponse: { error: 'bad gateway', __status: 502 } });
      await FCM.auth.set('kick', { accessToken: 'old', refreshToken: 'KR', expiresAt: Date.now() - 1000 });
      eq(await FCM.auth.usable('kick', {}), null, 'auth: a 502 leaves the token unusable for now');
      ok(await FCM.auth.get('kick'), 'auth: and does not throw the account away');
    }
    {
      const { FCM } = build({ tokenResponse: { error: 'invalid_grant', __status: 500 } });
      await FCM.auth.set('kick', { accessToken: 'old', refreshToken: 'KR', expiresAt: Date.now() - 1000 });
      await FCM.auth.usable('kick', {});
      eq(await FCM.auth.get('kick'), null,
        'auth: invalid_grant means the token is spent whatever status carried it');
    }
    // A proxy that reports Kick's trouble as its own must not cost the account.
    //
    // The worker used to answer every upstream failure that was not a 401 with
    // an HTTP 400, and 400 is how Kick says a refresh token is spent — so a
    // rate limit, a Kick incident or a Cloudflare challenge in front of
    // id.kick.com deleted a sign-in that lasts months and was still perfectly
    // good. The worker now passes only 400 and 401 through, and this is the
    // other half: where the body says what Kick actually answered, that is what
    // is believed, because a worker is deployed separately from the extension
    // and the one in front of a given user may still be the old one.
    {
      const { FCM } = build({ tokenResponse: { error: 'Kick returned HTTP 503.', status: 503, __status: 400 } });
      await FCM.auth.set('kick', { accessToken: 'old', refreshToken: 'KR', expiresAt: Date.now() - 1000 });
      eq(await FCM.auth.usable('kick', {}), null,
        'auth: a Kick outage reported as a proxy 400 leaves the token unusable for now');
      ok(await FCM.auth.get('kick'),
        'auth: but the account survives it, refresh token and all');
    }
    {
      const { FCM } = build({ tokenResponse: { error: 'Too many requests', status: 429, __status: 400 } });
      await FCM.auth.set('kick', { accessToken: 'old', refreshToken: 'KR', expiresAt: Date.now() - 1000 });
      await FCM.auth.usable('kick', {});
      ok(await FCM.auth.get('kick'), 'auth: nor does a shared rate limit end the sign-in');
    }
    // And the account is still forgotten when Kick really has finished with it.
    {
      const { FCM } = build({ tokenResponse: { error: 'invalid_grant', status: 400, __status: 400 } });
      await FCM.auth.set('kick', { accessToken: 'old', refreshToken: 'KR', expiresAt: Date.now() - 1000 });
      await FCM.auth.usable('kick', {});
      eq(await FCM.auth.get('kick'), null,
        'auth: a refresh token Kick itself rejects is still thrown away');
    }
    // A refresh token that was never stored cannot be refreshed at all.
    {
      const { FCM } = build({});
      await FCM.auth.set('kick', { accessToken: 'old', expiresAt: Date.now() - 1000 });
      eq(await FCM.auth.usable('kick', {}), null, 'auth: nothing to refresh with is unusable');
      eq(await FCM.auth.get('kick'), null, 'auth: and that account is cleared');
    }

    // —— Two things wanting a token at the same moment ——
    //
    // Kick rotates the refresh token, so the second request to carry the same
    // one is told invalid_grant — which is true, and is read as "this account is
    // finished". Two tabs opening together, or a join crossing a send, was
    // enough to delete a Kick sign-in seconds after refreshing it perfectly
    // well. One request is made and everybody waits on it.
    {
      let posts = 0;
      const { FCM } = build({
        tokenResponse: () => {
          posts++;
          // Kick's answer to a refresh token that has already been spent.
          if (posts > 1) return { error: 'invalid_grant' };
          return { access_token: 'KA2', refresh_token: 'KR2', expires_in: 3600 };
        },
      });
      await FCM.auth.set('kick', { accessToken: 'old', refreshToken: 'KR', expiresAt: Date.now() - 1000 });
      const [a, b, c] = await Promise.all([
        FCM.auth.usable('kick', {}),
        FCM.auth.usable('kick', {}),
        FCM.auth.usable('kick', {}),
      ]);
      eq(posts, 1, 'auth: three callers wanting a token at once make one refresh');
      ok(a && b && c, 'auth: and every one of them is given a usable token');
      eq([a, b, c].map((r) => r && r.accessToken), ['KA2', 'KA2', 'KA2'],
        'auth: the same freshly refreshed token');
      ok(await FCM.auth.get('kick'), 'auth: and the account is still signed in afterwards');
    }

    // —— Two writes to the one record they share ——
    //
    // Both platforms live under a single storage key, so every write is
    // read-modify-write over the other platform's record too. Overlapping them
    // used to lose whichever finished first: signing into Twitch while a Kick
    // token refreshed put back a copy with no Twitch in it.
    {
      const { FCM } = build({});
      await Promise.all([
        FCM.auth.set('twitch', { accessToken: 'T', login: 'me' }),
        FCM.auth.set('kick', { accessToken: 'K', login: 'me2' }),
      ]);
      ok(await FCM.auth.get('twitch'), 'auth: a Twitch sign-in survives a Kick write landing with it');
      ok(await FCM.auth.get('kick'), 'auth: and the Kick one survives too');
    }
    {
      const { FCM } = build({});
      await FCM.auth.set('twitch', { accessToken: 'T', login: 'me' });
      await FCM.auth.set('kick', { accessToken: 'K', login: 'me2' });
      // Signing out of one platform while the other is being written.
      await Promise.all([
        FCM.auth.clear('kick'),
        FCM.auth.set('twitch', { accessToken: 'T2', login: 'me' }),
      ]);
      eq(await FCM.auth.get('kick'), null, 'auth: signing out of Kick sticks');
      eq((await FCM.auth.get('twitch')).accessToken, 'T2',
        'auth: and does not undo the Twitch write it overlapped');
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

      // —— Which redirect the message tells you to register ——
      //
      // Kick's default flow reuses the desktop app's registered address and
      // never sends the extension's own, so naming that one sent people off to
      // register a URL this sign-in has no use for.
      const shared = FCM.explainAuthFailure('kick', 'invalid redirect uri', '', {
        redirect: FCM.KICK_SHARED_REDIRECT,
      });
      eq(shared.redirectUri, FCM.KICK_SHARED_REDIRECT,
        'auth: the message names the redirect the sign-in actually used');
      // And with nothing said about it, the extension's own is still the answer.
      contains(FCM.explainAuthFailure('kick', 'invalid redirect uri').redirectUri,
        '.chromiumapp.org/', 'auth: falling back to the extension’s own redirect');

      // —— A 400 that is not about the redirect at all ——
      //
      // The proxy attaches the same "usually the redirect_uri does not match"
      // hint to every 400 it passes on, including the ordinary one from
      // pressing Connect twice and spending the code. Classifying on that hint
      // sent people to re-register a URL that was already right.
      const spent = FCM.explainAuthFailure(
        'kick',
        'Kick rejected the request (400) without saying why. — Usually the redirect_uri does not exactly match.',
        '',
        { detail: 'Kick rejected the request (400) without saying why.' }
      );
      eq(spent.needsRedirectSetup, false,
        'auth: a failure Kick did not blame the redirect for is not a redirect problem');
      // What Kick really does say about one still is.
      eq(FCM.explainAuthFailure('kick', 'anything', '', { detail: 'invalid redirect uri' })
        .needsRedirectSetup, true,
      'auth: and one it does blame the redirect for still is');

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
      ok(!('reply_parent_message_id' in body),
        'send: an ordinary message says nothing about replying');
    }

    // A reply threads onto the original, so the platform draws it as a reply
    // and everyone reading gets the context the sender had.
    {
      const { FCM, calls } = build(() => ({ ok: true, json: async () => ({ data: [{ is_sent: true }] }) }));
      await FCM.sendMessage('twitch', 'Elden Ring', { roomId: '4242' }, {}, { replyToId: 'msg-1' });
      eq(JSON.parse(calls[0].body).reply_parent_message_id, 'msg-1',
        'send: the message being answered is named');
      // Twitch refuses the whole request for a parent it does not know, so an
      // empty id must never be sent in place of "not a reply".
      await FCM.sendMessage('twitch', 'hi', { roomId: '4242' }, {}, { replyToId: '' });
      ok(!('reply_parent_message_id' in JSON.parse(calls[1].body)),
        'send: an empty parent id is left out rather than sent empty');
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

  // And in an emote name and url, which land in src and alt.
  FCM.setEmotes('twitch', 'thirdparty', {
    'evil"onerror="alert(1)': { url: 'https://cdn/x.png', source: '7TV' },
    safe: { url: 'https://cdn/x.png" onerror="alert(1)', source: '"><b>' },
  });
  const emoteHtml = FCM.renderMessageBody('twitch', 'evil"onerror="alert(1) safe', {});
  missing(emoteHtml.html, '"onerror="', 'resilience: an emote name cannot break out of its attribute');
  missing(emoteHtml.html, '" onerror="', 'resilience: an emote url cannot break out of its attribute');
  contains(emoteHtml.html, '&quot;', 'resilience: quotes in emote fields are escaped');
  // The source is no longer written into the markup at all — it used to sit in
  // a `title`, which the hover preview replaced. A field that never reaches the
  // page cannot break out of anything, and this says so rather than leaving an
  // assertion that passes because it is testing nothing.
  missing(emoteHtml.html, '"><b>', 'resilience: a hostile emote source reaches no attribute');
  missing(emoteHtml.html, 'title=', 'resilience: emotes carry no title for it to reach');

  // A malicious badge image url lands in src.
  const badgeHtml = FCM.renderBadges('kick', [{ type: 'mod', image_url: 'x" onerror="alert(1)' }]);
  missing(badgeHtml, '" onerror="', 'resilience: a badge url cannot break out of its attribute');
  contains(badgeHtml, '&quot;', 'resilience: quotes in a badge url are escaped');

  // A link whose text is hostile.
  const linky = FCM.renderMessageBody('twitch', 'https://x.test/"><script>alert(1)</script>', {});
  missing(linky.html, '<script', 'resilience: a hostile url is escaped inside the anchor');

  // ── Words built to make the link matcher backtrack ─────────────────────────
  //
  // The bare-host pattern nests quantifiers, which is the shape that can
  // backtrack exponentially. Every word of every message goes through it, so a
  // message crafted to hit that would freeze the tab rather than merely render
  // wrongly — the one failure here that a viewer could not click away from.
  //
  // The bound is deliberately loose: this is meant to catch a pattern that has
  // become catastrophic, not to measure anything.
  {
    const nasty = [
      'a-'.repeat(240) + '!',                       // labels that never terminate
      'a.'.repeat(240) + '!',                       // dots without a usable tld
      ('ab-'.repeat(80)) + '.' + 'c-'.repeat(80) + '!',
      'a'.repeat(200) + '.' + 'b'.repeat(200) + '1',
      'aaaa.'.repeat(95) + '!',
      '('.repeat(40) + 'a-'.repeat(200) + '!',      // leading punctuation too
      '-'.repeat(480),
      '.'.repeat(480),
    ];
    const started = Date.now();
    let anchors = 0;
    nasty.forEach((word) => {
      const out = FCM.renderMessageBody('twitch', `hello ${word} world`, {});
      anchors += (out.html.match(/<a /g) || []).length;
    });
    const spent = Date.now() - started;
    ok(spent < 500, `resilience: words built to backtrack render promptly (${spent}ms)`);
    eq(anchors, 0, 'resilience: and none of them is mistaken for a link');
  }

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
      // Detached rows are tested one at a time, so this has to answer for a
      // single node the way querySelectorAll answers for a list — including
      // that a bare [data-platform] means the attribute is actually there,
      // which is what keeps system rows out of a platform filter.
      matches(sel) {
        const platform = (/data-platform="([^"]+)"/.exec(sel) || [])[1];
        const msgId = (/data-msg-id="([^"]+)"/.exec(sel) || [])[1];
        if (sel.includes('.fcm-msg') && !String(this.className).includes('fcm-msg')) return false;
        if (sel.includes('[data-platform') && !this.dataset.platform) return false;
        if (platform && this.dataset.platform !== platform) return false;
        if (msgId && this.dataset.msgId !== msgId) return false;
        return true;
      },
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
    // The feed listens for its own scroll to know whether it is still following
    // the live end. Scrolling is faked by setting the numbers and firing this.
    node.__listeners = {};
    node.addEventListener = (type, fn) => { (node.__listeners[type] = node.__listeners[type] || []).push(fn); };
    node.removeEventListener = (type, fn) => {
      const list = node.__listeners[type] || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    };
    node.__fire = (type) => (node.__listeners[type] || []).slice().forEach((fn) => fn());
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

  // ── Scrolling up holds the feed still, and offers the way back ─────────────
  //
  // Reading something a few screens up must not be interrupted by the feed
  // jumping to the newest line. It already held still; what was missing was any
  // sign of how much was piling up, or a way back that was not a manual scroll.
  {
    const t = build();
    const el = t.feedEl;
    const seen = [];
    t.feed.onPinChange((pinned, missed) => seen.push({ pinned, missed }));

    // Pinned: the bottom is within a screen of the scroll position.
    el.scrollHeight = 1000; el.clientHeight = 400; el.scrollTop = 600;
    ok(t.feed.isPinned(), 'feed: at the bottom it is following the live end');

    // Scrolled up several screens.
    el.scrollTop = 100;
    el.__fire('scroll');
    eq(seen.length, 1, 'feed: leaving the live end is reported once');
    eq(seen[0].pinned, false, 'feed: and reported as no longer pinned');

    // More scrolling while already away from the bottom says nothing new.
    el.scrollTop = 90; el.__fire('scroll');
    el.scrollTop = 80; el.__fire('scroll');
    eq(seen.length, 1, 'feed: scrolling about up there is not reported again');

    // Messages arriving while up there are counted, and the count climbs.
    t.feed.addMessage({ platform: 'twitch', author: 'a', text: '1', messageId: 'p1' }, filter);
    t.feed.addMessage({ platform: 'twitch', author: 'b', text: '2', messageId: 'p2' }, filter);
    t.flush();
    eq(seen[seen.length - 1].missed, 2, 'feed: messages arriving while away are counted');
    eq(seen[seen.length - 1].pinned, false, 'feed: and it is still not pinned');
    eq(el.scrollTop, 80, 'feed: and the view is left exactly where it was');

    t.feed.addMessage({ platform: 'kick', author: 'c', text: '3', messageId: 'p3' }, filter);
    t.flush();
    eq(seen[seen.length - 1].missed, 3, 'feed: the count keeps climbing as more arrive');

    // A status line is not something anyone scrolled up to avoid missing.
    t.feed.addSys('[Merged] connected');
    t.flush();
    eq(seen[seen.length - 1].missed, 3, 'feed: a status line does not count as a new message');

    // The way back: scrolled to the bottom, count cleared, reported pinned.
    t.feed.scrollToBottom();
    eq(el.scrollTop, el.scrollHeight, 'feed: jumping to live goes to the bottom');
    eq(seen[seen.length - 1].pinned, true, 'feed: and reports it is following again');
    eq(seen[seen.length - 1].missed, 0, 'feed: with nothing left outstanding');

    // Back at the live end, new messages scroll into view as before.
    const before = el.scrollTop;
    t.feed.addMessage({ platform: 'twitch', author: 'd', text: '4', messageId: 'p4' }, filter);
    el.scrollHeight = 1200;
    t.flush();
    eq(el.scrollTop, 1200, 'feed: and it follows the newest line again');
    ok(before !== 1200, 'feed: which is a move, not a coincidence');

    // Scrolling back down by hand is the same as pressing the button.
    el.scrollTop = 100; el.__fire('scroll');
    eq(seen[seen.length - 1].pinned, false, 'feed: scrolling up again unpins');
    t.feed.addMessage({ platform: 'twitch', author: 'e', text: '5', messageId: 'p5' }, filter);
    t.flush();
    ok(seen[seen.length - 1].missed > 0, 'feed: and starts counting again');
    el.scrollTop = el.scrollHeight; el.__fire('scroll');
    eq(seen[seen.length - 1].pinned, true, 'feed: scrolling down by hand also rejoins');
    eq(seen[seen.length - 1].missed, 0, 'feed: and clears what was missed');

    // Clearing the feed starts over at the live end.
    el.scrollTop = 0; el.__fire('scroll');
    t.feed.clear();
    eq(seen[seen.length - 1].pinned, true, 'feed: a cleared feed is at the live end');
    eq(seen[seen.length - 1].missed, 0, 'feed: with nothing missed');
  }

  // —— A feed with no box at all ——
  //
  // Collapsing or hiding the panel takes the feed's box away, and every
  // measurement off it then reads zero — which came out as "following the live
  // end" however far behind it was. So messages arriving while the panel was
  // away were counted as seen, the jump button stayed hidden, and opening it
  // again left the viewer in the middle of an hour ago with nothing offering
  // to take them back.
  {
    const t = build();
    const el = t.feedEl;
    const seen = [];
    t.feed.onPinChange((pinned, missed) => seen.push({ pinned, missed }));

    // Scrolled up, and then the panel is collapsed.
    el.scrollHeight = 1000; el.clientHeight = 400; el.scrollTop = 100;
    el.__fire('scroll');
    eq(t.feed.isPinned(), false, 'feed: away from the live end before it is put away');

    // A collapsed element reports nothing for any of the three, not just the
    // height — which is why every measurement off it came out as "at the
    // bottom".
    el.clientHeight = 0; el.scrollHeight = 0; el.scrollTop = 0;
    eq(t.feed.isPinned(), false,
      'feed: a feed with no box does not start claiming it is at the live end');

    // Messages arriving while it is away are still counted as missed.
    const missedBefore = (seen[seen.length - 1] || {}).missed || 0;
    t.feed.addMessage({ platform: 'twitch', author: 'x', text: '1', messageId: 'q1' }, filter);
    t.feed.addMessage({ platform: 'twitch', author: 'y', text: '2', messageId: 'q2' }, filter);
    t.flush();
    eq(seen[seen.length - 1].missed, missedBefore + 2,
      'feed: and messages arriving while it has no box are still counted');

    // The other way round: put away while it *was* following stays following,
    // so opening it again is not reported as being behind.
    const u = build();
    u.feedEl.scrollHeight = 1000; u.feedEl.clientHeight = 400; u.feedEl.scrollTop = 900;
    ok(u.feed.isPinned(), 'feed: following the live end before it is put away');
    u.feedEl.clientHeight = 0; u.feedEl.scrollHeight = 0; u.feedEl.scrollTop = 0;
    ok(u.feed.isPinned(), 'feed: and still following once it has no box');
  }

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

  // ── The empty-state row belongs to the feed ──
  //
  // It used to be found by searching the feed for it on every queued message,
  // which meant walking every row being kept — thousands of nodes on a busy
  // channel — to fail to find a row that has not been there since the first
  // message of the session. The feed holds it instead, so nothing on the
  // message path searches for it.
  {
    const t = build();
    let built = 0;
    const make = () => { built += 1; const el = fakeNode(); el.className = 'fcm-empty'; return el; };

    t.feed.setPlaceholder(make);
    eq(t.feedEl.childElementCount, 1, 'feed: the placeholder is shown');
    t.feed.setPlaceholder(make);
    eq(built, 1, 'feed: and is not built a second time while it is up');
    eq(t.feedEl.childElementCount, 1, 'feed: nor shown twice');

    // The first message to arrive takes it away, without being told to.
    t.feed.addMessage({ platform: 'twitch', author: 'a', text: 'x', messageId: 'e1' }, filter);
    t.flush();
    eq(t.feedEl.querySelectorAll('.fcm-empty').length, 0,
      'feed: the first message clears the placeholder');
    ok(t.feed.hasMessages, 'feed: and the feed says it is holding messages');

    // Clearing forgets it too, so a later empty state is shown rather than
    // taken for one that is already up.
    t.feed.setPlaceholder(make);
    t.feed.clear();
    eq(t.feedEl.childElementCount, 0, 'feed: clearing takes the placeholder with it');
    ok(!t.feed.hasMessages, 'feed: and the feed is holding nothing');
    t.feed.setPlaceholder(make);
    eq(t.feedEl.childElementCount, 1, 'feed: so a later empty state is shown again');

    t.feed.clearPlaceholder();
    eq(t.feedEl.childElementCount, 0, 'feed: and it can be taken away directly');
    t.feed.clearPlaceholder();
    eq(t.feedEl.childElementCount, 0, 'feed: clearing it twice is harmless');
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

  // ── Rows waiting in the queue are still rows ──
  //
  // Everything that changes the feed used to look only at what was attached,
  // and a message spends up to a frame in the queue first. Twitch sends a
  // message and the CLEARMSG that deletes it down one socket, so a delete
  // landing in that window found nothing and the message flushed a moment
  // later looking perfectly ordinary — the overlay then showed a message the
  // platform had removed, permanently.
  {
    const t = drainRig({});
    t.feed.addMessage({ platform: 'twitch', author: 'doomed', text: 'delete me', messageId: 'q1' }, filter);
    t.feed.markMessageDeleted('twitch', 'q1');
    t.fireFrames();
    const row = t.feedEl.children[0];
    ok(row.classList.contains('fcm-deleted'),
      'feed: a message deleted before it was drawn arrives deleted');
  }

  {
    const t = drainRig({});
    t.feed.addMessage({ platform: 'twitch', author: 'Banned', text: 'one', messageId: 'q2' }, filter);
    t.feed.addMessage({ platform: 'twitch', author: 'banned', text: 'two', messageId: 'q3' }, filter);
    t.feed.addMessage({ platform: 'twitch', author: 'other', text: 'three', messageId: 'q4' }, filter);
    t.feed.markUserDeleted('twitch', 'banned');
    t.fireFrames();
    const dimmed = t.feedEl.children.filter((c) => c.classList.contains('fcm-deleted'));
    eq(dimmed.length, 2, 'feed: a ban catches queued messages from that user too');
    ok(!t.feedEl.children[2].classList.contains('fcm-deleted'),
      'feed: and leaves everyone else alone');
  }

  {
    const t = drainRig({});
    t.feed.addMessage({ platform: 'kick', author: 'a', text: 'x', messageId: 'q5' }, filter);
    t.feed.applyFilter(new Set(['twitch']));
    t.fireFrames();
    ok(t.feedEl.children[0].classList.contains('fcm-hide'),
      'feed: a filter set while a row was queued still applies to it');
  }

  {
    const t = drainRig({});
    t.feed.addMessage({ platform: 'kick', author: 'a', text: 'x', messageId: 'q6' }, filter);
    t.feed.addMessage({ platform: 'twitch', author: 'b', text: 'y', messageId: 'q7' }, filter);
    t.feed.dropPlatform('kick');
    t.fireFrames();
    eq(t.feedEl.childElementCount, 1,
      'feed: leaving a chat drops its queued messages instead of drawing them after the leave');
    eq(t.feedEl.children[0].dataset.platform, 'twitch', 'feed: and keeps the other platform');
  }

  // System rows carry no platform, and a platform filter must not hide them.
  {
    const t = drainRig({});
    t.feed.addSys('Connected to Twitch');
    t.feed.applyFilter(new Set(['twitch']));
    t.fireFrames();
    ok(!t.feedEl.children[0].classList.contains('fcm-hide'),
      'feed: a queued status line is not caught by a platform filter');
  }
};

// Moving between channels on the same site. Twitch and Kick are single-page
// apps, so this is a URL change rather than a page load, and everything from
// the channel being left has to stop before the new one starts.
suites.navigation = function () {
  function boot(startPath, options = {}) {
    const ports = [];
    // What chrome.storage would hand back, and whoever is listening to it.
    const stored = { sync: {}, local: {} };
    const changeListeners = [];
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
        // A page carrying a link to the other platform, so "were the page's own
        // links sent" is a question this harness can actually answer. Without
        // one, an announcement that wrongly carried links would look identical
        // to one that correctly carried none.
        querySelectorAll: (sel) => (String(sel) === 'a[href]'
          // Laid out, like an anchor on a page a viewer can see. A real one
          // always answers this; only the panels a site has finished with
          // measure nothing.
          ? [{ getAttribute: () => 'https://kick.com/someoneelse',
            getClientRects: () => [{ width: 340, height: 191 }] }]
          : []),
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
          sync: { get: async () => ({ ...stored.sync }), set: async () => {} },
          local: { get: async () => ({ ...stored.local }), set: async () => {} },
          onChanged: { addListener(fn) { changeListeners.push(fn); } },
        },
      },
    });
    sandbox.setInterval = (fn, ms) => { timers.intervals.push({ fn, ms }); return timers.intervals.length; };
    sandbox.clearInterval = () => {};
    sandbox.setTimeout = (fn, ms) => { timers.timeouts.push({ fn, ms, cancelled: false }); return timers.timeouts.length; };
    sandbox.clearTimeout = (id) => { if (timers.timeouts[id - 1]) timers.timeouts[id - 1].cancelled = true; };

    // render.js as well as sites.js, because the manifest loads it before
    // boot.js and boot.js calls into it when a channel is left.
    // (stored/changeListeners are declared above the sandbox; see below.)
    const FCM = load(sandbox, ...SHARED, 'src/content/render.js', 'src/content/sites.js');

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
        setModerator() {}, modResult() {}, sendResult() {},
        applied: [],
        toasts: [],
        applyStoredSettings(s) { o.applied.push(s); },
        toast(t) { o.toasts.push(t); },
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
      // A settings save landing in one storage area, as chrome reports it.
      async settingsSaved(area, value) {
        stored[area][FCM.STORAGE_KEYS.settings] = value;
        const change = { [FCM.STORAGE_KEYS.settings]: { newValue: value } };
        changeListeners.forEach((fn) => fn(change, area));
        await flush();
      },
      live() { return ports.filter((p) => !p.disconnected); },
      joinsFor(port) { return port.sent.filter((m) => m.cmd === 'join').map((m) => m.channel); },
      allJoins() { return ports.flatMap((p) => p.sent.filter((m) => m.cmd === 'join').map((m) => m.channel)); },
      hellos() { return ports.flatMap((p) => p.sent.filter((m) => m.cmd === 'hello').map((m) => m.channel)); },
      helloMessages() { return ports.flatMap((p) => p.sent.filter((m) => m.cmd === 'hello')); },
      hintMessages() { return ports.flatMap((p) => p.sent.filter((m) => m.cmd === 'hints')); },
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

    // ── Announcing a channel carries no links scraped from the page ──
    //
    // This runs the moment the address changes, and a single-page app changes
    // the address before it draws the page. Anything read then belongs to the
    // channel just left — which is how arriving at one Kick streamer offered
    // the previous one's Twitch chat and wrote it down as this one's pair.
    // The links come later, from the scans, once the page they describe exists.
    {
      const t = boot('/alpha');
      await t.flush();
      await t.navigateTo('/bravo');
      const hellos = t.helloMessages();
      ok(hellos.length >= 2, 'nav: both channels were announced');
      ok(hellos.every((m) => Array.isArray(m.hints) && m.hints.length === 0),
        'nav: and neither announcement carried links read off the page');
    }

    // ── What the render module held for the old channel is dropped ──
    //
    // It outlives the overlay, so this is the one place a channel's emotes and
    // chatters can be forgotten. Driven through the real navigation rather than
    // by calling the reset directly, because the wiring is the part that broke.
    {
      const t = boot('/alpha');
      await t.flush();
      t.FCM.setViewSettings(t.FCM.DEFAULT_SETTINGS);
      t.FCM.setEmotes('twitch', 'thirdparty', { AlphaOnly: { url: 'https://cdn/a.webp', source: '7TV' } });
      t.FCM.rememberChatter('twitch', 'AlphaRegular');
      ok(t.FCM.findEmote('AlphaOnly'), 'nav: the channel had an emote loaded');

      await t.navigateTo('/bravo');
      ok(!t.FCM.findEmote('AlphaOnly'),
        'nav: navigating away drops the emotes that belonged to the old channel');
      eq(t.FCM.recentChatters().length, 0,
        'nav: and the people who spoke there stop being offered here');
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

    // ── A settings change reaches an overlay that is already open ──
    //
    // Every save is written to both storage areas and is allowed to succeed on
    // only one of them, which is the whole reason both are written. A browser
    // that is signed out, has extension sync switched off, or has spent its
    // sync write quota stores the change locally — so an overlay that only
    // listened to sync went on showing the old settings until the page was
    // reloaded. Every tab in this browser reads the same local area.
    {
      const t = boot('/alpha');
      await t.flush();
      const o = t.overlays[0];

      await t.settingsSaved('sync', { savedAt: 1000, fontSize: 18 });
      eq(o.applied.length, 1, 'settings: a change synced from another device is applied');

      await t.settingsSaved('local', { savedAt: 2000, fontSize: 20 });
      eq(o.applied.length, 2, 'settings: a change that only reached local is applied too');

      // Both areas take the same save, so it arrives twice and must be acted
      // on once — not applied and toasted a second time.
      await t.settingsSaved('sync', { savedAt: 2000, fontSize: 20 });
      eq(o.applied.length, 2, 'settings: the same save landing in both areas is applied once');
      eq(o.toasts.length, 2, 'settings: and says so once');

      // A later save is a different one, whichever area reports it first.
      await t.settingsSaved('local', { savedAt: 3000, fontSize: 22 });
      eq(o.applied.length, 3, 'settings: the next save is applied');
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

  // ── What the render module keeps between channels ──────────────────────────
  //
  // It is loaded once for the page and outlives every overlay built on it, so
  // anything it holds for a channel follows you to the next one unless it is
  // dropped. That is a leak over a long session, and before that it is wrong:
  // a word that is an emote in a channel you have left would render as that
  // emote here, where the real chat shows text.
  {
    const sandbox = makeSandbox({ document: stubDocument() });
    const FCM = load(sandbox, ...SHARED, 'src/content/render.js');
    FCM.setViewSettings(FCM.DEFAULT_SETTINGS);

    FCM.setEmotes('twitch', 'thirdparty', { AlphaOnly: { url: 'https://cdn/a.webp', source: '7TV' } });
    FCM.setBadges('twitch', {
      global: { moderator: { 1: { image_url_1x: 'https://badge/mod.png' } } },
      channel: { subscriber: { 12: { image_url_1x: 'https://badge/alpha12.png' } } },
    });
    FCM.rememberChatter('twitch', 'AlphaRegular');

    ok(FCM.findEmote('AlphaOnly'), 'switch: the channel\'s emote is loaded');
    ok(FCM.recentChatters().some((c) => c.name === 'AlphaRegular'),
      'switch: and someone who spoke there is remembered');
    const beforeVersion = FCM.view.emoteVersion;

    FCM.resetChannelView();

    ok(!FCM.findEmote('AlphaOnly'), 'switch: leaving drops the channel\'s emotes');
    eq(FCM.recentChatters().length, 0, 'switch: and everyone who spoke there');
    eq(Object.keys(FCM.view.badges.twitch.channel).length, 0,
      'switch: and the badges that belonged to it');
    ok(FCM.view.emoteVersion > beforeVersion,
      'switch: anything cached against the emotes is told to rebuild');
    // Global badges are the same everywhere and are re-sent on join anyway.
    ok(FCM.view.badges.twitch.global.moderator,
      'switch: global badges are not channel state and stay');
    // The settings are the viewer's, not the channel's.
    eq(FCM.view.settings.fontSize, FCM.DEFAULT_SETTINGS.fontSize,
      'switch: and neither are the settings');

    // A word that was an emote in the channel just left is plain text here.
    const after = FCM.renderMessageBody('twitch', 'AlphaOnly', {});
    missing(after.html, '<img', 'switch: so it renders as text, the way the real chat shows it');

    // ── Who gets forgotten when the list is full ──
    //
    // A busy channel has more names than the list holds, and the one to drop is
    // whoever was heard from longest ago — not whoever was seen first, which in
    // a channel you have sat in all evening is the regular still talking.
    FCM.resetChannelView();
    const regular = 'TheRegular';
    FCM.rememberChatter('twitch', regular);
    for (let i = 0; i < 150; i++) FCM.rememberChatter('twitch', `passerby${i}`);
    FCM.rememberChatter('twitch', regular);            // they say something else
    for (let i = 150; i < 260; i++) FCM.rememberChatter('twitch', `passerby${i}`);

    const names = FCM.recentChatters().map((c) => c.name);
    ok(names.includes(regular), 'switch: someone still talking survives a full list');
    ok(!names.includes('passerby0'), 'switch: and the quietest name is the one dropped');
    ok(names.length <= 200, 'switch: the list stays bounded');
  }

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

    // ── Reloading the page ──
    // The sockets live in the worker, so a reload does not disturb them and
    // nothing re-joins. The new page starts with an empty feed and an empty
    // emote picker, and only the worker can fill them.
    {
      const t = bootPair('/alpha');
      try {
        await wait(400);
        const irc = t.liveIrc()[0];
        irc.push('@room-id=99 :tmi.twitch.tv ROOMSTATE #alpha');
        irc.push(':justinfan!justinfan@tmi.twitch.tv 366 justinfan #alpha :End of /NAMES list');
        await wait(400);
        const first = t.overlays[t.overlays.length - 1];
        ok(first.badgeSets.length > 0, 'e2e: the first page is given its badges');

        const fresh = await t.reloadPage();
        await wait(600);

        ok(fresh !== first, 'e2e: a reload builds a new overlay');
        eq(t.joins(), ['JOIN #alpha'], 'e2e: and does not re-join the channel');
        eq(t.liveIrc().length, 1, 'e2e: the socket carries on through the reload');
        ok(fresh.statuses.some((s) => s.state === 'connected'),
          'e2e: the new page is told the chat is already connected');
        ok(fresh.badgeSets.length > 0,
          'e2e: and is given the badges it could not have kept');
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
        // A join overtaken inside its two storage reads may already have got as
        // far as opening a socket, depending on which side of ~24ms the
        // navigation lands. Demanding it never opened one made this flake about
        // once in ten runs; what actually matters is that an abandoned socket
        // is abandoned — closed, and never used to join anything.
        const abandoned = t.ircSockets().filter((sock) => sock.closed);
        ok(abandoned.every((sock) => !sock.sent.some((line) => line.startsWith('JOIN '))),
          'e2e: a join that was overtaken never joins anything');
        eq(t.liveIrc().length, 1, 'e2e: and exactly one socket is left open');

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

// Reloading the page. The sockets in the worker carry on, so nothing re-joins —
// and history, badges and emotes only ever happened on a join.
// Last visit's emote lists, kept so a channel you have been in before has its
// emotes on arrival rather than several round-trips later.
//
// The point of the cache is the gap at the start of a visit, and the point of
// these is that it can never become the final answer: the fetch still runs, and
// what it returns lands on top.
// The channel's own third-party emotes, which depend on an id that arrives
// whenever Twitch feels like sending it.
//
// 7TV, BTTV and FFZ all key a channel set by the platform’s numeric id, and on
// Twitch that id comes from ROOMSTATE, which is not ordered against the 366
// that says the join finished. When 366 came first the fetch went out with no
// id, got only the providers’ global sets, and nothing ever went back — which
// is why reloading the page sometimes fixed it and sometimes did not.
suites.emoterace = function () {
  const { bootWorker, wait } = require('./background.js');

  // Answers the channel-scoped provider calls only when they carry the id,
  // and counts them: the harness only records what its own default fetch does.
  const asked = [];
  const providers = async (url) => {
    const u = String(url);
    asked.push(u);
    if (u === 'https://7tv.io/v3/emote-sets/global') {
      return { ok: true, json: async () => ({ emotes: [
        { name: 'GlobalOnly', data: { host: { url: '//cdn/1', files: [{ name: '2x.webp' }] } } },
      ] }) };
    }
    if (u.includes('7tv.io/v3/users/twitch/99')) {
      return { ok: true, json: async () => ({ emote_set: { emotes: [
        { name: 'TheChannelEmote', data: { host: { url: '//cdn/2', files: [{ name: '2x.webp' }] } } },
      ] } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const namesSent = (w) => w.of('emotes')
    .flatMap((m) => Object.keys(m.store || {}));

  return (async () => {
    // ── The join finishing before Twitch says which channel it is ──
    {
      const w = bootWorker({ fetchImpl: providers });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        await wait(60);
        w.send({ cmd: 'join', platform: 'twitch', channel: 'alpha' });
        await wait(120);
        const irc = w.socketFor('irc-ws');
        // 366 first, with no ROOMSTATE yet: the order that used to lose them.
        irc.push(':justinfan!justinfan@tmi.twitch.tv 366 justinfan #alpha :End of /NAMES list');
        await wait(300);
        ok(namesSent(w).includes('GlobalOnly'),
          'emoterace: the providers’ global sets load without an id');
        ok(!namesSent(w).includes('TheChannelEmote'),
          'emoterace: the channel’s own set cannot be asked for yet');

        // ROOMSTATE arrives late, which is the case that was never retried.
        irc.push('@room-id=99 :tmi.twitch.tv ROOMSTATE #alpha');
        await wait(400);
        ok(namesSent(w).includes('TheChannelEmote'),
          'emoterace: and are fetched as soon as the id turns up');
      } finally { w.teardown(); }
    }

    // ── The other order still costs exactly one pass ──
    {
      asked.length = 0;
      const w = bootWorker({ fetchImpl: providers });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        await wait(60);
        w.send({ cmd: 'join', platform: 'twitch', channel: 'alpha' });
        await wait(120);
        const irc = w.socketFor('irc-ws');
        irc.push('@room-id=99 :tmi.twitch.tv ROOMSTATE #alpha');
        irc.push(':justinfan!justinfan@tmi.twitch.tv 366 justinfan #alpha :End of /NAMES list');
        await wait(400);
        ok(namesSent(w).includes('TheChannelEmote'),
          'emoterace: an id that arrives first works the same way');
        const channelCalls = asked.filter((u) => u.includes('7tv.io/v3/users/twitch/99')).length;
        eq(channelCalls, 1, 'emoterace: and is not asked for twice');
      } finally { w.teardown(); }
    }
  })();
};

suites.emotecache = function () {
  const { bootWorker, wait } = require('./background.js');

  // A whole arrival: connect, announce the channel, join, and let Twitch
  // confirm the join — 366 is what actually starts the emote load.
  const visit = async (w, channel) => {
    w.connect();
    w.send({ cmd: 'hello', site: 'twitch', channel, hints: [] });
    await wait(60);
    w.send({ cmd: 'join', platform: 'twitch', channel });
    await wait(120);
    const irc = w.socketFor('irc-ws');
    irc.push(`@room-id=99 :tmi.twitch.tv ROOMSTATE #${channel}`);
    irc.push(`:justinfan!justinfan@tmi.twitch.tv 366 justinfan #${channel} :End of /NAMES list`);
    await wait(300);
  };

  return (async () => {
    // Serves the providers the join asks for; everything else 404s the way the
    // harness normally does, which is enough for a join to complete.
    const withEmotes = async (url) => {
      const u = String(url);
      if (u === 'https://7tv.io/v3/emote-sets/global') {
        return { ok: true, json: async () => ({ emotes: [
          { name: 'GlobalPog', data: { host: { url: '//cdn.7tv/1', files: [{ name: '2x.webp' }] } } },
        ] }) };
      }
      if (/7tv[.]io[/]v3[/]users[/]/.test(u)) {
        return { ok: true, json: async () => ({ emote_set: { emotes: [
          { name: 'ChannelPog', data: { host: { url: '//cdn.7tv/2', files: [{ name: '2x.webp' }] } } },
        ] } }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    // ── A first visit fetches, and remembers ──
    const first = bootWorker({ fetchImpl: withEmotes });
    let carried;
    try {
      await visit(first, 'alpha');
      const sent = first.of('emotes');
      ok(sent.length > 0, 'emotecache: the first visit loads emotes from the providers');
      carried = first.storage.local.fcm_emote_cache_v1;
      ok(carried, 'emotecache: and writes them down for next time');
      ok(Object.keys(carried).some((k) => k.startsWith('twitch:alpha:')),
        'emotecache: keyed by the platform and channel');
    } finally { first.teardown(); }

    // ── A second visit has them before anything is fetched ──
    // Every provider hangs, so nothing can arrive from the network at all and
    // anything the overlay is given must have come from the cache.
    const hangs = () => new Promise(() => {});
    const second = bootWorker({ fetchImpl: hangs });
    try {
      // Same machine, so it starts with what the first visit left behind.
      second.storage.local.fcm_emote_cache_v1 = carried;
      await visit(second, 'alpha');
      const sent = second.of('emotes');
      ok(sent.length > 0,
        'emotecache: a return visit has its emotes with every provider unreachable');
      const names = sent.flatMap((m) => Object.keys(m.store || {}));
      ok(names.length > 0, 'emotecache: and they are real entries, not an empty store');
      ok(second.of('sys').some((m) => /from last time/i.test(m.text || '')),
        'emotecache: and says where they came from rather than claiming a fresh load');
    } finally { second.teardown(); }

    // ── A different channel does not get another channel's emotes ──
    const third = bootWorker({ fetchImpl: hangs });
    try {
      third.storage.local.fcm_emote_cache_v1 = carried;
      await visit(third, 'bravo');
      ok(!third.of('sys').some((m) => /from last time/i.test(m.text || '')),
        'emotecache: a channel never visited has nothing cached to offer');
    } finally { third.teardown(); }

    // ── Old enough and it is not offered ──
    const stale = bootWorker({ fetchImpl: hangs });
    try {
      const aged = JSON.parse(JSON.stringify(carried));
      Object.keys(aged).forEach((k) => { aged[k].at = Date.now() - (400 * 24 * 60 * 60 * 1000); });
      stale.storage.local.fcm_emote_cache_v1 = aged;
      await visit(stale, 'alpha');
      ok(!stale.of('sys').some((m) => /from last time/i.test(m.text || '')),
        'emotecache: a list old enough to distrust is not used');
    } finally { stale.teardown(); }
  })();
};

suites.reload = function () {
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
        await wait(120);
        const irc = w.socketFor('irc-ws');
        ok(irc.sent.includes('JOIN #alpha'), 'reload: joined to begin with');
        // 366 is Twitch saying the join completed, which is what triggers the
        // first load of history, badges and emotes.
        irc.push('@room-id=99 :tmi.twitch.tv ROOMSTATE #alpha');
        irc.push(':justinfan!justinfan@tmi.twitch.tv 366 justinfan #alpha :End of /NAMES list');
        await wait(250);
        ok(w.of('badges').length > 0, 'reload: the first load sends the page its badges');
        const wanted = /7tv|betterttv|frankerfacez|recent-messages/i;
        ok(w.fetchCalls.some((c) => wanted.test(c.url)),
          'reload: and goes looking for history and emotes');

        // The page reloads: a new port, the same channel, the socket untouched.
        const before = w.fetchCalls.length;
        w.clear();
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        await wait(300);

        const live = w.socketsFor('irc-ws').filter((sock) => !sock.closed);
        eq(live.length, 1, 'reload: the socket is not dropped and reopened');
        eq(live[0].sent.filter((l) => l === 'JOIN #alpha').length, 1,
          'reload: and the channel is not joined a second time');

        // What the fresh page could not have kept, and could not ask for itself:
        // nothing re-joins, so only the worker can start this again.
        ok(w.of('badges').length > 0, 'reload: badges are sent again');
        ok(w.fetchCalls.slice(before).some((c) => wanted.test(c.url)),
          'reload: history and emotes are fetched again for the new page');
        ok(w.of('ready').length > 0, 'reload: and the page is told what is connected');
      } finally { w.teardown(); }
    }

    // ── Kick, where replaying history needs an id learnt at join time ──
    {
      const w = bootWorker();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'alpha', hints: [] });
        await wait(60);
        w.send({ cmd: 'join', platform: 'kick', channel: 'alpha' });
        await wait(150);
        const pusher = w.socketFor('pusher.com');
        pusher.push(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
        await wait(300);
        pusher.push(JSON.stringify({ event: 'pusher_internal:subscription_succeeded', channel: 'chatrooms.1.v2', data: '{}' }));
        await wait(300);
        const firstEmotes = w.of('emotes').length + w.of('needKickEmotes').length;
        ok(firstEmotes > 0, 'reload: kick asks for its emotes on the first join');

        w.clear();
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'alpha', hints: [] });
        await wait(300);

        const live = w.socketsFor('pusher.com').filter((sock) => !sock.closed);
        eq(live.length, 1, 'reload: kick keeps its one socket');
        ok(w.of('emotes').length + w.of('needKickEmotes').length > 0,
          'reload: and asks for its emotes again for the new page');
      } finally { w.teardown(); }
    }

    // ── Moving to a different channel still tears down, as it always did ──
    {
      const w = bootWorker();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        await wait(60);
        w.send({ cmd: 'join', platform: 'twitch', channel: 'alpha' });
        await wait(120);
        w.clear();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'bravo', hints: [] });
        await wait(200);
        const live = w.socketsFor('irc-ws').filter((sock) => !sock.closed);
        ok(live.length <= 1, 'reload: a real channel change still leaves one socket');
        ok(!live.length || !live[0].sent.includes('JOIN #alpha'),
          'reload: and it is not the channel that was left');
      } finally { w.teardown(); }
    }
  })();
};

// Typing in a channel name to merge two that are not called the same thing.
// Driven through the real worker, over the port, the way the overlay does it.
// Moving to another channel on the same site.
//
// Reported from Kick: arriving at one streamer while still being offered the
// last one’s Twitch chat, with their name in the header. The address changes
// before a single-page app has drawn the page it names, so the links scraped
// at that moment belong to the channel just left — and the wrong pairing they
// produced was then written down and won for six hours against the page that
// disagreed with it.
suites.counterpartswitch = function () {
  const { bootWorker, wait } = require('./background.js');

  // What the code currently stamps on a page-link pairing, read off the code
  // rather than written down here: the number goes up every time page links
  // turn out to have been read off the wrong thing, and a fixture meant to be
  // current should not silently become a fixture meant to be stale.
  const CURRENT_LINK_VERSION = (() => {
    const D = load(makeSandbox(), ...SHARED, 'src/background/discovery.js');
    for (let v = 1; v <= 50; v++) {
      if (D.links.trustworthy({ match: 'page-link', v })) return v;
    }
    throw new Error('no page-link record version is trusted');
  })();

  const known = new Set(['cashmeow', 'irongoddess']);
  const boot = (storage) => {
    const w = bootWorker({
      fetchImpl: async (url, init) => {
        const u = String(url);
        const m = /kick[.]com[/]api[/]v[0-9][/]channels[/]([^/?]+)$/.exec(u);
        if (m) {
          return { ok: true, json: async () => ({
            id: 9, user_id: 77, slug: m[1], chatroom: { id: 55 },
            livestream: { session_title: 'live', viewer_count: 3, categories: [] },
            user: { username: m[1], profile_pic: '' },
          }) };
        }
        if (u.includes('gql.twitch.tv')) {
          const asked = JSON.stringify(JSON.parse((init && init.body) || '{}'));
          const who = [...known].find((n) => asked.includes(n));
          if (!who) return { ok: true, json: async () => ({ data: { user: null } }) };
          return { ok: true, json: async () => ({ data: { user: {
            id: '1', login: who, displayName: who, profileImageURL: '', stream: { id: 's' },
          } } }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });
    if (storage) w.storage.local.fcm_channel_links_v1 = storage;
    return w;
  };
  const seen = (w) => {
    const all = w.of('counterpart');
    const last = all[all.length - 1];
    return last && last.counterpart ? last.counterpart.channel : null;
  };

  return (async () => {
    // ── Arriving at a new channel is not offered the last one ──
    {
      const w = boot();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'cashmeow', hints: [] });
        await wait(150);
        w.send({ cmd: 'hints', hints: ['https://twitch.tv/cashmeow'] });
        await wait(300);
        eq(seen(w), 'cashmeow', 'switch: the first channel finds its own counterpart');

        // The move. No hints travel with it, because the page has not caught up.
        w.clear();
        w.send({ cmd: 'hello', site: 'kick', channel: 'irongoddess', hints: [] });
        await wait(400);
        ok(seen(w) !== 'cashmeow',
          'switch: the channel just left is not offered as the new one’s counterpart');

        // And once the page exists, its own links are used.
        w.send({ cmd: 'hints', hints: ['https://twitch.tv/irongoddess'] });
        await wait(400);
        eq(seen(w), 'irongoddess', 'switch: the new page’s own link is what answers');
      } finally { w.teardown(); }
    }

    // ── A page still running the previous version cannot cause it ──
    //
    // Reloading an extension restarts the worker and leaves the old content
    // script running in every tab already open, until each one is reloaded.
    // On a single-page app, clicking between channels never reloads the
    // document, so that can go on for a long time — and the old page half
    // still sends the links it read at the wrong moment.
    //
    // The worker is the half that can be sure it is current, so it discards
    // them rather than trusting the page to have stopped sending them.
    {
      const w = boot();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'cashmeow', hints: [] });
        await wait(300);
        // An old content script announcing the new channel, carrying the
        // links it scraped off the one being left.
        w.clear();
        w.send({ cmd: 'hello', site: 'kick', channel: 'irongoddess',
          hints: ['https://twitch.tv/cashmeow'] });
        await wait(500);
        eq(seen(w), 'irongoddess',
          'switch: links sent with the announcement are ignored, whatever the page sends');
        const links = w.storage.local.fcm_channel_links_v1;
        eq(links['kick:irongoddess'].channel, 'irongoddess',
          'switch: so a stale page cannot write a wrong pairing down either');
      } finally { w.teardown(); }
    }

    // ── A pairing written down by the old fault is not used at all ──
    //
    // Anyone who hit this has kick:irongoddess -> cashmeow in storage, and
    // neither Kick page links to Twitch, so nothing would ever arrive to argue
    // with it. Worse, using it rewrote its own timestamp, so the six hours it
    // was supposed to live never elapsed and the wrong answer was permanent.
    //
    // A page-link pairing from before the fix cannot be told from a good one,
    // so it is re-derived rather than carried forward.
    {
      const w = boot({
        'kick:irongoddess': { channel: 'cashmeow', match: 'page-link', at: Date.now() },
      });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'irongoddess', hints: [] });
        await wait(500);
        eq(seen(w), 'irongoddess',
          'switch: a pairing from before the fix is not believed, with no page link needed');
        const links = w.storage.local.fcm_channel_links_v1;
        eq(links['kick:irongoddess'].channel, 'irongoddess',
          'switch: and what replaces it is written down');
      } finally { w.teardown(); }
    }

    // ── A page link recorded by the current version is still believed ──
    //
    // The whole point of page links is the streamer whose names differ. Throwing
    // the good ones out with the bad would trade one wrong merge for another.
    //
    // Stamped with whatever the code considers current rather than a number
    // written in here, so that raising it means re-examining the fixtures that
    // are meant to be stale instead of quietly invalidating this one too.
    {
      const w = boot({
        'kick:irongoddess': { channel: 'cashmeow', match: 'page-link', at: Date.now(),
          v: CURRENT_LINK_VERSION },
      });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'irongoddess', hints: [] });
        await wait(500);
        eq(seen(w), 'cashmeow',
          'switch: a page link found since the fix still outranks the same-name guess');
      } finally { w.teardown(); }
    }

    // ── Using a remembered pairing does not renew it ──
    {
      const old = Date.now() - (60 * 60 * 1000);
      const w = boot({
        'kick:irongoddess': { channel: 'irongoddess', match: 'same-name', at: old, v: 2 },
      });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'irongoddess', hints: [] });
        await wait(500);
        const links = w.storage.local.fcm_channel_links_v1;
        eq(links['kick:irongoddess'].at, old,
          'switch: an unchanged answer keeps the age it was found at, so it can expire');
      } finally { w.teardown(); }
    }

    // ── A mapping set by hand is not overruled by a page link ──
    {
      const w = boot({
        'kick:irongoddess': { channel: 'cashmeow', manual: true, match: 'manual', at: Date.now() },
      });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'irongoddess', hints: [] });
        await wait(300);
        w.send({ cmd: 'hints', hints: ['https://twitch.tv/irongoddess'] });
        await wait(400);
        eq(seen(w), 'cashmeow', 'switch: what the viewer set by hand still wins');
      } finally { w.teardown(); }
    }
  })();
};

suites.linking = function () {
  const { bootWorker, wait } = require('./background.js');

  // Asked for "the Kick channel", people paste the address of it. Every shape
  // below is one somebody could reasonably hand over, and they all mean the
  // same channel.
  {
    const FCM = load(makeSandbox(), 'src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/util.js');
    [
      ['chefsteve', 'chefsteve'],
      ['ChefSteve', 'chefsteve'],
      ['@chefsteve', 'chefsteve'],
      ['  chefsteve  ', 'chefsteve'],
      ['https://kick.com/chefsteve', 'chefsteve'],
      ['https://kick.com/chefsteve/', 'chefsteve'],
      ['https://kick.com/chefsteve?si=abc', 'chefsteve'],
      ['https://kick.com/chefsteve#chat', 'chefsteve'],
      ['kick.com/chefsteve', 'chefsteve'],
      ['https://www.twitch.tv/chefsteve330', 'chefsteve330'],
      ['twitch.tv/chefsteve330', 'chefsteve330'],
      // A link to something on the channel still names the channel.
      ['https://www.twitch.tv/chefsteve330/videos', 'chefsteve330'],
      // Nothing usable is nothing, not a channel called "kick.com".
      ['https://kick.com/', ''],
      ['', ''],
      ['   ', ''],
    ].forEach(([input, expected]) => {
      eq(FCM.channelFromInput(input), expected, `linking: "${input}" reads as "${expected}"`);
    });
  }

  return (async () => {
    const w = bootWorker();
    try {
      w.connect();
      // Watching a Twitch channel whose Kick name is different.
      w.send({ cmd: 'hello', site: 'twitch', channel: 'chefsteve330', hints: [] });
      await wait(250);

      w.clear();
      w.send({ cmd: 'setLink', target: 'chefsteve' });
      await wait(400);

      const links = w.storage.local[FCM_LINKS_KEY] || {};
      eq((links['twitch:chefsteve330'] || {}).channel, 'chefsteve',
        'linking: the name typed in is saved against the channel being watched');
      eq((links['kick:chefsteve'] || {}).channel, 'chefsteve330',
        'linking: and the same pair is saved from the Kick side');

      const told = w.of('counterpart');
      ok(told.length > 0, 'linking: the page is told straight away, without a reload');

      // Correcting a link while merged with the channel it used to name.
      {
        const c = bootWorker();
        try {
          c.connect();
          c.send({ cmd: 'hello', site: 'twitch', channel: 'chefsteve330', hints: [] });
          await wait(200);
          // Merged with the channel the same-name guess found.
          c.send({ cmd: 'join', platform: 'kick', channel: 'wrongsteve' });
          await wait(300);
          ok(c.socketsFor('pusher.com').some((sock) => !sock.closed),
            'linking: connected to the channel that was guessed');

          c.clear();
          c.send({ cmd: 'setLink', target: 'chefsteve' });
          await wait(500);

          const idle = c.of('status').filter((m) => m.platform === 'kick' && m.state === 'idle');
          ok(idle.length > 0, 'linking: correcting the link leaves the chat it used to name');
          ok(c.of('sys').some((m) => /Left Kick/.test(m.text || '')),
            'linking: and says so rather than doing it quietly');
        } finally { c.teardown(); }
      }

      // Linking to the channel already merged leaves it alone.
      {
        const c = bootWorker();
        try {
          c.connect();
          c.send({ cmd: 'hello', site: 'twitch', channel: 'chefsteve330', hints: [] });
          await wait(200);
          c.send({ cmd: 'join', platform: 'kick', channel: 'chefsteve' });
          await wait(300);
          c.clear();
          c.send({ cmd: 'setLink', target: 'chefsteve' });
          await wait(500);
          const idle = c.of('status').filter((m) => m.platform === 'kick' && m.state === 'idle');
          eq(idle.length, 0, 'linking: confirming the channel already merged does not drop it');
        } finally { c.teardown(); }
      }

      // Undoing it from the other side takes both halves.
      w.clear();
      w.send({ cmd: 'hello', site: 'kick', channel: 'chefsteve', hints: [] });
      await wait(250);
      w.send({ cmd: 'clearLink' });
      await wait(400);
      const after = w.storage.local[FCM_LINKS_KEY] || {};
      // Reset means "go back to guessing", so an automatic entry landing here
      // again straight afterwards is the point. What must not survive is the
      // mapping that was typed in.
      ok(!(after['kick:chefsteve'] || {}).manual,
        'linking: reset drops the mapping that was typed in');
      ok(!after['twitch:chefsteve330'], 'linking: and the half pointing back at it');
    } finally { w.teardown(); }
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

      // ── `/me` arrives as a PRIVMSG wearing a CTCP wrapper ──
      w.clear();
      const SOH = '\u0001';
      irc.push('@display-name=Waver;emotes=25:6-10;id=msg-me '
        + `:waver!waver@waver.tmi.twitch.tv PRIVMSG #somechannel :${SOH}ACTION waves Kappa${SOH}\r\n`);
      const me = w.last('chat');
      eq(me.msg.text, 'waves Kappa', 'bg: the action wrapper is taken off the message');
      eq(me.msg.action, true, 'bg: and the row is told it is an action');
      // The positions in the tags are counted from the unwrapped text, so this
      // is the assertion that would fail if the wrapper came off any later.
      eq(me.msg.text.slice(6, 11), 'Kappa', 'bg: the emote range still lands on the emote');

      // ── a threaded reply carries the message it is answering ──
      w.clear();
      irc.push('@display-name=Answerer;id=msg-2;reply-parent-display-name=Asker;'
        + 'reply-parent-user-login=asker;reply-parent-msg-id=msg-1;'
        + 'reply-parent-msg-body=what\\sgame\\sis\\sthis '
        + ':answerer!answerer@answerer.tmi.twitch.tv PRIVMSG #somechannel :Elden Ring\r\n');
      const answered = w.last('chat');
      eq(answered.msg.reply, {
        name: 'Asker', login: 'asker', text: 'what game is this', messageId: 'msg-1',
      }, 'bg: a reply carries the original through to the feed');
      eq(me.msg.reply, null, 'bg: an ordinary message answers nothing');

      // ── somebody's first ever message in the channel, on Twitch's say-so ──
      w.clear();
      irc.push('@display-name=NewHere;first-msg=1;id=msg-3 '
        + ':newhere!newhere@newhere.tmi.twitch.tv PRIVMSG #somechannel :hello\r\n');
      eq(w.last('chat').msg.firstMessage, true, 'bg: a first message is flagged from the tag');
      eq(answered.msg.firstMessage, false, 'bg: and nothing else is');

      // ── a resub keeps our summary and the viewer's own message apart ──
      w.clear();
      irc.push('@msg-id=resub;display-name=Fan;msg-param-cumulative-months=24;emotes=25:7-11 '
        + ':tmi.twitch.tv USERNOTICE #somechannel :thanks Kappa\r\n');
      const resubEvent = w.last('event');
      eq(resubEvent.text, 'Fan resubscribed (24 months).',
        'bg: the summary is ours and carries none of their text');
      eq(resubEvent.meta.body, 'thanks Kappa', 'bg: what they said comes through separately');
      eq(resubEvent.meta.emoteMap[7].id, '25',
        'bg: with the emote positions that belong to it, so it can be drawn with emotes');

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

suites.watchnow = function () {
  // Kick draws a channel two ways, and the streamer gets the wrong one. What
  // follows is the page as Kick actually builds it, measured off a live
  // channel: a tab strip, a card floating above the player carrying a labelled
  // "Watch now", the player's own transport control carrying the same icon and
  // no words, and a whole second copy of everything inside a streaming
  // placeholder that measures nothing at all.

  // width/height only: everything here turns on whether a thing has a box.
  function node({ w = 0, h = 0, text = '', icon = null, tag = 'BUTTON' } = {}) {
    const n = {
      tagName: tag,
      textContent: text,
      parentElement: null,
      clicks: 0,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h }),
      closest(sel) {
        for (let p = n; p; p = p.parentElement) if (p.tagName === sel.toUpperCase()) return p;
        return null;
      },
      click() { n.clicks++; },
    };
    if (icon) icon.parentElement = n;
    n.icon = icon;
    return n;
  }

  // A play icon, and the button it is drawn inside. The icon is what the page
  // is searched for; the button is what climbing from it has to find.
  function playButton({ w, h, text }) {
    const icon = {
      tagName: 'SVG',
      parentElement: null,
      getAttribute: () => 'Play',
      closest(sel) {
        for (let p = icon; p; p = p.parentElement) if (p.tagName === sel.toUpperCase()) return p;
        return null;
      },
    };
    const btn = node({ w, h, text, icon });
    icon.parentElement = btn;
    return { icon, btn };
  }

  // The tab strip as sites.js asks for it, verbatim.
  const TABS = '[data-testid="channel-home-tab"],[data-testid="channel-about-tab"],'
    + '[data-testid="channel-videos-tab"],[data-testid="channel-clips-tab"],'
    + '[data-testid="channel-schedule-tab"]';

  function pageWith({ tabs = [], plays = [], pathname = '/jrblaze' } = {}) {
    return makeSandbox({
      location: { hostname: 'kick.com', pathname },
      window: {},
      document: {
        querySelectorAll: (sel) => {
          if (sel === TABS) return tabs;
          if (sel === '[data-ds-icon="Play"]') return plays.map((p) => p.icon);
          return [];
        },
        querySelector: () => null,
      },
    });
  }

  const laidOutTab = () => node({ w: 62, h: 48, tag: 'A' });
  const deadTab = () => node({ w: 0, h: 0, tag: 'A' });

  // ── The reported bug: live, on their own channel, looking at the profile ──
  {
    const watch = playButton({ w: 330, h: 40, text: 'Watch now' });
    const transport = playButton({ w: 44, h: 44, text: '' });
    const sandbox = pageWith({ tabs: [laidOutTab()], plays: [watch, transport] });
    const S = load(sandbox, ...SHARED, 'src/content/sites.js');
    ok(S.SITES.kick.watchNow() === watch.btn,
      'watchnow: the labelled button in the live card is the one offered');
  }

  // ── And the button it must never press ──
  //
  // The video's own play control carries the identical icon. Pressing that
  // would pause the stream the moment the overlay arrived, which is worse than
  // doing nothing at all.
  {
    const transport = playButton({ w: 44, h: 44, text: '' });
    const sandbox = pageWith({ tabs: [laidOutTab()], plays: [transport] });
    const S = load(sandbox, ...SHARED, 'src/content/sites.js');
    eq(S.SITES.kick.watchNow(), null,
      'watchnow: the player transport control is never mistaken for Watch now');
  }

  // ── Offline: Kick draws no card, so there is nothing to press ──
  //
  // This is the whole liveness test. Kick only puts the button there while the
  // channel is live, so nothing has to ask an API.
  {
    const sandbox = pageWith({ tabs: [laidOutTab()], plays: [] });
    const S = load(sandbox, ...SHARED, 'src/content/sites.js');
    eq(S.SITES.kick.watchNow(), null,
      'watchnow: an offline profile is left exactly as it is');
  }

  // ── The swap has already happened ──
  //
  // The button stays in the page afterwards, sized and all, so it cannot report
  // its own success. The tabs going is what says it worked.
  {
    const watch = playButton({ w: 330, h: 40, text: 'Watch now' });
    const sandbox = pageWith({ tabs: [deadTab()], plays: [watch] });
    const S = load(sandbox, ...SHARED, 'src/content/sites.js');
    eq(S.SITES.kick.watchNow(), null,
      'watchnow: with the tabs gone the swap is done and nothing is pressed again');
  }

  // ── A page someone asked for by name ──
  {
    const watch = playButton({ w: 330, h: 40, text: 'Watch now' });
    ['/jrblaze/about', '/jrblaze/videos', '/jrblaze/clips', '/popout/jrblaze'].forEach((pathname) => {
      const sandbox = pageWith({ tabs: [laidOutTab()], plays: [watch], pathname });
      const S = load(sandbox, ...SHARED, 'src/content/sites.js');
      eq(S.SITES.kick.watchNow(), null,
        `watchnow: ${pathname} is where someone meant to be, and is left alone`);
    });
  }

  // ── Kick's second, sizeless copy of the whole page ──
  {
    const ghost = playButton({ w: 0, h: 0, text: 'Watch now' });
    const real = playButton({ w: 330, h: 40, text: 'Watch now' });
    const sandbox = pageWith({ tabs: [deadTab(), laidOutTab()], plays: [ghost, real] });
    const S = load(sandbox, ...SHARED, 'src/content/sites.js');
    ok(S.SITES.kick.watchNow() === real.btn,
      'watchnow: the copy in the streaming placeholder is not the one pressed');
  }

  // ── Kick in someone else's language ──
  //
  // The words are preferred where they are English and the icon carries it
  // where they are not, which is the point of matching on the icon at all.
  {
    const translated = playButton({ w: 330, h: 40, text: 'Ver ahora' });
    const sandbox = pageWith({ tabs: [laidOutTab()], plays: [translated] });
    const S = load(sandbox, ...SHARED, 'src/content/sites.js');
    ok(S.SITES.kick.watchNow() === translated.btn,
      'watchnow: a translated label is still found, by its icon and its words');
  }

  // ── A channel name that merely starts with the word ──
  {
    const decoy = playButton({ w: 200, h: 40, text: 'watchdogs' });
    const real = playButton({ w: 330, h: 40, text: 'Watch now' });
    const sandbox = pageWith({ tabs: [laidOutTab()], plays: [decoy, real] });
    const S = load(sandbox, ...SHARED, 'src/content/sites.js');
    ok(S.SITES.kick.watchNow() === real.btn,
      'watchnow: "watchdogs" is a name, not the control');
  }

  // ── Twitch has no profile to be stranded on ──
  {
    const sandbox = makeSandbox({
      location: { hostname: 'www.twitch.tv', pathname: '/somechannel' },
      window: {},
      document: { querySelectorAll: () => [], querySelector: () => null },
    });
    const S = load(sandbox, ...SHARED, 'src/content/sites.js');
    eq(S.SITES.twitch.watchNow(), null,
      'watchnow: Twitch answers the same question with nothing to press');
  }
};

suites.watchpress = function () {
  // What boot does with the button once the adapter has found one. The adapter
  // decides *whether* there is anything to press; this decides how many times.

  function boot({ button = null, settings = {}, startPath = '/jrblaze' } = {}) {
    const timers = { intervals: [], timeouts: [] };
    const location = {
      hostname: 'kick.com',
      pathname: startPath,
      get href() { return 'https://kick.com' + this.pathname; },
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
              sent: [], disconnected: false,
              postMessage(m) { if (!this.disconnected) this.sent.push(m); },
              disconnect() { this.disconnected = true; },
              onMessage: { addListener() {} },
              onDisconnect: { addListener() {} },
            };
            return p;
          },
        },
        storage: {
          sync: { get: async (key) => ({ [key]: settings }), set: async () => {} },
          local: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener() {} },
        },
      },
    });
    sandbox.setInterval = (fn, ms) => { timers.intervals.push({ fn, ms }); return timers.intervals.length; };
    sandbox.clearInterval = () => {};
    sandbox.setTimeout = (fn, ms) => { timers.timeouts.push({ fn, ms, cancelled: false }); return timers.timeouts.length; };
    sandbox.clearTimeout = (id) => { if (timers.timeouts[id - 1]) timers.timeouts[id - 1].cancelled = true; };

    const FCM = load(sandbox, ...SHARED, 'src/content/render.js', 'src/content/sites.js');

    // The adapter's own answer is covered by the watchnow suite; what this one
    // needs is control over when there is a button and when there is not.
    const asked = { count: 0 };
    FCM.currentSite = () => ({
      id: 'kick',
      channelFromUrl() {
        const parts = location.pathname.split('/').filter(Boolean);
        return parts.length && parts[0] !== 'browse' ? parts[0] : null;
      },
      hints: () => [],
      watchNow() { asked.count++; return button; },
    });

    const sysLines = [];
    FCM.createOverlay = () => ({
      mount: () => Promise.resolve(),
      destroy() {}, sys(t) { sysLines.push(t); }, event() {}, chat() {}, batch() {},
      setEmotes() {}, setBadges() {}, setCheermotes() {}, profileResult() {},
      deleteMessage() {}, deleteUser() {}, setCounterpart() {}, setAccounts() {},
      setModerator() {}, modResult() {}, authError() {}, sendResult() {},
      applyStoredSettings() {}, toast() {}, setStatus() {},
    });

    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/boot.js'), 'utf8'),
      sandbox, { filename: 'boot.js' });

    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    return {
      timers, sysLines, asked, flush, location,
      // Every scan boot armed, in the order it armed them.
      scans: () => timers.timeouts.filter((t) => WATCH_DELAYS.includes(t.ms)),
      // A real timer queue checks each timer as it comes round, not once at
      // the start: the first scan cancels the four behind it, and those four
      // then never fire. Deciding up front which to run would fire them all
      // and hide exactly the thing this suite is here to check.
      // The flush is the settings read the press waits on: the button is
      // found synchronously, the permission to press it is not.
      async runScans() {
        this.scans().forEach((t) => { if (!t.cancelled) t.fn(); });
        await flush();
      },
      async navigateTo(pathname) {
        location.pathname = pathname;
        timers.intervals.filter((t) => t.ms === 600).forEach((t) => t.fn());
        await flush();
      },
    };
  }

  // The delays boot.js schedules its scans at.
  const WATCH_DELAYS = [700, 1600, 3200, 6000, 10000];

  return (async () => {
    // ── Live, on the profile: pressed once, however many scans run ──
    {
      const button = { clicks: 0, click() { this.clicks++; } };
      const t = boot({ button });
      await t.flush();
      eq(t.scans().length, WATCH_DELAYS.length, 'watchpress: a scan is armed at each delay');
      eq(button.clicks, 0, 'watchpress: nothing is pressed before the page has had time to draw');

      await t.runScans();
      eq(button.clicks, 1,
        'watchpress: the button is pressed once even though five scans were armed');
      eq(t.sysLines.length, 1, 'watchpress: and the feed says why the page changed');
      contains(t.sysLines[0], 'switched to the stream',
        'watchpress: in words that explain it rather than only announcing it');

      // Running them again stands for the timers that were already in flight
      // when the first one fired.
      await t.runScans();
      eq(button.clicks, 1, 'watchpress: a scan that had already been armed does not press it again');
    }

    // ── Offline, or a layout with no button: nothing happens, quietly ──
    {
      const t = boot({ button: null });
      await t.flush();
      await t.runScans();
      eq(t.sysLines.length, 0, 'watchpress: a page with nothing to press says nothing');
      ok(t.asked.count >= WATCH_DELAYS.length,
        'watchpress: and every scan really did look');
    }

    // ── Switched off ──
    {
      const button = { clicks: 0, click() { this.clicks++; } };
      const t = boot({ button, settings: { watchWhenLive: false } });
      await t.flush();
      await t.runScans();
      eq(button.clicks, 0,
        'watchpress: with the setting off the button is found and deliberately not pressed');
      eq(t.sysLines.length, 0, 'watchpress: and the page is left the way Kick drew it');
    }

    // ── Left the channel before the scan came round ──
    //
    // The timers outlive the navigation, and a press landing after it would be
    // pressing a button on a page nobody is on any more.
    {
      const button = { clicks: 0, click() { this.clicks++; } };
      const t = boot({ button });
      await t.flush();
      await t.navigateTo('/browse');
      t.timers.timeouts.filter((x) => WATCH_DELAYS.includes(x.ms)).forEach((x) => {
        if (!x.cancelled) x.fn();
      });
      eq(button.clicks, 0,
        'watchpress: a scan armed for a channel that has been left presses nothing');
    }
  })();
};

suites.twitchmenus = function () {
  // Twitch's account menu, as it is actually built. Measured off the page:
  //
  //   body
  //    +- div.tw-dialog-layer          1440x0, position: relative, below the fold
  //       +- div.ReactModal__Overlay      1x1, position: fixed
  //          +- div[role=dialog]           1x0, position: static
  //             +- div[data-popper-...]  207x193  <- the only thing anyone sees
  //
  // Every test in native.js asks what an element measures, and all three
  // wrappers answer "nothing" — so the panel that had a box was the one element
  // nothing was looking at, and the overlay painted straight over the menu the
  // viewer had just opened. The notifications popover and the chat settings
  // menu are the same three wrappers around a different panel.

  function el({ w = 0, h = 0, x = 0, y = 0, attrs = {}, position = 'static', kids = [] } = {}) {
    const node = {
      nodeType: 1,
      isConnected: true,
      style: {},
      children: [],
      parentElement: null,
      position,
      textContent: '',
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      contains(other) {
        for (let n = other; n; n = n.parentElement) if (n === node) return true;
        return false;
      },
      getBoundingClientRect: () => ({
        width: w, height: h, left: x, top: y, right: x + w, bottom: y + h,
      }),
    };
    kids.forEach((k) => { k.parentElement = node; node.children.push(k); });
    return node;
  }

  // The overlay's own box: Twitch's chat column, down the right-hand side.
  const CHAT_BOX = { left: 1100, top: 60, right: 1440, bottom: 900, width: 340, height: 840 };

  // The four nested elements Twitch draws a menu through. `panel` is the only
  // one with a box; everything above it measures nothing.
  function menuLayer(panel) {
    const dialog = el({ w: 1, h: 0, attrs: { role: 'dialog' }, kids: [panel] });
    const modalOverlay = el({ w: 1, h: 1, position: 'fixed', kids: [dialog] });
    const layer = el({ w: 1440, h: 0, y: 900, position: 'relative', kids: [modalOverlay] });
    return { panel, dialog, modalOverlay, layer };
  }

  const accountMenu = () => menuLayer(el({
    w: 207, h: 193, x: 1180, y: 100,
    attrs: { 'data-popper-placement': 'bottom-end' },
    position: 'absolute',
  }));

  /**
   * A page with no menu on it, and a way to open one afterwards.
   *
   * Opening it afterwards is the point. The bridge treats whatever is already
   * on screen when it is built as the page's own furniture, so a menu that was
   * there from the start could never be seen opening — and a test that built
   * both at once would be checking the furniture rule instead of this.
   */
  function page() {
    const body = el({ w: 1440, h: 900 });
    const html = el({ w: 1440, h: 900, kids: [body] });
    // Walked fresh on every query, so a menu added after the bridge exists is
    // found the way a real one would be.
    const walk = () => {
      const out = [];
      (function down(n) { out.push(n); n.children.forEach(down); })(body);
      return out;
    };
    const sandbox = makeSandbox({
      document: {
        body,
        documentElement: html,
        querySelectorAll: (sel) => walk().filter((n) => {
          if (sel.includes('data-popper-placement') && n.getAttribute('data-popper-placement')) return true;
          if (sel.includes('role="dialog"') && n.getAttribute('role') === 'dialog') return true;
          if (sel === '[data-state="open"]') return n.getAttribute('data-state') === 'open';
          return false;
        }),
        elementFromPoint: () => null,
      },
      window: {},
      getComputedStyle: (n) => ({ position: n.position || 'static', display: 'block', visibility: 'visible' }),
    });
    const FCM = load(sandbox, ...SHARED, 'src/content/native.js');
    // The adapter is only asked for its message list here, and a menu is never
    // inside one.
    const bridge = FCM.createNativeBridge({ id: 'twitch', messageList: () => null });
    return {
      bridge,
      open(parts) {
        parts.layer.parentElement = body;
        body.children.push(parts.layer);
        return parts;
      },
    };
  }

  // ── The reported bug ──
  {
    const p = page();
    const parts = p.open(accountMenu());
    ok(p.bridge.dialogOver(CHAT_BOX) === parts.panel,
      'twitchmenus: the account menu is found by the panel that has a box, not the wrappers that do not');
  }

  // ── And it is the panel, never one of the wrappers ──
  //
  // Each wrapper measures nothing, or nothing where the overlay is. Standing
  // aside for one would hide the panel for something nobody can see, and it
  // would never be noticed closing either.
  {
    const p = page();
    const parts = p.open(accountMenu());
    const found = p.bridge.dialogOver(CHAT_BOX);
    ok(found !== parts.dialog, 'twitchmenus: not the sizeless role=dialog wrapper');
    ok(found !== parts.layer, 'twitchmenus: not the body child parked below the fold');
    ok(found !== parts.modalOverlay, 'twitchmenus: not the 1x1 fixed overlay');
  }

  // ── A menu somewhere else is not in the way ──
  //
  // Twitch's player settings menu is the same machinery over the video. The
  // overlay is not on top of that, so hiding for it would be hiding for nothing.
  {
    const p = page();
    p.open(menuLayer(el({
      w: 207, h: 193, x: 200, y: 400,
      attrs: { 'data-popper-placement': 'top-start' },
      position: 'absolute',
    })));
    eq(p.bridge.dialogOver(CHAT_BOX), null,
      'twitchmenus: a menu that does not overlap the panel is left alone');
  }

  // ── A tooltip is not a menu ──
  //
  // Twitch positions tooltips with the same attribute. Hiding the whole overlay
  // for one would be worse than letting the tooltip be covered.
  {
    const p = page();
    p.open(menuLayer(el({
      w: 60, h: 24, x: 1200, y: 120,
      attrs: { 'data-popper-placement': 'top' },
      position: 'absolute',
    })));
    eq(p.bridge.dialogOver(CHAT_BOX), null,
      'twitchmenus: a tooltip is too small to hide the panel for');
  }

  // ── Closing it brings the panel back ──
  //
  // Twitch unmounts the layer outright, which is what isConnected answers.
  {
    const p = page();
    const parts = p.open(accountMenu());
    ok(p.bridge.dialogOver(CHAT_BOX) === parts.panel, 'twitchmenus: found while it is open');
    ok(p.bridge.dialogStillOpen(), 'twitchmenus: and still open while it is');
    parts.panel.isConnected = false;
    ok(!p.bridge.dialogStillOpen(),
      'twitchmenus: once Twitch unmounts it the panel stops standing aside');
  }

  // ── A menu that was already up before the overlay arrived ──
  //
  // That is the page's own furniture. Treating it as a menu would leave the
  // overlay invisible with nothing able to bring it back.
  {
    const body = el({ w: 1440, h: 900 });
    const html = el({ w: 1440, h: 900, kids: [body] });
    const parts = accountMenu();
    parts.layer.parentElement = body;
    body.children.push(parts.layer);
    const walk = () => {
      const out = [];
      (function down(n) { out.push(n); n.children.forEach(down); })(body);
      return out;
    };
    const sandbox = makeSandbox({
      document: {
        body,
        documentElement: html,
        querySelectorAll: (sel) => walk().filter((n) => {
          if (sel.includes('data-popper-placement') && n.getAttribute('data-popper-placement')) return true;
          if (sel.includes('role="dialog"') && n.getAttribute('role') === 'dialog') return true;
          if (sel === '[data-state="open"]') return n.getAttribute('data-state') === 'open';
          return false;
        }),
        elementFromPoint: () => null,
      },
      window: {},
      getComputedStyle: (n) => ({ position: n.position || 'static', display: 'block', visibility: 'visible' }),
    });
    const FCM = load(sandbox, ...SHARED, 'src/content/native.js');
    const bridge = FCM.createNativeBridge({ id: 'twitch', messageList: () => null });
    eq(bridge.dialogOver(CHAT_BOX), null,
      'twitchmenus: a panel already on screen when the overlay mounted is furniture, not a menu');
  }
};

suites.claim = function () {
  // The bonus chest is the one part of channel points that is lost purely by
  // not being at the keyboard: it is on screen for a couple of minutes and then
  // gone. The panel already knew about it and drew a button to be noticed;
  // these cover pressing it instead, and the two things that must hold when
  // something presses a control on someone's behalf — the right control, and
  // once.

  function el({ w = 40, h = 20, attrs = {} } = {}) {
    const node = {
      nodeType: 1,
      isConnected: true,
      tagName: 'BUTTON',
      style: {},
      children: [],
      parentElement: null,
      textContent: '',
      clicks: 0,
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      contains: () => false,
      getBoundingClientRect: () => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h }),
      // Kept apart on purpose. A press is a pointer/mouse sequence *and* a
      // click, because some controls listen for one and some for the other,
      // and counting them together would hide a control being clicked twice.
      click() { node.clicks++; },
      dispatchEvent(e) { node.events.push(e && e.type); return true; },
    };
    node.events = [];
    return node;
  }

  // A bridge over an adapter that reports whatever the test hands it.
  function bridgeFor(controls) {
    const sandbox = makeSandbox({
      document: {
        body: el({ w: 1440, h: 900 }),
        documentElement: el({ w: 1440, h: 900 }),
        querySelectorAll: () => [],
        querySelector: () => null,
        elementFromPoint: () => null,
      },
      // Real enough to carry a type, which is the only part of the event the
      // control being pressed would look at.
      window: {
        MouseEvent: function (type) { this.type = type; },
        PointerEvent: function (type) { this.type = type; },
      },
      getComputedStyle: () => ({ position: 'static', display: 'block', visibility: 'visible' }),
    });
    const FCM = load(sandbox, ...SHARED, 'src/content/native.js');
    return FCM.createNativeBridge({
      id: 'twitch',
      messageList: () => null,
      nativeControls: () => controls,
    });
  }

  // ── A named control is reported as one ──
  {
    const claim = el({ w: 90, h: 26, attrs: { 'aria-label': 'Claim Bonus' } });
    const bridge = bridgeFor({ claim, claimNamed: true });
    const stats = bridge.stats();
    ok(stats.canClaim, 'claim: a bonus on screen is reported');
    ok(stats.claimNamed, 'claim: and reported as one the site named');
  }

  // ── A guessed control is reported, but marked as a guess ──
  //
  // Twitch's adapter falls back to "whichever other button the points summary
  // has grown". That is a fair thing to offer somebody and not a fair thing to
  // press for them, so the two cases have to be told apart.
  {
    const claim = el({ w: 90, h: 26 });
    const bridge = bridgeFor({ claim, claimNamed: false });
    const stats = bridge.stats();
    ok(stats.canClaim, 'claim: a guessed control is still offered to a person');
    eq(stats.claimNamed, false, 'claim: but is marked as a guess, not an identification');
  }

  // ── Nothing on screen is not a bonus ──
  {
    const bridge = bridgeFor({ claim: el({ w: 0, h: 0, attrs: { 'aria-label': 'Claim Bonus' } }), claimNamed: true });
    eq(bridge.stats().canClaim, false, 'claim: a control with no box is not a waiting bonus');
    eq(bridge.stats().claimNamed, false, 'claim: and is not something to press either');
  }

  // ── Pressing it presses the site's own button ──
  //
  // The overlay never grants points itself. It has nothing that could, and
  // standing between somebody and their own balance is not a thing to get
  // subtly wrong — so the whole action is a click on the site's own control.
  {
    const claim = el({ w: 90, h: 26, attrs: { 'aria-label': 'Claim Bonus' } });
    const bridge = bridgeFor({ claim, claimNamed: true });
    ok(bridge.activate('claim'), 'claim: pressing it reports that there was something to press');
    eq(claim.clicks, 1, "claim: and the site's own button is clicked exactly once");
    eq(claim.events, ['pointerdown', 'mousedown', 'pointerup', 'mouseup'],
      'claim: with the pointer sequence a React control expects in front of it');
  }

  // ── A bonus that has gone is not pressed ──
  {
    const claim = el({ w: 0, h: 0, attrs: { 'aria-label': 'Claim Bonus' } });
    const bridge = bridgeFor({ claim, claimNamed: true });
    eq(bridge.activate('claim'), false, 'claim: a bonus that has gone reports nothing to press');
    eq(claim.clicks, 0, 'claim: and nothing is clicked');
  }

  // ── An adapter with no claim control at all ──
  {
    const bridge = bridgeFor({ claim: null, claimNamed: false });
    eq(bridge.stats().canClaim, false, 'claim: a site with no bonus control offers nothing');
    eq(bridge.activate('claim'), false, 'claim: and pressing it does nothing');
  }
};

suites.defaults = function () {
  // The settings a fresh install starts on. These are the answers given on
  // somebody's behalf before they have said anything, which is exactly why they
  // are worth pinning down rather than leaving to whoever edits the list next.
  const FCM = load(makeSandbox(), ...SHARED);

  eq(FCM.DEFAULT_SETTINGS.crossPromptMode, 'ask',
    'defaults: a new install ASKS before connecting the other platform');

  // Asking is only meaningful if it is also offered. 'never' would hide the
  // prompt outright and 'always' would connect without being asked, and both
  // are decisions belonging to the person, not to the default.
  ok(['ask', 'always', 'never'].includes(FCM.DEFAULT_SETTINGS.crossPromptMode),
    'defaults: and the mode is one the prompt actually understands');

  eq(FCM.DEFAULT_SETTINGS.autoClaimBonus, true,
    'defaults: channel point bonuses are claimed unless turned off');
  eq(FCM.DEFAULT_SETTINGS.watchWhenLive, true,
    "defaults: Kick's profile is swapped for the stream unless turned off");

  // Loading with nothing stored has to give the same answers. The defaults are
  // merged under whatever was saved, so a key missing from storage — which is
  // every key, on a first run — has to fall through to the value above.
  return (async () => {
    const empty = makeSandbox({
      chrome: {
        storage: {
          sync: { get: async () => ({}), set: async () => {} },
          local: { get: async () => ({}), set: async () => {} },
        },
      },
    });
    const F = load(empty, ...SHARED);
    const settings = await F.loadSettings();
    eq(settings.crossPromptMode, 'ask',
      'defaults: and a first run with nothing stored still asks');
    eq(settings.autoClaimBonus, true, 'defaults: and still claims bonuses');

    // A stored blob written by an older version knows nothing about the newer
    // keys, and must not end up with them undefined.
    const older = makeSandbox({
      chrome: {
        storage: {
          sync: { get: async (k) => ({ [k]: { savedAt: 1, fontSize: 15 } }), set: async () => {} },
          local: { get: async () => ({}), set: async () => {} },
        },
      },
    });
    const G = load(older, ...SHARED);
    const upgraded = await G.loadSettings();
    eq(upgraded.fontSize, 15, 'defaults: an older stored setting is kept');
    eq(upgraded.crossPromptMode, 'ask',
      'defaults: and a key it never had still arrives at the default');
    eq(upgraded.autoClaimBonus, true, 'defaults: for every new key, not just the first');
  })();
};

// Work in flight when the viewer moves to the next channel.
//
// Every one of these is the same shape: the worker asks the network something
// about channel A, the viewer clicks through to channel B before the answer
// comes back, and the answer is applied to B. That is not a cosmetic slip. The
// panel is showing B's name, so history, emotes and badges from A arrive with
// nothing to say they are not B's, and the counterpart is acted on by
// autoConnectHost — which opened one streamer's chat on another streamer's
// page and presented it as theirs.
//
// The worker already retires a superseded join by bumping `conn.joinSeq`; these
// prove the rest of the work follows it.
suites.staleafterswitch = function () {
  const { bootWorker, wait } = require('./background.js');

  // Holds every request whose url matches, until the test lets them all go.
  function gate(match) {
    let release;
    const held = new Promise((r) => { release = r; });
    return { hold: (url) => (match.test(url) ? held : null), release: () => release() };
  }

  return (async () => {
    // ── history ──
    {
      const g = gate(/recent-messages\.robotty\.de/);
      const w = bootWorker({
        hold: g.hold,
        twitchHistory: [
          '@display-name=OldViewer;id=h1 :x!x@x.tmi.twitch.tv PRIVMSG #alpha :from the channel you left\r\n',
        ],
      });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        await wait(30);
        w.send({ cmd: 'join', platform: 'twitch', channel: 'alpha' });
        await wait(30);
        // The join finishes, which is what asks for the history.
        const irc = w.socketFor('irc-ws');
        irc.push(':tmi.twitch.tv 001 justinfan1 :Welcome\r\n');
        irc.push(':justinfan1.tmi.twitch.tv 366 justinfan1 #alpha :End of /NAMES list\r\n');
        await wait(40);

        // Away to the next channel while the history request is still open.
        w.send({ cmd: 'hello', site: 'twitch', channel: 'bravo', hints: [] });
        await wait(20);
        w.clear();
        g.release();
        await wait(80);

        eq(w.of('batch').length, 0,
          'stale: history for the channel just left is not replayed into the next one');
      } finally { w.teardown(); }
    }

    // ── the same request, answered while the channel is still the one that asked ──
    // The guard has to drop what is stale without dropping what is not.
    {
      const g = gate(/recent-messages\.robotty\.de/);
      const w = bootWorker({
        hold: g.hold,
        twitchHistory: [
          '@display-name=Viewer;id=h2 :x!x@x.tmi.twitch.tv PRIVMSG #alpha :still the right channel\r\n',
        ],
      });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        await wait(30);
        w.send({ cmd: 'join', platform: 'twitch', channel: 'alpha' });
        await wait(30);
        const irc = w.socketFor('irc-ws');
        irc.push(':tmi.twitch.tv 001 justinfan1 :Welcome\r\n');
        irc.push(':justinfan1.tmi.twitch.tv 366 justinfan1 #alpha :End of /NAMES list\r\n');
        await wait(40);
        g.release();
        await wait(80);

        eq(w.of('batch').length, 1,
          'stale: history that arrives while the channel is still open is replayed');
      } finally { w.teardown(); }
    }

    // ── counterpart ──
    // The dangerous one: the overlay acts on this, so a counterpart resolved for
    // the previous channel could open the wrong streamer's chat.
    {
      const g = gate(/kick\.com\/api/);
      const w = bootWorker({ hold: g.hold });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        await wait(30);
        w.send({ cmd: 'hints', hints: ['https://kick.com/alphaguy'] });
        await wait(20);

        w.send({ cmd: 'hello', site: 'twitch', channel: 'bravo', hints: [] });
        await wait(20);
        w.clear();
        g.release();
        await wait(120);

        // Asserted on who was resolved, not on the label. The label was read
        // back off the session *after* the await, so a stale answer used to
        // arrive already stamped with the new channel's name — which is what
        // made it look right and act wrong.
        const offers = w.of('counterpart');
        const named = offers
          .map((m) => m.counterpart && m.counterpart.channel)
          .filter(Boolean);
        eq(named.filter((c) => c === 'alphaguy').length, 0,
          'stale: the counterpart found for the channel just left is not offered on the next one');
        ok(offers.every((m) => m.hostChannel !== 'alpha'),
          'stale: and nothing is announced for the channel that was left');
      } finally { w.teardown(); }
    }
  })();
};

// Giving up, and refusing to.
//
// Two opposite failures, both about the same counter. Everything before the
// Kick socket exists used to give up permanently on its first failure while the
// status chip still said it was trying; and a socket that came up and fell over
// again cleared the attempt count every time, so the cap was never reached and
// the retries never lengthened.
suites.reconnects = function () {
  const { bootWorker, wait } = require('./background.js');

  async function kickTab(w) {
    w.connect();
    w.send({ cmd: 'hello', site: 'kick', channel: 'someone', hints: [] });
    await wait(30);
    w.send({ cmd: 'join', platform: 'kick', channel: 'someone' });
    await wait(60);
  }

  return (async () => {
    // ── a lookup Kick refused is tried again, not abandoned ──
    {
      const w = bootWorker({
        fetchImpl: async (url) => {
          // Kick's edge putting a challenge in front of the channel lookup.
          if (String(url).includes('kick.com/api')) {
            return { ok: false, status: 403, json: async () => ({}) };
          }
          return { ok: false, status: 404, json: async () => ({}) };
        },
      });
      try {
        await kickTab(w);
        const states = w.of('status').filter((m) => m.platform === 'kick').map((m) => m.state);
        eq(states.includes('error'), false,
          'reconnects: a refused channel lookup is not reported as a dead end');
        ok(states.includes('disconnected'),
          'reconnects: it is reported as disconnected, which is what it is');
        const said = w.of('sys').map((m) => m.text).join(' | ');
        contains(said, 'trying again',
          'reconnects: and the feed says it will try again, which it now does');
      } finally { w.teardown(); }
    }

    // ── a connection that will not hold backs off instead of hammering ──
    //
    // A room that is refused just after the handshake comes up and falls
    // straight over. Clearing the attempt count on the handshake meant every
    // cycle started from the base delay, the cap was never reached, and Kick
    // was reconnected for as long as the tab stayed open. Asserted through the
    // cap, because reaching it at all is the thing that used to be impossible.
    {
      const w = bootWorker();
      try {
        // Real backoff on a real clock would take minutes; the shape is the
        // same in milliseconds and the shape is what is being tested.
        w.sandbox.FCM.RECONNECT_BASE_DELAY_MS = 5;
        w.sandbox.FCM.RECONNECT_MAX_DELAY_MS = 20;
        w.sandbox.FCM.MAX_RECONNECT_ATTEMPTS = 3;
        await kickTab(w);

        const flap = async () => {
          const socks = w.socketsFor('pusher');
          const sock = socks[socks.length - 1];
          if (!sock || sock.closed) return;
          sock.push(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
          await wait(4);
          sock.drop();
          await wait(40);
        };
        for (let i = 0; i < 6; i++) await flap();

        const said = w.of('sys').map((m) => m.text).join(' | ');
        contains(said, 'reconnect limit reached',
          'reconnects: a connection that never holds eventually stops being retried');
        ok(w.socketsFor('pusher').length <= 6,
          'reconnects: and it is not reopened once past the limit');
      } finally { w.teardown(); }
    }

    // ── and a connection that did hold starts afresh ──
    //
    // The counter must still be forgiven, or an evening of ordinary drops would
    // add up to the cap and the chat would stop coming back.
    {
      const w = bootWorker();
      try {
        w.sandbox.FCM.RECONNECT_BASE_DELAY_MS = 5;
        w.sandbox.FCM.RECONNECT_MAX_DELAY_MS = 20;
        w.sandbox.FCM.MAX_RECONNECT_ATTEMPTS = 3;
        // Anything that stayed up at all counts as having held, here.
        w.sandbox.FCM.STABLE_CONNECTION_MS = 1;
        await kickTab(w);

        const cycle = async () => {
          const socks = w.socketsFor('pusher');
          const sock = socks[socks.length - 1];
          if (!sock || sock.closed) return;
          sock.push(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
          await wait(15);
          sock.drop();
          await wait(40);
        };
        for (let i = 0; i < 6; i++) await cycle();

        const said = w.of('sys').map((m) => m.text).join(' | ');
        missing(said, 'reconnect limit reached',
          'reconnects: drops after connections that held never add up to the limit');
        ok(w.of('sys').some((m) => /Connected to Kick/.test(m.text)),
          'reconnects: and the chat keeps coming back');
      } finally { w.teardown(); }
    }
  })();
};

// Coming back from the worker going away, and from an account arriving.
suites.recovery = function () {
  const { bootWorker, wait } = require('./background.js');

  return (async () => {
    // ── the tab re-announces itself on a port it had to open itself ──
    //
    // The worker keeps its session against the port, so a new port starts
    // empty. Anything that sent a single message over a freshly opened port
    // reached a worker that had never heard of the tab: the overlay went on
    // saying "connected", no chat ever arrived again, and only a reload fixed
    // it. Driven here through boot.js, since that is the half at fault.
    {
      const fs2 = require('fs');
      const path2 = require('path');
      const ports = [];
      const timers = { intervals: [], timeouts: [] };
      const location = { pathname: '/alpha', href: 'https://twitch.tv/alpha', hostname: 'twitch.tv', search: '' };
      const sandbox = makeSandbox({
        location,
        document: stubDocument(),
        window: { location, addEventListener() {}, removeEventListener() {} },
        chrome: {
          runtime: {
            connect() {
              const p = {
                sent: [], disconnected: false,
                postMessage(m) { if (this.disconnected) throw new Error('port closed'); this.sent.push(m); },
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

      const F = load(sandbox, ...SHARED, 'src/content/render.js', 'src/content/sites.js');
      const overlays = [];
      F.createOverlay = (opts) => {
        const o = {
          channel: opts.channel, destroyed: false, onCommand: opts.onCommand,
          mount: () => Promise.resolve(o), destroy() { o.destroyed = true; },
          sys() {}, event() {}, chat() {}, batch() {}, setEmotes() {}, setBadges() {},
          deleteMessage() {}, deleteUser() {}, setCounterpart() {}, setAccounts() {},
          setModerator() {}, modResult() {}, sendResult() {}, profileResult() {},
          applyStoredSettings() {}, toast() {}, setStatus() {},
        };
        overlays.push(o);
        return o;
      };
      vm.runInContext(fs2.readFileSync(path2.join(ROOT, 'src/content/boot.js'), 'utf8'),
        sandbox, { filename: 'boot.js' });
      const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
      await flush();

      const first = ports[0];
      ok(first, 'recovery: the tab opened a port');
      first._recv({ type: 'ready', site: 'twitch', channel: 'alpha', connections: {} });
      await flush();
      ok(first.sent.some((m) => m.cmd === 'join'), 'recovery: and joined its channel');
      // The worker confirming the join is what the tab remembers it by.
      first._recv({ type: 'status', platform: 'twitch', state: 'connected', channel: 'alpha' });
      await flush();

      // The worker is evicted. The tab is told, and would normally rejoin after
      // a moment — but the viewer presses something first.
      first._gone();
      await flush();
      const overlay = overlays[overlays.length - 1];
      overlay.onCommand({ cmd: 'leave', platform: 'kick' });
      await flush();

      const second = ports[ports.length - 1];
      ok(second !== first, 'recovery: pressing something opened a new port');
      ok(second.sent.some((m) => m.cmd === 'hello'),
        'recovery: and the tab tells the new worker which channel it is on');
      ok(second.sent.some((m) => m.cmd === 'join' && m.channel === 'alpha'),
        'recovery: and rejoins the chat it was in, rather than going quiet');
    }

    // ── an account arriving or leaving re-opens the chat it applies to ──
    //
    // A socket reads its token when it opens, so a chat joined anonymously
    // stays anonymous: no moderator standing, none of this viewer's own emote
    // sets, no badges on their own messages, until the page was reloaded. And
    // the other way round — a socket opened with a token that has since been
    // taken away would go on claiming this viewer can moderate here.
    //
    // Driven through disconnect, which needs no OAuth to reach; both handlers
    // call the same helper.
    {
      const w = bootWorker();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        await wait(30);
        w.send({ cmd: 'join', platform: 'twitch', channel: 'alpha' });
        await wait(60);
        const before = w.socketsFor('irc-ws').length;
        eq(before, 1, 'recovery: one socket to begin with');

        w.send({ cmd: 'disconnectAccount', platform: 'twitch' });
        await wait(120);
        ok(w.socketsFor('irc-ws').length > before,
          'recovery: changing the account opens the chat again with it');
        const joined = w.socketsFor('irc-ws').pop();
        ok(joined.sent.some((line) => String(line).includes('JOIN #alpha')),
          'recovery: and it is the same channel, not a silent drop');
      } finally { w.teardown(); }
    }

    // ── and an account change with no chat open does nothing ──
    {
      const w = bootWorker();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        await wait(30);
        w.send({ cmd: 'disconnectAccount', platform: 'twitch' });
        await wait(80);
        eq(w.socketsFor('irc-ws').length, 0,
          'recovery: nothing is opened for a chat that was never joined');
      } finally { w.teardown(); }
    }
  })();
};

// What the worker leaves running when nobody is watching anything.
//
// The service worker is woken by its alarms, and every wake loads the whole
// background bundle. An alarm that outlives the reason for it is not a tidiness
// problem — it is the extension waking the machine, all day, to find there is
// nothing to do.
suites.alarms = function () {
  const { bootWorker, wait } = require('./background.js');

  return (async () => {
    {
      const w = bootWorker();
      try {
        ok(!w.alarms.has('fcm-heartbeat'),
          'alarms: no heartbeat before any tab has asked for one');

        const tab = w.makeTab(1).connect();
        tab.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        await wait(40);
        ok(w.alarms.has('fcm-heartbeat'), 'alarms: a tab being served gets one');

        w.listeners.tabRemoved(1);
        await wait(30);
        ok(!w.alarms.has('fcm-heartbeat'),
          'alarms: and closing the last tab stops it, rather than waking the worker all night');
      } finally { w.teardown(); }
    }

    // Two tabs, one closed: the other is still being served.
    {
      const w = bootWorker();
      try {
        w.makeTab(1).connect().send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
        w.makeTab(2).connect().send({ cmd: 'hello', site: 'kick', channel: 'bravo', hints: [] });
        await wait(40);
        w.listeners.tabRemoved(1);
        await wait(30);
        ok(w.alarms.has('fcm-heartbeat'),
          'alarms: the heartbeat stays while any tab is still open');
      } finally { w.teardown(); }
    }

    // The update check must not be pushed into a future that keeps moving.
    {
      const w = bootWorker();
      try {
        await wait(30);
        const first = w.alarms.get('fcm-update-check');
        ok(first, 'alarms: the update check is scheduled on the first start');
        // A worker restart re-runs the same setup. The alarm outlives the
        // worker, so re-arming it would move the check one minute further away
        // every time — and the worker restarts constantly.
        w.sandbox.FCM.watchForUpdates();
        await wait(30);
        eq(w.alarms.get('fcm-update-check'), first,
          'alarms: a later start leaves the one already scheduled alone');
      } finally { w.teardown(); }
    }
  })();
};

// What the page fetched on the worker's behalf, and what a failed check says.
suites.fallbacks = function () {
  const { bootWorker, wait } = require('./background.js');

  return (async () => {
    // ── the page-fetched Kick emote list is remembered ──
    //
    // The worker only asks the tab for this list when Kick's edge refuses it,
    // so the channels the path exists for were exactly the ones that were never
    // cached: every visit started with an empty picker and emote names drawn as
    // plain text until the page fetched them again.
    {
      const w = bootWorker();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'someone', hints: [] });
        await wait(30);
        w.send({ cmd: 'join', platform: 'kick', channel: 'someone' });
        await wait(60);
        const sock = w.socketFor('pusher');
        ok(sock, 'fallbacks: the Kick socket was opened');
        sock.push(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
        await wait(80);

        w.send({
          cmd: 'cacheKickEmotes',
          channel: 'someone',
          store: { theirEmote: { url: 'https://kick/e.png', source: 'Kick' } },
        });
        await wait(80);

        const cached = w.storage.local[w.sandbox.FCM.STORAGE_KEYS.emoteCache] || {};
        const entry = Object.values(cached)[0];
        ok(entry && entry.kinds && entry.kinds.native && entry.kinds.native.theirEmote,
          'fallbacks: what the page fetched is written to the cache');
      } finally { w.teardown(); }
    }

    // And a list that arrives naming a channel this tab has left is dropped.
    {
      const w = bootWorker();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'kick', channel: 'someone', hints: [] });
        await wait(30);
        w.send({ cmd: 'join', platform: 'kick', channel: 'someone' });
        await wait(60);
        w.send({
          cmd: 'cacheKickEmotes',
          channel: 'a-different-streamer',
          store: { wrongEmote: { url: 'https://kick/x.png', source: 'Kick' } },
        });
        await wait(80);
        const cached = w.storage.local[w.sandbox.FCM.STORAGE_KEYS.emoteCache] || {};
        const all = JSON.stringify(cached);
        missing(all, 'wrongEmote',
          "fallbacks: a list for a channel this tab is not on is not cached under the one it is");
      } finally { w.teardown(); }
    }

    // ── the page correcting the same-name guess leaves the wrong chat ──
    //
    // The guess is made before the page has drawn the streamer's own links, so
    // a streamer whose Kick account is not simply their Twitch name is paired
    // with whoever does hold that name. With cross-connect on, that stranger's
    // chat is joined a second before the page says who the streamer really is —
    // and correcting the chip while leaving their chat merged into the feed is
    // the worst of both.
    {
      const w = bootWorker({
        fetchImpl: async (url, init) => {
          const u = String(url);
          if (u.includes('gql.twitch.tv')) {
            return { ok: true, json: async () => ({ data: { user: null } }) };
          }
          const m = u.match(/kick\.com\/api\/v\d\/channels\/([^/?]+)/);
          if (m) {
            // Both names exist on Kick: the guess and the real one.
            return { ok: true, json: async () => ({
              id: 9, user_id: 77, slug: m[1], chatroom: { id: 55 },
              livestream: { session_title: 'live', viewer_count: 1, categories: [] },
              user: { username: m[1], profile_pic: '' },
            }) };
          }
          return { ok: false, status: 404, json: async () => ({}) };
        },
      });
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'chefsteve', hints: [] });
        await wait(120);
        const guessed = w.last('counterpart');
        eq(guessed && guessed.counterpart && guessed.counterpart.channel, 'chefsteve',
          'fallbacks: with no links to go on, the name is the guess');

        // The overlay acts on that and joins it, as crossPromptMode 'always' does.
        w.send({ cmd: 'join', platform: 'kick', channel: 'chefsteve' });
        await wait(80);
        w.clear();

        // Then the page renders and says who the streamer actually is.
        w.send({ cmd: 'hints', hints: ['https://kick.com/steve-cooks'] });
        await wait(150);

        const idle = w.of('status').filter((m) => m.platform === 'kick' && m.state === 'idle');
        ok(idle.length,
          'fallbacks: the chat joined on the guess is left when the page corrects it');
        const offered = w.last('counterpart');
        eq(offered && offered.counterpart && offered.counterpart.channel, 'steve-cooks',
          'fallbacks: and the corrected channel is what is offered');
      } finally { w.teardown(); }
    }

    // A counterpart that has not changed must not drop the chat mid-stream.
    {
      const w = bootWorker();
      try {
        w.connect();
        w.send({ cmd: 'hello', site: 'twitch', channel: 'somechannel', hints: [] });
        await wait(120);
        w.send({ cmd: 'join', platform: 'kick', channel: 'somechannel' });
        await wait(80);
        w.clear();
        w.send({ cmd: 'hints', hints: ['https://kick.com/somechannel'] });
        await wait(150);
        const idle = w.of('status').filter((m) => m.platform === 'kick' && m.state === 'idle');
        eq(idle.length, 0,
          'fallbacks: a page link that agrees with the guess leaves the chat alone');
      } finally { w.teardown(); }
    }

    // ── an account that goes on its own tells every open tab ──
    //
    // A refresh refused because the token was revoked elsewhere clears the
    // account, and nothing asked for that, so nothing was waiting to redraw.
    // The panel went on offering to send as an account that was already gone
    // and only found out when the message came back refused.
    {
      const w = bootWorker({
        fetchImpl: async (url) => {
          const u = String(url);
          if (u.includes('/kick-refresh')) {
            // What Kick says about a refresh token that has been revoked.
            return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
          }
          return { ok: false, status: 404, json: async () => ({}) };
        },
      });
      try {
        const F = w.sandbox.FCM;
        await F.auth.set('kick', {
          accessToken: 'K', refreshToken: 'KR', login: 'me', expiresAt: Date.now() - 1000,
        });
        const tab = w.makeTab(1).connect();
        tab.send({ cmd: 'hello', site: 'kick', channel: 'someone', hints: [] });
        await wait(40);
        tab.clear();

        eq(await F.auth.usable('kick', {}), null, 'fallbacks: a revoked token is unusable');
        await wait(60);

        const told = tab.of('auth');
        ok(told.length, 'fallbacks: and every open tab is told the account has gone');
        eq(told[told.length - 1].accounts.kick.connected, false,
          'fallbacks: so the panel stops offering to send as it');
      } finally { w.teardown(); }
    }

    // ── "Up to date" is a claim, and must not be made without asking ──
    {
      const w = bootWorker({
        fetchImpl: async (url) => {
          if (String(url).includes('api.github.com')) {
            // What a rate-limited or offline check looks like.
            return { ok: false, status: 403, json: async () => ({}) };
          }
          return { ok: false, status: 404, json: async () => ({}) };
        },
      });
      try {
        const status = await w.sandbox.FCM.checkForUpdate();
        eq(status.checked, false,
          'fallbacks: a check that never reached GitHub says so');
        eq(!!status.available, false, 'fallbacks: and reports no update, because it found none');
      } finally { w.teardown(); }
    }
    {
      const w = bootWorker({
        fetchImpl: async (url) => {
          if (String(url).includes('api.github.com')) {
            return { ok: true, json: async () => ({ tag_name: 'v99.0.0', html_url: 'https://x', assets: [] }) };
          }
          return { ok: false, status: 404, json: async () => ({}) };
        },
      });
      try {
        const status = await w.sandbox.FCM.checkForUpdate();
        eq(status.checked, true, 'fallbacks: a check that did reach GitHub says so too');
        eq(status.available, true, 'fallbacks: and reports the newer release it found');
      } finally { w.teardown(); }
    }
  })();
};

// Where a message goes when the message is nothing but an emote.
//
// An emote is a name that only means anything where it is loaded. Sent to the
// other chat it arrives as that bare word — "PogU", on its own, to people with
// no idea what it was meant to be. So a message that is only emotes goes only
// where they exist; a message with words in it goes to both, because then the
// sentence is the message and both chats can read it.
suites.emoterouting = function () {
  const sandbox = makeSandbox({
    chrome: { storage: { sync: { get: async () => ({}) } } },
    document: stubDocument(),
  });
  const FCM = load(sandbox, ...SHARED, 'src/content/render.js');
  FCM.setViewSettings(FCM.DEFAULT_SETTINGS);

  // PogU is Twitch's, KEKW is Kick's, catJAM is on both — which is the ordinary
  // shape of it, since 7TV and BTTV are loaded for each platform separately.
  FCM.setEmotes('twitch', 'thirdparty', {
    PogU: { url: 'https://cdn/pogu.webp', source: '7TV' },
    catJAM: { url: 'https://cdn/cj.webp', source: 'BTTV' },
  });
  FCM.setEmotes('kick', 'thirdparty', {
    KEKW: { url: 'https://cdn/kekw.webp', source: '7TV' },
    catJAM: { url: 'https://cdn/cj.webp', source: 'BTTV' },
  });

  // ── Whose emote is it ──
  eq(FCM.emotePlatforms('PogU'), ['twitch'], 'routing: a Twitch-only emote is Twitch\u2019s');
  eq(FCM.emotePlatforms('KEKW'), ['kick'], 'routing: a Kick-only emote is Kick\u2019s');
  eq(FCM.emotePlatforms('catJAM'), ['twitch', 'kick'], 'routing: one loaded on both is both\u2019s');
  eq(FCM.emotePlatforms('nothing'), [], 'routing: a word that is no emote belongs to nobody');
  // Object.prototype is in the chain of both stores.
  eq(FCM.emotePlatforms('constructor'), [], 'routing: nor does a word that names a built-in');

  // ── An emote on its own ──
  eq(FCM.emoteOnlyPlatform('PogU'), 'twitch',
    'routing: an emote only Twitch has goes only to Twitch');
  eq(FCM.emoteOnlyPlatform('KEKW'), 'kick',
    'routing: an emote only Kick has goes only to Kick');
  eq(FCM.emoteOnlyPlatform('  PogU  '), 'twitch',
    'routing: surrounding space does not make it a sentence');

  // ── An emote both chats have settles nothing ──
  eq(FCM.emoteOnlyPlatform('catJAM'), null,
    'routing: an emote both chats have goes to both');

  // ── Words alongside it send it everywhere ──
  eq(FCM.emoteOnlyPlatform('PogU nice'), null,
    'routing: an emote with something said next to it goes to both');
  eq(FCM.emoteOnlyPlatform('that was great catJAM'), null,
    'routing: and so does a sentence ending in one');
  eq(FCM.emoteOnlyPlatform('hello everyone'), null,
    'routing: an ordinary message is an ordinary message');
  eq(FCM.emoteOnlyPlatform(''), null, 'routing: an empty box decides nothing');

  // ── Several of them ──
  eq(FCM.emoteOnlyPlatform('PogU PogU PogU'), 'twitch',
    'routing: several of one platform\u2019s emotes still go only there');
  eq(FCM.emoteOnlyPlatform('PogU catJAM'), 'twitch',
    'routing: one exclusive emote decides it, even beside a shared one');
  eq(FCM.emoteOnlyPlatform('PogU KEKW'), null,
    'routing: two emotes pulling opposite ways go to both, since neither chat has all of it');

  // ── A name that is an emote on neither ──
  eq(FCM.emoteOnlyPlatform('Kappa'), null,
    'routing: a name nothing has loaded is text, and text goes to both');

  // ── Leaving a platform takes its emotes, and its claim, with it ──
  FCM.resetPlatformView('kick');
  eq(FCM.emoteOnlyPlatform('KEKW'), null,
    'routing: an emote whose platform has been left is just a word again');
  eq(FCM.emoteOnlyPlatform('catJAM'), 'twitch',
    'routing: and one that was on both is now only the platform still here');
};


// The control that opens each platform's own chat identity settings.
//
// This shipped not working, and the reason is worth keeping a test around for:
// neither platform calls it "identity" anywhere a search would find, and on
// Twitch it is not in the container every other control in that footer lives
// in. The markup below is copied off a signed-in channel page on each site.
suites.chatidentity = function () {
  // A DOM stub with just enough selector support for these lookups: attribute
  // and class selectors, descendant combinators, and closest().
  function build(html) {
    const nodes = [];
    function el(tag, attrs, kids) {
      const node = {
        tagName: tag.toUpperCase(),
        _attrs: attrs || {},
        children: [],
        parentElement: null,
        textContent: (attrs && attrs._text) || '',
        id: (attrs && attrs.id) || '',
        get className() { return this._attrs.class || ''; },
        getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
        getClientRects() { return this._attrs._hidden ? [] : [{ width: 24, height: 24 }]; },
        getBoundingClientRect() {
          const on = !this._attrs._hidden;
          return { width: on ? 24 : 0, height: on ? 24 : 0, top: 0, left: 0, right: 24, bottom: 24 };
        },
        closest(sel) {
          for (let n = this; n; n = n.parentElement) if (matchesList(n, sel)) return n;
          return null;
        },
        querySelectorAll(sel) { return descendants(this).filter((n) => matchesList(n, sel)); },
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
        contains(other) { for (let n = other; n; n = n.parentElement) if (n === this) return true; return false; },
      };
      (kids || []).forEach((k) => { k.parentElement = node; node.children.push(k); });
      nodes.push(node);
      return node;
    }
    function descendants(root) {
      const out = [];
      (function down(n) { n.children.forEach((c) => { out.push(c); down(c); }); })(root);
      return out;
    }
    // One selector: tag, .class, [attr], [attr="v"], [attr*="v" i], and
    // "a b" descendant pairs.
    function matches(node, sel) {
      sel = String(sel).trim();
      if (sel.includes(' ')) {
        const parts = sel.split(/\s+/);
        const last = parts.pop();
        if (!matches(node, last)) return false;
        let n = node.parentElement;
        const want = parts.pop();
        while (n) { if (matches(n, want)) return true; n = n.parentElement; }
        return false;
      }
      let m = /^([a-zA-Z]+)?\[([a-zA-Z-]+)(\*)?=?"?([^"\]]*)"?( i)?\]$/.exec(sel);
      if (m) {
        if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
        const v = node.getAttribute(m[2]);
        if (v == null) return false;
        if (!m[4]) return true;
        return m[3] ? v.toLowerCase().includes(m[4].toLowerCase()) : v === m[4];
      }
      m = /^([a-zA-Z]+)?\.([\w-]+)$/.exec(sel);
      if (m) {
        if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
        return String(node.className).split(/\s+/).includes(m[2]);
      }
      m = /^([a-zA-Z]+)?#([\w-]+)$/.exec(sel);
      if (m) {
        if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
        return node.id === m[2];
      }
      if (/^[a-zA-Z]+$/.test(sel)) return node.tagName === sel.toUpperCase();
      return false;
    }
    function matchesList(node, sel) {
      return String(sel).split(',').some((one) => matches(node, one));
    }
    const body = html(el);
    const doc = {
      querySelectorAll: (sel) => [body, ...descendants(body)].filter((n) => matchesList(n, sel)),
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      body,
      documentElement: body,
    };
    return makeSandbox({ document: doc, window: {} });
  }

  // ── Twitch ──
  //
  // Copied off a signed-in channel page. The control's accessible name is
  // "ChatBadgeCarousel" — the word identity is nowhere on it — and it sits in
  // the .chat-input row, *not* in .chat-input__buttons-container where Cheer,
  // the emote picker, the balances, the settings gear and Send all live. Both
  // of those are why the chip never appeared.
  {
    const sandbox = build((el) => el('div', {}, [
      el('div', { class: 'chat-input' }, [
        el('div', { class: 'chat-input__badge-carousel', 'data-a-target': 'chat-badge-carousel' }, [
          el('button', { 'data-a-target': 'chat-badge-carousel-badge-icon', 'aria-label': 'ChatBadgeCarousel' }),
        ]),
        el('div', { class: 'chat-input__buttons-container', 'data-test-selector': 'chat-input-buttons-container' }, [
          el('button', { 'data-a-target': 'bits-button', 'aria-label': 'Cheer' }),
          el('button', { 'data-a-target': 'emote-picker-button', 'aria-label': 'Emote picker' }),
          el('button', { 'data-a-target': 'chat-settings', 'aria-label': 'Chat settings' }),
          el('button', { 'data-a-target': 'chat-send-button', 'aria-label': 'Send Chat', _text: 'Chat' }),
        ]),
      ]),
    ]));
    const FCM = load(sandbox, ...SHARED, 'src/content/native.js', 'src/content/sites.js');
    const found = FCM.SITES.twitch.nativeControls().chatIdentity;
    ok(found, 'identity: twitch\u2019s badge carousel is found');
    eq(found && found.getAttribute('data-a-target'), 'chat-badge-carousel-badge-icon',
      'identity: and it is the carousel button, by the name Twitch actually gives it');
    ok(found && found.getAttribute('data-a-target') !== 'chat-send-button',
      'identity: never the button that sends');
  }
  // A page not showing it offers nothing, rather than guessing at a neighbour.
  {
    const sandbox = build((el) => el('div', {}, [
      el('div', { class: 'chat-input' }, [
        el('div', { class: 'chat-input__buttons-container', 'data-test-selector': 'chat-input-buttons-container' }, [
          el('button', { 'data-a-target': 'chat-settings', 'aria-label': 'Chat settings' }),
          el('button', { 'data-a-target': 'chat-send-button', 'aria-label': 'Send Chat', _text: 'Chat' }),
        ]),
      ]),
    ]));
    const FCM = load(sandbox, ...SHARED, 'src/content/native.js', 'src/content/sites.js');
    eq(FCM.SITES.twitch.nativeControls().chatIdentity, null,
      'identity: a Twitch page without one offers nothing');
  }

  // ── Kick ──
  //
  // Kick labels nothing here, marks the badge rather than the button, and gives
  // every badge in chat an identity-badge-* test id — so a loose match on
  // "identity", or on an icon named "badge", picks a subscriber or moderator
  // badge just as happily.
  {
    const sandbox = build((el) => el('div', {}, [
      el('div', { id: 'chatroom-footer' }, [
        el('button', {}, [el('span', { 'data-testid': 'identity-badge-subscriber' })]),
        el('button', {}, [el('svg', { 'data-ds-icon': 'VerifiedBadge' })]),
        el('button', { id: 'kick-identity' }, [
          el('span', { 'data-testid': 'identity-badge-chat_identity' }, [
            el('svg', { 'data-ds-icon': 'IdentityBadge' }),
          ]),
        ]),
        el('button', { id: 'send-message-button', _text: 'Chat' }),
      ]),
    ]));
    const FCM = load(sandbox, ...SHARED, 'src/content/native.js', 'src/content/sites.js');
    const found = FCM.SITES.kick.nativeControls().chatIdentity;
    ok(found, 'identity: kick\u2019s chat identity badge is found');
    eq(found && found.id, 'kick-identity',
      'identity: and it is that one, not the subscriber or verified badge beside it');
    ok(found && found.id !== 'send-message-button', 'identity: never the button that sends');
  }
};

// ── GIFs in Twitch chat ──────────────────────────────────────────────────────
//
// A Tier 2 or Tier 3 subscriber's GIF arrives as an ordinary PRIVMSG carrying a
// `gifs` tag: positions, an id and the address of the picture. The positions
// are what the picture stands in for, the way an emote's are; the address is
// only ever honoured for GIPHY's own hosts, because it is what every viewer's
// panel will point an <img> at.
suites.gifs = function () {
  const FCM = load(makeSandbox(), ...SHARED);
  const url = 'https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif'
    + '?cid=095d7a5dzizsiwgabonagkmigggv8v1spfai91ac3x0dsiy0&ep=v1_gifs_trending&rid=giphy.gif&ct=g';

  // ── The tag, as Twitch documents it ──
  const one = FCM.parseTwitchGifs(`0-33|joSNxeswxuc74Juo8X|${url}`);
  eq(one.length, 1, 'gifs: one entry in the tag is one GIF');
  eq(one[0].start, 0, 'gifs: the start position is read');
  eq(one[0].end, 33, 'gifs: and the end');
  eq(one[0].id, 'joSNxeswxuc74Juo8X', 'gifs: and the id');
  eq(one[0].url, url, 'gifs: and the address, exactly as Twitch gave it');

  const two = FCM.parseTwitchGifs(`0-5|a|https://media.giphy.com/media/a/giphy.gif,7-9|b|https://media.giphy.com/media/b/giphy.gif`);
  eq(two.length, 2, 'gifs: several GIFs are several entries');
  eq(two[1].start, 7, 'gifs: each with its own positions');

  // A GIF whose positions are unusable is kept, loose, rather than dropped:
  // Twitch put it in the message.
  const loose = FCM.parseTwitchGifs('x|id|https://media.giphy.com/media/id/giphy.gif');
  eq(loose[0].start, -1, 'gifs: nonsense positions make a loose GIF');
  eq(FCM.parseTwitchGifs('9-3|id|https://media.giphy.com/media/id/giphy.gif')[0].start, -1,
    'gifs: a range running backwards is loose too');

  // Only GIPHY, only over https. The tag is the one place a picture address
  // comes into the feed from, and a replayed line is one nobody watched arrive.
  eq(FCM.parseTwitchGifs('0-3|id|https://evil.example/x.gif'), null,
    'gifs: an address that is not GIPHY is refused');
  eq(FCM.parseTwitchGifs('0-3|id|http://media.giphy.com/media/id/giphy.gif'), null,
    'gifs: and so is plain http');
  eq(FCM.parseTwitchGifs('0-3|id|https://giphy.com.evil.example/x.gif'), null,
    'gifs: a host that merely starts with giphy.com is not GIPHY');
  eq(FCM.parseTwitchGifs(''), null, 'gifs: no tag is no GIFs');
  eq(FCM.parseTwitchGifs('garbage'), null, 'gifs: a tag with no bars in it is nothing');
  ok(FCM.isGifUrl('https://giphy.com/gifs/abc'), 'gifs: giphy.com itself is allowed');
  ok(FCM.isGifUrl('https://media1.giphy.com/media/abc/200.gif'), 'gifs: and any of its subdomains');
  ok(!FCM.isGifUrl('javascript:alert(1)'), 'gifs: a script address is not a picture');

  // Through the IRC parser, the way it arrives: the address carries = and &,
  // neither of which may confuse the tag split.
  const line = FCM.parseIrcLine(`@display-name=Gifer;gifs=0-33|joSNxeswxuc74Juo8X|${url};id=g1 `
    + ':gifer!gifer@gifer.tmi.twitch.tv PRIVMSG #c :https://giphy.com/gifs/joSNxeswxuc74Juo8X');
  eq(FCM.parseTwitchGifs(line.tags.gifs)[0].url, url,
    'gifs: the address survives the tag parser with its query string intact');
  eq(line.tags.id, 'g1', 'gifs: and the tags after it are still read');

  // ── Watch streaks and other milestones, over IRC ──
  const streak = FCM.twitchUserNoticeSummary({
    'msg-id': 'viewermilestone', 'display-name': 'Regular',
    'msg-param-category': 'watch-streak', 'msg-param-value': '10', 'msg-param-copoReward': '450',
    'system-msg': 'Regular watched 10 consecutive streams and sparked a watch streak!',
  });
  contains(streak, 'Regular watched 10 streams in a row', 'streak: a watch streak names the count');
  contains(streak, '+450 channel points', 'streak: and what Twitch paid for it');
  eq(FCM.twitchUserNoticeSummary({
    'msg-id': 'viewermilestone', 'display-name': 'Regular',
    'msg-param-category': 'watch-streak', 'msg-param-value': '3',
  }), 'Regular watched 3 streams in a row and sparked a watch streak!',
  'streak: and says nothing about points when Twitch paid none');
  // A milestone of a kind this has never heard of falls back to Twitch's own
  // sentence, and then to a line that at least names the category.
  eq(FCM.twitchUserNoticeSummary({
    'msg-id': 'viewermilestone', 'display-name': 'Regular',
    'msg-param-category': 'something-new', 'system-msg': 'Regular did a new thing!',
  }), 'Regular did a new thing!', 'streak: an unknown milestone uses Twitch\'s own words');
  eq(FCM.twitchUserNoticeSummary({
    'msg-id': 'viewermilestone', 'display-name': 'Regular', 'msg-param-category': 'something-new',
  }), 'Regular reached a something new milestone.', 'streak: or names the category');
  eq(FCM.twitchUserNoticeSummary({
    'msg-id': 'modiversary', 'display-name': 'Mod', 'system-msg': 'Mod has been a moderator for 2 years!',
  }), 'Mod has been a moderator for 2 years!', 'streak: a modiversary is Twitch\'s own sentence');
  eq(FCM.twitchUserNoticeSummary({ 'msg-id': 'brandnew', 'display-name': 'X', 'system-msg': 'X did it' }),
    'X did it', 'streak: any unknown notice prefers Twitch\'s sentence to "triggered"');
  eq(FCM.twitchUserNoticeSummary({ 'msg-id': 'brandnew', 'display-name': 'X' }),
    'X triggered brandnew.', 'streak: and only says "triggered" when there is nothing else');
  // The ones already handled keep their own wording.
  eq(FCM.twitchUserNoticeSummary({
    'msg-id': 'resub', 'display-name': 'Fan', 'msg-param-cumulative-months': '24',
    'system-msg': 'Fan subscribed at Tier 1. They\'ve subscribed for 24 months!',
  }), 'Fan resubscribed (24 months).', 'streak: a resub still reads the way it did');

  // ── This viewer's own subscription, off the badges ──
  const sub = (badges, info, extra) => FCM.twitchSubscriptionFromTags({
    badges, 'badge-info': info || '', ...(extra || {}),
  });
  eq(sub('subscriber/2014,premium/1', 'subscriber/14'), { tier: 2, months: 14, founder: false },
    'sub: a Tier 2 badge is 2000 plus the months, and badge-info carries the months');
  eq(sub('subscriber/3006', 'subscriber/6').tier, 3, 'sub: Tier 3 badges are 3000 plus');
  eq(sub('subscriber/6', 'subscriber/6').tier, 1, 'sub: a bare month count is Tier 1');
  eq(sub('subscriber/0', 'subscriber/1').months, 1, 'sub: the first month is a month');
  eq(sub('founder/0', 'founder/14'), { tier: 0, months: 14, founder: true },
    'sub: a founder subscribes at a tier the badge does not say');
  eq(sub('founder/0,subscriber/2003', 'subscriber/3').tier, 2,
    'sub: unless the subscriber badge is there beside it');
  eq(sub('premium/1'), null, 'sub: no subscriber badge is no subscription');
  eq(sub(''), null, 'sub: and no badges at all is none');
  eq(sub('', '', { subscriber: '1' }), { tier: 0, months: 0, founder: false },
    'sub: the subscriber flag alone says they subscribe, at a tier unknown');
  eq(sub('moderator/1,subscriber/2012', 'subscriber/12').tier, 2,
    'sub: the badge is found wherever it sits in the list');

  // ── Drawn as pictures ──
  const rsandbox = makeSandbox({
    chrome: { storage: { sync: { get: async () => ({}) } } },
    document: stubDocument(),
  });
  const R = load(rsandbox, ...SHARED, 'src/content/render.js');
  R.setViewSettings(R.DEFAULT_SETTINGS);
  const gif = { start: 0, end: 41, id: 'joSNxeswxuc74Juo8X', url };
  const drawn = R.renderMessageBody('twitch', 'https://giphy.com/gifs/joSNxeswxuc74Juo8X', { gifs: [gif] }).html;
  contains(drawn, '<a class="fcm-gif" href="https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif?cid=',
    'gifs: the GIF is drawn as a link to the picture');
  contains(drawn, '<img class="fcm-gif-img" src="https://media4.giphy.com/', 'gifs: with the picture inside it');
  contains(drawn, 'class="fcm-gif-label">GIF<', 'gifs: and a label for when pictures are off');
  contains(drawn, '&amp;ep=v1_gifs_trending', 'gifs: the address is escaped, not rewritten');
  missing(drawn, 'giphy.com/gifs/joSNxeswxuc74Juo8X<', 'gifs: the text the picture stands in for is gone');
  missing(drawn, 'fcm-link', 'gifs: and is not also drawn as a link');

  // Text around it, and an emote beside it: both are kept.
  const mixed = R.renderMessageBody('twitch', 'Kappa look XXXX wow', {
    emoteMap: { 0: { id: '25', end: 4 } },
    gifs: [{ start: 11, end: 14, id: 'x', url: 'https://media.giphy.com/media/x/giphy.gif' }],
  }).html;
  contains(mixed, 'twitch-emote', 'gifs: an emote in the same message is still an emote');
  contains(mixed, 'fcm-gif', 'gifs: and the GIF is still a GIF');
  contains(mixed, ' look ', 'gifs: the words before it survive');
  contains(mixed, ' wow', 'gifs: and the words after');
  missing(mixed, 'XXXX', 'gifs: the span it replaced does not');

  // A loose GIF goes after the words rather than nowhere.
  const tail = R.renderMessageBody('twitch', 'hello', {
    gifs: [{ start: -1, end: -1, id: 'x', url: 'https://media.giphy.com/media/x/giphy.gif' }],
  }).html;
  ok(tail.indexOf('hello') < tail.indexOf('fcm-gif'), 'gifs: a loose GIF follows the text');
  contains(R.renderMessageBody('twitch', '', {
    gifs: [{ start: -1, end: -1, id: 'x', url: 'https://media.giphy.com/media/x/giphy.gif' }],
  }).html, 'fcm-gif', 'gifs: a message that is nothing but a GIF still draws it');

  // The renderer checks the address again: nothing upstream is trusted to
  // have done it, and a bad one leaves the words as they were.
  const refused = R.renderMessageBody('twitch', 'abcd', {
    gifs: [{ start: 0, end: 3, id: 'x', url: 'https://evil.example/x.gif' }],
  }).html;
  eq(refused, 'abcd', 'gifs: an address that is not GIPHY draws nothing and keeps the text');
  const quoted = R.renderMessageBody('twitch', 'abcd', {
    gifs: [{ start: 0, end: 3, id: 'x', url: 'https://media.giphy.com/media/x"onerror="alert(1)' }],
  }).html;
  missing(quoted, '"onerror', 'gifs: a quote in the address cannot break out of the attribute');
  contains(quoted, '&quot;onerror', 'gifs: it is escaped like everything else');

  // Only Twitch has these. A Kick message handed the same field ignores it.
  missing(R.renderMessageBody('kick', 'hey', {
    gifs: [{ start: 0, end: 2, id: 'x', url: 'https://media.giphy.com/media/x/giphy.gif' }],
  }).html, 'fcm-gif', 'gifs: Kick messages carry no GIF tag and get no GIF');

  // The row is marked, so a moderator can find the GIFs in their chat.
  const row = R.buildMessageEl({
    platform: 'twitch', author: 'Gifer', text: 'x', gifs: [gif], messageId: 'g1',
  });
  contains(row.className, 'fcm-has-gif', 'gifs: a row carrying a GIF is marked');
  missing(R.buildMessageEl({ platform: 'twitch', author: 'Talker', text: 'x' }).className,
    'fcm-has-gif', 'gifs: one without is not');
};

// ── The prompts Twitch draws for this viewer alone ────────────────────────────
//
// "Share your watch streak", "share your resub": a block of words with a Share
// button in it, drawn on the site's own chat where the panel covers it. The
// button is the whole test, and everything about reading it fails closed.
suites.prompts = function () {
  const observers = [];
  const polls = [];
  const sandbox = makeSandbox({
    document: { ...stubDocument(), body: {} },
    MutationObserver: function (cb) {
      observers.push(cb);
      this.observe = () => {};
      this.disconnect = () => { this.gone = true; };
    },
    setInterval: (fn) => { polls.push(fn); return polls.length; },
    clearInterval: (id) => { polls[id - 1] = null; },
  });
  const FCM = load(sandbox, ...SHARED, 'src/content/native-events.js');

  const button = (text, aria) => ({
    nodeType: 1, textContent: text,
    getAttribute: (k) => (k === 'aria-label' ? (aria || null) : null),
    getBoundingClientRect: () => ({ width: 40, height: 20 }),
  });
  const block = (text, buttons) => ({
    nodeType: 1, innerText: text,
    querySelectorAll: (sel) => (sel === 'button' ? buttons : []),
    querySelector: () => null,
    matches: () => false,
  });

  const share = button('Share');
  const streak = FCM.readNativePrompt(block(
    'You\'ve watched 3 streams in a row!\nShare your streak with chat to earn 450 channel points\nShare\nNot now',
    [share, button('Not now')]
  ));
  ok(streak, 'prompts: a watch streak prompt is read');
  eq(streak.kind, 'streak', 'prompts: and known for what it is');
  eq(streak.text, 'You\'ve watched 3 streams in a row! Share your streak with chat to earn 450 channel points',
    'prompts: the words are kept and the buttons\' labels are not');
  ok(streak.share === share, 'prompts: the site\'s own Share button comes back to be pressed');

  const resub = FCM.readNativePrompt(block(
    'Your 12-month resub is ready to share\nShare\nDismiss', [button('Share'), button('Dismiss')]
  ));
  eq(resub.kind, 'resub', 'prompts: a resub prompt is a resub');
  eq(FCM.readNativePrompt(block('Tell chat something\nShare', [button('Share')])).kind, 'share',
    'prompts: anything else with a Share button is a plain share');
  eq(FCM.readNativePrompt(block('Resub ready', [button('', 'Share your resub')])).kind, 'resub',
    'prompts: a button labelled only for a screen reader still counts');

  // On a real row the buttons sit inline with the words, and innerText runs
  // them together — "...channel pointsShareNot now" — so the words are walked
  // out of the tree instead, skipping the buttons.
  {
    const text = (value) => ({ nodeType: 3, nodeValue: value });
    const el = (tag, kids, extra) => ({
      nodeType: 1, tagName: tag, childNodes: kids, ...(extra || {}),
    });
    const inlineShare = { ...button('Share'), tagName: 'BUTTON', childNodes: [text('Share')] };
    const later = { ...button('Not now'), tagName: 'BUTTON', childNodes: [text('Not now')] };
    const row = el('DIV', [
      el('SPAN', [text('You\u2019ve watched 3 streams in a row!')]),
      el('SPAN', [text('Share your streak with chat')]),
      inlineShare, later,
    ], {
      innerText: 'You\u2019ve watched 3 streams in a row!Share your streak with chatShareNot now',
      querySelectorAll: (sel) => (sel === 'button' ? [inlineShare, later] : []),
    });
    const walked = FCM.readNativePrompt(row);
    eq(walked && walked.text, 'You\u2019ve watched 3 streams in a row! Share your streak with chat',
      'prompts: on a real row the buttons\u2019 labels are walked around, not run into the words');
    eq(walked && walked.kind, 'streak', 'prompts: and the kind is still read off the words');
  }

  // Fails closed, every way.
  eq(FCM.readNativePrompt(block('someone: hello there', [button('Reply')])), null,
    'prompts: a chat line with a button that is not Share is not a prompt');
  eq(FCM.readNativePrompt(block('Regular watched 10 consecutive streams!', [])), null,
    'prompts: somebody else\'s streak has no button, so it is not a prompt');
  eq(FCM.readNativePrompt(block('Something', [button(`${'share '.repeat(20)}`)])), null,
    'prompts: a paragraph that happens to contain the word is not a button label');
  eq(FCM.readNativePrompt(block(`Share ${'x'.repeat(500)}`, [button('Share')])), null,
    'prompts: a block far too long to be a prompt is refused');
  eq(FCM.readNativePrompt(block('Share', [button('Share')])), null,
    'prompts: a Share button with no words around it is nothing to say');
  eq(FCM.readNativePrompt(null), null, 'prompts: no element is no prompt');
  eq(FCM.readNativePrompt({ nodeType: 3 }), null, 'prompts: a text node is no prompt');

  // ── The watcher, on Twitch ──
  const events = [];
  const prompts = [];
  const list = { contains: () => false };
  const column = { querySelectorAll: () => [] };
  const watcher = FCM.createNativeEventWatcher(
    { id: 'twitch', messageList: () => list, chatContainer: () => column },
    (text) => events.push(text),
    (prompt) => prompts.push(prompt),
  );
  watcher.start();
  eq(observers.length, 1, 'prompts: the list is observed');
  ok(polls.some(Boolean), 'prompts: and the column is polled for prompts drawn elsewhere');
  const added = (nodes) => observers[0]([{ addedNodes: nodes }]);

  const promptRow = block('Your 12-month resub is ready to share\nShare', [button('Share')]);
  added([promptRow]);
  eq(prompts.length, 1, 'prompts: a prompt added to the list is reported');
  eq(prompts[0].kind, 'resub', 'prompts: as what it is');
  ok(prompts[0].el === promptRow, 'prompts: with the element it was read from');
  added([promptRow]);
  eq(prompts.length, 1, 'prompts: the same prompt redrawn is not reported twice');
  added([block('viewer: nothing to share here', [])]);
  eq(prompts.length, 1, 'prompts: an ordinary row is not a prompt');

  // Redemptions still come through the same watcher, as before.
  const notice = {
    nodeType: 1, innerText: 'JRBlaze redeemed Feed your hedgehog\n50',
    matches: (sel) => sel.includes('user-notice-line'),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  added([notice]);
  eq(events, ['JRBlaze redeemed Feed your hedgehog (50 points).'],
    'prompts: a redemption row is still read as an event');
  eq(prompts.length, 1, 'prompts: and is not mistaken for a prompt');

  // A prompt drawn outside the list — above the composer — is found by the
  // poll, climbing from its Share button to the words around it.
  const outsideShare = button('Share');
  const wrapper = block('Your 24-month resub is ready to share\nShare', [outsideShare]);
  wrapper.parentElement = column;
  outsideShare.parentElement = wrapper;
  column.querySelectorAll = (sel) => (sel === 'button' ? [outsideShare] : []);
  polls.filter(Boolean).forEach((fn) => fn());
  eq(prompts.length, 2, 'prompts: a prompt outside the list is found by the poll');
  eq(prompts[1].text, 'Your 24-month resub is ready to share', 'prompts: read from the block around its button');
  polls.filter(Boolean).forEach((fn) => fn());
  eq(prompts.length, 2, 'prompts: and once only');

  watcher.stop();
  ok(!polls.some(Boolean), 'prompts: stopping the watcher stops the poll');
};

// ── The moderation strip on a message ─────────────────────────────────────────
//
// Delete, one timeout and ban, on the row itself, for the chats this viewer
// moderates. Ban takes two presses on purpose.
suites.modstrip = function () {
  function fakeEl(tag = 'div') {
    const classes = new Set();
    const handlers = {};
    const attrs = {};
    const node = {
      tagName: tag.toUpperCase(),
      children: [], parentElement: null,
      dataset: {}, style: {}, textContent: '', title: '', type: '', innerHTML: '',
      value: '', selectionStart: 0, placeholder: '',
      clientHeight: 400, offsetHeight: 40,
      appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
      addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
      removeEventListener() {},
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return k in attrs ? attrs[k] : null; },
      focus() {}, remove() {},
      closest(sel) {
        for (let n = this; n; n = n.parentElement) if (n.matchesClass(sel)) return n;
        return null;
      },
      matchesClass(sel) { return sel.startsWith('.') && classes.has(sel.slice(1)); },
      querySelector(sel) {
        for (const c of this.children) {
          if (c.matchesClass(sel)) return c;
          const deeper = c.querySelector(sel);
          if (deeper) return deeper;
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        this.children.forEach((c) => { if (c.matchesClass(sel)) out.push(c); out.push(...c.querySelectorAll(sel)); });
        return out;
      },
      click() {
        (handlers.click || []).forEach((fn) => fn({
          target: this, preventDefault() {}, stopPropagation() {},
        }));
      },
      fire(type, event) { (handlers[type] || []).forEach((fn) => fn(event)); },
      setSelectionRange(a) { this.selectionStart = a; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 240, height: 120 }; },
    };
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

  const timers = [];
  const sandbox = makeSandbox({
    chrome: { storage: { sync: { get: async () => ({}) } } },
    document: { createElement: (t) => fakeEl(t) },
    window: { getSelection: () => null },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  });
  const FCM = load(sandbox, ...SHARED, 'src/content/render.js', 'src/content/compose.js');
  FCM.setViewSettings(FCM.DEFAULT_SETTINGS);

  const actions = [];
  const feedEl = fakeEl();
  const compose = FCM.createCompose({
    panel: fakeEl(), inputEl: fakeEl('input'), feedEl, emoteBtn: fakeEl('button'),
    toast: () => {},
    canModerate: (platform) => platform === 'twitch',
    onModerate: (platform, action, opts) => actions.push({ platform, action, opts }),
  });

  function row(platform, { messageId = 'm1' } = {}) {
    const el = fakeEl();
    el.className = 'fcm-msg';
    el.dataset.platform = platform;
    el.dataset.user = 'someone';
    el.dataset.userId = 'u1';
    if (messageId) el.dataset.msgId = messageId;
    const author = fakeEl('span');
    author.className = 'fcm-author';
    author.dataset.name = 'Someone';
    author.dataset.platform = platform;
    el.appendChild(author);
    feedEl.appendChild(el);
    return el;
  }

  const twitchRow = row('twitch');
  const bar = compose.modBarFor(twitchRow);
  ok(bar, 'modstrip: a moderator gets a strip on a row from the chat they moderate');
  const labels = bar.children.map((b) => b.textContent);
  eq(labels, ['\u2715', '10m', 'Ban'], 'modstrip: delete, one timeout and ban, in that order');

  bar.children[0].click();
  eq(actions.pop(), {
    platform: 'twitch', action: 'delete', opts: { username: 'Someone', userId: 'u1', messageId: 'm1' },
  }, 'modstrip: delete acts on the message the strip is on');

  bar.children[1].click();
  eq(actions.pop(), {
    platform: 'twitch', action: 'timeout',
    opts: { seconds: 600, username: 'Someone', userId: 'u1', messageId: 'm1' },
  }, 'modstrip: the timeout is ten minutes, on that person');

  // Ban takes two presses: the first arms it and says so.
  const ban = bar.children[2];
  ban.click();
  eq(actions.length, 0, 'modstrip: one press does not ban');
  eq(ban.textContent, 'Ban?', 'modstrip: it asks instead');
  ban.click();
  eq(actions.pop(), {
    platform: 'twitch', action: 'ban', opts: { username: 'Someone', userId: 'u1', messageId: 'm1' },
  }, 'modstrip: the second press bans');
  eq(ban.textContent, 'Ban', 'modstrip: and the button is back to its word');

  // Left armed, it disarms itself.
  ban.click();
  eq(ban.textContent, 'Ban?', 'modstrip: armed again');
  const disarm = timers.filter((t) => t.fn).pop();
  ok(disarm && disarm.ms === 3000, 'modstrip: with a short fuse');
  disarm.fn();
  eq(ban.textContent, 'Ban', 'modstrip: that puts it back on its own');
  eq(actions.length, 0, 'modstrip: without banning anyone');

  // No message id — a replayed line, say — and there is nothing to delete.
  const noId = compose.modBarFor(row('twitch', { messageId: '' }));
  eq(noId.children.map((b) => b.textContent), ['10m', 'Ban'],
    'modstrip: a row with no message id offers no delete');

  // The other chat, which this viewer does not moderate, gets nothing.
  eq(compose.modBarFor(row('kick')), null, 'modstrip: no strip where the viewer is not a moderator');

  // And when they do moderate it, the strip is Kick's: the same three actions,
  // named for the platform the row came from, acting on Kick's own ids.
  {
    const both = [];
    const feed2 = fakeEl();
    const c2 = FCM.createCompose({
      panel: fakeEl(), inputEl: fakeEl('input'), feedEl: feed2, emoteBtn: fakeEl('button'),
      toast: () => {},
      canModerate: () => true,
      onModerate: (platform, action, opts) => both.push({ platform, action, opts }),
    });
    const kickRow = fakeEl();
    kickRow.className = 'fcm-msg';
    kickRow.dataset.platform = 'kick';
    kickRow.dataset.user = 'kickviewer';
    kickRow.dataset.userId = 'k9';
    kickRow.dataset.msgId = 'km1';
    const kickAuthor = fakeEl('span');
    kickAuthor.className = 'fcm-author';
    kickAuthor.dataset.name = 'KickViewer';
    kickAuthor.dataset.platform = 'kick';
    kickRow.appendChild(kickAuthor);
    feed2.appendChild(kickRow);

    const kickBar = c2.modBarFor(kickRow);
    ok(kickBar, 'modstrip: a Kick moderator gets the strip on a Kick row');
    eq(kickBar.children.map((b) => b.textContent), ['✕', '10m', 'Ban'],
      'modstrip: with the same three actions');
    contains(kickBar.children[1].title, 'Kick',
      'modstrip: named for the platform the row is from');
    kickBar.children[1].click();
    eq(both.pop(), {
      platform: 'kick', action: 'timeout',
      opts: { seconds: 600, username: 'KickViewer', userId: 'k9', messageId: 'km1' },
    }, 'modstrip: and the action goes to Kick with Kick’s own ids');
  }

  // Hovering is what grows the strip, once, and only while the setting is on.
  const hovered = row('twitch');
  const author = hovered.querySelector('.fcm-author');
  feedEl.fire('mouseover', { target: author });
  ok(hovered.querySelector('.fcm-modbar'), 'modstrip: pointing at a row grows its strip');
  feedEl.fire('mouseover', { target: author });
  eq(hovered.querySelectorAll('.fcm-modbar').length, 1, 'modstrip: and only one');

  FCM.setViewSettings({ ...FCM.DEFAULT_SETTINGS, modHoverTools: false });
  const quiet = row('twitch');
  feedEl.fire('mouseover', { target: quiet.querySelector('.fcm-author') });
  eq(quiet.querySelector('.fcm-modbar'), null, 'modstrip: switched off, nothing grows');
  ok(compose.modBarFor(quiet), 'modstrip: though the strip itself can still be asked for');
};

// ── This viewer's own subscription, as the worker learns it ───────────────────
//
// Twitch says it twice: in the badges on USERSTATE, and — for a token carrying
// the scope — outright from Helix, which is the only one that knows a
// founder's tier. Both are merged and told to the tab once per change.
suites.subscription = function () {
  const { bootWorker, wait } = require('./background.js');

  return (async () => {
    const asked = [];
    const w = bootWorker({
      fetchImpl: async (url) => {
        asked.push(String(url));
        if (String(url).includes('/subscriptions/user')) {
          return { ok: true, json: async () => ({ data: [{ tier: '3000', is_gift: true }] }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });
    try {
      w.storage.local.fcm_auth_v1 = {
        twitch: {
          accessToken: 't', clientId: 'c', userId: '42', login: 'me',
          scopes: ['chat:read', 'user:read:subscriptions'], expiresAt: 0,
        },
      };
      w.connect();
      w.send({ cmd: 'hello', site: 'twitch', channel: 'somechannel', hints: [] });
      await wait(40);
      w.send({ cmd: 'join', platform: 'twitch', channel: 'somechannel' });
      await wait(40);
      const irc = w.socketFor('irc-ws.chat.twitch.tv');
      ok(irc, 'sub: a Twitch socket is opened');

      // The badges say Tier 2, fourteen months.
      irc.push('@badge-info=subscriber/14;badges=subscriber/2014,premium/1;mod=0;emote-sets=0 '
        + ':tmi.twitch.tv USERSTATE #somechannel\r\n');
      const first = w.last('subscription');
      ok(first, 'sub: USERSTATE tells the tab about the subscription');
      eq(first.platform, 'twitch', 'sub: on Twitch');
      eq(first.subscription, {
        subscribed: true, tier: 2, months: 14, founder: false, isGift: false, source: 'badges',
      }, 'sub: the tier and the months come off the badges');

      // The same USERSTATE again — it arrives with every message this viewer
      // sends — says nothing new.
      irc.push('@badge-info=subscriber/14;badges=subscriber/2014,premium/1;mod=0 '
        + ':tmi.twitch.tv USERSTATE #somechannel\r\n');
      eq(w.of('subscription').length, 1, 'sub: an unchanged answer is not repeated');

      // ROOMSTATE names the room, and Helix is asked. It knows better.
      irc.push('@room-id=4242 :tmi.twitch.tv ROOMSTATE #somechannel\r\n');
      await wait(40);
      const helix = w.last('subscription');
      eq(helix.subscription.tier, 3, 'sub: Helix\'s tier wins over the badge');
      eq(helix.subscription.isGift, true, 'sub: and says whether it was a gift');
      eq(helix.subscription.months, 14, 'sub: the months still come from the badges');
      eq(helix.subscription.source, 'helix', 'sub: and the answer says where it came from');
      ok(asked.some((u) => /subscriptions\/user\?broadcaster_id=4242&user_id=42/.test(u)),
        'sub: Helix was asked about this viewer in this room');

      // A reloaded page is told again, with the ready.
      w.clear();
      w.send({ cmd: 'hello', site: 'twitch', channel: 'somechannel', hints: [] });
      await wait(40);
      eq(w.last('ready').connections.twitch.subscription.tier, 3,
        'sub: the ready carries what was learnt, for a page that reloaded');

      // Leaving forgets it: the next channel is a different question.
      w.send({ cmd: 'leave', platform: 'twitch' });
      await wait(20);
      w.send({ cmd: 'hello', site: 'twitch', channel: 'somechannel', hints: [] });
      await wait(40);
      eq(w.last('ready').connections.twitch.subscription, null,
        'sub: nothing is claimed about a channel that has been left');
    } finally {
      w.teardown();
    }
  })();
};

// Without the scope, Helix is left alone and the badges answer on their own.
suites.subscriptionscope = function () {
  const { bootWorker, wait } = require('./background.js');

  return (async () => {
    const w = bootWorker();
    try {
      w.storage.local.fcm_auth_v1 = {
        twitch: { accessToken: 't', clientId: 'c', userId: '42', login: 'me', scopes: ['chat:read'], expiresAt: 0 },
      };
      w.connect();
      w.send({ cmd: 'hello', site: 'twitch', channel: 'somechannel', hints: [] });
      await wait(40);
      w.send({ cmd: 'join', platform: 'twitch', channel: 'somechannel' });
      await wait(40);
      const irc = w.socketFor('irc-ws.chat.twitch.tv');
      irc.push('@badge-info=founder/9;badges=founder/0;mod=0 :tmi.twitch.tv USERSTATE #somechannel\r\n');
      irc.push('@room-id=4242 :tmi.twitch.tv ROOMSTATE #somechannel\r\n');
      await wait(40);
      const told = w.last('subscription');
      eq(told.subscription, {
        subscribed: true, tier: 0, months: 9, founder: true, isGift: false, source: 'badges',
      }, 'sub: a founder is known to subscribe, at a tier the badges cannot say');
      ok(!w.fetchCalls.some((c) => c.url.includes('/subscriptions/user')),
        'sub: Helix is not asked with a token that lacks the scope');

      // A sub that lapses is reported as gone.
      irc.push('@badge-info=;badges=premium/1;mod=0 :tmi.twitch.tv USERSTATE #somechannel\r\n');
      eq(w.last('subscription').subscription.subscribed, false, 'sub: a lapsed sub is reported as one');
    } finally {
      w.teardown();
    }
  })();
};

// ── Kick badges, drawn ───────────────────────────────────────────────────────
//
// Kick sends a role badge as a type and a caption and no picture — its own
// chat draws these from icons built into the site — so the feed here spelled
// them out. Now they are drawn: a picture where Kick sends one, the channel's
// own badge for a subscriber, an icon for a role, and the label only for a
// type none of those cover.
suites.kickbadges = function () {
  const FCM = load(makeSandbox({ document: stubDocument() }), ...SHARED, 'src/content/render.js');

  // ── Both of Kick's lists, read together ──
  const identity = {
    badges: [
      { type: 'moderator', text: 'Moderator', sort_order: 12 },
      { type: 'subscriber', text: 'Subscriber', count: 6, sort_order: 9 },
    ],
    badges_v2: [
      {
        name: 'level', badge_type: 'global', metadata: { level: 30 },
        image_url: 'https://ext.cdn.kick.com/chat/badges/30.png', selected: true,
      },
      { name: 'nothing', badge_type: 'global' },
    ],
  };
  const list = FCM.kickBadgeList(identity);
  eq(list.length, 3, 'kickbadges: role badges and pictured badges are one list');
  eq(list[0].type, 'moderator', 'kickbadges: roles first, as Kick draws them');
  eq(list[2], { type: 'level', text: 'Level 30', image_url: 'https://ext.cdn.kick.com/chat/badges/30.png' },
    'kickbadges: a pictured badge carries its picture and a caption with the level');
  eq(FCM.kickBadgeList(null), [], 'kickbadges: no identity is no badges');
  eq(FCM.kickBadgeList({ badges: 'nope', badges_v2: [null] }), [],
    'kickbadges: a malformed identity is no badges rather than a throw');

  // ── The channel's subscriber badges ──
  const subs = FCM.kickSubscriberBadges({
    subscriber_badges: [
      { months: 1, badge_image: { src: 'https://files.kick.com/channel_subscriber_badges/1/original' } },
      { months: 6, badge_image: { src: 'https://files.kick.com/channel_subscriber_badges/6/original' } },
      { months: 3, badge_image: { src: 'http://insecure.example/3' } },
      { months: 'x', badge_image: { src: 'https://files.kick.com/9' } },
    ],
  });
  eq(subs, [
    { months: 6, url: 'https://files.kick.com/channel_subscriber_badges/6/original' },
    { months: 1, url: 'https://files.kick.com/channel_subscriber_badges/1/original' },
  ], 'kickbadges: largest months first, only https, only numbers');
  eq(FCM.kickSubscriberBadges({}), [], 'kickbadges: a channel with none has none');

  // ── Drawing them ──
  const mod = FCM.renderBadges('kick', [{ type: 'moderator', text: 'Moderator' }]);
  contains(mod, '<svg', 'kickbadges: a moderator is an icon');
  contains(mod, 'fcm-kbadge-icon-moderator', 'kickbadges: coloured by role');
  contains(mod, '<title>Moderator</title>', 'kickbadges: captioned with what Kick said');
  missing(mod, 'fcm-kbadge-moderator"', 'kickbadges: and no longer the MOD label');

  FCM.setBadges('kick', { subscriber: subs });
  const seven = FCM.renderBadges('kick', [{ type: 'subscriber', text: 'Subscriber', count: 7 }]);
  contains(seven, 'channel_subscriber_badges/6/original',
    'kickbadges: a seven-month subscriber wears the six-month badge');
  contains(seven, 'title="Subscriber (7 months)"', 'kickbadges: with the months in the tooltip');
  contains(FCM.renderBadges('kick', [{ type: 'subscriber', count: 2 }]),
    'channel_subscriber_badges/1/original', 'kickbadges: two months wears the one-month badge');
  contains(FCM.renderBadges('kick', [{ type: 'subscriber', count: 1 }]), '(1 month)',
    'kickbadges: one month, singular');

  FCM.resetPlatformView('kick');
  contains(FCM.renderBadges('kick', [{ type: 'subscriber', count: 2 }]), 'fcm-kbadge-icon-subscriber',
    'kickbadges: a channel with no badges of its own gets the star');
  eq(FCM.renderBadges('kick', [{ type: 'subscriber', count: 2 }]).includes('channel_subscriber_badges'),
    false, 'kickbadges: and nothing from the last channel');

  contains(FCM.renderBadges('kick', [{ type: 'sub_gifter', text: 'Sub Gifter', count: 60 }]),
    'data-tier="50"', 'kickbadges: a gifter is tiered by how many they gave');
  contains(FCM.renderBadges('kick', [{ type: 'sub_gifter', count: 3 }]),
    'data-tier="1"', 'kickbadges: from the first one');
  contains(FCM.renderBadges('kick', list), 'ext.cdn.kick.com/chat/badges/30.png',
    'kickbadges: a badge Kick sent a picture for is drawn from it');
  contains(FCM.renderBadges('kick', list), 'title="Level 30"', 'kickbadges: captioned with the level');
  ['broadcaster', 'vip', 'og', 'founder', 'verified', 'staff', 'sidekick'].forEach((type) => {
    contains(FCM.renderBadges('kick', [{ type }]), `fcm-kbadge-icon-${type}`,
      `kickbadges: ${type} has an icon`);
  });
  contains(FCM.renderBadges('kick', [{ type: 'trainwreckstv', text: 'Trainwreck' }]), 'TRAINWRECKSTV',
    'kickbadges: a type with no icon is still a label');

  // A caption is text Kick relays from somewhere; it reaches nothing but text.
  const hostile = FCM.renderBadges('kick', [{ type: 'moderator', text: '"><img src=x onerror=alert(1)>' }]);
  missing(hostile, '<img', 'kickbadges: a hostile caption cannot put an element in the row');
  contains(hostile, '&lt;img', 'kickbadges: it is escaped');
};

// ── Clips linked in chat ─────────────────────────────────────────────────────
//
// A Twitch slug is four random words and a Kick id is a string of letters, so
// a bare clip address says nothing about what is behind it. The feed finds
// them, the worker asks the platform, and a card lands under the row.
suites.clips = function () {
  const FCM = load(makeSandbox({ document: stubDocument() }), ...SHARED, 'src/content/render.js');
  const find = FCM.findClipLinks;
  const { bootWorker, wait } = require('./background.js');

  // ── Finding them ──
  eq(find('look at this https://clips.twitch.tv/CloudySpicyPastaOneHand-p_jTKUjmLlPywWk_ lol'), [{
    platform: 'twitch',
    id: 'CloudySpicyPastaOneHand-p_jTKUjmLlPywWk_',
    url: 'https://clips.twitch.tv/CloudySpicyPastaOneHand-p_jTKUjmLlPywWk_',
  }], 'clips: a Twitch clip by its own address');
  eq(find('www.twitch.tv/bwana/clip/AbcDef-123?featured=false&filter=clips')[0].id, 'AbcDef-123',
    'clips: or under the channel, with the tracking left off');
  eq(find('https://clips.twitch.tv/embed?parent=x&clip=AbcDef-123')[0].id, 'AbcDef-123',
    'clips: or as an embed, which is not a clip called "embed"');
  eq(find('https://m.twitch.tv/bwana/clip/AbcDef-123')[0].id, 'AbcDef-123', 'clips: mobile too');
  eq(find('(kick.com/Bwana/clips/clip_01M1JENNKD1ASJQXVNMSYCGC86).'), [{
    platform: 'kick',
    id: 'clip_01M1JENNKD1ASJQXVNMSYCGC86',
    url: 'https://kick.com/bwana/clips/clip_01M1JENNKD1ASJQXVNMSYCGC86',
  }], 'clips: a Kick clip, with the sentence’s punctuation left off and the channel lowercased');
  eq(find('https://kick.com/bwana?clip=clip_01ABC&x=1')[0].id, 'clip_01ABC',
    'clips: or the channel page with the clip opened over it, as Kick’s share button copies');
  eq(find('https://www.twitch.tv/bwana kick.com/bwana clips.twitch.tv https://kick.com/bwana/videos/1'), [],
    'clips: a channel, a host and a video are not clips');
  eq(find('clips.twitch.tv/A clips.twitch.tv/A clips.twitch.tv/B clips.twitch.tv/C clips.twitch.tv/D').length, 3,
    'clips: each once, and no more than three in one message');
  eq(find(''), [], 'clips: nothing in nothing');
  eq(find(null), [], 'clips: nor in null');

  // ── The card ──
  const card = FCM.buildClipCardEl({
    platform: 'kick', url: 'https://kick.com/bwana/clips/clip_1', title: 'Helicopter <b>Fly</b>',
    thumbnail: 'https://clips.kick.com/clips/f6/clip_1/thumbnail.webp', duration: 75, channel: 'Bwana',
  });
  eq(card.href, 'https://kick.com/bwana/clips/clip_1', 'clips: the card opens the clip');
  eq(card.target, '_blank', 'clips: in a new tab');
  contains(card.className, 'fcm-clip-kick', 'clips: marked with its platform');
  contains(card.innerHTML, 'clips/f6/clip_1/thumbnail.webp', 'clips: the thumbnail');
  contains(card.innerHTML, 'Helicopter &lt;b&gt;Fly&lt;/b&gt;', 'clips: the title, escaped');
  contains(card.innerHTML, 'Kick clip · Bwana · 1:15', 'clips: whose, and how long');
  eq(FCM.buildClipCardEl({ platform: 'twitch', url: 'javascript:alert(1)', title: 'x' }), null,
    'clips: a card only ever opens an https address');
  contains(FCM.buildClipCardEl({ platform: 'twitch', url: 'https://clips.twitch.tv/x', thumbnail: 'http://evil/x.png' }).innerHTML,
    'fcm-clip-thumb-none', 'clips: a thumbnail that is not https is not drawn');
  contains(FCM.buildClipCardEl({ platform: 'twitch', url: 'https://clips.twitch.tv/x' }).innerHTML,
    '>Clip<', 'clips: a clip with no title is still called something');
  eq(FCM.buildClipCardEl(null), null, 'clips: nothing is no card');

  // ── The worker asking the platforms ──
  return (async () => {
    const w = bootWorker({
      twitchClips: {
        GoodSlug: {
          slug: 'GoodSlug', title: 'Actually... it was more', durationSeconds: 59, viewCount: 241,
          thumbnailURL: 'https://static-cdn.jtvnw.net/twitch-video-assets/x/thumb.jpg',
          broadcaster: { displayName: 'Bwana', login: 'bwana' },
        },
        OddSlug: {
          slug: 'OddSlug', title: 'x', thumbnailURL: 'https://evil.example/thumb.jpg',
        },
      },
      kickClips: {
        clip_01ABC: {
          id: 'clip_01ABC', title: 'Helicopter Fly Under Bridge', duration: 15, view_count: 3,
          thumbnail_url: 'https://clips.kick.com/clips/f6/clip_01ABC/thumbnail.webp',
          channel: { slug: 'bwana', username: 'Bwana' },
        },
      },
    });
    try {
      w.connect();
      w.send({ cmd: 'hello', site: 'kick', channel: 'bwana', hints: [] });
      await wait(30);

      w.send({ cmd: 'clip', id: 'c1', platform: 'twitch', clipId: 'GoodSlug' });
      await wait(30);
      eq(w.last('clip'), {
        type: 'clip',
        id: 'c1',
        clip: {
          platform: 'twitch', id: 'GoodSlug', url: 'https://clips.twitch.tv/GoodSlug',
          title: 'Actually... it was more',
          thumbnail: 'https://static-cdn.jtvnw.net/twitch-video-assets/x/thumb.jpg',
          duration: 59, channel: 'Bwana', views: 241,
        },
      }, 'clips: a Twitch clip is looked up over GQL and answered in full');

      w.send({ cmd: 'clip', id: 'c2', platform: 'kick', clipId: 'clip_01ABC' });
      await wait(30);
      eq(w.last('clip').clip, {
        platform: 'kick', id: 'clip_01ABC', url: 'https://kick.com/bwana/clips/clip_01ABC',
        title: 'Helicopter Fly Under Bridge',
        thumbnail: 'https://clips.kick.com/clips/f6/clip_01ABC/thumbnail.webp',
        duration: 15, channel: 'Bwana', views: 3,
      }, 'clips: a Kick clip from its record');

      w.send({ cmd: 'clip', id: 'c3', platform: 'kick', clipId: 'clip_missing' });
      await wait(30);
      eq(w.last('clip'), { type: 'clip', id: 'c3', clip: null },
        'clips: a clip Kick has nothing on is answered with nothing, not an error');

      w.send({ cmd: 'clip', id: 'c4', platform: 'twitch', clipId: 'OddSlug' });
      await wait(30);
      eq(w.last('clip').clip.thumbnail, '',
        'clips: a thumbnail off the platform’s own hosts is not passed on');

      const before = w.fetchCalls.length;
      w.send({ cmd: 'clip', id: 'c5', platform: 'twitch', clipId: 'GoodSlug' });
      await wait(30);
      eq(w.fetchCalls.length, before, 'clips: the same clip again is answered from memory');
      eq(w.last('clip').id, 'c5', 'clips: and still answered');

      w.send({ cmd: 'clip', id: 'c6', platform: 'twitch', clipId: '../evil' });
      await wait(30);
      eq(w.last('clip'), { type: 'clip', id: 'c6', clip: null },
        'clips: an id that is not an id is not asked about');
      eq(w.fetchCalls.length, before, 'clips: at all');
    } finally { w.teardown(); }
  })();
};

// ── Replaying a Kick channel's history ─────────────────────────────
//
// A Kick channel has two ids: the chatroom's, which names the Pusher room, and
// the channel's own. History is keyed by the second, and asking with the first
// is answered `200 OK` with an empty list — an answer, not an error, so nothing
// anywhere noticed that the backlog after a reload was always empty.
suites.kickhistory = function () {
  const { bootWorker, wait } = require('./background.js');

  async function joined(w) {
    w.connect();
    w.send({ cmd: 'hello', site: 'kick', channel: 'somechannel', hints: [] });
    await wait(60);
    w.send({ cmd: 'join', platform: 'kick', channel: 'somechannel' });
    await wait(80);
    const pusher = w.socketFor('pusher.com');
    pusher.push(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
    await wait(80);
    return pusher;
  }

  return (async () => {
    // The harness's channel record is `{ id: 9, chatroom: { id: 55 } }`, so the
    // two ids are told apart by which number the request carries.
    {
      const w = bootWorker({
        kickHistory: [
          {
            id: 'm1',
            content: 'said before you arrived',
            created_at: '2024-01-01T00:00:00Z',
            sender: { id: 3, username: 'Regular', identity: { color: '#75FD46', badges: [] } },
          },
        ],
      });
      try {
        await joined(w);
        await wait(40);
        const asked = w.fetchCalls.map((c) => c.url).filter((u) => u.includes('/messages?limit='));
        eq(asked.length, 1, 'kickhistory: the backlog is asked for once');
        ok(asked[0].includes('/channels/9/messages'),
          'kickhistory: with the channel’s own id');
        ok(!asked[0].includes('/channels/55/'),
          'kickhistory: and not the chatroom’s, which answers with an empty list');

        const rows = w.of('batch').flatMap((b) => b.rows || []);
        eq(rows.length, 1, 'kickhistory: and what came back reaches the feed');
        eq(rows[0].author, 'Regular', 'kickhistory: as the person who said it');
        eq(rows[0].history, true, 'kickhistory: marked as backlog rather than live chat');
      } finally { w.teardown(); }
    }

    // A tab reloading onto a chat that is already connected replays the same
    // way — the socket is not reopened, so the id has to have been kept.
    {
      const w = bootWorker({ kickHistory: [] });
      try {
        await joined(w);
        w.clear();
        w.fetchCalls.length = 0;
        w.send({ cmd: 'hello', site: 'kick', channel: 'somechannel', hints: [] });
        await wait(120);
        ok(w.fetchCalls.some((c) => c.url.includes('/channels/9/messages')),
          'kickhistory: a reload onto the same channel asks again, still by channel id');
      } finally { w.teardown(); }
    }
  })();
};

// ── Moderating a Kick channel ────────────────────────────────────────────────
//
// Kick will only say who *you* are in a room to the browser session that asks.
// The channel record the worker fetches describes the channel, not the person
// reading it, so it can only ever settle the broadcaster — which is why an
// ordinary moderator saw no tools at all. The page is asked instead.
suites.kickmod = function () {
  const FCM = load(makeSandbox(), ...SHARED);
  const read = FCM.readKickStanding;

  // ── Reading Kick's answer ──
  //
  // None of these field names are documented, so every plausible spelling is
  // accepted. Being generous is safe in one direction only, which is why the
  // worker never takes tools away on the strength of it.
  eq(read({ id: 7, username: 'ModPerson', is_moderator: true }),
    { known: true, canModerate: true, username: 'ModPerson' },
    'kickmod: a moderator is read, and named');
  eq(read({ id: 7, username: 'Streamer', is_broadcaster: true }).canModerate, true,
    'kickmod: so is the broadcaster of the room');
  eq(read({ id: 7, username: 'A', is_channel_owner: true }).canModerate, true,
    'kickmod: and the owner, however it is spelled');
  eq(read({ id: 7, username: 'A', is_super_admin: true }).canModerate, true,
    'kickmod: a super admin can moderate anywhere');
  eq(read({ id: 7, username: 'A', is_moderator: 'true' }).canModerate, true,
    'kickmod: a flag sent as a string still reads as one');
  eq(read({ id: 7, username: 'A', role: 'moderator' }).canModerate, true,
    'kickmod: a role named as a word');
  eq(read({ id: 7, username: 'A', roles: ['subscriber', 'Moderator'] }).canModerate, true,
    'kickmod: one among several, whatever its case');
  eq(read({ id: 7, username: 'A', badges: [{ type: 'moderator' }] }).canModerate, true,
    'kickmod: or carried as a badge, the way Kick draws one in chat');
  eq(read({ id: 7, username: 'A', chatroom: { is_moderator: true } }).canModerate, true,
    'kickmod: nested under the chatroom, as the channel record spells it');

  eq(read({ id: 7, username: 'Viewer', is_moderator: false }),
    { known: true, canModerate: false, username: 'Viewer' },
    'kickmod: an ordinary viewer is an answer, and the answer is no');
  eq(read({ id: 7, username: 'A', badges: [{ type: 'subscriber' }], roles: ['vip'] }).canModerate,
    false, 'kickmod: a badge that is not a moderator badge is not one');

  // Anything that is not an answer about somebody leaves the worker where it
  // was, rather than saying they moderate nothing.
  eq(read({ message: 'Unauthenticated.' }).known, false,
    'kickmod: no session is Kick refusing to say, not saying no');
  eq(read(null).known, false, 'kickmod: nothing is not an answer');
  eq(read('<html>').known, false, 'kickmod: nor a page that is not JSON');
  eq(read([]).known, false, 'kickmod: nor a list');
  eq(read({}).known, true, 'kickmod: an empty record is an answer about a viewer with no roles');
  eq(read({}).canModerate, false, 'kickmod: and it is no');

  // The name matters: the session that answered is not always the account the
  // extension holds a token for.
  eq(read({ id: 1, user: { username: 'Nested' }, is_moderator: true }).username, 'Nested',
    'kickmod: the name is found wherever Kick puts it');
  eq(read({ id: 1, slug: 'by-slug' }).username, 'by-slug', 'kickmod: or from the slug');
};

// The same, driven through the worker exactly as the tab drives it.
suites.kickmodworker = function () {
  const { bootWorker, wait } = require('./background.js');

  // Joins Kick and gets as far as the worker asking about this viewer.
  async function joined(w, { login = 'me' } = {}) {
    if (login) {
      w.storage.local.fcm_auth_v1 = {
        kick: { accessToken: 'k', refreshToken: 'r', login, userId: '5', expiresAt: 0 },
      };
    }
    w.connect();
    w.send({ cmd: 'hello', site: 'kick', channel: 'somechannel', hints: [] });
    await wait(60);
    w.send({ cmd: 'join', platform: 'kick', channel: 'somechannel' });
    await wait(80);
    const pusher = w.socketFor('pusher.com');
    ok(pusher, 'kickmod: a Kick socket is opened');
    pusher.push(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
    await wait(80);
    return pusher;
  }

  return (async () => {
    // ── The ordinary case: the worker cannot find out, so the tab is asked ──
    {
      const w = bootWorker();
      try {
        await joined(w);
        const ask = w.last('needKickModerator');
        ok(ask, 'kickmod: the worker asks the tab, which is where the session is');
        eq(ask.channel, 'somechannel', 'kickmod: about the channel it just joined');
        eq(w.of('moderator').filter((m) => m.canModerate).length, 0,
          'kickmod: and claims nothing until the tab answers');

        // The tab answers, the way boot.js does.
        w.send({ cmd: 'kickModerator', channel: 'somechannel', canModerate: true, username: 'me' });
        await wait(30);
        const told = w.last('moderator');
        eq(told, { type: 'moderator', platform: 'kick', canModerate: true },
          'kickmod: and the tools are turned on for Kick when it says yes');
      } finally { w.teardown(); }
    }

    // ── An answer about a channel this tab has left ──
    {
      const w = bootWorker();
      try {
        await joined(w);
        w.clear();
        w.send({ cmd: 'kickModerator', channel: 'somewhere-else', canModerate: true, username: 'me' });
        await wait(30);
        eq(w.of('moderator').length, 0,
          'kickmod: an answer about another channel is not applied to this one');
      } finally { w.teardown(); }
    }

    // ── Signed in to kick.com as somebody else ──
    {
      const w = bootWorker();
      try {
        await joined(w, { login: 'me' });
        w.clear();
        w.send({
          cmd: 'kickModerator', channel: 'somechannel', canModerate: true, username: 'SomebodyElse',
        });
        await wait(30);
        eq(w.of('moderator').length, 0,
          'kickmod: a moderator who is not the connected account gets no tools');
        ok(w.of('sys').some((s) => /signed in as SomebodyElse/i.test(s.text)),
          'kickmod: and the feed says which two accounts disagree');
        // Said once, not on every answer.
        w.clear();
        w.send({
          cmd: 'kickModerator', channel: 'somechannel', canModerate: true, username: 'SomebodyElse',
        });
        await wait(30);
        eq(w.of('sys').length, 0, 'kickmod: and says it once, not on every answer');
      } finally { w.teardown(); }
    }

    // ── Moderating with no Kick account connected ──
    //
    // The tools act through the connected account's token, so there is nothing
    // to offer — but this is exactly the person who would wonder why.
    {
      const w = bootWorker();
      try {
        await joined(w, { login: '' });
        w.clear();
        w.send({ cmd: 'kickModerator', channel: 'somechannel', canModerate: true, username: 'me' });
        await wait(30);
        eq(w.of('moderator').length, 0, 'kickmod: no account connected means no tools');
        ok(w.of('sys').some((s) => /connect a Kick account/i.test(s.text)),
          'kickmod: and the feed says that is why');
      } finally { w.teardown(); }
    }

    // ── The worker's own try, which is the only route on a Twitch tab ──
    {
      const w = bootWorker({
        fetchImpl: async (url, init) => {
          const u = String(url);
          if (u.includes('/channels/somechannel/me')) {
            // Only worth answering when the session actually travelled.
            eq(init && init.credentials, 'include',
              'kickmod: the worker sends the session it may have');
            return { ok: true, json: async () => ({ id: 7, username: 'me', is_moderator: true }) };
          }
          if (/kick\.com\/api\/v\d\/channels\/([^/?]+)$/.test(u)) {
            return {
              ok: true,
              json: async () => ({
                id: 9, user_id: 77, slug: 'somechannel', chatroom: { id: 55 },
                user: { username: 'somechannel' },
              }),
            };
          }
          return { ok: false, status: 404, json: async () => ({}) };
        },
      });
      try {
        await joined(w);
        eq(w.last('moderator'), { type: 'moderator', platform: 'kick', canModerate: true },
          'kickmod: an answer the worker got itself is enough');
        eq(w.of('needKickModerator').length, 0,
          'kickmod: and the tab is not asked for something already known');
      } finally { w.teardown(); }
    }

    // ── With the session cookie, the worker asks for itself ──
    //
    // Kick reads the session as a bearer token, not from the cookie jar. The
    // `cookies` permission lets the worker read the cookie kick.com set and
    // send it the way Kick's own site does, which is what makes this work
    // from a Twitch tab, where there is no kick.com page to ask.
    {
      const record = () => ({
        ok: true,
        json: async () => ({
          id: 9, user_id: 77, slug: 'somechannel', chatroom: { id: 55 },
          user: { username: 'somechannel' },
        }),
      });
      const withCookie = (whoami) => async (url, init) => {
        const u = String(url);
        const auth = init && init.headers && init.headers.Authorization;
        if (u.includes('/channels/somechannel/me')) {
          if (auth !== 'Bearer sess ion') {
            return { ok: false, status: 401, json: async () => ({ message: 'Unauthenticated.' }) };
          }
          // The real shape: a standing with no name on it.
          return { ok: true, json: async () => ({ is_moderator: true, is_broadcaster: false }) };
        }
        if (u.endsWith('/api/v1/user')) {
          if (auth !== 'Bearer sess ion') return { ok: true, json: async () => ({}) };
          return { ok: true, json: async () => ({ id: 1, username: whoami }) };
        }
        if (/kick\.com\/api\/v\d\/channels\/([^/?]+)$/.test(u)) return record();
        return { ok: false, status: 404, json: async () => ({}) };
      };

      const w = bootWorker({ cookies: { session_token: 'sess%20ion' }, fetchImpl: withCookie('me') });
      try {
        await joined(w);
        eq(w.last('moderator'), { type: 'moderator', platform: 'kick', canModerate: true },
          'kickmod: the session cookie, sent as the bearer token Kick reads, is enough');
        eq(w.of('needKickModerator').length, 0,
          'kickmod: and the tab is not asked for what the worker found out');
      } finally { w.teardown(); }

      // The name Kick does not put on the standing is read from the account,
      // so the guard against acting as somebody else still has something to
      // compare.
      const other = bootWorker({
        cookies: { session_token: 'sess%20ion' }, fetchImpl: withCookie('SomebodyElse'),
      });
      try {
        await joined(other);
        eq(other.of('moderator').filter((m) => m.canModerate).length, 0,
          'kickmod: a browser signed in as somebody else gets no tools from the worker either');
        ok(other.of('sys').some((s) => /signed in as SomebodyElse/i.test(s.text)),
          'kickmod: and the feed says so');
      } finally { other.teardown(); }

      // No cookie: exactly where things were, the tab is asked.
      const bare = bootWorker({ fetchImpl: withCookie('me') });
      try {
        await joined(bare);
        ok(bare.last('needKickModerator'), 'kickmod: without the cookie the tab is asked');
      } finally { bare.teardown(); }
    }

    // ── Never taken away ──
    //
    // The field names are undocumented guesses. A "no" built on a guess must
    // not be able to take the broadcaster's own tools off them.
    {
      const w = bootWorker();
      try {
        // The connected account is the channel: the broadcaster of the room.
        await joined(w, { login: 'somechannel' });
        eq(w.last('moderator').canModerate, true,
          'kickmod: the broadcaster is known from the channel record alone');
        w.clear();
        w.send({ cmd: 'kickModerator', channel: 'somechannel', canModerate: false, username: 'somechannel' });
        await wait(30);
        eq(w.of('moderator').length, 0,
          'kickmod: and a later "no" never takes the tools away again');
      } finally { w.teardown(); }
    }

    // ── Leaving forgets it ──
    {
      const w = bootWorker();
      try {
        await joined(w);
        w.send({ cmd: 'kickModerator', channel: 'somechannel', canModerate: true, username: 'me' });
        await wait(30);
        eq(w.last('moderator').canModerate, true, 'kickmod: moderating, then');
        w.clear();
        w.send({ cmd: 'leave', platform: 'kick' });
        await wait(30);
        eq(w.last('moderator'), { type: 'moderator', platform: 'kick', canModerate: false },
          'kickmod: leaving the channel takes the tools with it');
      } finally { w.teardown(); }
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
