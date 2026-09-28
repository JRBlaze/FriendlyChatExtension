const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

function fixture(options = {}) {
  const writes = [], data = options.data || {}, listeners = new Set();
  function element() {
    const events = {};
    return { children: [], dataset: {}, style: {}, hidden: false, value: '', selectionStart: 0, selectionEnd: 0,
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children; },
      setAttribute(key, value) { this[key] = value; },
      addEventListener(type, handler) { events[type] = handler; },
      fire(type, extra = {}) { return events[type]?.({ preventDefault() {}, ...extra }); },
      dispatchEvent(event) { this.lastEvent = event.type; }, focus() { this.focused = true; },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    };
  }
  const chrome = { storage: { local: {
    async get() { if (options.onRead) options.onRead(); if (options.getError) throw Error('unavailable'); return structuredClone(data); },
    async set(patch) { if (options.setError) throw Error('full'); writes.push(patch); Object.assign(data, structuredClone(patch)); },
  }, onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } } } };
  const sandbox = vm.createContext({ chrome, document: { createElement: element }, Event: class { constructor(type) { this.type = type; } }, console });
  sandbox.self = sandbox;
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/content/compose.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: path.join(ROOT, file) });
  }
  const FCM = sandbox.FCM, settings = { ...FCM.DEFAULT_SETTINGS }, platforms = ['twitch', 'kick'];
  FCM.view = { emotes: { twitch: { native: { Kappa: { url: 'https://example.test/tw.png' } }, thirdparty: {} },
    kick: { native: { Kappa: { url: 'https://example.test/ki.png' }, KEKW: { url: 'https://example.test/kekw.png' } }, thirdparty: {} } } };
  const container = element(), inputEl = element(), toasts = [];
  const api = FCM.createRecentEmotes({ container, inputEl, getSettings: () => settings,
    getPlatforms: () => platforms, toast: text => toasts.push(text) });
  return { FCM, api, container, inputEl, settings, platforms, writes, data, listeners, toasts,
    changed(changes, area = 'local') { for (const listener of listeners) listener(changes, area); } };
}

async function run() {
  const f = fixture(); await f.api.ready;
  assert.equal(f.settings.showRecentEmotes, true);
  assert.equal(f.container.hidden, true);
  await f.api.record('hello unknown Kappa KEKW Kappa', ['twitch', 'kick']);
  assert.equal(f.container.hidden, false);
  assert.deepEqual(f.container.children.map(b => b.title), ['Kappa (Twitch)', 'Kappa (Kick)', 'KEKW (Kick)']);
  assert.equal(f.container.children[0].children[0].src, 'https://example.test/tw.png');
  assert.equal(f.container.children[1].children[0].src, 'https://example.test/ki.png');
  assert.equal(f.writes.length, 2);
  const key = platform => `${f.FCM.STORAGE_KEYS.recentEmotes}:${platform}`;
  assert.deepEqual(Object.keys(f.data).sort(), [key('kick'), key('twitch')]);
  assert.ok(JSON.stringify(f.data).includes('Kappa'));
  assert.ok(!JSON.stringify(f.data).includes('hello'), 'only known emote names are stored');
  f.inputEl.value = 'hello old suffix'; f.inputEl.selectionStart = 6; f.inputEl.selectionEnd = 9;
  let prevented = false;
  f.container.children[0].fire('mousedown', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  f.container.children[0].fire('click');
  assert.equal(f.inputEl.value, 'hello Kappa  suffix');
  assert.equal(f.inputEl.selectionStart, 12); assert.equal(f.inputEl.focused, true);
  assert.equal(f.inputEl.lastEvent, 'input');
  f.inputEl.value = 'gg'; f.inputEl.selectionStart = f.inputEl.selectionEnd = 2;
  f.container.children[0].fire('click'); assert.equal(f.inputEl.value, 'gg Kappa ');
  f.inputEl.value = ''; f.inputEl.selectionStart = f.inputEl.selectionEnd = 0;
  f.container.children[0].fire('click'); assert.equal(f.inputEl.value, 'Kappa ');
  f.inputEl.value = 'x'.repeat(478); f.inputEl.selectionStart = f.inputEl.selectionEnd = 478;
  f.container.children[0].fire('click'); assert.equal(f.inputEl.value.length, 478); assert.equal(f.toasts.length, 1);
  const stale = f.container.children[0];
  f.settings.showRecentEmotes = false; f.api.refresh(); assert.equal(f.container.hidden, true);
  stale.fire('click'); assert.equal(f.inputEl.value.length, 478);
  await f.api.record('KEKW', ['kick']);
  f.settings.showRecentEmotes = true; f.api.refresh(); assert.equal(f.container.hidden, false);
  f.platforms.splice(0, 1); f.api.refresh();
  assert.deepEqual(f.container.children.map(b => b.title), ['KEKW (Kick)', 'Kappa (Kick)']);
  const reload = fixture({ data: f.data }); await reload.api.ready;
  assert.equal(reload.container.children.length, 3, 'recents survive a fresh visit');
  delete reload.FCM.view.emotes.kick.native.KEKW; reload.api.refresh();
  assert.equal(reload.container.children.length, 2, 'unavailable emotes are hidden');
  const old = reload.container.children[1]; delete reload.FCM.view.emotes.kick.native.Kappa;
  old.fire('click'); assert.equal(reload.inputEl.value, '', 'stale buttons cannot insert unavailable emotes');
  const before = f.writes.length;
  await f.api.record('unknown', ['youtube']); await f.api.record('unknown', ['kick']);
  assert.equal(f.writes.length, before);
  f.changed({ [key('kick')]: { newValue: ['Kappa', 'Kappa', '', 42, '__proto__', 'unknown'] } });
  assert.deepEqual(f.container.children.map(b => b.title), ['Kappa (Kick)']);
  f.changed({ [key('kick')]: { newValue: [] } }, 'sync');
  assert.equal(f.container.children.length, 1);
  f.changed({ unrelated: { newValue: [] } }); assert.equal(f.container.children.length, 1);
  f.changed({ [key('kick')]: {} }); assert.equal(f.container.hidden, true);
  f.changed({ [key('kick')]: { newValue: {} } }); assert.equal(f.container.hidden, true);
  for (let i = 0; i < 16; i++) f.FCM.view.emotes.kick.thirdparty['E' + i] = { url: 'https://example.test/e.png' };
  await f.api.record(Array.from({ length: 16 }, (_, i) => 'E' + i).join(' '), ['kick']);
  assert.equal(f.container.children.length, 12); assert.equal(f.data[key('kick')].length, 12);
  await f.api.record('E0', ['kick']); assert.equal(f.container.children[0].title, 'E0 (Kick)');
  await Promise.all([f.api.record('E1', ['kick']), f.api.record('E2', ['kick'])]);
  assert.deepEqual(f.data[key('kick')].slice(0, 2), ['E2', 'E1']);
  f.api.destroy(); stale.fire('click'); await f.api.record('Kappa', ['twitch']); f.api.refresh();
  assert.equal(f.container.hidden, true); assert.equal(f.listeners.size, 0);
  for (const options of [{ getError: true }, { setError: true }]) {
    const broken = fixture(options); await broken.api.ready; await broken.api.record('Kappa', ['twitch']);
    assert.equal(broken.container.children.length, 1, 'storage errors retain useful in-memory recents'); broken.api.destroy();
  }
  const missing = fixture(); await missing.api.ready;
  delete missing.FCM.view.emotes.twitch;
  await missing.api.record('Kappa', ['twitch']);
  assert.equal(missing.container.hidden, true);
  const lateOptions = {}, late = fixture(lateOptions); await late.api.ready;
  lateOptions.onRead = () => late.api.destroy();
  await late.api.record('Kappa', ['twitch']);
  assert.equal(late.writes.length, 0, 'teardown during a storage read cannot write later');
  const early = fixture(); early.api.destroy(); await early.api.ready;
  assert.equal(early.container.hidden, true);
  console.log('Recent emote bar tests passed.');
}
module.exports = { run, fixture };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
