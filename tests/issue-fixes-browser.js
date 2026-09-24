// Optional real-browser regression check. Uses an existing Playwright install:
// FCM_PLAYWRIGHT_PATH=<path> node tests/issue-fixes-browser.js <artifact-directory>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || 'issue-fixes-artifacts');

async function run() {
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
  let browser;
  const coverage = [];
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const mode of ['chrome', 'firefox']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      // Local synthetic fixtures only, with every external request blocked.
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
      await page.goto(`${origin}/tests/harness.html?browser=${mode}`);
      await page.locator('.fcm-msg').first().waitFor();
      await page.evaluate(() => overlay.applyStoredSettings({ ...FCM.view.settings, autoClaimBonus: false, animations: false, hideNativeChat: true }));

      // #56/#59 on each site's actual adapter with synthetic replacement DOM.
      for (const platform of ['twitch', 'kick']) {
        await page.locator(`.devbar [data-act="site-${platform}"]`).click();
        await page.evaluate(() => overlay.applyStoredSettings({ ...FCM.view.settings, hideNativeChat: true }));
        await page.waitForFunction(platform => FCM.SITES[platform].nativeChatBody()?.style.visibility === 'hidden', platform);
        await page.evaluate(platform => {
          const body = FCM.SITES[platform].nativeChatBody();
          const replacement = body.cloneNode(true); replacement.style.visibility = '';
          body.replaceWith(replacement);
        }, platform);
        await page.waitForFunction(platform => FCM.SITES[platform].nativeChatBody()?.style.visibility === 'hidden', platform);
        // Open the real overlay action, with the site drawing a delayed card inside its list.
        await page.evaluate(platform => {
          const adapter = FCM.SITES[platform];
          const list = adapter.messageList();
          const name = document.createElement('span'); name.textContent = 'fixtureuser';
          list.appendChild(name); adapter.chatUsername = () => name;
          name.addEventListener('click', () => {
            window.nameWasVisible = getComputedStyle(name).visibility === 'visible';
            setTimeout(() => {
              const card = document.createElement('div');
              card.id = 'fixture-user-card'; card.setAttribute('role', 'dialog'); card.dataset.state = 'open';
              card.textContent = 'Synthetic native user card';
              const r = list.getBoundingClientRect();
              card.style.cssText = `position:fixed;top:${r.top + 15}px;left:${r.left}px;width:300px;height:200px;background:purple;z-index:2000`;
              list.appendChild(card);
            }, 350);
          });
          overlay.chat({ platform, messageId: 'fixture-' + platform, userId: 'fixture', author: 'fixtureuser', text: 'Native card regression', timestamp: Date.now() });
        }, platform);
        const author = page.locator('.fcm-author[data-name="fixtureuser"]').last();
        await author.click();
        await page.getByRole('button', { name: `Open ${platform === 'twitch' ? 'Twitch' : 'Kick'}'s user card` }).click();
        await page.locator('#fixture-user-card').waitFor();
        await page.waitForFunction(() => document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-panel').classList.contains('fcm-peek'));
        assert.equal(await page.evaluate(() => window.nameWasVisible), true, 'native name is visible before clicking');
        await page.waitForTimeout(4300);
        assert.equal(await page.locator('.fcm-panel').evaluate(el => el.classList.contains('fcm-peek')), true, 'card remains uncovered beyond initial hold');
        await page.locator('#fixture-user-card').evaluate(el => { el.dataset.state = 'closed'; el.style.visibility = 'hidden'; });
        await page.waitForFunction(() => !document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-panel').classList.contains('fcm-peek'));
        await page.locator('#fixture-user-card').evaluate(el => el.remove());
      }

      // #57: short portal toast in the upper-right can be clicked by the viewer.
      await page.evaluate(() => {
        const list = FCM.SITES.kick.messageList(), r = list.getBoundingClientRect();
        const notice = document.createElement('button'); notice.id = 'fixture-drop'; notice.setAttribute('role', 'status');
        notice.textContent = 'Emote drop available';
        notice.style.cssText = `position:fixed;top:${r.top}px;left:${r.left}px;width:300px;height:44px;z-index:50;background:green`;
        notice.addEventListener('click', () => { window.dropClicks = (window.dropClicks || 0) + 1; });
        document.body.appendChild(notice);
      });
      await page.waitForFunction(() => {
        const panel = document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-panel');
        return panel.getBoundingClientRect().top >= document.querySelector('#fixture-drop').getBoundingClientRect().bottom;
      });
      assert.equal(await page.evaluate(() => window.dropClicks || 0), 0, 'no automatic redemption');
      await page.locator('#fixture-drop').click();
      assert.equal(await page.evaluate(() => window.dropClicks), 1);
      await page.locator('#fixture-drop').evaluate(el => el.remove());

      // #60: controls are above the author and body at wide/narrow widths.
      await page.locator('.devbar [data-act="site-twitch"]').click();
      await page.locator('.devbar [data-act="mods"]').click();
      await page.evaluate(() => overlay.chat({ platform: 'twitch', author: 'fixtureuser', messageId: 'mod-fixture', text: 'A message that stays readable under its moderation controls.', timestamp: Date.now() }));
      for (const width of ['wide', 'narrow']) {
        await page.locator(`.devbar [data-act="${width}"]`).click();
        const row = page.locator('.fcm-msg[data-platform="twitch"]').last();
        await row.hover();
        await row.locator('.fcm-modbar').waitFor();
        const boxes = await row.evaluate(el => {
          const bar = el.querySelector('.fcm-modbar').getBoundingClientRect();
          return { bottom: bar.bottom, texts: ['.fcm-author', '.fcm-body'].map(sel => el.querySelector(sel).getBoundingClientRect().top) };
        });
        assert.ok(boxes.texts.every(top => top >= boxes.bottom), 'toolbar clears message and author');
      }
      await page.screenshot({ path: path.join(output, `${mode}-moderation.png`) });
      await page.locator('.devbar [data-act="burst"]').click();
      const newest = page.locator('.fcm-msg').last();
      await newest.hover();
      await newest.locator('.fcm-modbar').waitFor();
      await page.waitForTimeout(650);
      assert.equal(await newest.locator('.fcm-modbar').isVisible(), true, 'bottom-row toolbar stays reachable');

      // #58: two real popup windows, no PiP shim. Closing one keeps the other open.
      const other = await context.newPage();
      await other.goto(`${origin}/tests/harness.html?browser=${mode}`);
      await other.locator('.fcm-msg').first().waitFor();
      const [firstPopup] = await Promise.all([page.waitForEvent('popup'), page.locator('.fcm-actions [data-act="popout"]').click()]);
      await firstPopup.locator('.fcm-input').waitFor();
      const [secondPopup] = await Promise.all([other.waitForEvent('popup'), other.locator('.fcm-actions [data-act="popout"]').click()]);
      await secondPopup.locator('.fcm-input').waitFor();
      assert.equal(firstPopup.isClosed(), false);
      await firstPopup.locator('.fcm-input').fill('Independent draft one');
      await secondPopup.locator('.fcm-input').fill('Independent draft two');
      await firstPopup.close();
      await page.locator('.fcm-input').waitFor();
      assert.equal(await page.locator('.fcm-input').innerText(), 'Independent draft one');
      assert.equal(await secondPopup.locator('.fcm-input').innerText(), 'Independent draft two');
      await secondPopup.locator('.fcm-actions [data-act="popout"]').click();
      await other.locator('.fcm-input').waitFor();
      assert.equal(await other.locator('.fcm-input').innerText(), 'Independent draft two');
      const [closingPopup] = await Promise.all([other.waitForEvent('popup'), other.locator('.fcm-actions [data-act="popout"]').click()]);
      await closingPopup.locator('.fcm-input').waitFor();
      await Promise.all([closingPopup.waitForEvent('close'), other.goto('about:blank')]);
      assert.deepEqual(errors, []);
      coverage.push(...(await page.coverage.stopJSCoverage()).map(entry => ({ functions: entry.functions, source: entry.source, url: entry.url })));
      await context.close();
      console.log(`${mode} harness: #56-60 browser regressions passed`);
    }
    fs.writeFileSync(path.join(output, 'browser-coverage.json'), JSON.stringify(coverage));
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
