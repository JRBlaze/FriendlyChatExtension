// Collect exact VM sources while running the full suite, then gate the Git diff.
// FCM_EMOTE_COVERAGE=<output.json> node -r ./tests/emote-availability-coverage.js tests/run.js
// node tests/emote-availability-coverage.js <output.json>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const inspector = require('node:inspector');
const { execFileSync } = require('node:child_process');
const gate = require('./youtube-coverage');
const ROOT = path.resolve(__dirname, '..');

function addedFiles() {
  return execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split(/\r?\n/).filter(file => file.endsWith('.js'));
}

function changedFiles() {
  const changed = execFileSync('git', ['diff', 'HEAD', '--name-only', '--', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split(/\r?\n/).filter(file => file.endsWith('.js'));
  return [...new Set([...changed, ...addedFiles()])];
}

function collect(output) {
  const session = new inspector.Session(); session.connect();
  function post(method, params = {}) {
    let result, failure;
    session.post(method, params, (error, value) => { failure = error; result = value; });
    if (failure) throw failure;
    assert.ok(result, 'same-thread inspector response must be synchronous');
    return result;
  }
  post('Debugger.enable'); post('Profiler.enable');
  post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  process.on('exit', () => {
    const files = changedFiles();
    const { result } = post('Profiler.takePreciseCoverage');
    const scripts = result.filter(script => files.some(file => gate.matchesFile(script, file))).map(script => ({
      ...script, source: post('Debugger.getScriptSource', { scriptId: script.scriptId }).scriptSource,
    }));
    fs.writeFileSync(output, JSON.stringify(scripts));
    post('Profiler.stopPreciseCoverage'); session.disconnect();
  });
}

function selfTest() {
  gate.selfTest();
  assert.equal(gate.matchesFile({ url: 'src/content/render.js' }, 'src/content/render.js'), true);
  const source = 'const value = 1;\n';
  const script = { source, functions: [{ ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }] };
  assert.equal(gate.report('fixture.js', source, [script], new Set([1])).passed, true);
  assert.throws(() => gate.report('fixture.js', source, [{ ...script, source: 'old' }], new Set([1])), /Stale/);
  assert.throws(() => gate.report('fixture.js', source, [], new Set([1])), /Missing/);
  assert.equal(gate.report('fixture.js', source,
    [{ ...script, functions: [{ ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] }] }], new Set([1])).passed, false);
}

function report(output) {
  selfTest();
  const scripts = JSON.parse(fs.readFileSync(output, 'utf8'));
  let failed = false;
  const added = new Set(addedFiles());
  for (const file of changedFiles()) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const diff = execFileSync('git', ['diff', 'HEAD', '--no-ext-diff', '--unified=0', '--', file], { cwd: ROOT, encoding: 'utf8' });
    // Existing tests also use extracted scopes. Only full, exact sources count.
    const exact = scripts.filter(script => gate.matchesFile(script, file) && script.source === source);
    const result = gate.report(file, source, exact, gate.selectedLines(source, diff, added.has(file)));
    const lines = result.lines.filter(line => line.covered).length;
    const functions = [...result.functions.values()].filter(count => count > 0).length;
    const ranges = [...result.ranges.values()].filter(Boolean).length;
    console.log(`${file}: changed lines ${lines}/${result.lines.length}; functions ${functions}/${result.functions.size}; V8 ranges ${ranges}/${result.ranges.size}`);
    for (const line of result.lines.filter(line => !line.covered)) console.log(`  UNCOVERED line ${line.line}`);
    for (const [key, covered] of result.ranges) if (!covered) {
      const [start, end] = key.split(':').map(Number);
      console.log(`  UNCOVERED range line ${source.slice(0, start).split('\n').length}: ${source.slice(start, end).trim().slice(0, 120)}`);
    }
    if (!result.passed) failed = true;
  }
  return !failed;
}

module.exports = { selfTest, collect, report };
if (require.main !== module && process.env.FCM_EMOTE_COVERAGE) collect(process.env.FCM_EMOTE_COVERAGE);
if (require.main === module) {
  if (process.argv[2] === '--self-test') selfTest();
  else if (!process.argv[2]) throw Error('Coverage JSON path required.');
  else if (!report(process.argv[2])) process.exitCode = 1;
}
