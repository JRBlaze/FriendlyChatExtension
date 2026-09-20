// Node's built-in V8 profiler: no instrumentation or downloaded dependencies.
// Optional third argument: raw Playwright Chromium JS coverage from the UI harness.
const inspector = require('node:inspector');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

async function main() {
  const session = new inspector.Session();
  session.connect();
  const post = promisify(session.post.bind(session));
  await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  await require('./update-display')();
  const { result } = await post('Profiler.takePreciseCoverage');
  await post('Profiler.stopPreciseCoverage');
  session.disconnect();
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(result));
  if (process.argv[3]) result.push(...JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
  const targets = [
    ['src/shared/util.js', [['  FCM.displayFontKey =', '  FCM.escapeHtml =']]],
    ['src/background/updates.js', [["  if (typeof chrome !== 'undefined'", '  // The repo itself']]],
  ];
  if (process.argv[3]) targets.push(['src/content/overlay.js', [
    ['    const displayFont =', '    /**'],
    ['      const fontInput =', '      /**'],
    ['      displayFont.refresh();'],
    ['      applyDisplayFont();'],
    ['        await Promise.all([loadGeometry(), loadSendTargets(), displayFont.refresh()]);'],
    ['        displayFont.destroy();'],
  ]]);
  else console.log('Overlay UI coverage requires the browser coverage JSON as the third argument.');
  let failed = false;
  for (const [file, markers] of targets) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const scopes = markers.flatMap(([first, last]) => {
      const spans = [];
      let start = source.indexOf(first);
      if (start < 0) throw Error(`Coverage target missing: ${file}: ${first}`);
      do {
        const end = last ? source.indexOf(last, start + first.length) : source.indexOf('\n', start);
        if (end <= start) throw Error(`Invalid coverage target: ${file}: ${first}`);
        spans.push([start, end]);
        start = last ? -1 : source.indexOf(first, end);
      } while (start >= 0);
      return spans;
    });
    const selected = offset => scopes.some(([a,b]) => offset >= a && offset < b);
    const scripts = result.filter(s => s.url.replaceAll('\\', '/').split('?')[0].endsWith(file));
    if (scripts.some(script => script.source && script.source !== source)) throw Error('Stale browser coverage: ' + file);
    const ranges = new Map(), functions = new Map();
    for (const script of scripts) {
      for (const fn of script.functions) {
        const root = fn.ranges[0];
        if (selected(root.startOffset)) {
          const id = `${root.startOffset}:${root.endOffset}`;
          functions.set(id, (functions.get(id) || 0) + root.count);
        }
        for (const r of fn.ranges) {
          if (!selected(r.startOffset)) continue;
          const id = `${r.startOffset}:${r.endOffset}`;
          ranges.set(id, (ranges.get(id) || 0) + r.count);
        }
      }
    }
    const lines = [];
    let offset = 0;
    for (const text of source.split('\n')) {
      const trimmed = text.trim();
      const point = offset + text.search(/\S/);
      if (selected(point) && trimmed && !/^(\/\/|\*|[{}\]);,]+$)/.test(trimmed)) {
        const executed = scripts.some(script => {
          const enclosing = script.functions.flatMap(fn => fn.ranges)
            .filter(r => r.startOffset <= point && r.endOffset > point)
            .sort((a,b) => (a.endOffset-a.startOffset)-(b.endOffset-b.startOffset));
          return enclosing.length && enclosing[0].count > 0;
        });
        lines.push({ executed, point });
      }
      offset += text.length + 1;
    }
    const missing = [...ranges].filter(([, count]) => !count);
    const missingFunctions = [...functions].filter(([, count]) => !count);
    const missingLines = lines.filter(line => !line.executed);
    console.log(`${file}: lines ${lines.length-missingLines.length}/${lines.length}; functions ${functions.size-missingFunctions.length}/${functions.size}; V8 ranges ${ranges.size-missing.length}/${ranges.size}`);
    for (const [id] of missing) {
      const [a,b] = id.split(':').map(Number);
      console.log(`  UNCOVERED line ${source.slice(0,a).split('\n').length}: ${source.slice(a,b).trim().slice(0,160)}`);
    }
    for (const { point } of missingLines) console.log(`  UNCOVERED line ${source.slice(0,point).split('\n').length}`);
    if (!scripts.length || missing.length || missingFunctions.length || missingLines.length) failed = true;
  }
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
