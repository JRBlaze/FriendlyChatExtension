// Layout contracts for slimmer controls; actual geometry is checked in-browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
function declarations(selector) {
  const css = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return Object.fromEntries(rules.filter(rule => rule[1].trim() === selector).flatMap(rule =>
    rule[2].replace(/\/\*[\s\S]*?\*\//g, '').split(';').map(part => part.trim().split(/:(.*)/s).slice(0, 2)).filter(pair => pair.length === 2).map(([key, value]) => [key.trim(), value.trim()])));
}
function run() {
  const css = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'src/content/overlay.js'), 'utf8');
  assert.ok(parseFloat(declarations('.fcm-icon-btn').width) >= 24, 'header controls retain usable pointer targets');
  assert.ok(parseFloat(declarations('.fcm-icon-btn').height) >= 24);
  assert.ok(parseFloat(declarations('.fcm-input')['min-height']) >= 28, 'compact composer still provides a full input line');
  assert.equal(declarations('.fcm-input')['min-width'], '0', 'input can shrink in a narrow panel');
  assert.equal(declarations('.fcm-feed')['min-height'], '0', 'menus never force the feed outside its panel');
  assert.match(css, /\.fcm-section-toggle:focus-visible\s*\{[^}]*outline:/, 'disclosures remain keyboard-visible');
  assert.equal(declarations('.fcm-chip-btn')['max-width'], '100%', 'long channel controls stay inside the panel');
  assert.equal(declarations('.fcm-chip-btn > span:not(.fcm-live-dot):not(.fcm-live-pip)')['overflow-wrap'], 'break-word', 'full names can wrap without clipping');
  assert.match(source, /<details class="fcm-platform-section" open>/);
  assert.match(source, /<details class="fcm-send-section" open>/, 'existing defaults and native disclosures remain intact');
  assert.ok(source.includes('role="status" aria-live="polite"'), 'discovery notices stay announced');
  assert.equal(declarations('.fcm-send-section[open] .fcm-target-summary').display, 'none', 'only expanded routing has a duplicate summary');
  assert.equal(declarations('.fcm-send-section:not([open]) .fcm-target-summary').display, undefined, 'collapsed destinations are not hidden');
  assert.equal(declarations('.fcm-platform-notice').display, undefined, 'discovery remains visible in both states');
  console.log('Compact overlay layout and disclosure contracts passed.');
}
module.exports = { run };
if (require.main === module) run();
