const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
function audioFixture() {
  const state = window.__audio = { contexts: [], nodes: [], claims: 0, now: 10000, last: -Infinity };
  window.AudioContext = class {
    constructor() { this.state='suspended';this.currentTime=0;this.destination={};state.contexts.push(this); }
    async resume(){this.state='running';} async close(){this.state='closed';}
    createOscillator(){const node={frequency:{setValueAtTime(){}},connect(){},disconnect(){},start(){state.nodes.push(this);},stop(){queueMicrotask(()=>this.onended?.());}};return node;}
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
  };
}
function fixtureHtml() {
  const scripts=['namespace','constants','youtube','youtube-links','util','mention-sound','irc','emote-parsers','kick-events','clips'].map(name=>`<script src="/src/shared/${name}.js"></script>`).join('');
  return `<!doctype html><meta charset="utf-8"><button id="enable">Enable alerts</button><button id="preview">Preview</button><div id="feed"></div>${scripts}<script src="/src/content/render.js"></script><script src="/src/content/feed.js"></script><script>
    const settings={...FCM.DEFAULT_SETTINGS,highlightNames:'JRBlaze, keyword'};FCM.setViewSettings(settings);
    const filter=new Set(['twitch']),feed=FCM.createFeed(document.querySelector('#feed'),()=>settings);
    const sound=FCM.createMentionSound({getWindow:()=>window,getSettings:()=>settings,claim:async()=>{
      __audio.claims++;const play=__audio.now-__audio.last>=5000;if(play)__audio.last=__audio.now;return {play};
    }});feed.onMessage((msg,row)=>sound.notify(msg,row));
    document.querySelector('#enable').onclick=event=>{settings.mentionSound=!settings.mentionSound;sound.refresh();if(settings.mentionSound)sound.arm(event);};
    document.querySelector('#preview').onclick=event=>sound.preview(event);
    window.fixture={settings,feed,sound,filter,add:(text,id,extra={})=>feed.addMessage({platform:'twitch',author:'AnotherViewer',text,messageId:id,...extra},filter)};
    </script>`;
}
function wav(samples, rate) {
  const out=Buffer.alloc(44+samples.length*2);out.write('RIFF',0);out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);
  out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(rate,24);out.writeUInt32LE(rate*2,28);
  out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(samples.length*2,40);
  samples.forEach((sample,i)=>out.writeInt16LE(Math.round(Math.max(-1,Math.min(1,sample))*32767),44+i*2));return out;
}
async function run(output) {
  fs.mkdirSync(output,{recursive:true});
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');if(url.pathname==='/fixture'){res.setHeader('Content-Type','text/html');res.end(fixtureHtml());return;}
    const file=path.resolve(ROOT,'.'+url.pathname);if(!file.startsWith(ROOT+path.sep)){res.writeHead(403).end();return;}
    try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,coverage=[],results=[];let browser;
  try{
    browser=await chromium.launch({channel:'chrome',headless:true});
    for(const mode of ['chrome','firefox']){
      const context=await browser.newContext();const errors=[],blocked=[];
      try{
        await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort();});
        await context.addInitScript(audioFixture);const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
        await page.coverage.startJSCoverage({resetOnNavigation:false});await page.goto(origin+'/fixture');
        await page.evaluate(()=>fixture.add('@JRBlaze','off'));assert.equal(await page.evaluate(()=>__audio.nodes.length),0);
        await page.locator('#enable').click();await page.waitForFunction(()=>__audio.contexts[0]?.state==='running');
        assert.equal(await page.evaluate(()=>__audio.nodes.length),0,'enabling arms silently');
        await page.evaluate(()=>{
          fixture.add('@JRBlaze','history',{history:true});fixture.add('@JRBlaze','hidden',{platform:'kick'});
          fixture.add('@JRBlaze','self',{author:'JRBlaze'});fixture.add('ordinary','plain');fixture.add('@JRBlaze','live');fixture.add('@JRBlaze','live');
        });await page.waitForFunction(()=>__audio.nodes.length===2);
        assert.equal(await page.evaluate(()=>__audio.claims),1);
        await page.evaluate(()=>fixture.add('keyword','burst'));await page.waitForTimeout(50);
        assert.equal(await page.evaluate(()=>__audio.nodes.length),2,'burst does not overlap');
        await page.evaluate(()=>{__audio.now+=5000;fixture.add('keyword','later');});await page.waitForFunction(()=>__audio.nodes.length===4);
        await page.locator('#enable').click();await page.evaluate(()=>fixture.add('keyword','disabled'));await page.waitForTimeout(50);
        assert.equal(await page.evaluate(()=>__audio.nodes.length),4);
        await page.locator('#preview').click();await page.waitForFunction(()=>__audio.nodes.length===6);
        assert.equal(await page.evaluate(()=>fixture.settings.mentionSound),false,'preview never enables alerts');
        if(mode==='chrome'){
          const rendered=await page.evaluate(async()=>{const ctx=new OfflineAudioContext(1,16800,48000);FCM.scheduleMentionChime(ctx);const buffer=await ctx.startRendering();return Array.from(buffer.getChannelData(0));});
          const peak=Math.max(...rendered.map(Math.abs));assert.ok(peak>0&&peak<=.06);
          fs.writeFileSync(path.join(output,'soft-chime.wav'),wav(rendered,48000));
        }
        await page.goto(origin+'/tests/options-harness.html?browser='+mode);await page.waitForFunction(()=>window.__ready===true && document.querySelector('#mentionSound'));
        assert.equal(await page.locator('#mentionSound').isChecked(),false);
        await page.locator('#mention-sound-preview').click();await page.waitForFunction(()=>document.querySelector('#mention-sound-status').textContent==='Soft chime preview.');
        assert.equal(await page.locator('#mentionSound').isChecked(),false);
        await page.locator('#mentionSound').check();await page.waitForFunction(()=>__store.local.fcm_settings_v1?.mentionSound===true);
        assert.equal(await page.evaluate(()=>__store.sync.fcm_settings_v1.mentionSound),true);
        await page.locator('#mentionSound').uncheck();await page.waitForFunction(()=>__store.local.fcm_settings_v1?.mentionSound===false);
        await page.evaluate(()=>{document.querySelector('#mention-sound-preview').dispatchEvent(new MouseEvent('click',{bubbles:true}));});
        await page.evaluate(()=>{window.AudioContext=undefined;});
        await page.locator('#mention-sound-preview').click();
        await page.waitForFunction(()=>document.querySelector('#mention-sound-status').textContent.includes('could not play'));
        await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
        coverage.push(...await page.coverage.stopJSCoverage());assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
        const overlayContext=await browser.newContext();
        try {
          await overlayContext.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
          await overlayContext.addInitScript(audioFixture);const overlayPage=await overlayContext.newPage();
          await overlayPage.coverage.startJSCoverage({resetOnNavigation:false});
          await overlayPage.goto(origin+'/tests/harness.html?browser='+mode);
          await overlayPage.locator('[data-act="settings"]').click();
          assert.equal(await overlayPage.locator('[data-set="mentionSound"]').isChecked(),false);
          await overlayPage.locator('[data-set="mentionSound"]').check();
          await overlayPage.locator('[data-set="highlightNames"]').fill('JRBlaze, keyword');
          await overlayPage.locator('[data-set="maxMessages"]').fill('400');
          await overlayPage.locator('[data-set="opacity"]').focus();await overlayPage.keyboard.press('ArrowLeft');
          await overlayPage.locator('[data-set="theme"]').selectOption('dark');
          await overlayPage.locator('[data-act="preview-mention-sound"]').click();
          await overlayPage.waitForFunction(()=>document.getElementById('friendly-chat-merge-host').shadowRoot.querySelector('.fcm-toast').textContent==='Soft chime preview');
          await overlayPage.locator('[data-set="mentionSound"]').uncheck();
          await overlayPage.evaluate(()=>{window.AudioContext=undefined;});
          await overlayPage.locator('[data-act="preview-mention-sound"]').click();
          await overlayPage.waitForFunction(()=>document.getElementById('friendly-chat-merge-host').shadowRoot.querySelector('.fcm-toast').textContent.includes('could not play'));
          await overlayPage.evaluate(()=>document.getElementById('friendly-chat-merge-host').shadowRoot.querySelector('[data-act="preview-mention-sound"]').dispatchEvent(new MouseEvent('click',{bubbles:true})));
          await overlayPage.screenshot({path:path.join(output,mode+'-overlay-setting.png'),fullPage:true});
          await overlayPage.evaluate(()=>overlay.destroy());
          coverage.push(...await overlayPage.coverage.stopJSCoverage());
        } finally {await overlayContext.close();}
        results.push({mode,nativeBrowser:'Chrome',errors,blocked});
      }finally{await context.close();}
    }fs.writeFileSync(path.join(output,'browser-coverage.json'),JSON.stringify(coverage));fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
    console.log('Mention sound browser fixtures passed; quiet offline chime rendered; options toggle and preview verified.');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
module.exports={run};if(require.main===module)run(path.resolve(process.argv[2])).catch(error=>{console.error(error);process.exitCode=1;});
