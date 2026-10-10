// Offline native Twitch pinning, exact message targets, and moderator boundaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function backend(options = {}) {
  const calls = [], reads = [];
  const context = vm.createContext({ console, fetch: async (url, init) => {
    calls.push({ url, init });
    if (options.throw) throw Error('offline');
    return { ok: options.ok ?? (options.status ? options.status === 204 : true), status: options.status || 204,
      json: async () => { if (options.badJson) throw Error('not json'); return options.body || {}; } };
  } }); context.self = context;
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/background/moderation.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: path.join(ROOT, file) });
  }
  context.FCM.auth = { usable: async platform => { reads.push(platform); return options.disconnected ? null :
    { accessToken: 'fixture-token', clientId: 'fixture-client', userId: 'moderator/&' }; } };
  const act = (action, opts = {}, platform = 'twitch', conn = { roomId: 'room/&' }) => context.FCM.moderate(platform, action, opts, conn, {});
  return { F: context.FCM, calls, reads, act };
}

async function run() {
  const b = backend();
  for (const action of ['pin', 'unpin']) {
    b.calls.length = 0;
    const result = await b.act(action, { username: 'Viewer', messageId: 'message/&', seconds: 300 });
    assert.equal(result.ok, true); assert.equal(result.action, action);
    assert.equal(result.messageId, 'message/&');
    assert.equal(b.calls.length, 1, 'message pin never performs a user lookup or ban');
    const { url, init } = b.calls[0], query = new URL(url).searchParams;
    assert.equal(new URL(url).pathname, '/helix/chat/pins');
    assert.equal(query.get('broadcaster_id'), 'room/&'); assert.equal(query.get('moderator_id'), 'moderator/&');
    assert.equal(query.get('message_id'), 'message/&'); assert.equal(init.method, action === 'pin' ? 'PUT' : 'DELETE');
    assert.equal(query.get('duration_seconds'), action === 'pin' ? '300' : null);
    assert.equal(init.body, undefined); assert.equal(init.headers.Authorization, 'Bearer fixture-token');
  }
  await b.act('pin', { messageId: 'one' });
  assert.equal(new URL(b.calls.at(-1).url).searchParams.has('duration_seconds'), false, 'omitted duration lasts until stream ends');
  for (const seconds of [30, 1800]) {
    assert.equal((await b.act('pin', { messageId: 'one', seconds })).ok, true);
  }
  for (const seconds of [0, 29, 1801, 30.5, '300', NaN, Infinity, null]) {
    const before = b.calls.length;
    assert.equal((await b.act('pin', { messageId: 'one', seconds })).reason, 'invalid-pin-duration');
    assert.equal(b.calls.length, before);
  }
  for (const action of ['pin', 'unpin']) {
    assert.equal((await b.act(action)).reason, 'no-message');
    const before = [b.calls.length, b.reads.length];
    assert.equal((await b.act(action, { messageId: 'one' }, 'kick')).reason, 'unsupported-pin');
    assert.deepEqual([b.calls.length, b.reads.length], before, 'Kick cannot fall through to ban or read a token');
    assert.equal((await b.act(action, { messageId: 'one' }, 'youtube')).reason, 'unsupported');
    assert.equal((await backend({ disconnected: true }).act(action, { messageId: 'one' })).reason, 'not-connected');
    assert.equal((await b.act(action, { messageId: 'one' }, 'twitch', {})).reason, 'no-channel');
  }
  for (const action of ['pin ', 'PIN', 'updatepin']) assert.equal((await b.act(action)).reason, 'unsupported-action');
  // Cover shared moderation outcomes as well: adding pin cases must preserve
  // deletion failures, Kick's missing-options guard, and existing result wording.
  assert.equal((await backend({ status: 204, ok: false }).act('delete', { messageId: 'one' })).ok, true);
  assert.equal((await backend({ status: 403, badJson: true }).act('delete', { messageId: 'one' })).detail, 'HTTP 403');
  assert.equal((await backend({ status: 403, body: { message: 'denied' } }).act('delete', { messageId: 'one' })).detail, 'denied');
  assert.equal((await b.F.moderate('kick', 'delete', undefined, { roomId: 'room' }, {})).reason, 'no-message');
  assert.equal(b.F.describeModeration('twitch', { ok: true, action: 'unban' }), 'Twitch: lifted the ban on that viewer');
  assert.equal(b.F.describeModeration('twitch', { ok: true, action: 'timeout', seconds: 10 }), 'Twitch: timed that viewer out for 10s');
  assert.equal(b.F.describeModeration('twitch', { ok: true, action: 'timeout' }), 'Twitch: timed that viewer out for 0s');
  assert.equal(b.F.describeModeration('twitch', { ok: true, action: 'unknown' }), 'Twitch: done');
  for (const status of [400, 401, 403, 404, 409, 429, 500]) {
    const failure = backend({ status, body: { message: 'fixture refusal' } });
    const result = await failure.act('pin', { messageId: 'one' });
    assert.equal(result.reason, 'refused'); assert.equal(result.detail, 'fixture refusal'); assert.equal(failure.calls.length, 1);
  }
  assert.equal((await backend({ status: 403, badJson: true }).act('unpin', { messageId: 'one' })).detail, 'HTTP 403');
  assert.equal((await backend({ throw: true }).act('pin', { messageId: 'one' })).reason, 'network');
  assert.equal(b.F.describeModeration('twitch', { ok: true, action: 'pin', target: 'Viewer', seconds: 300 }), 'Twitch: pinned a message from Viewer for 5m');
  assert.equal(b.F.describeModeration('twitch', { ok: true, action: 'pin' }), 'Twitch: pinned a message from that viewer until the stream ends');
  assert.equal(b.F.describeModeration('twitch', { ok: true, action: 'unpin', target: 'Viewer' }), 'Twitch: unpinned a message from Viewer');
  assert.match(b.F.describeModeration('kick', { ok: false, reason: 'unsupported-pin' }), /native chat controls/);
  assert.match(b.F.describeModeration('twitch', { ok: false, reason: 'invalid-pin-duration' }), /30 seconds.*30 minutes/);

  const { fixture, element } = require('./youtube-view.test');
  const { FCM } = fixture();
  const panel = element(), feed = element(), input = element('textarea'), actions = [];
  let permission = true;
  FCM.getProfile = async () => null;
  const compose = FCM.createCompose({ panel, feedEl: feed, inputEl: input, hostPlatform: 'twitch', canModerate: () => permission,
    onModerate: (...args) => actions.push(plain(args)) });
  const makeRow = (platform, id = 'message-id') => {
    const row = element(), author = element('span'); row.className = 'fcm-msg'; row.dataset = { platform, msgId: id, userId: 'viewer-id' };
    author.className = 'fcm-author'; author.dataset = { name: 'Viewer', platform }; row.appendChild(author); feed.appendChild(row);
    return { row, author };
  };
  const target = { username: 'Viewer', userId: 'viewer-id', messageId: 'message-id' };
  for (const platform of ['twitch', 'kick', 'youtube']) {
    const { row, author } = makeRow(platform);
    const bar = compose.modBarFor(row), pin = bar?.children.find(button => button.textContent === 'Pin');
    assert.equal(!!pin, platform === 'twitch');
    if (pin) { pin.fire('click'); assert.deepEqual(actions.pop(), ['twitch', 'pin', { seconds: 300, ...target }]); }
    const menu = panel.children[1], before = menu.children.length; feed.fire('contextmenu', author);
    const pinActions = menu.children.slice(before).filter(button => /^(Pin this message|Unpin this message)/.test(button.textContent));
    assert.equal(pinActions.length, platform === 'twitch' ? 3 : 0);
    if (platform === 'twitch') {
      pinActions[0].fire('click'); assert.deepEqual(actions.pop(), ['twitch', 'pin', { ...target, seconds: 300 }]);
      pinActions[1].fire('click'); assert.deepEqual(actions.pop(), ['twitch', 'pin', target]);
      pinActions[2].fire('click'); assert.deepEqual(actions.pop(), ['twitch', 'unpin', target]);
      delete row.dataset.msgId;
      assert.equal(compose.modBarFor(row).children.some(button => button.textContent === 'Pin'), false);
      const previous = menu.children.length; feed.fire('contextmenu', author);
      assert.ok(menu.children.slice(previous).filter(button => /^(Pin this message|Unpin this message)/.test(button.textContent)).every(button => button.disabled));
      permission = false; const viewerStart = menu.children.length; feed.fire('contextmenu', author);
      assert.equal(compose.modBarFor(row), null);
      assert.equal(menu.children.slice(viewerStart).some(button => /^(Pin this message|Unpin this message)/.test(button.textContent)), false);
      permission = true;
    }
    compose.closeAll();
  }
  compose.closeAll();
  for (const [browser, loadPath] of [['chrome', 'worker'], ['firefox', 'scripts']]) {
    const worker = require('./background').bootWorker({ browser, loadPath });
    try {
      worker.connect();
      vm.runInContext("sessions.get(1).conns.twitch = { channel: 'streamer', roomId: 'room', canModerate: false };", worker.sandbox);
      const invoked = []; worker.sandbox.FCM.moderate = async (...args) => { invoked.push(args); return { ok: true, action: args[1], target: 'Viewer' }; };
      worker.send({ cmd: 'moderate', platform: 'twitch', action: 'pin', opts: target }); await flush();
      assert.equal(invoked.length, 0); assert.match(worker.last('modResult').text, /not a moderator/);
      vm.runInContext('sessions.get(1).conns.twitch.canModerate = true;', worker.sandbox);
      worker.send({ cmd: 'moderate', platform: 'twitch', action: 'pin', opts: target }); await flush();
      assert.equal(invoked.length, 1); assert.equal(invoked[0][1], 'pin'); assert.deepEqual(plain(invoked[0][2]), target);
      vm.runInContext('sessions.get(1).conns.twitch.canModerate = false;', worker.sandbox);
      worker.send({ cmd: 'moderate', platform: 'twitch', action: 'unpin', opts: target }); await flush();
      assert.equal(invoked.length, 1, 'revoked standing blocks unpin too');
      vm.runInContext('sessions.get(1).conns.twitch.channel = null;', worker.sandbox);
      worker.send({ cmd: 'moderate', platform: 'twitch', action: 'pin', opts: target }); await flush();
      assert.equal(worker.last('modResult').result.reason, 'no-channel');
    } finally { worker.teardown(); }
  }
  console.log('Twitch native pin/unpin tests and Chrome/Firefox moderator boundaries passed.');
}
module.exports = { run, backend };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
