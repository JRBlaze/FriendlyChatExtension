const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const FILE = 'src/shared/mention-sound.js';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function fixture(options = {}) {
  const contexts = [], claims = [], listeners = new Map(), settings = { mentionSound: !!options.enabled };
  const document = { addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); } };
  const parameter = () => ({ events: [], setValueAtTime(value, time) { this.events.push(['set', value, time]); },
    linearRampToValueAtTime(value, time) { this.events.push(['linear', value, time]); },
    exponentialRampToValueAtTime(value, time) { this.events.push(['exponential', value, time]); } });
  class AudioContext {
    constructor() { if (options.constructorError) throw Error('fixture constructor'); this.state = options.running ? 'running' : 'suspended'; this.currentTime = 1; this.destination = {}; this.oscillators = []; this.gains = []; contexts.push(this); }
    async resume() { if (options.resume) return options.resume(this); if (options.resumeError) throw Error('fixture resume'); this.state = 'running'; }
    async close() { this.state = 'closed'; if (options.closeError) throw Error('fixture close'); }
    createOscillator() { if (options.toneError) throw Error('fixture oscillator'); const node = { frequency: parameter(), connect() {}, disconnect() { this.disconnected = true; },
      start(time) { this.started = time; }, stop(time) { this.stopped = time; } }; this.oscillators.push(node); return node; }
    createGain() { const node = { gain: parameter(), connect() {}, disconnect() { this.disconnected = true; } }; this.gains.push(node); return node; }
  }
  let owner = { document, AudioContext: options.noAudio ? undefined : AudioContext };
  const sandbox = vm.createContext({ FCM: {}, console }); sandbox.self = sandbox;
  const filename = path.join(ROOT, FILE); vm.runInContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const controller = sandbox.FCM.createMentionSound({ getWindow: () => owner, getSettings: () => settings,
    async claim() { claims.push(true); if (options.claim) return options.claim(); if (options.claimError) throw Error('fixture gate'); return { play: options.play !== false }; } });
  const classes = new Set(['fcm-mentioned']);
  const row = { classList: { contains: name => classes.has(name) } };
  return { controller, F: sandbox.FCM, contexts, claims, listeners, settings, row, classes, options,
    owner(value) { owner = value; }, AudioContext, document, arm: () => controller.arm({ isTrusted: true }) };
}

async function run() {
  const f = fixture();
  assert.equal(f.contexts.length, 0, 'off by default and no autoplay/context allocation');
  assert.equal(await f.controller.notify({}, f.row), false);
  await f.controller.arm({ isTrusted: false }); await f.arm(); assert.equal(f.contexts.length, 0);
  assert.equal(await f.controller.preview({ isTrusted: false }), false);
  assert.equal(await f.controller.preview({ isTrusted: true }), true, 'explicit preview works without enabling alerts');
  assert.equal(f.contexts[0].oscillators.length, 2);
  assert.ok(f.contexts[0].oscillators.every(node => node.type === 'sine' && node.stopped - node.started < .2));
  assert.ok(f.contexts[0].gains.every(node => node.gain.events.every(([, value]) => value <= .045)), 'quiet gain and gentle ramps');
  assert.equal(f.claims.length, 0, 'preview does not consume the shared alert gate');
  f.contexts[0].oscillators.forEach(node => node.onended());
  assert.ok(f.contexts[0].gains.every(node => node.disconnected));
  f.settings.mentionSound = true;
  assert.equal(await f.controller.notify({}, f.row), true);
  const before = f.claims.length;
  assert.equal(await f.controller.notify({ history: true }, f.row), false);
  f.classes.add('fcm-hide'); assert.equal(await f.controller.notify({}, f.row), false); f.classes.delete('fcm-hide');
  f.classes.add('fcm-deleted'); assert.equal(await f.controller.notify({}, f.row), false); f.classes.delete('fcm-deleted');
  f.classes.delete('fcm-mentioned'); assert.equal(await f.controller.notify({}, f.row), false); f.classes.add('fcm-mentioned');
  assert.equal(f.claims.length, before);
  f.options.play = false; assert.equal(await f.controller.notify({}, f.row), false);
  f.options.play = true; f.options.claimError = true; assert.equal(await f.controller.notify({}, f.row), false);
  f.settings.mentionSound = false; f.controller.refresh(); await flush(); assert.equal(f.contexts[0].state, 'closed');
  f.controller.destroy(); assert.equal(f.listeners.size, 0); assert.equal(await f.controller.preview({ isTrusted: true }), false);

  const cold = fixture({ enabled: true }); assert.equal(await cold.controller.notify({}, cold.row), false, 'no queued sounds before user interaction');
  await cold.listeners.get('pointerdown')({ isTrusted: true }); await flush();
  assert.equal(await cold.controller.notify({}, cold.row), true);
  cold.controller.destroy();
  for (const options of [{ noAudio: true }, { constructorError: true }, { resumeError: true }, { toneError: true }]) {
    const broken = fixture(options); assert.equal(await broken.controller.preview({ isTrusted: true }), false); broken.controller.destroy();
  }
  const closing = fixture({ closeError: true }); await closing.controller.preview({ isTrusted: true }); closing.controller.refresh(); await flush();
  const throwing = fixture(); await throwing.controller.preview({ isTrusted: true }); throwing.contexts[0].close = () => { throw Error('fixture close'); }; throwing.controller.destroy();
  const notRunning = fixture({ resume: async context => { context.state = 'suspended'; } });
  assert.equal(await notRunning.controller.preview({ isTrusted: true }), false);
  const moved = fixture({ enabled: true }); await moved.arm();
  const secondListeners = new Map();
  moved.owner({ AudioContext: moved.AudioContext, document: { addEventListener: (type, fn) => secondListeners.set(type, fn), removeEventListener: type => secondListeners.delete(type) } });
  moved.controller.refresh(); assert.equal(moved.contexts[0].state, 'closed'); assert.equal(moved.listeners.size, 0);
  assert.equal(await moved.controller.notify({}, moved.row), false);
  await secondListeners.get('keydown')({ isTrusted: true }); assert.equal(await moved.controller.notify({}, moved.row), true);
  moved.owner(null); moved.controller.refresh(); moved.controller.destroy(); moved.controller.refresh();
  const noClaim = fixture({ enabled: true });
  const quiet = noClaim.F.createMentionSound({ getWindow: () => ({ document: noClaim.document, AudioContext: noClaim.AudioContext }), getSettings: () => noClaim.settings });
  // Stable owner identity is required for a running context.
  const win = { document: noClaim.document, AudioContext: noClaim.AudioContext };
  const defaultGate = noClaim.F.createMentionSound({ getWindow: () => win, getSettings: () => noClaim.settings });
  await defaultGate.arm({ isTrusted: true }); assert.equal(await defaultGate.notify({}, noClaim.row), false); defaultGate.destroy(); quiet.destroy();
  let release;
  const pending = fixture({ enabled: true, claim: () => new Promise(resolve => { release = resolve; }) }); await pending.arm();
  const first = pending.controller.notify({}, pending.row); await flush();
  assert.equal(await pending.controller.notify({}, pending.row), false, 'pending requests coalesce');
  pending.settings.mentionSound = false; release({ play: true }); assert.equal(await first, false, 'disabling during a request prevents playback');
  pending.controller.destroy();
  const ready = fixture({ enabled: true, running: true }); await ready.arm(); ready.contexts[0].state = 'suspended';
  assert.equal(await ready.controller.notify({}, ready.row), false); assert.equal(await ready.controller.notify({}, null), false);
  const schema = require('./mention-highlight.test').fixture().F;
  assert.equal(schema.DEFAULT_SETTINGS.mentionSound, false);
  const backup = schema.buildBackup({ settings: { ...schema.DEFAULT_SETTINGS, mentionSound: true } }, 'fixture');
  assert.equal(schema.readBackup(backup).stores.settings.mentionSound, true, 'sound choice follows existing backup semantics');
  const feed = require('./feed-performance.test').fixture();
  const accepted = [];
  feed.api.onMessage((message, row) => accepted.push({ message, row }));
  feed.api.addMessage({ platform: 'twitch', messageId: 'one', history: true });
  assert.equal(feed.api.addMessage({ platform: 'twitch', messageId: 'one' }), null);
  assert.equal(accepted.length, 1, 'duplicate rows never trigger notification callbacks');
  assert.equal(accepted[0].message.history, true);
  feed.api.destroy(); feed.api.addMessage({ platform: 'kick', messageId: 'closed' });
  assert.equal(accepted.length, 1, 'destroyed feeds cannot notify');
  const failedFeed = require('./feed-performance.test').fixture(); failedFeed.api.onMessage(() => { throw Error('fixture notifier'); });
  assert.ok(failedFeed.api.addMessage({ platform: 'twitch', messageId: 'safe' })); failedFeed.api.destroy();
  const readerTest = require('./youtube-reader.test');
  const reader = readerTest.fixture({ rows: [readerTest.row('old')] }); reader.ack();
  const initial = reader.posts.find(post => post.type === 'batch');
  assert.equal(initial.messages[0].history, true, 'initial YouTube rows are silent history');
  const checked = schema.youtube.sanitizeBatch(initial, initial.videoId, initial.run);
  assert.equal(checked.messages[0].history, true, 'the bounded relay preserves only true history metadata');
  reader.rows.push(readerTest.row('new')); reader.tick(5000, 'interval');
  assert.equal(reader.posts.at(-1).messages[0].history, undefined, 'later messages are live');
  reader.port.onDisconnect.fire();
  for (const [browser, loadPath] of [['chrome', 'worker'], ['firefox', 'scripts']]) {
    const worker = require('./background').bootWorker({ browser, loadPath });
    try {
      worker.sandbox.chrome.runtime.id = 'fixture';
      const settings = { mentionSound: true }; worker.sandbox.FCM.loadSettings = async () => settings;
      worker.connect();
      vm.runInContext("sessions.get(1).hostChannel = 'fixture'; globalThis.soundNow = 10000; Date.now = () => soundNow;", worker.sandbox);
      const sender = { id: 'fixture', frameId: 0, tab: { id: 1 } };
      const request = (from = sender) => new Promise(resolve => { assert.equal(worker.listeners.message({ cmd: 'mentionSound' }, from, resolve), true); });
      assert.equal((await request()).play, true);
      assert.equal((await request()).play, false, 'all chat tabs share the cooldown');
      worker.sandbox.soundNow = 15000;
      assert.equal((await request()).play, true);
      settings.mentionSound = false; worker.sandbox.soundNow = 20000;
      assert.equal((await request()).play, false);
      for (const from of [{ ...sender, id: 'other' }, { ...sender, frameId: 1 }, { ...sender, tab: { id: 999 } }, {}]) {
        assert.equal((await request(from)).play, false);
      }
      worker.sandbox.FCM.loadSettings = async () => { throw Error('fixture storage'); };
      assert.equal((await request()).play, false);
    } finally { worker.teardown(); }
  }
  const events = [], sound = { refresh() { events.push('refresh'); }, arm(event) { events.push(['arm', event.isTrusted]); },
    notify(message) { events.push(['message', message.history]); }, preview: async () => true, destroy() { events.push('destroy'); } };
  const ui = require('./youtube-sending-ui.test').fixture({ sound }); await ui.api.mount();
  ui.api.chat({ platform: 'twitch', text: 'hello', messageId: 'live' });
  ui.api.batch([{ platform: 'twitch', text: 'hello', messageId: 'history' }]);
  assert.ok(events.some(event => Array.isArray(event) && event[0] === 'message' && event[1] === true), 'history batches stay silent');
  ui.api.applyStoredSettings({ ...ui.FCM.DEFAULT_SETTINGS, mentionSound: true });
  assert.ok(events.includes('refresh'));
  ui.api.authError('twitch', { message: 'fixture' });
  ui.options.soundHooks.getWindow();
  assert.equal(ui.options.soundHooks.getSettings().mentionSound, true);
  await ui.options.soundHooks.claim();
  await ui.nodes.get('[data-act="preview-mention-sound"]').fire('click', { isTrusted: false });
  await ui.nodes.get('[data-act="preview-mention-sound"]').fire('click');
  sound.preview = async () => false;
  await ui.nodes.get('[data-act="preview-mention-sound"]').fire('click');
  await ui.popout();
  await ui.popout();
  ui.api.destroy(); assert.ok(events.includes('destroy'));
  console.log('Optional mention sound tests passed.');
}
module.exports = { run, fixture, flush };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
