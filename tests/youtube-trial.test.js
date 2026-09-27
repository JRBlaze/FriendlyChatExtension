'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

async function run() {
  const trial = require('../tools/youtube-trial');
  const constants = fs.readFileSync(path.join(ROOT, 'src/shared/constants.js'), 'utf8');
  const manifestBytes = fs.readFileSync(path.join(ROOT, 'manifest.json'));
  const safe = trial.safeDefaults(constants);
  for (const key of ['autoClaimBonus', 'watchWhenLive', 'showShareReminders']) {
    assert.match(safe, new RegExp(`${key}: false`));
    assert.throws(() => trial.safeDefaults(constants.replace(`${key}: true`, `${key}: false`)), /exactly one/);
    assert.throws(() => trial.safeDefaults(`${constants}\n  ${key}: true,\n`), /exactly one/);
  }
  const chromeSource = { key: 'source-public-key', name: 'Original', version: '1.2.3', update_url: 'https://example.test/update' };
  const chrome = trial.localManifest(chromeSource, 'chrome');
  assert.equal(chromeSource.key, 'source-public-key');
  assert.equal(chrome.key, undefined); assert.equal(chrome.update_url, undefined);
  assert.equal(chrome.name, 'Friendly Chat — YouTube Local Trial');
  assert.match(chrome.version_name, /experimental/i);
  const geckoSource = { ...chromeSource, browser_specific_settings: { gecko: { id: 'production',
    update_url: 'https://example.test/update', strict_min_version: '140.0' } } };
  const firefox = trial.localManifest(geckoSource, 'firefox');
  assert.equal(firefox.browser_specific_settings.gecko.id, 'friendly-chat-youtube-trial@local.invalid');
  assert.equal(firefox.browser_specific_settings.gecko.update_url, undefined);
  assert.equal(geckoSource.browser_specific_settings.gecko.id, 'production');
  assert.throws(() => trial.localManifest(chromeSource, 'unsupported'), /Unknown target/);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-youtube-trial-test-'));
  const occupied = path.join(temporary, 'occupied'); fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'keep.txt'), 'user file');
  assert.throws(() => trial.buildTrial(occupied), /already exists/);
  assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'user file');
  assert.throws(() => trial.buildTrial(ROOT), /outside/);
  assert.throws(() => trial.buildTrial(path.join(ROOT, 'src', 'trial-artifact')), /outside/);
  for (const input of ['', '   ', null]) assert.throws(() => trial.buildTrial(input), /fresh output directory/);
  const output = path.join(temporary, 'local build');
  const result = trial.buildTrial(output);
  assert.equal(result.directory, output);
  for (const target of ['chrome', 'firefox']) {
    const built = JSON.parse(fs.readFileSync(path.join(output, target, 'manifest.json'), 'utf8'));
    assert.equal(built.name, chrome.name); assert.equal(built.key, undefined);
    assert.equal(fs.readFileSync(path.join(output, target, 'src/shared/constants.js'), 'utf8'), safe);
    assert.deepEqual(fs.readFileSync(path.join(output, target, 'src/content/render.js')),
      fs.readFileSync(path.join(ROOT, 'src/content/render.js')));
    if (target === 'firefox') {
      assert.equal(built.browser_specific_settings.gecko.id, firefox.browser_specific_settings.gecko.id);
      assert.equal(built.browser_specific_settings.gecko.update_url, undefined);
      assert.ok(built.background.scripts.length);
    } else assert.ok(built.background.service_worker);
  }
  assert.equal(fs.readFileSync(path.join(ROOT, 'src/shared/constants.js'), 'utf8'), constants);
  assert.deepEqual(fs.readFileSync(path.join(ROOT, 'manifest.json')), manifestBytes);
  assert.throws(() => trial.buildTrial(output), /already exists/);
  const launcher = fs.readFileSync(path.join(output, 'Launch Chrome Trial.cmd'), 'utf8');
  assert.match(launcher, /--user-data-dir="%~dp0chrome-profile"/);
  assert.match(launcher, /DisableDelayedExpansion/);
  assert.doesNotMatch(launcher, /--disable-web-security|--ignore-certificate|--load-extension|--disable-extensions-except/);
  const guide = fs.readFileSync(path.join(output, 'START-HERE.html'), 'utf8');
  assert.match(guide, /normal Chrome profile/); assert.match(guide, /Load unpacked/);
  assert.match(guide, /Add YouTube chat/); assert.match(guide, /possible match/);
  assert.match(guide, /channel URL/); assert.match(guide, /several live streams/);
  assert.match(guide, /OAuth/); assert.match(guide, /firefox.*fixture/is);

  // Exercise the real CLI entry with an isolated process facade; never launch a browser.
  const file = path.join(ROOT, 'tools/youtube-trial.js'), source = fs.readFileSync(file, 'utf8');
  function cli(args) {
    const module = { exports: {} }, messages = [];
    const localRequire = id => id === './pack' ? require('../tools/pack') : require(id);
    localRequire.main = module;
    const process = { argv: ['node', file, ...args], exitCode: 0 };
    vm.runInNewContext(source, { require: localRequire, module, __dirname: path.dirname(file), process,
      console: { log: value => messages.push(String(value)), error: value => messages.push(String(value)) } }, { filename: file });
    return { process, messages };
  }
  assert.equal(cli([]).process.exitCode, 1);
  assert.equal(cli(['a', 'b']).process.exitCode, 1);
  assert.equal(cli([occupied]).process.exitCode, 1);
  const success = cli([path.join(temporary, 'cli build')]);
  assert.equal(success.process.exitCode, 0);
  assert.match(success.messages.join('\n'), /START-HERE/);
  console.log('YouTube isolated local builder tests passed.');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
