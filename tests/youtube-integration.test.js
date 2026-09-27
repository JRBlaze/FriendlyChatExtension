// Package/startup boundaries for the optional reader. All browser APIs are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pack = require('../tools/pack');
const { bootWorker } = require('./background');
const ROOT = path.resolve(__dirname, '..');

async function run() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const baseline = JSON.parse(execFileSync('git', ['show', 'HEAD:manifest.json'], { cwd: ROOT, encoding: 'utf8' }));
  assert.equal(manifest.key, baseline.key, 'the original extension identity stays fixed');
  assert.equal(manifest.name, baseline.name, 'the official extension name stays fixed');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'the official build uses a normal release version');
  assert.equal(manifest.version_name, undefined, 'the official build has no trial version label');
  assert.doesNotMatch(manifest.description, /experimental|local trial/i);
  assert.doesNotMatch(manifest.description, /read-only/i, 'package metadata reflects optional YouTube sending');
  assert.match(manifest.description, /optional YouTube live chat/i);
  assert.ok(manifest.description.length <= 132, 'description fits the browser package limit');
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(!manifest.permissions.includes('declarativeNetRequest'));
  assert.ok(!manifest.permissions.includes('debugger'));
  assert.deepEqual(manifest.optional_host_permissions, ['https://www.youtube.com/*']);
  assert.ok(!manifest.host_permissions.some(host => host.includes('youtube.com')));
  assert.equal(manifest.content_scripts.length, 1, 'optional YouTube access must not be implicitly granted by a static reader');
  const host = manifest.content_scripts[0];
  assert.deepEqual(host.matches, ['*://*.twitch.tv/*', '*://*.kick.com/*']);
  assert.equal(host.all_frames, false, 'normal Friendly Chat never starts inside YouTube frames');
  for (const file of ['src/shared/youtube.js', 'src/content/youtube-suggestions.js', 'src/content/youtube-source.js', 'src/content/youtube-controls.js', 'src/content/overlay.js']) {
    assert.ok(host.js.includes(file), `${file} is registered on the host page`);
  }
  assert.ok(host.js.indexOf('src/shared/youtube.js') < host.js.indexOf('src/content/youtube-suggestions.js'));
  assert.ok(host.js.indexOf('src/content/youtube-suggestions.js') < host.js.indexOf('src/content/youtube-source.js'));
  assert.ok(host.js.indexOf('src/content/youtube-source.js') < host.js.indexOf('src/content/youtube-controls.js'));
  assert.ok(host.js.indexOf('src/content/youtube-controls.js') < host.js.indexOf('src/content/overlay.js'));
  const harness = fs.readFileSync(path.join(ROOT, 'tests/harness.html'), 'utf8');
  assert.ok(harness.indexOf('/src/shared/youtube.js') < harness.indexOf('/src/content/youtube-suggestions.js'));
  assert.ok(harness.indexOf('/src/content/youtube-suggestions.js') < harness.indexOf('/src/content/youtube-controls.js'));
  const names = pack.collect(ROOT);
  for (const file of ['src/shared/youtube.js', 'src/background/youtube-relay.js', 'src/background/youtube-lookup.js', 'src/content/youtube-source.js',
    'src/content/youtube-reader.js', 'src/content/youtube-suggestions.js', 'src/content/youtube-controls.js', 'src/youtube/permission.html', 'src/youtube/permission.js']) {
    assert.ok(names.includes(file), `${file} is included in both packages`);
  }
  for (const [browser, loadPath] of [['chrome', 'worker'], ['firefox', 'scripts']]) {
    const worker = bootWorker({ browser, loadPath });
    try {
      assert.ok(worker.loaded.includes('src/shared/youtube.js'));
      assert.ok(worker.loaded.includes('src/background/youtube-relay.js'));
      assert.ok(worker.loaded.indexOf('src/shared/youtube.js') < worker.loaded.indexOf('src/background/youtube-relay.js'));
      assert.deepEqual(Array.from(worker.sandbox.FCM.PLATFORMS), ['twitch', 'kick']);
      assert.deepEqual(Array.from(worker.sandbox.FCM.SEND_PLATFORMS), ['twitch', 'kick']);
      assert.equal(worker.sandbox.FCM.PLATFORM_META.youtube.name, 'YouTube');
      assert.equal(worker.sandbox.FCM.PLATFORM_META.youtube.short, 'YT');
      assert.ok(worker.sandbox.FCM.youtube);
      assert.equal(typeof worker.sandbox.FCM.resolveYouTubeChannel, 'function');
      assert.ok(worker.loaded.indexOf('src/shared/youtube.js') < worker.loaded.indexOf('src/background/youtube-lookup.js'));
      assert.ok(worker.loaded.indexOf('src/background/youtube-lookup.js') < worker.loaded.indexOf('src/background/youtube-relay.js'));
      assert.equal(worker.fetchCalls.filter(call => String(call.url).includes('youtube.com')).length, 0, 'startup does not look up channels');
      assert.equal(worker.sockets.length, 0, 'startup alone opens no chat connection');
      await Promise.resolve();
    } finally { worker.teardown(); }
  }
  console.log('YouTube package and Chrome/Firefox startup boundaries passed.');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
