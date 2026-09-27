const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

function anchor(href, { visible = true, chat = false } = {}) {
  return { chat, getAttribute: name => name === 'href' ? href : null,
    getClientRects: () => visible ? [{}] : [] };
}

function fixture(anchors, hasChat = true) {
  const scope = { contains: element => element.chat };
  const doc = { querySelectorAll(selector) {
    if (selector === 'a[href]') return anchors;
    return hasChat ? [scope] : [];
  } };
  const context = { FCM: {}, document: doc, window: {}, location: { hostname: 'www.twitch.tv', pathname: '/fixture' } };
  context.self = context;
  vm.createContext(context);
  const file = path.join(ROOT, 'src/content/sites.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { sites: context.FCM.SITES, doc, scope };
}

function run() {
  const good = 'https://www.youtube.com/@streamer';
  for (const platform of ['twitch', 'kick']) {
    const f = fixture([
      anchor(good), anchor(good), anchor('https://youtube.com/@mobile'), anchor('https://m.youtube.com/@mobile2'),
      anchor('https://www.youtube.com/@stale', { visible: false }),
      anchor('https://www.youtube.com/@viewer', { chat: true }),
      anchor('https://www.youtube.com/@hiddenChat', { visible: false, chat: true }),
      anchor('https://youtube.com.evil.test/@wrong'), anchor('https://evil.test/?next=https://youtube.com/@wrong'),
      anchor('http://www.youtube.com/@wrong'), anchor('//www.youtube.com/@wrong'), anchor(null),
      anchor('https://twitch.tv/existing'), anchor('https://kick.com/existing'),
    ]);
    const site = f.sites[platform];
    assert.deepEqual(Array.from(site.youtubeHints()), [good, 'https://youtube.com/@mobile', 'https://m.youtube.com/@mobile2']);
    assert.deepEqual(Array.from(site.hints()), ['https://' + (platform === 'twitch' ? 'kick.com' : 'twitch.tv') + '/existing'],
      'existing counterpart discovery keeps its original destinations');
    const captured = { querySelectorAll(selector) { assert.equal(selector, 'a[href]'); return [anchor('https://youtube.com/@captured')]; } };
    assert.deepEqual(Array.from(site.youtubeHints(captured)), ['https://youtube.com/@captured'], 'the captured host document is scanned');
    assert.deepEqual(Array.from(fixture([anchor(good)], false).sites[platform].youtubeHints()), [],
      'without a known chat scope the page cannot nominate an identity');
    site.chatScope = () => { throw Error('site changed'); };
    assert.deepEqual(Array.from(site.youtubeHints()), []);
    site.chatScope = null;
    assert.deepEqual(Array.from(site.youtubeHints()), []);
  }
  const many = fixture(Array.from({ length: 45 }, (_, n) => anchor('https://youtube.com/@channel' + n)));
  assert.equal(many.sites.twitch.youtubeHints().length, 40, 'page hints stay bounded');
  console.log('YouTube channel page hint tests passed.');
}

module.exports = run;
if (require.main === module) run();
