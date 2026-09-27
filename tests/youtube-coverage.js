// Actual-source V8 coverage for optional YouTube support. No coverage exclusions.
// node tests/youtube-coverage.js <node-output.json> [browser-coverage.json]
// node tests/youtube-coverage.js --self-test
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const inspector = require('node:inspector');
const { promisify } = require('node:util');
const { execFileSync } = require('node:child_process');
const pack = require('../tools/pack');
const ROOT = path.resolve(__dirname, '..');
const EXISTING = ['src/shared/constants.js', 'src/content/render.js', 'src/content/compose.js',
  'src/content/overlay.js', 'src/content/sites.js', 'src/background/service-worker.js'];

function normalizedUrl(value) {
  try { return decodeURIComponent(String(value).split(/[?#]/)[0]).replaceAll('\\', '/'); }
  catch { return ''; }
}

function matchesFile(script, file) {
  const url = normalizedUrl(script.url).toLowerCase(), name = file.toLowerCase();
  return url === name || url.endsWith(`/${name}`);
}

function executedAt(scripts, point, source) {
  return scripts.some(script => {
    // Full-source equality prevents a padded unit scope or stale browser copy
    // from crediting text that never executed in the current actual file.
    if (script.source !== source) return false;
    const ranges = script.functions.flatMap(fn => fn.ranges)
      .filter(range => range.startOffset <= point && range.endOffset > point)
      .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
    return ranges.length > 0 && ranges[0].count > 0;
  });
}

function executedRange(scripts, start, end, source) {
  const cuts = new Set([start, end]);
  for (const script of scripts) for (const fn of script.functions) for (const range of fn.ranges) {
    if (range.startOffset > start && range.startOffset < end) cuts.add(range.startOffset);
    if (range.endOffset > start && range.endOffset < end) cuts.add(range.endOffset);
  }
  const points = [...cuts].sort((a, b) => a - b);
  return points.slice(0, -1).every((point, index) => {
    const offset = source.slice(point, points[index + 1]).search(/\S/);
    return offset < 0 || executedAt(scripts, point + offset, source);
  });
}

function selectedLines(source, diff, wholeFile) {
  if (wholeFile) return new Set(source.split('\n').map((_, index) => index + 1));
  const changed = new Set();
  for (const hunk of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let line = start; line < start + count; line++) changed.add(line);
  }
  return changed;
}

function report(file, source, scripts, changed) {
  if (!scripts.length) throw Error(`Missing actual-source coverage: ${file}`);
  if (scripts.some(script => script.source !== source)) throw Error(`Stale or padded source coverage: ${file}`);
  let offset = 0;
  const spans = [], lines = [];
  source.split('\n').forEach((text, index) => {
    if (changed.has(index + 1)) {
      spans.push([offset, offset + text.length + 1]);
      const clean = text.trim();
      if (clean && !/^(\/\/|\*|[{}\]);,]+$)/.test(clean)) {
        lines.push({ line: index + 1, covered: executedAt(scripts, offset + text.search(/\S/), source) });
      }
    }
    offset += text.length + 1;
  });
  const selected = point => spans.some(([start, end]) => point >= start && point < end);
  const functions = new Map(), ranges = new Map();
  for (const script of scripts) for (const fn of script.functions) {
    const root = fn.ranges[0];
    if (selected(root.startOffset)) {
      const key = `${root.startOffset}:${root.endOffset}`;
      functions.set(key, (functions.get(key) || 0) + root.count);
    }
    for (const range of fn.ranges) if (selected(range.startOffset)) {
      const key = `${range.startOffset}:${range.endOffset}`;
      ranges.set(key, executedRange(scripts, range.startOffset, range.endOffset, source));
    }
  }
  return { file, lines, functions, ranges,
    passed: lines.length > 0 && lines.every(line => line.covered)
      && [...functions.values()].every(count => count > 0) && [...ranges.values()].every(Boolean) };
}

function selfTest() {
  const source = 'abcdef';
  const first = { source, functions: [{ ranges: [
    { startOffset: 0, endOffset: 6, count: 1 }, { startOffset: 2, endOffset: 4, count: 0 },
  ] }] };
  assert.equal(executedAt([first], 1, source), true);
  assert.equal(executedAt([first], 3, source), false, 'a nested zero must override its executed parent');
  assert.equal(executedAt([], 0, source), false);
  assert.equal(executedAt([{ ...first, source: '      ' }], 1, source), false, 'blank padding cannot credit code');
  assert.equal(executedAt([{ ...first, source: null }], 1, source), false);
  assert.equal(executedAt([first], 8, source), false);
  assert.equal(executedRange([first], 0, 6, source), false);
  const second = { source, functions: [{ ranges: [{ startOffset: 2, endOffset: 4, count: 1 }] }] };
  assert.equal(executedRange([first, second], 0, 6, source), true, 'independently exercised ranges combine by partitions');
  assert.equal(executedRange([], 0, 3, '   '), true);
  assert.equal(matchesFile({ url: 'file:///C:/a%20b/src/content/render.js' }, 'src/content/render.js'), true);
  assert.equal(matchesFile({ url: 'C:\\a\\src\\content\\render.js?fixture' }, 'src/content/render.js'), true);
  assert.equal(matchesFile({ url: 'src/content/render.js' }, 'src/content/render.js'), true);
  assert.equal(matchesFile({ url: 'bad%url' }, 'src/content/render.js'), false);
  assert.equal(matchesFile({ url: 'src/other.js' }, 'src/content/render.js'), false);
  const full = selectedLines('one\ntwo\n', '', true);
  assert.deepEqual([...full], [1, 2, 3], 'a new/untracked file has full scope even without a git diff');
  assert.deepEqual([...selectedLines('ignored', '@@ -1 +3,2 @@\n@@ -7 +9 @@\n@@ -8 +10,0 @@', false)], [3, 4, 9]);
  assert.deepEqual([...selectedLines('ignored', '', false)], []);
  assert.throws(() => report('fixture.js', source, [], new Set([1])), /Missing/);
  assert.throws(() => report('fixture.js', source, [{ ...first, source: 'padded' }], new Set([1])), /Stale/);
  assert.equal(report('fixture.js', source, [first], new Set([1])).passed, false);
  assert.equal(report('fixture.js', source, [first, second], new Set([1])).passed, true);
  assert.equal(report('fixture.js', source, [first, second], new Set()).passed, false);
  console.log('YouTube coverage gate self-tests passed.');
}

function targets() {
  const fresh = pack.collect(ROOT).filter(file => file.startsWith('src/') && file.endsWith('.js')
    && (path.basename(file).startsWith('youtube') || file.startsWith('src/youtube/')));
  return [...fresh.map(file => ({ file, whole: true })), { file: 'tools/youtube-trial.js', whole: true },
    ...EXISTING.map(file => ({ file, whole: false }))];
}

async function main(args) {
  selfTest();
  if (args[0] === '--self-test') return;
  if (!args[0]) throw Error('Usage: node tests/youtube-coverage.js <node-output.json> [browser-coverage.json]');
  const selected = targets();
  const session = new inspector.Session(); session.connect();
  const post = promisify(session.post.bind(session));
  await post('Debugger.enable'); await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  const scripts = [];
  try {
    await require('./youtube-reader.test')();
    await require('./youtube-transport.test').run();
    await require('./youtube-send.test')();
    await require('./youtube-send-transport.test')();
    await require('./youtube-sending-ui.test')();
    await require('./youtube-resolve-route.test')();
    await require('./youtube-lookup.test')();
    await require('./youtube-suggestions.test')();
    await require('./youtube-hints.test')();
    await require('./youtube-view.test')();
    await require('./youtube-controls.test')();
    await require('./youtube-links.test')();
    await require('./youtube-permission.test')();
    await require('./youtube-access-card.test')();
    await require('./youtube-onboarding.test')();
    await require('./youtube-trial.test')();
    await require('./youtube-integration.test')();
    const { result } = await post('Profiler.takePreciseCoverage');
    for (const script of result.filter(value => selected.some(({ file }) => matchesFile(value, file)))) {
      const { scriptSource } = await post('Debugger.getScriptSource', { scriptId: script.scriptId });
      scripts.push({ ...script, source: scriptSource });
    }
  } finally {
    await post('Profiler.stopPreciseCoverage'); session.disconnect();
  }
  fs.writeFileSync(args[0], JSON.stringify(scripts));
  if (args[1]) scripts.push(...JSON.parse(fs.readFileSync(args[1], 'utf8')));
  let failed = false;
  for (const { file, whole } of selected) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const diff = whole ? '' : execFileSync('git', ['diff', 'HEAD', '--no-ext-diff', '--unified=0', '--', file],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const changed = selectedLines(source, diff, whole);
    try {
      const value = report(file, source, scripts.filter(script => matchesFile(script, file)), changed);
      const hit = value.lines.filter(line => line.covered).length;
      const called = [...value.functions.values()].filter(count => count > 0).length;
      const branches = [...value.ranges.values()].filter(Boolean).length;
      console.log(`${file}: ${whole ? 'full file' : 'changed'} lines ${hit}/${value.lines.length}; functions ${called}/${value.functions.size}; V8 ranges ${branches}/${value.ranges.size}`);
      value.lines.filter(line => !line.covered).forEach(line => console.log(`  UNCOVERED line ${line.line}`));
      for (const [key, covered] of value.ranges) if (!covered) {
        const [start, end] = key.split(':').map(Number);
        console.log(`  UNCOVERED range line ${source.slice(0, start).split('\n').length}: ${source.slice(start, end).trim().slice(0, 150)}`);
      }
      if (!value.passed) failed = true;
    } catch (error) { failed = true; console.error(error.message); }
  }
  if (failed) process.exitCode = 1;
}

module.exports = { normalizedUrl, matchesFile, executedAt, executedRange, selectedLines, report, selfTest, targets, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
