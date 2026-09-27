const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const CHANNEL = 'https://www.youtube.com/@Example';
const SECOND = 'https://www.youtube.com/@Another';
const clean = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const listeners = [], store = {}, reads = [], writes = [];
  const chrome = {
    runtime: { id: 'fixture', getURL: file => `chrome-extension://fixture/${file}`,
      onMessage: { addListener: fn => listeners.push(fn) } },
    storage: { local: {
      async get(keys) { reads.push(keys); return structuredClone(store); },
      async set(patch) { writes.push(structuredClone(patch)); Object.assign(store, structuredClone(patch)); },
    } },
  };
  const sandbox = vm.createContext({ chrome, URL, Date }); sandbox.self = sandbox;
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/youtube.js',
    'src/shared/youtube-links.js', 'src/background/youtube-links.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: path.join(ROOT, file) });
  }
  const FCM = sandbox.FCM, key = FCM.STORAGE_KEYS.youtubeLinks;
  const sender = { id: 'fixture', tab: { id: 7 }, frameId: 0, url: 'https://www.twitch.tv/example' };
  const message = { platform: 'twitch', channel: 'example' };
  function request(cmd = 'youtubeLinkGet', extra = {}, from = sender) {
    return new Promise(resolve => {
      const handled = listeners[0]({ ...message, cmd, ...extra }, from, answer => resolve(clean(answer)));
      if (handled !== true) queueMicrotask(() => resolve(null));
    });
  }
  function pair() {
    store[FCM.STORAGE_KEYS.links] = {
      'twitch:example': { channel: 'different-name', manual: true },
      'kick:different-name': { channel: 'example', manual: true },
    };
  }
  return { FCM, chrome, store, key, reads, writes, listeners, sender, request, pair };
}

async function run() {
  const f = fixture(), F = f.FCM;
  assert.equal(f.key, 'fcm_youtube_links_v1');
  for (const value of [undefined, null, 3, '', []]) assert.equal(F.cleanYouTubeLinks(value), null);
  for (const args of [['youtube', 'example'], ['twitch', null], ['twitch', 'one-two'], ['kick', 'a'],
    ['twitch', 'drops'], ['kick', 'drops'], ['kick', '@name'], ['kick', 'x'.repeat(31)]]) {
    assert.equal(F.youtubeLinkHostKey(...args), '');
  }
  assert.equal(F.youtubeLinkHostKey('twitch', ' Example '), 'twitch:example');
  assert.equal(F.youtubeLinkHostKey('kick', 'Some-One'), 'kick:some-one');
  const malformed = {
    '__proto__:oops': { channelUrl: CHANNEL }, 'youtube:example': { channelUrl: CHANNEL },
    'twitch:example:extra': { channelUrl: CHANNEL }, 'kick:missing': null,
    'kick:string': CHANNEL, 'kick:array': [], 'twitch:invalid': { channelUrl: 'https://evil.test/' },
    'kick:directvideo': { channelUrl: 'AbCdEfGhI_1' },
    'twitch: Example ': { channelUrl: 'https://m.youtube.com/@Example/live?x=1', at: 42, ignored: 'secret' },
    'kick:valid': { channelUrl: SECOND, at: -1 },
    'kick:nan': { channelUrl: SECOND, at: NaN },
    'kick:stringtime': { channelUrl: SECOND, at: '42' },
  };
  assert.deepEqual(clean(F.cleanYouTubeLinks(malformed)), {
    'twitch:example': { channelUrl: CHANNEL, at: 42 }, 'kick:valid': { channelUrl: SECOND, at: 0 },
    'kick:nan': { channelUrl: SECOND, at: 0 }, 'kick:stringtime': { channelUrl: SECOND, at: 0 },
  });
  const many = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`kick:user${i}`, { channelUrl: CHANNEL, at: 0 }]));
  assert.equal(Object.keys(F.cleanYouTubeLinks(many)).length, 400);
  assert.deepEqual(clean(F.cleanYouTubeLinks({})), {});

  let called = false;
  assert.equal(f.listeners[0](null, f.sender, () => { called = true; }), false);
  assert.equal(f.listeners[0]({ cmd: 'different' }, f.sender, () => { called = true; }), false);
  assert.equal(called, false);
  const invalidSenders = [null, { ...f.sender, id: 'other' }, { ...f.sender, tab: null },
    { ...f.sender, tab: { id: -1 } }, { ...f.sender, tab: { id: '7' } }, { ...f.sender, frameId: 1 },
    ...['not a URL', 'http://twitch.tv/example', 'https://twitch.tv:444/example',
      'https://name@twitch.tv/example', 'https://name:secret@twitch.tv/example',
      'https://evil.twitch.tv/example', 'https://www.youtube.com/example', 'https://twitch.tv/',
      'https://twitch.tv/drops', 'https://twitch.tv/popout', 'https://twitch.tv/other',
      'https://kick.com/drops'].map(url => ({ ...f.sender, url }))];
  for (const sender of invalidSenders) {
    assert.equal((await f.request('youtubeLinkGet', {}, sender)).error, 'invalid-host');
  }
  assert.equal((await f.request('youtubeLinkSave', { platform: 'youtube' })).error, 'invalid-host');
  assert.equal(f.reads.length, 0, 'refused senders cannot read storage');
  assert.deepEqual(await f.request(), { ok: true, link: null, counterpart: null });
  for (const url of ['https://twitch.tv/example', 'https://www.twitch.tv/popout/example/chat',
    'https://twitch.tv/moderator/example', 'https://twitch.tv/embed/example/chat']) {
    assert.equal((await f.request('youtubeLinkGet', {}, { ...f.sender, url })).ok, true);
  }
  for (const url of ['https://kick.com/example', 'https://www.kick.com/popout/example/chat']) {
    assert.equal((await f.request('youtubeLinkGet', { platform: 'kick' }, { ...f.sender, url })).ok, true);
  }
  for (const channelUrl of [undefined, '', 'AbCdEfGhI_1', 'https://evil.test/@Example']) {
    assert.equal((await f.request('youtubeLinkSave', { channelUrl })).error, 'invalid-channel');
  }
  assert.equal((await f.request('youtubeLinkSave', { channelUrl: CHANNEL, counterpartChannel: 'other' })).error, 'counterpart-changed');
  const saved = await f.request('youtubeLinkSave', { channelUrl: CHANNEL + '/streams' });
  assert.equal(saved.ok, true); assert.equal(saved.link.channelUrl, CHANNEL); assert.ok(saved.link.at > 0);
  assert.deepEqual(await f.request(), { ok: true, link: saved.link, counterpart: null });
  assert.deepEqual(f.store[f.key], { 'twitch:example': saved.link });

  f.pair();
  assert.deepEqual((await f.request()).counterpart, { platform: 'kick', channel: 'different-name', link: null });
  const paired = await f.request('youtubeLinkSave', { channelUrl: SECOND, counterpartChannel: 'different-name' });
  assert.equal(paired.ok, true);
  assert.deepEqual(f.store[f.key]['twitch:example'], f.store[f.key]['kick:different-name']);
  assert.deepEqual((await f.request()).counterpart.link, paired.link);
  assert.equal((await f.request('youtubeLinkSave', { channelUrl: CHANNEL, counterpartChannel: 'outdated' })).error, 'counterpart-changed');
  for (const mutation of [records => { records['twitch:example'].manual = false; },
    records => { records['twitch:example'].none = true; }, records => { records['twitch:example'].channel = 'drops'; },
    records => { delete records['kick:different-name']; }, records => { records['kick:different-name'].manual = false; },
    records => { records['kick:different-name'].none = true; }, records => { records['kick:different-name'].channel = 'someoneelse'; }]) {
    f.pair(); mutation(f.store[F.STORAGE_KEYS.links]);
    assert.equal((await f.request()).counterpart, null);
  }
  f.pair();
  const kickSender = { ...f.sender, url: 'https://kick.com/different-name' };
  const kickInfo = await f.request('youtubeLinkGet', { platform: 'kick', channel: 'different-name' }, kickSender);
  assert.equal(kickInfo.counterpart.platform, 'twitch'); assert.equal(kickInfo.counterpart.channel, 'example');
  assert.deepEqual(await f.request('youtubeLinkForget'), { ok: true, link: null });
  assert.ok(f.store[f.key]['kick:different-name'], 'forgetting one host leaves the other explicit choice');
  assert.equal(f.store[f.key]['twitch:example'], undefined);
  assert.equal((await f.request('youtubeLinkForget')).ok, true, 'forget is idempotent');

  const optionsSender = { id: 'fixture', url: f.chrome.runtime.getURL('src/options/options.html') };
  const forget = { hostKey: 'kick:different-name', channelUrl: SECOND };
  for (const sender of [null, f.sender, { ...optionsSender, id: 'other' },
    { ...optionsSender, url: 'https://evil.test/src/options/options.html' }]) {
    assert.equal((await f.request('youtubeLinkForgetSaved', forget, sender)).error, 'invalid-host');
  }
  for (const hostKey of [undefined, 'kick', 'kick:name:extra', 'youtube:name', 'twitch:drops']) {
    assert.equal((await f.request('youtubeLinkForgetSaved', { ...forget, hostKey }, optionsSender)).error, 'invalid-host');
  }
  assert.equal((await f.request('youtubeLinkForgetSaved', { ...forget, channelUrl: CHANNEL }, optionsSender)).error, 'link-changed');
  assert.equal((await f.request('youtubeLinkForgetSaved', forget, optionsSender)).ok, true);
  assert.equal((await f.request('youtubeLinkForgetSaved', forget, optionsSender)).error, 'link-changed');

  const full = fixture(); full.store[full.key] = many;
  assert.equal((await full.request('youtubeLinkSave', { channelUrl: CHANNEL })).error, 'limit');
  assert.equal(full.writes.length, 0, 'a full store never evicts another explicit link');
  const update = await full.request('youtubeLinkSave', { platform: 'kick', channel: 'user0', channelUrl: SECOND },
    { ...full.sender, url: 'https://kick.com/user0' });
  assert.equal(update.ok, true, 'an existing link can be replaced at capacity');
  assert.equal(Object.keys(full.store[full.key]).length, 400);
  const almost = fixture(); almost.pair(); almost.store[almost.key] = Object.fromEntries(Object.entries(many).slice(0, 399));
  assert.equal((await almost.request('youtubeLinkSave', { channelUrl: CHANNEL, counterpartChannel: 'different-name' })).error, 'limit');
  assert.equal(almost.writes.length, 0, 'saving both hosts refuses atomically if only one free slot remains');

  const broken = fixture(), originalGet = broken.chrome.storage.local.get, originalSet = broken.chrome.storage.local.set;
  broken.chrome.storage.local.get = async () => { throw Error('private get failure'); };
  assert.deepEqual(await broken.request(), { ok: false, error: 'storage' });
  broken.chrome.storage.local.get = originalGet;
  broken.chrome.storage.local.set = async () => { throw Error('private set failure'); };
  assert.deepEqual(await broken.request('youtubeLinkSave', { channelUrl: CHANNEL }), { ok: false, error: 'storage' });
  assert.deepEqual(await broken.request('youtubeLinkForget'), { ok: false, error: 'storage' });
  broken.chrome.storage.local.set = originalSet;
  assert.equal((await broken.request('youtubeLinkSave', { channelUrl: CHANNEL })).ok, true, 'failure does not poison the write queue');
  broken.store[broken.key] = { 'twitch:example': { channelUrl: 'https://evil.test/', at: 1 } };
  assert.equal((await broken.request()).link, null, 'corrupt stored input cannot authorize capture');

  const concurrent = fixture();
  await Promise.all([
    concurrent.request('youtubeLinkSave', { channelUrl: CHANNEL }),
    concurrent.request('youtubeLinkSave', { channel: 'another', channelUrl: SECOND },
      { ...concurrent.sender, url: 'https://twitch.tv/another', tab: { id: 8 } }),
  ]);
  assert.deepEqual(Object.keys(concurrent.store[concurrent.key]).sort(), ['twitch:another', 'twitch:example']);
  assert.deepEqual(Array.from(F.PLATFORMS), ['twitch', 'kick']);
  assert.deepEqual(Array.from(F.SEND_PLATFORMS), ['twitch', 'kick']);
  console.log('YouTube saved-link schema and route tests passed.');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
