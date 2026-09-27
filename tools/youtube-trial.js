// Builds isolated unpacked experiments. Never changes or publishes the source extension.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pack = require('./pack');
const ROOT = path.resolve(__dirname, '..');

function safeDefaults(source) {
  let result = source;
  for (const key of ['autoClaimBonus', 'watchWhenLive', 'showShareReminders']) {
    const pattern = new RegExp(`^([ \\t]*${key}[ \\t]*:[ \\t]*)true([ \\t]*,)`, 'gm');
    if ([...result.matchAll(pattern)].length !== 1) throw Error(`Expected exactly one enabled default for ${key}; refusing an ambiguous trial build.`);
    result = result.replace(pattern, '$1false$2');
  }
  return result;
}

function localManifest(source, target) {
  if (!['chrome', 'firefox'].includes(target)) throw Error('Unknown target for local trial.');
  const manifest = JSON.parse(JSON.stringify(source));
  delete manifest.key;
  delete manifest.update_url;
  manifest.name = 'Friendly Chat — YouTube Local Trial';
  manifest.version_name = `${manifest.version} experimental local trial`;
  if (target === 'firefox') {
    manifest.browser_specific_settings.gecko.id = 'friendly-chat-youtube-trial@local.invalid';
    delete manifest.browser_specific_settings.gecko.update_url;
  }
  return manifest;
}

const LAUNCHER = `@echo off
setlocal DisableDelayedExpansion
rem This dedicated profile must not be replaced with your normal Chrome profile.
set "trialChrome=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"
if not exist "%trialChrome%" set "trialChrome=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"
if not exist "%trialChrome%" set "trialChrome=%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe"
if not exist "%trialChrome%" (
  echo Chrome was not found. Open START-HERE.html for setup instructions.
  exit /b 1
)
start "" "%trialChrome%" --user-data-dir="%~dp0chrome-profile" --no-first-run --no-default-browser-check "chrome://extensions" "%~dp0START-HERE.html"
`;

const GUIDE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Friendly Chat YouTube Local Trial</title>
<style>body{font:17px/1.6 system-ui;max-width:850px;margin:40px auto;padding:24px;background:#102130;color:#dde8f4}code{background:#08131e;padding:3px}li{margin:12px 0}a{color:#9cdaff}</style>
<h1>Friendly Chat — YouTube Local Trial</h1>
<p>This is an experimental local build with a separate extension identity. Your working Friendly Chat install and its settings are not changed.</p>
<ol>
<li>Use <strong>Launch Chrome Trial.cmd</strong> from this folder. It creates a dedicated <code>chrome-profile</code> here. Do not load this experiment into your normal Chrome profile. Stay signed out and do not enable browser sync.</li>
<li>In that test window, open <code>chrome://extensions</code>, enable Developer mode, choose <strong>Load unpacked</strong>, and select this folder's <code>chrome</code> subfolder. Its name must say <strong>YouTube Local Trial</strong>.</li>
<li>Open a Twitch or Kick channel in this test profile. After allowing YouTube site access, a live possible match can appear with an <strong>Add YouTube chat</strong> button. Page links take priority over a matching username; check that the suggested channel is the one you want. Chat starts only after Add. Use <strong>Check YouTube</strong> to check again after granting access or dismissing a suggestion. You can also use the trial's YouTube controls to attach a public live-video URL or channel URL such as <code>https://www.youtube.com/@Agent00</code>. Choose <strong>Add chat</strong> to look up its current broadcast. If the channel has several live streams, use the specific video URL. YouTube viewing is read only: no posting, replies or moderation.</li>
<li>Keep Twitch/Kick accounts disconnected. This extension's different identity has no registered OAuth redirect; do not change the worker or account registration for this test. Do not import your regular Friendly Chat settings or tokens.</li>
<li>Observe the combined feed, switch channels, detach the YouTube source and confirm it stops. Automatic bonus claims, Watch now clicks and share reminders default to off in this artifact. Keep them off.</li>
<li>Detach YouTube and close the entire test window when finished. Retain this folder if you want to repeat the test. Build into another fresh folder for a new trial; the builder will never replace an existing output.</li>
</ol>
<p>The <code>firefox</code> folder is a separate-ID, unsigned local fixture for compatibility testing. It is not a release or an approved Firefox feature. No package was uploaded or published.</p>
<p>Normal release notices may still appear because the existing update check is read only. Ignore those notices in this experiment. It cannot install a normal Friendly Chat release over this trial automatically.</p>
<p>YouTube reliability and terms remain separate from this local test. Hidden capture still loads YouTube chat and its normal network requests; it uses no Google API key or server operated by you.</p>
</html>
`;

function buildTrial(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw Error('Choose a fresh output directory under an existing parent.');
  const requested = path.resolve(directory);
  // Resolve the existing parent so a directory alias cannot write back inside the checkout.
  const output = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
  const relative = path.relative(fs.realpathSync(ROOT), output);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw Error('The local trial output must be outside the source checkout.');
  }
  if (fs.existsSync(output)) throw Error('Output already exists; choose a fresh directory. Nothing was overwritten.');
  const constants = safeDefaults(fs.readFileSync(path.join(ROOT, 'src/shared/constants.js'), 'utf8'));
  const targets = ['chrome', 'firefox'];
  const manifests = targets.map(target => localManifest(JSON.parse(pack.manifestBytes(ROOT, target)), target));
  fs.mkdirSync(output);
  targets.forEach((target, index) => {
    const targetDirectory = path.join(output, target);
    pack.writeUnpacked(ROOT, targetDirectory, target);
    fs.writeFileSync(path.join(targetDirectory, 'manifest.json'), `${JSON.stringify(manifests[index], null, 2)}\n`);
    fs.writeFileSync(path.join(targetDirectory, 'src/shared/constants.js'), constants);
  });
  fs.writeFileSync(path.join(output, 'Launch Chrome Trial.cmd'), LAUNCHER.replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(output, 'START-HERE.html'), GUIDE);
  return { directory: output, targets };
}

module.exports = { safeDefaults, localManifest, buildTrial };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw Error('Usage: node tools/youtube-trial.js <fresh-output-directory>');
    const result = buildTrial(args[0]);
    console.log(`Created isolated local trial: ${result.directory}\nOpen START-HERE.html before loading it.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
