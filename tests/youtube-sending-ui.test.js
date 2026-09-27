// Full actual overlay source, driven through DOM events and its public API.
// Native and background transports are fixtures; no real message is sent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const READY = { available: true, reason: 'ready', accountLabel: '@Viewer', sourceId: 'video:run:1', capability: 1, maxLength: 200 };

function fixture(options = {}) {
  const nodes = new Map(), storage = options.storage || {}, writes = [], commands = [], messages = [], nativeSends = [], youtubeSends = [], accessSetups = [], accessCloses = [];
  const elements = [], popups = [], nativeCardQueries = [], nativeVisibility = [];
  const listeners = new Map();
  let youtubeHooks, composeHooks, api;
  function element(tag = 'div') {
    const classes = new Set(), events = new Map();
    const node = { tagName: tag.toUpperCase(), children: [], dataset: {}, value: '', textContent: '', isConnected: true, events,
      style: { setProperty() {}, removeProperty() {} },
      appendChild(child) {
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(other => other !== child);
        child.parentNode = this; child.parentElement = this; child.isConnected = true; this.children.push(child); return child;
      },
      insertBefore(child) { return this.appendChild(child); },
      replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); },
      remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); },
      setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; },
      addEventListener(type, fn) { const entries = events.get(type) || []; entries.push(fn); events.set(type, entries); },
      removeEventListener() {}, focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 360, bottom: 600, width: 360, height: 600 }),
      attachShadow() { return element(); },
      querySelector(selector) {
        if (!nodes.has(selector)) {
          const child = element(); child.parentNode = this;
          if (selector === '.fcm-actions [data-act="popout"]') child.dataset.act = 'popout';
          nodes.set(selector, child);
        }
        return nodes.get(selector);
      },
      querySelectorAll(selector) {
        if (selector === '.fcm-target') return this.children.filter(child => child.className === 'fcm-target');
        if (selector === '.fcm-actions [data-act]') return [this.querySelector('.fcm-actions [data-act="popout"]')];
        return [];
      },
      async fire(type, extra = {}) {
        const event = { isTrusted: true, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
        await Promise.all((events.get(type) || []).map(fn => fn(event))); await flush();
      },
    };
    node.classList = { add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)),
      contains: value => classes.has(value), toggle(value, state) { if (state) classes.add(value); else classes.delete(value); } };
    Object.defineProperty(node, 'className', { get: () => [...classes].join(' '), set(value) { classes.clear(); value.split(/\s+/).forEach(v => classes.add(v)); } });
    elements.push(node);
    return node;
  }
  function eventTarget() {
    const events = new Map();
    return {
      addEventListener(type, fn, options = {}) {
        const entries = events.get(type) || []; entries.push({ fn, once: !!options.once }); events.set(type, entries);
      },
      removeEventListener(type, fn) { events.set(type, (events.get(type) || []).filter(entry => entry.fn !== fn)); },
      fire(type) {
        for (const entry of [...(events.get(type) || [])]) {
          if (entry.once) this.removeEventListener(type, entry.fn);
          entry.fn({ type });
        }
      },
    };
  }
  const document = { createElement: element, documentElement: element('html'), body: options.noBody ? null : element('body'), activeElement: null,
    removeEventListener() {}, addEventListener(type, fn) { listeners.set(type, fn); }, querySelector: () => null };
  const window = { ...eventTarget(), innerWidth: 1280, innerHeight: 720,
    open() {
      const popup = { ...eventTarget(), document: { body: element('body') }, closed: false,
        close() { if (!this.closed) { this.closed = true; this.fire('pagehide'); } },
      };
      popups.push(popup); return popup;
    },
  };
  const chrome = { runtime: { getURL: p => p, getManifest: () => ({ version: '1.23.0' }), sendMessage() {} }, storage: {
    local: { get: async () => storage, set: async patch => { writes.push(patch); Object.assign(storage, patch); } },
    sync: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} },
  } };
  const sandbox = vm.createContext({ document, chrome, console, URL, setTimeout: () => 1, clearTimeout() {}, clearInterval() {},
    setInterval: () => 1, fetch: async () => ({ text: async () => '' }), window });
  sandbox.self = sandbox;
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/util.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: path.join(ROOT, file) });
  }
  const FCM = sandbox.FCM;
  FCM.BROWSER = options.browser || 'chrome';
  const feed = { onCount() {}, onPinChange() {}, addSys: text => messages.push(text), clearPlaceholder() {}, setPlaceholder() {},
    dropPlatform() {}, applyFilter() {}, destroy() {}, scrollToBottom() {}, trim() {}, resettle() {} };
  Object.assign(FCM, {
    createNativeBridge: () => ({ release() {},
      cards(includeHighlights) { nativeCardQueries.push(includeHighlights); return options.nativeCards || null; },
      setNativeHidden(hide, exemptions) { nativeVisibility.push({ hide, exemptions }); },
      dialogOver() {}, coveringChat() {}, stats: () => ({}) }),
    createNativeEventWatcher: () => ({ start() {}, stop() {} }), createFeed: () => feed,
    createDisplayFont: () => ({ destroy() {}, refresh: async () => {}, size: n => n }), makeEmoteInput() {},
    emoteOnlyPlatform: () => options.emoteHome || null, findCheer: () => options.cheer || null, toKickMessage: text => text,
    loadSettings: async () => ({ ...FCM.DEFAULT_SETTINGS, theme: 'dark', revealHighlights: false, showNativeStats: false, autoClaimBonus: false, showShareReminders: false, autoOpen: false }),
    setViewSettings() {}, watchSiteTheme: () => ({ current: () => 'dark', stop() {} }),
    createCompose: hooks => { composeHooks = hooks; return { closeAll() {}, handleKey: () => !!options.autocomplete }; },
    view: { emotes: { kick: { native: {} } } },
    sendViaNativeComposer: async (site, text) => { nativeSends.push(text); return options.nativeResult || { ok: true }; },
    resetPlatformView() {},
    gifButtonState: () => ({ visible: false }),
    attachYouTubeControls: options.noYouTube ? undefined : hooks => {
      youtubeHooks = hooks;
      if (options.synchronousState) hooks.onSendState(READY);
      return { send: async text => { youtubeSends.push(text); if (options.send) return options.send(text); return options.result || { outcome: 'submitted' }; },
        openAccessSetup() { accessSetups.push(true); return options.accessSetup !== false; },
        closeAccessSetup() { accessCloses.push(true); },
        destroy() {}, updateCounterpart() {}, openLinks() {} };
    },
  });
  const file = path.join(ROOT, 'src/content/overlay.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const site = { id: options.platform || 'twitch', channelFromUrl: () => 'example',
    chatContainer: () => options.chatRect ? { getBoundingClientRect: () => options.chatRect } : null };
  api = FCM.createOverlay({ site, channel: 'example', onCommand(command) {
    commands.push(command);
    if (command.cmd === 'send') queueMicrotask(() => api.sendResult(command.id,
      options.apiMissing ? {} : Object.fromEntries(command.targets.map(platform => [platform, options.apiResult || { ok: true }]))));
  } });
  api.setStatus('twitch', 'connected', 'example');
  api.setStatus('kick', 'connected', 'counterpart');
  api.setAccounts({ twitch: { connected: true, login: 'TwitchViewer' }, kick: { connected: true, login: 'KickViewer' } });
  const target = platform => nodes.get('.fcm-targets').children.find(child => child.dataset.platform === platform);
  return { api, FCM, options, nodes, storage, writes, commands, messages, nativeSends, youtubeSends, accessSetups, accessCloses, target,
    document, window, popups, element, nativeCardQueries, nativeVisibility, host: elements.find(node => node.id === 'friendly-chat-merge-host'),
    popout: () => nodes.get('.fcm-actions [data-act="popout"]').fire('click'),
    input: nodes.get('.fcm-input'), button: nodes.get('.fcm-send'), state: value => youtubeHooks.onSendState(value),
    select: platform => target(platform).fire('click'), ready: () => youtubeHooks.onSendState(READY),
    reply: (platform, name = 'OtherViewer', id = '') => composeHooks.onReplyTo(platform, name, id),
    send: async (text = 'hello', event = {}) => { nodes.get('.fcm-input').value = text; await nodes.get('.fcm-send').fire('click', event); },
  };
}

async function historyChecks() {
  const arrow = async (f, key = 'ArrowUp', modifiers = {}) => {
    let prevented = false;
    await f.input.fire('keydown', { key, preventDefault() { prevented = true; }, ...modifiers });
    return prevented;
  };
  for (const browser of ['chrome', 'firefox']) for (const platform of ['twitch', 'kick']) {
    const h = fixture({ browser, platform }); await h.api.mount();
    assert.equal(await arrow(h), false, 'empty history leaves arrows alone');
    await h.send('first'); await h.send('second'); await h.send('second');
    h.input.value = 'unfinished draft';
    const sentCount = h.commands.filter(c => c.cmd === 'send').length;
    const writes = h.writes.length;
    assert.equal(await arrow(h, 'ArrowDown'), false, 'Down outside history leaves the draft alone');
    assert.equal(await arrow(h), true); assert.equal(h.input.value, 'second');
    assert.equal(h.input.selectionStart, 6); assert.equal(h.input.selectionEnd, 6);
    await arrow(h); assert.equal(h.input.value, 'first', 'combined sends and consecutive repeats occupy one entry');
    await arrow(h); assert.equal(h.input.value, 'first', 'oldest entry does not wrap');
    await arrow(h, 'ArrowDown'); assert.equal(h.input.value, 'second');
    await arrow(h, 'ArrowDown'); assert.equal(h.input.value, 'unfinished draft');
    assert.equal(await arrow(h, 'ArrowDown'), false);
    assert.equal(h.commands.filter(c => c.cmd === 'send').length, sentCount, 'recall never sends');
    assert.equal(h.writes.length, writes, 'history is never persisted');
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing']) {
      assert.equal(await arrow(h, 'ArrowUp', { [modifier]: true }), false);
      assert.equal(h.input.value, 'unfinished draft');
    }
    assert.equal(await arrow(h, 'ArrowLeft'), false);
    h.options.autocomplete = true;
    await arrow(h); assert.equal(h.input.value, 'unfinished draft', 'autocomplete has priority');
    h.options.autocomplete = false;
    h.reply('kick'); h.input.value = '@OtherViewer active reply';
    assert.equal(await arrow(h), false, 'history cannot overwrite an active reply');
    await h.input.fire('keydown', { key: 'Escape' });
    await arrow(h); assert.equal(h.input.value, 'second');
    h.input.value = 'edited recall'; await h.input.fire('input');
    assert.equal(await arrow(h, 'ArrowDown'), false, 'typing leaves history browsing');
    await arrow(h); await arrow(h, 'ArrowDown'); assert.equal(h.input.value, 'edited recall');
    await arrow(h); h.input.value = 'picker insertion';
    await arrow(h); assert.equal(h.input.value, 'second');
    await arrow(h, 'ArrowDown'); assert.equal(h.input.value, 'picker insertion', 'programmatic edits become the draft too');
    await h.popout(); await arrow(h); assert.equal(h.input.value, 'second');
    await h.popout(); await arrow(h); assert.equal(h.input.value, 'first', 'history survives popup return');
    await h.select('twitch');
    await h.input.fire('keydown', { key: 'Enter' });
    assert.equal(h.commands.filter(c => c.cmd === 'send').at(-1).text, 'first');
    assert.deepEqual(Array.from(h.commands.at(-1).targets), ['kick'], 'explicit resend uses current targets');
    assert.deepEqual(Object.keys(h.commands.at(-1).replies), [], 'recall does not restore reply routing');
    await arrow(h); assert.equal(h.input.value, 'first');
    h.api.destroy(); h.input.value = 'closed';
    assert.equal(await arrow(h), false); assert.equal(h.input.value, 'closed');
    const fresh = fixture({ browser, platform });
    assert.equal(await arrow(fresh), false, 'new channel/tab overlay has no old history');
  }
  const bounded = fixture();
  for (let i = 0; i < 52; i++) await bounded.send('message ' + i);
  for (let i = 51; i >= 2; i--) { await arrow(bounded); assert.equal(bounded.input.value, 'message ' + i); }
  await arrow(bounded); assert.equal(bounded.input.value, 'message 2', 'only the latest 50 entries remain');
  for (let i = 0; i < 50; i++) await arrow(bounded, 'ArrowDown');
  assert.equal(bounded.input.value, '', 'empty draft restores after walking the whole history');
  const historyReply = fixture(); await historyReply.api.mount(); historyReply.reply('twitch', 'Viewer', 'parent');
  await historyReply.send('@Viewer reply'); await arrow(historyReply);
  assert.equal(historyReply.input.value, '@Viewer reply', 'recall keeps the original visible mention');
  await historyReply.input.fire('keydown', { key: 'Enter' });
  assert.deepEqual(Object.keys(historyReply.commands.at(-1).replies), [], 'old thread IDs are never replayed');
  assert.deepEqual(Array.from(historyReply.commands.at(-1).targets), ['twitch', 'kick']);
  for (const options of [
    { apiResult: { ok: false, reason: 'rejected' } },
    { cheer: { total: 100 } },
    { cheer: { total: 100 }, nativeResult: { ok: false, reason: 'cheer-unconfirmed' } },
    { nativeResult: { ok: false, reason: 'cheer-unconfirmed' } },
    { result: { outcome: 'uncertain' } },
    { send: async () => { throw Error('uncertain'); } },
  ]) {
    const excluded = fixture(options);
    if (options.result || options.send) { excluded.ready(); await excluded.select('youtube'); }
    if (options.nativeResult) excluded.api.setAccounts({ twitch: { connected: false }, kick: { connected: true } });
    await excluded.send('excluded'); excluded.input.value = 'draft';
    assert.equal(await arrow(excluded), false, 'failed, uncertain and paid sends are not added');
    assert.equal(excluded.input.value, 'draft');
  }
  const nativeHistory = fixture(); await nativeHistory.select('kick');
  nativeHistory.api.setAccounts({ twitch: { connected: false }, kick: { connected: false } });
  await nativeHistory.send('native accepted'); await arrow(nativeHistory); assert.equal(nativeHistory.input.value, 'native accepted');
  const partial = fixture({ result: { outcome: 'not-sent' } }); partial.ready(); await partial.select('youtube');
  await partial.send('accepted by Twitch and Kick'); await arrow(partial); assert.equal(partial.input.value, 'accepted by Twitch and Kick');
  const ytOnly = fixture(); ytOnly.ready(); await ytOnly.select('youtube'); await ytOnly.select('twitch'); await ytOnly.select('kick');
  await ytOnly.send('YouTube only'); await arrow(ytOnly); assert.equal(ytOnly.input.value, 'YouTube only');
  let finishHistorySend;
  const pending = fixture({ send: () => new Promise(resolve => { finishHistorySend = resolve; }) });
  await pending.send('earlier'); pending.ready(); await pending.select('youtube');
  const waiting = pending.send('pending'); await flush(); pending.input.value = 'next draft';
  assert.equal(await arrow(pending), false, 'pending sends do not allow history navigation');
  finishHistorySend({ outcome: 'submitted' }); await waiting;
  assert.equal(pending.input.value, 'next draft', 'completion never overwrites the next draft');
  await arrow(pending); assert.equal(pending.input.value, 'pending');
  await arrow(pending, 'ArrowDown'); assert.equal(pending.input.value, 'next draft');
}

async function run() {
  await historyChecks();
  const noticeElement = { isConnected: true, getBoundingClientRect: () => ({ top: 70, bottom: 122, height: 52 }) };
  const notice = fixture({ nativeCards: { elements: [noticeElement], top: 70, bottom: 122, left: 0, right: 360, height: 52 } });
  await notice.api.mount();
  assert.ok(notice.nativeCardQueries.includes(false), 'highlights-off still queries native notifications');
  assert.ok(notice.nativeVisibility.some(call => call.exemptions.includes(noticeElement)), 'notifications remain exempt from native chat hiding');
  for (const manual of [false, true]) for (const noticeBottom of [0, 122, 300]) {
    const rect = { top: 60, left: 0, width: 360, height: 180 };
    const bottom = noticeBottom || 122;
    const element = { isConnected: true, getBoundingClientRect: () => ({ top: 70, bottom, height: bottom - 70 }) };
    const short = fixture({ chatRect: rect,
      storage: { fcm_geometry_v1: { twitch: { manual, ...rect } } },
      nativeCards: { elements: [element], top: 70, bottom, left: 0, right: 360, noticeBottom } });
    await short.api.mount();
    assert.equal(short.nodes.get('.fcm-panel').style.top, `${noticeBottom || 60}px`, 'notifications outrank the panel floor; optional highlights retain it');
    assert.equal(short.nodes.get('.fcm-panel').style.height, `${Math.max(0, 240 - (noticeBottom || 60))}px`);
    short.options.nativeCards = null;
    short.api.applyStoredSettings({ ...short.FCM.DEFAULT_SETTINGS, revealHighlights: false });
    assert.equal(short.nodes.get('.fcm-panel').style.top, '60px', 'removing a notice restores saved placement');
    assert.equal(short.nodes.get('.fcm-panel').style.height, '180px', 'temporary clearance never overwrites saved height');
  }
  const css = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
  const selectedStyle = css.match(/\.fcm-target\[data-platform="youtube"\]\[data-on="true"\]\s*\{([^}]+)\}/)?.[1];
  assert.ok(selectedStyle, 'selected YouTube sending has its own platform highlight');
  for (const [property, token] of [['color', 'text'], ['background', 'dim'], ['border-color', 'border']]) {
    assert.ok(selectedStyle.includes(`${property}: var(--youtube-${token})`), `YouTube selection styles ${property}`);
    for (const theme of [/\.fcm-root\s*\{([^}]+)\}/, /\.fcm-root\[data-theme="light"\]\s*\{([^}]+)\}/]) {
      assert.ok(css.match(theme)[1].includes(`--youtube-${token}:`), `both themes define the YouTube ${token} color`);
    }
  }
  for (const browser of ['chrome', 'firefox']) {
    for (const platform of ['twitch', 'kick']) {
      for (const noBody of [false, true]) {
        const mounted = fixture({ browser, platform, noBody });
        await mounted.api.mount();
        const pageParent = () => browser === 'firefox' && mounted.document.body
          ? mounted.document.body : mounted.document.documentElement;
        assert.equal(mounted.host.parentNode, pageParent(), `${browser}/${platform}/${noBody}: mount uses the browser's editable page parent`);
        mounted.input.value = 'preserved draft';
        await mounted.popout();
        assert.equal(mounted.host.parentNode, mounted.popups[0].document.body, 'the actual host moves into the popup body');
        await mounted.popout();
        assert.equal(mounted.host.parentNode, pageParent(), 'the dock button restores the editable page parent');
        assert.equal(mounted.popups[0].closed, true);
        assert.equal(mounted.input.value, 'preserved draft');
        await mounted.popout();
        mounted.popups[1].close();
        assert.equal(mounted.host.parentNode, pageParent(), 'closing a popup restores the editable page parent');
        await mounted.popout();
        mounted.document.body = mounted.element('body');
        mounted.window.fire('pagehide');
        assert.equal(mounted.host.parentNode, pageParent(), 'returning resolves the current body, including a body created after mount');
        assert.equal(mounted.popups[2].closed, true);
        assert.equal(mounted.input.value, 'preserved draft');
        await mounted.popout();
        pageParent().appendChild(mounted.host);
        mounted.popups[3].close();
        assert.equal(mounted.host.parentNode, pageParent(), 'returning is safe when the host is already docked');
        assert.equal(pageParent().children.filter(child => child === mounted.host).length, 1);
        await mounted.popout();
        const lastPopup = mounted.popups[4];
        mounted.api.destroy();
        lastPopup.fire('pagehide');
        assert.equal(lastPopup.closed, true);
        assert.equal(mounted.host.isConnected, false, 'a popup closing during teardown never resurrects its overlay');
        assert.equal(mounted.document.documentElement.children.includes(mounted.host), false);
        assert.equal(mounted.document.body.children.includes(mounted.host), false);
      }
    }
  }
  const f = fixture();
  assert.equal(f.target('youtube').disabled, true);
  f.ready();
  assert.equal(f.target('youtube').dataset.on, 'false', 'a connected YouTube account never selects itself');
  assert.equal(f.target('youtube').children[1].textContent, 'as @Viewer');
  await f.target('youtube').fire('click', { isTrusted: false });
  assert.equal(f.target('youtube').dataset.on, 'false');
  await f.select('youtube');
  assert.equal(f.target('youtube').dataset.on, 'true');
  await f.send('hello', { isTrusted: false });
  assert.equal(f.youtubeSends.length, 0); assert.equal(f.commands.length, 0);
  await f.send('hello');
  assert.deepEqual(f.youtubeSends, ['hello']);
  assert.deepEqual(Array.from(f.commands.at(-1).targets), ['twitch', 'kick']);
  assert.equal(f.input.value, '');
  assert.equal(f.messages.length, 0, 'successful mixed sends do not add a system status row');
  assert.deepEqual(f.writes, [], 'YouTube selection never persists');
  await f.select('youtube');
  assert.equal(f.target('youtube').dataset.on, 'false');
  const noYouTube = fixture({ noYouTube: true });
  assert.equal(noYouTube.target('youtube'), undefined);
  const synchronous = fixture({ synchronousState: true });
  assert.equal(synchronous.target('youtube').disabled, false, 'an initial state emitted during construction is safe');
  assert.equal(synchronous.target('youtube').dataset.on, 'false');
  for (const browser of ['chrome', 'firefox']) {
    const access = fixture({ browser });
    access.input.value = 'keep this draft';
    for (const value of ['unknown', 'needed', 'granted', 'denied', 'unsupported', 'error', 'requesting', 'reloading', 'failed', '']) {
      access.state({ ...READY, available: false, reason: 'signed-out', accountLabel: '', access: value });
      const canSetup = browser === 'firefox' && ['needed', 'denied', 'error'].includes(value);
      const canCancel = browser === 'firefox' && ['requesting', 'reloading'].includes(value);
      assert.equal(access.target('youtube').disabled, !(canSetup || canCancel), `${browser}/${value} exposes setup actions only when appropriate`);
      assert.equal(access.target('youtube').children[1].textContent, canCancel ? 'cancel setup' : canSetup ? 'enable sending' : 'sign in on YouTube');
      if (browser === 'firefox' && value) assert.match(access.target('youtube').title, value === 'failed' ? /Remove and add YouTube chat/ : /Firefox/);
      const before = access.accessSetups.length;
      const beforeClose = access.accessCloses.length;
      await access.target('youtube').fire('click', { isTrusted: false });
      assert.equal(access.accessSetups.length, before, 'synthetic clicks cannot open access setup');
      assert.equal(access.accessCloses.length, beforeClose, 'synthetic clicks cannot cancel access setup');
      await access.select('youtube');
      assert.equal(access.accessSetups.length, before + Number(canSetup));
      assert.equal(access.accessCloses.length, beforeClose + Number(canCancel));
      assert.equal(access.target('youtube').dataset.on, 'false', 'opening access setup never selects a destination');
      assert.equal(access.input.value, 'keep this draft');
      assert.deepEqual(access.youtubeSends, []);
      assert.deepEqual(access.commands, []);
      assert.deepEqual(access.writes, []);
    }
    access.state({ ...READY, access: 'needed' });
    const setups = access.accessSetups.length;
    await access.select('youtube');
    assert.equal(access.target('youtube').dataset.on, 'true', 'an already available native composer retains normal explicit selection');
    assert.equal(access.accessSetups.length, setups);
    access.state({ ...READY, available: false, reason: 'composer-unavailable', access: 'needed' });
    assert.equal(access.target('youtube').dataset.on, 'false', 'setup readiness cannot retain an earlier sending choice');
    const oldSetup = access.target('youtube');
    access.api.destroy(); await oldSetup.fire('click');
    assert.equal(access.accessSetups.length, setups, 'a destroyed setup button cannot open a frame');
  }
  const failedSetup = fixture({ browser: 'firefox', accessSetup: false });
  failedSetup.state({ ...READY, available: false, access: 'needed' });
  await failedSetup.select('youtube');
  assert.match(failedSetup.nodes.get('.fcm-toast').textContent, /could not open.*try again/i);
  assert.equal(failedSetup.target('youtube').dataset.on, 'false');
  const setupReply = fixture({ browser: 'firefox' }); await setupReply.api.mount();
  setupReply.reply('twitch');
  setupReply.state({ ...READY, available: false, access: 'requesting' });
  setupReply.input.value = 'keep reply draft';
  const oldCancel = setupReply.target('youtube');
  await setupReply.select('youtube');
  assert.equal(setupReply.nodes.get('.fcm-targets').dataset.locked, 'true', 'cancelling setup does not cancel a platform-scoped reply');
  assert.equal(setupReply.input.value, 'keep reply draft');
  setupReply.state({ ...READY, available: false, access: 'granted', reason: 'busy' });
  await oldCancel.fire('click');
  assert.equal(setupReply.accessCloses.length, 1, 'stale setup controls cannot cancel a busy native send');
  setupReply.state({ ...READY, access: 'requesting' });
  await setupReply.select('youtube');
  assert.equal(setupReply.accessCloses.length, 1, 'an available composer retains the normal target/reply action');
  setupReply.state({ ...READY, available: false, access: 'reloading' });
  const destroyedCancel = setupReply.target('youtube');
  setupReply.api.destroy(); await destroyedCancel.fire('click');
  assert.equal(setupReply.accessCloses.length, 1);
  const states = fixture();
  states.state({ ...READY, available: false, reason: 'signed-out', accountLabel: '' });
  assert.match(states.target('youtube').children[1].textContent, /sign in/);
  await states.select('youtube');
  assert.equal(states.target('youtube').dataset.on, 'false');
  states.ready(); await states.select('youtube');
  states.state({ ...READY, available: false, reason: 'busy' });
  assert.equal(states.target('youtube').dataset.on, 'true', 'a busy interval keeps the same authorized account selected');
  assert.equal(states.target('youtube').disabled, true);
  await states.send(); assert.equal(states.youtubeSends.length, 0);
  states.ready(); assert.equal(states.target('youtube').dataset.on, 'true');
  for (const replacement of [{ ...READY, sourceId: 'other:run:1' }, { ...READY, accountLabel: '@Other' },
    { ...READY, available: false, reason: 'restricted' }]) {
    states.state(replacement);
    assert.equal(states.target('youtube').dataset.on, 'false', 'reader/account/capability changes revoke selection');
    states.ready(); await states.select('youtube');
  }
  states.state({ ...READY, accountLabel: '' });
  assert.equal(states.target('youtube').children[1].textContent, 'unavailable');
  await states.select('youtube');
  assert.match(states.nodes.get('.fcm-sendnote').title, /signed-in YouTube account/);
  const staleButton = states.target('youtube');
  states.api.destroy(); states.state(READY); await staleButton.fire('click');
  await states.send(); assert.equal(states.youtubeSends.length, 0);

  const length = fixture(); length.ready(); await length.select('youtube');
  for (const text of ['x'.repeat(201), 'text\u0000suffix', 'text\u0085suffix']) {
    await length.send(text);
    assert.equal(length.youtubeSends.length, 0); assert.equal(length.commands.length, 0);
    assert.equal(length.input.value, text, 'invalid mixed sends preserve the original draft without sending elsewhere');
  }
  length.input.value = 'hello'; await length.button.events.get('click')[0]();
  assert.equal(length.youtubeSends.length, 0, 'a missing event cannot authorize YouTube');
  await length.send('x'.repeat(200)); assert.equal(length.youtubeSends[0].length, 200);
  length.input.value = ''; await length.button.fire('click');
  assert.equal(length.youtubeSends.length, 1);
  length.button.disabled = true; await length.send('second');
  assert.equal(length.youtubeSends.length, 1, 'in-flight Send is not submitted twice');

  const only = fixture(); only.ready(); await only.select('youtube');
  await only.select('twitch'); await only.select('kick');
  assert.deepEqual(only.writes.map(patch => Array.from(Object.values(patch)[0]['twitch:example'])), [['kick']]);
  await only.select('youtube'); assert.equal(only.target('youtube').dataset.on, 'true', 'cannot disable the only target');
  assert.match(only.nodes.get('.fcm-sendnote').textContent, /sending to YouTube$/);
  await only.send('youtube only');
  assert.deepEqual(only.youtubeSends, ['youtube only']); assert.equal(only.commands.length, 0);
  assert.equal(only.messages.length, 0, 'successful YouTube-only sends do not add a system status row');
  only.state({ available: false, reason: 'composer-unavailable', accountLabel: '', sourceId: '' });
  await only.send('do not reroute');
  assert.equal(only.commands.length, 0); assert.equal(only.input.value, 'do not reroute');

  const narrowed = fixture({ emoteHome: 'twitch' }); narrowed.ready(); await narrowed.select('youtube');
  await narrowed.send('Kappa');
  assert.equal(narrowed.youtubeSends.length, 0);
  assert.deepEqual(Array.from(narrowed.commands[0].targets), ['twitch']);
  const native = fixture(); native.ready(); await native.select('youtube');
  native.api.setAccounts({ twitch: { connected: false }, kick: { connected: false } });
  await native.send('mixed native');
  assert.deepEqual(native.nativeSends, ['mixed native']); assert.deepEqual(native.youtubeSends, ['mixed native']);

  for (const [outcome, restore] of [['submitted', false], ['not-sent', true], ['uncertain', false]]) {
    const result = fixture({ result: { outcome }, apiResult: { ok: false, reason: 'network' } });
    result.ready(); await result.select('youtube'); await result.send('original');
    assert.equal(result.input.value, restore ? 'original' : '', `${outcome} restoration follows confirmed handoff state`);
    assert.equal(result.youtubeSends.length, 1, 'no automatic retry');
    if (outcome === 'uncertain') assert.ok(result.messages.some(text => /could not be confirmed/.test(text)));
  }
  const notSent = fixture({ result: { outcome: 'not-sent' } });
  notSent.ready(); await notSent.select('youtube'); await notSent.select('twitch'); await notSent.select('kick');
  await notSent.send(); assert.match(notSent.nodes.get('.fcm-toast').textContent, /YouTube did not submit/);
  const uncertain = fixture({ send: async () => { throw Error('transport closed'); } });
  uncertain.ready(); await uncertain.select('youtube'); await uncertain.select('twitch'); await uncertain.select('kick');
  await uncertain.send(); assert.equal(uncertain.input.value, '');
  assert.match(uncertain.nodes.get('.fcm-toast').textContent, /could not be confirmed/);
  const malformed = fixture({ send: async () => null });
  malformed.ready(); await malformed.select('youtube'); await malformed.send();
  assert.ok(malformed.messages.some(text => /could not be confirmed/.test(text)));

  let finish;
  const pending = fixture({ send: () => new Promise(resolve => { finish = resolve; }) });
  pending.ready(); await pending.select('youtube');
  const submitted = pending.send('first'); await flush();
  pending.input.value = 'new draft'; finish({ outcome: 'not-sent' }); await submitted;
  assert.equal(pending.input.value, 'new draft', 'a result never overwrites a newer draft');
  const changed = fixture(); changed.ready(); await changed.select('youtube');
  const dispatched = changed.send('old account'); changed.state({ ...READY, sourceId: 'new:run:1' });
  await dispatched; assert.equal(changed.youtubeSends.length, 0, 'a source switch before dispatch cannot send as the new account');
  const unavailable = fixture(); unavailable.ready(); await unavailable.select('youtube');
  const unavailableSend = unavailable.send(); unavailable.state({ ...READY, available: false, reason: 'busy' });
  await unavailableSend; assert.equal(unavailable.youtubeSends.length, 0);
  const replies = fixture(); await replies.api.mount(); replies.ready(); await replies.select('youtube');
  replies.reply('twitch'); await replies.send('reply only');
  assert.equal(replies.youtubeSends.length, 0, 'a reply never inherits the YouTube selection');
  assert.deepEqual(Array.from(replies.commands.at(-1).targets), ['twitch']);
  replies.reply('kick'); await replies.select('youtube');
  assert.match(replies.nodes.get('.fcm-toast').textContent, /Reply cancelled/);
  await replies.input.fire('keydown', { key: 'Enter', shiftKey: true });
  replies.input.value = 'typed'; await replies.input.fire('keydown', { key: 'Enter' });
  assert.deepEqual(replies.youtubeSends, ['typed']);
  for (const reject of [false, true]) {
    let resolveLate, rejectLate;
    const closing = fixture({ send: () => new Promise((resolve, fail) => { resolveLate = resolve; rejectLate = fail; }) });
    closing.ready(); await closing.select('youtube');
    const result = closing.send('leaving'); await flush();
    const before = closing.messages.length;
    closing.api.destroy();
    if (reject) rejectLate(Error('gone')); else resolveLate({ outcome: 'uncertain' });
    await result;
    assert.equal(closing.messages.length, before, 'late send results cannot repopulate a destroyed feed');
    assert.equal(closing.input.value, '', 'teardown cannot restore an uncertain draft');
  }
  // Older send paths share the dispatcher with YouTube and remain unchanged.
  const lastBinary = fixture(); await lastBinary.select('twitch'); await lastBinary.select('kick');
  assert.equal(lastBinary.target('kick').dataset.on, 'true');
  const blocked = fixture(); await blocked.select('twitch');
  blocked.api.setAccounts({ twitch: { connected: false }, kick: { connected: false } });
  await blocked.send(); assert.match(blocked.nodes.get('.fcm-toast').textContent, /Connect a Kick account/);
  blocked.api.setStatus('kick', 'idle', ''); await blocked.send();
  assert.match(blocked.nodes.get('.fcm-toast').textContent, /No connected chat/);
  const blockedReply = fixture(); await blockedReply.api.mount();
  blockedReply.api.setAccounts({ twitch: { connected: false }, kick: { connected: false } });
  blockedReply.reply('kick'); await blockedReply.send();
  assert.match(blockedReply.nodes.get('.fcm-toast').textContent, /reply on Kick/);
  blockedReply.api.setStatus('kick', 'idle', ''); await blockedReply.send();
  assert.match(blockedReply.nodes.get('.fcm-toast').textContent, /reply cannot be sent/);
  const threaded = fixture(); await threaded.api.mount(); threaded.reply('twitch', 'OtherViewer', 'parent-id');
  await threaded.send('@OtherViewer hello');
  assert.equal(threaded.commands.at(-1).text, 'hello');
  assert.equal(threaded.commands.at(-1).replies.twitch, 'parent-id');
  for (const platform of ['twitch', 'kick']) {
    const cheer = fixture({ platform, cheer: { total: 100 } });
    await cheer.send('Cheer100 hello');
    assert.equal(cheer.nativeSends.length, platform === 'twitch' ? 1 : 0);
    if (platform === 'kick') assert.match(cheer.nodes.get('.fcm-toast').textContent, /only be sent from a Twitch page/);
  }
  for (const reason of ['cheer-unconfirmed', 'unrecognized', 'rejected']) {
    const failed = fixture({ cheer: { total: 100 }, nativeResult: { ok: false, reason } });
    await failed.select('kick'); await failed.send('Cheer100');
    assert.equal(failed.input.value, reason === 'cheer-unconfirmed' ? '' : 'Cheer100');
    if (reason === 'unrecognized') assert.match(failed.nodes.get('.fcm-toast').textContent, /Could not send to Twitch/);
  }
  const cheerKick = fixture({ platform: 'kick', cheer: { total: 100 } });
  await cheerKick.select('twitch');
  cheerKick.api.setAccounts({ twitch: { connected: false }, kick: { connected: false } });
  await cheerKick.send('Cheer100');
  assert.deepEqual(cheerKick.nativeSends, ['Cheer100'], 'a Kick-only choice is not accidentally sent to Twitch');
  const missing = fixture({ apiMissing: true }); await missing.send();
  assert.equal(missing.input.value, 'hello');
  const detailed = fixture({ apiResult: { ok: false, reason: 'expired', detail: 'Reconnect this account' } });
  await detailed.send(); assert.ok(detailed.messages.some(text => /Reconnect this account/.test(text)));
  console.log('YouTube send-target and composer UI tests passed.');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
