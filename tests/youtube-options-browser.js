// Synthetic options-page checks. Uses installed Chrome with Chrome/Firefox API fixtures.
// FCM_PLAYWRIGHT_PATH=<existing-install> node tests/youtube-options-browser.js <output>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');

async function run(output) {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const coverage = [], results = [];
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const mode of ['chrome', 'firefox']) {
      const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
      const blocked = [], errors = [], dialogs = [];
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        blocked.push(route.request().url());
        return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
      await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
      await page.goto(`${origin}/tests/options-harness.html?browser=${mode}`);
      await page.waitForFunction(() => window.__ready && document.querySelector('#youtube-links').textContent.includes('No saved YouTube links'));
      assert.equal(await page.evaluate(() => FCM.BROWSER), mode);
      const recentToggle = page.getByRole('checkbox', { name: 'Recent emote bar', exact: true });
      assert.equal(await recentToggle.isChecked(), true);
      await recentToggle.uncheck();
      await page.waitForFunction(async () => (await FCM.loadSettings()).showRecentEmotes === false);
      await page.evaluate(() => chrome.storage.local.set({
        [FCM.STORAGE_KEYS.recentEmotes + ':twitch']: ['PrivateRecentTW'],
        [FCM.STORAGE_KEYS.recentEmotes + ':kick']: ['PrivateRecentKI'],
      }));
      const channelUrl = 'https://www.youtube.com/@SyntheticChannel';
      const longUrl = 'https://www.youtube.com/@' + 'LongYouTubeChannelNameForWrapping'.repeat(3);
      const links = {
        'twitch:syntheticstreamer': { channelUrl, at: 1 },
        'kick:syntheticstreamer': { channelUrl, at: 1 },
        'twitch:long_channel_name_for_testing': { channelUrl: longUrl, at: 2 },
      };
      const backup = { format: 'friendly-chat-extension-backup', backupVersion: 1, youtubeLinks: links };
      await page.evaluate(value => __importFile(JSON.stringify(value)), backup);
      await page.waitForFunction(() => document.querySelector('#backup-note').textContent === 'Imported 3 saved YouTube links.');
      assert.match(dialogs.at(-1), /3 saved YouTube links/);
      assert.equal(await page.locator('#youtube-links .link-row').count(), 3);
      assert.deepEqual(await page.locator('#youtube-links .from').allTextContents(),
        ['Kick/syntheticstreamer', 'Twitch/long_channel_name_for_testing', 'Twitch/syntheticstreamer']);
      await page.locator('#youtube-links').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `${mode}-saved-youtube-links-1360.png`) });
      await page.setViewportSize({ width: 420, height: 920 });
      await page.locator('#youtube-links').scrollIntoViewIfNeeded();
      assert.deepEqual(await page.locator('#youtube-links .link-row').evaluateAll(rows => rows.map(row => {
        const box = row.getBoundingClientRect();
        return row.scrollWidth <= row.clientWidth + 1 && box.left >= 0 && box.right <= innerWidth;
      })), [true, true, true], 'saved rows wrap long channel URLs inside the narrow viewport');
      assert.equal(await page.locator('#youtube-links .to').nth(1).textContent(), longUrl);
      await page.screenshot({ path: path.join(output, `${mode}-saved-youtube-links-420.png`) });

      await page.getByRole('button', { name: 'Export to a file', exact: true }).click();
      await page.waitForFunction(() => window.__lastDownload && __lastDownload.text);
      const exported = await page.evaluate(() => JSON.parse(__lastDownload.text));
      assert.deepEqual(exported.youtubeLinks, links);
      assert.equal(exported.settings.showRecentEmotes, false);
      assert.equal(Object.keys(exported).some(key => key.includes('recentEmotes')), false);
      assert.doesNotMatch(JSON.stringify(exported), /PrivateRecentTW|PrivateRecentKI/);
      assert.equal(exported.backupVersion, 1);
      assert.equal(exported.auth, undefined);
      await page.locator('#youtube-links .link-row').filter({ hasText: 'Kick/syntheticstreamer' }).getByRole('button', { name: 'Forget', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('#youtube-links .link-row').length === 2);
      assert.deepEqual(await page.evaluate(() => Object.keys(__store.local[FCM.STORAGE_KEYS.youtubeLinks]).sort()),
        ['twitch:long_channel_name_for_testing', 'twitch:syntheticstreamer']);
      assert.equal(await page.locator('#youtube-links-note').textContent(), 'Saved YouTube link forgotten.');

      await page.evaluate(() => __importFile(JSON.stringify({ format: FCM.BACKUP_FORMAT, backupVersion: 1, settings: { opacity: 85 } })));
      await page.waitForFunction(() => document.querySelector('#backup-note').textContent === 'Imported 1 setting.');
      assert.equal(await page.locator('#youtube-links .link-row').count(), 2, 'legacy backup leaves current YouTube choices intact');
      await page.evaluate(value => __importFile(JSON.stringify(value)), {
        ...backup, youtubeLinks: { 'twitch:syntheticstreamer': links['twitch:syntheticstreamer'] },
      });
      await page.waitForFunction(() => document.querySelector('#backup-note').textContent === 'Imported 1 saved YouTube link.');
      assert.match(dialogs.at(-1), /1 saved YouTube link\./);
      assert.equal(await page.locator('#youtube-links .link-row').count(), 1);
      await page.locator('#youtube-links .link-row').getByRole('button', { name: 'Forget', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#youtube-links').textContent.includes('No saved YouTube links'));
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, [], 'the options fixture requests no external services');
      coverage.push(...await page.coverage.stopJSCoverage());
      results.push({ browserEngine: 'installed Chrome', simulatedBrowserMode: mode, passed: true,
        viewportWidths: [1360, 420], externalRequestsServed: 0, blockedExternalRequests: blocked.length, errors });
      await context.close();
      console.log(`${mode}: saved YouTube links, backup and narrow-layout browser checks passed`);
    }
    fs.writeFileSync(path.join(output, 'browser-coverage.json'), JSON.stringify(coverage));
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

if (require.main === module) run(path.resolve(process.argv[2] || 'youtube-options-artifacts'))
  .catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
