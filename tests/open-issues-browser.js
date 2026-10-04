// Rendered regressions for #62-64 using synthetic pages and no live services.
// FCM_PLAYWRIGHT_PATH=<existing-install> node tests/open-issues-browser.js <output>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const { dashboardPaths } = require('./issue-62.test');

async function notificationChecks(page, mode, output) {
  for (const platform of ['twitch', 'kick']) {
    await page.evaluate(platform => switchSite(platform), platform);
    const panel = page.locator('.fcm-panel');
    for (const revealHighlights of [true, false]) for (const moved of [false, true]) {
      await page.evaluate(revealHighlights => overlay.applyStoredSettings({ ...FCM.view.settings,
        autoClaimBonus: false, animations: false, hideNativeChat: true, revealHighlights }), revealHighlights);
      if (moved) {
        const header = await page.locator('.fcm-brand').boundingBox();
        await page.mouse.move(header.x + 20, header.y + 10); await page.mouse.down();
        await page.mouse.move(header.x + 8, header.y + 5); await page.mouse.up();
        if (!revealHighlights) {
          const rect = await panel.boundingBox(), grip = await page.locator('.fcm-resize').boundingBox();
          await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
          await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - rect.height + 180); await page.mouse.up();
          assert.ok((await panel.boundingBox()).height <= 181, `short-panel resize: ${JSON.stringify(await panel.boundingBox())}, grip ${JSON.stringify(grip)}`);
        }
      }
      const before = await panel.boundingBox();
      const bottom = await page.evaluate(({ platform, top }) => {
        for (let i = 0; i < 2; i++) {
          const toast = document.createElement('div'); toast.className = 'fixture-stacked-notice';
          if (i === 0) toast.setAttribute('role', 'alert');
          else if (platform === 'kick') toast.setAttribute('data-sonner-toast', '');
          else toast.classList.add('tw-toast');
          toast.style.cssText = `position:fixed;right:0;top:${top + i * 62}px;width:340px;height:52px;z-index:2000;background:#374151;color:white`;
          const button = document.createElement('button'); button.textContent = 'Dismiss notification ' + i;
          button.onclick = () => toast.remove(); toast.append(button); document.body.append(toast);
        }
        return top + 114;
      }, { platform, top: before.y + 10 });
      await page.waitForFunction(bottom => document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-panel').getBoundingClientRect().top >= bottom, bottom);
      assert.equal(await page.getByRole('button', { name: 'Dismiss notification 0', exact: true }).evaluate(button => {
        const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), true, 'the native notification receives pointer hits above the overlay');
      if (!revealHighlights) await page.screenshot({ path: path.join(output, `${mode}-${platform}-notices-${moved ? 'moved' : 'auto'}.png`) });
      await page.getByRole('button', { name: 'Dismiss notification 0', exact: true }).click();
      await page.getByRole('button', { name: 'Dismiss notification 1', exact: true }).click();
      await page.waitForFunction(top => Math.abs(document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-panel').getBoundingClientRect().top - top) < 2, before.y);
      if (moved) await page.locator('[data-act="reset-placement"]').click();
    }
  }
}

async function managedToastChecks(page, mode, output) {
  await page.evaluate(() => switchSite('twitch'));
  const panel = page.locator('.fcm-panel');
  for (const revealHighlights of [true, false]) for (const moved of [false, true]) {
    await page.evaluate(revealHighlights => overlay.applyStoredSettings({ ...FCM.view.settings,
      autoClaimBonus: false, animations: false, hideNativeChat: true, revealHighlights }), revealHighlights);
    if (moved) {
      const header = await page.locator('.fcm-brand').boundingBox();
      await page.mouse.move(header.x + 20, header.y + 10); await page.mouse.down();
      await page.mouse.move(header.x + 8, header.y + 5); await page.mouse.up();
      const rect = await panel.boundingBox(), grip = await page.locator('.fcm-resize').boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - rect.height + 180); await page.mouse.up();
      assert.ok((await panel.boundingBox()).height <= 181, 'tall notices also clear a short manually resized panel');
    }
    const before = await panel.boundingBox();
    const bottom = await page.evaluate(top => {
      const manager = document.createElement('div');
      manager.className = 'onsite-notifications-toast-manager';
      manager.setAttribute('data-test-selector', 'onsite-notifications-toast-manager');
      manager.style.cssText = 'position:fixed;top:49px;right:16px;width:0;height:0;z-index:4000';
      window.fixtureToastActions = [];
      for (let i = 0; i < 2; i++) {
        const wrapper = document.createElement('div'); wrapper.style.cssText = 'width:0;height:0';
        const toast = document.createElement('div');
        toast.style.cssText = `position:fixed;right:0;top:${top + i * 170}px;width:340px;height:160px;background:#303030;color:white;padding:12px;box-sizing:border-box`;
        const title = document.createElement('p'); title.textContent = 'A followed channel is live'; toast.append(title);
        for (const action of ['Watch', 'Options', 'Dismiss']) {
          const button = document.createElement('button'); button.textContent = `${action} managed toast ${i}`;
          button.onclick = () => { fixtureToastActions.push(`${action}:${i}`); if (action === 'Dismiss') wrapper.remove(); };
          toast.append(button);
        }
        wrapper.append(toast); manager.append(wrapper);
      }
      document.body.append(manager);
      return top + 330;
    }, before.y + 8);
    await page.waitForFunction(bottom => document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-panel').getBoundingClientRect().top >= bottom, bottom);
    for (let i = 0; i < 2; i++) for (const action of ['Watch', 'Options', 'Dismiss']) {
      const button = page.getByRole('button', { name: `${action} managed toast ${i}`, exact: true });
      assert.equal(await button.evaluate(el => {
        const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), true, 'every managed-toast action receives pointer hits');
      if (action !== 'Dismiss') await button.click();
    }
    assert.deepEqual(await page.evaluate(() => fixtureToastActions), ['Watch:0', 'Options:0', 'Watch:1', 'Options:1']);
    await page.screenshot({ path: path.join(output, `${mode}-managed-toasts-${revealHighlights ? 'highlights' : 'no-highlights'}-${moved ? 'moved' : 'auto'}.png`) });
    await page.getByRole('button', { name: 'Dismiss managed toast 0', exact: true }).click();
    await page.getByRole('button', { name: 'Dismiss managed toast 1', exact: true }).click();
    await page.waitForFunction(top => Math.abs(document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-panel').getBoundingClientRect().top - top) < 2, before.y);
    assert.ok(Math.abs((await panel.boundingBox()).height - before.height) < 2, 'dismissal restores the original height');
    await page.locator('.onsite-notifications-toast-manager').evaluate(el => el.remove());
    if (moved) await page.locator('[data-act="reset-placement"]').click();
  }
}

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
      let blocked = 0, emoteFixtures = 0;
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.hostname === 'dashboard.kick.com') {
          const scripts = ['src/shared/namespace.js', 'src/shared/constants.js', 'src/content/sites.js', 'src/content/boot.js'];
          const file = scripts.find(file => url.pathname === '/' + file);
          if (file) return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: fs.readFileSync(path.join(ROOT, file), 'utf8') });
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><title>Offline Kick dashboard fixture</title>
            <h1>Synthetic dashboard</h1><script>
              self.fixturePorts=[];
              self.chrome={storage:{onChanged:{addListener(){}}},runtime:{connect(){
                const port={sent:[],postMessage(message){this.sent.push(message)},disconnect(){this.closed=true},
                  onMessage:{addListener(){}},onDisconnect:{addListener(){}}};fixturePorts.push(port);return port;
              }}};
              self.FCM={BROWSER:${JSON.stringify(mode)},isGifErrand:()=>false,resetChannelView(){},createOverlay(){
                const node=document.createElement('div');node.id='friendly-chat-merge-host';node.textContent='Synthetic overlay';
                return {async mount(){document.body.append(node)},destroy(){node.remove()}};
              }};
            </script>
            ${scripts.map(file => `<script src="/${file}"></script>`).join('')}` });
        }
        if (url.origin === 'https://static-cdn.jtvnw.net') {
          emoteFixtures++;
          return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112"><circle cx="56" cy="56" r="52" fill="#9146ff"/></svg>' });
        }
        blocked++;
        return route.abort();
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
      const dashboard = await context.newPage();
      dashboard.on('pageerror', error => errors.push(error.message));
      await dashboard.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
      for (const pathname of dashboardPaths) {
        // These URLs are fulfilled entirely from local source and synthetic HTML.
        await dashboard.goto('https://dashboard.kick.com' + pathname);
        assert.equal(await dashboard.evaluate(() => FCM.currentSite().channelFromUrl()), null, pathname + ' is excluded');
        assert.equal(await dashboard.locator('#friendly-chat-merge-host').count(), 0, pathname + ' has no overlay');
        assert.equal(await dashboard.evaluate(() => fixturePorts.length), 0, pathname + ' has no chat session');
        await dashboard.evaluate(() => history.pushState(null, '', '/stream'));
        await dashboard.locator('#friendly-chat-merge-host').waitFor();
        await dashboard.evaluate(pathname => { history.pushState(null, '', pathname); dispatchEvent(new PopStateEvent('popstate')); }, pathname);
        assert.equal(await dashboard.locator('#friendly-chat-merge-host').count(), 0, 'leaving stream removes the overlay');
        assert.equal(await dashboard.evaluate(() => fixturePorts.at(-1).closed), true, 'leaving stream disconnects chat');
      }
      await dashboard.goto('https://dashboard.kick.com/stream');
      await dashboard.locator('#friendly-chat-merge-host').waitFor();
      coverage.push(...await dashboard.coverage.stopJSCoverage());
      await dashboard.close();
      await page.goto(`${origin}/tests/harness.html?browser=${mode}`);
      await page.locator('.fcm-msg').first().waitFor();
      await page.evaluate(() => overlay.applyStoredSettings({ ...FCM.view.settings, autoClaimBonus: false, animations: false }));

      // Exercise the real route parser without visiting Kick or loading its page.
      assert.deepEqual(await page.evaluate(() => {
        const original = location.href, results = [];
        for (const pathname of ['/drops', '/drops/claimed', '/drops/inventory', '/DROPS/campaign', '/popout/drops/chat', '/drops_streamer']) {
          history.replaceState(null, '', pathname);
          results.push(FCM.SITES.kick.channelFromUrl());
        }
        history.replaceState(null, '', original);
        return results;
      }), [null, null, null, null, null, 'drops_streamer']);

      const initialTop = (await page.locator('.fcm-panel').boundingBox()).y;
      await page.evaluate(() => {
        const notice = document.createElement('div');
        notice.id = 'fixture-live-notice'; notice.className = 'tw-toast'; notice.setAttribute('role', 'alert');
        notice.style.cssText = 'position:fixed;top:70px;right:0;width:340px;height:52px;background:#6530a0;color:white;z-index:2000';
        notice.textContent = 'A followed channel is live. ';
        const button = document.createElement('button'); button.textContent = 'Dismiss fixture';
        button.addEventListener('click', () => notice.remove()); notice.appendChild(button); document.body.appendChild(notice);
      });
      await page.waitForFunction(() => document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-panel').getBoundingClientRect().top >= 122);
      await page.screenshot({ path: path.join(output, `${mode}-live-notification.png`) });
      await page.getByRole('button', { name: 'Dismiss fixture' }).click();
      await page.waitForFunction(top => Math.abs(document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-panel').getBoundingClientRect().top - top) < 2, initialTop);

      await page.evaluate(() => overlay.chat({ platform: 'twitch', messageId: 'fixture-giant', author: 'FixtureViewer',
        text: 'Kappa Kappa', emoteMap: FCM.parseTwitchEmoteMap('25:0-4,6-10'), gigantifiedEmote: true, timestamp: Date.now() }));
      const giantRow = page.locator('.fcm-msg[data-msg-id="fixture-giant"]');
      await giantRow.locator('img').nth(1).waitFor();
      const dimensions = await giantRow.locator('img').evaluateAll(images => images.map(image => ({
        width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height,
        giant: image.classList.contains('fcm-emote-gigantified'), src: image.getAttribute('src'),
      })));
      assert.equal(dimensions.length, 2);
      assert.equal(dimensions[0].giant, false); assert.equal(dimensions[0].height, 26);
      assert.equal(dimensions[1].giant, true); assert.equal(dimensions[1].height, 112); assert.equal(dimensions[1].width, 112);
      assert.match(dimensions[1].src, /\/3\.0$/);
      await page.locator('.fcm-panel').evaluate(panel => { panel.style.width = '260px'; });
      assert.equal((await page.locator('.fcm-panel').boundingBox()).width, 260);
      assert.equal(await giantRow.evaluate(row => row.scrollWidth <= row.clientWidth), true, 'gigantified emote fits the row');
      await page.screenshot({ path: path.join(output, `${mode}-gigantified-emote.png`) });
      await notificationChecks(page, mode, output);
      await managedToastChecks(page, mode, output);
      assert.deepEqual(errors, []);
      coverage.push(...await page.coverage.stopJSCoverage());
      results.push({ browserEngine: 'installed Chrome', simulatedBrowserMode: mode, passed: true,
        externalRequestsServed: 0, blockedExternalRequests: blocked, syntheticEmoteResponses: emoteFixtures, errors });
      await context.close();
      console.log(`${mode}: dashboard exclusion, Drops routes, live notification, and gigantified emote passed`);
    }
    fs.writeFileSync(path.join(output, 'browser-coverage.json'), JSON.stringify(coverage));
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

module.exports = run;
if (require.main === module) run(path.resolve(process.argv[2] || 'open-issues-browser-artifacts'))
  .catch(error => { console.error(error); process.exitCode = 1; });
