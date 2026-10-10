// Actual overlay/CSS on synthetic Twitch/Kick pages. All remote traffic blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
const BEFORE = execFileSync('git', ['show', 'HEAD:src/content/overlay.css'], { cwd: ROOT, encoding: 'utf8' });
const CHANGED = ['.fcm-youtube-wrap','.fcm-youtube','.fcm-youtube summary','.fcm-youtube form','.fcm-youtube-wrap > .fcm-chip-btn','.fcm-header', '.fcm-brand', '.fcm-actions', '.fcm-icon-btn', '.fcm-chips', '.fcm-chip-btn',
  '.fcm-native', '.fcm-native-chip', '.fcm-composer', '.fcm-composer-row', '.fcm-recent-emotes', '.fcm-targets',
  '.fcm-target', '.fcm-gif-btn', '.fcm-input', '.fcm-send', '.fcm-statusbar', '.fcm-platform-section',
  '.fcm-send-section > .fcm-section-toggle', '.fcm-send-section .fcm-targets',
  '.fcm-platform-section[open] > .fcm-section-toggle', '.fcm-platform-section[open] .fcm-chips',
  '.fcm-platform-section[open]:has(.fcm-platform-notice:not([hidden])) > .fcm-section-toggle',
  '.fcm-platform-section .fcm-prompt', '.fcm-platform-section > div:not(.fcm-chips)', '.fcm-send-section',
  '.fcm-send-section[open] > .fcm-section-toggle', '.fcm-send-section[open] .fcm-targets',
  '.fcm-send-section[open] .fcm-target-summary'];
const INJECTION = `
  mem.local.fcm_settings_v1={...FCM.DEFAULT_SETTINGS,autoClaimBonus:false,watchWhenLive:false,animations:false};
  chrome.runtime.sendMessage=async msg=>msg.cmd==='youtubeLinkGet'?{ok:true,link:null,counterpart:null}:null;
  FCM.createYouTubeSuggestions=hooks=>{window.suggestionHooks=hooks;return {pause(){},refresh(){},updateCounterpart(){},destroy(){}};};
  FCM.createYouTubeSource=()=>({async start(){return true;},stop(){},destroy(){},getSendState(){return {available:false};},openAccessSetup(){return false;},closeAccessSetup(){}});
`;
async function applyStyle(page, text) {
  await page.evaluate(css => {
    const shadow = document.getElementById('friendly-chat-merge-host').shadowRoot;
    shadow.querySelector('style').textContent = css;
  }, text);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function metrics(page) {
  return page.evaluate(() => {
    const shadow = document.getElementById('friendly-chat-merge-host').shadowRoot;
    const rect = selector => { const r = shadow.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; };
    return { chatLineHeight:parseFloat(getComputedStyle(shadow.querySelector('.fcm-msg')).lineHeight), panel:rect('.fcm-panel'), header:rect('.fcm-header'), platforms:rect('.fcm-platform-section'),
      feed:rect('.fcm-feed'), composer:rect('.fcm-composer'), status:rect('.fcm-statusbar'), input:rect('.fcm-input'),
      destinations:[...shadow.querySelectorAll('.fcm-target')].map(node=>({...node.dataset})),
      overflow:[...shadow.querySelectorAll('.fcm-header button,.fcm-chip-btn,.fcm-target,.fcm-send,.fcm-input')]
        .filter(node=>node.getClientRects().length).map(node=>{const r=node.getBoundingClientRect();return {right:r.right,x:r.x};}) };
  });
}
async function run(output) {
  fs.mkdirSync(output,{recursive:true});const results=[],used=new Set(),errors=[];
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname,file=path.resolve(ROOT,'.'+pathname);
    if(!file.startsWith(ROOT+path.sep)){res.writeHead(403).end();return;}
    try{let body=fs.readFileSync(file);if(pathname==='/tests/harness.html')body=body.toString().replace('  let overlay = FCM.createOverlay({',INJECTION+'\n  let overlay = FCM.createOverlay({');
      res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);
    }catch{res.writeHead(404).end();}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;let browser;
  try{
    browser=await chromium.launch({channel:'chrome',headless:true});
    for(const mode of ['chrome','firefox']){
      const context=await browser.newContext({viewport:{width:1100,height:700}});
      try{
        await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
        const page=await context.newPage(),cdp=await context.newCDPSession(page),sheets=new Set();
        page.on('pageerror',error=>errors.push(error.message));cdp.on('CSS.styleSheetAdded',({header})=>sheets.add(header.styleSheetId));
        await cdp.send('DOM.enable');await cdp.send('CSS.enable');await cdp.send('CSS.startRuleUsageTracking');
        await page.goto(origin+'/tests/harness.html?browser='+mode);
        await page.addStyleTag({content:'.devbar{display:none!important}'});
        await page.waitForFunction(()=>document.getElementById('friendly-chat-merge-host')?.shadowRoot.querySelector('style')?.textContent.includes('Native disclosures'));
        for(const host of ['twitch','kick']){
          await page.evaluate(host=>switchSite(host),host);
          await page.waitForFunction(()=>document.getElementById('friendly-chat-merge-host')?.shadowRoot.querySelector('style')?.textContent.includes('Native disclosures'));
          await page.evaluate(()=>{
            const shadow=document.getElementById('friendly-chat-merge-host').shadowRoot;
            const size=document.createElement('style');size.id='fixture-size';shadow.appendChild(size);
            overlay.setStatus('twitch','connected','JRBlaze');overlay.setStatus('kick','connected','JRBlaze');overlay.setCounterpart(null);
            for(let i=0;i<22;i++)overlay.chat({platform:i%2?'kick':'twitch',author:i%2?'KickViewer':'TwitchViewer',text:['Hello everyone!','Both chats are easy to follow here.','That was a great round.','Ready for the next one?'][i%4],messageId:'sample-'+i,timestamp:Date.UTC(2026,9,9,20,48)});
          });
          for(const width of [340,280,240])for(const theme of ['dark','light'])for(const fontSize of [10,14,22]){
            await page.evaluate(({width,theme,fontSize})=>{
              const shadow=document.getElementById('friendly-chat-merge-host').shadowRoot;
              shadow.querySelector('#fixture-size').textContent='.fcm-panel{left:20px!important;top:20px!important;width:'+width+'px!important;height:600px!important}';
              overlay.applyStoredSettings({...FCM.DEFAULT_SETTINGS,autoClaimBonus:false,watchWhenLive:false,animations:false,theme,fontSize});
            },{width,theme,fontSize});
            await applyStyle(page,BEFORE);const before=await metrics(page);
            await applyStyle(page,CSS);const after=await metrics(page),gain=after.feed.height-before.feed.height;
            assert.deepEqual(after.destinations,before.destinations,'styling preserves destination states');
            assert.ok(gain>=12,`${host}/${mode}/${width}/${theme}/${fontSize}: gains ${gain}px of chat`);
            assert.ok(after.input.width>=60,'narrow composer still has usable input width');
            assert.ok(after.overflow.every(r=>r.x>=after.panel.x-.5&&r.right<=after.panel.right+.5),'controls stay inside panel');
            if(!results.length)await page.locator('.fcm-panel').screenshot({path:path.join(output,'first-layout.png')});
            assert.ok(after.feed.height>=200,'expanded controls retain useful chat space');
            results.push({host,mode,width,theme,fontSize,beforeFeed:before.feed.height,afterFeed:after.feed.height,gain});
            if(width===340&&theme==='dark'&&fontSize===14){
              await applyStyle(page,BEFORE);await page.locator('.fcm-panel').screenshot({path:path.join(output,`${mode}-${host}-before.png`)});
              await applyStyle(page,CSS);await page.locator('.fcm-panel').screenshot({path:path.join(output,`${mode}-${host}-after.png`)});
            }
          }
          await page.setViewportSize({width:800,height:600});
          await page.evaluate(()=>overlay.applyStoredSettings({...FCM.DEFAULT_SETTINGS,autoClaimBonus:false,watchWhenLive:false,animations:false,theme:'dark',fontSize:14}));
          await page.evaluate(()=>document.getElementById('friendly-chat-merge-host').shadowRoot.querySelector('#fixture-size').textContent='.fcm-panel{left:20px!important;top:20px!important;width:280px!important;height:480px!important}');
          await applyStyle(page,BEFORE);const shortBefore=await metrics(page);await applyStyle(page,CSS);const shortAfter=await metrics(page);
          assert.ok(shortAfter.feed.height>shortBefore.feed.height+12&&shortAfter.feed.height>=3*shortAfter.chatLineHeight,'short laptop-height panel keeps more usable chat at the default font size');
          assert.ok(shortAfter.status.bottom<=600,'footer fits inside the short viewport');
          results.push({host,mode,width:280,viewport:'800x600',panelHeight:480,beforeFeed:shortBefore.feed.height,afterFeed:shortAfter.feed.height,gain:shortAfter.feed.height-shortBefore.feed.height});
          await page.locator('.fcm-panel').screenshot({path:path.join(output,`${mode}-${host}-short-laptop.png`)});
          await page.evaluate(()=>overlay.applyStoredSettings({...FCM.DEFAULT_SETTINGS,autoClaimBonus:false,watchWhenLive:false,animations:false,fontSize:22,platformsCollapsed:true,sendToCollapsed:true}));
          const largeShort=await metrics(page);assert.ok(largeShort.feed.height>=180,'collapsed controls leave chat readable at large text sizes in a short panel');
          assert.equal(await page.locator('.fcm-target-summary').isVisible(),true,'large-text compact routing remains visible');
          await page.evaluate(()=>overlay.applyStoredSettings({...FCM.DEFAULT_SETTINGS,autoClaimBonus:false,watchWhenLive:false,animations:false,fontSize:22}));
          await page.setViewportSize({width:1100,height:700});
          await page.evaluate(()=>document.getElementById('friendly-chat-merge-host').shadowRoot.querySelector('#fixture-size').textContent='.fcm-panel{left:20px!important;top:20px!important;width:240px!important;height:600px!important}');
          await page.evaluate(()=>{
            overlay.setStatus('twitch','connected','ThirtyCharacterChannelNameHereXX');
            overlay.setStatus('kick','connected','AReallyLongKickChannelNameHereXX');
            overlay.setCounterpart({exists:true,live:true,channel:'found',displayName:'Synthetic'});
            suggestionHooks.onSuggestions([{match:'page-link',label:'Synthetic YouTube',channelUrl:'https://www.youtube.com/@Synthetic'}]);
          });
          const longNames=await metrics(page);assert.ok(longNames.overflow.every(r=>r.x>=longNames.panel.x-.5&&r.right<=longNames.panel.right+.5),'full channel names wrap within a 240px panel');
          assert.equal(await page.locator('.fcm-chip-btn > span:not(.fcm-live-dot):not(.fcm-live-pip)').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth+1)),true,'channel text is not horizontally clipped');
          await page.evaluate(async()=>{
            const names=Array.from({length:8},(_,index)=>'Recent'+index);
            overlay.setEmotes('twitch','thirdparty',Object.fromEntries(names.map(name=>[name,{url:location.origin+'/icons/icon-48.png',source:'Fixture'}])));
            await chrome.storage.local.set({'fcm_recent_emotes_v1:twitch':names,'fcm_recent_emotes_v1:order':names.map(name=>'twitch:'+name)});
          });
          await page.waitForFunction(()=>document.getElementById('friendly-chat-merge-host').shadowRoot.querySelectorAll('.fcm-recent-emote').length>0);
          const recent=await page.locator('.fcm-recent-emote').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {y:r.y,right:r.right};}));
          assert.ok(recent.length<=8&&recent.every(r=>r.y===recent[0].y&&r.right<=longNames.panel.right),'recent emotes retain one responsive row');
          await page.evaluate(()=>overlay.setAccounts({twitch:{connected:true,login:'FixtureViewer'},kick:{connected:true,login:'FixtureViewer'}}));
          await page.locator('.fcm-msg[data-platform="twitch"] .fcm-author').first().click();
          await page.getByRole('button',{name:/^Reply on Twitch/}).click();
          assert.equal(await page.locator('.fcm-reply').isVisible(),true,'compact footer retains reply context');
          await page.locator('.fcm-send-section > summary').click();assert.match(await page.locator('.fcm-target-summary').innerText(),/Twitch/);
          await page.locator('.fcm-send-section > summary').click();await page.locator('.fcm-reply-clear').click();
          await page.evaluate(()=>overlay.setStatus(harnessHost.platform==='twitch'?'kick':'twitch','idle',''));
          const youtube=page.locator('.fcm-youtube');await youtube.locator(':scope > summary').click();
          assert.equal(await page.getByRole('textbox',{name:'YouTube live video or channel URL'}).isVisible(),true);
          const urlBox=await page.getByRole('textbox',{name:'YouTube live video or channel URL'}).boundingBox();assert.ok(urlBox.x>=longNames.panel.x&&urlBox.x+urlBox.width<=longNames.panel.right,'expanded YouTube URL input fits the narrow panel');
          await youtube.locator(':scope > summary').click();
          const platforms=page.locator('.fcm-platform-section'),sending=page.locator('.fcm-send-section');
          assert.equal(await page.locator('.fcm-platform-notice').isVisible(),true,'expanded discovery notice remains visible');
          await platforms.locator(':scope > summary').click();assert.match(await platforms.innerText(),/YouTube.*found/);
          await platforms.locator(':scope > summary').focus();await page.keyboard.press('Enter');
          assert.equal(await platforms.evaluate(node=>node.open),true);assert.equal(await page.locator('.fcm-prompt').isVisible(),true);
          await sending.locator(':scope > summary').click();assert.equal(await page.locator('.fcm-target-summary').isVisible(),true);
          await sending.locator(':scope > summary').focus();await page.keyboard.press('Space');
          assert.equal(await sending.evaluate(node=>node.open),true);assert.equal(await page.locator('.fcm-target-summary').isVisible(),false);
          await page.locator('.fcm-input').fill('A local draft');assert.equal(await page.locator('.fcm-input').innerText(),'A local draft');
          const long=await metrics(page);assert.ok(long.overflow.every(r=>r.x>=long.panel.x-.5&&r.right<=long.panel.right+.5),'long names wrap inside a narrow panel');
          await page.locator('.fcm-panel').screenshot({path:path.join(output,`${mode}-${host}-narrow-notices.png`)});
        }
        const {ruleUsage}=await cdp.send('CSS.stopRuleUsageTracking');const texts=new Map();
        for(const id of sheets){try{texts.set(id,(await cdp.send('CSS.getStyleSheetText',{styleSheetId:id})).text);}catch{}}
        for(const rule of ruleUsage){const text=texts.get(rule.styleSheetId);if(!rule.used||!text||text.replace(/\r\n/g,'\n')!==CSS.replace(/\r\n/g,'\n'))continue;
          const selector=text.slice(rule.startOffset,rule.endOffset).split('{')[0].trim();if(CHANGED.includes(selector))used.add(selector);}
      }finally{await context.close();}
    }
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
    fs.writeFileSync(path.join(output,'css-coverage.json'),JSON.stringify({selectors:CHANGED,used:[...used]},null,2));
    assert.deepEqual(errors,[]);assert.deepEqual(CHANGED.filter(selector=>!used.has(selector)),[],'every changed CSS rule is exercised');
    console.log(`Compact layout: ${results.length} cases pass; ${used.size}/${CHANGED.length} changed CSS rules exercised. Chat gains ${Math.min(...results.map(r=>r.gain))}–${Math.max(...results.map(r=>r.gain))}px.`);
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
module.exports={run};if(require.main===module)run(path.resolve(process.argv[2])).catch(error=>{console.error(error);process.exitCode=1;});
