// Combined actual-source coverage for YouTube support and issues #62-64.
// node tests/release-coverage.js [--changed-only] <node-output.json> <browser-coverage.json> [...]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const inspector = require('node:inspector');
const { promisify } = require('node:util');
const { execFileSync } = require('node:child_process');
const gate = require('./youtube-coverage');
const ROOT = path.resolve(__dirname, '..');

function targets(changedOnly = false) {
  const selected = new Map((changedOnly ? [] : gate.targets()).map(target => [target.file, target]));
  const changed = execFileSync('git', ['diff', 'HEAD', '--name-only', '--', 'src'], { cwd: ROOT, encoding: 'utf8' });
  const added = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'src'], { cwd: ROOT, encoding: 'utf8' });
  for (const [files, whole] of [[changed, false], [added, true]]) {
    for (const file of files.trim().split(/\r?\n/).filter(file => file.endsWith('.js'))) {
      if (!selected.has(file)) selected.set(file, { file, whole });
    }
  }
  return [...selected.values()];
}

function selfTest() {
  gate.selfTest();
  const selected = targets();
  assert.equal(new Set(selected.map(target => target.file)).size, selected.length);
  assert.ok(selected.some(target => target.file === 'src/content/youtube-controls.js' && target.whole));
  assert.ok(targets(true).every(target => selected.some(item => item.file === target.file)));
  assert.equal(new Set(targets(true).map(target => target.file)).size, targets(true).length);
}

async function main(args) {
  selfTest();
  if (args[0] === '--self-test') return;
  if (!args[0]) throw Error('A node coverage output path is required.');
  const changedOnly = args[0] === '--changed-only';
  if (changedOnly) args.shift();
  const selected = targets(changedOnly), session = new inspector.Session();
  session.connect();
  const post = promisify(session.post.bind(session)), scripts = [];
  await post('Debugger.enable'); await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  try {
    for (const name of ['release-notes', 'feed-performance', 'native-performance', 'recent-emotes', 'youtube-reader', 'youtube-transport', 'youtube-send', 'youtube-storage-access', 'youtube-send-transport', 'youtube-sending-ui', 'youtube-resolve-route', 'youtube-lookup',
      'youtube-suggestions', 'youtube-hints', 'youtube-view', 'youtube-controls', 'youtube-links', 'youtube-links-backup', 'youtube-permission',
      'youtube-access-card', 'youtube-onboarding', 'youtube-trial', 'youtube-integration', 'issue-62', 'issue-63', 'issue-64']) {
      const suite = require(`./${name}.test`);
      await (typeof suite === 'function' ? suite : suite.run)();
    }
    const { result } = await post('Profiler.takePreciseCoverage');
    for (const script of result.filter(script => selected.some(({ file }) => gate.matchesFile(script, file)))) {
      const { scriptSource } = await post('Debugger.getScriptSource', { scriptId: script.scriptId });
      scripts.push({ ...script, source: scriptSource });
    }
  } finally {
    await post('Profiler.stopPreciseCoverage'); session.disconnect();
  }
  fs.writeFileSync(args[0], JSON.stringify(scripts));
  for (const file of args.slice(1)) scripts.push(...JSON.parse(fs.readFileSync(file, 'utf8')));
  let failed = false;
  for (const { file, whole } of selected) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const diff = whole ? '' : execFileSync('git', ['diff', 'HEAD', '--no-ext-diff', '--unified=0', '--', file],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const report = gate.report(file, source, scripts.filter(script => gate.matchesFile(script, file)), gate.selectedLines(source, diff, whole));
    const lines = report.lines.filter(line => line.covered).length;
    const functions = [...report.functions.values()].filter(count => count > 0).length;
    const ranges = [...report.ranges.values()].filter(Boolean).length;
    console.log(`${file}: ${whole ? 'full' : 'changed'} lines ${lines}/${report.lines.length}; functions ${functions}/${report.functions.size}; V8 ranges ${ranges}/${report.ranges.size}`);
    report.lines.filter(line => !line.covered).forEach(line => console.log(`  UNCOVERED line ${line.line}`));
    for (const [key, covered] of report.ranges) if (!covered) {
      const [start, end] = key.split(':').map(Number);
      console.log(`  UNCOVERED range line ${source.slice(0, start).split('\n').length}: ${source.slice(start, end).trim().slice(0, 160)}`);
    }
    if (!report.passed) failed = true;
  }
  if (failed) process.exitCode = 1;
}

module.exports = { targets, selfTest, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
