// Synthetic chat only: actual composer/menu CSS, no platform traffic or moderation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
function html() {
  return `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/content/overlay.css">
    <div class="fcm-root" style="position:relative;width:320px;height:620px"><div class="fcm-feed" style="height:480px"></div><textarea></textarea></div>
    ${['namespace','constants','util','irc','youtube','emote-parsers'].map(file => `<script src="/src/shared/${file}.js"></script>`).join('')}
    <script src="/src/content/render.js"></script><script src="/src/content/compose.js"></script><script>
    FCM.setViewSettings(FCM.DEFAULT_SETTINGS);
    const root=document.querySelector('.fcm-root'),feed=document.querySelector('.fcm-feed');
    window.actions=[];window.moderator=true;
    window.compose=FCM.createCompose({panel:root,feedEl:feed,inputEl:document.querySelector('textarea'),hostPlatform:'twitch',
      canModerate:()=>moderator,onModerate:(...args)=>actions.push(args),onProfile:async()=>null,onHistory:()=>[]});
    for(const platform of ['twitch','kick','youtube'])feed.appendChild(FCM.buildMessageEl({platform,author:'Viewer',userId:'viewer',messageId:platform+'-id',text:'A useful message for the stream.'}));
    const noId=FCM.buildMessageEl({platform:'twitch',author:'NoId',text:'A row without a message ID.'});feed.appendChild(noId);
    </script>`;
}
async function run(output) {
  fs.mkdirSync(output,{recursive:true});
  const coverage=[],errors=[];
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/fixture'){res.setHeader('Content-Type','text/html');res.end(html());return;}
    const file=path.resolve(ROOT,'.'+pathname);if(!file.startsWith(ROOT+path.sep)){res.writeHead(403).end();return;}
    try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;let browser;
  try{
    browser=await chromium.launch({channel:'chrome',headless:true});
    for(const mode of ['chrome','firefox']){
      const context=await browser.newContext({viewport:{width:600,height:760}});
      try{
        await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
        const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
        await page.coverage.startJSCoverage({resetOnNavigation:false});await page.goto(origin+'/fixture');
        await page.evaluate(browserMode=>FCM.BROWSER=browserMode,mode);
        const row=page.locator('.fcm-msg[data-msg-id="twitch-id"]');
        await row.hover();const pin=row.locator('.fcm-modbar-pin');assert.equal(await pin.count(),1);
        const bounds=await pin.boundingBox(),root=await page.locator('.fcm-root').boundingBox();
        assert.ok(bounds.x>=root.x&&bounds.x+bounds.width<=root.x+root.width,'pin shortcut fits a 320px panel');
        await page.screenshot({path:path.join(output,`${mode}-shortcut.png`)});
        await pin.click();assert.equal(await page.evaluate(()=>actions.at(-1)[1]),'pin');
        assert.equal(await page.evaluate(()=>actions.at(-1)[2].seconds),300);
        const author=row.locator('.fcm-author'),menu=page.locator('.fcm-um');await author.click({button:'right'});
        assert.equal(await menu.locator('.fcm-um-action').filter({hasText:/^Pin this message/}).count(),2);
        await page.screenshot({path:path.join(output,`${mode}-menu.png`)});
        await menu.locator('.fcm-um-action').filter({hasText:/^Pin this message until/}).click();
        assert.equal(await page.evaluate(()=>actions.at(-1)[2].seconds),undefined);
        await author.click({button:'right'});await menu.locator('.fcm-um-action').filter({hasText:/^Unpin this message/}).click();
        assert.equal(await page.evaluate(()=>actions.at(-1)[1]),'unpin');
        assert.equal(await page.evaluate(()=>actions.at(-1)[2].messageId),'twitch-id');
        for(const platform of ['kick','youtube']){
          await page.evaluate(()=>compose.closeAll());
          await page.locator(`.fcm-msg[data-msg-id="${platform}-id"] .fcm-author`).click({button:'right'});
          assert.equal(await menu.locator('.fcm-um-action').filter({hasText:/^(Pin this message|Unpin this message)/}).count(),0);
        }
        await page.evaluate(()=>compose.closeAll());
        await page.locator('.fcm-author[data-name="NoId"]').click({button:'right'});
        const unavailable=menu.locator('.fcm-um-action').filter({hasText:/^(Pin this message|Unpin this message)/});
        assert.equal(await unavailable.count(),3);for(const button of await unavailable.all())assert.equal(await button.isDisabled(),true);
        await page.evaluate(()=>{moderator=false;compose.closeAll();});await author.click({button:'right'});
        assert.equal(await menu.locator('.fcm-um-action').filter({hasText:/^(Pin this message|Unpin this message)/}).count(),0);
        coverage.push(...await page.coverage.stopJSCoverage());
      }finally{await context.close();}
    }
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'browser-coverage.json'),JSON.stringify(coverage));
    console.log('Twitch pin controls passed in isolated Chrome and simulated Firefox at 320px; remote traffic blocked.');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
module.exports={run};if(require.main===module)run(path.resolve(process.argv[2])).catch(error=>{console.error(error);process.exitCode=1;});
