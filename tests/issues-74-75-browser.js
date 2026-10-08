// Local synthetic pages only. All outbound platform requests are blocked.
// FCM_PLAYWRIGHT_PATH=<existing-install> node tests/issues-74-75-browser.js <output>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, firefox } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');

async function check(browser, origin, mode, label, output) {
  const context = await browser.newContext();
  await context.route('**/*', route => route.request().url().startsWith(origin + '/')
    ? route.continue() : route.abort());
  try {
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/tests/harness.html?browser=${mode}`);
    await page.waitForFunction(() => !!window.switchSite);
    for (const platform of ['twitch', 'kick']) {
      await page.evaluate(platform => switchSite(platform), platform);
      const input = page.locator('.fcm-input');
      await input.fill('preserved draft');
      const [popup] = await Promise.all([page.waitForEvent('popup'),
        page.locator('.fcm-actions [data-act="popout"]').click()]);
      await popup.waitForLoadState('load');
      await popup.locator('.fcm-feed').waitFor();
      const title = `${platform === 'twitch' ? 'Twitch' : 'Kick'}/${platform === 'twitch' ? 'examplestreamer' : 'examplestreamer-kick'} — merged chat`;
      assert.equal(await popup.title(), title);
      assert.match(popup.url(), new RegExp(`^blob:${origin}/[^#]+#friendly-chat/${platform}/`));
      assert.notEqual(popup.url(), 'about:blank', 'the URL bar identifies a local Friendly Chat document');
      assert.equal(await popup.locator('.fcm-input').evaluate(node => node.value), 'preserved draft');
      await popup.screenshot({ path: path.join(output, `${label}-${platform}-popout.png`) });
      await popup.close();
      await input.waitFor();
      assert.equal(await input.evaluate(node => node.value), 'preserved draft');
    }
    await page.evaluate(async () => {
      await switchSite('twitch');
      window.nativeSends = [];
      FCM.sendViaNativeComposer = async (site, text, options) => {
        nativeSends.push({ platform: site.id, text, options }); return { ok: true };
      };
      overlay.setStatus('kick', 'connected', 'examplestreamer-kick');
      overlay.setAccounts({ twitch: { connected: true }, kick: { connected: true } });
      window.commands = [];
    });
    await page.locator('.fcm-input').fill('Cheer100 hello');
    await page.locator('.fcm-send').click();
    await page.waitForFunction(() => nativeSends.length === 1);
    assert.deepEqual(await page.evaluate(() => nativeSends), [
      { platform: 'twitch', text: 'Cheer100 hello', options: { cheer: true } },
    ]);
    assert.equal(await page.evaluate(() => commands.filter(command => command.cmd === 'send').length), 0);
    assert.equal(await page.locator('.fcm-target[data-platform="kick"]').getAttribute('data-on'), 'true');
    assert.deepEqual(errors, []);
    console.log(`${label}: Twitch/Kick loaded pop-out titles, draft return and isolated Cheer passed.`);
  } finally { await context.close(); }
}

async function main() {
  assert.ok(process.argv[2], 'An output directory is required');
  const output = path.resolve(process.argv[2]);
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.setHeader('Content-Type', (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const chrome = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      await check(chrome, origin, 'chrome', 'chrome', output);
      await check(chrome, origin, 'firefox', 'firefox-mode', output);
    } finally { await chrome.close(); }
    if (fs.existsSync(firefox.executablePath())) {
      const ff = await firefox.launch({ headless: true });
      try { await check(ff, origin, 'firefox', 'firefox', output); }
      finally { await ff.close(); }
    } else console.log('Native Firefox not run: no existing Playwright Firefox runtime.');
  } finally { server.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
