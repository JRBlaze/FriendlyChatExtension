// Local synthetic pages only; no platform services or signed-in profiles.
// FCM_PLAYWRIGHT_PATH=<existing-install> node tests/collapsible-controls-browser.js <output>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, firefox } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2]);
const injection = `
  chrome.runtime.sendMessage = async message => message.cmd === 'youtubeLinkGet'
    ? {ok:true,link:null,counterpart:null} : null;
  FCM.createYouTubeSuggestions = hooks => {
    window.suggestionHooks = hooks;
    return {pause(){},refresh(){},updateCounterpart(){},destroy(){}};
  };
  FCM.createYouTubeSource = hooks => ({
    async start() { window.youtubeStarts = (window.youtubeStarts || 0) + 1; return true; },
    stop(){},destroy(){},getSendState(){return {available:false};},
    openAccessSetup(){return false;},closeAccessSetup(){},send(){throw Error('Unexpected send');}
  });
`;

async function checks(browser, origin, name, mode) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 820 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  try {
    await page.goto(`${origin}/tests/harness.html?browser=${mode}`);
    await page.locator('.fcm-platform-section').waitFor();
    assert.equal(await page.locator('.fcm-platform-section').evaluate(node => node.open), true);
    assert.equal(await page.locator('.fcm-send-section').evaluate(node => node.open), true);
    for (const host of ['twitch', 'kick']) {
      await page.evaluate(host => switchSite(host), host);
      await page.evaluate(host => {
        const other = host === 'twitch' ? 'kick' : 'twitch';
        overlay.setStatus(host, 'connected', 'synthetic');
        overlay.setStatus(other, 'idle', '');
        overlay.setCounterpart({exists:true,live:true,channel:'found',displayName:'Synthetic'});
      }, host);
      const platforms = page.locator('.fcm-platform-section');
      const sending = page.locator('.fcm-send-section');
      const feed = page.locator('.fcm-feed');
      const height = (await feed.boundingBox()).height;
      const summary = platforms.locator(':scope > summary');
      await summary.click();
      assert.equal(await platforms.evaluate(node => node.open), false);
      assert.equal(await page.locator('.fcm-chips').isVisible(), false);
      assert.equal(await page.locator('.fcm-youtube-wrap').isVisible(), false);
      assert.equal(await page.locator('.fcm-prompt').isVisible(), false);
      assert.match(await summary.innerText(), /found - not added/);
      assert.ok((await feed.boundingBox()).height > height + 30, 'collapsing frees feed space');
      await page.evaluate(() => suggestionHooks.onSuggestions([
        {match:'page-link',label:'Synthetic YouTube',channelUrl:'https://www.youtube.com/@Synthetic'}
      ]));
      assert.match(await summary.innerText(), /YouTube/);
      await page.evaluate(host => overlay.setStatus(host === 'twitch' ? 'kick' : 'twitch', 'connected', 'found'), host);
      assert.match(await summary.innerText(), /YouTube found/);
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await platforms.evaluate(node => node.open), true, 'keyboard expansion works');
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
      assert.equal(await page.locator('.fcm-platform-notice').isVisible(), false);
      await page.evaluate(() => suggestionHooks.onSuggestions([
        {match:'page-link',label:'Synthetic YouTube',channelUrl:'https://www.youtube.com/@Synthetic'}
      ]));
      await page.getByRole('button', { name: 'Add YouTube chat', exact: true }).click();
      assert.equal(await page.locator('.fcm-platform-notice').isVisible(), false);
      const before = await page.evaluate(() => youtubeStarts);
      await summary.click();
      assert.equal(await page.evaluate(() => youtubeStarts), before, 'collapse never restarts capture');
      const targets = await page.locator('.fcm-target').evaluateAll(nodes => nodes.map(node => ({...node.dataset})));
      const sendSummary = sending.locator(':scope > summary');
      await sendSummary.click();
      assert.equal(await sending.evaluate(node => node.open), false);
      assert.equal(await page.locator('.fcm-targets').isVisible(), false);
      assert.match(await sendSummary.innerText(), /Send to/);
      assert.equal(await page.locator('.fcm-input').isVisible(), true);
      assert.equal(await page.locator('.fcm-send').isVisible(), true);
      await page.screenshot({ path: path.join(output, `${name}-${host}-collapsed.png`) });
      await sendSummary.focus();
      await page.keyboard.press('Space');
      assert.equal(await sending.evaluate(node => node.open), true);
      assert.deepEqual(await page.locator('.fcm-target').evaluateAll(nodes => nodes.map(node => ({...node.dataset}))), targets);
      await page.setViewportSize({width:800,height:700});
      await summary.click();
      assert.equal(await platforms.evaluate(node => node.open), true);
      await page.screenshot({ path: path.join(output, `${name}-${host}-expanded.png`) });
    }
    await page.locator('.fcm-platform-section > summary').click();
    await page.locator('.fcm-send-section > summary').click();
    await page.waitForFunction(() => mem.local.fcm_settings_v1?.platformsCollapsed === true && mem.local.fcm_settings_v1?.sendToCollapsed === true);
    await page.evaluate(() => switchSite('twitch'));
    assert.equal(await page.locator('.fcm-platform-section').evaluate(node => node.open), false);
    assert.equal(await page.locator('.fcm-send-section').evaluate(node => node.open), false, 'remount restores saved collapse choices');
    await page.goto(origin + '/src/releases/notes.html');
    for (const width of [375, 1100]) for (const colorScheme of ['dark', 'light']) {
      await page.setViewportSize({width, height:820});
      await page.emulateMedia({colorScheme});
      assert.equal(await page.locator('h2').count(), 5);
      assert.match(await page.locator('h1').innerText(), /update/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({path:path.join(output, `${name}-notes-${width}-${colorScheme}.png`),fullPage:true});
    }
    assert.deepEqual(errors, []);
    console.log(`${name}: Twitch/Kick collapse, notifications, keyboard, and target preservation passed.`);
  } finally { await context.close(); }
}

async function main() {
  fs.mkdirSync(output, {recursive:true});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.resolve(ROOT, '.' + url.pathname);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css'};
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    let content = fs.readFileSync(file);
    if (url.pathname === '/tests/harness.html') content = content.toString().replace('  let overlay = FCM.createOverlay({', injection + '\n  let overlay = FCM.createOverlay({');
    res.end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const chrome = await chromium.launch({channel:'chrome',headless:true});
    try { await checks(chrome, origin, 'chrome', 'chrome'); await checks(chrome, origin, 'firefox-mode', 'firefox'); }
    finally { await chrome.close(); }
    if (fs.existsSync(firefox.executablePath())) {
      const ff = await firefox.launch({headless:true});
      try { await checks(ff, origin, 'firefox', 'firefox'); } finally { await ff.close(); }
    } else console.log('Native Firefox not run: no existing Playwright Firefox runtime.');
  } finally { server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
