const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const transport = require('./youtube-transport.test');
const readerFixture = require('./youtube-reader.test').fixture;
const { relay, source, readerSender, VIDEO, RUN, RUN2, settle } = transport;
const clean = value => JSON.parse(JSON.stringify(value));
const READY = { available: true, reason: 'ready', accountLabel: '@SyntheticViewer', capability: 1, maxLength: 200 };
const result = (sequence = 1, extra = {}) => ({ type: 'send-result', videoId: VIDEO, run: RUN,
  sequence, outcome: 'submitted', reason: 'submitted', ...extra });
const command = (sequence = 1, extra = {}) => ({ cmd: 'send', videoId: VIDEO, run: RUN, sequence, capability: 1, text: 'Hello', ...extra });
const state = (extra = {}) => ({ type: 'send-state', videoId: VIDEO, run: RUN, ...READY, ...extra });
const invalidStates = [
  { available: 'yes' }, { reason: 'unknown' }, { available: false }, { accountLabel: null },
  { accountLabel: 'a'.repeat(101) }, { accountLabel: 'bad\nname' }, { accountLabel: ' ' },
  { capability: 0 }, { capability: -1 }, { capability: 1.5 }, { capability: Number.MAX_SAFE_INTEGER + 1 },
  { maxLength: 201 },
];
const invalidText = [null, 1, '', ' ', 'a'.repeat(201), 'a\nb', 'a\tb', 'a\u007fb', 'a\u0085b', '😀'.repeat(101)];
const nativeFrame = (overrides = {}) => readerSender({ frameId: 4, url: readerSender().url + '&role=sender', ...overrides });

function linked(withPermissionEvents = false) {
  const r = relay(withPermissionEvents), host = r.host(); r.start(host);
  const capture = r.reader(), reader = r.reader(nativeFrame());
  reader.onMessage.emit(state());
  return { ...r, host, reader, capture,
    send: value => host.onMessage.emit(value),
    received: () => reader.sent.filter(value => value.cmd === 'send'),
    last: () => clean(host.sent.at(-1)),
  };
}

async function accessTests() {
  const envelope = { videoId: VIDEO, run: RUN };
  const access = (value, extra = {}) => ({ type: 'access-state', access: value, ...envelope, ...extra });
  const unavailable = { ...READY, available: false, reason: 'composer-unavailable', accountLabel: '' };
  const open = r => r.send({ cmd: 'access-open', ...envelope });
  const reload = r => r.reader.onMessage.emit({ type: 'access-reload', ...envelope });
  for (const disconnectFirst of [false, true]) {
    const r = linked(); r.reader.onMessage.emit(state(unavailable));
    const before = r.host.sent.length;
    r.capture.onMessage.emit(access('granted')); r.reader.onMessage.emit(access('invalid'));
    r.send({ cmd: 'access-open', ...envelope, run: RUN2 });
    r.send({ cmd: 'access-close', ...envelope });
    reload(r); await settle(); assert.equal(r.host.sent.length, before, 'access cannot cross roles, runs or start itself');
    for (const value of ['unknown', 'needed', 'denied', 'unsupported', 'error', 'requesting', 'granted']) {
      r.reader.onMessage.emit(access(value, { secret: 'not-forwarded' }));
      assert.deepEqual(r.last(), access(value));
    }
    r.reader.onMessage.emit(access('needed'));
    open(r); open(r); await settle(); assert.equal(r.reader.sent.filter(m => m.cmd === 'access-open').length, 1);
    r.send(command()); await settle(); assert.equal(r.last().reason, 'busy'); assert.equal(r.received().length, 0);
    r.reader.onMessage.emit(access('granted')); reload(r); reload(r); await settle();
    assert.equal(r.reader.sent.filter(m => m.cmd === 'access-reload').length, 1);
    assert.equal(r.last().type, 'access-reloading');
    const beforeOldState = r.host.sent.length; r.reader.onMessage.emit(state());
    assert.equal(r.host.sent.length, beforeOldState, 'old document readiness cannot finish the reload or re-enable sending');
    r.send(command(2)); await settle(); assert.equal(r.last().reason, 'busy', 'old reader cannot restore sending before replacement');
    if (disconnectFirst) r.reader.disconnect();
    assert.equal(r.capture.closed, false); assert.equal(r.host.closed, false);
    assert.equal(r.add(transport.port('fcm-youtube-reader', nativeFrame({ frameId: 8 }))).closed, true);
    const next = r.add(transport.port('fcm-youtube-reader', nativeFrame()));
    assert.equal(next.sent[0].type, 'reader-ready'); assert.equal(r.reader.closed, true);
    assert.equal(r.add(transport.port('fcm-youtube-reader', nativeFrame())).closed, true, 'only one replacement is accepted');
    const count = r.host.sent.length; r.reader.onMessage.emit(access('error')); assert.equal(r.host.sent.length, count);
    next.onMessage.emit(state(unavailable)); next.onMessage.emit(state());
    r.send(command(3)); await settle(); assert.equal(next.sent.at(-1).cmd, 'send');
    next.onMessage.emit(result(3));
    next.onMessage.emit({ type: 'access-reload', ...envelope }); await settle();
    assert.equal(next.sent.filter(m => m.cmd === 'access-reload').length, 0, 'successful reload budget cannot loop');
    open(r); await settle(); assert.equal(r.last().type, 'access-close');
    r.host.disconnect();
  }
  // A previously granted permission may be restored without opening visible setup.
  {
    const r = linked(); r.reader.onMessage.emit(state(unavailable));
    r.reader.onMessage.emit(access('requesting')); r.send(command()); await settle(); assert.equal(r.last().reason, 'busy');
    r.reader.onMessage.emit(access('granted')); reload(r); await settle();
    assert.equal(r.last().type, 'access-reloading');
    r.reader.disconnect(); r.send({ cmd: 'access-abort', ...envelope });
    assert.equal(r.last().type, 'access-close'); assert.equal(r.capture.closed, false);
    assert.equal(r.add(transport.port('fcm-youtube-reader', nativeFrame())).closed, true, 'timeout rejects late sender replacement');
    r.host.disconnect();
  }
  for (const response of [false, 'throw', 'reject']) {
    const r = linked(); r.chrome.permissions.contains = () => {
      if (response === 'throw') throw Error('unavailable');
      return response === 'reject' ? Promise.reject(Error('unavailable')) : Promise.resolve(response);
    };
    open(r); await settle(); assert.equal(r.last().type, 'access-close');
    assert.equal(r.host.sent.at(-2).access, 'error'); assert.equal(r.capture.closed, false);
  }
  for (const cancel of ['host', 'sender', 'run', 'close']) {
    const r = linked(); let allow;
    r.chrome.permissions.contains = () => new Promise(resolve => { allow = resolve; });
    open(r);
    if (cancel === 'host') r.host.disconnect();
    if (cancel === 'sender') r.reader.disconnect();
    if (cancel === 'run') r.start(r.host, RUN2);
    if (cancel === 'close') r.send({ cmd: 'access-close', ...envelope });
    allow(true); await settle(); assert.equal(r.reader.sent.some(m => m.cmd === 'access-open'), false);
  }
  for (const failedClose of [false, true]) {
    const r = linked(); open(r); await settle();
    r.chrome.permissions.contains = async () => false; r.reader.failPost = failedClose;
    reload(r); await settle();
    assert.equal(r.host.sent.at(-2).access, failedClose ? 'failed' : 'error');
    assert.equal(r.last().type, 'access-close'); assert.equal(r.capture.closed, false);
    if (failedClose) assert.equal(r.reader.closed, true);
    else assert.equal(r.reader.sent.at(-1).cmd, 'access-close', 'permission rejection must release the reader-local send gate');
    r.host.disconnect();
  }
  {
    const r = linked(); open(r); await settle(); r.host.failPost = true;
    reload(r); await settle(); assert.equal(r.host.closed, true, 'reload notification failure tears down the bridge');
  }
  for (const restoring of [false, true]) {
    const r = linked(); if (restoring) r.reader.onMessage.emit(access('requesting'));
    r.reader.onMessage.emit(access('granted')); reload(r); await settle();
    r.reader.disconnect(); const next = transport.port('fcm-youtube-reader', nativeFrame()); next.failPost = true; r.add(next);
    assert.equal(next.closed, true); assert.equal(r.capture.closed, false);
    assert.equal(r.host.sent.at(-2).access, 'failed'); r.host.disconnect();
  }
  for (const senderError of [false, true]) {
    const r = linked(); open(r); await settle(); reload(r); await settle();
    if (senderError) r.reader.onMessage.emit(access('error'));
    r.reader.onMessage.emit({ type: 'access-close', ...envelope });
    assert.equal(r.host.sent.at(-2).access, 'failed', 'cancel or failed navigation cannot reuse an exhausted reload attempt');
    assert.equal(r.reader.closed, true); assert.equal(r.capture.closed, false);
    assert.equal(r.add(transport.port('fcm-youtube-reader', nativeFrame())).closed, true);
    r.host.disconnect();
  }
  {
    const r = linked(); open(r); await settle(); reload(r); await settle(); r.reader.disconnect();
    const next = r.add(transport.port('fcm-youtube-reader', nativeFrame())); next.onMessage.emit(state());
    r.send({ cmd: 'access-abort', ...envelope });
    assert.equal(next.closed, true); assert.equal(r.capture.closed, false); assert.equal(r.host.closed, false);
    assert.equal(r.host.sent.some(value => value.type === 'reader-disconnected'), false,
      'a timeout racing queued ready must abort only the sender, even after relay readiness settled');
    r.host.disconnect();
  }
  for (const stage of ['open', 'reload', 'state', 'error', 'close', 'ready']) {
    const r = linked();
    if (stage === 'state') { r.host.failPost = true; r.reader.onMessage.emit(access('needed')); assert.equal(r.host.closed, true); continue; }
    if (stage === 'error') { r.chrome.permissions.contains = async () => false; r.host.failPost = true; open(r); await settle(); assert.equal(r.host.closed, true); continue; }
    if (stage === 'open') r.reader.failPost = true;
    open(r); await settle();
    if (stage === 'close') { r.host.failPost = true; r.reader.onMessage.emit({ type: 'access-close', ...envelope }); assert.equal(r.host.closed, true); continue; }
    if (stage === 'reload') r.reader.failPost = true;
    if (stage !== 'open') { reload(r); await settle(); }
    if (stage === 'ready') {
      r.reader.disconnect(); const next = transport.port('fcm-youtube-reader', nativeFrame()); next.failPost = true; r.add(next);
      assert.equal(next.closed, true);
    }
    assert.equal(r.capture.closed, false, `${stage} setup failure preserves capture`);
    r.host.disconnect();
  }
  {
    const r = linked(); open(r); await settle(); r.reader.onMessage.emit({ type: 'access-close', ...envelope });
    assert.equal(r.last().type, 'access-close');
    r.reader.onMessage.emit({ type: 'access-close', ...envelope });
    r.send(command()); await settle(); open(r); await settle(); assert.equal(r.last().type, 'access-close');
    r.reader.onMessage.emit(result()); r.host.disconnect();
    const empty = relay(), host = empty.host(); empty.start(host); host.onMessage.emit({ cmd: 'access-open', ...envelope }); await settle();
    assert.equal(host.sent.at(-1).type, 'access-close'); host.disconnect();
  }

  async function sourceWithAccess(onSendState) {
    const s = source(); s.context.FCM.BROWSER = 'firefox';
    if (onSendState) s.control = s.context.FCM.createYouTubeSource({ onBatch() {}, onStatus() {}, onSendState });
    await s.control.start(VIDEO);
    s.message('host-ready'); s.message('batch', { ready: true });
    s.message('send-state', unavailable); s.message('access-state', { access: 'needed' }); return s;
  }
  {
    const empty = source(); empty.context.FCM.BROWSER = 'firefox';
    assert.equal(empty.control.openAccessSetup(), false); empty.control.closeAccessSetup();
    await empty.control.start(VIDEO); assert.equal(empty.control.openAccessSetup(), false);
    empty.control.destroy(); assert.equal(empty.control.openAccessSetup(), false);
    const s = await sourceWithAccess(); s.context.FCM.BROWSER = 'chrome'; assert.equal(s.control.openAccessSetup(), false);
    s.context.FCM.BROWSER = 'firefox'; s.message('access-state', { access: 'unknown' }); assert.equal(s.control.openAccessSetup(), false);
    s.message('access-state', { access: 'invalid' }); assert.equal(s.control.getSendState().access, 'unknown');
    s.message('access-close'); s.message('access-reloading');
    s.message('access-state', { access: 'needed' }); s.message('send-state', READY); assert.equal(s.control.openAccessSetup(), false);
    const pending = s.control.send('Pending native send'); s.message('send-state', unavailable);
    assert.equal(s.control.openAccessSetup(), false); s.message('send-result', { sequence: 1, outcome: 'submitted', reason: 'submitted' }); await pending;
    assert.equal(s.control.openAccessSetup(), true); assert.equal(s.control.openAccessSetup(), false);
    assert.match(s.frames[1].style.cssText, /display: block/); assert.equal(s.frames[0].style.cssText, 'display: none !important;');
    assert.equal(s.control.getSendState().access, 'requesting'); assert.equal((await s.control.send('Blocked')).outcome, 'not-sent');
    s.message('send-state', READY); assert.equal(s.control.getSendState().available, false);
    s.control.closeAccessSetup(); assert.equal(s.control.getSendState().available, true);
    assert.equal(s.frames[1].style.cssText, 'display: none !important;');
    s.message('send-state', unavailable); assert.equal(s.control.openAccessSetup(), true);
    s.message('access-close'); assert.equal(s.control.getSendState().available, false);
    assert.equal(s.control.openAccessSetup(), true); s.message('access-reloading');
    assert.match(s.frames[1].style.cssText, /display: block/, 'explicit setup remains visible through child reload');
    const count = s.time.timers.size; s.message('access-reloading'); assert.equal(s.time.timers.size, count);
    s.message('send-state', READY); assert.equal(s.control.getSendState().available, true);
    assert.match(s.control.getSendState().sourceId, /:1:1$/); assert.equal(s.frames.length, 2, 'reload never reassigns/rebuilds frames');
    assert.equal(s.frames[1].style.cssText, 'display: none !important;');
    s.message('send-state', unavailable); assert.equal(s.control.openAccessSetup(), false);
    s.control.destroy();
  }
  {
    const s = await sourceWithAccess(); s.control.closeAccessSetup();
    assert.equal(s.control.openAccessSetup(), true); s.message('access-state', { access: 'requesting' });
    s.control.closeAccessSetup(); assert.equal(s.control.getSendState().access, 'needed');
    assert.equal(s.control.openAccessSetup(), true, 'cancel restores a settled, retryable setup state');
    s.message('access-close'); s.message('access-state', { access: 'requesting' });
    s.control.closeAccessSetup(); assert.equal(s.control.getSendState().access, 'needed');
    s.message('access-state', { access: 'failed' });
    assert.equal(s.control.getSendState().access, 'failed'); assert.equal(s.frames[1].removed, true);
    assert.equal(s.frames[0].removed, false); assert.equal(s.control.openAccessSetup(), false);
    s.message('batch', { ready: true }); assert.equal(s.control.getSendState().access, 'failed');
    s.control.destroy();
    const noFrames = source(); await noFrames.control.start(VIDEO); noFrames.message('access-state', { access: 'failed' });
    assert.equal(noFrames.frames.length, 0); noFrames.control.destroy();
  }
  for (const abortAt of ['open', 'failed']) {
    let abort = false, s;
    s = await sourceWithAccess(value => {
      if (abort && value.access === (abortAt === 'open' ? 'requesting' : 'failed')) { abort = false; s.control.destroy(); }
    });
    if (abortAt === 'failed') { s.control.openAccessSetup(); s.message('access-reloading'); }
    abort = true;
    if (abortAt === 'open') assert.equal(s.control.openAccessSetup(), false);
    else s.control.closeAccessSetup();
    assert.equal(s.time.timers.size, 0); assert.equal(s.frames.every(frame => frame.removed), true);
  }
  for (const failure of ['timeout', 'cancel', 'post']) {
    const s = await sourceWithAccess(); s.message('access-state', { access: 'requesting' });
    assert.equal(s.control.openAccessSetup(), false); s.message('access-state', { access: 'granted' }); s.message('access-reloading');
    assert.equal(s.frames[1].style.cssText, 'display: none !important;', 'automatic restoration never opens setup');
    const late = [...s.time.timers.values()].find(t => t.delay === 20000).fn;
    if (failure === 'post') s.activePort().failPost = true;
    if (failure === 'cancel') s.control.closeAccessSetup(); else s.time.fire(20000);
    assert.equal(s.frames[0].removed, false); assert.equal(s.frames[1].removed, true);
    assert.equal(s.control.getSendState().access, 'failed'); assert.equal(s.control.openAccessSetup(), false);
    s.message('send-state', READY); s.message('access-state', { access: 'granted' });
    assert.equal(s.control.getSendState().available, false, 'timed-out setup rejects late sender readiness');
    s.control.destroy(); late(); assert.equal(s.time.timers.size, 0);
  }
  {
    const s = await sourceWithAccess(); s.activePort().failPost = true;
    assert.equal(s.control.openAccessSetup(), false); assert.equal(s.frames[0].removed, false);
    s.activePort().failPost = false; assert.equal(s.control.openAccessSetup(), true);
    s.activePort().failPost = true; s.control.closeAccessSetup(); assert.equal(s.frames[1].style.cssText, 'display: none !important;');
    s.control.destroy();
  }

  // Firefox-only helper lives in the authenticated sender, with no page-world bridge.
  {
    const r = readerFixture({ sending: true }); r.context.FCM.BROWSER = 'firefox'; let destroyed = 0;
    r.context.FCM.createYouTubeAccess = () => { r.port.onDisconnect.fire(); return { destroy() { destroyed++; } }; };
    r.ack(); assert.equal(destroyed, 1); assert.equal(r.observers.length, 0); assert.equal(r.timers.size, 0);
  }
  for (const sending of [false, true]) {
    const r = readerFixture({ sending }); r.context.FCM.BROWSER = 'firefox';
    const parsed = new URL(r.context.location.href), env = { videoId: parsed.searchParams.get('v'), run: parsed.hash.slice(13, 45) };
    let callbacks, native, sends = 0, opens = 0, closes = 0, destroys = 0, reloads = 0;
    r.context.location.reload = () => { reloads++; };
    r.context.FCM.createYouTubeSender = value => { native = value; value.onState(unavailable); return { refresh() {}, send() { sends++; }, destroy() {} }; };
    r.context.FCM.createYouTubeAccess = value => { callbacks = value; value.onState('needed'); return { open() { opens++; }, close() { closes++; }, destroy() { destroys++; } }; };
    r.port.onMessage.fire({ cmd: 'access-open', ...env }); r.port.onMessage.fire({ cmd: 'access-close', ...env }); r.port.onMessage.fire({ cmd: 'access-reload', ...env });
    r.ack();
    if (!sending) { assert.equal(callbacks, undefined); r.port.onDisconnect.fire(); continue; }
    assert.equal(callbacks.canRestore(), true); native.onState(READY); assert.equal(callbacks.canRestore(), false);
    native.onState({ ...unavailable, reason: 'busy' }); assert.equal(callbacks.canRestore(), false); native.onState(unavailable);
    callbacks.onReload(); assert.equal(r.posts.at(-1).type, 'send-state', 'reload needs an explicit request or granted restoration');
    r.port.onMessage.fire({ cmd: 'access-open', ...env }); assert.equal(opens, 1); assert.equal(callbacks.canRestore(), false);
    r.port.onMessage.fire({ cmd: 'send', ...env, sequence: 1 }); assert.equal(sends, 0);
    callbacks.onState('requesting'); callbacks.onState('granted'); callbacks.onReload(); callbacks.onReload();
    assert.equal(r.posts.filter(m => m.type === 'access-reload').length, 1);
    r.port.onMessage.fire({ cmd: 'access-reload', ...env }); r.port.onMessage.fire({ cmd: 'access-reload', ...env }); assert.equal(reloads, 1);
    callbacks.onClose(); assert.equal(r.posts.at(-1).type, 'access-close');
    r.port.onMessage.fire({ cmd: 'access-close', ...env }); assert.equal(closes, 1);
    callbacks.onState('requesting'); r.port.onMessage.fire({ cmd: 'send', ...env, sequence: 2 }); assert.equal(sends, 0);
    callbacks.onState('denied'); r.port.onMessage.fire({ cmd: 'send', ...env, sequence: 3 }); assert.equal(sends, 1);
    callbacks.onState('requesting'); callbacks.onState('granted'); callbacks.onReload();
    r.context.location.reload = () => { throw Error('navigation failed'); }; r.port.onMessage.fire({ cmd: 'access-reload', ...env });
    assert.equal(r.posts.at(-2).access, 'error'); assert.equal(r.posts.at(-1).type, 'access-close');
    assert.equal(closes, 2); r.port.onMessage.fire({ cmd: 'send', ...env, sequence: 4 });
    assert.equal(sends, 2, 'failed navigation releases the local access gate without retrying a send');
    r.context.location.href += '&stale'; assert.equal(callbacks.isCurrent(), false); assert.equal(callbacks.canRestore(), false);
    callbacks.onReload(); r.port.onDisconnect.fire(); assert.equal(destroys, 1); assert.equal(callbacks.canRestore(), false);
    const total = r.posts.length; callbacks.onState('granted'); callbacks.onReload(); assert.equal(r.posts.length, total);
  }
}

async function run() {
  {
    const listeners = [];
    const context = vm.createContext({ chrome: { runtime: { onMessage: { addListener(value) { listeners.push(value); } },
      onConnect: { addListener(value) { listeners.push(value); } } } }, FCM: {}, URL, Map, Set });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/background/youtube-relay.js'), 'utf8'), context,
      { filename: path.join(__dirname, '..', 'src/background/youtube-relay.js') });
    assert.equal(listeners.length, 3, 'legacy worker fixtures without a permissions API still load safely');
  }
  // Revocation cancels existing native work and does not displace other listeners.
  for (const origin of ['https://www.youtube.com/*', '*://www.youtube.com/*', 'https://*.youtube.com/*',
    '*://*.youtube.com/*', 'https://*/*', '*://*/*', '<all_urls>']) {
    const r = linked(true); let otherCalled = false;
    r.chrome.permissions.onRemoved.addListener(() => { otherCalled = true; });
    for (const details of [undefined, null, {}, { origins: null }, { origins: [] },
      { origins: ['https://www.twitch.tv/*', 'http://www.youtube.com/*'] }]) r.chrome.permissions.onRemoved.emit(details);
    assert.equal(r.host.closed, false, 'unrelated permissions do not interrupt this reader');
    r.chrome.permissions.onRemoved.emit({ origins: [origin] });
    assert.equal(otherCalled, true); assert.equal(r.host.closed, true); assert.equal(r.reader.closed, true);
    assert.equal(r.capture.closed, true, 'revocation closes both native frame roles');
    assert.equal(r.last().type, 'permission-revoked');
    const reconnect = relayPort => { const host = relayPort.host(); relayPort.start(host); return host; };
    const rebound = { ...r, host: () => r.add(transport.port('fcm-youtube-host', transport.sender())) };
    let host = reconnect(rebound); assert.equal(host.closed, true); assert.equal(host.sent.at(-1).type, 'permission-revoked');
    r.chrome.permissions.onAdded.emit({ origins: ['https://example.invalid/*'] });
    host = reconnect(rebound); assert.equal(host.closed, true);
    r.chrome.permissions.onAdded.emit({ origins: [origin] });
    host = reconnect(rebound); assert.equal(host.closed, false); assert.equal(host.sent.at(-1).type, 'host-ready');
    host.disconnect();
  }
  {
    const r = linked(true); let allow;
    r.chrome.permissions.contains = () => new Promise(resolve => { allow = resolve; });
    r.send(command()); r.chrome.permissions.onRemoved.emit({ origins: ['https://www.youtube.com/*'] });
    allow(true); await settle(); assert.equal(r.received().length, 0);
    const broken = linked(true); broken.host.failPost = true;
    broken.chrome.permissions.onRemoved.emit({ origins: ['https://www.youtube.com/*'] });
    assert.equal(broken.reader.closed, true, 'failed host notification still cancels the native reader');
  }
  // All new reader data is rebuilt from an allowlist, never copied wholesale.
  {
    const r = linked(), count = r.host.sent.length;
    for (const extra of invalidStates) r.reader.onMessage.emit(state(extra));
    assert.equal(r.host.sent.length, count);
    r.reader.onMessage.emit(state({ token: 'do-not-forward', arbitrary: true }));
    assert.deepEqual(r.last(), state());
    r.reader.onMessage.emit(state({ available: false, reason: 'signed-out', accountLabel: '' }));
    assert.equal(r.last().available, false);
    r.send(command()); await settle();
    assert.equal(r.last().reason, 'composer-unavailable');
    assert.equal(r.received().length, 0);
  }
  // The URL role, rather than a message-provided flag, decides each authority.
  {
    const r = linked(), count = r.host.sent.length;
    r.capture.onMessage.emit(state({ accountLabel: '@ForgedCapture', role: 'sender' }));
    r.capture.onMessage.emit(result());
    r.reader.onMessage.emit({ type: 'batch', videoId: VIDEO, run: RUN, ready: true, role: 'reader' });
    for (const message of [null, {}, state({ videoId: 'ZYXWVUTSRQP' }), state({ run: RUN2 })]) r.reader.onMessage.emit(message);
    assert.equal(r.host.sent.length, count, 'cross-role and mismatched messages never reach the host');
    r.send(command()); await settle();
    const beforeResult = r.host.sent.length;
    r.capture.onMessage.emit(result()); assert.equal(r.host.sent.length, beforeResult, 'capture cannot complete a pending send');
    assert.equal(r.capture.sent.filter(message => message.cmd === 'send').length, 0);
    r.reader.onMessage.emit(result()); assert.equal(r.last().outcome, 'submitted');
    assert.equal(r.add(transport.port('fcm-youtube-reader', nativeFrame({ frameId: 5 }))).closed, true,
      'duplicate sender role is refused');
  }
  for (const sendingFirst of [false, true]) {
    const r = relay(), host = r.host(); r.start(host);
    const first = sendingFirst ? nativeFrame() : readerSender();
    const other = sendingFirst ? readerSender({ frameId: first.frameId }) : nativeFrame({ frameId: first.frameId });
    assert.equal(r.reader(first).closed, false);
    assert.equal(r.reader(other).closed, true, 'one physical frame cannot claim both roles in either connection order');
  }
  for (const suffix of ['&role=capture', '&role=Sender', '&role=sender&extra=1', '&role=sender&role=sender']) {
    const r = relay(), host = r.host(); r.start(host);
    assert.equal(r.reader(nativeFrame({ url: readerSender().url + suffix })).closed, true);
  }
  for (const role of ['capture', 'reader']) {
    const r = linked(); r.send(command()); await settle();
    assert.equal(r.received().length, 1);
    r[role].disconnect();
    assert.equal(r.host.sent.filter(message => message.type === 'send-result' && message.outcome === 'uncertain').length, 1,
      'loss of either frame makes a forwarded send uncertain');
    r.reader.onMessage.emit(result()); r.send(command()); await settle();
    assert.equal(r.received().length, 1, 'late results and repeat commands cannot resend after either role is lost');
  }
  // Invalid requests never reach native controls. Valid text is never altered.
  {
    const r = linked();
    const count = r.host.sent.length;
    for (const extra of [{ videoId: 'ZYXWVUTSRQP' }, { run: RUN2 }, { sequence: 0 }, { sequence: -1 },
      { sequence: '1' }, { sequence: Number.MAX_SAFE_INTEGER + 1 }]) r.send(command(1, extra));
    assert.equal(r.host.sent.length, count);
    let sequence = 0;
    for (const text of invalidText) { r.send(command(++sequence, { text })); await settle(); assert.equal(r.last().reason, 'invalid-request'); }
    for (const capability of [0, '1', -1, 1.5]) {
      r.send(command(++sequence, { capability })); await settle(); assert.equal(r.last().reason, 'invalid-request');
    }
    r.send(command(++sequence, { capability: 2 })); await settle(); assert.equal(r.last().reason, 'stale-capability');
    r.send(command(++sequence, { text: ' 😀 exact text ' })); await settle();
    assert.deepEqual(clean(r.received()), [command(sequence, { text: ' 😀 exact text ' })]);
    r.reader.onMessage.emit(result(sequence));
    assert.deepEqual(r.last(), result(sequence));
  }
  // Each consumed sequence can execute once, including while permission is pending.
  {
    const r = linked(); let allow;
    r.chrome.permissions.contains = () => new Promise(resolve => { allow = resolve; });
    r.send(command()); r.send(command());
    r.send(command(2)); assert.equal(r.last().reason, 'busy');
    r.reader.onMessage.emit(result());
    assert.equal(r.last().reason, 'busy', 'a reader cannot acknowledge before dispatch');
    allow(true); await settle(); assert.equal(r.received().length, 1);
    r.send(command()); assert.equal(r.received().length, 1);
    for (const extra of [{ sequence: 99 }, { outcome: 'sent' }, { reason: 'arbitrary' }, { reason: 'timeout' }]) {
      r.reader.onMessage.emit(result(1, extra));
      assert.equal(r.last().reason, 'busy');
    }
    r.reader.onMessage.emit(result()); assert.equal(r.last().outcome, 'submitted');
    r.send(command()); assert.deepEqual(r.last(), result());
    r.send(command(2)); assert.equal(r.last().reason, 'stale-sequence');
    r.send(command(2)); assert.equal(r.last().reason, 'stale-sequence');
    assert.equal(r.received().length, 1, 'cached and stale results never repeat native dispatch');
    r.start(r.host); assert.equal(r.reader.closed, false, 'duplicate start preserves reader and consumed sequences');
    r.send(command()); assert.equal(r.received().length, 1);
  }
  for (const grant of [false, 'truthy', 'throw', 'reject']) {
    const r = linked();
    r.chrome.permissions.contains = () => {
      if (grant === 'throw') throw Error('permission API unavailable');
      return grant === 'reject' ? Promise.reject(Error('revoked')) : Promise.resolve(grant);
    };
    r.send(command()); await settle();
    assert.equal(r.last().reason, 'permission'); assert.equal(r.received().length, 0);
  }
  for (const change of ['account', 'unavailable', 'reader', 'capture', 'host', 'run']) {
    const r = linked(); let allow;
    r.chrome.permissions.contains = () => new Promise(resolve => { allow = resolve; });
    r.send(command());
    if (change === 'account') r.reader.onMessage.emit(state({ capability: 2 }));
    if (change === 'unavailable') r.reader.onMessage.emit(state({ available: false, reason: 'restricted' }));
    if (change === 'reader') r.reader.disconnect();
    if (change === 'capture') r.capture.disconnect();
    if (change === 'host') r.host.disconnect();
    if (change === 'run') r.start(r.host, RUN2);
    allow(true); await settle();
    assert.equal(r.received().length, 0, `A pending permission check cannot cross a changed ${change}`);
    if (['account', 'unavailable'].includes(change)) assert.equal(r.last().reason, 'stale-capability');
  }
  {
    const r = relay(), host = r.host(); r.start(host);
    host.onMessage.emit(command()); await settle();
    assert.equal(host.sent.at(-1).reason, 'composer-unavailable', 'no reader fails before permission or dispatch');
  }
  // Failed bridge delivery, stale replies and replayed starts cannot create a retry.
  {
    let r = linked(); r.reader.failPost = true; r.send(command()); await settle();
    assert.equal(r.last().outcome, 'uncertain'); assert.equal(r.host.closed, true);
    r = linked(); r.send(command()); await settle(); r.reader.disconnect();
    assert.equal(r.host.sent.some(value => value.type === 'send-result' && value.outcome === 'uncertain'), true);
    r = linked(); r.send(command()); await settle(); r.host.failPost = true;
    r.reader.onMessage.emit(result()); assert.equal(r.host.closed, true);
    r = linked(); r.send(command()); await settle(); r.reader.onMessage.emit(result());
    r.host.failPost = true; r.send(command()); assert.equal(r.host.closed, true);
    r = linked(); r.host.failPost = true; r.reader.onMessage.emit(state()); assert.equal(r.host.closed, true);
    r = linked(); r.host.failPost = true; r.start(r.host); assert.equal(r.host.closed, true);
    r = linked(); r.send(command()); await settle(); r.start(r.host, RUN2);
    r.reader.onMessage.emit(result()); assert.equal(r.host.sent.at(-1).type, 'host-ready');
    r = linked();
    r.reader.postMessage = () => { r.reader.disconnect(); throw Error('Disconnected during dispatch'); };
    r.send(command()); await settle();
    assert.equal(r.host.sent.filter(value => value.type === 'send-result').length, 1,
      'reentrant bridge failure cannot complete one request twice');
  }

  // Source exposes only the current, sanitized account/composer identity.
  {
    const s = source(), states = [];
    s.control = s.context.FCM.createYouTubeSource({ onBatch() {}, onStatus() {}, onSendState: value => states.push(clean(value)) });
    assert.equal(s.control.getSendState().sourceId, '');
    assert.equal((await s.control.send('Hello')).outcome, 'not-sent');
    for (const text of invalidText) assert.equal((await s.control.send(text)).reason, 'invalid-request');
    await s.control.start(VIDEO);
    const count = states.length;
    for (const extra of invalidStates) s.message('send-state', { ...READY, ...extra });
    assert.equal(states.length, count);
    s.message('send-state', READY);
    const id = s.control.getSendState().sourceId;
    assert.equal(id, `${VIDEO}:${s.activePort().sent[0].run}:1`);
    const snapshot = s.control.getSendState(); snapshot.available = false;
    assert.equal(s.control.getSendState().available, true, 'callers cannot mutate transport capability');
    const sending = s.control.send('Hello');
    assert.equal((await s.control.send('Duplicate')).reason, 'busy');
    const request = s.activePort().sent.at(-1);
    assert.equal(request.cmd, 'send'); assert.equal(request.capability, 1); assert.equal(request.sequence, 1);
    const lateTimer = [...s.time.timers.values()].find(timer => timer.delay === 25000).fn;
    for (const extra of [{ sequence: 4 }, { outcome: 'sent' }, { reason: 'arbitrary' }, { reason: 'timeout' }]) {
      s.message('send-result', { sequence: 1, outcome: 'submitted', reason: 'submitted', ...extra });
    }
    assert.equal((await s.control.send('Still pending')).reason, 'busy');
    s.message('send-result', { sequence: 1, outcome: 'submitted', reason: 'submitted', token: 'private' });
    assert.deepEqual(clean(await sending), { sequence: 1, outcome: 'submitted', reason: 'submitted' });
    lateTimer(); assert.equal(s.activePort().closed, false, 'a completed send cannot be timed out later');
    s.message('send-result', { sequence: 1, outcome: 'submitted', reason: 'submitted' });
    s.message('send-state', { ...READY, available: false, reason: 'busy' });
    assert.equal(s.control.getSendState().sourceId, id, 'transient busy state preserves account/composer selection identity');
    assert.equal((await s.control.send('Hello')).reason, 'busy');
    s.control.destroy(); assert.equal(states.at(-1).sourceId, '');
  }
  for (const interruption of ['disconnect', 'stop', 'destroy', 'timeout', 'post']) {
    const s = source(); await s.control.start(VIDEO); s.message('send-state', READY);
    const original = s.activePort();
    if (interruption === 'post') original.failPost = true;
    const pending = s.control.send('Never replay this');
    if (interruption === 'disconnect') original.disconnect();
    if (interruption === 'stop') s.control.stop();
    if (interruption === 'destroy') s.control.destroy();
    if (interruption === 'timeout') s.time.fire(25000);
    assert.equal((await pending).outcome, 'uncertain');
    assert.equal(s.control.getSendState().available, false);
    if (['disconnect', 'timeout', 'post'].includes(interruption)) {
      assert.equal((await s.control.send('While disconnected')).outcome, 'not-sent');
      s.time.fire(2000); await settle();
      assert.equal(s.activePort().sent.filter(value => value.cmd === 'send').length, 0, 'reconnecting never replays pending text');
      s.message('send-result', { sequence: 1, outcome: 'submitted', reason: 'submitted' }, original);
    }
    s.control.destroy();
  }
  {
    const s = source(); await s.control.start(VIDEO); s.message('send-state', READY);
    const sending = s.control.send('Cancelled by access removal');
    s.message('permission-revoked');
    assert.equal((await sending).outcome, 'uncertain');
    assert.equal(s.control.getSendState().available, false);
    assert.equal(s.statuses.at(-1).state, 'permission');
    assert.equal(s.time.timers.size, 0, 'explicit revocation stops reconnecting immediately');
  }
  for (const response of [null, { granted: false }, { granted: 'yes' }, { granted: true, error: 'reader-registration' }, 'reject']) {
    const s = source(); await s.control.start(VIDEO); s.activePort().disconnect();
    s.chrome.runtime.sendMessage = async () => { if (response === 'reject') throw Error('background stopped'); return response; };
    s.time.fire(2000); await settle();
    assert.equal(s.chrome.runtime.ports.length, 1, 'a retry must recheck optional access before creating a port/frame');
    assert.equal(s.time.timers.size, 0);
    assert.equal(s.statuses.at(-1).state, response && response.error ? 'error' : 'permission');
  }
  {
    const s = source();
    const control = s.context.FCM.createYouTubeSource({ onBatch() {}, onStatus(value) {
      if (value.text === 'Connecting YouTube chat…') control.stop();
    } });
    await control.start(VIDEO);
    assert.equal(s.chrome.runtime.ports.length, 0, 'a status callback can cancel before creating the frame transport');
    assert.equal(s.time.timers.size, 0);
    control.destroy();
  }
  {
    const s = source(); await s.control.start(VIDEO); s.message('send-state', READY);
    s.activePort().postMessage = () => {
      s.message('send-result', { sequence: 1, outcome: 'submitted', reason: 'submitted' });
      throw Error('Bridge closed immediately after result');
    };
    assert.equal((await s.control.send('Complete once')).outcome, 'submitted');
    s.control.destroy();
  }

  // Reader wires native sender only after the nonce-bound handshake.
  {
    const r = readerFixture({ sending: true }), parsed = new URL(r.context.location.href);
    const envelope = { videoId: parsed.searchParams.get('v'), run: parsed.hash.slice('#fcm-youtube='.length, '#fcm-youtube='.length + 32) };
    const calls = [], native = { refresh() { calls.push('refresh'); }, send(value) { calls.push(clean(value)); }, destroy() { calls.push('destroy'); } };
    let callbacks;
    r.context.FCM.createYouTubeSender = options => { callbacks = options; calls.push('create'); options.onState(READY); return native; };
    const send = { cmd: 'send', sequence: 1, capability: 1, text: 'Hello', ...envelope };
    r.port.onMessage.fire(send); assert.deepEqual(calls, []);
    r.ack(); assert.deepEqual(calls, ['create', 'refresh']); assert.equal(callbacks.isCurrent(), true);
    r.port.onMessage.fire(send); assert.deepEqual(calls.at(-1), { sequence: 1, capability: 1, text: 'Hello' });
    callbacks.onResult({ sequence: 1, outcome: 'submitted', reason: 'submitted', videoId: 'evil', run: 'evil' });
    assert.deepEqual(r.posts.at(-1), { sequence: 1, outcome: 'submitted', reason: 'submitted', type: 'send-result', ...envelope });
    r.tick(5000, 'interval'); assert.equal(calls.at(-1), 'refresh');
    r.context.location.href += '&changed'; assert.equal(callbacks.isCurrent(), false);
    r.port.onDisconnect.fire(); assert.equal(calls.at(-1), 'destroy'); assert.equal(callbacks.isCurrent(), false);
    const count = r.posts.length; callbacks.onState(READY); callbacks.onResult({ sequence: 1 });
    assert.equal(r.posts.length, count, 'destroyed reader ignores late sender callbacks');
    const readingOnly = readerFixture(); readingOnly.ack();
    const url = new URL(readingOnly.context.location.href);
    readingOnly.port.onMessage.fire({ ...send, videoId: url.searchParams.get('v'), run: url.hash.slice(13) });
    readingOnly.port.onDisconnect.fire();
  }
  for (const when of ['construct', 'refresh']) {
    const r = readerFixture({ sending: true }); let destroyed = 0;
    r.context.FCM.createYouTubeSender = options => {
      if (when === 'construct') { r.failPost = true; options.onState(READY); }
      return { refresh() { r.failPost = true; options.onState(READY); }, send() {}, destroy() { destroyed++; } };
    };
    r.ack(); assert.equal(destroyed, 1); assert.equal(r.timers.size, 0);
  }
  await accessTests();
  console.log('YouTube send transport isolation and no-retry tests passed.');
}

async function coverage() {
  const inspector = require('node:inspector'), { promisify } = require('node:util');
  const gate = require('./youtube-coverage');
  const session = new inspector.Session(); session.connect(); const post = promisify(session.post.bind(session));
  await post('Debugger.enable'); await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  try {
    await transport.run(); await require('./youtube-reader.test')();
    await require('./youtube-resolve-route.test')(); await run();
    const { result } = await post('Profiler.takePreciseCoverage');
    const files = ['src/background/youtube-relay.js', 'src/content/youtube-source.js', 'src/content/youtube-reader.js'];
    const scripts = [];
    for (const entry of result.filter(script => files.some(file => gate.matchesFile(script, file)))) {
      const { scriptSource } = await post('Debugger.getScriptSource', { scriptId: entry.scriptId });
      scripts.push({ ...entry, source: scriptSource });
    }
    const failures = [];
    for (const file of files) {
      const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const report = gate.report(file, source, scripts.filter(script => gate.matchesFile(script, file)), gate.selectedLines(source, '', true));
      const uncovered = [...report.ranges].filter(([, covered]) => !covered).map(([key]) => {
        const [start, end] = key.split(':').map(Number);
        return { line: source.slice(0, start).split('\n').length, text: source.slice(start, end).slice(0, 200) };
      });
      console.log(file, `${report.lines.filter(line => line.covered).length}/${report.lines.length} lines`,
        `${[...report.functions.values()].filter(Boolean).length}/${report.functions.size} functions`,
        `${[...report.ranges.values()].filter(Boolean).length}/${report.ranges.size} ranges`);
      if (!report.passed) failures.push({ file, lines: report.lines.filter(line => !line.covered), uncovered });
    }
    assert.deepEqual(failures, []);
  } finally { await post('Profiler.stopPreciseCoverage'); session.disconnect(); }
}

module.exports = run;
if (require.main === module) (process.argv.includes('--coverage') ? coverage() : run())
  .catch(error => { console.error(error); process.exitCode = 1; });
