// Offline rendered checks using installed Chrome; Firefox mode uses the same
// harness in Chromium and does not certify native Firefox behavior.
// FCM_PLAYWRIGHT_PATH=<existing playwright> node tests/system-messages-browser.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || 'dist/system-messages');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const mode of ['chrome', 'firefox']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(`${origin}/tests/harness.html?browser=${mode}`);
      await page.waitForFunction(() => !!window.overlay);
      const feed = page.locator('.fcm-feed');
      await page.evaluate(() => {
        overlay.sys('Connecting to Kick: bwana...');
        overlay.sys('Loaded 201 cached Kick emotes');
        overlay.sys('Loaded 45 third-party emotes (7TV/BTTV/FFZ)');
        overlay.sys('Kick: chat service changed — switching to its current connection');
        overlay.sys('Connected to Kick: bwana');
        overlay.setSubscription('twitch', { subscribed: true, tier: 1, months: 24 });
        overlay.event('twitch', 'Your Drop is ready to claim');
      });
      await page.locator('[data-act="share-streak"]').click();
      const prompt = feed.locator('.fcm-sys-prompt').first();
      await prompt.waitFor();
      assert.equal(await feed.getByText(/Connecting to|Loaded \d+|chat service changed|Connected to/).count(), 0);
      assert.equal(await feed.getByText(/You are subscribed to/).count(), 1);
      assert.equal(await feed.getByText('Your Drop is ready to claim').count(), 1);

      for (const theme of ['dark', 'light']) {
        await page.evaluate(async theme => {
          overlay.applyStoredSettings({ ...await FCM.loadSettings(), theme, autoClaimBonus: false });
        }, theme);
        for (const width of [260, 460]) {
          await page.evaluate(width => { document.querySelector('.chatcol').style.width = `${width}px`; }, width);
          await page.waitForFunction(width => {
            const panel = document.getElementById('friendly-chat-merge-host').shadowRoot.querySelector('.fcm-panel');
            return Math.abs(panel.getBoundingClientRect().width - width) < 3;
          }, width);
          await prompt.scrollIntoViewIfNeeded();
          const geometry = await prompt.evaluate(row => {
            const rect = row.getBoundingClientRect();
            return [...row.querySelectorAll('button')].map(button => {
              const box = button.getBoundingClientRect();
              return { height: box.height, inside: box.left >= rect.left && box.right <= rect.right,
                cursor: getComputedStyle(button).cursor };
            });
          });
          assert.equal(geometry.length, 3);
          geometry.forEach(button => {
            assert.ok(button.height >= 26); assert.ok(button.inside); assert.equal(button.cursor, 'pointer');
          });
          const share = prompt.getByRole('button', { name: 'Share', exact: true });
          await share.evaluate(button => { button.style.transition = 'none'; });
          const fill = await share.evaluate(button => getComputedStyle(button).backgroundColor);
          await share.hover();
          assert.equal(await share.evaluate(button => getComputedStyle(button).backgroundColor), fill, 'hover keeps Share filled');
          if (width === 460) {
            await page.locator('.fcm-panel').screenshot({ path: path.join(output, `${mode}-${theme}.png`) });
            await prompt.screenshot({ path: path.join(output, `${mode}-${theme}-reminder.png`) });
          }
        }
      }
      await page.evaluate(() => {
        document.querySelector('.chatcol').style.width = '260px';
        document.getElementById('friendly-chat-merge-host').shadowRoot.querySelector('.fcm-root').style.setProperty('--fcm-size', '22px');
      });
      await prompt.scrollIntoViewIfNeeded();
      assert.equal(await prompt.evaluate(row => row.scrollWidth <= row.clientWidth), true, 'large text wraps inside a narrow reminder');
      await page.evaluate(() => {
        window.fixtureShares = 0;
        document.querySelector('.native-prompt button').addEventListener('click', () => window.fixtureShares++);
      });
      const share = prompt.getByRole('button', { name: 'Share', exact: true });
      await share.focus(); await page.keyboard.press('Shift');
      assert.equal(await share.evaluate(button => getComputedStyle(button).outlineWidth), '2px');
      await share.press('Enter');
      assert.equal(await page.evaluate(() => window.fixtureShares), 1, 'explicit keyboard action presses native Share once');
      assert.equal(await prompt.locator('.fcm-prompt-actions').isVisible(), false);
      await page.locator('[data-act="share-resub"]').click();
      const resub = feed.locator('.fcm-sys-prompt').filter({ hasText: 'Your 12-month resub' });
      await resub.waitFor();
      await resub.getByTitle('Hide this reminder').click();
      assert.equal(await resub.count(), 0);
      assert.equal(await page.evaluate(() => window.fixtureShares), 1, 'dismissal never shares');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`${mode} harness: diagnostics hidden, personal events retained, dark/light 260/460px, keyboard Share and dismissal passed`);
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
