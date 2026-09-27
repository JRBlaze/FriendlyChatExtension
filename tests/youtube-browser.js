// Synthetic browser integration, never a live chat or extension-session test.
// Uses an existing Playwright install: FCM_PLAYWRIGHT_PATH=<path> node tests/youtube-browser.js <artifacts>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || 'youtube-browser-artifacts');
const VIDEO = 'AbCdEfGhI_1';

async function installFixture(page) {
  await page.evaluate(() => {
    const fixture = window.youtubeFixture = { instances: [], suggestions: [], starts: [], commands: [], permission: true,
      online: true, links: {}, pairs: {}, linkCalls: [], captures: 0 };
    const sendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (message, reply) => {
      if (!['youtubeLinkGet', 'youtubeLinkSave', 'youtubeLinkForget'].includes(message.cmd)) return sendMessage(message, reply);
      fixture.linkCalls.push({ ...message });
      const key = message.platform + ':' + message.channel;
      const other = message.platform === 'twitch' ? 'kick' : 'twitch';
      const pair = fixture.pairs[key];
      let result;
      if (message.cmd === 'youtubeLinkGet') result = { ok: true, link: fixture.links[key] || null,
        counterpart: pair ? { platform: other, channel: pair, link: fixture.links[other + ':' + pair] || null } : null };
      else if (message.cmd === 'youtubeLinkSave') {
        const link = { channelUrl: FCM.youtube.parseInput(message.channelUrl).channelUrl, at: Date.now() };
        fixture.links[key] = link;
        if (message.counterpartChannel) fixture.links[other + ':' + message.counterpartChannel] = { ...link };
        result = { ok: true, link };
      } else {
        delete fixture.links[key];
        result = { ok: true, link: null };
      }
      if (reply) queueMicrotask(() => reply(result));
      return Promise.resolve(result);
    };
    const create = FCM.createOverlay;
    FCM.createOverlay = options => create({ ...options, onCommand(command) {
      fixture.commands.push(command);
      options.onCommand(command);
    } });
    FCM.createYouTubeSuggestions = options => {
      const instance = { options, paused: false, pauses: 0, refreshes: 0, destroyed: 0, counterparts: [] };
      fixture.suggestions.push(instance);
      return {
        pause() { instance.paused = true; instance.pauses++; },
        refresh() { instance.paused = false; instance.refreshes++; },
        updateCounterpart(info) { instance.counterparts.push(info); },
        destroy() { instance.paused = true; instance.destroyed++; },
      };
    };
    fixture.suggest = (items, instance = fixture.suggestions.at(-1)) => {
      if (!instance.paused && !instance.destroyed) instance.options.onSuggestions(items);
    };
    FCM.createYouTubeSource = callbacks => {
      const instance = { callbacks, videoId: '', stopped: 0, destroyed: 0, active: false };
      fixture.instances.push(instance);
      return {
        async start(input) {
          fixture.starts.push(input);
          instance.active = false;
          try { const selection = FCM.youtube.parseInput(input); instance.videoId = selection.videoId || 'AbCdEfGhI_1'; }
          catch (_) { callbacks.onStatus({ state: 'error', text: 'Enter a YouTube live video or channel URL.' }); return false; }
          if (!fixture.permission) {
            callbacks.onStatus({ state: 'permission', text: 'Allow YouTube access, then choose Add chat again.' });
            return false;
          }
          if (!fixture.online) {
            callbacks.onStatus({ state: 'error', text: 'This YouTube channel is not live right now.' });
            return false;
          }
          instance.active = true;
          fixture.captures++;
          callbacks.onStatus({ state: 'connected', text: 'YouTube connected' });
          return true;
        },
        stop() { instance.active = false; instance.stopped++; callbacks.onStatus({ state: 'stopped', text: 'YouTube is off.' }); },
        destroy() { instance.active = false; instance.destroyed++; callbacks.onStatus({ state: 'stopped', text: 'YouTube is off.' }); },
      };
    };
    fixture.emit = (rows, deleted = [], instance = fixture.instances.at(-1)) => {
      // Exercise the actual parser and sanitizer against real, synthetic DOM.
      const messages = rows.map(item => {
        const row = document.createElement('yt-live-chat-text-message-renderer'); row.id = item.id;
        const author = document.createElement('span'); author.id = 'author-name'; author.textContent = item.author;
        const body = document.createElement('span'); body.id = 'message'; body.textContent = item.text;
        if (item.emoji) { const emoji = document.createElement('img'); emoji.alt = item.emoji; body.appendChild(emoji); }
        row.append(author, body);
        return FCM.youtube.parseRow(row, instance.videoId, Date.now());
      });
      const run = '1234567890abcdef1234567890abcdef';
      const batch = FCM.youtube.sanitizeBatch({ type: 'batch', videoId: instance.videoId, run, ready: true,
        messages, deleted: deleted.map(id => `youtube:${instance.videoId}:${id}`) }, instance.videoId, run);
      if (!batch) throw Error('Synthetic fixture did not satisfy the reader contract');
      instance.callbacks.onBatch(batch);
    };
  });
  await page.locator('.devbar [data-act="site-twitch"]').click();
  await page.waitForFunction(() => youtubeFixture.instances.length === 1 && overlay.hostPlatform === 'twitch');
}

async function openPanel(page, platform, expand = true, saved = false) {
  const before = await page.evaluate(() => youtubeFixture.instances.length);
  await page.locator(`.devbar [data-act="site-${platform}"]`).click();
  await page.waitForFunction(({ before, platform }) => youtubeFixture.instances.length > before && overlay.hostPlatform === platform,
    { before, platform });
  await page.evaluate(() => {
    overlay.applyStoredSettings({ ...FCM.view.settings, autoClaimBonus: false, animations: false, hideNativeChat: true });
    overlay.setStatus('twitch', 'connected', 'examplestreamer');
    overlay.setStatus('kick', 'connected', 'examplestreamer-kick');
    overlay.setAccounts({ twitch: { connected: true, login: 'SyntheticTwitch' }, kick: { connected: true, login: 'SyntheticKick' } });
    overlay.setModerator('twitch', true); overlay.setModerator('kick', true);
  });
  if (!saved) assert.equal(await page.locator('.fcm-youtube form').isVisible(), false, 'controls begin collapsed');
  if (expand && !await page.locator('.fcm-youtube form').isVisible()) await page.locator('.fcm-youtube summary').click();
}

async function startChat(page, keyboard = false) {
  const input = keyboard ? 'https://www.youtube.com/@SyntheticChannel' : `https://www.youtube.com/watch?v=${VIDEO}`;
  await page.getByRole('textbox', { name: 'YouTube live video or channel URL', exact: true }).fill(input);
  if (keyboard) await page.locator('.fcm-youtube input[type=text]').press('Enter');
  else await page.getByRole('button', { name: 'Add chat', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#friendly-chat-merge-host').shadowRoot
    .querySelector('.fcm-youtube [role="status"]').textContent === 'YouTube connected');
}

async function persistentLinks(page, mode) {
  const channelUrl = 'https://www.youtube.com/@SavedStreamer';
  await page.evaluate(() => {
    youtubeFixture.pairs = { 'twitch:examplestreamer': 'examplestreamer-kick', 'kick:examplestreamer-kick': 'examplestreamer' };
  });
  await openPanel(page, 'twitch', false);
  await page.locator('.fcm-actions [data-act="settings"]').click();
  const shortcut = page.getByRole('button', { name: 'Link a YouTube channel', exact: true });
  await shortcut.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, `${mode}-youtube-link-settings.png`) });
  await page.locator('.fcm-sheet [data-act="close-sheet"]').click();
  await page.locator('.fcm-actions [data-act="collapse"]').click();
  assert.equal(await page.locator('.fcm-youtube-wrap').isVisible(), false);
  await page.locator('.fcm-actions [data-act="settings"]').click();
  await shortcut.click();
  assert.equal(await page.locator('.fcm-sheet').count(), 0, 'the settings entry opens the channel-link controls');
  assert.equal(await page.locator('.fcm-youtube form').isVisible(), true, 'the settings shortcut expands a collapsed panel');
  const input = page.getByRole('textbox', { name: 'YouTube live video or channel URL', exact: true });
  assert.equal(await input.evaluate(element => element.getRootNode().activeElement === element), true);
  const save = page.getByRole('button', { name: 'Save YouTube link', exact: true });
  const forget = page.getByRole('button', { name: 'Forget YouTube link', exact: true });
  const both = page.getByRole('checkbox', { name: /Also link kick\/examplestreamer-kick/i });
  await both.check();
  await input.fill('https://www.youtube.com/watch?v=AbCdEfGhI_1');
  await save.click();
  assert.equal(await page.evaluate(() => youtubeFixture.linkCalls.filter(call => call.cmd === 'youtubeLinkSave').length), 0,
    'a changing video ID cannot be saved as a persistent channel identity');
  await input.fill('https://m.youtube.com/@SavedStreamer/live');
  await save.evaluate(button => button.click());
  assert.equal(await page.evaluate(() => youtubeFixture.linkCalls.filter(call => call.cmd === 'youtubeLinkSave').length), 0,
    'page-generated clicks cannot authorize persistent links');
  await save.click();
  await page.waitForFunction(url => youtubeFixture.links['twitch:examplestreamer']?.channelUrl === url
    && youtubeFixture.instances.at(-1).active, channelUrl);
  const saved = await page.evaluate(() => youtubeFixture.links);
  assert.equal(saved['twitch:examplestreamer'].channelUrl, channelUrl);
  assert.equal(saved['kick:examplestreamer-kick'].channelUrl, channelUrl, 'the explicitly checked manual counterpart is saved too');
  assert.equal(await page.evaluate(() => youtubeFixture.starts.at(-1)), channelUrl, 'saving checks the channel immediately');
  assert.equal(await forget.isEnabled(), true);
  await forget.evaluate(button => button.click());
  assert.equal(await page.evaluate(() => youtubeFixture.linkCalls.filter(call => call.cmd === 'youtubeLinkForget').length), 0,
    'page-generated clicks cannot erase persistent links');

  const width = await page.locator('.chatcol:not(.kickcol)').evaluate(column => {
    const previous = { width: column.style.width, boxSizing: column.style.boxSizing };
    column.style.boxSizing = 'border-box';
    column.style.width = '260px';
    return previous;
  });
  await page.waitForFunction(() => document.querySelector('#friendly-chat-merge-host').shadowRoot
    .querySelector('.fcm-panel').getBoundingClientRect().width === 260);
  assert.equal(await page.locator('.fcm-youtube').evaluate(section => {
    const bounds = section.getBoundingClientRect();
    return [...section.querySelectorAll('input,button,p,label')].filter(element => element.getClientRects().length).every(element => {
      const rect = element.getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right;
    });
  }), true, 'saved-link controls remain within a narrow 260px panel');
  await page.screenshot({ path: path.join(output, `${mode}-saved-youtube-link.png`) });
  await page.locator('.chatcol:not(.kickcol)').evaluate((column, previous) => { Object.assign(column.style, previous); }, width);

  await page.getByRole('button', { name: 'Remove YouTube', exact: true }).click();
  assert.equal(await page.evaluate(() => youtubeFixture.links['twitch:examplestreamer'].channelUrl), channelUrl,
    'Remove pauses this visit without forgetting the saved identity');
  await input.fill('https://www.youtube.com/@TemporaryStreamer');
  await page.getByRole('button', { name: 'Add chat', exact: true }).click();
  assert.equal(await page.evaluate(() => youtubeFixture.starts.at(-1)), 'https://www.youtube.com/@TemporaryStreamer');
  assert.equal(await page.evaluate(() => youtubeFixture.links['twitch:examplestreamer'].channelUrl), channelUrl,
    'one-time Add does not overwrite a saved channel');

  for (const platform of ['kick', 'twitch']) {
    const before = await page.evaluate(() => youtubeFixture.starts.length);
    await openPanel(page, platform, false, true);
    await page.waitForFunction(before => youtubeFixture.starts.length > before && youtubeFixture.instances.at(-1).active, before);
    assert.equal(await page.locator('.fcm-youtube form').isVisible(), false, 'automatic loading keeps the setup controls collapsed');
    await page.locator('.fcm-youtube summary').click();
    assert.equal(await page.evaluate(() => youtubeFixture.starts.at(-1)), channelUrl,
      `returning to ${platform} resolves the saved channel automatically`);
    assert.equal(await page.evaluate(() => youtubeFixture.suggestions.at(-1).paused), true,
      'a saved identity takes precedence over guessed channel suggestions');
  }

  let captures = await page.evaluate(() => { youtubeFixture.online = false; return youtubeFixture.captures; });
  await openPanel(page, 'twitch', true, true);
  assert.match(await page.locator('.fcm-youtube [role="status"]').innerText(), /not live/);
  assert.equal(await page.evaluate(() => youtubeFixture.captures), captures, 'an offline saved channel does not attach capture');
  assert.equal(await page.evaluate(() => youtubeFixture.links['twitch:examplestreamer'].channelUrl), channelUrl);
  assert.equal(await page.locator('iframe[src*="youtube.com"]').count(), 0);
  captures = await page.evaluate(() => { youtubeFixture.online = true; youtubeFixture.permission = false; return youtubeFixture.captures; });
  await openPanel(page, 'kick', true, true);
  assert.match(await page.locator('.fcm-youtube [role="status"]').innerText(), /Allow YouTube access/);
  assert.equal(await page.evaluate(() => youtubeFixture.captures), captures, 'a saved link cannot override withheld site permission');
  assert.equal(await page.evaluate(() => youtubeFixture.links['kick:examplestreamer-kick'].channelUrl), channelUrl);
  await page.evaluate(() => { youtubeFixture.permission = true; });
  await openPanel(page, 'twitch', true, true);
  await forget.click();
  assert.equal(await page.evaluate(() => youtubeFixture.links['twitch:examplestreamer'] || null), null);
  assert.equal(await page.evaluate(() => youtubeFixture.links['kick:examplestreamer-kick'].channelUrl), channelUrl,
    'Forget affects only the currently identified host channel');
  assert.equal(await page.evaluate(() => youtubeFixture.instances.at(-1).active), false);
  const before = await page.evaluate(() => youtubeFixture.starts.length);
  await openPanel(page, 'twitch', false);
  assert.equal(await page.evaluate(() => youtubeFixture.starts.length), before, 'a forgotten host no longer auto-starts on arrival');
  await page.evaluate(() => { youtubeFixture.links = {}; youtubeFixture.pairs = {}; });
}

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(fs.readFileSync(file));
    } catch (_) { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const coverage = [], results = [];
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const mode of ['chrome', 'firefox']) {
      const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
      const blocked = [], youtubeRequests = [], errors = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        blocked.push(url.origin);
        if (url.hostname.endsWith('youtube.com')) youtubeRequests.push(url.href);
        return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
      await page.goto(`${origin}/tests/harness.html?browser=${mode}`);
      await page.locator('.fcm-msg').first().waitFor();
      await page.waitForFunction(() => typeof window.switchSite === 'function');
      // Normal Accounts settings omit developer redirect details in both browsers.
      // The harness records account commands; no real sign-in or disconnect occurs.
      await page.locator('.fcm-actions [data-act="settings"]').click();
      for (const connected of [false, true]) {
        await page.evaluate(({ connected, mode }) => overlay.setAccounts({
          twitch: { connected, login: 'FixtureTwitch' }, kick: { connected, login: 'FixtureKick' },
        }, { redirectUri: 'https://fixture.chromiumapp.org/', browser: mode }), { connected, mode });
        assert.equal(await page.locator('.fcm-sheet .fcm-code').count(), 0);
        for (const platform of ['twitch', 'kick']) {
          const button = page.locator(`.fcm-sheet [data-account="${platform}"]`);
          assert.equal(await button.textContent(), connected ? 'Disconnect' : 'Connect');
          await button.click();
          assert.deepEqual(await page.evaluate(() => window.commands.at(-1)),
            { cmd: connected ? 'disconnectAccount' : 'connectAccount', platform });
        }
      }
      await page.screenshot({ path: path.join(output, `${mode}-settings.png`) });
      await page.evaluate(() => overlay.authError('twitch', { message: 'Synthetic redirect configuration failure',
        needsRedirectSetup: true, redirectUri: 'https://fixture.chromiumapp.org/' }));
      assert.equal(await page.locator('.fcm-sheet .fcm-code').count(), 1, 'specific sign-in diagnostics remain available');
      assert.equal(await page.locator('.fcm-sheet .fcm-code').textContent(), 'https://fixture.chromiumapp.org/');
      assert.equal((await page.locator('.fcm-authfail').textContent()).includes("This is Firefox's address"), mode === 'firefox');
      await page.evaluate(() => overlay.setAccounts({ twitch: { connected: true }, kick: { connected: false } }));
      assert.equal(await page.locator('.fcm-sheet .fcm-code').count(), 0, 'success removes the failure-specific address');
      await page.locator('.fcm-sheet [data-act="close-sheet"]').click();
      assert.equal(await page.locator('iframe[src*="youtube.com"]').count(), 0);
      assert.equal(await page.locator('.fcm-youtube button:has-text("Remove YouTube")').isDisabled(), true);
      assert.equal(youtubeRequests.length, 0, 'default-off does not request YouTube');
      await installFixture(page);

      for (const platform of ['twitch', 'kick']) {
        await openPanel(page, platform, false);
        assert.equal(await page.evaluate(() => youtubeFixture.suggestions.slice(0, -1).every(instance => instance.destroyed === 1)), true,
          'site switching also destroys every previous discovery helper');
        assert.equal(await page.evaluate(platform => youtubeFixture.suggestions.at(-1).options.site.id === platform
          && youtubeFixture.suggestions.at(-1).options.channel === (platform === 'twitch' ? 'examplestreamer' : 'examplestreamer-kick'), platform), true);
        await page.evaluate(() => {
          overlay.setCounterpart({ exists: true, channel: 'linked-streamer', live: false });
          overlay.setCounterpart(null);
        });
        assert.deepEqual(await page.evaluate(() => youtubeFixture.suggestions.at(-1).counterparts.slice(-2)),
          [{ exists: true, channel: 'linked-streamer', live: false }, null], 'counterpart discovery is forwarded without changing the binary join flow');
        await page.locator('.fcm-youtube summary').click();
        await page.locator('.fcm-youtube input[type=text]').fill('https://www.youtube.com/@MyManualChannel');
        await page.locator('.fcm-youtube summary').click();
        const beforeSuggestion = await page.evaluate(() => youtubeFixture.starts.length);
        await page.evaluate(() => youtubeFixture.suggest([{ channelUrl: 'https://www.youtube.com/@examplestreamer',
          videoId: 'AbCdEfGhI_1', label: '@examplestreamer', match: 'same-name' }]));
        const prompt = page.locator('.fcm-youtube-suggestions');
        assert.equal(await prompt.isVisible(), true, 'a discovered live channel is offered outside the closed manual settings');
        assert.equal(await page.locator('.fcm-youtube form').isVisible(), false);
        assert.match(await prompt.innerText(), /Live on YouTube · Possible same-name match/);
        assert.equal(await prompt.locator('a').getAttribute('href'), 'https://www.youtube.com/@examplestreamer');
        assert.equal(await prompt.locator('a').getAttribute('rel'), 'noopener noreferrer');
        assert.equal(await page.evaluate(() => youtubeFixture.starts.length), beforeSuggestion, 'metadata arrival never starts chat capture');
        assert.equal(await page.locator('iframe[src*="youtube.com"]').count(), 0);
        assert.equal(await page.locator('.fcm-youtube input[type=text]').inputValue(), 'https://www.youtube.com/@MyManualChannel');
        await prompt.evaluate(box => [...box.querySelectorAll('button')].forEach(button => button.click()));
        assert.equal(await prompt.isVisible(), true, 'synthetic suggestion buttons cannot accept or dismiss a match');
        assert.equal(await page.evaluate(() => youtubeFixture.starts.length), beforeSuggestion);
        await page.locator('.fcm-actions [data-act="collapse"]').click();
        assert.equal(await page.locator('.fcm-youtube-wrap').isVisible(), false, 'collapse includes suggestions and manual controls');
        await page.locator('.fcm-actions [data-act="collapse"]').click();
        const width = await page.locator('.fcm-panel').evaluate(panel => {
          const previous = panel.style.width;
          panel.style.setProperty('width', '260px', 'important');
          return previous;
        });
        const fits = await prompt.evaluate(box => {
          const bounds = box.getBoundingClientRect();
          return [...box.querySelectorAll('a,button,p')].every(element => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right;
          });
        });
        assert.equal(fits, true, 'the live suggestion remains readable within a narrow 260px panel');
        await page.screenshot({ path: path.join(output, `${mode}-${platform}-suggestion.png`) });
        await page.locator('.fcm-panel').evaluate((panel, previous) => { panel.style.width = previous; }, width);
        await prompt.getByRole('button', { name: 'Dismiss', exact: true }).click();
        assert.equal(await prompt.isVisible(), false);
        await page.evaluate(() => youtubeFixture.suggest([{ channelUrl: 'https://www.youtube.com/@LateResult',
          videoId: 'AbCdEfGhI_1', label: '@LateResult', match: 'same-name' }]));
        assert.equal(await prompt.isVisible(), false, 'paused discovery ignores late metadata after dismissal');
        await page.locator('.fcm-youtube summary').click();
        await page.getByRole('button', { name: 'Check YouTube', exact: true }).evaluate(button => button.click());
        assert.equal(await page.evaluate(() => youtubeFixture.suggestions.at(-1).refreshes), 1, 'synthetic checks cannot resume discovery');
        await page.getByRole('button', { name: 'Check YouTube', exact: true }).click();
        assert.equal(await page.evaluate(() => youtubeFixture.suggestions.at(-1).refreshes), 2);
        await page.evaluate(() => youtubeFixture.suggest([{ channelUrl: 'https://www.youtube.com/@LinkedChannel',
          videoId: 'AbCdEfGhI_1', label: '@LinkedChannel', match: 'page-link' }]));
        assert.match(await prompt.innerText(), /Live on YouTube · Linked on this page/);
        await prompt.getByRole('button', { name: 'Add YouTube chat', exact: true }).click();
        assert.equal(await page.evaluate(() => youtubeFixture.starts.at(-1)), 'https://www.youtube.com/@LinkedChannel',
          'a genuine Add click resolves the suggested channel through the normal source start');
        assert.equal(await page.locator('.fcm-youtube input[type=text]').inputValue(), 'https://www.youtube.com/@MyManualChannel',
          'accepting a suggestion preserves the typed manual URL');
        assert.equal(await page.locator('.fcm-youtube form').isVisible(), true, 'the accepted source status is visible');
        assert.equal(await prompt.isVisible(), false);
        assert.equal(await page.getByRole('button', { name: 'Check YouTube', exact: true }).isDisabled(), true);
        await page.getByRole('button', { name: 'Remove YouTube', exact: true }).click();
        await page.evaluate(() => youtubeFixture.suggest([{ channelUrl: 'https://www.youtube.com/@AfterRemoval',
          videoId: 'AbCdEfGhI_1', label: '@AfterRemoval', match: 'same-name' }]));
        assert.equal(await prompt.isVisible(), false, 'removal leaves discovery paused until Check YouTube');
        assert.equal(await page.getByRole('button', { name: 'Check YouTube', exact: true }).isDisabled(), false);
        assert.equal(await page.evaluate(() => youtubeFixture.instances.slice(0, -1).every(instance => instance.destroyed === 1)), true,
          'site switching destroys every previous source');

        const syntheticActivation = await page.evaluate(video => {
          const form = document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-youtube form');
          const input = form.querySelector('input'), add = [...form.querySelectorAll('button')].find(button => button.textContent === 'Add chat');
          input.value = video;
          const before = youtubeFixture.starts.length;
          form.requestSubmit(); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          add.click(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
          return { before, after: youtubeFixture.starts.length };
        }, VIDEO);
        assert.equal(syntheticActivation.after, syntheticActivation.before, 'host scripts cannot opt a viewer into YouTube capture');

        await page.locator('.fcm-youtube input[type=text]').fill('not a video');
        await page.getByRole('button', { name: 'Add chat', exact: true }).click();
        assert.match(await page.locator('.fcm-youtube [role="status"]').innerText(), /Enter a YouTube/);
        assert.equal(await page.getByRole('button', { name: 'Remove YouTube', exact: true }).isDisabled(), true);
        await page.evaluate(() => { youtubeFixture.permission = false; });
        await page.locator('.fcm-youtube input[type=text]').fill(VIDEO);
        await page.getByRole('button', { name: 'Add chat', exact: true }).click();
        assert.match(await page.locator('.fcm-youtube [role="status"]').innerText(), /Allow YouTube access/);
        await page.evaluate(() => { youtubeFixture.permission = true; });
        await startChat(page, platform === 'kick');
        assert.equal(await page.evaluate(() => youtubeFixture.starts.at(-1)), platform === 'kick'
          ? 'https://www.youtube.com/@SyntheticChannel' : `https://www.youtube.com/watch?v=${VIDEO}`);
        await page.evaluate(() => {
          overlay.chat({ platform: 'twitch', messageId: 'synthetic-twitch', author: 'TwitchViewer', text: 'Hello from Twitch', timestamp: Date.now() });
          overlay.chat({ platform: 'kick', messageId: 'synthetic-kick', author: 'KickViewer', text: 'Hello from Kick', timestamp: Date.now() });
          const item = { id: 'synthetic-youtube', author: 'YouTubeViewer <script>',
            text: 'Hello from YouTube <img src=x onerror=alert(1)> & ', emoji: '😀' };
          youtubeFixture.emit([item]); youtubeFixture.emit([item]);
          youtubeFixture.emit([{ id: 'second', author: 'EmojiReader', text: 'Emoji stay readable ', emoji: '🙂' }]);
        });
        const rows = page.locator('.fcm-msg[data-platform="youtube"]');
        await rows.nth(1).waitFor();
        assert.equal(await rows.count(), 2, 'normal feed deduplicates the repeated YouTube message ID');
        assert.equal(await page.locator('.fcm-feed .fcm-msg[data-platform="twitch"]').count(), 1);
        assert.equal(await page.locator('.fcm-feed .fcm-msg[data-platform="kick"]').count(), 1);
        assert.equal(await rows.locator('.fcm-chip-youtube').count(), 0, 'YouTube authors have no extra platform badge');
        assert.equal(await rows.first().locator('.fcm-author').getAttribute('data-name'), 'YouTubeViewer <script>');
        assert.equal(await rows.first().locator('.fcm-body').innerText(), 'Hello from YouTube <img src=x onerror=alert(1)> & 😀');
        assert.equal(await rows.first().locator('img,script,a').count(), 0, 'captured markup and URLs never become rich content');
        assert.equal(await rows.first().locator('.fcm-author').getAttribute('title'), 'YouTube · replies and moderation unavailable');

        await page.locator('.fcm-input').fill('Keep my draft');
        const commandCount = await page.evaluate(() => youtubeFixture.commands.length);
        await rows.first().locator('.fcm-author').click();
        await rows.first().locator('.fcm-author').hover();
        assert.equal(await page.locator('.fcm-input').innerText(), 'Keep my draft');
        assert.equal(await page.locator('.fcm-um').isVisible(), false);
        assert.equal(await page.locator('.fcm-reply').isVisible(), false);
        assert.equal(await rows.first().locator('.fcm-modbar').count(), 0);
        assert.equal(await page.evaluate(() => youtubeFixture.commands.length), commandCount, 'no profile, reply, or moderation command');
        assert.equal(await page.evaluate(() => FCM.recentChatters().some(chatter => chatter.platform === 'youtube')), false);
        const styles = await rows.first().evaluate(row => {
          const author = getComputedStyle(row.querySelector('.fcm-author'));
          return { cursor: author.cursor, decoration: author.textDecorationLine,
            author: author.color,
            dot: getComputedStyle(row.querySelector('.fcm-dot-youtube')).backgroundColor };
        });
        assert.equal(styles.cursor, 'text'); assert.equal(styles.decoration, 'none');
        for (const color of [styles.author, styles.dot]) {
          const [red, green, blue] = color.match(/\d+/g).map(Number);
          assert.ok(red > green && red > blue, 'YouTube author and dot retain their red platform color');
        }
        await page.locator('.fcm-input').fill('');

        await page.locator('.fcm-actions [data-act="collapse"]').click();
        assert.equal(await page.locator('.fcm-youtube').isVisible(), false, 'collapse hides the trial controls');
        await page.locator('.fcm-actions [data-act="collapse"]').click();
        await page.locator('.fcm-youtube input[type=text]').waitFor();
        const geometry = await page.locator('.fcm-youtube').evaluate(section => {
          const outer = section.getBoundingClientRect(), input = section.querySelector('input').getBoundingClientRect();
          return { inside: input.left >= outer.left && input.right <= outer.right, height: outer.height };
        });
        assert.equal(geometry.inside, true, 'URL field fits the chat column');
        assert.ok(geometry.height > 0);
        await page.screenshot({ path: path.join(output, `${mode}-${platform}-merged.png`) });

        await page.evaluate(() => youtubeFixture.emit([], ['synthetic-youtube']));
        assert.equal(await rows.first().evaluate(row => row.classList.contains('fcm-deleted')), true);

        if (platform === 'kick') {
          const other = await context.newPage();
          other.on('pageerror', error => errors.push(error.message));
          await other.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
          await other.goto(`${origin}/tests/harness.html?browser=${mode}`);
          await other.locator('.fcm-msg').first().waitFor();
          await other.waitForFunction(() => typeof window.switchSite === 'function');
          await installFixture(other); await openPanel(other, 'twitch'); await startChat(other);
          await other.evaluate(() => youtubeFixture.emit([{ id: 'other-tab', author: 'OtherTab', text: 'Only in the second tab' }]));
          await other.locator('.fcm-msg[data-platform="youtube"]').waitFor();
          assert.equal(await page.locator('.fcm-author[data-name="OtherTab"]').count(), 0, 'one tab does not render another source');
          await page.getByRole('button', { name: 'Remove YouTube', exact: true }).click();
          assert.equal(await other.locator('.fcm-msg[data-platform="youtube"]').count(), 1, 'removing one source leaves the other feed intact');
          coverage.push(...await other.coverage.stopJSCoverage());
          await other.close();
          await startChat(page);
        }

        // Removal during the same JS task must purge pending feed rows as well.
        await page.evaluate(() => {
          youtubeFixture.emit([{ id: 'queued-before-remove', author: 'QueuedViewer', text: 'Never appears after removal' }]);
          const form = document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('.fcm-youtube form');
          [...form.querySelectorAll('button')].find(button => button.textContent === 'Remove YouTube').click();
        });
        await page.waitForTimeout(350);
        assert.equal(await rows.count(), 0, 'removal clears both visible and queued YouTube rows');
        assert.equal(await page.locator('.fcm-msg[data-platform="twitch"]').count(), 1);
        assert.equal(await page.locator('.fcm-msg[data-platform="kick"]').count(), 1);
      }

      await persistentLinks(page, mode);

      // Both sides of the optional overlay hook are exercised with real mount/destroy.
      await page.evaluate(async () => {
        const attach = FCM.attachYouTubeControls;
        FCM.attachYouTubeControls = undefined;
        await switchSite('twitch');
        overlay.setCounterpart(null);
        document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('[data-act="settings"]').click();
        if (document.querySelector('#friendly-chat-merge-host').shadowRoot.querySelector('[data-act="youtube-link"]')) {
          throw Error('The settings shortcut requires the YouTube controls');
        }
        FCM.attachYouTubeControls = attach;
        await switchSite('kick');
      });
      assert.equal(await page.locator('#friendly-chat-merge-host').count(), 1);
      assert.equal(await page.locator('.fcm-youtube').count(), 1);
      await page.evaluate(() => {
        const previous = youtubeFixture.suggestions.at(-2);
        previous.options.onSuggestions([{ channelUrl: 'https://www.youtube.com/@OldChannel',
          videoId: 'AbCdEfGhI_1', label: '@OldChannel', match: 'same-name' }]);
      });
      assert.equal(await page.locator('.fcm-youtube-suggestions').isVisible(), false, 'destroyed controls reject even a stale callback');
      assert.equal(youtubeRequests.length, 0, 'the entire synthetic test performs no YouTube requests');
      assert.deepEqual(errors, []);
      coverage.push(...await page.coverage.stopJSCoverage());
      results.push({ browserEngine: 'installed Chrome', simulatedBrowserMode: mode, passed: true,
        youtubeRequests: youtubeRequests.length, externalRequestsServed: 0, blockedExternalRequests: blocked.length, errors });
      await context.close();
      console.log(`${mode === 'firefox' ? 'Chrome with simulated Firefox branches' : 'Chrome'}: synthetic YouTube merge checks passed`);
    }
    fs.writeFileSync(path.join(output, 'browser-coverage.json'), JSON.stringify(coverage));
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
