// Real extension markup/scripts, synthetic extension APIs, and no external traffic.
// Both modes run in installed Chrome; Firefox mode does not test Firefox's native prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const pack = require('../tools/pack');
const ROOT = path.resolve(__dirname, '..');
const YOUTUBE = 'https://www.youtube.com/*';

function extensionFixture({ mode, manifest }) {
  const events = { added: [], removed: [] }, stores = { local: {}, sync: {} };
  const state = window.__permission = { granted: new URL(location.href).searchParams.has('granted'), outcome: 'deny', requests: [], closed: 0 };
  const area = name => ({
    async get(key) { return key == null ? { ...stores[name] } : { [key]: stores[name][key] }; },
    async set(patch) { Object.assign(stores[name], patch); },
    async remove(key) { delete stores[name][key]; },
  });
  state.change = granted => {
    state.granted = granted;
    events[granted ? 'added' : 'removed'].forEach(fn => fn({ origins: ['https://www.youtube.com/*'] }));
  };
  window.close = () => { state.closed++; };
  window.chrome = {
    storage: { local: area('local'), sync: area('sync'), onChanged: { addListener() {}, removeListener() {} } },
    runtime: {
      getManifest: () => manifest,
      getURL: (file = '') => `${mode === 'firefox' ? 'moz-extension' : 'chrome-extension'}://fixture/${file}`,
      openOptionsPage() {},
      sendMessage(message, callback) {
        const answer = message.cmd === 'status' ? { site: 'twitch', channel: 'syntheticstreamer', connections: {} }
          : { available: false, installed: manifest.version };
        if (callback) callback(answer);
        return Promise.resolve(answer);
      },
    },
    management: { async getSelf() { return { installType: 'development' }; } },
    tabs: { async query() { return [{ id: 1, url: 'https://www.twitch.tv/syntheticstreamer' }]; } },
    permissions: {
      async contains({ origins }) { return origins.every(origin => origin === 'https://www.youtube.com/*' ? state.granted : mode !== 'firefox'); },
      async request(details) {
        state.requests.push({ ...details, activeGesture: navigator.userActivation.isActive });
        if (state.outcome === 'error') throw Error('Synthetic browser refusal');
        if (state.outcome !== 'allow') return false;
        state.change(true);
        return true;
      },
      onAdded: { addListener(fn) { events.added.push(fn); } },
      onRemoved: { addListener(fn) { events.removed.push(fn); } },
    },
  };
}

async function run(output) {
  fs.mkdirSync(output, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const firefox = pack.firefoxManifest(manifest, fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8'));
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
      const context = await browser.newContext({ viewport: { width: 1120, height: 1000 } });
      const blocked = [], errors = [];
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        blocked.push(route.request().url());
        return route.abort();
      });
      await context.addInitScript(extensionFixture, { mode, manifest: mode === 'firefox' ? firefox : manifest });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
      for (const surface of ['welcome', 'popup', 'options']) {
        const file = surface === 'welcome' ? 'youtube/permission' : `${surface}/${surface}`;
        const button = surface === 'welcome' ? '#allow' : '#youtube-access-allow';
        const status = surface === 'welcome' ? '#status' : '#youtube-access-status';
        const width = surface === 'popup' ? 320 : 1120;
        await page.setViewportSize({ width, height: surface === 'popup' ? 600 : 1000 });
        await page.goto(`${origin}/src/${file}.html?source=update`);
        await page.waitForFunction(id => !document.querySelector(id).disabled, button);
        await page.waitForFunction(id => !document.querySelector(id).textContent.includes('Checking'), status);
        assert.deepEqual(await page.evaluate(() => __permission.requests), [], 'Opening a surface never requests access');
        if (surface !== 'welcome') assert.equal(await page.evaluate(() => FCM.BROWSER), mode);
        assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true, `${surface} has no horizontal overflow`);
        await page.screenshot({ path: path.join(output, `${mode}-${surface}-initial.png`), fullPage: true });
        if (surface !== 'popup') {
          await page.setViewportSize({ width: 420, height: 920 });
          assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true, `${surface} fits a narrow viewport`);
          await page.screenshot({ path: path.join(output, `${mode}-${surface}-420.png`), fullPage: true });
        }
        await page.locator(button).click();
        await page.waitForFunction(id => /not granted/i.test(document.querySelector(id).textContent), status);
        assert.equal(await page.locator(button).isEnabled(), true, 'Denial keeps retry available');
        await page.evaluate(() => { __permission.outcome = 'error'; });
        await page.locator(button).click();
        await page.waitForFunction(id => /could not grant/i.test(document.querySelector(id).textContent), status);
        assert.equal(await page.locator(button).isEnabled(), true, 'Browser refusal keeps retry available');
        await page.evaluate(() => { __permission.outcome = 'allow'; });
        await page.locator(button).click();
        await page.waitForFunction(id => document.querySelector(id).textContent === 'YouTube access allowed', button);
        assert.equal(await page.locator(button).isDisabled(), true);
        assert.deepEqual(await page.evaluate(() => __permission.requests), Array.from({ length: 3 }, () => ({ origins: [YOUTUBE], activeGesture: true })),
          'Only the YouTube origin is requested, directly during each trusted click');
        await page.evaluate(() => __permission.change(false));
        await page.waitForFunction(id => !document.querySelector(id).disabled, button);
        await page.evaluate(() => __permission.change(true));
        await page.waitForFunction(id => document.querySelector(id).disabled, button);
        const source = surface === 'welcome' ? '/src/youtube/permission.js' : '/src/youtube/access-card.js';
        // Re-run the actual source in a fresh document with an existing grant.
        await page.goto(`${origin}/src/${file}.html?source=update&granted=1`);
        await page.waitForFunction(id => document.querySelector(id).textContent === 'YouTube access allowed', button);
        assert.deepEqual(await page.evaluate(() => __permission.requests), [], 'An existing grant never produces a duplicate request');
        assert.equal(await page.locator(`script[src="${source.split('/').at(-1)}"], script[src="../youtube/access-card.js"]`).count(), 1);
        if (surface === 'welcome') {
          await page.locator('#continue').click();
          assert.equal(await page.evaluate(() => __permission.closed), 1);
          assert.match(await page.locator(status).textContent(), /close this setup tab/);
        }
        results.push({ browserEngine: 'installed Chrome', simulatedBrowserMode: mode, surface, passed: true, externalRequestsServed: 0 });
      }
      coverage.push(...await page.coverage.stopJSCoverage());
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
      await context.close();
    }
    fs.writeFileSync(path.join(output, 'browser-coverage.json'), JSON.stringify(coverage));
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log('YouTube onboarding browser checks passed:', results.length, 'surfaces.');
  } finally { if (browser) await browser.close(); server.close(); }
}

if (require.main === module) run(path.resolve(process.argv[2] || 'youtube-onboarding-artifacts'))
  .catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
