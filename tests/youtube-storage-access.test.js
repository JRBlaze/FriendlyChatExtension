const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FILE = path.resolve(__dirname, '../src/content/youtube-access.js');
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function element(tag) {
  return { tag, children: [], style: {}, attrs: {}, listeners: {}, removed: false,
    setAttribute(k, v) { this.attrs[k] = v; }, append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); }, remove() { this.removed = true; }, focus() { this.focused = true; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    fire(k, values = {}) { return this.listeners[k]?.({ isTrusted: true, ...values }); },
  };
}
function fixture(options = {}) {
  const state = { states: [], reloads: 0, closes: 0, requests: 0, current: true, calls: [], elements: [] };
  const document = { body: element('body'), documentElement: element('html'),
    createElement(tag) { const node = element(tag); state.elements.push(node); return node; },
    hasStorageAccess: async () => false,
    requestStorageAccess() { state.requests++; state.calls.push('request'); return Promise.resolve(); },
  };
  const context = vm.createContext({ FCM: {}, Promise }); context.self = context;
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), context, { filename: FILE });
  if (options.setup) options.setup(document, state);
  state.document = document;
  state.api = context.FCM.createYouTubeAccess({ document,
    onState(value) { state.states.push(value); }, onReload() { state.reloads++; }, onClose() { state.closes++; },
    canRestore() { return state.restore !== false; },
    isCurrent() { if (state.throwCurrent) throw Error('gone'); return state.current; },
  });
  state.last = () => state.states.at(-1);
  state.button = () => state.elements.findLast(item => item.tag === 'button' && item.textContent !== 'Cancel');
  state.cancel = () => state.elements.findLast(item => item.textContent === 'Cancel');
  state.panel = () => state.elements.findLast(item => item.attrs.role === 'dialog');
  return state;
}
async function run() {
  for (const answer of [false, true, 'unknown']) {
    const f = fixture({ setup: d => { d.hasStorageAccess = async () => answer; } }); await settle();
    assert.equal(f.last(), answer === false ? 'needed' : answer === true ? 'granted' : 'unknown');
    assert.equal(f.requests, 0, 'inspection never requests permission');
  }
  for (const key of ['hasStorageAccess', 'requestStorageAccess']) {
    const f = fixture({ setup: d => { d[key] = undefined; } }); await settle();
    assert.equal(f.last(), 'unsupported'); assert.equal(f.api.open(), false);
  }
  const error = fixture({ setup: d => { d.hasStorageAccess = async () => { throw Error('blocked'); }; } });
  await settle(); assert.equal(error.last(), 'error');
  const f = fixture(); await settle(); assert.equal(f.api.open(), true); assert.equal(f.api.open(), true);
  assert.equal(f.document.body.children.length, 1, 'reopening reuses the one setup panel');
  assert.equal(f.button().focused, true);
  await f.button().fire('click', { isTrusted: false }); assert.equal(f.requests, 0);
  const sent = f.button().fire('click');
  assert.equal(f.requests, 1, 'request occurs synchronously inside the trusted handler');
  assert.equal(f.last(), 'requesting'); assert.equal(f.button().disabled, true);
  await f.button().fire('click'); assert.equal(f.requests, 1, 'pending grants are never repeated');
  await sent; assert.equal(f.last(), 'granted'); assert.equal(f.reloads, 1);
  f.api.close(); assert.equal(f.panel().removed, true); f.api.close();
  for (const name of ['NotAllowedError', 'SecurityError', undefined]) {
    const denied = fixture({ setup: d => { d.requestStorageAccess = () => Promise.reject(name ? { name } : null); } });
    await settle(); denied.api.open(); await denied.button().fire('click');
    assert.equal(denied.last(), name === 'NotAllowedError' ? 'denied' : 'error');
    assert.equal(denied.reloads, 0); assert.equal(denied.button().disabled, false);
    await denied.cancel().fire('click', { isTrusted: false }); assert.equal(denied.closes, 0);
    await denied.cancel().fire('click'); assert.equal(denied.closes, 1); assert.equal(denied.panel().removed, true);
  }
  const sync = fixture({ setup: d => { d.requestStorageAccess = () => { throw { name: 'NotAllowedError' }; }; } });
  await settle(); sync.api.open(); await sync.button().fire('click'); assert.equal(sync.last(), 'denied');
  const keyboard = fixture(); await settle(); keyboard.api.open();
  keyboard.panel().fire('keydown', { key: 'Enter' }); keyboard.panel().fire('keydown', { key: 'Escape', isTrusted: false });
  assert.equal(keyboard.closes, 0); keyboard.panel().fire('keydown', { key: 'Escape' }); assert.equal(keyboard.closes, 1);
  const bodyless = fixture({ setup: d => { d.body = null; } }); await settle(); bodyless.api.open();
  assert.equal(bodyless.document.documentElement.children.length, 1); bodyless.api.destroy();
  for (const reject of [false, true]) for (const action of ['close', 'reopen', 'destroy', 'current', 'throwCurrent']) {
    let resolve; const pending = fixture({ setup: d => { d.requestStorageAccess = () => new Promise((r, j) => { resolve = reject ? j : r; }); } });
    await settle(); pending.api.open(); const button = pending.button(); const promise = button.fire('click');
    if (action === 'current') pending.current = false;
    else if (action === 'throwCurrent') pending.throwCurrent = true;
    else if (action === 'reopen') { pending.api.close(); pending.api.open(); }
    else pending.api[action]();
    resolve(); await promise; assert.equal(pending.reloads, 0, 'late grants cannot revive closed or stale setup');
    if (action !== 'reopen') { await button.fire('click'); assert.equal(pending.reloads, 0); }
    pending.api.destroy(); pending.api.destroy(); assert.equal(pending.api.open(), false);
  }
  for (const reject of [false, true]) {
    let finish; const stale = fixture({ setup: d => { d.hasStorageAccess = () => new Promise((r, j) => { finish = reject ? j : r; }); } });
    stale.api.destroy(); finish(false); await settle(); assert.equal(stale.states.length, 0);
  }
  let complete;
  const racing = fixture({ setup: d => { d.hasStorageAccess = () => new Promise(r => { complete = r; }); } });
  racing.api.open(); await racing.button().fire('click'); complete(false); await settle();
  assert.equal(racing.last(), 'granted', 'late initial inspection cannot replace the granted state');
  const offline = fixture({ setup: (d, s) => { s.current = false; } }); await settle();
  assert.equal(offline.api.open(), false); assert.equal(offline.states.length, 0);
  const cancelStale = fixture(); await settle(); cancelStale.api.open();
  const oldCancel = cancelStale.cancel(); cancelStale.current = false; oldCancel.fire('click');
  cancelStale.current = true; cancelStale.api.close(); oldCancel.fire('click'); assert.equal(cancelStale.closes, 0);
  for (const permission of ['granted', 'prompt', 'denied', null]) {
    const saved = fixture({ setup: d => { d.defaultView = { navigator: { permissions: {
      async query(value) { assert.equal(value.name, 'storage-access'); return permission && { state: permission }; },
    } } }; } }); await settle();
    assert.equal(saved.requests, permission === 'granted' ? 1 : 0, 'only an existing browser grant can be activated without a click');
    assert.equal(saved.reloads, permission === 'granted' ? 1 : 0);
    assert.equal(saved.last(), permission === 'granted' ? 'granted' : 'needed');
  }
  const makeRestore = setup => fixture({ setup(d, s) {
    d.defaultView = { navigator: { permissions: { query: async () => ({ state: 'granted' }) } } };
    setup(d, s);
  } });
  const loggedIn = makeRestore((d, s) => { s.restore = false; }); await settle(); assert.equal(loggedIn.requests, 0);
  const queryError = makeRestore(d => { d.defaultView.navigator.permissions.query = async () => { throw Error('unsupported'); }; });
  await settle(); assert.equal(queryError.last(), 'needed'); assert.equal(queryError.requests, 0);
  const restoreError = makeRestore(d => { d.requestStorageAccess = async () => { throw Error('revoked'); }; });
  await settle(); assert.equal(restoreError.last(), 'needed'); assert.equal(restoreError.reloads, 0);
  for (const action of ['destroy', 'login', 'request']) {
    let finish; const oldQuery = makeRestore(d => { d.defaultView.navigator.permissions.query = () => new Promise(r => { finish = r; }); });
    await settle();
    if (action === 'destroy') oldQuery.api.destroy();
    else if (action === 'login') oldQuery.restore = false;
    else { oldQuery.api.open(); await oldQuery.button().fire('click'); }
    finish({ state: 'granted' }); await settle();
    assert.equal(oldQuery.requests, action === 'request' ? 1 : 0, 'stale grant queries do not switch accounts or repeat an explicit request');
  }
  let restoreFinish;
  const oldRestore = makeRestore(d => { d.requestStorageAccess = () => new Promise(r => { restoreFinish = r; }); });
  await settle(); oldRestore.api.destroy(); restoreFinish(); await settle(); assert.equal(oldRestore.reloads, 0);
  console.log('YouTube storage access tests passed.');
}
module.exports = { run, fixture };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
