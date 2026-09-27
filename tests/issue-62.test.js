// Issue #62: Kick Drops pages must not be mistaken for streamer channels.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const dashboardPaths = ['/channel/stream', '/revenue', '/studio/vods', '/studio/clips',
  '/analytics/overview', '/analytics/streams', '/moderation/message-moderation',
  '/moderation/access', '/moderation/display', '/moderation/unban-requests',
  '/community/roles/moderator', '/community/roles/vip', '/community/roles/og',
  '/community/chat/emotes', '/community/chat/badges', '/community/chat/channel-points'];

function fixture(browser = 'chrome', pathname = '/drops') {
  const location = new URL(pathname, 'https://kick.com');
  const intervals = new Map(), timeouts = new Map(), events = new Map();
  const overlays = [], ports = [];
  let nextTimer = 0, resets = 0;
  const context = {
    URL, console, location,
    document: { querySelector: () => null, querySelectorAll: () => [] },
    window: { name: '', addEventListener: (name, listener) => events.set(name, listener) },
    setInterval: (callback, ms) => { const id = ++nextTimer; intervals.set(id, { callback, ms }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (callback, ms) => { const id = ++nextTimer; timeouts.set(id, { callback, ms }); return id; },
    clearTimeout: id => timeouts.delete(id),
    chrome: {
      runtime: {
        getURL: value => (browser === 'firefox' ? 'moz-extension://fixture/' : 'chrome-extension://fixture/') + value,
        connect() {
          const port = { sent: [], disconnected: false,
            postMessage(message) { this.sent.push(message); },
            disconnect() { this.disconnected = true; },
            onMessage: { addListener() {} }, onDisconnect: { addListener() {} } };
          ports.push(port);
          return port;
        },
      },
      storage: { onChanged: { addListener() {} } },
    },
  };
  context.self = context;
  vm.createContext(context);
  function load(relative) {
    const filename = path.join(ROOT, relative);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/util.js',
    'src/background/discovery.js', 'src/content/sites.js'].forEach(load);
  const FCM = context.FCM;
  FCM.isGifErrand = () => false;
  FCM.resetChannelView = () => { resets++; };
  FCM.createOverlay = ({ channel }) => {
    const overlay = { channel, destroyed: false,
      async mount() {}, destroy() { this.destroyed = true; } };
    overlays.push(overlay);
    return overlay;
  };
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  return { FCM, location, overlays, ports, intervals, timeouts,
    resets: () => resets,
    async start() { load('src/content/boot.js'); await flush(); },
    async navigate(pathname, byPopstate = false) {
      location.href = new URL(pathname, location.origin).href;
      if (byPopstate) events.get('popstate')();
      else for (const timer of intervals.values()) if (timer.ms === 600) timer.callback();
      await flush();
    },
  };
}

async function run() {
  for (const browser of ['chrome', 'firefox']) {
    for (const pathname of [...dashboardPaths, '/', '/future/dashboard/page', '/jrblaze', '/popout/jrblaze/chat', '/stream/extra', '/streaming']) {
      const dashboard = fixture(browser, 'https://dashboard.kick.com' + pathname);
      assert.equal(dashboard.FCM.currentSite(), dashboard.FCM.SITES.kick, 'dashboard retains navigation detection');
      assert.equal(dashboard.FCM.SITES.kick.channelFromUrl(), null, pathname + ' is not the stream dashboard');
      await dashboard.start();
      assert.equal(dashboard.overlays.length, 0, 'dashboard never mounts an overlay');
      assert.equal(dashboard.ports.length, 0, 'dashboard never opens a chat session');
      assert.equal(dashboard.timeouts.size, 0, 'dashboard never schedules discovery or watch actions');
      assert.equal([...dashboard.intervals.values()].some(timer => timer.ms === 20000), false, 'excluded dashboard pages have no chat keepalive');
      await dashboard.navigate('/stream');
      assert.equal(dashboard.overlays.length, 1, 'SPA navigation to the stream dashboard activates the existing overlay');
      await dashboard.navigate(pathname, true);
      assert.equal(dashboard.overlays[0].destroyed, true, 'leaving stream removes the overlay');
      assert.equal(dashboard.ports[0].disconnected, true, 'leaving stream closes its chat session');
      assert.equal(dashboard.timeouts.size, 0, 'leaving stream cancels discovery and watch timers');
      await dashboard.navigate('/stream/');
      assert.equal(dashboard.overlays.length, 2, 'returning to stream activates the overlay again');
    }
    for (const pathname of ['/stream', '/stream/', '/stream?layout=chat#live']) {
      const stream = fixture(browser, 'https://dashboard.kick.com' + pathname);
      await stream.start();
      assert.equal(stream.overlays.length, 1, pathname + ' keeps its existing direct-load behavior');
      assert.equal(stream.ports.length, 1);
    }
    for (const host of ['kick.com', 'www.kick.com']) {
      for (const pathname of ['/jrblaze', '/popout/jrblaze/chat', '/revenue', '/studio']) {
        const publicPage = fixture(browser, 'https://' + host + pathname);
        assert.equal(publicPage.FCM.currentSite(), publicPage.FCM.SITES.kick);
        await publicPage.start();
        assert.equal(publicPage.overlays.length, 1, host + pathname + ' remains a public channel');
        assert.equal(publicPage.ports.length, 1, 'public channels still connect');
      }
    }
    for (const host of ['help.kick.com', 'id.kick.com', 'api.kick.com', 'notkick.com', 'kick.com.example.org', 'www.dashboard.kick.com']) {
      const nonChannel = fixture(browser, 'https://' + host + '/jrblaze');
      assert.equal(nonChannel.FCM.currentSite(), null, host + ' cannot activate a public channel overlay');
    }
    const f = fixture(browser);
    for (const route of ['/drops', '/drops/', '/drops/inventory', '/drops/claimed',
      '/drops/campaigns', '/drops/campaigns/fixture?sort=active#rewards', '/DrOpS/claimed']) {
      f.location.href = 'https://kick.com' + route;
      assert.equal(f.FCM.SITES.kick.channelFromUrl(), null, route + ' is not a Kick channel');
      assert.equal(f.FCM.slugFromUrl(f.location.href, 'kick'), null, route + ' is not a counterpart hint');
    }
    f.location.href = 'https://kick.com/popout/drops/chat';
    assert.equal(f.FCM.SITES.kick.channelFromUrl(), null, 'popout cannot bypass the reserved route');
    for (const channel of ['dropsfan', 'drops_streamer', 'drops-player', 'raindrops']) {
      f.location.href = 'https://kick.com/' + channel;
      assert.equal(f.FCM.SITES.kick.channelFromUrl(), channel, 'names containing drops remain valid');
      assert.equal(f.FCM.slugFromUrl(f.location.href, 'kick'), channel);
    }
    f.location.href = 'https://kick.com/popout/dropsfan/chat';
    assert.equal(f.FCM.SITES.kick.channelFromUrl(), 'dropsfan', 'real popout chats remain supported');

    const page = fixture(browser, '/drops/claimed');
    await page.start();
    assert.equal(page.overlays.length, 0, 'opening Drops directly creates no overlay');
    assert.equal(page.ports.length, 0, 'opening Drops directly creates no chat session');
    assert.equal(page.timeouts.size, 0, 'opening Drops does not schedule discovery or watch actions');
    await page.navigate('/dropsfan');
    assert.equal(page.overlays.length, 1, 'leaving Drops for a channel mounts normally');
    assert.equal(page.ports.length, 1);
    assert.equal(page.ports[0].sent[0].channel, 'dropsfan');
    const resetsBefore = page.resets();
    await page.navigate('/drops/inventory', true);
    assert.equal(page.overlays.length, 1, 'SPA navigation to Drops creates no replacement overlay');
    assert.equal(page.overlays[0].destroyed, true, 'the old overlay is removed on Drops');
    assert.equal(page.ports[0].disconnected, true, 'the previous chat session is disconnected');
    assert.equal(page.ports[0].sent.at(-1).channel, '', 'the worker is told to leave the channel');
    assert.equal(page.resets(), resetsBefore + 1, 'the old channel view is cleared');
    assert.equal(page.timeouts.size, 0, 'old discovery and watch actions are cancelled');
    assert.equal([...page.intervals.values()].some(timer => timer.ms === 20000), false,
      'the old chat keepalive is cancelled');
    await page.navigate('/drops/claimed');
    assert.equal(page.ports.length, 1, 'changing Drops tabs does not reconnect chat');
    await page.navigate('/another-channel');
    assert.equal(page.overlays.length, 2, 'returning to a streamer restores the overlay');
    assert.equal(page.overlays[1].channel, 'another-channel');
    assert.equal(page.ports.length, 2);
  }
  console.log('Issue #62 Kick Drops route and navigation tests passed.');
}

module.exports = run;
module.exports.dashboardPaths = dashboardPaths;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
