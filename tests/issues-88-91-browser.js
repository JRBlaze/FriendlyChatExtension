// Isolated real-DOM checks. All nonlocal requests and real clipboard writes blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
async function run(output) {
  fs.mkdirSync(output, { recursive: true });
  const errors = [], coverage = [], cssCoverage = [], results = [];
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
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const mode of ['chrome', 'firefox']) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 850 } });
      try {
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
        await page.coverage.startJSCoverage({ resetOnNavigation: false });
        const cdp = await context.newCDPSession(page);
        await cdp.send('DOM.enable'); await cdp.send('CSS.enable'); await cdp.send('CSS.startRuleUsageTracking');
        await page.goto(origin + '/tests/harness.html?browser=' + mode);
        await page.addStyleTag({ content: '.devbar{display:none!important}' });
        await page.waitForFunction(() => document.getElementById('friendly-chat-merge-host')?.shadowRoot.querySelector('style')?.textContent.includes('.fcm-row-actions'));
        await page.evaluate(() => {
          window.copied = [];
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => copied.push(text) } });
          const style = document.createElement('style'); style.textContent = '.fcm-panel{left:20px!important;top:20px!important;width:280px!important;height:720px!important}';
          document.getElementById('friendly-chat-merge-host').shadowRoot.appendChild(style);
          overlay.setStatus('twitch', 'connected', 'JRBlaze', ['Followers only (10m)', 'Subscribers only', 'Emotes only', 'Slow mode (30s)', 'Unique messages']);
          overlay.setStatus('kick', 'connected', 'JRBlaze', ['Subscribers only']);
          overlay.setModerator('twitch', false);
          for (const platform of ['twitch', 'kick']) overlay.chat({ platform, author: 'Viewer', messageId: 'november-' + platform, text: 'Copy only this message.' });
        });
        const shadow = page.locator('#friendly-chat-merge-host');
        const input = shadow.locator('.fcm-input');
        await input.click();
        await page.keyboard.type('before !yw after');
        await page.evaluate(() => {
          const box = document.getElementById('friendly-chat-merge-host').shadowRoot.querySelector('.fcm-input');
          box.setSelectionRange(7, 10);
          const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', "You're welcome!");
          box.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
        });
        assert.equal(await input.evaluate(el => el.value), "before You're welcome! after");
        await page.evaluate(() => {
          const list = document.createElement('div'); document.body.appendChild(list);
          window.noticeWatcher = FCM.createNativeEventWatcher({ id: 'twitch', messageList: () => list }, text => overlay.event('twitch', text));
          noticeWatcher.start();
          const row = document.createElement('div'); row.dataset.testSelector = 'user-notice-line';
          row.innerHTML = 'Give <a href="/target">Target</a> a shoutout!'; list.appendChild(row);
        });
        await shadow.locator('.fcm-sys-event a[href="https://www.twitch.tv/target"]').waitFor();
        for (const platform of ['twitch', 'kick']) {
          const row = shadow.locator(`.fcm-msg[data-msg-id="november-${platform}"]`);
          await row.hover();
          const actions = row.locator('.fcm-row-actions'); await actions.waitFor({ state: 'visible' });
          const bodyRect = await row.locator('.fcm-body').boundingBox(), barRect = await actions.boundingBox();
          assert.ok(barRect.y >= bodyRect.y + bodyRect.height - 1, 'shortcuts never cover message text');
          await actions.getByTitle('Copy message', { exact: true }).click();
          assert.equal(await page.evaluate(() => copied.at(-1)), 'Copy only this message.');
          await actions.getByRole('button', { name: 'Reply', exact: true }).click();
          assert.match(await input.evaluate(el => el.value), /@Viewer/);
          await actions.getByRole('button', { name: 'Copy', exact: true }).focus();
          await page.mouse.move(900, 800);
          assert.equal(await actions.isVisible(), true, 'focused controls remain available after hover ends');
        }
        const modes = shadow.locator('.fcm-chatmodes'); assert.match(await modes.textContent(), /Twitch: Followers only/);
        assert.equal(await modes.evaluate(el => el.scrollWidth <= el.clientWidth), true);
        for (const theme of ['dark', 'light']) {
          await page.evaluate(theme => overlay.applyStoredSettings({ ...FCM.DEFAULT_SETTINGS, theme, autoClaimBonus: false, watchWhenLive: false }), theme);
          await shadow.locator('.fcm-msg[data-msg-id="november-twitch"]').hover();
          await page.screenshot({ path: path.join(output, `${mode}-${theme}.png`) });
          results.push({ mode, theme, width: 280, selectionReplacement: true, actions: true, modes: true });
        }
        coverage.push(...await page.coverage.stopJSCoverage());
        const { ruleUsage } = await cdp.send('CSS.stopRuleUsageTracking');
        for (const id of new Set(ruleUsage.filter(rule => rule.used).map(rule => rule.styleSheetId))) {
          const { text } = await cdp.send('CSS.getStyleSheetText', { styleSheetId: id });
          cssCoverage.push({ text, ranges: ruleUsage.filter(rule => rule.used && rule.styleSheetId === id).map(rule => ({ start: rule.startOffset, end: rule.endOffset })) });
        }
      } finally { await context.close(); }
    }
    assert.deepEqual(errors, []);
    const css = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
    const rules = [...css.matchAll(/[^{}]+\{[^{}]*\}/g)].filter(match => /\.fcm-row-actions|\.fcm-chatmodes/.test(match[0]));
    fs.writeFileSync(path.join(output, 'css-coverage.json'), JSON.stringify(cssCoverage));
    assert.equal(rules.length, 3);
    for (const rule of rules) {
      const start = rule.index + rule[0].search(/\.fcm-/);
      assert.ok(cssCoverage.some(entry => entry.text === css && entry.ranges.some(range => range.start <= start && range.end >= start)), 'changed CSS rule exercised: ' + rule[0].trim().slice(0, 80));
    }
    fs.writeFileSync(path.join(output, 'browser-coverage.json'), JSON.stringify(coverage));
    fs.writeFileSync(path.join(output, 'css-coverage.json'), JSON.stringify(cssCoverage));
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log('November browser checks passed: Chrome and simulated Firefox, both themes, 280px.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
module.exports = { run };
if (require.main === module) run(path.resolve(process.argv[2])).catch(error => { console.error(error); process.exitCode = 1; });
