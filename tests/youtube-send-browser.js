// Local synthetic integration only: all external traffic is blocked.
// FCM_PLAYWRIGHT_PATH=<existing install> node tests/youtube-send-browser.js <artifacts>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || 'dist/youtube-send-browser');

async function fixture(page, platform) {
  await page.evaluate(() => {
    const test = window.sendFixture = { instances: [], sends: [], outcome: 'submitted', sequence: 0, accessSetups: 0, accessCloses: 0 };
    const create = FCM.createOverlay;
    FCM.createOverlay = options => create({ ...options, onCommand(command) {
      (window.commands = window.commands || []).push(command);
      if (command.cmd === 'send') setTimeout(() => overlay.sendResult(command.id, window.autoSendResult), 20);
    } });
    test.state = { available: true, reason: 'ready', accountLabel: '@SyntheticYouTube', capability: 1,
      sourceId: 'AbCdEfGhI_1:synthetic:1', videoId: 'AbCdEfGhI_1', run: 'synthetic', maxLength: 200 };
    test.emit = patch => {
      Object.assign(test.state, patch);
      test.instances.at(-1).onSendState({ ...test.state });
    };
    FCM.createYouTubeSource = callbacks => {
      test.instances.push(callbacks);
      return {
        async start() {
          callbacks.onStatus({ state: 'connected', text: 'YouTube connected' });
          callbacks.onSendState({ ...test.state });
          return true;
        },
        getSendState() { return { ...test.state }; },
        openAccessSetup() { test.accessSetups++; return true; },
        closeAccessSetup() { test.accessCloses++; test.emit({ available: false, access: 'needed' }); },
        async send(text) {
          test.sends.push({ text, sourceId: test.state.sourceId });
          if (test.outcome === 'reject') throw Error('Synthetic transport interruption');
          return { sequence: ++test.sequence, outcome: test.outcome, reason: test.outcome };
        },
        stop() { callbacks.onSendState({ available: false, reason: 'disconnected', accountLabel: '', sourceId: '' }); },
        destroy() {},
      };
    };
    FCM.createYouTubeSuggestions = () => ({ pause() {}, refresh() {}, updateCounterpart() {}, destroy() {} });
    window.autoSendResult = { twitch: { ok: true }, kick: { ok: true } };
  });
  await page.locator(`.devbar [data-act="site-${platform}"]`).click();
  await page.waitForFunction(platform => overlay.hostPlatform === platform && sendFixture.instances.length, platform);
  await page.evaluate(() => {
    overlay.setStatus('twitch', 'connected', 'synthetic-twitch');
    overlay.setStatus('kick', 'connected', 'synthetic-kick');
    overlay.setAccounts({ twitch: { connected: true, login: 'SyntheticTwitch' }, kick: { connected: true, login: 'SyntheticKick' } });
    overlay.applyStoredSettings({ ...FCM.view.settings, autoClaimBonus: false, animations: false, hideNativeChat: true });
    overlay.chat({ platform: 'twitch', author: 'SyntheticViewer', text: 'Synthetic reply target', messageId: 'synthetic-reply', timestamp: Date.now() });
  });
  await page.locator('.fcm-youtube summary').click();
  await page.getByRole('textbox', { name: 'YouTube live video or channel URL', exact: true }).fill('https://www.youtube.com/@SyntheticChannel');
  await page.getByRole('button', { name: 'Add chat', exact: true }).click();
}

async function checks(page, mode, platform) {
  const yt = page.locator('.fcm-target[data-platform="youtube"]');
  const input = page.locator('.fcm-input');
  const send = page.locator('.fcm-send');
  const count = () => page.evaluate(() => ({ youtube: sendFixture.sends.length, api: (window.commands || []).filter(c => c.cmd === 'send').length }));
  assert.equal(await page.locator('#friendly-chat-merge-host').evaluate(host => host.parentNode.tagName),
    mode === 'firefox' ? 'BODY' : 'HTML', 'Firefox editing must remain inside the page body');
  await input.click();
  await page.keyboard.type('Edit me');
  await page.keyboard.press('Backspace');
  assert.equal(await input.evaluate(el => el.value), 'Edit m', 'Backspace deletes typed text');
  await page.keyboard.press('Home');
  await page.keyboard.press('Delete');
  assert.equal(await input.evaluate(el => el.value), 'dit m', 'Delete removes text after the caret');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  assert.equal(await input.evaluate(el => el.value), '', 'a selected draft can be deleted');
  assert.deepEqual(await count(), { youtube: 0, api: 0 }, 'editing never sends a message');
  await yt.waitFor();
  assert.equal(await yt.isEnabled(), true);
  assert.equal(await yt.getAttribute('data-on'), 'false', 'YouTube sending starts off even when signed in');
  assert.match(await yt.innerText(), /as @SyntheticYouTube/i);
  await page.evaluate(() => sendFixture.emit({ available: false, reason: 'signed-out', accountLabel: '', access: 'needed' }));
  assert.equal(await yt.isEnabled(), mode === 'firefox', 'only Firefox offers the embedded sign-in access setup');
  await input.fill('Draft survives sign-in access setup');
  await yt.evaluate(button => button.click());
  assert.equal(await page.evaluate(() => sendFixture.accessSetups), 0, 'synthetic clicks cannot open sign-in access setup');
  if (mode === 'firefox') {
    assert.match(await yt.innerText(), /enable sending/i);
    assert.match(await yt.getAttribute('title'), /Firefox needs permission/);
    const beforeSetup = await count();
    await yt.click();
    assert.equal(await page.evaluate(() => sendFixture.accessSetups), 1);
    assert.deepEqual(await count(), beforeSetup, 'sign-in access setup never sends');
    assert.equal(await yt.getAttribute('data-on'), 'false', 'opening access setup does not select YouTube');
    assert.equal(await input.innerText(), 'Draft survives sign-in access setup');
    for (const access of ['requesting', 'reloading']) {
      await page.evaluate(access => sendFixture.emit({ available: false, access }), access);
      assert.equal(await yt.isEnabled(), true, 'the host has a cancel control even while the native frame reloads');
      assert.match(await yt.innerText(), /cancel setup/i);
      const closed = await page.evaluate(() => sendFixture.accessCloses);
      await yt.evaluate(button => button.click());
      assert.equal(await page.evaluate(() => sendFixture.accessCloses), closed);
      await yt.click();
      assert.equal(await page.evaluate(() => sendFixture.accessCloses), closed + 1);
      assert.deepEqual(await count(), beforeSetup);
      assert.equal(await yt.getAttribute('data-on'), 'false');
      assert.equal(await input.innerText(), 'Draft survives sign-in access setup');
    }
    await page.evaluate(() => sendFixture.emit({ available: false, access: 'failed' }));
    assert.equal(await yt.isEnabled(), false, 'a failed sender frame cannot advertise a setup retry');
    assert.match(await yt.getAttribute('title'), /Remove and add YouTube chat/);
  }
  await page.evaluate(() => sendFixture.emit({ available: true, reason: 'ready', accountLabel: '@SyntheticYouTube', access: 'granted' }));
  assert.equal(await yt.getAttribute('data-on'), 'false', 'a ready account after setup still needs explicit selection');
  await yt.evaluate(button => button.click());
  assert.equal(await yt.getAttribute('data-on'), 'false', 'synthetic host-page click cannot arm YouTube');
  await input.fill('Existing destinations only');
  await send.click(); await page.waitForFunction(() => !document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-send').disabled);
  assert.equal((await count()).youtube, 0);

  await yt.click();
  assert.equal(await yt.getAttribute('data-on'), 'true');
  const themeRoot = page.locator('.fcm-root'), originalTheme = await themeRoot.getAttribute('data-theme');
  for (const theme of ['dark', 'light']) {
    await themeRoot.evaluate((root, value) => { root.dataset.theme = value; }, theme);
    await page.waitForTimeout(180);
    const paint = () => yt.evaluate(button => {
      const style = getComputedStyle(button);
      return { color: style.color, background: style.backgroundColor, border: style.borderTopColor };
    });
    assert.deepEqual(await paint(), theme === 'dark'
      ? { color: 'rgb(255, 138, 138)', background: 'rgba(255, 85, 85, 0.15)', border: 'rgba(255, 85, 85, 0.38)' }
      : { color: 'rgb(176, 20, 20)', background: 'rgba(176, 20, 20, 0.12)', border: 'rgba(176, 20, 20, 0.38)' },
    'selected YouTube has a red label, tint and border in both themes');
    await page.locator('.fcm-targets').screenshot({ path: path.join(output, `${mode}-${platform}-targets-${theme}.png`) });
    await yt.click();
    await page.waitForTimeout(180);
    const off = await paint();
    assert.equal(off.color, theme === 'dark' ? 'rgb(143, 143, 168)' : 'rgb(92, 102, 117)', 'deselected YouTube returns to neutral text');
    assert.equal(off.background, theme === 'dark' ? 'rgb(22, 22, 26)' : 'rgb(255, 255, 255)', 'deselected YouTube has no red tint');
    await yt.click();
  }
  await themeRoot.evaluate((root, value) => { root.dataset.theme = value; }, originalTheme);
  await input.fill('Explicit mixed message');
  const before = await count();
  await send.evaluate(button => button.click());
  assert.deepEqual(await count(), before, 'synthetic Send cannot post to any selected mixed destination');
  await input.press('Enter');
  await page.waitForFunction(before => sendFixture.sends.length === before + 1, before.youtube);
  await page.waitForFunction(() => !document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-send').disabled);
  assert.equal(await input.innerText(), '');
  assert.equal((await count()).api, before.api + 1);
  assert.equal(await page.evaluate(() => sendFixture.sends.at(-1).text), 'Explicit mixed message');
  assert.doesNotMatch(await page.locator('.fcm-feed').innerText(), /Submitted to YouTube/, 'successful mixed sends stay silent');

  const beforeRecall = await count();
  await input.fill('Unfinished draft');
  await input.press('ArrowUp');
  assert.equal(await input.evaluate(el => el.value), 'Explicit mixed message');
  await input.press('ArrowUp');
  assert.equal(await input.evaluate(el => el.value), 'Existing destinations only', 'one history entry per combined send');
  await input.press('ArrowDown'); await input.press('ArrowDown');
  assert.equal(await input.evaluate(el => el.value), 'Unfinished draft');
  await input.press('ArrowUp'); await input.press('Backspace');
  assert.equal(await input.evaluate(el => el.value), 'Explicit mixed messag', 'recalled text remains editable at the end');
  await input.press('ArrowUp'); await input.press('ArrowDown');
  assert.equal(await input.evaluate(el => el.value), 'Explicit mixed messag', 'edited recall is the new draft');
  await input.fill('@Synthetic');
  await page.locator('.fcm-ac:not(.fcm-hidden)').waitFor();
  await input.press('ArrowUp');
  assert.equal(await input.evaluate(el => el.value), '@Synthetic', 'autocomplete arrows do not recall history');
  await input.press('Escape');
  await input.fill(''); await input.press('ArrowUp');
  assert.deepEqual(await count(), beforeRecall, 'browsing never sends');
  await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-send').disabled);
  assert.equal((await count()).youtube, beforeRecall.youtube + 1, 'Enter explicitly resends the recalled text once');
  assert.equal(await page.evaluate(() => sendFixture.sends.at(-1).text), 'Explicit mixed message');
  await input.press('ArrowUp'); await input.press('ArrowUp');
  assert.equal(await input.evaluate(el => el.value), 'Existing destinations only', 'consecutive resends do not fill history');
  await page.evaluate(() => FCM.setEmotes('twitch', 'native', { RecallEmote: {
    url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/%3E', source: 'Local fixture',
  } }));
  await input.fill('RecallEmote café 🎉'); await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-send').disabled);
  await input.press('ArrowUp');
  assert.equal(await input.evaluate(el => el.value), 'RecallEmote café 🎉', 'Unicode and emote text round-trip');
  assert.equal(await input.locator('img').count(), 1, 'recalled emotes render as images');
  await input.press('ArrowDown'); assert.equal(await input.evaluate(el => el.value), '');

  for (const text of ['x'.repeat(201), 'line one\u0001line two']) {
    await input.evaluate((element, text) => { element.value = text; element.dispatchEvent(new Event('input', { bubbles: true })); }, text);
    const prior = await count();
    await send.click();
    assert.deepEqual(await count(), prior, `invalid YouTube text (${text.length} characters) blocks all copies of a mixed send`);
    assert.equal(await input.innerText(), text);
  }

  // The page exposes read-only message rows; the actual Twitch reply UI still scopes replies.
  await input.fill('');
  const author = page.locator('.fcm-msg[data-platform="twitch"] .fcm-author').first();
  await author.click();
  await page.locator('.fcm-um').getByRole('button', { name: /Reply on Twitch/ }).click();
  await input.press('End');
  await input.pressSequentially('reply remains on Twitch');
  assert.equal(await page.locator('.fcm-reply').isVisible(), true);
  const beforeReply = await count();
  await send.click();
  await page.waitForFunction(before => (window.commands || []).filter(c => c.cmd === 'send').length > before, beforeReply.api);
  await page.waitForFunction(() => !document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-send').disabled);
  assert.equal((await count()).youtube, beforeReply.youtube);
  assert.deepEqual(await page.evaluate(() => window.commands.filter(c => c.cmd === 'send').at(-1).targets), ['twitch']);

  // Select just YouTube for this visit. No YouTube choice is stored with binary targets.
  for (const target of ['twitch', 'kick']) {
    const chip = page.locator(`.fcm-target[data-platform="${target}"]`);
    if (await chip.getAttribute('data-on') === 'true') await chip.click();
  }
  assert.equal(await yt.getAttribute('data-on'), 'true');
  assert.match(await page.locator('.fcm-sendnote').innerText(), /^sending to YouTube$/);
  for (const outcome of ['not-sent', 'submitted', 'uncertain', 'reject']) {
    await page.evaluate(outcome => { sendFixture.outcome = outcome; }, outcome);
    await input.fill('Synthetic outcome ' + outcome);
    const prior = await count();
    await send.click();
    await page.waitForFunction(before => sendFixture.sends.length === before + 1, prior.youtube);
    await page.waitForFunction(() => !document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-send').disabled);
    assert.equal((await count()).api, prior.api, 'YouTube-only cannot fall through into another platform');
    assert.equal(await input.innerText(), outcome === 'not-sent' ? 'Synthetic outcome not-sent' : '', 'uncertain or submitted text is never restored');
    assert.doesNotMatch(await page.locator('.fcm-feed').innerText(), /Submitted to YouTube/, 'YouTube-only sends do not add a success row');
    if (outcome === 'uncertain' || outcome === 'reject') {
      assert.match(await page.locator('.fcm-feed').innerText(), /YouTube submission could not be confirmed/, 'uncertain sends still warn against duplicates');
    }
  }

  await page.evaluate(() => sendFixture.emit({ available: false, reason: 'busy' }));
  assert.equal(await yt.getAttribute('data-on'), 'true', 'temporary busy keeps the same source selected');
  assert.equal(await yt.isEnabled(), false);
  await page.evaluate(() => sendFixture.emit({ available: true, reason: 'ready' }));
  assert.equal(await yt.getAttribute('data-on'), 'true');
  await page.evaluate(() => sendFixture.emit({ sourceId: 'AbCdEfGhI_1:synthetic:2', capability: 2 }));
  assert.equal(await yt.getAttribute('data-on'), 'false', 'a new reader capability requires fresh selection');
  await yt.click();
  await page.evaluate(() => sendFixture.emit({ accountLabel: '@DifferentSyntheticAccount' }));
  assert.equal(await yt.getAttribute('data-on'), 'false', 'an account change cannot retain consent');
  await yt.click();
  await page.evaluate(() => sendFixture.emit({ available: false, reason: 'signed-out', accountLabel: '' }));
  assert.equal(await yt.getAttribute('data-on'), 'false');
  assert.match(await yt.innerText(), /sign in on YouTube/i);
  await page.evaluate(() => sendFixture.emit({ available: true, reason: 'ready', accountLabel: '@SyntheticYouTube' }));
  await yt.click();
  await page.screenshot({ path: path.join(output, `${mode}-${platform}-send.png`) });
  const column = page.locator(platform === 'kick' ? '.kickcol' : '.chatcol:not(.kickcol)');
  await column.evaluate(element => { element.style.width = '260px'; element.style.boxSizing = 'border-box'; });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.fcm-targets').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'targets fit the 260px panel');
  await page.screenshot({ path: path.join(output, `${mode}-${platform}-send-narrow.png`) });
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(ROOT + path.sep)) return res.writeHead(403).end();
    try {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(fs.readFileSync(file));
    } catch (_) { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, coverage = [], results = [];
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const mode of ['chrome', 'firefox']) for (const platform of ['twitch', 'kick']) {
      const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
      const errors = [], blocked = [];
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        blocked.push(route.request().url()); return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
      await page.goto(`${origin}/tests/harness.html?browser=${mode}`);
      await page.locator('.fcm-msg').first().waitFor();
      await fixture(page, platform);
      await checks(page, mode, platform);
      assert.deepEqual(errors, []);
      coverage.push(...await page.coverage.stopJSCoverage());
      results.push({ engine: 'installed Chrome', simulatedBrowserMode: mode, platform, passed: true, externalRequestsServed: 0, blocked: blocked.length });
      await context.close();
      console.log(`${mode}/${platform}: synthetic YouTube sending passed`);
    }
    fs.writeFileSync(path.join(output, 'browser-coverage.json'), JSON.stringify(coverage));
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
