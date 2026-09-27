const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const VIDEO = 'AbCdEfGhI_0';
const CHANNEL = 'https://www.youtube.com/@fixture';
const copy = value => JSON.parse(JSON.stringify(value));
async function settle() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

function fixture(options = {}) {
  const requests = [], updates = [], timers = new Map();
  let sequence = 0;
  const doc = { marker: 'original-host-document' };
  const state = { page: 'fixture', hints: [], answer: async () => ({ videoId: VIDEO }), ...options };
  const site = { id: 'twitch', channelFromUrl: () => state.page,
    youtubeHints(owner) { assert.equal(owner, doc); return state.hints; }, ...options.site };
  const context = { FCM: {}, URL, Map, Set,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: { runtime: { async sendMessage(message) {
      assert.equal(message.cmd, 'youtubeSuggest'); requests.push(copy(message)); return state.answer(message);
    } } },
  };
  context.self = context;
  vm.createContext(context);
  for (const name of ['src/shared/youtube.js', 'src/content/youtube-suggestions.js']) {
    const file = path.join(ROOT, name);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  const api = context.FCM.createYouTubeSuggestions({ site,
    channel: Object.hasOwn(options, 'channel') ? options.channel : 'fixture', document: doc,
    onSuggestions(value) { updates.push(copy(value)); if (state.onUpdate) state.onUpdate(value); } });
  async function fire(delay) {
    const item = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(item, 'scheduled scan exists'); timers.delete(item[0]); item[1].fn(); await settle();
  }
  return { api, site, state, requests, updates, timers, fire, latest: () => updates.at(-1) };
}

async function run() {
  {
    const f = fixture();
    assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [1500, 4000, 9000]);
    f.api.updateCounterpart({ exists: true, channel: 'other' });
    assert.equal(f.requests.length, 0, 'initial mount and counterpart update do not scan stale DOM');
    assert.equal(f.updates.length, 0);
    await f.fire(1500);
    assert.deepEqual(f.requests.map(r => r.channelUrl), [CHANNEL, 'https://www.youtube.com/@other']);
    assert.deepEqual(f.latest(), [
      { channelUrl: CHANNEL, videoId: VIDEO, match: 'same-name', label: '@fixture' },
      { channelUrl: 'https://www.youtube.com/@other', videoId: VIDEO, match: 'same-name', label: '@other' },
    ]);
    await f.fire(4000); await f.fire(9000);
    assert.equal(f.requests.length, 2, 'answered candidates are reused within a visit');
    f.api.updateCounterpart({ exists: true, channel: 'FIXTURE' }); await settle();
    assert.equal(f.latest().length, 1, 'case-only handle duplicates collapse');
    f.api.updateCounterpart({ exists: false, channel: 'absent' }); await settle();
    f.api.updateCounterpart({ exists: true, channel: null }); await settle();
    f.api.updateCounterpart({ exists: true, channel: 'invalid/name' }); await settle();
    assert.equal(f.requests.length, 2);
    f.api.destroy(); f.api.destroy();
  }
  {
    const f = fixture({ site: { id: 'kick' }, hints: [
      'https://youtube.com/@Linked/live', 'https://www.youtube.com/@linked',
      'https://www.youtube.com/@日本語/streams', 'https://www.youtube.com/channel/UC' + 'A'.repeat(22),
      'https://www.youtube.com/@IgnoredFourth',
    ] });
    await f.fire(1500);
    assert.equal(f.requests.length, 3, 'only three distinct page links are checked');
    assert.ok(f.latest().every(item => item.match === 'page-link'));
    assert.deepEqual(f.latest().map(item => item.label), ['@Linked', '@日本語', 'channel/UC' + 'A'.repeat(22)]);
    assert.equal(f.requests.some(item => item.channelUrl === CHANNEL), false, 'page links suppress same-name probing');
    f.state.hints = ['https://www.youtube.com/channel/UC' + 'a'.repeat(22)];
    await f.fire(4000);
    assert.equal(f.requests.length, 4, 'channel IDs retain case-sensitive identity');
    f.api.destroy();
  }
  {
    const f = fixture({ hints: [null, {}, 'javascript:alert(1)', 'https://youtube.com.evil.test/@fake',
      'https://youtu.be/' + VIDEO, 'https://www.youtube.com/watch?v=' + VIDEO, 'https://www.youtube.com/live_chat?v=' + VIDEO] });
    await f.fire(1500);
    assert.deepEqual(f.requests.map(item => item.channelUrl), [CHANNEL], 'only channel URLs can identify suggestions');
    f.state.hints = 'not an array'; await f.fire(4000);
    f.site.youtubeHints = () => { throw Error('page not ready'); }; await f.fire(9000);
    assert.equal(f.requests.length, 1);
    f.api.destroy();
    const bounded = fixture({ hints: [...Array(40).fill('invalid'), 'https://www.youtube.com/@beyondBound'] });
    await bounded.fire(1500); assert.equal(bounded.requests[0].channelUrl, CHANNEL); bounded.api.destroy();
  }
  for (const options of [
    { site: { id: 'youtube' } }, { channel: null }, { channel: '' }, { page: 'another' },
    { site: { channelFromUrl() { throw Error('no context'); } } },
  ]) {
    const f = fixture(options); await f.fire(1500);
    assert.equal(f.requests.length, 0); assert.deepEqual(f.latest(), []); f.api.destroy();
  }
  for (const answer of [null, {}, { error: 'permission' }, { error: 'busy' }, { videoId: 123 }, { videoId: 'invalid' }]) {
    const f = fixture({ answer: async () => answer }); await f.fire(1500);
    assert.deepEqual(f.latest(), []); assert.equal(f.requests.length, 1); f.api.destroy();
  }
  {
    const f = fixture({ answer: async () => { throw Error('worker restarted'); } });
    await f.fire(1500); assert.deepEqual(f.latest(), []); f.api.destroy();
  }
  {
    const f = fixture();
    for (let scan = 0; scan < 3; scan++) {
      f.state.hints = Array.from({ length: 3 }, (_, n) => 'https://www.youtube.com/@page' + (scan * 3 + n));
      await f.fire([1500, 4000, 9000][scan]);
    }
    assert.equal(f.requests.length, 6, 'a visit has a six-candidate query budget');
    assert.deepEqual(f.latest(), []);
    f.api.refresh(); await settle();
    assert.equal(f.requests.length, 9, 'explicit refresh starts a fresh bounded lookup pass');
    assert.equal(f.latest().length, 3); f.api.destroy();
  }
  {
    let resolve;
    const f = fixture({ answer: () => new Promise(r => { resolve = r; }) });
    await f.fire(1500);
    f.state.hints = ['https://www.youtube.com/@stronger'];
    await f.fire(4000);
    assert.equal(f.requests.length, 1, 'metadata requests remain sequential');
    const oldResolve = resolve;
    f.state.answer = async () => ({ videoId: 'AbCdEfGhI_1' });
    oldResolve({ videoId: VIDEO }); await settle();
    assert.deepEqual(f.latest(), [{ channelUrl: 'https://www.youtube.com/@stronger', videoId: 'AbCdEfGhI_1', match: 'page-link', label: '@stronger' }]);
    assert.equal(f.updates.some(items => items.some(item => item.channelUrl === CHANNEL)), false,
      'a pending weaker guess never appears after a page link supersedes it');
    f.api.destroy();
  }
  {
    let resolve;
    const f = fixture({ answer: () => new Promise(r => { resolve = r; }) });
    await f.fire(1500); f.api.pause();
    const updateCount = f.updates.length;
    assert.equal(f.timers.size, 0);
    f.api.updateCounterpart({ exists: true, channel: 'afterPause' });
    resolve({ videoId: VIDEO }); await settle();
    assert.equal(f.updates.length, updateCount, 'pause discards late metadata and counterpart updates');
    assert.equal(f.requests.length, 1);
    f.state.answer = async () => ({ videoId: VIDEO });
    f.api.refresh(); await settle();
    assert.equal(f.requests.length, 3, 'explicit refresh can resume a paused visit');
    f.api.destroy(); f.api.refresh(); f.api.updateCounterpart(null);
    assert.equal(f.timers.size, 0);
  }
  {
    let resolve;
    const f = fixture({ answer: () => new Promise(r => { resolve = r; }) });
    await f.fire(1500); f.api.refresh();
    assert.equal(f.requests.length, 1, 'refresh waits for the old request rather than adding concurrency');
    f.state.answer = async () => ({ videoId: 'AbCdEfGhI_1' });
    resolve({ videoId: VIDEO }); await settle();
    assert.equal(f.requests.length, 2);
    assert.equal(f.latest()[0].videoId, 'AbCdEfGhI_1', 'refresh discards the prior generation result');
    f.api.destroy();
  }
  for (const action of ['destroy', 'navigate']) {
    let resolve;
    const f = fixture({ answer: () => new Promise(r => { resolve = r; }) });
    await f.fire(1500);
    if (action === 'destroy') f.api.destroy(); else f.state.page = 'different';
    const updateCount = f.updates.length;
    resolve({ videoId: VIDEO }); await settle();
    assert.equal(f.updates.length, updateCount, 'late results cannot cross an overlay lifecycle');
    if (action === 'navigate') { await f.fire(4000); assert.deepEqual(f.latest(), []); f.api.destroy(); }
  }
  {
    const f = fixture({ onUpdate() { f.state.page = 'different'; } });
    await f.fire(1500); assert.equal(f.requests.length, 0, 'context is checked again before dispatch'); f.api.destroy();
  }
  console.log('YouTube live suggestion tests passed.');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
