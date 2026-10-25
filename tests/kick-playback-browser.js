// Isolated installed-Chrome comparison; no account, live stream or external requests.
// FCM_PLAYWRIGHT_PATH=<existing playwright> node tests/kick-playback-browser.js <artifacts>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || 'dist/kick-playback-performance/browser');
// Pin the pre-optimization reference so this comparison still works after merge.
const baselineRef = process.env.FCM_PLAYBACK_BASE || '8c6ca38dd2fa91771883171a5279241e518e058c';
const oldOverlay = execFileSync('git', ['show', `${baselineRef}:src/content/overlay.js`], { cwd: ROOT, encoding: 'utf8' });
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

async function spellingChecks(page, mode) {
  for (const platform of ['twitch', 'kick']) {
    await page.evaluate(platform => switchSite(platform), platform);
    const input = page.locator('.fcm-input');
    assert.equal(await input.evaluate(el => el.spellcheck), true, 'issue #83: browser spellchecking is enabled');
    await page.evaluate(platform => {
      overlay.setEmotes(platform, 'thirdparty', {
        LocalCheckEmote: { url: 'https://fixture.invalid/emote.png', source: 'Fixture' },
      });
    }, platform);
    await input.fill('teh ');
    await input.press('End'); await input.pressSequentially('LocalCheckEmote ');
    assert.equal(await input.locator('img.fcm-input-emote').count(), 1, 'ordinary emote completion still works');
    const corrected = await input.evaluate(el => {
      const contextMenu = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true });
      const nativeMenuAllowed = el.dispatchEvent(contextMenu);
      // Model the browser applying a suggested replacement to the text node.
      // Browser dictionaries and their OS-rendered menu are outside this headless fixture.
      el.firstChild.replaceData(0, 3, 'the');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: 'the' }));
      return { value: el.value, nativeMenuAllowed, image: el.querySelector('img')?.alt };
    });
    assert.equal(corrected.nativeMenuAllowed, true, 'the extension leaves the spelling context menu available');
    assert.equal(corrected.value, 'the LocalCheckEmote ');
    assert.equal(corrected.image, 'LocalCheckEmote', 'correction preserves inline emotes');
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('[data-act="popout"]').click()]);
    const poppedInput = popup.locator('.fcm-input'); await poppedInput.waitFor();
    assert.equal(await poppedInput.evaluate(el => el.spellcheck), true, 'pop-out keeps browser spellchecking enabled');
    assert.equal(await poppedInput.evaluate(el => el.value), corrected.value, 'moving windows retains the corrected draft');
    await popup.screenshot({ path: path.join(output, `${mode}-${platform}-spelling-popout.png`) });
    await popup.close(); await input.waitFor();
    assert.equal(await input.evaluate(el => el.spellcheck), true, 'docking keeps spelling enabled');
    assert.equal(await input.evaluate(el => el.value), corrected.value, 'correction never sends or clears the draft');
    await input.fill('');
  }
}

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
  const results = [];
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const mode of ['chrome', 'firefox']) for (const baseline of [true, false]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) {
          if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body: pixel });
          return route.abort();
        }
        if (baseline && url.pathname === '/src/content/overlay.js') {
          return route.fulfill({ contentType: 'text/javascript', body: oldOverlay });
        }
        return route.continue();
      });
      await page.addInitScript(() => {
        window.probe = { rects: 0, controls: 0, resize: null, tick: null };
        const interval = window.setInterval;
        window.setInterval = (fn, ms, ...args) => {
          if (ms === 500) window.probe.tick = fn;
          return interval(() => { if (!window.probe.measuring) fn(...args); }, ms);
        };
        const bounds = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function () {
          if (this.id === 'channel-chatroom') window.probe.rects++;
          return bounds.call(this);
        };
        const Observer = window.ResizeObserver;
        window.ResizeObserver = class extends Observer {
          constructor(callback) { super(callback); this.callback = callback; }
          observe(target, options) {
            if (target.id === 'channel-chatroom') window.probe.resize = this.callback;
            return super.observe(target, options);
          }
        };
      });
      const load = async () => {
        await page.goto(`${origin}/tests/harness.html?browser=${mode}`);
        await page.waitForFunction(() => !!window.switchSite);
        await page.evaluate(async () => {
          const native = FCM.SITES.kick.nativeControls;
          FCM.SITES.kick.nativeControls = function () { window.probe.controls++; return native.call(this); };
          await window.switchSite('kick');
        });
        await page.waitForFunction(() => !!window.probe.resize);
      };
      await load();
      if (!baseline) {
        await page.evaluate(() => overlay.applyStoredSettings({ ...FCM.DEFAULT_SETTINGS, hideNativeChat: true }));
        assert.equal(await page.evaluate(() => getComputedStyle(FCM.SITES.kick.nativeChatBody()).visibility), 'visible',
          'the obsolete saved flag cannot hide Kick chat');
        await page.locator('[data-act="settings"]').click();
        assert.equal(await page.locator('[data-set="hideNativeChat"]').count(), 0);
        assert.equal(await page.locator('[data-set="revealHighlights"]').count(), 1);
        await page.locator('[data-act="close-sheet"]').click();
        const optionsPage = await context.newPage();
        await optionsPage.goto(`${origin}/tests/options-harness.html?browser=${mode}`);
        await optionsPage.locator('#revealHighlights').waitFor();
        assert.equal(await optionsPage.locator('#hideNativeChat').count(), 0, 'All Settings removes the control too');
        await optionsPage.screenshot({ path: path.join(output, `${mode}-options.png`) });
        await optionsPage.close();
        await spellingChecks(page, mode);
      }
      const counts = await page.evaluate(async () => {
        const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        probe.measuring = true;
        await nextFrame();
        probe.controls = 0; probe.tick(); const controlsPerTick = probe.controls;
        probe.rects = 0;
        for (let i = 0; i < 1000; i++) probe.resize([]);
        const synchronousResizeReads = probe.rects;
        await nextFrame();
        const resizeReadsAfterFrame = probe.rects;
        const list = document.querySelector('#chatroom-messages');
        let scrollReads = 0;
        for (let i = 0; i < 12; i++) {
          probe.rects = 0; list.dispatchEvent(new Event('scroll')); await nextFrame(); scrollReads += probe.rects;
        }
        probe.measuring = false;
        return { controlsPerTick, synchronousResizeReads, resizeReadsAfterFrame, scrollReads };
      });
      assert.equal(counts.controlsPerTick, baseline ? 2 : 1);
      assert.equal(counts.synchronousResizeReads > 0, baseline);
      if (!baseline) assert.ok(counts.resizeReadsAfterFrame > 0 && counts.resizeReadsAfterFrame <= 6,
        'the deferred frame still measures and places the column once');
      assert.equal(counts.scrollReads > 0, baseline);
      // A local moving video changes intrinsic dimensions while chat loads and
      // the viewport resizes. This exercises layout overlap, not Kick's ABR codec/network path.
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const video = document.createElement('video'); video.id = 'fixture-video'; video.muted = true;
        video.style.cssText = 'width:100%;height:100%;object-fit:contain';
        document.querySelector('.player').replaceChildren(video);
        const ctx = canvas.getContext('2d'); let frame = 0;
        const draw = setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#333399' : '#339933'; ctx.fillRect(0, 0, canvas.width, canvas.height); }, 33);
        const stream = canvas.captureStream(30); video.srcObject = stream; await video.play();
        window.fixtureVideo = { canvas, video, stream, draw };
        window.overlay.applyStoredSettings({ ...FCM.DEFAULT_SETTINGS, autoClaimBonus: false });
      });
      for (const [width, height] of [[640, 360], [1280, 720], [1920, 1080], [640, 360]]) {
        await page.evaluate(([width, height]) => {
          fixtureVideo.canvas.width = width; fixtureVideo.canvas.height = height;
          for (let i = 0; i < 100; i++) overlay.chat({ platform: i % 2 ? 'kick' : 'twitch',
            author: 'Fixture', text: 'Local message', messageId: `${width}-${height}-${Math.random()}` });
        }, [width, height]);
        await page.setViewportSize({ width: width === 1920 ? 1280 : 1440, height: 1000 });
        await page.waitForFunction(([width, height]) => fixtureVideo.video.videoWidth === width
          && fixtureVideo.video.videoHeight === height, [width, height]);
      }
      const state = await page.evaluate(() => {
        const shadow = document.querySelector('#friendly-chat-merge-host').shadowRoot;
        const panel = shadow.querySelector('.fcm-panel').getBoundingClientRect();
        const column = FCM.SITES.kick.chatContainer().getBoundingClientRect();
        return { playing: !fixtureVideo.video.paused, time: fixtureVideo.video.currentTime,
          ready: fixtureVideo.video.readyState, hosts: document.querySelectorAll('#friendly-chat-merge-host').length,
          rows: shadow.querySelector('.fcm-feed').children.length, panel: { left: panel.left, width: panel.width },
          column: { left: column.left, width: column.width } };
      });
      assert.equal(state.playing, true); assert.ok(state.time > 0); assert.ok(state.ready >= 2);
      assert.equal(state.hosts, 1); assert.ok(state.rows <= 400);
      assert.equal(state.panel.left, state.column.left); assert.equal(state.panel.width, state.column.width);
      assert.deepEqual(errors, []);
      if (!baseline) await page.screenshot({ path: path.join(output, `${mode}-current.png`) });
      await page.evaluate(() => { clearInterval(fixtureVideo.draw); fixtureVideo.stream.getTracks().forEach(track => track.stop()); });
      await load();
      assert.equal(await page.locator('#friendly-chat-merge-host').count(), 1, 'refresh remounts once');
      results.push({ mode: mode === 'firefox' ? 'simulated Firefox in Chrome' : 'Chrome', baseline, ...counts, state });
      await context.close();
    }
    fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    console.log('Isolated playback/layout, refresh and before/after performance checks passed.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
