// Dependency-free V8 coverage for the changed runtime in issues #56-60.
// node tests/issue-fixes-coverage.js <node-output.json> <browser-coverage.json>
const assert = require('node:assert/strict');
const inspector = require('node:inspector');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

function executedAt(scripts, point, source) {
  return scripts.some(script => {
    // Extracted unit scopes keep original offsets and blank everything outside
    // the scope. Their top-level execution must not credit the blanked code.
    if (!script.source || script.source[point] !== source[point]) return false;
    const ranges = script.functions.flatMap(fn => fn.ranges)
      .filter(r => r.startOffset <= point && r.endOffset > point)
      .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
    return ranges.length > 0 && ranges[0].count > 0;
  });
}

// V8 emits different nested ranges as branches are exercised in different
// processes. Union their effective counts, not only identical start/end pairs.
function executedRange(scripts, start, end, source) {
  const cuts = new Set([start, end]);
  for (const script of scripts) for (const fn of script.functions) for (const r of fn.ranges) {
    if (r.startOffset > start && r.startOffset < end) cuts.add(r.startOffset);
    if (r.endOffset > start && r.endOffset < end) cuts.add(r.endOffset);
  }
  const points = [...cuts].sort((a, b) => a - b);
  return points.slice(0, -1).every((point, i) => {
    const text = source.slice(point, points[i + 1]);
    const offset = text.search(/\S/);
    return offset < 0 || executedAt(scripts, point + offset, source);
  });
}

function selfTest() {
  const script = { source: 'abcdef', functions: [{ ranges: [
    { startOffset: 0, endOffset: 6, count: 1 }, { startOffset: 2, endOffset: 4, count: 0 },
  ] }] };
  assert.equal(executedAt([script], 1, 'abcdef'), true);
  assert.equal(executedAt([script], 3, 'abcdef'), false, 'uncovered child overrides covered parent');
  assert.equal(executedAt([{ ...script, source: '      ' }], 1, 'abcdef'), false, 'blank VM padding is not code');
  assert.equal(executedAt([], 1, 'abcdef'), false);
  assert.equal(executedAt([{ ...script, source: null }], 1, 'abcdef'), false);
  assert.equal(executedRange([script], 0, 6, 'abcdef'), false);
  const alternate = { source: 'abcdef', functions: [{ ranges: [{ startOffset: 2, endOffset: 4, count: 1 }] }] };
  assert.equal(executedRange([script, alternate], 0, 6, 'abcdef'), true);
}

async function main() {
  selfTest();
  const session = new inspector.Session(); session.connect();
  const post = promisify(session.post.bind(session));
  await post('Debugger.enable'); await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  await require('./issue-fixes')();
  const { result } = await post('Profiler.takePreciseCoverage');
  const scripts = [];
  for (const script of result.filter(s => /src[\\/]content[\\/](native|overlay)\.js$/.test(s.url))) {
    const { scriptSource } = await post('Debugger.getScriptSource', { scriptId: script.scriptId });
    scripts.push({ ...script, source: scriptSource });
  }
  await post('Profiler.stopPreciseCoverage'); session.disconnect();
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(scripts));
  if (!process.argv[3]) throw Error('Current browser coverage is required for UI bindings and the periodic tick.');
  const browser = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  let failed = false;
  for (const file of ['src/content/native.js', 'src/content/overlay.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const matching = list => list.filter(s => s.url.replaceAll('\\', '/').split('?')[0].endsWith(file));
    const browserScripts = matching(browser);
    if (!browserScripts.length || browserScripts.some(s => s.source !== source)) throw Error('Missing or stale browser coverage: ' + file);
    const runs = [...matching(scripts), ...browserScripts];
    // Derive every added/changed source line from the actual diff. No manual
    // exclusion of a changed function or a failure branch to make the gate pass.
    const diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', '--', file], { cwd: ROOT, encoding: 'utf8' });
    const changed = new Set();
    for (const hunk of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let line = start; line < start + count; line++) changed.add(line);
    }
    let offset = 0;
    const spans = [], lines = [];
    source.split('\n').forEach((text, index) => {
      const clean = text.trim();
      if (changed.has(index + 1)) {
        spans.push([offset, offset + text.length + 1]);
        if (clean && !/^(\/\/|\*|[{}\]);,]+$)/.test(clean)) {
          const point = offset + text.search(/\S/);
          lines.push({ line: index + 1, executed: executedAt(runs, point, source) });
        }
      }
      offset += text.length + 1;
    });
    const selected = point => spans.some(([a, b]) => point >= a && point < b);
    const functions = new Map(), ranges = new Map();
    for (const script of runs) for (const fn of script.functions) {
      const root = fn.ranges[0];
      if (selected(root.startOffset)) {
        const key = `${root.startOffset}:${root.endOffset}`;
        functions.set(key, (functions.get(key) || 0) + root.count);
      }
      for (const range of fn.ranges) if (selected(range.startOffset)) {
        const key = `${range.startOffset}:${range.endOffset}`;
        ranges.set(key, (ranges.get(key) || 0) + range.count);
      }
    }
    const missedLines = lines.filter(line => !line.executed);
    const missedRanges = [...ranges].filter(([id, count]) => !count && !executedRange(runs, ...id.split(':').map(Number), source));
    const missedFunctions = [...functions].filter(([, count]) => !count);
    console.log(`${file}: changed executable lines ${lines.length - missedLines.length}/${lines.length}; functions ${functions.size - missedFunctions.length}/${functions.size}; V8 ranges ${ranges.size - missedRanges.length}/${ranges.size}`);
    missedLines.forEach(({ line }) => console.log(`  UNCOVERED line ${line}`));
    missedRanges.forEach(([id]) => {
      const [a, b] = id.split(':').map(Number);
      console.log(`  UNCOVERED range line ${source.slice(0, a).split('\n').length}: ${source.slice(a, b).trim().slice(0, 140)}`);
    });
    if (!lines.length || missedLines.length || missedRanges.length || missedFunctions.length) failed = true;
  }
  if (failed) process.exitCode = 1;
}
module.exports = { selfTest };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
