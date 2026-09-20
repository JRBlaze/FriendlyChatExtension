const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bootWorker } = require('./background');
const ROOT = path.resolve(__dirname, '..');

function load(extra = {}) {
  const context = vm.createContext({ console, ...extra });
  context.self = context;
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/util.js', 'src/background/updates.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  return context.FCM;
}

async function run() {
  // Browser update events activate downloaded packages; loading the module alone never reloads.
  for (const browser of ['chrome', 'firefox']) {
    let listener, reloads = 0;
    load({ chrome: { runtime: {
      getURL: () => browser === 'firefox' ? 'moz-extension://test/' : 'chrome-extension://test/',
      onUpdateAvailable: { addListener(fn) { listener = fn; } },
      reload() { reloads++; },
    } } });
    assert.equal(reloads, 0);
    assert.equal(typeof listener, 'function');
    listener({ version: '2.0.0' });
    assert.equal(reloads, 1);
  }
  load();
  load({ chrome: {} });
  load({ chrome: { runtime: {} } });
  load({ chrome: { runtime: { onUpdateAvailable: { addListener() { assert.fail('no reload API'); } } } } });

  const records = {};
  const listeners = new Set();
  const writes = [];
  let rejectGet = false, rejectSet = false, heldGet = null;
  const chrome = { storage: {
    local: {
      async get(key) {
        if (rejectGet) throw Error('unavailable');
        if (heldGet) return heldGet(key);
        return { [key]: records[key] };
      },
      async set(data) {
        if (rejectSet) throw Error('unavailable');
        writes.push(data);
        Object.assign(records, data);
        for (const fn of listeners) fn(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { newValue: v }])), 'local');
      },
      async remove(key) {
        if (rejectSet) throw Error('unavailable');
        delete records[key];
        for (const fn of listeners) fn({ [key]: {} }, 'local');
      },
    },
    onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
  } };
  const FCM = load({ chrome });
  let win = { screen: { width: 2560, height: 1440 }, devicePixelRatio: 1 };
  const key1440 = FCM.displayFontKey(win);
  assert.equal(key1440, 'fcm_display_font_v1_2560x1440');
  win.devicePixelRatio = 1.5;
  assert.equal(FCM.displayFontKey(win), key1440, 'zoom is not a profile identifier');
  for (const invalid of [undefined, {}, { screen: {} }, { screen: { width: 0, height: 1080 } }, { screen: { width: Infinity, height: 1080 } }, { screen: { width: '1920', height: 1080 } }]) {
    assert.equal(FCM.displayFontKey(invalid), '');
  }
  let changes = 0;
  const controller = FCM.createDisplayFont(() => win, () => { changes++; });
  assert.equal(controller.size(14), 14);
  await controller.refresh();
  assert.equal(controller.size(14), 14);
  await controller.set(18);
  assert.equal(controller.size(14), 18);
  assert.equal(records[key1440], 18);
  const before = changes;
  await controller.refresh();
  assert.equal(changes, before, 'unchanged monitor does not redraw');
  win = { screen: { width: 1920, height: 1080 } };
  await controller.refresh();
  assert.equal(controller.size(14), 14);
  await controller.set(12);
  assert.equal(controller.size(22), 12, 'global settings do not override a display choice');
  const key1080 = FCM.displayFontKey(win);
  assert.equal(records[key1440], 18);
  assert.equal(records[key1080], 12);
  win = { screen: { width: 2560, height: 1440 } };
  await controller.refresh();
  assert.equal(controller.size(14), 18);
  await controller.set(null);
  assert.equal(controller.size(16), 16);
  assert.equal(records[key1440], undefined);
  for (const bad of ['', NaN, Infinity, 9, 23, '18']) {
    assert.equal(await controller.set(bad), false);
  }
  for (const good of [10, 22, 14]) assert.equal(await controller.set(good), true);
  // Cross-tab changes and unrelated storage events.
  for (const fn of listeners) {
    fn({ [key1440]: { newValue: 20 } }, 'sync');
    fn({ other: { newValue: 20 } }, 'local');
  }
  assert.equal(controller.size(14), 14);
  for (const value of [20, 100, '19', undefined]) {
    for (const fn of listeners) fn({ [key1440]: { newValue: value } }, 'local');
    assert.equal(controller.size(14), value === 20 ? 20 : 14);
  }
  // Storage read races: the old screen must never repaint the new screen.
  let releaseRead;
  heldGet = key => new Promise(resolve => { releaseRead = () => resolve({ [key]: 21 }); });
  win = { screen: { width: 1280, height: 720 } };
  const pending = controller.refresh();
  heldGet = null;
  win = { screen: { width: 1920, height: 1080 } };
  await controller.refresh();
  releaseRead();
  await pending;
  assert.equal(controller.size(14), 12);
  // A choice made during a pending read wins, even if that read resolves later.
  heldGet = key => new Promise(resolve => { releaseRead = () => resolve({ [key]: 21 }); });
  win = { screen: { width: 1280, height: 720 } };
  const pendingChoice = controller.refresh();
  await controller.set(15);
  releaseRead();
  await pendingChoice;
  heldGet = null;
  assert.equal(controller.size(14), 15);
  rejectSet = true;
  assert.equal(await controller.set(17), false);
  assert.equal(await controller.set(null), false);
  rejectSet = false;
  rejectGet = true;
  win = { screen: { width: 1024, height: 768 } };
  await controller.refresh();
  assert.equal(controller.size(14), 14);
  rejectGet = false;
  await controller.refresh();
  win = {};
  await controller.refresh();
  assert.equal(await controller.set(18), false);
  assert.equal(controller.size(14), 14);
  // Independent windows can save different display records concurrently.
  const other = FCM.createDisplayFont(() => ({ screen: { width: 1920, height: 1080 } }), () => {});
  win = { screen: { width: 2560, height: 1440 } };
  await Promise.all([controller.set(18), other.set(12)]);
  assert.equal(records[key1440], 18);
  assert.equal(records[key1080], 12);
  assert.equal(controller.size(14), 18);
  assert.equal(other.size(14), 12);
  other.destroy();
  controller.destroy();
  assert.equal(listeners.size, 0);
  assert.equal(await controller.set(18), false);
  await controller.refresh();
  // Cleanup while a read is in flight must not invoke the view callback.
  heldGet = key => new Promise(resolve => { releaseRead = () => resolve({ [key]: 21 }); });
  win = { screen: { width: 2560, height: 1440 } };
  const late = FCM.createDisplayFont(() => win, () => { changes++; });
  const lateRead = late.refresh();
  late.destroy();
  const atDestroy = changes;
  releaseRead();
  await lateRead;
  assert.equal(changes, atDestroy);
  assert.ok(writes.length > 0);

  // Execute the actual overlay's view/binding functions with a small DOM fixture.
  const overlaySource = fs.readFileSync(path.join(ROOT, 'src/content/overlay.js'), 'utf8');
  const handlers = {}, resetHandlers = {}, errors = [], css = {};
  const input = { value: '', addEventListener(type, fn) { handlers[type] = fn; } };
  const reset = { addEventListener(type, fn) { resetHandlers[type] = fn; } };
  let chosen = null, accepted = true, getOwner;
  const ui = vm.createContext({
    FCM: { ...FCM, createDisplayFont(getWindow) {
      getOwner = getWindow;
      return { size(fallback) { return chosen === null ? fallback : chosen; }, async set(value) { if (accepted) chosen = value; return accepted; } };
    } },
    window: { screen: 'main' }, pipWindow: null,
    sheet: null, shadow: { activeElement: null }, settings: { fontSize: 14 },
    root: { style: { setProperty(k,v) { css[k] = v; }, getPropertyValue(k) { return css[k]; } } },
    feed: { resettle() {} }, toast(message) { errors.push(message); },
  });
  const first = overlaySource.indexOf('    const displayFont =');
  vm.runInContext(overlaySource.slice(first, overlaySource.indexOf('    /**', first)), ui);
  assert.equal(getOwner().screen, 'main');
  ui.pipWindow = { screen: 'popout' };
  assert.equal(getOwner().screen, 'popout');
  ui.applyDisplayFont();
  assert.equal(css['--fcm-size'], '14px');
  ui.sheet = { querySelector(selector) { return selector === '[data-display-font]' ? input : reset; } };
  chosen = 12;
  ui.applyDisplayFont();
  assert.equal(input.value, 12);
  ui.shadow.activeElement = input;
  chosen = 18;
  ui.applyDisplayFont();
  assert.equal(css['--fcm-size'], '18px');
  assert.equal(input.value, 12, 'an in-progress edit keeps its text');
  ui.shadow.activeElement = null;
  const binding = overlaySource.indexOf('      const fontInput =');
  vm.runInContext(overlaySource.slice(binding, overlaySource.indexOf('      /**', binding)), ui);
  handlers.blur();
  assert.equal(input.value, 18);
  input.value = '16';
  await handlers.change();
  assert.equal(chosen, 16);
  input.value = '';
  await handlers.change();
  assert.equal(chosen, null);
  accepted = false;
  input.value = '99';
  await handlers.change();
  assert.equal(errors.length, 1);
  await resetHandlers.click();
  assert.equal(errors.length, 2);
  accepted = true;
  chosen = 20;
  await resetHandlers.click();
  assert.equal(chosen, null);
  const optionsMarkup = fs.readFileSync(path.join(ROOT, 'src/options/options.html'), 'utf8');
  assert.match(optionsMarkup, /Default text size/);
  assert.match(optionsMarkup, /Use default there restores this value/);

  // The real worker imports the listener in both browser loading modes.
  for (const browser of ['chrome', 'firefox']) {
    const worker = bootWorker({ browser, loadPath: browser === 'firefox' ? 'scripts' : 'worker' });
    try {
      assert.equal(typeof worker.listeners.updateAvailable, 'function');
      assert.equal(worker.sandbox.chrome.runtime.reloadCount, 0);
      worker.listeners.updateAvailable({ version: '2.0.0' });
      assert.equal(worker.sandbox.chrome.runtime.reloadCount, 1);
    } finally { worker.teardown(); }
  }
  console.log('Update activation and per-display font tests passed.');
}
module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
