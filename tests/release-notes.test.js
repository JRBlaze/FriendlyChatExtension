const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const FILE = 'src/background/release-notes.js';
const KEY = 'fcm_release_notes_v1';

function fixture(options = {}) {
  const store = options.store || {}, tabs = [], listeners = [], operations = [];
  let error = options.error;
  const fail = stage => { if (error === stage) throw Error(stage); };
  const chrome = {
    runtime: { onInstalled: { addListener(fn) { listeners.push(fn); } },
      getManifest() { fail('manifest'); return {version: '1.23.4'}; },
      getURL(file) { fail('url'); return 'extension://fixture/' + file; } },
    storage: { local: {
      async get(key) { assert.equal(key, KEY); fail('read'); operations.push('read'); return store; },
      async set(patch) { fail('write'); operations.push('write'); Object.assign(store, patch); },
    } },
    tabs: { async create(info) { fail('tab'); operations.push('tab'); tabs.push(JSON.parse(JSON.stringify(info))); } },
  };
  const sandbox = vm.createContext({chrome, URL}); sandbox.self = sandbox;
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/background/updates.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, {filename: path.join(ROOT, file)});
  }
  if (options.missing === 'chrome') delete sandbox.chrome;
  if (options.missing === 'runtime') delete chrome.runtime;
  if (options.missing === 'event') delete chrome.runtime.onInstalled;
  vm.runInContext(fs.readFileSync(path.join(ROOT, FILE), 'utf8'), sandbox, {filename:path.join(ROOT, FILE)});
  return {store, tabs, listeners, operations, fire: details => listeners[0](details), recover() {error = '';}};
}

// This runs in the full suite before the release workflow can sign or publish.
function assertCurrentNotes(markup, version) {
  const sections = [...markup.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)];
  assert.ok(sections.length, 'bundled release notes need a latest section');
  const latest = sections[0][1];
  const heading = /<h2\b[^>]*>Version ([0-9.]+)<\/h2>/.exec(latest);
  assert.equal(heading && heading[1], version, 'first bundled release notes must match manifest.version');
  assert.equal((markup.match(/LATEST UPDATE/g) || []).length, 1, 'exactly one latest marker');
  assert.match(latest, /LATEST UPDATE/, 'latest marker belongs to the current version');
  const items = [...latest.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)];
  assert.ok(items.some(item => item[1].replace(/<[^>]*>/g, '').trim()), 'current version needs nonempty change notes');
}

async function run() {
  for (const missing of ['chrome', 'runtime', 'event']) assert.equal(fixture({missing}).listeners.length, 0);
  const f = fixture();
  assert.equal(f.listeners.length, 1);
  assert.deepEqual(f.operations, [], 'background starts do not open or record notices');
  for (const details of [null, undefined, {}, {reason:'chrome_update'}, {reason:'startup'}]) assert.equal(f.fire(details), undefined);
  await Promise.all([f.fire({reason:'update',previousVersion:'1.23.0'}), f.fire({reason:'update',previousVersion:'1.23.3'})]);
  assert.deepEqual(f.tabs, [{url:'extension://fixture/src/releases/notes.html',active:false}]);
  assert.equal(f.store[KEY], '1.23.4');
  assert.deepEqual(f.operations, ['read','write','tab','read']);
  const restarted = fixture({store:f.store}); await restarted.fire({reason:'update',previousVersion:'1.23.3'});
  assert.equal(restarted.tabs.length, 0);
  for (const details of [{reason:'install'}, {reason:'update',previousVersion:'1.23.4'}, {reason:'update',previousVersion:'2.0.0'}]) {
    const g = fixture(); await g.fire(details); assert.equal(g.tabs.length, 0); assert.equal(g.store[KEY], '1.23.4');
  }
  for (const error of ['manifest','read','write','url','tab']) {
    const g = fixture({error}); await g.fire({reason:'update',previousVersion:'1.23.3'});
    assert.equal(g.tabs.length, 0); g.recover(); await g.fire({reason:'update',previousVersion:'1.23.3'});
    assert.equal(g.tabs.length, ['url','tab'].includes(error) ? 0 : 1);
  }
  const pack = require('../tools/pack');
  const files = pack.collect(ROOT);
  for (const file of [FILE, 'src/releases/notes.html', 'src/releases/notes.css']) assert.ok(files.includes(file));
  const markup = fs.readFileSync(path.join(ROOT, 'src/releases/notes.html'), 'utf8');
  const currentVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
  const valid = '<section><p>LATEST UPDATE</p><h2>Version 1.2.3</h2><ul><li>A useful update</li></ul></section>';
  assertCurrentNotes(valid, '1.2.3');
  for (const invalid of ['', valid.replace('1.2.3', '1.2.2'), valid.replace('LATEST UPDATE', ''),
    valid + 'LATEST UPDATE', valid.replace('<li>A useful update</li>', ''),
    valid.replace('A useful update', '<strong> </strong>'), valid.replace('LATEST UPDATE', '') + '<section>LATEST UPDATE</section>',
    valid.replace('<h2>Version 1.2.3</h2>', ''), valid.replace('1.2.3', '1.2.30')]) {
    assert.throws(() => assertCurrentNotes(invalid, '1.2.3'));
  }
  assertCurrentNotes(markup, currentVersion);

  for (const version of ['1.23.0','1.23.1','1.23.2','1.23.3','1.23.4','1.23.5','1.23.6','1.23.7','1.23.8','1.23.9','1.23.10','1.23.11','1.23.12','1.23.13','1.23.14']) assert.ok(markup.includes('Version ' + version));
  assert.ok(markup.indexOf('Version 1.23.11') < markup.indexOf('Version 1.23.10'));
  assert.match(markup, /Quieter system messages/);
  assert.match(markup, /Brighter personal notices/);
  assert.match(markup, /Clearer Share buttons/);
  assert.ok(markup.indexOf('Version 1.23.10') < markup.indexOf('Version 1.23.9'));
  assert.match(markup, /Less work alongside Kick video/);
  assert.match(markup, /Native chat stays visible/);
  assert.match(markup, /Browser spellchecking/);
  assert.equal((markup.match(/LATEST UPDATE/g) || []).length, 1);
  assert.ok(markup.indexOf('Version 1.23.6') < markup.indexOf('Version 1.23.5'));
  assert.ok(markup.indexOf('Version 1.23.7') < markup.indexOf('Version 1.23.6'));
  assert.ok(markup.indexOf('Version 1.23.8') < markup.indexOf('Version 1.23.7'));
  assert.ok(markup.indexOf('Version 1.23.9') < markup.indexOf('Version 1.23.8'));
  assert.match(markup, /Kick reconnect loop fixed/);
  assert.match(markup, /current compatible connection automatically/);
  assert.match(markup, /Twitch, Kick and YouTube.*five minutes/);
  assert.match(markup, /Stable YouTube reading/);
  assert.match(markup, /never replay an uncertain message/);
  assert.match(markup, /One Share reminder per action/);
  assert.match(markup, /streaks, resubs and other Share prompts/);
  assert.match(markup, /current native Share button/);
  for (const feature of ['Quick start', 'emote access', 'highlight', 'chime', 'pin', 'Slimmer']) assert.ok(markup.includes(feature));
  assert.match(markup, /aria-labelledby="v1235"/);
  assert.match(markup, /Paid messages stay on their platform/);
  assert.match(markup, /about:blank/);
  assert.ok(!markup.includes('<script'), 'release history works offline without scripts');
  for (const file of ['src/popup/popup.html','src/options/options.html']) {
    assert.match(fs.readFileSync(path.join(ROOT, file), 'utf8'), /href="\.\.\/releases\/notes.html"/);
  }
  const { bootWorker } = require('./background');
  for (const [browser, loadPath] of [['chrome','worker'], ['firefox','scripts']]) {
    const worker = bootWorker({browser,loadPath});
    try {
      assert.ok(worker.loaded.includes(FILE));
      assert.ok(worker.loaded.indexOf(FILE) > worker.loaded.indexOf('src/background/updates.js'));
      assert.equal(worker.sandbox.FCM.STORAGE_KEYS.releaseNotes, KEY);
      assert.ok(!worker.sandbox.FCM.BACKUP_STORES.includes('releaseNotes'));
      const backup = worker.sandbox.FCM.buildBackup({settings:{platformsCollapsed:true,sendToCollapsed:false},releaseNotes:'1.23.4'},'1.23.4');
      assert.equal(backup.settings.platformsCollapsed, true);
      assert.equal(backup.settings.sendToCollapsed, false);
      assert.equal(backup.releaseNotes, undefined);
    } finally { worker.teardown(); }
  }
  console.log('Installed release-notes lifecycle tests passed.');
}
module.exports = run;
module.exports.assertCurrentNotes = assertCurrentNotes;
if (require.main === module) run().catch(error => {console.error(error);process.exitCode = 1;});
