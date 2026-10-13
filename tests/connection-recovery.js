// Issue #80: real socket sources with a deterministic clock and no network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

function fixture(browser = 'chrome') {
  let now = 100000, nextId = 1;
  const timers = new Map(), sockets = [], said = [], states = [], lookups = [];
  const schedule = (fn, delay, interval = false) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + delay, delay, interval });
    return id;
  };
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(data); }
    push(event, data = '{}') { this.onmessage({ data: JSON.stringify({ event, data }) }); }
    drop() { this.readyState = 3; this.onclose(); }
    close() { this.readyState = 3; schedule(() => this.onclose(), 0); }
  }
  const sandbox = {
    console, URL, URLSearchParams, WebSocket: Socket,
    Date: class extends Date { static now() { return now; } },
    chrome: { runtime: { getURL: () => `${browser === 'firefox' ? 'moz' : 'chrome'}-extension://test/` } },
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id),
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/util.js',
    'src/shared/irc.js', 'src/shared/emote-parsers.js', 'src/shared/kick-events.js',
    'src/background/twitch-source.js', 'src/background/kick-source.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  const FCM = sandbox.FCM;
  let info = { id: 10, user_id: 11, chatroom: { id: 12 } };
  FCM.kickApi = { channel: async (channel, opts) => { lookups.push({ channel, opts }); return info; } };
  const sink = new Proxy({ status: state => states.push(state), sys: text => said.push(text) },
    { get: (target, key) => target[key] || (() => {}) });
  const conn = { attempt: 0 };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, timer] = entry;
      now = timer.at;
      if (timer.interval) timer.at += timer.delay; else timers.delete(id);
      timer.fn();
      // Source connect awaits only the stubbed channel lookup.
      await Promise.resolve(); await Promise.resolve();
    }
    now = end;
  }
  return { FCM, conn, sink, sockets, said, states, timers, lookups, advance, sandbox,
    info: value => { info = value; },
    connect: platform => FCM[`${platform}Source`].connect('alpha', sink, conn, null),
    latest: () => sockets.at(-1),
    delay: id => timers.get(id)?.at - now,
    callback: id => timers.get(id)?.fn,
    pingCount: sock => sock.sent.filter(text => text.includes('pusher:ping')).length };
}

async function youtubeRecovery() {
  const { source, settle, VIDEO } = require('./youtube-transport.test');
  for (const browser of ['chrome', 'firefox']) for (const host of ['twitch.tv', 'kick.com']) {
    const s = source();
    s.context.FCM.BROWSER = browser;
    s.doc.location.hostname = host;
    let now = 100000;
    s.context.Date = { now: () => now };
    await s.control.start(VIDEO);
    for (let cycle = 0; cycle < 2; cycle++) for (const delay of [2000, 4000, 8000, 300000]) {
      const old = s.activePort(), count = s.chrome.runtime.ports.length;
      old.disconnect();
      assert.equal(s.control.getSendState().available, false);
      assert.equal(s.time.timers.size, 1);
      if (delay === 300000) assert.match(s.statuses.at(-1).text, /retrying in 5 minutes/i);
      s.message('batch', { ready: true }, old);
      assert.equal(s.chrome.runtime.ports.length, count);
      s.time.fire(delay); await settle();
      assert.equal(s.chrome.runtime.ports.length, count + 1);
      assert.notEqual(old.sent[0].run, s.activePort().sent[0].run);
    }
    // Healthy reading forgives previous transient drops, but repeated heartbeats
    // must not keep moving the stable-connection timestamp forward.
    s.activePort().disconnect(); s.time.fire(2000); await settle();
    s.message('host-ready');
    assert.equal(new URL(s.frames.at(-1).src).searchParams.get('embed_domain'), host);
    s.message('batch', { ready: true });
    now += 10000; s.message('batch', { ready: true });
    now += 20001; s.activePort().disconnect();
    s.time.fire(2000); await settle();
    s.activePort().disconnect(); s.time.fire(4000); await settle();
    s.activePort().disconnect(); s.time.fire(8000); await settle();
    // A handed-off send becomes uncertain once, and is never replayed in a
    // replacement frame even when that replacement follows a cooldown.
    s.message('host-ready');
    s.message('send-state', { available: true, reason: 'ready', accountLabel: 'Synthetic Viewer',
      capability: 1, maxLength: 200 });
    const pending = s.control.send('Never replay this message');
    s.activePort().disconnect();
    assert.equal((await pending).outcome, 'uncertain');
    const lateCooldown = [...s.time.timers.values()][0].fn;
    s.time.fire(300000); await settle();
    assert.deepEqual(s.activePort().sent.map(message => message.cmd), ['start']);
    const recoveredPorts = s.chrome.runtime.ports.length;
    lateCooldown(); await settle();
    assert.equal(s.chrome.runtime.ports.length, recoveredPorts, 'a queued old cooldown cannot replace the recovered reader');
    s.control.stop(); lateCooldown(); await settle();
    assert.equal(s.time.timers.size, 0, 'Remove/navigation cancels every cooldown');
    assert.equal(s.statuses.at(-1).state, 'stopped');
  }
  // Cooldown retains no live frames and checks access again before rebuilding.
  for (const permission of [{ granted: false }, { granted: true, error: 'reader-registration' }]) {
    const s = source(); await s.control.start(VIDEO);
    for (const delay of [2000, 4000, 8000]) {
      s.activePort().disconnect(); s.time.fire(delay); await settle();
    }
    s.message('host-ready'); s.activePort().disconnect();
    assert.ok(s.frames.every(frame => frame.removed));
    s.chrome.runtime.sendMessage = async () => permission;
    s.time.fire(300000); await settle();
    assert.equal(s.chrome.runtime.ports.length, 4);
    assert.equal(s.statuses.at(-1).state, permission.error ? 'error' : 'permission');
    assert.equal(s.time.timers.size, 0);
  }
  // Explicit Add replaces a paused attempt; its already-queued timer is inert.
  {
    const s = source(); await s.control.start(VIDEO);
    for (const delay of [2000, 4000, 8000]) {
      s.activePort().disconnect(); s.time.fire(delay); await settle();
    }
    s.activePort().disconnect();
    const late = [...s.time.timers.values()][0].fn;
    await s.control.start(VIDEO); late(); await settle();
    assert.equal(s.chrome.runtime.ports.length, 5);
    s.control.destroy(); assert.equal(s.time.timers.size, 0);
  }
}

async function run() {
  await youtubeRecovery();
  for (const browser of ['chrome', 'firefox']) {
    // Negotiate a bounded heartbeat; malformed values cannot create a tight loop.
    for (const value of [undefined, 120, 10, 0, -1, '10', 'bad', null]) {
      const f = fixture(browser);
      await f.connect('kick');
      f.latest().push('pusher:connection_established', JSON.stringify({ activity_timeout: value }));
      const delay = value === 10 ? 10000 : 25000;
      assert.equal(f.delay(f.conn.pingTimer), delay, `heartbeat interval: ${value}`);
      await f.advance(delay - 1);
      assert.equal(f.pingCount(f.latest()), 0);
      await f.advance(1);
      assert.equal(f.pingCount(f.latest()), 1);
      assert.equal(f.delay(f.conn.pongTimer), 30000);
      f.FCM.kickSource.disconnect(f.conn);
      await f.advance(0);
      assert.equal(f.timers.size, 0);
    }
    for (const data of ['null', 'broken', '{"activity_timeout":1e999}']) {
      const f = fixture(browser);
      await f.connect('kick');
      f.latest().push('pusher:connection_established', data);
      assert.equal(f.delay(f.conn.pingTimer), 25000);
      f.FCM.kickSource.disconnect(f.conn);
      await f.advance(0);
    }
    // A received pong or chat/protocol message proves the socket is alive.
    for (const event of ['pusher:pong', 'pusher:ping', 'pusher_internal:subscription_succeeded',
      'App\\Events\\ChatMessageEvent']) {
      const f = fixture(browser);
      await f.connect('kick');
      f.latest().push('pusher:connection_established');
      await f.advance(25000);
      f.latest().push(event, JSON.stringify({ content: 'hello', sender: { username: 'reader' } }));
      assert.equal(f.conn.pongTimer, null);
      await f.advance(25000);
      assert.equal(f.pingCount(f.latest()), 2);
      assert.equal(f.latest().readyState, 1);
      if (event === 'pusher:ping') assert.ok(f.latest().sent.some(text => text.includes('pusher:pong')));
      f.FCM.kickSource.disconnect(f.conn);
      await f.advance(0);
    }
    // A blackholed connection cannot remain green forever or keep extending its deadline.
    {
      const f = fixture(browser);
      await f.connect('kick');
      f.latest().push('pusher:connection_established');
      const dead = f.latest();
      await f.advance(54999);
      assert.equal(f.pingCount(dead), 1);
      assert.equal(dead.readyState, 1);
      await f.advance(1);
      assert.equal(dead.readyState, 3);
      assert.ok(f.said.some(text => text.includes('timed out')));
      assert.equal(f.conn.pingTimer, null);
      assert.equal(f.conn.pongTimer, null);
      assert.equal(f.delay(f.conn.retryTimer), 2000);
      await f.advance(2000);
      assert.equal(f.sockets.length, 2);
      assert.equal(f.conn.attempt, 1);
    }
    // Stale handlers, keepalives and deadlines cannot affect the replacement socket.
    {
      const f = fixture(browser);
      await f.connect('kick');
      const old = f.latest();
      old.push('pusher:connection_established');
      const oldPing = f.callback(f.conn.pingTimer);
      await f.advance(25000);
      const oldPong = f.callback(f.conn.pongTimer);
      await f.FCM.kickSource.connect('bravo', f.sink, f.conn, null);
      const live = f.latest();
      live.push('pusher:connection_established');
      const livePing = f.conn.pingTimer;
      oldPing(); oldPong(); old.push('pusher:pong');
      await f.advance(0);
      assert.equal(f.conn.pingTimer, livePing);
      assert.equal(live.readyState, 1);
      assert.equal(f.conn.channel, 'bravo');
      assert.equal(f.conn.retryTimer, undefined);
      live.readyState = 0;
      f.callback(livePing)();
      assert.equal(f.pingCount(live), 0);
      f.FCM.kickSource.disconnect(f.conn);
      await f.advance(0);
      assert.equal(f.timers.size, 0);
    }
    // Exhaustion is a pause, with automatic recovery and the original bounded backoff.
    for (const platform of ['kick', 'twitch']) {
      const f = fixture(browser);
      assert.equal(f.FCM.RECONNECT_COOLDOWN_MS, 300000);
      await f.connect(platform);
      for (let attempt = 0; attempt <= 10; attempt++) {
        f.latest().drop();
        const delay = attempt === 10 ? 300000 : Math.min(2000 * (2 ** attempt), 30000);
        assert.equal(f.delay(f.conn.retryTimer), delay, `${platform} attempt ${attempt}`);
        const count = f.sockets.length;
        await f.advance(delay - 1);
        assert.equal(f.sockets.length, count);
        await f.advance(1);
        assert.equal(f.sockets.length, count + 1);
        assert.equal(f.conn.attempt, attempt === 10 ? 0 : attempt + 1);
      }
      assert.ok(f.said.some(text => /reconnect limit reached.*5 minutes/.test(text)));
      // A healthy connection resets attempts; an unopened replacement must not
      // inherit the last healthy socket's timestamp and forgive its own failure.
      f.conn.attempt = 10;
      if (platform === 'kick') f.latest().push('pusher:connection_established');
      else f.latest().onmessage({ data: ':server 366 reader #alpha :End of /NAMES list\r\n' });
      await f.advance(30001);
      f.latest().drop();
      assert.equal(f.conn.attempt, 0);
      await f.advance(2000);
      assert.equal(f.conn.connectedAt, 0);
      f.conn.attempt = 10;
      f.latest().drop();
      assert.equal(f.delay(f.conn.retryTimer), 300000);
      const late = f.callback(f.conn.retryTimer), count = f.sockets.length;
      f.FCM[`${platform}Source`].disconnect(f.conn);
      late();
      await f.advance(300000);
      assert.equal(f.sockets.length, count, 'leaving cancels recovery');
      // An explicit reconnect bypasses the cooldown. A queued callback must
      // also refuse force-close/channel changes even within the same generation.
      f.conn.attempt = 10;
      await f.connect(platform);
      f.latest().drop();
      const queued = f.callback(f.conn.retryTimer);
      const before = f.sockets.length;
      f.conn.forceClose = true;
      queued();
      f.conn.forceClose = false;
      f.conn.channel = 'bravo';
      queued();
      assert.equal(f.sockets.length, before);
      f.conn.attempt = 0;
      await f.connect(platform);
      assert.equal(f.sockets.length, before + 1);
      assert.equal(f.conn.retryTimer, null);
      // A connection with no prior attempts also follows the normal backoff.
      delete f.conn.attempt;
      f.latest().drop();
      assert.equal(f.delay(f.conn.retryTimer), 2000);
      await f.advance(2000);
      assert.equal(f.conn.attempt, 1);
      f.FCM[`${platform}Source`].disconnect(f.conn);
      await f.advance(0);
    }
    // Pre-socket lookup/constructor failures use the same cooldown, with a fresh lookup.
    for (const failure of ['lookup', 'constructor']) {
      const f = fixture(browser);
      if (failure === 'lookup') f.info(null);
      // Explicit constructor failure without using any real transport.
      if (failure === 'constructor') {
        vm.runInContext('WebSocket = function () { throw Error("offline"); };',
          f.sandbox);
      }
      f.conn.attempt = 10;
      await f.connect('kick');
      assert.equal(f.delay(f.conn.retryTimer), 300000);
      const late = f.callback(f.conn.retryTimer);
      f.info({ id: 10, chatroom: { id: 12 } });
      await f.advance(300000);
      assert.equal(f.conn.attempt, 0);
      assert.equal(f.lookups.length, 2);
      if (failure === 'lookup') {
        // Failed metadata below the cap retains normal backoff and bypasses cache.
        f.info(null);
        await f.connect('kick');
        assert.equal(f.delay(f.conn.retryTimer), 2000);
        await f.advance(2000);
        assert.equal(f.conn.attempt, 1);
        assert.equal(f.lookups.at(-1).opts.maxAge, 0);
        const queued = f.callback(f.conn.retryTimer);
        f.conn.forceClose = true;
        queued();
        f.conn.forceClose = false;
        f.conn.channel = 'bravo';
        queued();
      }
      f.FCM.kickSource.disconnect(f.conn);
      late();
      await f.advance(0);
    }
  }
  // Drive the real session coordinator through each browser's startup path.
  // The other platform must keep delivering chat throughout Kick recovery.
  const { bootWorker, wait } = require('./background');
  for (const browser of ['chrome', 'firefox']) {
    const w = bootWorker({ browser, loadPath: browser === 'firefox' ? 'scripts' : 'worker' });
    try {
      w.sandbox.FCM.MAX_RECONNECT_ATTEMPTS = 0;
      w.sandbox.FCM.RECONNECT_COOLDOWN_MS = 100;
      w.connect();
      w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] });
      await wait(60);
      w.send({ cmd: 'join', platform: 'twitch', channel: 'alpha' });
      w.send({ cmd: 'join', platform: 'kick', channel: 'alpha' });
      await wait(60);
      const twitch = w.socketFor('irc-ws'), kick = w.socketFor('pusher');
      twitch.push(':server 366 reader #alpha :End of /NAMES list\r\n');
      kick.push(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
      kick.drop();
      twitch.push('@id=still;display-name=Guest :guest!guest@host PRIVMSG #alpha :still here\r\n');
      assert.ok(w.of('chat').some(({ msg }) => msg.platform === 'twitch' && msg.text === 'still here'));
      await wait(150);
      assert.equal(w.socketsFor('pusher').length, 2);
      assert.equal(w.socketsFor('irc-ws').length, 1);
      assert.equal(twitch.readyState, 1);
      const latest = w.socketsFor('pusher').at(-1);
      latest.drop();
      w.send({ cmd: 'leave', platform: 'kick' });
      await wait(150);
      assert.equal(w.socketsFor('pusher').length, 2, 'coordinator leave cancels cooldown');
      w.send({ cmd: 'join', platform: 'kick', channel: 'alpha' });
      await wait(60);
      assert.equal(w.socketsFor('pusher').length, 3, 'explicit join bypasses cooldown');
    } finally { w.teardown(); }
  }
  console.log('Issue #80 Twitch/Kick/YouTube recovery tests passed (Chrome and Firefox source modes).');
}

async function coverage() {
  const inspector = require('node:inspector');
  const { promisify } = require('node:util');
  const { execFileSync } = require('node:child_process');
  const gate = require('./youtube-coverage');
  gate.selfTest();
  const session = new inspector.Session(); session.connect();
  const post = promisify(session.post.bind(session));
  await post('Debugger.enable'); await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  await run();
  const { result } = await post('Profiler.takePreciseCoverage');
  for (const file of ['src/shared/constants.js', 'src/background/kick-source.js', 'src/background/twitch-source.js',
    'src/content/youtube-source.js']) {
    const scripts = [];
    for (const script of result.filter(item => gate.matchesFile(item, file))) {
      const { scriptSource } = await post('Debugger.getScriptSource', { scriptId: script.scriptId });
      scripts.push({ ...script, source: scriptSource });
    }
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', '--', file],
      { cwd: ROOT, encoding: 'utf8' });
    const report = gate.report(file, source, scripts, gate.selectedLines(source, diff, false));
    const hit = report.lines.filter(line => line.covered).length;
    const funcs = [...report.functions.values()].filter(Boolean).length;
    const ranges = [...report.ranges.values()].filter(Boolean).length;
    console.log(`${file}: changed executable lines ${hit}/${report.lines.length}; functions ${funcs}/${report.functions.size}; V8 ranges ${ranges}/${report.ranges.size}`);
    for (const line of report.lines.filter(line => !line.covered)) console.log(`  UNCOVERED line ${line.line}`);
    for (const [key, covered] of report.ranges) if (!covered) {
      const [start, end] = key.split(':').map(Number);
      console.log(`  UNCOVERED range line ${source.slice(0, start).split('\n').length}: ${source.slice(start, end)}`);
    }
    if (!report.passed) process.exitCode = 1;
  }
  await post('Profiler.stopPreciseCoverage'); session.disconnect();
}

module.exports = run;
module.exports.fixture = fixture;
if (require.main === module) (process.argv.includes('--coverage') ? coverage() : run())
  .catch(error => { console.error(error); process.exitCode = 1; });
