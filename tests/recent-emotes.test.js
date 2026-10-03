const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

function fixture(options = {}) {
  const writes = [], data = options.data || {}, listeners = new Set(), observers = new Set();
  function element() {
    const events = {};
    return { children: [], dataset: {}, style: {}, hidden: false, clientWidth: 340, value: '', selectionStart: 0, selectionEnd: 0,
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
  const sandbox = vm.createContext({ chrome, document: { createElement: element }, Event: class { constructor(type) { this.type = type; } }, console,
    ResizeObserver: options.noResizeObserver ? undefined : class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    } });
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
    changed(changes, area = 'local') { for (const listener of listeners) listener(changes, area); },
    observers, resize(width) { container.clientWidth = width; for (const observer of observers) observer.callback(); } };
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
  assert.equal(f.writes.length, 1);
  const key = platform => `${f.FCM.STORAGE_KEYS.recentEmotes}:${platform}`;
  assert.deepEqual(Object.keys(f.data).sort(), [key('kick'), key('order'), key('twitch')]);
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
  assert.equal(f.container.children.length, 8); assert.equal(f.data[key('kick')].length, 12);
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
  const mixed = fixture(); await mixed.api.ready;
  for (const platform of ['twitch', 'kick']) {
    for (let i = 0; i < 16; i++) mixed.FCM.view.emotes[platform].native['E' + i] = { url: 'https://example.test/e.png' };
  }
  await mixed.api.record('E0 E1 E2 E3 E4 E5', ['twitch']);
  await mixed.api.record('E6 E7 E8 E9 E10 E11', ['kick']);
  assert.deepEqual(mixed.container.children.map(b => b.title),
    ['E6 (Kick)', 'E7 (Kick)', 'E8 (Kick)', 'E9 (Kick)', 'E10 (Kick)', 'E11 (Kick)', 'E0 (Twitch)', 'E1 (Twitch)']);
  await mixed.api.record('E2', ['twitch']);
  assert.equal(mixed.container.children.length, 8);
  assert.equal(mixed.container.children[0].title, 'E2 (Twitch)', 'a newer Twitch use outranks Kick');
  await mixed.api.record('E2', ['kick']);
  assert.deepEqual(mixed.container.children.slice(0, 2).map(b => b.title), ['E2 (Kick)', 'E2 (Twitch)'],
    'identical names retain their separate platform identity');
  const revisit = fixture({ data: structuredClone(mixed.data) }); await revisit.api.ready;
  revisit.FCM.view.emotes = mixed.FCM.view.emotes; revisit.api.refresh();
  assert.deepEqual(revisit.container.children.map(b => b.title), mixed.container.children.map(b => b.title),
    'combined recency survives a fresh visit');
  revisit.platforms.splice(1, 1); revisit.api.refresh();
  assert.deepEqual(revisit.container.children.map(b => b.title),
    ['E2 (Twitch)', 'E0 (Twitch)', 'E1 (Twitch)', 'E3 (Twitch)', 'E4 (Twitch)', 'E5 (Twitch)']);
  revisit.platforms.push('kick');
  delete revisit.FCM.view.emotes.kick.native.E2; revisit.api.refresh();
  assert.equal(revisit.container.children.length, 8, 'unavailable emotes do not consume a slot');
  assert.equal(revisit.container.children[0].title, 'E2 (Twitch)');
  revisit.changed({ [key('order')]: { newValue: ['kick:E11', 'twitch:E0', 'kick:E11', null, 42,
    'youtube:E0', 'kick:', 'twitch:' + 'x'.repeat(101)] } });
  assert.deepEqual(revisit.container.children.slice(0, 2).map(b => b.title), ['E11 (Kick)', 'E0 (Twitch)']);
  revisit.changed({ [key('order')]: { newValue: {} } });
  assert.equal(revisit.container.children[0].title, 'E2 (Twitch)', 'legacy names remain usable without ordering metadata');
  revisit.changed({ [key('order')]: {} });
  await mixed.api.record(Array.from({ length: 16 }, (_, i) => 'E' + i).join(' '), ['twitch', 'kick']);
  assert.equal(mixed.data[key('order')].length, 24, 'ordering metadata is bounded');
  assert.equal(mixed.container.children.length, 8, 'both full histories still render at most eight total');
  const external = fixture({ data: mixed.data }); await external.api.ready;
  external.FCM.view.emotes = mixed.FCM.view.emotes; external.api.refresh();
  mixed.data[key('order')] = ['kick:E11', ...mixed.data[key('order')].filter(id => id !== 'kick:E11')];
  await external.api.record('E0', ['twitch']);
  assert.deepEqual(external.container.children.slice(0, 2).map(b => b.title), ['E0 (Twitch)', 'E11 (Kick)'],
    'a new write merges the latest order saved by another context');
  for (const [width, count] of [[1000, 8], [284, 8], [283, 7], [160, 4], [68, 2], [32, 1], [0, 1]]) {
    mixed.resize(width);
    assert.equal(mixed.container.children.length, count, `width ${width} shows ${count} emotes without exceeding eight`);
  }
  mixed.settings.showRecentEmotes = false; mixed.resize(340);
  assert.equal(mixed.container.hidden, true, 'resizing cannot reveal a disabled bar');
  mixed.settings.showRecentEmotes = true; mixed.api.refresh();
  assert.equal(mixed.container.children.length, 8, 'widening restores the newest eight');
  for (const item of [mixed, revisit, external]) item.api.destroy();
  assert.equal(mixed.observers.size, 0, 'teardown disconnects the width observer');
  const unsupported = fixture({ noResizeObserver: true }); await unsupported.api.ready;
  await unsupported.api.record('Kappa', ['twitch']);
  assert.equal(unsupported.container.children.length, 1); unsupported.api.destroy();
  const css = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
  const barStyle = css.match(/\.fcm-recent-emotes\s*\{([^}]+)\}/)[1];
  assert.doesNotMatch(barStyle, /flex-wrap:\s*wrap/, 'the recent bar stays on a single row');
  assert.doesNotMatch(barStyle, /overflow-x:\s*(auto|scroll)/, 'the recent bar does not create horizontal scrolling');
  console.log('Recent emote bar tests passed.');
}
module.exports = { run, fixture };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
