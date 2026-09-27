const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const CHANNEL = 'https://www.youtube.com/@Example';
const VIDEO = 'AbCdEfGhI_1';
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function fixture() {
  const listeners = [], calls = [];
  let now = 100000;
  const chrome = {
    runtime: { id: 'trial', onMessage: { addListener: fn => listeners.push(fn) }, onConnect: { addListener() {} } },
    permissions: { contains: async () => true },
  };
  const FCM = { youtube: { parseInput(input) {
    if (input === `${CHANNEL}/live`) return { channelUrl: CHANNEL };
    if (typeof input === 'string' && /^https:\/\/www\.youtube\.com\/@Example\d*$/.test(input)) return { channelUrl: input };
    if (input === VIDEO) return { videoId: VIDEO };
    throw Error('invalid');
  } }, resolveYouTubeChannel: async input => { calls.push(input); return { videoId: VIDEO }; } };
  const context = vm.createContext({ FCM, chrome, URL, Date: { now: () => now } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background/youtube-relay.js'), 'utf8'), context,
    { filename: path.join(ROOT, 'src/background/youtube-relay.js') });
  const sender = { id: 'trial', frameId: 0, tab: { id: 1 }, url: 'https://www.twitch.tv/example' };
  function request(message = { cmd: 'youtubeResolve', channelUrl: CHANNEL }, from = sender) {
    const replies = [];
    const handled = listeners.map(fn => fn(message, from, reply => replies.push(reply)));
    return { replies, handled };
  }
  function suggest(channelUrl = CHANNEL, tabId = 1) {
    return request({ cmd: 'youtubeSuggest', channelUrl }, { ...sender, tab: { id: tabId } });
  }
  return { FCM, chrome, calls, sender, request, suggest, advance: elapsed => { now += elapsed; } };
}

async function run() {
  const f = fixture();
  const first = f.request(); await settle();
  assert.equal(first.replies[0]?.videoId, VIDEO);
  assert.equal(first.handled.includes(true), true);
  assert.deepEqual(f.calls, [CHANNEL]);
  assert.equal(f.request(null).replies.length, 0);
  assert.equal(f.request({ cmd: 'somethingElse' }).replies.length, 0);
  for (const sender of [null, { ...f.sender, id: 'other' }, { ...f.sender, frameId: 2 },
    { ...f.sender, url: 'https://www.youtube.com/' }]) {
    const r = f.request(undefined, sender); await settle(); assert.equal(r.replies[0].error, 'permission');
  }
  for (const input of [undefined, '', 'https://evil.test/@Example', VIDEO]) {
    const r = f.request({ cmd: 'youtubeResolve', channelUrl: input }); await settle();
    assert.equal(r.replies[0].error, 'unavailable');
  }
  assert.equal(f.calls.length, 1, 'invalid sender/input cannot cause lookup');
  for (const permission of [false, 'truthy']) {
    f.chrome.permissions.contains = async () => permission;
    const r = f.request(); await settle(); assert.equal(r.replies[0].error, 'permission');
  }
  for (const contains of [() => { throw Error('missing'); }, async () => { throw Error('failed'); }]) {
    f.chrome.permissions.contains = contains;
    const r = f.request(); await settle(); assert.equal(r.replies[0].error, 'unavailable');
  }
  f.chrome.permissions.contains = async () => true;
  f.FCM.resolveYouTubeChannel = async () => { throw Error('private detail must not be returned'); };
  const rejected = f.request(); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(rejected.replies)), [{ error: 'unavailable' }]);
  f.FCM.resolveYouTubeChannel = async () => ({ error: 'not-live' });
  const offline = f.request(); await settle(); assert.equal(offline.replies[0].error, 'not-live');

  // Bound work across repeated clicks and across tabs, and release slots on every outcome.
  const pending = [];
  f.FCM.resolveYouTubeChannel = () => new Promise(resolve => pending.push(resolve));
  const jobs = [];
  for (let id = 1; id <= 4; id++) jobs.push(f.request(undefined, { ...f.sender, tab: { id } }));
  const sameTab = f.request(); const fifth = f.request(undefined, { ...f.sender, tab: { id: 5 } });
  await settle(); assert.equal(pending.length, 4);
  assert.equal(sameTab.replies[0].error, 'busy'); assert.equal(fifth.replies[0].error, 'busy');
  pending.forEach(resolve => resolve({ videoId: VIDEO })); await settle();
  assert.ok(jobs.every(job => job.replies[0].videoId === VIDEO));
  f.FCM.resolveYouTubeChannel = async () => ({ videoId: VIDEO });
  const kick = f.request(undefined, { ...f.sender, url: 'https://kick.com/example', tab: { id: 5 } });
  await settle(); assert.equal(kick.replies[0].videoId, VIDEO);

  // Both routes share sender and canonical channel guards before any permission
  // check or public request. Suggestions do not register a capture reader.
  const guarded = fixture(); let permissionChecks = 0;
  guarded.chrome.permissions.contains = async () => { permissionChecks++; return true; };
  for (const cmd of ['youtubeResolve', 'youtubeSuggest']) {
    for (const sender of [null, { ...guarded.sender, id: 'other' }, { ...guarded.sender, frameId: 2 },
      { ...guarded.sender, url: 'https://www.youtube.com/' }]) {
      const r = guarded.request({ cmd, channelUrl: CHANNEL }, sender); await settle();
      assert.equal(r.replies[0].error, 'permission');
    }
    for (const channelUrl of [undefined, '', 'https://evil.test/@Example', VIDEO]) {
      const r = guarded.request({ cmd, channelUrl }); await settle();
      assert.equal(r.replies[0].error, 'unavailable');
    }
  }
  assert.equal(permissionChecks, 0);
  assert.equal(guarded.calls.length, 0);
  const allowed = guarded.suggest(); await settle(); assert.equal(allowed.replies[0].videoId, VIDEO);
  assert.equal(permissionChecks, 1);

  // A cached hint is never a substitute for current permission or a fresh
  // explicit lookup. Only the canonical channel, not its input form, is keyed.
  const cached = fixture();
  cached.suggest(); await settle();
  const alias = cached.suggest(`${CHANNEL}/live`); await settle();
  assert.equal(alias.replies[0].videoId, VIDEO); assert.equal(cached.calls.length, 1);
  cached.chrome.permissions.contains = async () => false;
  const revoked = cached.suggest(); await settle(); assert.equal(revoked.replies[0].error, 'permission');
  cached.chrome.permissions.contains = async () => { throw Error('permission unavailable'); };
  const permissionFailure = cached.suggest(); await settle(); assert.equal(permissionFailure.replies[0].error, 'unavailable');
  cached.chrome.permissions.contains = async () => true;
  cached.FCM.resolveYouTubeChannel = async input => { cached.calls.push(input); return { videoId: 'OtherVideo1' }; };
  const fresh = cached.request(); await settle(); assert.equal(fresh.replies[0].videoId, 'OtherVideo1');
  assert.equal(cached.calls.length, 2);
  const stillHint = cached.suggest(); await settle(); assert.equal(stillHint.replies[0].videoId, VIDEO);
  cached.advance(29999);
  const beforeExpiry = cached.suggest(); await settle(); assert.equal(beforeExpiry.replies[0].videoId, VIDEO);
  cached.advance(1);
  const expired = cached.suggest(); await settle(); assert.equal(expired.replies[0].videoId, 'OtherVideo1');
  assert.equal(cached.calls.length, 3, 'a 30-second-old hint is fetched again');

  // Stable discovery outcomes are reusable. Temporary failures, quota of local
  // jobs, permission errors, and malformed resolver data must be retried fresh.
  for (const error of ['not-live', 'ambiguous', 'unavailable', 'permission', 'busy']) {
    const outcome = fixture(); let attempts = 0;
    outcome.FCM.resolveYouTubeChannel = async () => { attempts++; return { error, privateDetail: 'excluded' }; };
    const one = outcome.suggest(); await settle(); const two = outcome.suggest(); await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(one.replies)), [{ error }]);
    assert.deepEqual(JSON.parse(JSON.stringify(two.replies)), [{ error }]);
    assert.equal(attempts, ['not-live', 'ambiguous'].includes(error) ? 1 : 2);
  }
  for (const value of [null, undefined, {}, { videoId: 1 }, { videoId: 'bad' }, { error: 'private detail' }]) {
    const malformed = fixture(); let attempts = 0;
    malformed.FCM.resolveYouTubeChannel = async () => { attempts++; return value; };
    const one = malformed.suggest(); await settle(); const two = malformed.suggest(); await settle();
    assert.equal(one.replies[0].error, 'unavailable'); assert.equal(two.replies[0].error, 'unavailable');
    assert.equal(attempts, 2);
  }
  const clean = fixture();
  clean.FCM.resolveYouTubeChannel = async () => ({ videoId: VIDEO, privateDetail: 'excluded' });
  const cleaned = clean.suggest(); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(cleaned.replies)), [{ videoId: VIDEO }]);

  // Cache eviction bounds memory to 64 channels without a timer or persistence.
  const bounded = fixture();
  for (let index = 0; index < 64; index++) { bounded.suggest(`${CHANNEL}${index}`); await settle(); }
  assert.equal(bounded.calls.length, 64);
  bounded.suggest(`${CHANNEL}0`); await settle(); assert.equal(bounded.calls.length, 64);
  bounded.suggest(`${CHANNEL}64`); await settle(); assert.equal(bounded.calls.length, 65);
  bounded.suggest(`${CHANNEL}1`); await settle(); assert.equal(bounded.calls.length, 65);
  bounded.suggest(`${CHANNEL}0`); await settle(); assert.equal(bounded.calls.length, 66);

  // Automatic requests for one channel share work across tabs. The user's Add
  // lookup in that same tab has its own slot and always makes a fresh request.
  const coalesced = fixture(), waiting = [];
  coalesced.FCM.resolveYouTubeChannel = input => new Promise(resolve => waiting.push({ input, resolve }));
  const auto = coalesced.suggest(); const anotherTab = coalesced.suggest(CHANNEL, 2);
  const repeatedAuto = coalesced.suggest(`${CHANNEL}1`);
  const manual = coalesced.request(); await settle();
  assert.equal(waiting.length, 2); assert.equal(repeatedAuto.replies[0].error, 'busy');
  waiting[0].resolve({ videoId: VIDEO }); waiting[1].resolve({ videoId: 'OtherVideo1' }); await settle();
  assert.equal(auto.replies[0].videoId, VIDEO); assert.equal(anotherTab.replies[0].videoId, VIDEO);
  assert.equal(manual.replies[0].videoId, 'OtherVideo1');

  // The global bound counts public network jobs, not coalesced subscribers or
  // cached replies. A rejected fifth request does not poison later discovery.
  const limited = fixture(), active = [];
  limited.FCM.resolveYouTubeChannel = input => new Promise((resolve, reject) => active.push({ input, resolve, reject }));
  const running = [];
  for (let index = 1; index <= 4; index++) running.push(limited.suggest(`${CHANNEL}${index}`, index));
  await settle(); assert.equal(active.length, 4);
  const shared = limited.suggest(`${CHANNEL}1`, 5);
  const busyAuto = limited.suggest(`${CHANNEL}5`, 6);
  const busyManual = limited.request(); await settle();
  assert.equal(active.length, 4); assert.equal(busyAuto.replies[0].error, 'busy');
  assert.equal(busyManual.replies[0].error, 'busy');
  active[0].reject(Error('temporary lookup failure'));
  for (const job of active.slice(1)) job.resolve({ videoId: VIDEO });
  await settle();
  assert.equal(running[0].replies[0].error, 'unavailable'); assert.equal(shared.replies[0].error, 'unavailable');
  assert.ok(running.slice(1).every(job => job.replies[0].videoId === VIDEO));
  const recovered = limited.suggest(`${CHANNEL}1`, 1);
  const retryBusy = limited.suggest(`${CHANNEL}5`, 6); await settle();
  assert.equal(active.length, 6);
  active[4].resolve({ videoId: VIDEO }); active[5].resolve({ videoId: VIDEO }); await settle();
  assert.equal(recovered.replies[0].videoId, VIDEO); assert.equal(retryBusy.replies[0].videoId, VIDEO);

  // Synchronous resolver failures also release the job and per-tab guard.
  const throws = fixture();
  throws.FCM.resolveYouTubeChannel = () => { throw Error('failed before returning a promise'); };
  const failed = throws.suggest(); await settle(); assert.equal(failed.replies[0].error, 'unavailable');
  throws.FCM.resolveYouTubeChannel = async () => ({ videoId: VIDEO });
  const retried = throws.suggest(); await settle(); assert.equal(retried.replies[0].videoId, VIDEO);
  console.log('YouTube channel lookup relay boundaries passed.');
}
module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
