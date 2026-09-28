// Issue #64: preserve Twitch's Gigantify marker from IRC through live/history rendering.
// Offline fixtures, never a real redemption or Bits purchase.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bootWorker, wait } = require('./background.js');
const ROOT = path.resolve(__dirname, '..');

function harness(history) {
  const rows = [], batches = [], sockets = [];
  const context = vm.createContext({
    console, URL,
    chrome: { storage: { sync: { get: async () => ({}) } } },
    document: { createElement: () => ({ dataset: {}, innerHTML: '' }) },
    WebSocket: function () { sockets.push(this); },
    fetch: async () => ({ ok: true, json: async () => ({ messages: history }) }),
  });
  context.self = context;
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/util.js',
    'src/shared/irc.js', 'src/shared/youtube.js', 'src/shared/emote-parsers.js', 'src/background/twitch-source.js',
    'src/content/render.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  const sink = { status() {}, sys() {}, event() {}, chat: row => rows.push(row), batch: batch => batches.push(...batch) };
  context.FCM.setViewSettings(context.FCM.DEFAULT_SETTINGS);
  return { FCM: context.FCM, rows, batches, sockets, sink };
}

const line = (extra = '', text = 'Kappa Kappa', emotes = '25:0-4,6-10') =>
  `@display-name=Viewer;emotes=${emotes};id=fixture;${extra} :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #fixture :${text}`;

async function run() {
  const fixtures = [
    line('msg-id=gigantified-emote-message'),
    line('msg-id=gigantified-emote-message;bits=100'),
    line('msg-id=gigantified-emote-message;custom-reward-id=fixture-reward'),
    line(), line('msg-id=animated-message'), line('msg-id=gigantified-emote-message-forged'),
    line('bits=100'), line('custom-reward-id=fixture-reward'),
    line('', 'msg-id=gigantified-emote-message Kappa', '25:33-37'),
    line('msg-id=gigantified-emote-message', '\u0001ACTION 😀 Kappa\u0001', '25:2-6'),
  ];
  const h = harness(fixtures), { FCM } = h;
  FCM.twitchSource.connect('fixture', h.sink, {}, null);
  h.sockets[0].onmessage({ data: fixtures.join('\r\n') });
  await FCM.twitchSource.fetchHistory('fixture', h.sink, 60);
  assert.equal(h.rows.length, fixtures.length);
  assert.equal(h.batches.length, fixtures.length);
  for (const [index, row] of h.rows.entries()) {
    const expected = index < 3 || index === 9;
    assert.equal(row.gigantifiedEmote, expected, `live marker ${index}`);
    assert.equal(h.batches[index].gigantifiedEmote, expected, `history marker ${index}`);
    for (const item of [row, h.batches[index]]) {
      const html = FCM.buildMessageEl(item).innerHTML;
      assert.equal((html.match(/fcm-emote-gigantified/g) || []).length, expected ? 1 : 0,
        `source-to-row rendering ${index}`);
    }
  }

  const render = (text, emotes, extra = {}) => FCM.renderMessageBody('twitch', text,
    { emoteMap: FCM.parseTwitchEmoteMap(emotes), gigantifiedEmote: true, ...extra }).html;
  const repeated = render('Kappa Kappa', '25:0-4,6-10');
  assert.match(repeated, /class="fcm-emote twitch-emote"[^>]+\/2\.0/);
  assert.match(repeated, /class="fcm-emote twitch-emote fcm-emote-gigantified"[^>]+\/3\.0/);
  assert.equal((repeated.match(/fcm-emote-gigantified/g) || []).length, 1);
  const multiple = render('😀 Kappa PogChamp', '88:8-15/25:2-6');
  assert.match(multiple, /fcm-emote-gigantified[^>]+\/88\/default\/dark\/3\.0" alt="PogChamp"/,
    'select by final position, not tag ordering, with Unicode offsets');
  assert.ok(multiple.startsWith('😀 '));
  for (const flag of [false, 'true', 1, null, undefined]) {
    assert.ok(!render('Kappa', '25:0-4', { gigantifiedEmote: flag }).includes('fcm-emote-gigantified'));
  }
  for (const emotes of ['', '25:9-13', '25:5-0']) {
    assert.ok(!render('Kappa', emotes).includes('fcm-emote-gigantified'), 'no guessed emote');
  }
  FCM.setEmotes('twitch', 'thirdparty', { ThirdParty: { url: 'https://cdn.7tv.app/emote/fixture/2x.webp', source: '7TV' } });
  assert.ok(!render('ThirdParty', '').includes('fcm-emote-gigantified'), 'third-party-only text is not enlarged');
  const thirdParty = render('Kappa ThirdParty', '25:0-4');
  assert.match(thirdParty, /fcm-emote-gigantified[^>]+alt="Kappa"/);
  assert.match(thirdParty, /class="fcm-emote thirdparty-emote"[^>]+alt="ThirdParty"/);
  const gifs = [{ start: 6, end: 8, id: 'fixture', url: 'https://media.giphy.com/media/fixture/giphy.gif' }];
  assert.match(render('Kappa GIF', '25:0-4', { gifs }), /fcm-emote-gigantified[^>]+alt="Kappa"/);
  assert.ok(!render('GIF', '', { gifs: [{ ...gifs[0], start: 0, end: 2 }] }).includes('fcm-emote-gigantified'));
  assert.ok(!FCM.renderMessageBody('kick', '[emote:25:Kappa]', { gigantifiedEmote: true }).html.includes('fcm-emote-gigantified'));
  assert.equal(FCM.renderMessageBody('youtube', '<Kappa>', { gigantifiedEmote: true }).html, '&lt;Kappa&gt;');
  assert.equal(FCM.renderMessageBody('unknown', 'Kappa', { gigantifiedEmote: true }).html, 'Kappa');
  assert.ok(!FCM.renderMessageBody('twitch', 'Kappa', { emoteMap: FCM.parseTwitchEmoteMap('25:0-4') }).html.includes('fcm-emote-gigantified'));
  const css = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
  assert.match(css, /\.fcm-emote\.fcm-emote-gigantified\s*\{[^}]*height:\s*112px;[^}]*max-height:\s*112px;[^}]*max-width:\s*100%;/);
  assert.match(css, /\.fcm-emote\s*\{\s*max-height:\s*26px;/, 'ordinary emotes keep their normal bound');

  // The real service worker and generated Firefox script order must carry the
  // marker through the content-script port, not merely keep it inside a source.
  for (const loadPath of ['worker', 'scripts']) {
    const worker = bootWorker({ loadPath, twitchHistory: fixtures.slice(0, 4) });
    try {
      worker.connect();
      worker.send({ cmd: 'hello', site: 'kick', channel: 'fixture', hints: [] });
      await wait(40);
      worker.send({ cmd: 'join', platform: 'twitch', channel: 'fixture' });
      await wait(40);
      const socket = worker.socketFor('irc-ws');
      assert.ok(socket);
      socket.push(':tmi.twitch.tv 366 justinfan1 #fixture :End of /NAMES list\r\n');
      socket.push(fixtures.slice(0, 4).join('\r\n'));
      await wait(40);
      const live = worker.of('chat').map(message => message.msg);
      const history = worker.of('batch').flatMap(message => message.rows);
      assert.deepEqual(Array.from(live, row => row.gigantifiedEmote), [true, true, true, false]);
      assert.deepEqual(Array.from(history, row => row.gigantifiedEmote), [true, true, true, false]);
      assert.match(FCM.buildMessageEl(live[0]).innerHTML, /fcm-emote-gigantified/);
      assert.match(FCM.buildMessageEl(history[0]).innerHTML, /fcm-emote-gigantified/);
    } finally { worker.teardown(); }
  }
}

module.exports = { run };
if (require.main === module) run().then(() => console.log('Issue #64 Gigantify tests passed')).catch(error => { console.error(error); process.exitCode = 1; });
