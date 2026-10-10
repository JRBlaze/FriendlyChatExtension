const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bootWorker } = require('./background');
const ROOT = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const context = vm.createContext({ console, URL, setTimeout, clearTimeout });
  context.self = context;
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/util.js',
    'src/shared/emote-parsers.js', 'src/content/render.js', 'src/content/compose.js', 'src/background/emotes.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: path.join(ROOT, file) });
  }
  return context.FCM;
}

function composerFixture() {
  const F = fixture(), nodes = [];
  function element() {
    const classes = new Set(['fcm-hidden']), events = {}, queries = new Map();
    const node = { style: {}, children: [], value: '', selectionStart: 0, selectionEnd: 0, clientHeight: 500,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      addEventListener(type, fn) { events[type] = fn; }, focus() {},
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      appendChild(child) { this.children.push(child); },
      querySelector(selector) { if (!queries.has(selector)) queries.set(selector, element()); return queries.get(selector); },
      insertAdjacentHTML(_position, html) { this.innerHTML = (this.innerHTML || '') + html; this.lastElementChild = element(); },
      fire(type, target = node) { events[type]?.({ target, preventDefault() {}, stopPropagation() {} }); },
    };
    nodes.push(node); return node;
  }
  const document = { createElement: element, addEventListener() {} };
  const sandbox = vm.createContext({ FCM: F, document, window: {}, console, setTimeout: () => 1, clearTimeout() {} });
  sandbox.self = sandbox;
  const file = path.join(ROOT, 'src/content/compose.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const panel = element(), inputEl = element(), feedEl = element();
  const api = F.createCompose({ panel, inputEl, feedEl, toast() {} });
  return { F, api, panel, inputEl, popup: panel.children[0] };
}

async function pageFixture(options = {}) {
  const received = [], commands = [], calls = [], timers = [];
  let handler;
  const port = { postMessage: command => commands.push(command), disconnect() {},
    onMessage: { addListener: fn => { handler = fn; } }, onDisconnect: { addListener() {} } };
  const F = fixture();
  const location = { pathname: '/host', search: '', hash: '', href: 'https://kick.com/host' };
  const sandbox = vm.createContext({ FCM: F, location, console, URL,
    document: { cookie: options.token === false ? '' : 'session_token=fixture', querySelectorAll: () => [], querySelector: () => null },
    window: { name: '', addEventListener() {} },
    chrome: { runtime: { connect: () => port }, storage: { onChanged: { addListener() {} } } },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/me')) {
        if (options.error === 'network') throw Error('fixture network');
        if (options.error === 'json') return { ok: true, json: async () => { throw Error('fixture json'); } };
        return { ok: options.error !== 'http', json: async () => ({ is_subscribed: options.subscribed !== false }) };
      }
      if (options.emoteError) throw Error('fixture emote network');
      return { ok: true, json: async () => options.empty ? [] : [{ id: 1, slug: 'host', emotes: [
        { id: 11, name: 'Paid', subscribers_only: true }, { id: 12, name: 'Free' },
      ] }] };
    } });
  sandbox.self = sandbox;
  Object.assign(F, { currentSite: () => ({ id: options.platform || 'kick', channelFromUrl: () => 'host', hints: () => [] }),
    isGifErrand: () => false, createOverlay: () => ({ mount: async () => {}, sys() {}, setAccounts() {},
      setEmotes(...args) { received.push(args); }, destroy() {} }), loadSettings: async () => ({ ...F.DEFAULT_SETTINGS, watchWhenLive: false }),
  });
  const file = path.join(ROOT, 'src/content/boot.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  return { F, received, calls, commands, handler, location };
}

async function run() {
  require('./emote-availability-coverage').selfTest();
  const F = fixture();
  F.setEmotes('twitch', 'native', { Expired: { url: 'old', selectable: true }, Kept: { url: 'kept', selectable: true } }, true);
  F.view.settings.favouriteEmotes = ['Expired', 'Kept'];
  assert.equal(F.allEmoteEntries().length, 2);
  F.setEmotes('twitch', 'native', { Kept: { url: 'kept', selectable: true } }, true);
  assert.deepEqual(plain(F.allEmoteEntries().map(item => item.name)), ['Kept'], 'fresh lists revoke missing emotes');
  assert.equal(F.findEmote('Expired').url, 'old', 'old chat retains its image');
  assert.deepEqual(plain(F.view.settings.favouriteEmotes), ['Expired', 'Kept'], 'saved favorites are preserved');
  assert.equal(F.pickerSections(F.allEmoteEntries(), F.view.settings.favouriteEmotes)[0].entries.length, 1);
  F.setEmotes('twitch', 'native', { Expired: { url: 'old', selectable: true } }, true);
  assert.deepEqual(plain(F.allEmoteEntries().map(item => item.name)), ['Expired'], 'renewed access restores favorites');
  F.setEmotes('kick', 'native', { Expired: { url: 'kick', selectable: false }, Seen: { url: 'seen', learned: true } });
  assert.equal(F.allEmoteEntries().some(item => item.name === 'Seen'), false, 'another viewer cannot grant access');
  F.setEmotes('twitch', 'native', { Expired: { url: 'old', selectable: false } }, true);
  F.setEmotes('kick', 'thirdparty', { Expired: { url: 'thirdparty' } });
  assert.equal(F.allEmoteEntries().find(item => item.name === 'Expired').url, 'thirdparty', 'available same-name alternatives survive');
  const version = F.view.emoteVersion;
  F.setEmotes('twitch', 'native', {}, true);
  assert.equal(F.view.emoteVersion, version, 'repeated revoked snapshot does not rebuild the index');
  F.setEmotes('unknown', 'native', {}, true);
  F.setEmotes('twitch', 'native', null, true);

  const compose = composerFixture();
  compose.api.refreshEmotes();
  compose.F.setEmotes('twitch', 'native', { Paid: { url: 'paid', selectable: true } }, true);
  compose.api.toggleEmotePicker();
  assert.equal(compose.api.isPopupOpen(), true);
  compose.F.setEmotes('twitch', 'native', {}, true);
  compose.popup.fire('mousedown', { closest: selector => selector === '[data-index]' ? { dataset: { index: '0' } } : null });
  assert.equal(compose.inputEl.value, '', 'stale picker cells cannot insert revoked emotes');
  assert.equal(compose.api.isPopupOpen(), false);
  compose.F.setEmotes('twitch', 'native', { Paid: { url: 'paid', selectable: true } }, true);
  compose.api.toggleEmotePicker();
  compose.api.refreshEmotes();
  compose.F.setEmotes('twitch', 'native', {}, true);
  compose.api.refreshEmotes();
  assert.match(compose.popup.querySelector('.fcm-ac-results').innerHTML, /No emotes match/);
  compose.api.closeAll();
  compose.F.setEmotes('twitch', 'native', { Paid: { url: 'paid', selectable: true } }, true);
  compose.inputEl.value = ':Pa'; compose.inputEl.selectionStart = 3;
  compose.api.updateAutocomplete();
  assert.equal(compose.api.isPopupOpen(), true);
  compose.F.setEmotes('twitch', 'native', {}, true);
  compose.api.refreshEmotes();
  assert.equal(compose.api.isPopupOpen(), false, 'typed suggestions refresh too');

  let user = [{ id: 'mine', name: 'Mine' }], sets = [{ id: 'expired', name: 'Expired' }];
  F.getJson = async url => {
    if (url.includes('/chat/emotes/global')) return { data: [{ id: 'global', name: 'Global' }] };
    if (url.includes('/chat/emotes/user')) return { data: user };
    if (url.includes('/chat/emotes/set')) return { data: sets };
    if (url.includes('/chat/emotes?')) return { data: [{ id: 'chan', name: 'ChannelSub', emote_type: 'subscriptions' }] };
    return { data: [] };
  };
  const opts = { clientId: 'fixture', token: 'fixture', userId: 'viewer', broadcasterId: 'host', setIds: ['old'] };
  let store = await F.emoteLoader.twitchNative(opts);
  assert.equal(store.Mine.selectable, true);
  assert.equal(store.Global.selectable, true);
  assert.equal(store.ChannelSub.selectable, false, 'the channel catalog is not entitlement');
  assert.equal(store.Expired.selectable, false, 'fresh complete user list overrides stale IRC sets');
  user = null;
  store = await F.emoteLoader.twitchNative(opts);
  assert.equal(store.Expired.selectable, true, 'current IRC sets still work if user endpoint is refused');
  assert.equal(store.ChannelSub.selectable, false);
  store = await F.emoteLoader.twitchNative({ clientId: 'fixture', broadcasterId: 'host' });
  assert.equal(store.ChannelSub.selectable, false, 'signed-out catalogs do not grant subscriber access');
  user = [null, { name: 'NoId' }, { id: 'NoName' }, { id: 'owned', name: 'Owned', owner_id: '123' }];
  store = await F.emoteLoader.twitchNative(opts);
  assert.equal(store.Owned.selectable, true, 'valid owner records still load alongside malformed entries');
  assert.equal(store.NoId, undefined);

  const kick = F.parseKickEmotePayload([
    { id: 1, slug: 'host', emotes: [{ id: 1, name: 'Paid', subscribers_only: true }, { id: 2, name: 'Free' }] },
    { id: 2, slug: 'other', emotes: [{ id: 3, name: 'OtherPaid', subscribers_only: true }] },
  ], 'host');
  F.applyKickEmoteAccess(kick, null);
  assert.equal(kick.Paid.selectable, false);
  assert.equal(kick.Free.selectable, true);
  assert.equal(kick.OtherPaid.selectable, true, 'personal set inclusion confirms the other channel entitlement');
  F.applyKickEmoteAccess(kick, { is_subscribed: true });
  assert.equal(kick.Paid.selectable, true);
  F.applyKickEmoteAccess(kick, { is_subscribed: false });
  assert.equal(kick.Paid.selectable, false);
  F.applyKickEmoteAccess(kick, { is_broadcaster: true });
  assert.equal(kick.Paid.selectable, true);
  F.applyKickEmoteAccess(kick, { is_moderator: true });
  assert.equal(kick.Paid.selectable, false, 'moderation does not grant paid emotes');

  const recent = require('./recent-emotes.test').fixture();
  await recent.api.ready;
  await recent.api.record('Kappa KEKW', ['twitch', 'kick']);
  const stale = recent.container.children[0];
  recent.FCM.view.emotes.twitch.native.Kappa.selectable = false;
  recent.FCM.view.emotes.kick.native.KEKW.learned = true;
  recent.api.refresh();
  assert.deepEqual(recent.container.children.map(button => button.title), ['Kappa (Kick)']);
  stale.fire('click');
  assert.equal(recent.inputEl.value, '', 'a stale quick button cannot insert a revoked emote');
  recent.api.destroy();

  for (const browser of ['chrome', 'firefox']) {
    let refreshes = 0;
    const args = [];
    const ui = require('./youtube-sending-ui.test').fixture({ browser, onEmotes: (...values) => args.push(values),
      refreshEmotes: () => { refreshes++; } });
    ui.api.setEmotes('twitch', 'native', {}, true);
    await ui.api.mount();
    ui.api.setEmotes('twitch', 'native', {}, true);
    ui.api.setEmotes('kick', 'native', {});
    assert.deepEqual(args.map(values => values[3]), [true, true, false], 'overlay forwards fresh snapshots');
    assert.equal(refreshes, 2, 'mounted picker refreshes on new access');
    ui.api.destroy();
  }

  for (const options of [{}, { subscribed: false }, { token: false }, { empty: true }, { emoteError: true }, { error: 'http' }, { error: 'json' }, { error: 'network' }]) {
    const page = await pageFixture(options);
    page.handler({ type: 'emotes', platform: 'kick', kind: 'native', store: {}, replace: true });
    assert.equal(page.received[0][3], true, 'content forwards fresh snapshot metadata');
    page.handler({ type: 'needKickEmotes', channel: 'host', loaded: 1 });
    for (let i = 0; i < 50; i++) await Promise.resolve();
    if (options.token === false) { assert.equal(page.calls.length, 0); continue; }
    if (options.empty || options.emoteError) { assert.equal(page.received.length, 1, 'an empty failed load grants no access'); continue; }
    assert.equal(page.received.at(-1)[3], true, 'page list replaces availability');
    assert.equal(page.received.at(-1)[2].Paid.selectable, !options.error && options.subscribed !== false);
    assert.equal(page.received.at(-1)[2].Free.selectable, true);
    assert.equal(page.calls.at(-1).init.redirect, 'error', 'session header is not followed to another origin');
    assert.equal(page.commands.at(-1).cmd, 'cacheKickEmotes');
  }
  const unsigned = await pageFixture({ token: false });
  unsigned.handler({ type: 'needKickEmotes', channel: 'host', loaded: 0 });
  for (let i = 0; i < 50; i++) await Promise.resolve();
  assert.equal(unsigned.received[0][2].Paid.selectable, false);

  for (const browser of ['chrome', 'firefox']) {
    const w = bootWorker({ browser, loadPath: browser === 'firefox' ? 'scripts' : 'worker' });
    try {
      await vm.runInContext(`(async () => {
        const session = createSession(99, { postMessage() {} });
        session.conns.twitch.channel = 'host';
        const sink = makeSink(session, 'twitch');
        sink.emoteSets(['one', 'two']);
        await session.conns.twitch.emoteChain;
        sink.emoteSets(['two']);
        await session.conns.twitch.emoteChain;
        if (session.conns.twitch.emoteSets.join() !== 'two') throw Error('revoked IRC set retained');
        sink.emoteSets(['two']);
        sink.emoteSets(['three']);
        await session.conns.twitch.emoteChain;
        sink.emoteSets([]);
        await session.conns.twitch.emoteChain;
        sink.emoteSets();
        if (session.conns.twitch.emoteSets.length) throw Error('empty IRC set snapshot ignored');
      })()`, w.sandbox);
      const native = { Old: { url: 'old', selectable: true } };
      await w.sandbox.FCM.emoteCache.write('twitch', 'host', '', 'native', native);
      const payloads = [];
      w.sandbox.testPort = { postMessage: msg => payloads.push(msg) };
      await vm.runInContext(`(async () => {
        globalThis.testSession = createSession(99, testPort);
        testSession.conns.twitch.channel = 'host';
        await sendCachedEmotes(testSession, 'twitch');
        testSession.conns.twitch.nativeEmotesFresh = true;
        await sendCachedEmotes(testSession, 'twitch');
      })()`, w.sandbox);
      assert.equal(payloads.filter(msg => msg.type === 'emotes').length, 1, 'late cache cannot overwrite current access');
      assert.equal(payloads[0].store.Old.selectable, false, 'legacy cached access is never trusted');
      assert.equal(native.Old.selectable, true, 'the input cache is not mutated');

      const K = w.sandbox.FCM;
      let subscribed = true;
      K.getJson = async url => url.endsWith('/me') ? { is_subscribed: subscribed } : [{ id: 1, slug: 'host', emotes: [
        { id: 11, name: 'Paid', subscribers_only: true }, { id: 12, name: 'Free' },
      ] }];
      assert.equal((await K.kickApi.emotes('host', { headers: { Authorization: 'Bearer fixture' } })).Paid.selectable, true);
      subscribed = false;
      assert.equal((await K.kickApi.emotes('host', { headers: { Authorization: 'Bearer fixture' } })).Paid.selectable, false);
      assert.equal((await K.kickApi.emotes('host')).Paid.selectable, false);

      K.loadSettings = async () => ({ ...K.DEFAULT_SETTINGS, twitchClientId: 'fixture', showHistory: false, thirdPartyEmotes: false });
      let account = { clientId: 'fixture', userId: 'viewer', accessToken: 'fixture' };
      K.auth.get = async () => account;
      let fresh = { Paid: { url: 'paid', selectable: true }, Kept: { url: 'kept', selectable: true } };
      K.emoteLoader.twitchNative = async () => fresh;
      await vm.runInContext("loadTwitchEmotes(testSession, 'twitch')", w.sandbox);
      fresh = { Kept: { url: 'kept', selectable: true } };
      await vm.runInContext("loadTwitchEmotes(testSession, 'twitch')", w.sandbox);
      for (let i = 0; i < 30; i++) await Promise.resolve();
      assert.deepEqual(Object.keys(await K.emoteCache.read('twitch', 'host', 'viewer')).sort(), ['native']);
      assert.deepEqual(Object.keys((await K.emoteCache.read('twitch', 'host', 'viewer')).native), ['Kept'], 'smaller fresh list replaces cache');
      assert.equal(payloads.filter(msg => msg.type === 'emotes').at(-1).replace, true);
      const realWrite = K.emoteCache.write;
      K.emoteCache.write = async () => { throw Error('fixture cache quota'); };
      account = null;
      await vm.runInContext("loadTwitchEmotes(testSession, 'twitch')", w.sandbox);
      K.emoteCache.write = realWrite;
      await vm.runInContext(`(async () => {
        const original = FCM.loadSettings;
        FCM.loadSettings = async () => { throw Error('fixture settings read'); };
        makeSink(testSession, 'twitch').emoteSets(['error']);
        await testSession.conns.twitch.emoteChain.catch(() => {});
        await Promise.resolve();
        FCM.loadSettings = original;
      })()`, w.sandbox);
      await vm.runInContext("onJoined(testSession, 'twitch', 0)", w.sandbox);
      for (let i = 0; i < 30; i++) await Promise.resolve();
      assert.ok(payloads.some(msg => msg.replace && !Object.keys(msg.store).length), 'joining first revokes old access');
      vm.runInContext("leaveChannel(testSession, 'twitch', { silent: true })", w.sandbox);
      assert.equal(w.sandbox.testSession.conns.twitch.nativeEmotesFresh, false);
      assert.deepEqual(plain(w.sandbox.testSession.conns.twitch.emoteSets), []);
      const frames = [];
      const connection = {};
      K.twitchSource.connect('host', { emoteSets: ids => frames.push(plain(ids)), moderator() {}, subscription() {}, status() {}, sys() {} }, connection, null);
      connection.ws.push('@emote-sets=one,two :fixture USERSTATE #host');
      connection.ws.push('@emote-sets= :fixture USERSTATE #host');
      connection.ws.push('@display-name=Viewer :fixture USERSTATE #host');
      assert.deepEqual(frames, [['one', 'two'], []], 'empty IRC tags revoke sets; absent tags do not');
    } finally { w.teardown(); }
  }
  console.log('Issue #77 emote availability regressions passed.');
}

module.exports = { run, fixture };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
