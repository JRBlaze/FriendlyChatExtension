// Shipped renderer, stylesheet and feed over a local fixture; all remote requests blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const scripts = ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/youtube.js', 'src/shared/util.js',
  'src/shared/irc.js', 'src/shared/emote-parsers.js', 'src/shared/kick-events.js', 'src/shared/clips.js',
  'src/content/render.js', 'src/content/feed.js', 'tests/contrast.js'];
function html(mode) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Local highlighted chat fixture</title><style>body{margin:0;background:white}#host{display:block;margin:16px;width:460px;max-width:calc(100vw - 32px)}</style>
  <div id="host"></div><script>self.FCM={BROWSER:${JSON.stringify(mode)}};</script>
  ${scripts.map(file => `<script src="/${file}"></script>`).join('\n')}
  <script>
  const shadow=document.querySelector('#host').attachShadow({mode:'open'});
  shadow.innerHTML='<link rel="stylesheet" href="/src/content/overlay.css"><style>.fcm-panel{position:static;width:100%;height:620px;opacity:.96}.fixture-title{padding:12px;font-size:13px;color:var(--text)}.fcm-feed{height:570px;flex:none}</style>'
    +'<div class="fcm-root" data-theme="dark" data-animate="false" data-timestamps="true" data-badges="true"><div class="fcm-panel"><div class="fixture-title">Friendly Chat · highlighted messages</div><div class="fcm-feed"></div></div></div>';
  const root=shadow.querySelector('.fcm-root'),feedEl=shadow.querySelector('.fcm-feed');
  const settings={...FCM.DEFAULT_SETTINGS,animations:false,highlightNames:'urgent, red alert'};
  FCM.setViewSettings(settings);
  FCM.setMentionAccounts({twitch:{connected:true,login:'JRBlaze'},kick:{connected:false}});
  FCM.setYouTubeIdentity('@YTViewer');
  const feed=FCM.createFeed(feedEl,()=>settings),filter=new Set(['twitch','kick','youtube']);
  const messages=[
    {platform:'twitch',author:'L_U_R_K_3_R',text:'good morning everyone',color:'#808080'},
    {platform:'twitch',author:'L_U_R_K_3_R',text:'jrblaze good day',color:'#808080'},
    {platform:'kick',author:'AnotherViewer',text:'This is URGENT — please take a look.',color:'#0000ff'},
    {platform:'youtube',author:'VideoViewer',text:'@YTViewer hello from YouTube',color:'#123456'},
    {platform:'twitch',author:'FirstViewer',text:'@JRBlaze this is my first message',firstMessage:true,color:'#ff0000'},
    {platform:'twitch',author:'JRBlaze',text:'urgent: my own message',color:'#1e90ff'},
    {platform:'kick',author:'AnotherViewer',text:'JRBlazeFan is urgently watching',color:'#daa520'},
    {platform:'twitch',author:'ActionViewer',text:'@JRBlaze waves hello',action:true,color:'#123456'}
  ];
  function populate(){feed.clear();messages.forEach((message,index)=>feed.addMessage({...message,messageId:'demo-'+index,timestamp:Date.UTC(2026,9,9,23,18)},filter));}
  window.fixture={shadow,root,feedEl,feed,settings,messages,populate};populate();
  </script>`;
}

async function run(output) {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/fixture') { res.setHeader('Content-Type', 'text/html'); res.end(html(url.searchParams.get('mode'))); return; }
    const file = path.resolve(ROOT, '.' + url.pathname);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    try { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(fs.readFileSync(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, results = [];
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const mode of ['chrome', 'firefox']) {
      const context = await browser.newContext({ viewport: { width: 620, height: 740 }, timezoneId: 'America/New_York' });
      const errors = [], blocked = [];
      try {
        await context.route('**/*', route => {
          if (new URL(route.request().url()).origin === origin) return route.continue();
          blocked.push(route.request().url()); return route.abort();
        });
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/fixture?mode=' + mode);
        await page.waitForFunction(() => fixture.feedEl.children.length === 8);
        const counts = await page.evaluate(() => ({ rows: fixture.feedEl.children.length,
          highlights: fixture.feedEl.querySelectorAll('.fcm-mentioned').length, tags: fixture.feedEl.querySelectorAll('.fcm-highlight-tag').length }));
        assert.deepEqual(counts, { rows: 8, highlights: 5, tags: 5 });
        assert.equal(await page.evaluate(() => fixture.feedEl.children[1].querySelector('.fcm-body').textContent), 'jrblaze good day', 'copy omits the highlight label');
        for (const theme of ['dark', 'light']) {
          await page.evaluate(theme => { fixture.root.dataset.theme = theme; }, theme);
          for (const size of [10, 14, 22]) {
            await page.evaluate(size => {
              fixture.root.style.setProperty('--fcm-size',size+'px');
              fixture.feedEl.querySelectorAll('.fcm-msg').forEach(row=>{row.style.contentVisibility='visible';});
            }, size);
            const failures = await page.evaluate(() => __auditContrast([fixture.feedEl]));
            assert.deepEqual(failures, [], `${mode} ${theme} ${size}px contrast`);
          }
          await page.evaluate(() => fixture.root.style.setProperty('--fcm-size','14px'));
          await page.screenshot({ path: path.join(output, `${mode}-${theme}.png`), fullPage: true });
          const colors = await page.evaluate(() => {
            const row=fixture.feedEl.children[1];return { highlighted:getComputedStyle(row).backgroundColor,
              normal:getComputedStyle(fixture.feedEl.children[0]).backgroundColor, edge:getComputedStyle(row).boxShadow };
          });
          assert.notEqual(colors.highlighted, colors.normal);
          assert.match(colors.edge, /inset/);
          await page.setViewportSize({ width: 320, height: 740 });
          assert.equal(await page.locator('body').evaluate(node=>node.scrollWidth<=innerWidth),true);
          const collision = await page.evaluate(() => {
            const row=fixture.feedEl.children[1],tag=row.querySelector('.fcm-highlight-tag').getBoundingClientRect(),body=row.querySelector('.fcm-body').getBoundingClientRect();
            return tag.bottom>body.top;
          });
          assert.equal(collision,false,'label has its own line at narrow widths');
          await page.screenshot({ path: path.join(output, `${mode}-${theme}-320.png`), fullPage: true });
          await page.setViewportSize({ width: 620, height: 740 });
        }
        await page.evaluate(()=>{
          fixture.feed.clear();for(let i=0;i<100;i++)fixture.feed.addMessage({platform:'twitch',author:'AnotherViewer',text:'@JRBlaze red alert '+i,messageId:'stress-'+i},new Set(['twitch']));
          fixture.feed.scrollToBottom();
        });
        await page.waitForFunction(()=>fixture.feedEl.children.length===100);
        await page.waitForTimeout(600);
        const pinned=await page.evaluate(()=>fixture.feedEl.lastElementChild.getBoundingClientRect().bottom<=fixture.feedEl.getBoundingClientRect().bottom+2);
        assert.equal(pinned,true,'highlight rows retain pinned-feed scrolling');
        assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
        results.push({mode,nativeBrowser:'Chrome',counts,errors,blocked});
      } finally { await context.close(); }
    }
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
    console.log('Mention highlights: Chrome and simulated Firefox, both themes, 320px, 10/14/22px, contrast and pinned feed passed.');
  } finally { if(browser)await browser.close();await new Promise(resolve=>server.close(resolve)); }
}
module.exports = { run };
if(require.main===module)run(path.resolve(process.argv[2])).catch(error=>{console.error(error);process.exitCode=1;});
