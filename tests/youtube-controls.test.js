const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

async function fixture(withSuggestions = true, options = {}) {
  const elements = [];
  const doc = { createElement(tag) {
    const el = { tag, ownerDocument: doc, children: [], listeners: {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      appendChild(child) { this.children.push(child); },
      setAttribute(key, value) { this[key] = value; },
      addEventListener(key, fn) { this.listeners[key] = fn; },
      removeEventListener(key, fn) { assert.equal(this.listeners[key], fn); delete this.listeners[key]; },
      remove() { this.removed = true; },
      focus() { this.focused = true; },
    };
    elements.push(el); return el;
  } };
  const container = doc.createElement('div');
  const calls = [], starts = [], requests = [], source = { start: async value => { starts.push(value); return options.accepted !== false; },
    getSendState: () => ({ available: true, accountLabel: '@Viewer' }),
    send: async text => ({ outcome: 'submitted', text }),
    openAccessSetup() { calls.push('access-setup'); return options.accessSetup !== false; },
    closeAccessSetup() { calls.push('access-close'); },
    stop() { calls.push('stop'); callbacks.onStatus({ text: 'Stopped' }); },
    destroy() { calls.push('destroy'); },
  };
  let callbacks, suggestionOptions;
  const discovery = { pause() { calls.push("pause"); }, refresh() { calls.push("refresh"); },
    updateCounterpart(info) { calls.push(info); }, destroy() { calls.push("discovery-destroy"); } };
  let stored = options.link || null;
  const context = { URL, FCM: { PLATFORMS: ['twitch', 'kick'], createYouTubeSource(opts) { callbacks = opts; return source; } },
    chrome: { runtime: { getURL: p => 'chrome-extension://trial/' + p,
      async sendMessage(message) {
        requests.push(message);
        if (options.request) return options.request(message);
        if (message.cmd === 'youtubeLinkSave') stored = { channelUrl: message.channelUrl, at: 1 };
        if (message.cmd === 'youtubeLinkForget') stored = null;
        return { ok: true, link: stored, counterpart: options.counterpart || null };
      },
    } } };
  if (withSuggestions) context.FCM.createYouTubeSuggestions = options => { suggestionOptions = options; return discovery; };
  context.self = context;
  vm.createContext(context);
  const shared = path.join(ROOT, 'src/shared/youtube.js');
  vm.runInContext(fs.readFileSync(shared, 'utf8'), context, { filename: shared });
  const file = path.join(ROOT, 'src/content/youtube-controls.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const filter = new Set(['twitch', 'kick']);
  const rows = [], deletions = [], drops = [];
  const site = { id: options.platform || 'twitch', channelFromUrl: () => 'example' };
  const api = context.FCM.attachYouTubeControls({ site, channel: "example", container, filter, onFilterChange() { calls.push('filter'); },
    ...(options.sendState ? { onSendState: options.sendState } : {}),
    feed: { addMessage(row, f) { assert.equal(f, filter); rows.push(row); },
      applyFilter(f) { assert.equal(f, filter); calls.push('applyFilter'); },
      markMessageDeleted(...args) { deletions.push(args); }, dropPlatform(p) { drops.push(p); } } });
  const form = elements.find(e => e.tag === 'form');
  const add = elements.find(e => e.textContent === 'Add chat');
  const stop = elements.find(e => e.textContent === 'Remove YouTube');
  const input = elements.find(e => e.tag === 'input');
  const status = elements.find(e => e.role === 'status');
  const start = add.listeners.click;
  const event = { isTrusted: true, preventDefault() { calls.push('preventDefault'); } };
  const batch = { messages: [{ id: 'youtube:AbCdEfGhI_0:one', username: '@fixture', displayName: 'Fixture', text: '<safe> 😀', ts: 100 }], deleted: ['youtube:AbCdEfGhI_0:two'] };
  const save = elements.find(e => e.textContent === 'Save YouTube link');
  const forget = elements.find(e => e.textContent === 'Forget YouTube link');
  const pairCheck = elements.find(e => e.type === 'checkbox');
  const note = elements.find(e => e.className === 'fcm-youtube-link-note');
  if (!options.pending) await flush();
  calls.length = 0;
  return { api, callbacks, suggestionOptions, discovery, container, source, filter, rows, deletions, drops, elements, form, add, stop, input, status, calls, start, event, batch,
    site, starts, requests, save, forget, pairCheck, note, options };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

async function run() {
  const f = await fixture();
  assert.equal(f.elements.find(e => e.tag === 'summary').textContent, 'YouTube', 'YouTube is a normal chat source');
  assert.equal(f.api.getSendState().accountLabel, '@Viewer');
  assert.equal((await f.api.send('hello')).text, 'hello');
  assert.equal(f.api.openAccessSetup(), true);
  assert.equal(f.calls.filter(call => call === 'access-setup').length, 1);
  f.options.accessSetup = false;
  assert.equal(f.api.openAccessSetup(), false, 'setup failure reaches the overlay without pretending it opened');
  f.api.closeAccessSetup();
  assert.equal(f.calls.filter(call => call === 'access-close').length, 1);
  f.callbacks.onSendState({ available: false });
  assert.equal(f.stop.disabled, true);
  assert.equal(f.input['aria-label'], 'YouTube live video or channel URL');
  assert.match(f.input.placeholder, /@channel/);
  assert.match(f.status.textContent, /live video or channel URL/);
  assert.equal(f.filter.has('youtube'), false);
  let starts = 0;
  f.source.start = async () => { starts++; return true; };
  await f.start({ ...f.event, isTrusted: false });
  f.form.listeners.submit(f.event);
  f.input.listeners.keydown({ ...f.event, key: 'x' });
  f.input.listeners.keydown({ ...f.event, key: 'Enter', isTrusted: false });
  assert.equal(starts, 0, 'page-triggered clicks, key events and form submits cannot opt in');
  f.input.listeners.keydown({ ...f.event, key: 'Enter' }); await Promise.resolve();
  assert.equal(starts, 1, 'trusted keyboard activation works');
  f.stop.listeners.click();
  f.callbacks.onBatch(f.batch); assert.equal(f.rows.length, 0, 'off by default');
  f.input.value = 'https://www.youtube.com/watch?v=AbCdEfGhI_0';
  f.source.start = async value => { assert.equal(value, f.input.value); return true; };
  await f.start(f.event);
  f.callbacks.onStatus({ text: 'Connected — read only' });
  assert.equal(f.status.textContent, 'Connected — read only');
  f.callbacks.onBatch(f.batch);
  assert.equal(f.filter.has('youtube'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.rows[0])), {
    platform: 'youtube', messageId: f.batch.messages[0].id, author: 'Fixture', login: '@fixture',
    text: '<safe> 😀', timestamp: 100, readOnly: true,
  });
  assert.deepEqual(f.deletions, [['youtube', f.batch.deleted[0]]]);
  f.filter.delete('twitch'); f.filter.delete('kick');
  f.stop.listeners.click();
  assert.equal(f.filter.has('youtube'), false);
  assert.deepEqual([...f.filter], ['twitch', 'kick'], 'removing the only visible source restores the normal chats');
  assert.ok(f.calls.includes('filter')); assert.ok(f.calls.includes('applyFilter'));
  f.callbacks.onBatch(f.batch); assert.equal(f.rows.length, 1, 'late batch after Stop ignored');
  assert.equal(f.status.textContent, 'Stopped');
  f.input.value = 'https://www.youtube.com/@SyntheticChannel';
  f.source.start = async value => { assert.equal(value, f.input.value); return true; };
  await f.start(f.event); assert.equal(f.stop.disabled, false, 'channel URLs reach the source unchanged');
  f.stop.listeners.click();
  f.source.start = async () => false; await f.start(f.event); assert.equal(f.stop.disabled, true);
  f.source.start = async () => { throw Error('unavailable'); };
  await f.start(f.event); assert.match(f.status.textContent, /could not start/);
  assert.equal(f.add.disabled, false);
  let resolve;
  f.source.start = () => new Promise(r => { resolve = r; });
  const pending = f.start(f.event); await f.start(f.event);
  assert.equal(f.add.disabled, true, 'duplicate starts ignored while pending');
  f.stop.listeners.click(); resolve(true); await pending;
  assert.equal(f.stop.disabled, true, 'stale result cannot revive a stopped capture');
  let reject;
  f.source.start = () => new Promise((_, r) => { reject = r; });
  const old = f.start(f.event); f.stop.listeners.click(); reject(Error('late')); await old;
  const latestStatus = f.status.textContent;
  f.source.start = () => new Promise(r => { resolve = r; });
  const destroyed = f.start(f.event); f.api.destroy(); f.api.destroy(); resolve(true); await destroyed;
  const accessCalls = f.calls.filter(call => call === 'access-setup').length;
  assert.equal(f.api.openAccessSetup(), false, 'destroyed controls cannot reveal the sender frame');
  assert.equal(f.calls.filter(call => call === 'access-setup').length, accessCalls);
  f.api.closeAccessSetup();
  assert.equal(f.calls.filter(call => call === 'access-close').length, 1, 'destroyed controls cannot cancel a later source');
  f.callbacks.onBatch(f.batch); f.callbacks.onStatus({ text: 'late' }); await f.start(f.event);
  assert.equal(f.status.textContent, latestStatus);
  assert.equal(f.rows.length, 1);
  assert.equal(f.form.listeners.submit, undefined);
  assert.equal(f.add.listeners.click, undefined);
  assert.equal(f.input.listeners.keydown, undefined);
  assert.equal(f.stop.listeners.click, undefined);
  assert.equal(f.calls.filter(c => c === 'destroy').length, 1);
  const g = await fixture(); g.source.start = () => new Promise((_, r) => { reject = r; });
  const rejected = g.start(g.event); g.api.destroy(); reject(Error('destroyed')); await rejected;
  assert.ok(g.elements.find(e => e.tag === 'details').removed);
  const h = await fixture();
  const result = { channelUrl: 'https://www.youtube.com/@Suggested', videoId: 'AbCdEfGhI_0', match: 'same-name', label: '@Suggested' };
  const suggestionBox = h.elements.find(e => e.className === 'fcm-youtube-suggestions');
  assert.equal(suggestionBox.hidden, true);
  assert.equal(h.suggestionOptions.channel, 'example');
  assert.equal(h.suggestionOptions.site.id, 'twitch');
  assert.equal(h.suggestionOptions.document, h.container.ownerDocument);
  h.input.value = 'https://www.youtube.com/@MyChoice';
  h.suggestionOptions.onSuggestions([result]);
  assert.equal(suggestionBox.hidden, false);
  assert.equal(h.input.value, 'https://www.youtube.com/@MyChoice', 'suggestions never overwrite a typed URL');
  const row = suggestionBox.children[0];
  assert.match(row.children[0].textContent, /Possible same-name match/);
  assert.equal(row.children[1].href, result.channelUrl);
  const candidateAdd = row.children[2];
  let suggestedStarts = 0;
  h.source.start = async value => { assert.equal(value, result.channelUrl); suggestedStarts++; return true; };
  await candidateAdd.listeners.click({ ...h.event, isTrusted: false });
  assert.equal(suggestedStarts, 0);
  await candidateAdd.listeners.click(h.event);
  assert.equal(suggestedStarts, 1);
  assert.equal(h.input.value, 'https://www.youtube.com/@MyChoice');
  assert.equal(suggestionBox.hidden, true);
  assert.equal(h.elements.find(e => e.tag === 'details').open, true);
  const refresh = h.elements.find(e => e.textContent === 'Check YouTube');
  refresh.listeners.click(h.event);
  assert.ok(!h.calls.includes('refresh'), 'cannot look up suggestions while capture is active');
  h.suggestionOptions.onSuggestions([result]); assert.equal(suggestionBox.hidden, true);
  h.stop.listeners.click();
  refresh.listeners.click({ ...h.event, isTrusted: false }); assert.ok(!h.calls.includes('refresh'));
  refresh.listeners.click(h.event); assert.ok(h.calls.includes('refresh'));
  h.suggestionOptions.onSuggestions([{ ...result, match: 'page-link' }]);
  assert.match(suggestionBox.children[0].children[0].textContent, /Linked on this page/);
  await candidateAdd.listeners.click(h.event); assert.equal(suggestedStarts, 1, 'stale suggestion button cannot start capture');
  const dismiss = h.elements.filter(e => e.textContent === 'Dismiss').at(-1);
  dismiss.listeners.click({ ...h.event, isTrusted: false }); assert.equal(suggestionBox.hidden, false);
  dismiss.listeners.click(h.event); assert.equal(suggestionBox.hidden, true);
  h.api.updateCounterpart({ channel: 'other' }); assert.deepEqual(h.calls.at(-1), { channel: 'other' });
  h.api.destroy();
  h.suggestionOptions.onSuggestions([result]); refresh.listeners?.click?.(h.event);
  assert.equal(suggestionBox.hidden, true); assert.ok(suggestionBox.removed);
  assert.equal(h.calls.filter(c => c === 'discovery-destroy').length, 1);
  h.api.updateCounterpart(null);
  const noDiscovery = await fixture(false);
  noDiscovery.api.updateCounterpart(null);
  const check = noDiscovery.elements.find(e => e.textContent === 'Check YouTube');
  check.listeners.click(noDiscovery.event);
  await noDiscovery.start(noDiscovery.event); noDiscovery.stop.listeners.click(); noDiscovery.api.destroy();
  await savedLinks();
  const states = [], sending = await fixture(true, { sendState: state => states.push(state) });
  sending.callbacks.onSendState({ available: true });
  assert.equal(states.length, 1);
  sending.api.destroy(); sending.callbacks.onSendState({ available: false });
  assert.equal(states.length, 1, 'destroyed controls never revive a send target');
  console.log('YouTube controls unit tests passed.');
}

async function savedLinks() {
  const link = { channelUrl: 'https://www.youtube.com/@SavedCreator', at: 1 };
  const counterpart = { platform: 'kick', channel: 'paired', link: null };
  for (const platform of ['twitch', 'kick']) {
    const f = await fixture(true, { link, platform });
    assert.deepEqual(f.starts, [link.channelUrl], 'a saved channel is freshly resolved on arrival');
    assert.equal(f.input.value, link.channelUrl);
    assert.match(f.note.textContent, new RegExp(`Saved for ${platform}/example`));
    assert.equal(f.requests[0].platform, platform);
    const box = f.elements.find(e => e.className === 'fcm-youtube-suggestions');
    f.suggestionOptions.onSuggestions([{ channelUrl: 'https://www.youtube.com/@Guess' }]);
    assert.equal(box.hidden, true, 'saved links take precedence over guesses');
    f.stop.listeners.click();
    assert.equal(f.requests.length, 1, 'Remove pauses the visit without writing storage');
    await f.elements.find(e => e.textContent === 'Check YouTube').listeners.click(f.event);
    assert.deepEqual(f.starts, [link.channelUrl, link.channelUrl], 'Check retries the saved channel');
    f.input.value = 'https://www.youtube.com/@Temporary';
    await f.start(f.event);
    assert.equal(f.starts.at(-1), f.input.value);
    assert.equal(f.requests.length, 1, 'manual Add never changes the saved link');
    await f.forget.listeners.click({ ...f.event, isTrusted: false });
    assert.equal(f.requests.length, 1);
    await f.forget.listeners.click(f.event);
    assert.equal(f.requests.at(-1).cmd, 'youtubeLinkForget');
    assert.equal(f.stop.disabled, true);
    assert.equal(f.forget.disabled, true);
    await f.forget.listeners.click(f.event);
    f.api.destroy();
  }
  const offline = await fixture(true, { link, accepted: false });
  assert.equal(offline.stop.disabled, true);
  assert.equal(offline.forget.disabled, false, 'offline or permission-denied startup keeps the saved link');
  assert.equal(offline.elements.find(e => e.textContent === 'Check YouTube').disabled, false);
  offline.api.destroy();

  const f = await fixture(true, { counterpart });
  const pairLabel = f.elements.find(e => e.className === 'fcm-youtube-pair');
  assert.equal(pairLabel.hidden, false);
  assert.match(pairLabel.children[1].textContent, /Also link kick\/paired/);
  f.input.value = link.channelUrl;
  await f.save.listeners.click({ ...f.event, isTrusted: false });
  assert.equal(f.requests.length, 1, 'page events cannot persist authorization');
  f.input.value = 'garbage'; await f.save.listeners.click(f.event);
  assert.match(f.note.textContent, /Use a YouTube channel URL/);
  f.input.value = 'https://www.youtube.com/watch?v=AbCdEfGhI_0'; await f.save.listeners.click(f.event);
  assert.equal(f.requests.length, 1, 'ephemeral videos cannot become future auto-load links');
  f.input.value = link.channelUrl + '/streams';
  f.pairCheck.checked = true;
  await f.save.listeners.click(f.event);
  assert.equal(f.requests.at(-1).counterpartChannel, 'paired');
  assert.equal(f.requests.at(-1).channelUrl, link.channelUrl);
  assert.equal(f.pairCheck.checked, false);
  assert.equal(f.starts.at(-1), link.channelUrl);
  f.stop.listeners.click();
  f.options.counterpart = { ...counterpart, link };
  f.api.openLinks(); await flush();
  assert.equal(f.input.focused, true);
  assert.match(pairLabel.children[1].textContent, /replace https:\/\/www.youtube.com/);
  assert.equal(f.starts.length, 1, 'opening settings does not resume a paused visit');
  await f.save.listeners.click(f.event);
  assert.equal('counterpartChannel' in f.requests.at(-1), false, 'pair propagation requires explicit selection each time');
  f.api.destroy(); f.api.openLinks();

  const noPair = await fixture(false);
  noPair.pairCheck.checked = true;
  noPair.input.value = link.channelUrl;
  await noPair.save.listeners.click(noPair.event);
  assert.equal('counterpartChannel' in noPair.requests.at(-1), false);
  noPair.api.destroy();

  let resolve;
  const deferred = () => new Promise(r => { resolve = r; });
  const late = await fixture(true, { pending: true, request: deferred });
  late.suggestionOptions.onSuggestions([{ channelUrl: link.channelUrl }]);
  assert.equal(late.elements.find(e => e.className === 'fcm-youtube-suggestions').hidden, true);
  await late.save.listeners.click(late.event);
  late.input.value = 'https://www.youtube.com/@Typed';
  await late.start(late.event);
  resolve({ ok: true, link, counterpart: null }); await flush();
  assert.deepEqual(late.starts, [late.input.value], 'a late saved read cannot replace a manual choice');
  late.api.destroy();
  const stopped = await fixture(true, { pending: true, request: deferred });
  stopped.stop.listeners.click(); resolve({ ok: true, link }); await flush();
  assert.equal(stopped.starts.length, 0, 'a late read cannot resume a removed source');
  stopped.api.destroy();
  const gone = await fixture(true, { pending: true, request: deferred });
  gone.api.destroy(); resolve({ ok: true, link }); await flush();
  assert.equal(gone.starts.length, 0);
  const nav = await fixture(true, { pending: true, request: deferred });
  nav.site.channelFromUrl = () => 'someone-else'; resolve({ ok: true, link }); await flush();
  assert.equal(nav.starts.length, 0, 'SPA changes guard the interval before overlay teardown');
  nav.api.destroy();
  const overlap = await fixture(true, { pending: true, request: deferred });
  const firstRead = resolve;
  overlap.api.openLinks(); const secondRead = resolve;
  firstRead({ ok: true, link }); secondRead({ ok: true, link: null, counterpart: null }); await flush();
  assert.equal(overlap.starts.length, 0, 'new reads invalidate older results');
  overlap.api.destroy();

  for (const response of [null, { ok: false }]) {
    const bad = await fixture(true, { request: async () => response });
    assert.match(bad.note.textContent, /Could not read/);
    bad.options.request = async () => ({ ok: true, link: null, counterpart: null });
    bad.api.openLinks(); await flush();
    assert.equal(bad.save.disabled, false);
    bad.options.request = async () => response;
    bad.input.value = link.channelUrl;
    await bad.save.listeners.click(bad.event);
    assert.match(bad.note.textContent, /was not saved/);
    assert.equal(bad.starts.length, 0);
    bad.api.destroy();
  }
  const failure = await fixture(true, { request: async () => { throw Error('offline worker'); } });
  assert.match(failure.note.textContent, /Could not read/);
  failure.api.destroy();
  for (const response of [null, { ok: false }]) {
    const bad = await fixture(true, { link });
    bad.options.request = async () => response;
    await bad.forget.listeners.click(bad.event);
    assert.match(bad.note.textContent, /could not be removed/);
    assert.equal(bad.forget.disabled, false, 'failed deletion preserves the link and offers retry');
    bad.api.destroy();
  }
  const write = await fixture(true);
  write.input.value = link.channelUrl;
  write.options.request = deferred;
  const pendingSave = write.save.listeners.click(write.event);
  await write.save.listeners.click(write.event);
  write.api.openLinks();
  assert.equal(write.requests.length, 2, 'opening while saving does not race storage reads');
  write.stop.listeners.click(); resolve({ ok: true, link }); await pendingSave;
  assert.equal(write.starts.length, 0, 'Remove during a save prevents automatic startup');
  assert.match(write.note.textContent, /Saved for/);
  write.api.destroy();
  for (const action of ['save', 'forget']) {
    const closing = await fixture(true, { link });
    closing.input.value = link.channelUrl;
    closing.options.request = deferred;
    const pending = closing[action].listeners.click(closing.event);
    closing.api.destroy(); resolve({ ok: true, link }); await pending;
  }
  const wrongPage = await fixture(true);
  wrongPage.site.channelFromUrl = () => { throw Error('page unloading'); };
  wrongPage.source.send = () => { throw Error('stale source must not receive a send'); };
  wrongPage.source.openAccessSetup = () => { throw Error('stale source must not open access setup'); };
  wrongPage.source.closeAccessSetup = () => { throw Error('stale source must not close access setup'); };
  assert.equal((await wrongPage.api.send('old channel')).reason, 'not-current');
  assert.equal(wrongPage.api.openAccessSetup(), false);
  wrongPage.api.closeAccessSetup();
  await wrongPage.start(wrongPage.event);
  wrongPage.callbacks.onStatus({ text: 'stale' }); wrongPage.callbacks.onBatch(wrongPage.batch);
  wrongPage.api.openLinks(); await wrongPage.save.listeners.click(wrongPage.event);
  await wrongPage.forget.listeners.click(wrongPage.event);
  await wrongPage.elements.find(e => e.textContent === 'Check YouTube').listeners.click(wrongPage.event);
  wrongPage.suggestionOptions.onSuggestions([]);
  assert.equal(wrongPage.starts.length, 0);
  wrongPage.api.destroy();
}
module.exports = run;
if (require.main === module) run().catch(e => { console.error(e); process.exitCode = 1; });
