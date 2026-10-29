const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./feed-performance.test');
const ROOT = path.resolve(__dirname, '..');

function styleChecks() {
  const css = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
  const rule = selector => {
    const start = css.indexOf(selector + ' {');
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('}', start));
  };
  const luminance = hex => {
    const channels = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const selector of ['.fcm-root', '.fcm-root[data-theme="light"]']) {
    const root = rule(selector);
    const color = name => root.match(new RegExp(`--${name}: (#[a-f\\d]{6})`, 'i'))[1];
    const bg = luminance(color('sys-bg')), text = luminance(color('sys-text'));
    assert.ok((Math.max(bg, text) + 0.05) / (Math.min(bg, text) + 0.05) >= 4.5,
      `${selector}: system text contrast`);
    if (selector === '.fcm-root') {
      assert.ok(bg > 0.01, 'dark notices have a visibly raised background');
      assert.ok((text + 0.05) / (bg + 0.05) >= 10, 'dark notice text is brighter');
    }
  }
  const button = rule('.fcm-prompt-btn');
  assert.match(button, /min-height: 26px/, 'slightly larger click target');
  assert.match(button, /font-size: max\(11px, calc\(var\(--fcm-size\) - 2px\)\)/, 'button labels follow chat text size');
  assert.match(button, /cursor: pointer/);
  assert.match(rule('.fcm-prompt-btn-share'), /background: var\(--send-twitch\); color: #fff/, 'solid primary action');
  assert.match(rule('.fcm-prompt-btn-share:hover'), /background: var\(--send-twitch\)/, 'hover keeps the primary action filled');
  assert.match(rule('.fcm-prompt-btn:focus-visible'), /outline: 2px solid/, 'visible keyboard focus');
}

function run() {
  const hidden = [
    'Connecting to Kick: bwana...', 'Connected to Kick: bwana', 'Connected to Twitch',
    'Twitch: server asked us to reconnect', 'Kick: chat service changed — switching to its current connection',
    'Kick: disconnected', 'Twitch: connection error', 'Kick: connection timed out — reconnecting',
    'Twitch: reconnecting in 2s...', 'Left Kick: bwana',
    'Loaded 201 cached Kick emotes', 'Loaded 201 Kick emotes (71 channel, 130 global)',
    'Loaded 925 of your Twitch emotes (subs, follows, global)',
    'Loaded 45 third-party emotes (7TV/BTTV/FFZ)',
    'Loaded 285 third-party emotes for Twitch (7TV/BTTV/FFZ)',
    'Loaded 50 Twitch history messages', 'Loaded 20 Kick history messages',
    '201 emotes ready from last time — checking for new ones',
    '[Merged] v1.23.10 · Watching Twitch/bwana',
    '[Merged] Moderation tools enabled for Twitch',
    '[Merged] Bwana is also live on Kick — connecting automatically',
    '[Merged] Bwana just went live on Twitch',
    '  [Kick] Loaded 201 cached Kick emotes  ', '', null, undefined,
  ];
  const f = fixture();
  const empty = f.element();
  f.api.setPlaceholder(() => empty);
  for (const text of hidden) f.api.addSys(text);
  assert.equal(f.timers.size, 0, 'diagnostics never schedule a feed flush');
  assert.equal(f.frames.size, 0, 'diagnostics never schedule an animation frame');
  assert.deepEqual(f.feedEl.children, [empty], 'diagnostics leave the empty state intact');
  assert.equal(f.api.count, 0);

  const visible = [
    '[Twitch] You are subscribed to bwana for 24 months (Tier 1)',
    '[Account] Sign-in failed — reconnect your account in settings',
    'Kick: could not find that channel', 'Twitch: You are banned from talking in this channel.',
    'Kick: reconnect limit reached — retrying in 5 minutes (or reconnect from the overlay now)',
    'Kick: could not load channel information — trying again in 2s...',
    'No Twitch emotes could be loaded — connect a Twitch account in settings to load yours',
    '[Merged] Firefox has not allowed access to Twitch — check Site access',
    'YouTube submission could not be confirmed. Check YouTube chat before sending it again.',
    '[Twitch] LoadedFan gifted you a subscription!',
    '[Twitch] Your Drop is ready to claim', '[Twitch] Your watch streak is ready to share',
    'A new platform notice that needs to remain readable',
  ];
  for (const text of visible) f.api.addSys(text);
  f.flush();
  assert.equal(f.feedEl.children.length, visible.length, 'personal notices and actionable errors remain');
  assert.ok(!f.feedEl.children.includes(empty));
  assert.equal(f.api.count, 0, 'notices do not count as chat messages');

  f.api.addEvent('twitch', 'Viewer resubscribed for 24 months');
  f.api.addEvent('kick', 'Viewer gifted 5 subscriptions');
  const prompt = f.element(); prompt.className = 'fcm-sys fcm-sys-prompt';
  f.api.addRow(prompt);
  f.flush();
  assert.equal(f.feedEl.children.length, visible.length + 3, 'events and interactive Share rows bypass diagnostic filtering');
  assert.ok(f.feedEl.children.includes(prompt));
  f.api.destroy();
  styleChecks();
  console.log('System-message visibility regressions passed.');
}

async function coverage() {
  const inspector = require('node:inspector');
  const { promisify } = require('node:util');
  const { execFileSync } = require('node:child_process');
  const gate = require('./youtube-coverage');
  gate.selfTest();
  const session = new inspector.Session(); session.connect();
  const post = promisify(session.post.bind(session));
  await post('Debugger.enable'); await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  try {
    run();
    const { result } = await post('Profiler.takePreciseCoverage');
    const file = 'src/content/feed.js', scripts = [];
    for (const script of result.filter(item => gate.matchesFile(item, file))) {
      const { scriptSource } = await post('Debugger.getScriptSource', { scriptId: script.scriptId });
      scripts.push({ ...script, source: scriptSource });
    }
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const diff = execFileSync('git', ['diff', 'HEAD', '--no-ext-diff', '--unified=0', '--', file], { cwd: ROOT, encoding: 'utf8' });
    const selected = gate.selectedLines(source, diff, false);
    assert.ok(selected.size, 'coverage requires a changed runtime selection');
    const report = gate.report(file, source, scripts, selected);
    const lines = report.lines.filter(line => line.covered).length;
    const functions = [...report.functions.values()].filter(Boolean).length;
    const ranges = [...report.ranges.values()].filter(Boolean).length;
    console.log(`${file}: changed executable lines ${lines}/${report.lines.length}; functions ${functions}/${report.functions.size}; V8 ranges ${ranges}/${report.ranges.size}`);
    assert.ok(report.passed, JSON.stringify(report.lines.filter(line => !line.covered)));
  } finally {
    await post('Profiler.stopPreciseCoverage'); session.disconnect();
  }
}

module.exports = { run };
if (require.main === module) (process.argv.includes('--coverage') ? coverage() : Promise.resolve().then(run))
  .catch(error => { console.error(error); process.exitCode = 1; });
