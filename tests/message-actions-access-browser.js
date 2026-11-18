const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
async function run(output) {
  fs.mkdirSync(output, { recursive: true });
  const errors = [], profiles = [], styles = [], results = [];
  const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    try {
      let body = fs.readFileSync(file);
      if (file.endsWith('harness.html')) body = body.toString().replace('  let overlay = FCM.createOverlay({',
        '  mem.local.fcm_settings_v1={...FCM.DEFAULT_SETTINGS,autoClaimBonus:false,watchWhenLive:false,animations:false};\n  let overlay = FCM.createOverlay({');
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`; let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const mode of ['chrome', 'firefox']) for (const touch of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 850 }, hasTouch: touch });
      try {
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
        await page.coverage.startJSCoverage({ resetOnNavigation: false });
        const cdp = await context.newCDPSession(page);
        await cdp.send('DOM.enable'); await cdp.send('CSS.enable'); await cdp.send('CSS.startRuleUsageTracking');
        await page.goto(origin + '/tests/harness.html?browser=' + mode);
        await page.addStyleTag({ content: '.devbar{display:none!important}' });
        await page.waitForFunction(() => document.getElementById('friendly-chat-merge-host')?.shadowRoot.querySelector('style')?.textContent.includes('pointer: coarse'));
        await page.evaluate(() => {
          window.copied = [];
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => copied.push(text) } });
          const root = document.getElementById('friendly-chat-merge-host').shadowRoot;
          const size = document.createElement('style'); size.textContent = '.fcm-panel{left:20px!important;top:20px!important;width:280px!important;height:700px!important}'; root.appendChild(size);
          overlay.setModerator('twitch', false);
          for (const platform of ['twitch', 'kick', 'youtube']) overlay.chat({ platform, author: 'Reader', messageId: 'access-' + platform, text: 'Accessible ' + platform });
        });
        const host = page.locator('#friendly-chat-merge-host');
        for (const platform of ['twitch', 'kick', 'youtube']) {
          const row = host.locator(`.fcm-msg[data-msg-id="access-${platform}"]`); await row.waitFor({ state: 'attached' });
          // Optional YouTube is not connected in this network-isolated fixture.
          await row.evaluate(el => el.classList.remove('fcm-hide'));
          if (touch) {
            await row.locator('.fcm-body').tap();
          } else {
            await row.evaluate(el => {
              const before = document.createElement('button'); before.id = 'tab-start'; before.textContent = 'Keyboard test';
              el.before(before); before.focus();
            });
            await page.mouse.move(900, 800); await page.keyboard.press('Tab');
            assert.equal(await row.evaluate(el => el.getRootNode().activeElement === el), true, 'Tab reaches message without hovering');
            assert.equal(await row.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
          }
          const bar = row.locator('.fcm-row-actions'); await bar.waitFor({ state: 'visible' });
          const reply = bar.getByRole('button', { name: 'Reply', exact: true });
          if (touch) {
            const box = await reply.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
            await reply.tap();
          } else {
            await page.keyboard.press('Tab'); assert.equal(await reply.evaluate(el => el.getRootNode().activeElement === el), true);
            assert.equal(await reply.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
            await page.keyboard.press('Enter');
          }
          assert.match(await host.locator('.fcm-input').evaluate(el => el.value), /@Reader/);
          if (touch) await row.locator('.fcm-body').tap();
          else { await row.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); }
          const copy = bar.getByRole('button', { name: 'Copy', exact: true });
          if (touch) await copy.tap(); else await page.keyboard.press('Space');
          assert.equal(await page.evaluate(() => copied.at(-1)), 'Accessible ' + platform);
          if (!touch) await row.evaluate(el => el.previousElementSibling.remove());
        }
        for (const theme of ['dark', 'light']) {
          await page.evaluate(theme => overlay.applyStoredSettings({ ...FCM.DEFAULT_SETTINGS, theme, autoClaimBonus: false, watchWhenLive: false }), theme);
          await host.locator('.fcm-msg[data-msg-id="access-twitch"]').focus();
          await page.screenshot({ path: path.join(output, `${mode}-${touch ? 'touch' : 'keyboard'}-${theme}.png`) });
          results.push({ mode, touch, theme, width: 280, passed: true });
        }
        const notes = await context.newPage(); await notes.goto(origin + '/src/releases/notes.html');
        assert.equal(await notes.locator('section h2').first().textContent(), 'Version 1.23.14');
        for (const version of ['1.23.12', '1.23.13', '1.23.14']) assert.equal(await notes.getByRole('heading', { name: 'Version ' + version, exact: true }).count(), 1);
        await notes.screenshot({ path: path.join(output, `${mode}-${touch ? 'touch' : 'keyboard'}-notes.png`), fullPage: true });
        profiles.push(...await page.coverage.stopJSCoverage());
        const { ruleUsage } = await cdp.send('CSS.stopRuleUsageTracking');
        for (const id of new Set(ruleUsage.filter(rule => rule.used).map(rule => rule.styleSheetId))) {
          const { text } = await cdp.send('CSS.getStyleSheetText', { styleSheetId: id });
          styles.push({ text, ranges: ruleUsage.filter(rule => rule.used && rule.styleSheetId === id).map(rule => ({ start: rule.startOffset, end: rule.endOffset })) });
        }
      } finally { await context.close(); }
    }
    assert.deepEqual(errors, []);
    const css = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
    for (const selector of ['.fcm-msg:focus-visible', '.fcm-row-actions button:focus-visible', '.fcm-row-actions button { min-width: 44px']) {
      const start = css.indexOf(selector); assert.ok(start > 0);
      assert.ok(styles.some(entry => entry.text === css && entry.ranges.some(range => range.start <= start && range.end >= start)), selector + ' exercised');
    }
    fs.writeFileSync(path.join(output, 'browser-coverage.json'), JSON.stringify(profiles));
    fs.writeFileSync(path.join(output, 'css-coverage.json'), JSON.stringify(styles));
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log('Keyboard/touch and bundled notes browser checks passed in Chrome/simulated Firefox, both themes.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
module.exports = { run };
if (require.main === module) run(path.resolve(process.argv[2])).catch(error => { console.error(error); process.exitCode = 1; });
