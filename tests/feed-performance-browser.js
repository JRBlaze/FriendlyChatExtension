// Local raster fixtures only. Uses an existing Playwright installation:
// FCM_PLAYWRIGHT_PATH=<path> node tests/feed-performance-browser.js <artifacts>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium, firefox } = require(process.env.FCM_PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || 'dist/chat-performance/browser');
const sources = ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/youtube.js',
  'src/shared/youtube-links.js', 'src/shared/util.js', 'src/shared/irc.js',
  'src/shared/emote-parsers.js', 'src/shared/kick-events.js', 'src/shared/clips.js',
  'src/content/render.js'];

// Full raster frames with different aspect ratios and a local animation loop.
function gif(width = 56, height = 56) {
  const dimensions=Buffer.alloc(4);dimensions.writeUInt16LE(width,0);dimensions.writeUInt16LE(height,2);
  const frames=[Buffer.from('GIF89a'),dimensions,Buffer.from('800000ff000000ff00','hex'),
    Buffer.from('21ff0b4e45545343415045322e300301000000','hex')];
  for(const color of [0,1]) {
    const codes=[];
    for(let pixel=0;pixel<width*height;pixel++) {
      if(pixel%128===0)codes.push(256);
      codes.push(color);
    }
    codes.push(257);
    const bytes=[];let value=0,bits=0;
    for(const code of codes) {
      value|=code<<bits;bits+=9;
      while(bits>=8){bytes.push(value&255);value>>>=8;bits-=8;}
    }
    if(bits)bytes.push(value&255);
    frames.push(Buffer.from('21f904000a0000002c00000000','hex'),dimensions,Buffer.from([0,8]));
    for(let offset=0;offset<bytes.length;offset+=255) {
      const chunk=bytes.slice(offset,offset+255);frames.push(Buffer.from([chunk.length,...chunk]));
    }
    frames.push(Buffer.from([0]));
  }
  frames.push(Buffer.from([0x3b]));return Buffer.concat(frames);
}

function html(baseline, mode) {
  const scripts = [...sources.map(file=>baseline&&file==='src/content/render.js'
    ?'fixture/baseline-render.js':file),baseline?'fixture/baseline-feed.js':'src/content/feed.js'];
  const popupImages=Object.fromEntries([[56,56],[112,56],[56,112]].map(([w,h])=>[
    w+':'+h,'data:image/gif;base64,'+gif(w,h).toString('base64')
  ]));
  return `<!doctype html><meta charset="utf-8"><title>Local chat stress fixture</title>
    <style>body{margin:0;background:#202124;font:14px Arial;color:white}
    #fixture-host{display:block;width:420px;height:550px;margin:30px}
    #fixture-popout{margin:12px}</style>
    <button id="fixture-popout">Pop out fixture</button><div id="fixture-host"></div>
    <script>self.FCM={BROWSER:${JSON.stringify(mode)}};</script>
    ${scripts.map(file => `<script src="/${file}"></script>`).join('\n')}
    <script>
      const host = document.querySelector('#fixture-host');
      const shadow = host.attachShadow({mode:'open'});
      shadow.innerHTML = '<link rel="stylesheet" href="/src/content/overlay.css">'
        + '<style>.fcm-root{position:relative;width:420px;height:550px;display:flex;flex-direction:column}'
        + '.fcm-feed{height:480px;flex:none}.fixture-heading{padding:10px}</style>'
        + '<div class="fcm-root" data-theme="dark" data-animate="false" data-badges="true">'
        + '<div class="fixture-heading">Synthetic local chat</div><div class="fcm-feed"></div></div>';
      const feedEl = shadow.querySelector('.fcm-feed');
      const settings = {...FCM.DEFAULT_SETTINGS,animations:false,maxMessages:400};
      FCM.setViewSettings(settings);
      for (const platform of ['twitch','kick']) FCM.setEmotes(platform,'thirdparty',{
        LocalDance:{url:location.origin+'/fixture/animated.gif',source:'Local fixture'},
        LocalWide:{url:location.origin+'/fixture/animated.gif?width=112&height=56',source:'Local fixture'},
        LocalTall:{url:location.origin+'/fixture/animated.gif?width=56&height=112',source:'Local fixture'}
      });
      const feed = FCM.createFeed(feedEl,()=>settings);
      let serial=0;
      window.fixture={host,shadow,feedEl,feed,settings,popup:null,
        async populate(total,cap){
          feed.clear(); settings.maxMessages=cap;
          const start=performance.now();
          for(let offset=0;offset<total;offset+=200){
            for(let i=offset;i<Math.min(total,offset+200);i++) feed.addMessage({
              platform:i%2?'kick':'twitch',author:'fixtureuser'+i%5,messageId:'fixture-'+serial++,
              text:Array.from({length:20},(_,n)=>['LocalDance','LocalWide','LocalTall'][n%3]).join(' '),timestamp:Date.now()
            },new Set(['twitch','kick']));
            await new Promise(resolve=>requestAnimationFrame(resolve));
          }
          feed.scrollToBottom();
          return performance.now()-start;
        },
        snapshot(){
          const images=[...feedEl.querySelectorAll('img')];
          const rows=[...feedEl.children];
          const rect=feedEl.getBoundingClientRect();
          const visible=rows.filter(row=>{const r=row.getBoundingClientRect();return r.bottom>rect.top&&r.top<rect.bottom});
          return {rows:rows.length,messages:feed.count,totalImages:images.length,
            activeImages:images.filter(img=>img.hasAttribute('src')).length,
            loadedImages:images.filter(img=>img.hasAttribute('src')&&img.complete&&img.naturalWidth>0).length,
            visibleImages:visible.reduce((n,row)=>n+row.querySelectorAll('img').length,0),
            visibleActiveImages:visible.reduce((n,row)=>n+row.querySelectorAll('img[src]').length,0),
            visibleLoadedImages:visible.reduce((n,row)=>n+[...row.querySelectorAll('img')]
              .filter(img=>img.hasAttribute('src')&&img.complete&&img.naturalWidth>0).length,0),
            scrollHeight:feedEl.scrollHeight,scrollTop:feedEl.scrollTop,clientHeight:feedEl.clientHeight,
            firstHeight:rows[0]?.getBoundingClientRect().height||0,
            lastHeight:rows.at(-1)?.getBoundingClientRect().height||0,
            heapBytes:performance.memory?.usedJSHeapSize||null};
        }
      };
      document.querySelector('#fixture-popout').onclick=()=>{
        const images=${JSON.stringify(popupImages)};
        // Raster data URLs keep about:blank popup assertions independent from
        // Chromium's localhost request handling in an adopted document.
        for(const image of feedEl.querySelectorAll('img')) {
          const source=image.getAttribute('data-fcm-src')||image.getAttribute('src');
          if(!source)continue;
          const url=new URL(source,location.href),w=Number(url.searchParams.get('width'))||56,
            h=Number(url.searchParams.get('height'))||56,data=images[w+':'+h];
          if(image.hasAttribute('src'))image.setAttribute('src',data);
          image.setAttribute('data-fcm-src',data);
        }
        const popup=window.open('','_blank','popup,width=500,height=650');
        fixture.popup=popup;
        popup.document.body.style.cssText='margin:0;background:#202124';
        popup.document.body.appendChild(host);
        feed.resettle();feed.scrollToBottom();
      };
    </script>`;
}

async function settled(page, { current = false } = {}) {
  await page.waitForFunction(() => fixture.snapshot().rows > 0);
  if (current) {
    try {
      await page.waitForFunction(() => {
        const s=fixture.snapshot();return s.activeImages>0&&s.activeImages<s.totalImages&&s.visibleImages>0
          &&s.visibleLoadedImages===s.visibleImages;
      });
    } catch(error) {
      console.error('Image restoration diagnostic: '+JSON.stringify(await page.evaluate(()=>({
        ...fixture.snapshot(),sourceHidden:document.hidden,ownerHidden:fixture.feedEl.ownerDocument.hidden,
        ownerUrl:fixture.feedEl.ownerDocument.URL,connected:fixture.feedEl.isConnected,
        lastImage:fixture.feedEl.lastElementChild?.querySelector('img')?.outerHTML
      }))));
      throw error;
    }
  }
  await page.waitForTimeout(850);
}

async function measure(page, total, cap, current) {
  const renderMs = await page.evaluate(({ total, cap }) => fixture.populate(total,cap), { total, cap });
  await settled(page, { current });
  const value = await page.evaluate(() => fixture.snapshot());
  assert.equal(value.messages,total,'Every message is counted, including the long-session soak');
  assert.equal(value.rows,Math.min(total,cap),'The configured row cap remains exact');
  assert.equal(value.totalImages,value.rows*20,'The actual renderer preserves every emote');
  assert.ok(value.loadedImages>0,'Local raster emotes decode successfully');
  if (current) {
    assert.ok(value.activeImages<value.totalImages/2,'Offscreen emotes have no active image source');
    assert.equal(value.visibleActiveImages,value.visibleImages,'Visible rows keep their emotes');
    assert.equal(value.visibleLoadedImages,value.visibleImages,'Every visible emote decodes successfully');
    assert.ok(value.scrollHeight-value.scrollTop-value.clientHeight<=3,'The newest message is fully in view');
  } else assert.equal(value.activeImages,value.totalImages,'The HEAD baseline keeps all retained image sources');
  return { total,cap,renderMs,...value };
}

async function profileMeasure(page, context, total, cap, current, label) {
  const cdp=await context.newCDPSession(page);
  await cdp.send('Performance.enable');await cdp.send('Profiler.enable');
  const before=(await cdp.send('Performance.getMetrics')).metrics;
  await cdp.send('Profiler.start');
  const value=await measure(page,total,cap,current);
  const {profile}=await cdp.send('Profiler.stop');
  const after=(await cdp.send('Performance.getMetrics')).metrics;
  const start=Object.fromEntries(before.map(item=>[item.name,item.value]));
  const metrics=Object.fromEntries(after.filter(item=>/Count|Duration/.test(item.name)).map(item=>[
    item.name,item.value-(start[item.name]||0)
  ]));
  const nodes=new Map(profile.nodes.map(node=>[node.id,node])),samples=new Map();
  for(let i=0;i<profile.samples.length;i++) {
    const node=nodes.get(profile.samples[i]),key=(node.callFrame.functionName||'(anonymous)')
      +' '+node.callFrame.url.split('/').slice(-2).join('/')+':'+(node.callFrame.lineNumber+1);
    samples.set(key,(samples.get(key)||0)+(profile.timeDeltas[i]||0)/1000);
  }
  const report={...value,metrics,topSamples:[...samples].sort((a,b)=>b[1]-a[1]).slice(0,25)};
  fs.writeFileSync(path.join(output,label+'-profile.json'),JSON.stringify({report,profile},null,2));
  console.log(label+' profile: '+JSON.stringify(report));
  await cdp.detach();return value;
}

async function regressions(page, context, label) {
  await page.evaluate(() => {
    const el=fixture.feedEl;el.dispatchEvent(new WheelEvent('wheel',{deltaY:-3000}));
    el.scrollTop=0;el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(() => fixture.feedEl.firstElementChild.querySelectorAll('img[src]').length===20);
  await page.waitForFunction(()=>{const s=fixture.snapshot();return s.visibleImages>0&&s.visibleLoadedImages===s.visibleImages;});
  const reading=await page.evaluate(() => fixture.snapshot());
  assert.equal(reading.visibleImages,reading.visibleActiveImages,'Scrolling restores older visible emotes');
  assert.equal(reading.visibleImages,reading.visibleLoadedImages,'Every older visible emote decodes after scrolling');
  assert.ok(reading.activeImages<reading.totalImages/2);
  await page.screenshot({path:path.join(output,label+'-reading.png')});

  await page.evaluate(() => fixture.feed.applyFilter(new Set(['twitch'])));
  await page.waitForFunction(() => fixture.feedEl.querySelectorAll('.fcm-hide img[src]').length===0);
  assert.equal(await page.evaluate(() => fixture.feedEl.querySelectorAll('.fcm-msg.fcm-hide').length),200);
  await page.evaluate(() => {fixture.feed.applyFilter(new Set(['twitch','kick']));fixture.feed.scrollToBottom();});
  await settled(page,{current:true});
  const before=await page.evaluate(() => fixture.snapshot());
  await page.evaluate(() => {fixture.feedEl.style.display='none';});
  await page.waitForFunction(() => fixture.snapshot().activeImages===0);
  await page.evaluate(() => {fixture.feedEl.style.display='';fixture.feed.resettle();fixture.feed.scrollToBottom();});
  await settled(page,{current:true});
  const restored=await page.evaluate(() => fixture.snapshot());
  assert.equal(restored.lastHeight,before.lastHeight,'Restoring suspended media preserves row geometry');

  const [popup]=await Promise.all([page.waitForEvent('popup'),page.locator('#fixture-popout').click()]);
  await popup.locator('.fcm-feed').waitFor();
  const imageUrl=await page.evaluate(()=>fixture.feedEl.querySelector('img').getAttribute('data-fcm-src'));
  const assetProbe=await popup.evaluate(async url=>{
    const image=document.createElement('img');image.src=url;document.body.appendChild(image);
    const result=await Promise.race([image.decode().then(()=>({loaded:true,width:image.naturalWidth})).catch(error=>({error:error.message})),
      new Promise(resolve=>setTimeout(()=>resolve({loaded:false,currentSrc:image.currentSrc.slice(0,60),complete:image.complete}),3000))]);
    image.remove();return result;
  },imageUrl);
  console.log(label+' pop-out raster asset probe: '+JSON.stringify(assetProbe));
  assert.equal(assetProbe.loaded,true,'The adopted popup document decodes a real local raster asset');
  await settled(page,{current:true});
  assert.equal(await page.evaluate(() => fixture.feedEl.ownerDocument===fixture.popup.document),true,
    'The same feed is adopted into a real pop-out window');
  await popup.screenshot({path:path.join(output,label+'-popout.png')});
  await page.evaluate(() => {
    document.body.appendChild(fixture.host);fixture.feed.resettle();fixture.feed.scrollToBottom();
  });
  await popup.close();
  await settled(page,{current:true});

  const background=await context.newPage();
  await background.goto('about:blank');
  await background.bringToFront();
  const hidden=await page.evaluate(() => document.hidden);
  if(hidden) await page.waitForFunction(() => fixture.snapshot().activeImages===0);
  await page.bringToFront();
  await settled(page,{current:true});
  await background.close();
  await page.evaluate(() => {fixture.feed.clear();fixture.feed.destroy();});
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => fixture.snapshot().rows),0,'Clear/destroy cannot revive a queued or observed row');
  return {reading,restored,nativeHiddenDocumentCheck:hidden};
}

async function geometry(page) {
  await page.evaluate(()=>{
    fixture.feed.clear();
    for(const [id,text,kind] of [['wide','LocalWide',''],['tall','LocalTall',''],
      ['gigantified','LocalTall','fcm-emote-gigantified'],['gif','LocalWide','fcm-gif-img']]) {
      const row=FCM.buildMessageEl({platform:'twitch',author:'geometry',text,messageId:id},new Set(['twitch']));
      row.dataset.fixture=id;
      if(kind)row.querySelector('img').className=kind==='fcm-gif-img'?kind:'fcm-emote '+kind;
      fixture.feed.addRow(row);
    }
    fixture.feed.scrollToBottom();
  });
  await page.waitForFunction(()=>[...fixture.feedEl.querySelectorAll('img')].every(img=>img.naturalWidth>0));
  await page.waitForTimeout(850);
  const read=()=>page.evaluate(()=>Object.fromEntries([...fixture.feedEl.querySelectorAll('[data-fixture]')].map(row=>{
    const r=row.querySelector('img').getBoundingClientRect();return [row.dataset.fixture,{width:r.width,height:r.height}];
  })));
  const before=await read();
  assert.ok(before.wide.width>before.wide.height,'Wide raster emotes retain their aspect ratio');
  assert.ok(before.tall.height>before.tall.width,'Tall raster emotes retain their aspect ratio');
  assert.equal(before.gigantified.height,112,'Gigantify retains its production CSS height');
  for(let i=0;i<200;i++)await page.evaluate(i=>fixture.feed.addSys('Local filler '+i),i);
  await page.evaluate(()=>fixture.feed.scrollToBottom());
  await page.waitForFunction(()=>fixture.feedEl.querySelectorAll('[data-fixture] img[src]').length===0);
  await page.evaluate(()=>{
    const el=fixture.feedEl;el.dispatchEvent(new WheelEvent('wheel',{deltaY:-3000}));
    el.scrollTop=0;el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(()=>fixture.feedEl.querySelectorAll('[data-fixture] img[src]').length===4);
  await page.waitForTimeout(850);
  assert.deepEqual(await read(),before,'Suspending and restoring wide, tall, GIF and Gigantify media preserves geometry');
  return before;
}

async function overlayPopouts(context, origin, mode, coverage) {
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  if(mode.browserName==='chromium')await page.coverage.startJSCoverage({resetOnNavigation:false,reportAnonymousScripts:true});
  await page.goto(origin+'/tests/harness.html?browser='+mode.mode);
  await page.locator('.fcm-msg').first().waitFor();
  await page.evaluate(({origin,raster})=>{
    overlay.applyStoredSettings({...FCM.view.settings,autoClaimBonus:false,watchWhenLive:false,animations:false,maxMessages:400});
    overlay.setEmotes('twitch','thirdparty',{LocalDance:{url:raster,source:'Local fixture'}});
    overlay.batch(Array.from({length:450},(_,i)=>({platform:'twitch',author:'idlepopout',messageId:'idle-'+i,
      text:Array(20).fill('LocalDance').join(' '),timestamp:Date.now()})));
  },{origin,raster:'data:image/gif;base64,'+gif().toString('base64')});
  const ready=surface=>surface.waitForFunction(()=>{
    const feed=document.querySelector('#friendly-chat-merge-host')?.shadowRoot.querySelector('.fcm-feed');
    if(!feed)return false;
    const rect=feed.getBoundingClientRect(),images=[...feed.children].filter(row=>{
      const r=row.getBoundingClientRect();return r.bottom>rect.top&&r.top<rect.bottom;
    }).flatMap(row=>[...row.querySelectorAll('img')]);
    return images.length>0&&images.every(img=>img.hasAttribute('src')&&img.complete&&img.naturalWidth>0);
  });
  await ready(page);
  const count=await page.locator('.fcm-msg').count();
  const [popup]=await Promise.all([page.waitForEvent('popup'),page.locator('.fcm-actions [data-act="popout"]').click()]);
  await popup.locator('.fcm-feed').waitFor();await ready(popup);
  assert.equal(await popup.locator('.fcm-msg').count(),count,'Actual overlay pop-out moves the retained rows');
  await popup.screenshot({path:path.join(output,mode.label+'-overlay-popout.png')});
  await popup.locator('.fcm-actions [data-act="popout"]').click();
  await ready(page);
  assert.equal(await page.locator('.fcm-msg').count(),count,'Actual overlay pop-in restores an idle feed without another message');
  const [closedPopup]=await Promise.all([page.waitForEvent('popup'),page.locator('.fcm-actions [data-act="popout"]').click()]);
  await ready(closedPopup);await closedPopup.close();await ready(page);
  assert.deepEqual(errors,[],'Actual overlay migration has no page errors');
  await page.evaluate(()=>overlay.destroy());
  if(mode.browserName==='chromium')coverage.push(...(await page.coverage.stopJSCoverage()).map(entry=>({
    functions:entry.functions,source:entry.source,url:entry.url
  })));
  await page.close();return {retainedRows:count,popOut:true,popIn:true,closedWindowReturn:true};
}

async function run() {
  fs.mkdirSync(output,{recursive:true});
  const baseline=execFileSync('git',['show','HEAD:src/content/feed.js'],{cwd:ROOT,encoding:'utf8'});
  const baselineRender=execFileSync('git',['show','HEAD:src/content/render.js'],{cwd:ROOT,encoding:'utf8'});
  const profileSource=process.env.FCM_PERF_FEED_SOURCE
    ?fs.readFileSync(path.resolve(ROOT,process.env.FCM_PERF_FEED_SOURCE),'utf8'):null;
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/fixture.html') {
      res.setHeader('Content-Type','text/html');
      res.end(html(url.searchParams.get('source')==='baseline',url.searchParams.get('mode')||'chrome'));return;
    }
    if(url.pathname==='/fixture/animated.gif') {
      const width=Math.max(1,Math.min(256,Number(url.searchParams.get('width'))||56));
      const height=Math.max(1,Math.min(256,Number(url.searchParams.get('height'))||56));
      res.setHeader('Content-Type','image/gif');res.end(gif(width,height));return;
    }
    if(url.pathname==='/fixture/baseline-feed.js') {
      res.setHeader('Content-Type','text/javascript');res.end(baseline);return;
    }
    if(url.pathname==='/fixture/baseline-render.js') {
      res.setHeader('Content-Type','text/javascript');res.end(baselineRender);return;
    }
    if(url.pathname==='/src/content/feed.js'&&profileSource) {
      res.setHeader('Content-Type','text/javascript');res.end(profileSource);return;
    }
    const file=path.resolve(ROOT,'.'+url.pathname);
    if(!file.startsWith(ROOT+path.sep)){res.writeHead(403).end();return;}
    try{res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));}
    catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port,coverage=[],results=[];
  let chromeBrowser,nativeFirefox;
  try {
    chromeBrowser=await chromium.launch({channel:'chrome',headless:true});
    let firefoxReason='No existing compatible Firefox installation';
    const firefoxPath=fs.existsSync(firefox.executablePath())?firefox.executablePath()
      :(process.platform==='win32'&&fs.existsSync('C:/Program Files/Mozilla Firefox/firefox.exe')
        ?'C:/Program Files/Mozilla Firefox/firefox.exe':null);
    if(firefoxPath) {
      try{nativeFirefox=await firefox.launch({executablePath:firefoxPath,headless:true,timeout:12000});}
      catch(error){firefoxReason=error.message.split('\n')[0];}
    }
    const modes=[{browser:chromeBrowser,browserName:'chromium',mode:'chrome',label:'chrome',actual:true},
      {browser:nativeFirefox||chromeBrowser,mode:'firefox',
        browserName:nativeFirefox?'firefox':'chromium',label:nativeFirefox?'firefox':'firefox-simulated',actual:!!nativeFirefox}];
    if(process.env.FCM_PERF_PROFILE==='1')modes.splice(1);
    if(!nativeFirefox) console.log('Native Firefox unavailable: '+firefoxReason+'; Firefox mode runs in Chrome.');
    for(const mode of modes) {
      const context=await mode.browser.newContext({viewport:{width:1280,height:800}});
      const external=[];
      await context.route('**/*',route=>{
        const url=route.request().url();
        if(new URL(url).origin===origin)return route.continue();
        if(route.request().resourceType()==='image')return route.fulfill({contentType:'image/gif',body:gif()});
        external.push(url);return route.abort();
      });
      const entries={browser:mode.label,actualBrowser:mode.actual,baseline:[],current:[]};
      try {
        for(const current of [false,true]) {
          const page=await context.newPage(),errors=[];
          page.on('pageerror',error=>errors.push(error.message));
          const collects=mode.browser===chromeBrowser;
          if(collects)await page.coverage.startJSCoverage({resetOnNavigation:false,reportAnonymousScripts:true});
          await page.goto(origin+'/fixture.html?source='+(current?'current':'baseline')+'&mode='+mode.mode);
          await page.waitForFunction(()=>window.fixture&&fixture.feedEl.clientHeight>0);
          const cases=process.env.FCM_PERF_QUICK==='1'?[[400,400]]:[[100,100],[400,400],[8000,400]];
          for(const [total,cap] of cases) {
            const value=process.env.FCM_PERF_PROFILE==='1'
              ?await profileMeasure(page,context,total,cap,current,mode.label+'-'+(current?'current':'baseline'))
              :await measure(page,total,cap,current);
            entries[current?'current':'baseline'].push(value);
            console.log(mode.label+' '+(current?'current':'HEAD')+' '+total+' messages: '
              +value.activeImages+'/'+value.totalImages+' active image sources; '+Math.round(value.renderMs)+' ms insertion');
          }
          await page.screenshot({path:path.join(output,mode.label+'-'+(current?'current':'baseline')+'.png')});
          if(current) {
            entries.geometry=await geometry(page);
            await measure(page,400,400,true);
            entries.regressions=await regressions(page,context,mode.label);
          }
          assert.deepEqual(errors,[],'Real-source rendering has no page errors');
          if(collects)coverage.push(...(await page.coverage.stopJSCoverage()).map(entry=>({
            functions:entry.functions,source:entry.source,url:entry.url
          })));
          await page.close();
        }
        entries.overlay=await overlayPopouts(context,origin,mode,coverage);
        assert.deepEqual(external,[],'The stress fixture never requests external resources');
        results.push(entries);
      } finally {await context.close();}
    }
    fs.writeFileSync(path.join(output,'metrics.json'),JSON.stringify({results,nativeFirefox:!!nativeFirefox,
      stressMediaTransport:'localhost HTTP raster fixtures',popupMediaTransport:'data URL raster fixtures'},null,2));
    fs.writeFileSync(path.join(output,'browser-coverage.json'),JSON.stringify(coverage));
    console.log('Local feed stress, image suspension, scroll, collapse, filter, and pop-out checks passed.');
  } finally {
    if(nativeFirefox)await nativeFirefox.close();
    if(chromeBrowser)await chromeBrowser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}

run().catch(error=>{console.error(error);process.exitCode=1;});
