// The shipped guide over synthetic extension APIs. No accounts or services are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');

function extensionFixture(mode) {
  const events = [];
  const state = window.__setup = { requests: [], settings: 0, accounts: {
    twitch: { connected: false, login: '' }, kick: { connected: false, login: '' },
  }, cancelledKick: false, youtubeGranted: false, youtubeOutcome: 'deny', permissionRequests: [] };
  const added = new Set(), removed = new Set();
  const permissionEvent = listeners => ({ addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) });
  window.chrome = {
    runtime: {
      getURL: file => `${mode === 'firefox' ? 'moz-extension' : 'chrome-extension'}://fixture/${file}`,
      async sendMessage(message) {
        state.requests.push({ ...message, gesture: navigator.userActivation.isActive });
        if (message.cmd === 'quickStartConnect') {
          if (message.platform === 'kick' && !state.cancelledKick) { state.cancelledKick = true; return { ok: false, code: 'failed' }; }
          state.accounts[message.platform] = { connected: true, login: message.platform === 'twitch' ? '<FixtureViewer>' : 'KickViewer' };
        }
        return { ok: true, accounts: JSON.parse(JSON.stringify(state.accounts)) };
      },
      async openOptionsPage() { state.settings++; },
    },
    storage: { onChanged: { addListener: fn => events.push(fn), removeListener: fn => events.splice(events.indexOf(fn), 1) } },
    permissions: {
      async contains() { return state.youtubeGranted; },
      async request(permission) {
        state.permissionRequests.push({ ...permission, gesture: navigator.userActivation.isActive });
        if (state.youtubeOutcome === 'error') throw Error('Synthetic browser refusal');
        state.youtubeGranted = state.youtubeOutcome === 'allow';
        if (state.youtubeGranted) added.forEach(fn => fn(permission));
        return state.youtubeGranted;
      },
      onAdded: permissionEvent(added), onRemoved: permissionEvent(removed),
    },
  };
}

async function run(output) {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css'
        : file.endsWith('.png') ? 'image/png' : 'text/html');
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, coverage = [], results = [];
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const mode of ['chrome', 'firefox']) {
      const context = await browser.newContext({ viewport: { width: 1120, height: 950 } });
      const blocked = [], errors = [];
      try {
        await context.route('**/*', route => {
          if (new URL(route.request().url()).origin === origin) return route.continue();
          blocked.push(route.request().url()); return route.abort();
        });
        await context.addInitScript(extensionFixture, mode);
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.coverage.startJSCoverage({ resetOnNavigation: false });
        await page.goto(`${origin}/src/setup/quick-start.html?source=install`);
        await page.waitForFunction(() => !document.querySelector('#connect-twitch').disabled);
        assert.equal(await page.locator('#step-1').isVisible(), true);
        assert.equal(await page.locator('#step-2').isVisible(), false);
        assert.deepEqual(await page.evaluate(() => __setup.requests.filter(request => request.cmd === 'quickStartConnect')), []);
        assert.deepEqual(await page.evaluate(() => __setup.permissionRequests), [], 'opening the guide does not prompt');
        await page.screenshot({ path: path.join(output, `${mode}-welcome.png`), fullPage: true });
        await page.locator('#next').focus(); await page.keyboard.press('Enter');
        assert.equal(await page.locator('#title-2').evaluate(el => document.activeElement === el), true);
        await page.waitForFunction(() => !document.querySelector('#allow-youtube').disabled);
        await page.screenshot({ path: path.join(output, `${mode}-accounts-initial.png`), fullPage: true });
        await page.locator('#connect-twitch').click();
        await page.waitForFunction(() => document.querySelector('#connect-twitch').textContent === 'Twitch connected');
        assert.match(await page.locator('#account-twitch').textContent(), /<FixtureViewer>/);
        assert.equal(await page.locator('#account-twitch img').count(), 0);
        await page.locator('#connect-kick').click();
        await page.waitForFunction(() => /not completed/.test(document.querySelector('#status').textContent));
        await page.locator('#connect-kick').click();
        await page.waitForFunction(() => document.querySelector('#connect-kick').textContent === 'Kick connected');
        const connects = await page.evaluate(() => __setup.requests.filter(request => request.cmd === 'quickStartConnect'));
        assert.ok(connects.every(request => request.gesture), 'connect requests originate in genuine user gestures');
        await page.locator('#allow-youtube').click();
        await page.waitForFunction(() => /not granted/.test(document.querySelector('#youtube-status').textContent));
        assert.equal(await page.locator('#next').isEnabled(), true, 'denial leaves Continue available');
        await page.evaluate(() => { __setup.youtubeOutcome = 'error'; });
        await page.locator('#allow-youtube').click();
        await page.waitForFunction(() => /could not grant/.test(document.querySelector('#youtube-status').textContent));
        await page.evaluate(() => { __setup.youtubeOutcome = 'allow'; });
        await page.locator('#allow-youtube').click();
        await page.waitForFunction(() => document.querySelector('#allow-youtube').textContent === 'YouTube access allowed');
        const permissionRequests = await page.evaluate(() => __setup.permissionRequests);
        assert.equal(permissionRequests.length, 3);
        assert.ok(permissionRequests.every(request => request.gesture && request.origins.join() === 'https://www.youtube.com/*'));
        await page.screenshot({ path: path.join(output, `${mode}-accounts.png`), fullPage: true });
        await page.setViewportSize({ width: 360, height: 820 });
        for (const stage of ['accounts', 'settings', 'complete']) {
          assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true, `${mode} ${stage} fits 360px`);
          await page.screenshot({ path: path.join(output, `${mode}-${stage}-360.png`), fullPage: true });
          if (stage === 'accounts') await page.locator('#next').click();
          if (stage === 'settings') await page.locator('#settings').click();
        }
        assert.equal(await page.evaluate(() => __setup.settings), 1);
        assert.equal(await page.locator('#complete-title').evaluate(el => document.activeElement === el), true);
        await page.goto(`${origin}/src/setup/quick-start.html?source=manual`);
        await page.waitForFunction(() => !document.querySelector('#connect-twitch').disabled);
        await page.locator('#next').click(); await page.locator('#next').click(); await page.locator('#skip').click();
        assert.equal(await page.locator('#complete').isVisible(), true);
        assert.equal(await page.evaluate(() => __setup.settings), 0);
        assert.deepEqual(await page.evaluate(() => __setup.requests.filter(request => request.cmd === 'quickStartConnect')), []);
        assert.deepEqual(await page.evaluate(() => __setup.permissionRequests), [], 'skip never prompts for YouTube');
        await page.locator('#review').click();
        assert.equal(await page.locator('#step-1').isVisible(), true);
        coverage.push(...await page.coverage.stopJSCoverage());
        assert.deepEqual(errors, []);
        assert.deepEqual(blocked, [], 'guide initiates no remote requests');
        results.push({ mode, nativeBrowser: 'Chrome', narrowWidth: 360, errors, blocked });
      } finally { await context.close(); }
    }
    fs.writeFileSync(path.join(output, 'browser-coverage.json'), JSON.stringify(coverage));
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log('Quick-start browser fixtures passed: Chrome and simulated Firefox; 1120px and 360px.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

module.exports = { run };
if (require.main === module) run(path.resolve(process.argv[2])).catch(error => { console.error(error); process.exitCode = 1; });
