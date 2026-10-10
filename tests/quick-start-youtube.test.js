const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FILE = path.resolve(__dirname, '../src/setup/youtube-access.js');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function fixture(options = {}) {
  const reads = [], requests = [], busy = [], added = new Set(), removed = new Set();
  const button = { disabled: true, textContent: '', addEventListener(type, handler) { this[type] = handler; } };
  const status = { textContent: '' };
  const state = { granted: !!options.granted, busy: false, outcome: 'allow' };
  const event = listeners => ({ addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) });
  const chrome = { permissions: {
    async contains(permission) { reads.push(permission); if (options.read) return options.read(); if (options.readError) throw Error('fixture read'); return state.granted; },
    async request(permission) {
      requests.push(permission);
      if (options.request) return options.request();
      if (state.outcome === 'error') throw Error('fixture permission');
      state.granted = state.outcome === 'allow'; return state.granted;
    },
    onAdded: event(added), onRemoved: event(removed),
  } };
  const sandbox = vm.createContext({ chrome, FCM: {} }); sandbox.self = sandbox;
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), sandbox, { filename: FILE });
  const api = sandbox.FCM.createQuickStartYouTubeAccess({ button, status, isBusy: () => state.busy,
    onBusy(value) { busy.push(value); state.busy = value; } });
  return { api, button, status, state, reads, requests, busy, added, removed, options,
    click: trusted => button.click({ isTrusted: trusted !== false }), change: () => [...added, ...removed].forEach(fn => fn({ origins: ['https://www.youtube.com/*'] })) };
}

async function run() {
  const f = fixture(); await flush();
  assert.equal(f.requests.length, 0, 'guide opening never asks for permission');
  assert.equal(f.button.textContent, 'Allow YouTube access');
  await f.click(false); assert.equal(f.requests.length, 0);
  await f.click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests)), [{ origins: ['https://www.youtube.com/*'] }]);
  assert.equal(f.button.disabled, true);
  assert.equal(f.button.textContent, 'YouTube access allowed');
  assert.match(f.status.textContent, /ready/i);
  assert.deepEqual(f.busy, [true, false]);
  await f.click(); assert.equal(f.requests.length, 1, 'existing access never opens another prompt');
  f.state.granted = false; f.change(); await flush();
  assert.equal(f.button.disabled, false, 'revoked permission is reflected');
  f.state.busy = true; f.api.render(); assert.equal(f.button.disabled, true);
  await f.click(); assert.equal(f.requests.length, 1, 'OAuth and permission prompts cannot overlap');
  f.state.busy = false;
  for (const outcome of ['deny', 'error']) {
    f.state.outcome = outcome; await f.click();
    assert.equal(f.button.disabled, false);
    assert.match(f.status.textContent, outcome === 'deny' ? /not granted/ : /could not grant/);
  }
  const granted = fixture({ granted: true }); await flush();
  assert.equal(granted.button.disabled, true); assert.equal(granted.requests.length, 0);
  const broken = fixture({ readError: true }); await flush();
  assert.match(broken.status.textContent, /Unable to check/);
  await broken.click(); assert.equal(broken.button.disabled, true, 'the explicit allow action can recover a failed status check');
  f.api.destroy(); assert.equal(f.added.size, 0); assert.equal(f.removed.size, 0);
  await f.api.refresh(); await f.click();

  let release;
  const waiting = fixture({ request: () => new Promise(resolve => { release = resolve; }) }); await flush();
  const prompt = waiting.click(); await flush();
  assert.equal(waiting.button.disabled, true);
  assert.equal(waiting.requests.length, 1);
  await waiting.click();
  waiting.state.granted = true; waiting.change();
  await waiting.api.refresh();
  release(true); await prompt; await flush();
  assert.equal(waiting.requests.length, 1, 'permission changes never trigger a second prompt');
  assert.equal(waiting.reads.length, 2, 'a change during the prompt schedules one status refresh');
  assert.equal(waiting.button.textContent, 'YouTube access allowed');

  for (const outcome of ['allow', 'error']) {
    let resolve, reject;
    const late = fixture({ request: () => new Promise((yes, no) => { resolve = yes; reject = no; }) }); await flush();
    const request = late.click(); await flush();
    late.api.destroy(); const before = late.status.textContent;
    if (outcome === 'allow') resolve(true); else reject(Error('fixture late request'));
    await request;
    assert.equal(late.status.textContent, before, 'closed guide ignores permission results');
    assert.deepEqual(late.busy, [true], 'closed guide does not repaint its navigation');
  }
  const reads = [];
  const race = fixture({ read: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) });
  const second = race.api.refresh();
  reads[1].resolve(true); await second;
  reads[0].resolve(false); await flush();
  assert.equal(race.button.disabled, true, 'a stale permission read cannot overwrite a new grant');
  race.api.refresh(); const latest = race.api.refresh();
  reads[2].reject(Error('fixture stale read')); reads[3].resolve(false); await latest; await flush();
  assert.equal(race.button.disabled, false);

  for (const outcome of ['allow', 'error']) {
    let release;
    const pendingReads = [];
    const active = fixture({ read: () => new Promise((resolve, reject) => pendingReads.push({ resolve, reject })),
      request: () => new Promise(resolve => { release = resolve; }) });
    pendingReads[0].resolve(false); await flush();
    const read = active.api.refresh(); const request = active.click(); await flush();
    if (outcome === 'allow') pendingReads[1].resolve(true); else pendingReads[1].reject(Error('fixture pending read'));
    await read;
    release(false); await request;
    assert.match(active.status.textContent, /not granted/, 'a read started before a prompt cannot overwrite its result');
  }
  for (const outcome of ['allow', 'error']) {
    let resolve, reject;
    const closed = fixture({ read: () => new Promise((yes, no) => { resolve = yes; reject = no; }) });
    closed.api.destroy(); const before = closed.status.textContent;
    if (outcome === 'allow') resolve(true); else reject(Error('fixture closed read'));
    await flush();
    assert.equal(closed.status.textContent, before);
  }
  console.log('Quick-start optional YouTube access tests passed.');
}
module.exports = { run, fixture, flush };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
