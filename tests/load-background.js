// Loads the background into a test sandbox the way a browser does.
//
// There are two ways, and the extension ships both. Chrome starts
// service-worker.js as a service worker, and the worker pulls in everything
// else itself through importScripts. Firefox has no extension service workers:
// it runs an event page, which is a window, loads each file the Firefox
// manifest lists in background.scripts one after another, and has no
// importScripts to call. The same files end up running in the same order — but
// only while the list tools/pack.js generates is right and the worker's call
// is guarded, and a suite that only ever boots the Chrome way would never
// notice either of those going wrong.
//
// tests/background.js and tests/endtoend.js both boot through here, so every
// harness can boot either way and the two cannot drift apart.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pack = require('../tools/pack.js');

const ROOT = path.join(__dirname, '..');

function repoManifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
}

// Where each browser serves the extension from, which is what FCM.BROWSER is
// read from. Chrome's is the extension's ID; Firefox's is a random UUID per
// profile, never the add-on's ID.
function extensionOrigin(browser) {
  return browser === 'firefox'
    ? 'moz-extension://2f9a6c1e-7d4b-4c0e-9a51-3b8e6f0d2c47'
    : 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
}

/**
 * The manifest the background runs under: Chrome's as it is, or the one the
 * Firefox package is built with.
 *
 * @param {{loadPath?: 'worker'|'scripts', manifest?: object, updateUrl?: string|null}} [opts]
 *   `manifest` is Chrome's to start from (the repository's by default). One
 *   that already lists background.scripts is taken at its word, so a test can
 *   hand over a deliberately wrong list and watch it fail. `updateUrl`, when
 *   the key is there at all, is what the Firefox manifest names in place of
 *   tools/pack.js's UPDATE_URL: null makes the Firefox package built without
 *   one, which Firefox never updates and which still runs the extension's own
 *   update check.
 */
function backgroundManifest(opts = {}) {
  const manifest = opts.manifest || repoManifest();
  if ((opts.loadPath || 'worker') === 'worker') return manifest;
  if (manifest.background && Array.isArray(manifest.background.scripts)) return manifest;
  const worker = (manifest.background || {}).service_worker;
  const swSource = worker ? fs.readFileSync(path.join(ROOT, worker), 'utf8') : '';
  return pack.firefoxManifest(manifest, swSource,
    'updateUrl' in opts ? { updateUrl: opts.updateUrl } : undefined);
}

/**
 * Runs the background inside `sandbox`, which becomes its global.
 *
 * @param {object} sandbox the globals the background should see: chrome,
 *   fetch, WebSocket, timers. Contextified here if it has not been already.
 * @param {{loadPath?: 'worker'|'scripts', manifest?: object}} [opts]
 *   'worker' (the default) is Chrome's service worker, 'scripts' Firefox's
 *   event page.
 * @returns {{manifest: object, loaded: string[]}} the manifest it ran under,
 *   and every file it ran, in the order each one started
 */
function loadBackground(sandbox, opts = {}) {
  const loadPath = opts.loadPath || 'worker';
  if (loadPath !== 'worker' && loadPath !== 'scripts') {
    throw new Error(`unknown loadPath "${loadPath}" (expected worker or scripts)`);
  }
  const manifest = backgroundManifest({ ...opts, loadPath });
  const loaded = [];
  const run = (rel) => {
    loaded.push(rel);
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  };

  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  if (loadPath === 'worker') {
    // A worker's global: importScripts exists, takes the extension-absolute
    // paths the worker passes it, and runs each file into this same global.
    sandbox.importScripts = (...paths) => {
      paths.forEach((p) => run(String(p).replace(/^\//, '')));
    };
    if (!vm.isContext(sandbox)) vm.createContext(sandbox);
    run(manifest.background.service_worker);
  } else {
    // A window's: no importScripts whatever the sandbox was given, and
    // `window` is the global itself, as it is on an event page.
    delete sandbox.importScripts;
    sandbox.window = sandbox;
    if (!vm.isContext(sandbox)) vm.createContext(sandbox);
    manifest.background.scripts.forEach(run);
  }
  return { manifest, loaded };
}

module.exports = { loadBackground, backgroundManifest, extensionOrigin, repoManifest };
