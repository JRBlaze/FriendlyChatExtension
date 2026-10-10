const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pack = require('../tools/pack');
const { bootWorker } = require('./background');
const ROOT = path.resolve(__dirname, '..');
const FILE = 'src/background/youtube-onboarding.js';
const KEY = 'fcm_youtube_onboarding_v1';
const clean = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const store = options.store || {}, operations = [], tabs = [], listeners = [];
  const state = { error: options.error || '', version: options.version || '1.23.0' };
  const origin = options.browser === 'firefox' ? 'moz-extension://fixture/' : 'chrome-extension://fixture/';
  function fail(stage) { if (state.error === stage) throw Error(`Fixture ${stage} failure`); }
  const chrome = {
    runtime: {
      getURL(file) { fail('url'); return origin + file; },
      getManifest() { fail('manifest'); return { version: state.version }; },
      onInstalled: { addListener(listener) { listeners.push(listener); } },
    },
    storage: { local: {
      async get(key) { operations.push('read'); assert.equal(key, KEY); fail('read'); return { ...store }; },
      async set(patch) { operations.push('write'); fail('write'); Object.assign(store, clean(patch)); },
    }, sync: { set() { assert.fail('Onboarding must not write sync storage'); } } },
    tabs: { async create(info) { operations.push('tab'); fail('tab'); tabs.push(clean(info)); } },
    permissions: { request() { assert.fail('The background must never request YouTube permission'); } },
  };
  const context = vm.createContext({ chrome, URL, fetch() { assert.fail('Onboarding must not fetch'); } });
  context.self = context;
  function load(file) {
    const filename = path.join(ROOT, file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/util.js', 'src/background/updates.js']) load(file);
  if (options.api === 'none') delete context.chrome;
  if (options.api === 'runtime') delete chrome.runtime;
  if (options.api === 'event') delete chrome.runtime.onInstalled;
  load(FILE);
  return { store, operations, tabs, listeners, context, state, origin,
    fire: details => listeners[0](details), load };
}

async function run() {
  for (const api of ['none', 'runtime', 'event']) {
    const f = fixture({ api });
    assert.equal(f.listeners.length, 0, `Missing ${api} API does not break background loading`);
    assert.deepEqual(f.operations, []);
  }
  for (const browser of ['chrome', 'firefox']) {
    const f = fixture({ browser });
    assert.equal(f.listeners.length, 1, 'Installation listener is registered synchronously');
    await Promise.resolve();
    assert.deepEqual(f.operations, [], 'Ordinary background startup has no onboarding storage or tab activity');
    for (const details of [undefined, null, {}, { reason: 'chrome_update' }, { reason: 'shared_module_update' },
      { reason: 'startup' }, { reason: 'https://evil.invalid/' }]) {
      assert.equal(f.fire(details), undefined);
    }
    assert.deepEqual(f.operations, [], 'Unrelated lifecycle events are ignored');
    await Promise.all([f.fire({ reason: 'install' }), f.fire({ reason: 'update', previousVersion: '1.22.6' })]);
    assert.deepEqual(f.tabs, [{ url: f.origin + 'src/setup/quick-start.html?source=install', active: true }]);
    assert.equal(f.store[KEY], '1.23.0');
    assert.deepEqual(f.operations, ['read', 'write', 'tab', 'read'], 'The marker is persisted before opening, and events are serialized');
    await f.fire({ reason: 'update', previousVersion: '1.23.0' });
    assert.equal(f.tabs.length, 1, 'Reloading an unpacked copy never repeats the introduction');
    f.state.version = '1.24.0';
    await f.fire({ reason: 'update', previousVersion: '1.23.0' });
    assert.equal(f.tabs.length, 1, 'A later release does not repeat this feature introduction');
    const restarted = fixture({ browser, store: f.store });
    await restarted.fire({ reason: 'update' });
    assert.equal(restarted.tabs.length, 0, 'The marker survives a new background lifetime');
    assert.equal(restarted.context.FCM.STORAGE_KEYS.youtubeOnboarding, KEY);
    assert.ok(!restarted.context.FCM.BACKUP_STORES.includes('youtubeOnboarding'));
    assert.equal(restarted.context.FCM.buildBackup({ youtubeOnboarding: { feature: '1.23.0' } }, '1.23.0').youtubeOnboarding, undefined,
      'Installation metadata is not portable user data');

    const update = fixture({ browser });
    await update.fire({ reason: 'update', previousVersion: '1.22.6' });
    assert.deepEqual(update.tabs, [{ url: update.origin + 'src/youtube/permission.html?source=update', active: false }],
      'Updating introduces the feature without stealing focus from a stream');
    const sameVersion = fixture({ browser });
    await sameVersion.fire({ reason: 'update', previousVersion: '1.23.0' });
    assert.equal(sameVersion.tabs.length, 1, 'A prior local trial without this marker gets one introduction');
  }
  for (const version of ['1.22.6', '0.0.0', 'invalid']) {
    const f = fixture({ version });
    await f.fire({ reason: 'install' });
    assert.deepEqual(f.operations, [], 'A build before YouTube does not introduce it');
  }
  for (const version of ['1.23.1', '1.24.0', '2.0.0']) {
    const f = fixture({ version });
    await f.fire({ reason: 'update', previousVersion: '1.22.6' });
    assert.equal(f.tabs.length, 1, 'Skipping the introduction release still introduces its feature once');
  }
  for (const marker of [null, false, {}, 'older']) {
    const f = fixture({ store: { [KEY]: marker } });
    await f.fire({ reason: 'install' });
    assert.equal(f.store[KEY], '1.23.0');
    assert.equal(f.tabs.length, 1, 'An unrelated or malformed marker is not mistaken for this feature');
  }
  for (const error of ['manifest', 'read', 'write', 'url', 'tab']) {
    const f = fixture({ error });
    await f.fire({ reason: 'install' });
    assert.equal(f.tabs.length, 0, `${error} failure is contained`);
    const marked = ['url', 'tab'].includes(error);
    assert.equal(f.store[KEY], marked ? '1.23.0' : undefined);
    f.state.error = '';
    await f.fire({ reason: 'update' });
    assert.equal(f.tabs.length, marked ? 0 : 1, 'Tab failure does not nag; an unrecorded event can recover on a later installation event');
  }

  const names = pack.collect(ROOT);
  assert.ok(names.includes(FILE), 'Both extension packages include onboarding');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const workerSource = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
  const firefox = pack.firefoxManifest(manifest, workerSource);
  assert.deepEqual(firefox.optional_host_permissions, ['https://www.youtube.com/*']);
  assert.ok(firefox.background.scripts.indexOf(FILE) > firefox.background.scripts.indexOf('src/background/updates.js'),
    'Firefox loads the existing version comparator before onboarding');
  assert.match(workerSource, /'\/src\/background\/updates\.js',\s*'\/src\/background\/youtube-onboarding\.js'/,
    'Chrome imports the same ordered source, using the packager contract');
  for (const [browser, loadPath] of [['chrome', 'worker'], ['firefox', 'scripts']]) {
    const worker = bootWorker({ browser, loadPath });
    try {
      assert.ok(worker.loaded.includes(FILE), `${browser} loads onboarding through its real background entry`);
      assert.ok(worker.loaded.indexOf(FILE) > worker.loaded.indexOf('src/background/updates.js'));
      await Promise.resolve();
      assert.equal(worker.fetchCalls.filter(call => String(call.url).includes('youtube.com')).length, 0);
      assert.equal(worker.sockets.length, 0, 'Loading onboarding starts no chat connection');
    } finally { worker.teardown(); }
  }
  console.log('YouTube one-time install/update onboarding tests passed.');
}

async function coverage() {
  const inspector = require('node:inspector');
  const { promisify } = require('node:util');
  const gate = require('./youtube-coverage');
  const session = new inspector.Session(); session.connect();
  const post = promisify(session.post.bind(session));
  await post('Debugger.enable'); await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  try {
    await run();
    const { result } = await post('Profiler.takePreciseCoverage');
    const scripts = [];
    for (const entry of result.filter(script => gate.matchesFile(script, FILE))) {
      const { scriptSource } = await post('Debugger.getScriptSource', { scriptId: entry.scriptId });
      scripts.push({ ...entry, source: scriptSource });
    }
    const source = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
    const report = gate.report(FILE, source, scripts, gate.selectedLines(source, '', true));
    assert.equal(report.passed, true, JSON.stringify({ lines: report.lines.filter(line => !line.covered),
      functions: [...report.functions].filter(([, count]) => !count), ranges: [...report.ranges].filter(([, covered]) => !covered) }));
    console.log(`Onboarding actual-source coverage: ${report.lines.length}/${report.lines.length} lines; ${report.functions.size}/${report.functions.size} functions; ${report.ranges.size}/${report.ranges.size} V8 ranges.`);
  } finally { await post('Profiler.stopPreciseCoverage'); session.disconnect(); }
}

module.exports = run;
if (require.main === module) (process.argv.includes('--coverage') ? coverage() : run())
  .catch(error => { console.error(error); process.exitCode = 1; });
