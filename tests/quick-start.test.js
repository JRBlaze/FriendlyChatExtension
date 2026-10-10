const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bootWorker, wait } = require('./background');
const ROOT = path.resolve(__dirname, '..');
const clean = value => JSON.parse(JSON.stringify(value));
const PAGE = 'src/setup/quick-start.html';
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function backgroundFixture(options = {}) {
  const calls = [], state = { twitch: { connected: false }, kick: { connected: false } };
  const chrome = { runtime: { id: 'fixture', getURL: file => `chrome-extension://fixture/${file}` } };
  const sandbox = vm.createContext({ chrome }); sandbox.self = sandbox;
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: path.join(ROOT, file) });
  }
  const F = sandbox.FCM;
  F.loadSettings = async () => { if (options.settingsError) throw Error('private fixture detail'); return { fixture: true }; };
  F.auth = {
    summary: async () => {
      if (options.summaryError) throw Error('private fixture detail');
      return state;
    },
    async connect(platform, settings) {
      calls.push({ platform, settings });
      if (options.connect) await options.connect(platform);
      if (options.connectError) throw Error('private fixture detail');
      state[platform] = { connected: true, login: '<FixtureViewer>', accessToken: 'FAKE_PRIVATE', refreshToken: 'FAKE_PRIVATE' };
    },
  };
  const file = path.join(ROOT, 'src/background/quick-start.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const sender = { id: 'fixture', url: chrome.runtime.getURL(PAGE), frameId: 0 };
  return { F, calls, options, state, sender, handle: (message, from = sender) => F.quickStartRequest(message, from) };
}

async function backgroundChecks() {
  const f = backgroundFixture();
  assert.deepEqual(clean(await f.handle({ cmd: 'quickStartAccounts' })), { ok: true, accounts: {
    twitch: { connected: false, login: '' }, kick: { connected: false, login: '' },
  } });
  assert.equal(f.calls.length, 0, 'reading setup never starts OAuth');
  for (const sender of [undefined, {}, { ...f.sender, id: 'another' }, { ...f.sender, url: 'https://kick.com/host' },
    { ...f.sender, url: f.sender.url + '/evil' }, { ...f.sender, frameId: 2 }, { ...f.sender, url: null }]) {
    assert.equal((await f.F.quickStartRequest({ cmd: 'quickStartConnect', platform: 'twitch' }, sender)).ok, false);
  }
  assert.equal(f.calls.length, 0, 'only the extension setup page may start this route');
  for (const message of [null, {}, { cmd: 'send' }, { cmd: 'quickStartConnect', platform: 'youtube' },
    { cmd: 'quickStartConnect', platform: '__proto__' }]) {
    assert.equal((await f.handle(message)).ok, false);
  }
  assert.equal((await f.handle({ cmd: 'quickStartAccounts' }, { ...f.sender, url: f.sender.url + '?source=manual#accounts' })).ok, true);
  assert.equal((await f.handle({ cmd: 'quickStartAccounts' }, { id: 'fixture', url: f.sender.url })).ok, true);
  for (const platform of ['twitch', 'kick']) {
    const result = await f.handle({ cmd: 'quickStartConnect', platform });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.accounts[platform].login, '<FixtureViewer>');
    assert.ok(!JSON.stringify(result).includes('FAKE_PRIVATE'), 'credentials never reach the guide');
    assert.equal(f.calls.at(-1).settings.fixture, true, 'use the existing sign-in settings');
    const count = f.calls.length;
    assert.equal((await f.handle({ cmd: 'quickStartConnect', platform })).changed, false);
    assert.equal(f.calls.length, count, 'already connected accounts are preserved');
  }
  for (const options of [{ settingsError: true }, { connectError: true }, { summaryError: true }]) {
    const failed = backgroundFixture(options);
    const result = await failed.handle({ cmd: 'quickStartConnect', platform: 'twitch' });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('private fixture detail'));
    Object.keys(options).forEach(key => { options[key] = false; });
    assert.equal((await failed.handle({ cmd: 'quickStartConnect', platform: 'twitch' })).ok, true, 'failure releases the connection lock');
  }
  const missing = backgroundFixture(); missing.F.auth.summary = async () => null;
  assert.equal((await missing.handle({ cmd: 'quickStartAccounts' })).accounts.twitch.connected, false);
  missing.F.auth.summary = async () => ({ twitch: { connected: false, login: 123 }, kick: { connected: true } });
  assert.equal((await missing.handle({ cmd: 'quickStartAccounts' })).accounts.twitch.login, '');
  const unreadable = backgroundFixture({ summaryError: true });
  assert.equal((await unreadable.handle({ cmd: 'quickStartAccounts' })).ok, false);
  let release;
  const slow = backgroundFixture({ connect: () => new Promise(resolve => { release = resolve; }) });
  const first = slow.handle({ cmd: 'quickStartConnect', platform: 'twitch' }); await flush();
  assert.equal((await slow.handle({ cmd: 'quickStartConnect', platform: 'kick' })).code, 'busy');
  assert.equal((await slow.handle({ cmd: 'quickStartAccounts' })).ok, true);
  release(); await first;
}

function uiFixture(options = {}) {
  const nodes = new Map(), events = {}, requests = [], storageEvents = [], state = options.accounts || {
    twitch: { connected: false }, kick: { connected: false },
  };
  const youtubeRequests = [], youtube = { granted: !!options.youtubeGranted };
  const permissionEvents = { added: new Set(), removed: new Set() };
  const permissionEvent = listeners => ({ addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) });
  function node(id) {
    if (!nodes.has(id)) {
      const handlers = {};
      nodes.set(id, { hidden: false, disabled: false, textContent: '', attrs: {},
        addEventListener(type, fn) { handlers[type] = fn; },
        setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; },
        focus() { this.focused = true; }, fire(type = 'click', extra = {}) { return handlers[type]?.({ isTrusted: true, ...extra }); },
      });
    }
    return nodes.get(id);
  }
  const chrome = { runtime: {
    async sendMessage(message) {
      requests.push(message);
      if (options.request) return options.request(message);
      if (options.readError && message.cmd === 'quickStartAccounts') throw Error('fixture read');
      if (options.connectError && message.cmd === 'quickStartConnect') return { ok: false, code: options.connectError };
      if (message.cmd === 'quickStartConnect') state[message.platform] = { connected: true, login: '<FixtureViewer>' };
      return { ok: true, accounts: clean(state) };
    },
    async openOptionsPage() { options.settingsOpened = (options.settingsOpened || 0) + 1; if (options.settingsError) throw Error('fixture settings'); },
  }, storage: { onChanged: { addListener: fn => storageEvents.push(fn), removeListener: fn => storageEvents.splice(storageEvents.indexOf(fn), 1) } },
  permissions: { contains: async () => youtube.granted,
    async request(permission) { youtubeRequests.push(permission); youtube.granted = true; return true; },
    onAdded: permissionEvent(permissionEvents.added), onRemoved: permissionEvent(permissionEvents.removed),
  } };
  const sandbox = vm.createContext({ chrome, console, document: { getElementById: node },
    window: { addEventListener: (type, fn) => { events[type] = fn; } }, FCM: { STORAGE_KEYS: { auth: 'fcm_auth_v1' } } });
  sandbox.self = sandbox;
  const accessFile = path.join(ROOT, 'src/setup/youtube-access.js');
  vm.runInContext(fs.readFileSync(accessFile, 'utf8'), sandbox, { filename: accessFile });
  const file = path.join(ROOT, 'src/setup/quick-start.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return { node, nodes, options, requests, state, events, storageEvents, youtubeRequests, youtube, permissionEvents };
}

async function uiChecks() {
  const f = uiFixture(); await flush();
  assert.equal(f.node('step-1').hidden, false);
  assert.equal(f.requests.filter(message => message.cmd === 'quickStartConnect').length, 0, 'opening the guide never connects');
  await f.node('next').fire('click', { isTrusted: false });
  assert.equal(f.node('step-2').hidden, true);
  await f.node('next').fire();
  assert.equal(f.node('step-2').hidden, false);
  assert.equal(f.node('title-2').focused, true);
  assert.equal(f.youtubeRequests.length, 0, 'entering Accounts does not prompt automatically');
  await f.node('allow-youtube').fire();
  assert.equal(f.node('allow-youtube').textContent, 'YouTube access allowed');
  assert.deepEqual(clean(f.youtubeRequests), [{ origins: ['https://www.youtube.com/*'] }]);
  await f.node('connect-twitch').fire('click', { isTrusted: false });
  assert.equal(f.requests.filter(message => message.cmd === 'quickStartConnect').length, 0);
  await f.node('connect-twitch').fire();
  assert.equal(f.node('connect-twitch').disabled, true);
  assert.match(f.node('account-twitch').textContent, /<FixtureViewer>/, 'usernames render as text');
  const count = f.requests.length;
  await f.node('connect-twitch').fire();
  assert.equal(f.requests.length, count);
  await f.node('connect-kick').fire();
  assert.equal(f.node('connect-kick').disabled, true);
  await f.node('back').fire();
  assert.equal(f.node('step-1').hidden, false);
  await f.node('next').fire(); await f.node('next').fire();
  assert.equal(f.node('step-3').hidden, false);
  await f.node('skip').fire('click', { isTrusted: false });
  assert.equal(f.node('complete').hidden, true);
  await f.node('skip').fire();
  assert.equal(f.node('complete').hidden, false);
  assert.equal(f.node('complete-title').focused, true);
  assert.equal(f.options.settingsOpened, undefined, 'skip never opens settings');
  await f.node('review').fire();
  assert.equal(f.node('step-1').hidden, false);
  await f.node('next').fire(); await f.node('next').fire();
  await f.node('settings').fire();
  assert.equal(f.options.settingsOpened, 1);
  assert.equal(f.node('complete').hidden, false);

  const skipped = uiFixture(); await flush();
  await skipped.node('next').fire(); await skipped.node('next').fire(); await skipped.node('skip').fire();
  assert.equal(skipped.requests.filter(message => message.cmd === 'quickStartConnect').length, 0, 'both account connections are optional');
  const failed = uiFixture({ readError: true }); await flush();
  assert.match(failed.node('status').textContent, /check/i);
  assert.equal(failed.node('connect-twitch').disabled, true);
  failed.options.readError = false;
  await failed.node('check').fire();
  await flush();
  assert.equal(failed.node('connect-twitch').disabled, false);
  await failed.node('next').fire();
  for (const code of ['failed', 'busy']) {
    failed.options.connectError = code;
    await failed.node('connect-twitch').fire();
    assert.match(failed.node('status').textContent, code === 'busy' ? /already open/ : /not completed/);
    assert.equal(failed.node('connect-twitch').disabled, false);
  }
  failed.options.connectError = '';
  await failed.node('next').fire();
  failed.options.settingsError = true;
  await failed.node('settings').fire();
  assert.equal(failed.node('complete').hidden, true);
  assert.match(failed.node('status').textContent, /settings/i);
  await failed.node('skip').fire();
  assert.equal(failed.node('complete').hidden, false);
  const unconfirmed = uiFixture({ request: async message => ({ ok: true, accounts: { twitch: { connected: false }, kick: { connected: false } } }) });
  await flush(); await unconfirmed.node('next').fire(); await unconfirmed.node('connect-twitch').fire();
  assert.match(unconfirmed.node('status').textContent, /not completed/, 'a response must confirm the connected account');

  const external = uiFixture({ accounts: { twitch: { connected: true }, kick: { connected: false } } }); await flush();
  assert.equal(external.node('account-twitch').textContent, 'Account connected');
  const before = external.requests.length;
  external.storageEvents[0]({ other: {} }, 'local');
  external.storageEvents[0]({ fcm_auth_v1: {} }, 'sync');
  await external.node('check').fire('click', { isTrusted: false });
  assert.equal(external.requests.length, before);
  external.state.twitch = { connected: false };
  external.storageEvents[0]({ fcm_auth_v1: {} }, 'local'); await flush();
  assert.equal(external.node('connect-twitch').disabled, false);
  external.events.focus(); await flush();

  for (const reply of [null, {}, { ok: true }, { ok: false }]) {
    const malformed = uiFixture({ request: async () => reply }); await flush();
    assert.equal(malformed.node('connect-twitch').disabled, true);
    assert.match(malformed.node('status').textContent, /Unable to check/);
  }
  for (const reply of [null, { ok: true }]) {
    const malformed = uiFixture({ request: async message => message.cmd === 'quickStartAccounts'
      ? { ok: true, accounts: { twitch: { connected: false }, kick: { connected: false } } } : reply });
    await flush(); await malformed.node('next').fire(); await malformed.node('connect-twitch').fire();
    assert.match(malformed.node('status').textContent, /not completed/);
  }
  const rejected = uiFixture({ request: async message => {
    if (message.cmd === 'quickStartConnect') throw Error('fixture message channel');
    return { ok: true, accounts: { twitch: { connected: false }, kick: { connected: false } } };
  } });
  await flush(); await rejected.node('next').fire(); await rejected.node('connect-twitch').fire();
  assert.match(rejected.node('status').textContent, /not completed/);

  const reads = [];
  const race = uiFixture({ request: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) });
  race.events.focus();
  reads[1].resolve({ ok: true, accounts: { twitch: { connected: true, login: 'Current' } } }); await flush();
  reads[0].resolve({ ok: true, accounts: { twitch: { connected: false } } }); await flush();
  assert.equal(race.node('account-twitch').textContent, 'Connected as Current', 'older reads cannot overwrite fresh account state');
  race.events.focus(); race.events.focus();
  reads[2].reject(Error('fixture old read')); await flush();
  reads[3].resolve({ ok: true, accounts: { twitch: { connected: true, login: 'Newest' } } }); await flush();
  assert.equal(race.node('account-twitch').textContent, 'Connected as Newest');

  for (const finish of ['resolve', 'reject']) {
    let release;
    const late = uiFixture({ request: () => new Promise((resolve, reject) => { release = finish === 'resolve' ? resolve : reject; }) });
    late.events.pagehide();
    release(finish === 'resolve' ? { ok: true, accounts: {} } : Error('fixture late read'));
    await flush();
    assert.equal(late.storageEvents.length, 0);
    assert.equal(late.permissionEvents.added.size, 0);
    assert.equal(late.permissionEvents.removed.size, 0);
    const before = late.requests.length;
    late.events.focus(); await late.node('next').fire(); await late.node('check').fire();
    assert.equal(late.requests.length, before, 'closed guide cannot request more state');
  }
  for (const close of [false, true, 'reject']) {
    let resolve, reject;
    const busy = uiFixture({ request: message => message.cmd === 'quickStartAccounts'
      ? { ok: true, accounts: { twitch: { connected: false }, kick: { connected: false } } }
      : new Promise((yes, no) => { resolve = yes; reject = no; }) });
    await flush(); await busy.node('next').fire();
    const connection = busy.node('connect-twitch').fire(); await flush();
    assert.equal(busy.node('next').disabled, true);
    const before = busy.requests.length;
    await busy.node('connect-kick').fire(); await busy.node('next').fire(); await busy.node('back').fire();
    busy.events.focus();
    assert.equal(busy.requests.length, before, 'one guide does not open overlapping sign-in windows');
    assert.equal(busy.node('step-2').hidden, false);
    if (close) busy.events.pagehide();
    if (close === 'reject') reject(Error('fixture late connection'));
    else resolve({ ok: true, accounts: { twitch: { connected: true, login: 'Viewer' } } });
    await connection;
    if (!close) assert.equal(busy.node('connect-twitch').disabled, true);
  }
  for (const failure of [false, true]) {
    let release;
    const settings = uiFixture(); await flush(); await settings.node('next').fire(); await settings.node('next').fire();
    settings.options.request = async message => ({ ok: true, accounts: {} });
    // Opening settings is asynchronous; closing the guide during it cannot redraw.
    settings.node('settings').fire('click', { isTrusted: false });
    const original = settings.options.settingsOpened;
    assert.equal(original, undefined);
    settings.options.settingsError = failure;
    const opening = settings.node('settings').fire();
    settings.events.pagehide(); await opening;
    assert.equal(settings.node('complete').hidden, true);
  }
}

async function run() {
  await backgroundChecks();
  await require('./quick-start-youtube.test').run();
  await uiChecks();
  const html = fs.readFileSync(path.join(ROOT, PAGE), 'utf8');
  assert.ok(html.includes('Read Twitch, Kick, and Youtube chats together on the stream page you already watch, and choose where each message goes.'));
  assert.ok(html.includes('When the streamer is also live on the other platforms, add that chat to the same feed. You can also link channels yourself.'));
  assert.ok(html.includes('Use <strong>Sent to</strong> to select Twitch, Kick, and/or Youtube. Enjoy emotes, favorites, replies and chat tools in one place.'));
  for (const id of ['step-1', 'step-2', 'step-3', 'connect-twitch', 'connect-kick', 'settings', 'skip', 'complete']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Open All Settings/);
  assert.match(html, /Skip and finish/);
  assert.match(html, /id="allow-youtube"/);
  assert.match(html, /Allow YouTube access/);
  assert.ok(html.indexOf('src="youtube-access.js"') < html.indexOf('src="quick-start.js"'));
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /onclick=|<script>(?!\s*<\/script>)/, 'no inline script or event code');
  const css = fs.readFileSync(path.join(ROOT, 'src/setup/quick-start.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /@media \(max-width: 650px\)/);
  for (const file of ['src/popup/popup.html', 'src/options/options.html']) {
    assert.match(fs.readFileSync(path.join(ROOT, file), 'utf8'), /href="\.\.\/setup\/quick-start\.html"[^>]*rel="noopener"/,
      'the guide is available again from popup and settings');
  }
  const packaged = require('../tools/pack').collect(ROOT);
  for (const file of ['src/setup/quick-start.html', 'src/setup/quick-start.css', 'src/setup/quick-start.js', 'src/setup/youtube-access.js', 'src/background/quick-start.js']) {
    assert.ok(packaged.includes(file), `${file} is included in both packages`);
  }
  for (const [browser, loadPath] of [['chrome', 'worker'], ['firefox', 'scripts']]) {
    const w = bootWorker({ browser, loadPath });
    try {
      w.sandbox.chrome.runtime.id = 'fixture';
      const sender = { id: 'fixture', frameId: 0, url: w.sandbox.chrome.runtime.getURL(PAGE) };
      let connected = false;
      w.sandbox.FCM.auth.summary = async () => ({ twitch: { connected, login: connected ? 'Viewer' : '', userId: '42' }, kick: { connected: false } });
      w.sandbox.FCM.auth.connect = async () => { connected = true; };
      const request = message => new Promise(resolve => {
        assert.equal(w.listeners.message(message, sender, resolve), true);
      });
      w.connect();
      assert.equal((await request({ cmd: 'quickStartAccounts' })).accounts.twitch.connected, false);
      assert.equal((await request({ cmd: 'quickStartConnect', platform: 'twitch' })).accounts.twitch.connected, true);
      assert.equal(w.last('auth').accounts.twitch.userId, '42', 'existing stream sessions receive their normal sanitized summary');
      assert.equal((await request({ cmd: 'quickStartConnect', platform: 'twitch' })).changed, false);
      const original = w.sandbox.FCM.quickStartRequest;
      w.sandbox.FCM.quickStartRequest = async () => { throw Error('fixture unexpected failure'); };
      assert.equal((await request({ cmd: 'quickStartAccounts' })).ok, false, 'route contains unexpected failures');
      w.sandbox.FCM.quickStartRequest = original;
      for (const [cmd, method] of [['updateStatus', 'updateStatus'], ['updateCheck', 'checkForUpdate'], ['updateDismiss', 'dismissUpdate']]) {
        w.sandbox.FCM[method] = async () => ({ fixture: true });
        const result = await request({ cmd, version: 'fixture' });
        assert.equal(result[cmd === 'updateDismiss' ? 'ok' : 'fixture'], true, 'existing popup routes still succeed');
        w.sandbox.FCM[method] = async () => { throw Error('fixture update failure'); };
        assert.equal(await request({ cmd }), null, 'existing popup route errors remain contained');
      }
      assert.equal(w.listeners.message({ cmd: 'unknown' }, sender, () => assert.fail('Unknown route replied')), undefined);
      assert.equal(w.sockets.length, 0, 'guide itself starts no channel connection');
      assert.ok(w.loaded.includes('src/background/quick-start.js'), `${browser} loads the guide account handler`);
    } finally { w.teardown(); }
  }
  console.log('Quick-start guide tests passed.');
}
module.exports = { run, backgroundFixture, backgroundChecks, uiFixture, uiChecks, flush };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
