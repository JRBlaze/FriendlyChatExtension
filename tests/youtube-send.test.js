const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FILE = path.resolve(__dirname, '../src/content/youtube-send.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));

function element(text = '', parent = null) {
  return { textContent: text, parentElement: parent, isConnected: true, attrs: new Map(), children: new Map(), disabled: false,
    tagName: 'DIV', style: { display: 'block', visibility: 'visible' },
    hasAttribute(key) { return this.attrs.has(key); },
    getAttribute(key) { return this.attrs.get(key) ?? null; },
    querySelector(key) { return this.children.get(key) || null; },
  };
}

function fixture(options = {}) {
  const parent = element(), root = element('', parent), author = element('@Viewer', root);
  const input = element('', root), button = element('', root), error = element('', root);
  input.attrs.set('contenteditable', ''); button.disabled = true;
  root.children.set('#author-name', author);
  root.children.set('yt-live-chat-text-input-field-renderer div#input[contenteditable]', input);
  root.children.set('#send-button button', button);
  root.children.set('#error-message', error);
  const state = { parent, root, author, input, button, error, states: [], results: [], events: [], timers: new Map(),
    now: 100, serial: 0, clicks: 0, current: true, autoEnable: options.autoEnable !== false,
    onInput: null, onClick: null, onState: null, onQuery: null, onCurrent: null,
  };
  input.dispatchEvent = event => {
    state.events.push(copy(event));
    if (state.autoEnable) button.disabled = !input.textContent;
    if (state.onInput) state.onInput(event);
    return true;
  };
  button.click = () => { state.clicks++; if (state.onClick) state.onClick(); };
  const context = vm.createContext({ FCM: {},
    Date: class extends Date { static now() { return state.now; } },
    InputEvent: class { constructor(type, values) { this.type = type; Object.assign(this, values); } },
    setTimeout(fn, delay) { const id = ++state.serial; state.timers.set(id, { fn, at: state.now + delay }); return id; },
    clearTimeout(id) { state.timers.delete(id); },
  });
  context.self = context;
  vm.runInContext(SOURCE, context, { filename: FILE });
  if (options.setup) options.setup(state);
  state.sender = context.FCM.createYouTubeSender({
    document: { defaultView: { getComputedStyle: item => item.style }, querySelector(selector) {
      assert.equal(selector, 'yt-live-chat-message-input-renderer');
      if (state.onQuery) state.onQuery();
      return state.root;
    } },
    onState(value) { state.states.push(copy(value)); if (state.onState) state.onState(value); },
    onResult(value) { state.results.push(copy(value)); },
    isCurrent() { return state.onCurrent ? state.onCurrent() : state.current; },
  });
  state.status = () => state.states.at(-1);
  state.send = (text = 'A test message', overrides = {}) => state.sender.send({ sequence: 1, capability: state.status().capability, text, ...overrides });
  state.tick = ms => {
    state.now += ms;
    for (const [id, timer] of [...state.timers]) if (timer.at <= state.now) {
      state.timers.delete(id); timer.fn();
    }
  };
  return state;
}

function result(state, outcome, reason) {
  assert.equal(state.results.at(-1).outcome, outcome);
  assert.equal(state.results.at(-1).reason, reason);
}

async function run() {
  const ready = fixture();
  assert.deepEqual(ready.status(), { available: true, reason: 'ready', accountLabel: '@Viewer', capability: 1, maxLength: 200 });
  ready.sender.refresh(); assert.equal(ready.states.length, 1, 'unchanged refresh does not flood the relay');
  ready.onClick = () => { ready.input.textContent = ''; };
  ready.send(' Exact text 😀 ');
  assert.equal(ready.clicks, 1, 'one native activation');
  result(ready, 'submitted', 'submitted');
  assert.equal(ready.results[0].sequence, 1);
  assert.deepEqual(ready.events[0], { type: 'input', bubbles: true, composed: true, inputType: 'insertText', data: ' Exact text 😀 ' });
  assert.equal(ready.status().available, true);
  assert.equal(ready.status().capability, 1, 'busy state keeps the account/composer capability');
  assert.ok(ready.states.some(state => state.reason === 'busy' && !state.available));
  assert.equal(ready.timers.size, 0);
  ready.send(); ready.sender.send(null); ready.sender.send({ sequence: 1.5 }); ready.sender.send({ sequence: 0 });
  assert.equal(ready.clicks, 1, 'duplicate and invalid sequences cannot activate native send');
  ready.send('x'.repeat(200), { sequence: 2 }); assert.equal(ready.clicks, 2);
  assert.equal(ready.events[1].data.length, 200);

  for (const text of ['', ' \t ', 'x'.repeat(201), 'line\nbreak', '\u0000hi', 'hi\u007f', '\u009fhi', 1, null]) {
    const invalid = fixture(); invalid.send(text); result(invalid, 'not-sent', 'invalid-request'); assert.equal(invalid.clicks, 0);
  }
  for (const capability of [0, -1, 1.5, NaN, '1']) {
    const invalid = fixture(); invalid.send('text', { capability }); result(invalid, 'not-sent', 'invalid-request');
  }
  const stale = fixture(); stale.send('text', { capability: 2 }); result(stale, 'not-sent', 'stale-capability');
  const existing = fixture(); existing.input.textContent = 'Existing draft'; existing.send();
  result(existing, 'not-sent', 'draft-not-empty'); assert.equal(existing.input.textContent, 'Existing draft'); assert.equal(existing.events.length, 0);

  for (const change of [state => { state.root = null; }, state => { state.root.isConnected = false; },
    state => state.root.children.delete('yt-live-chat-text-input-field-renderer div#input[contenteditable]'),
    state => state.root.children.delete('#send-button button'), state => { state.input.isConnected = false; },
    state => { state.button.isConnected = false; }, state => { state.onQuery = () => { throw Error('gone'); }; }]) {
    const unavailable = fixture({ setup: change });
    assert.equal(unavailable.status().reason, 'composer-unavailable'); unavailable.send(); result(unavailable, 'not-sent', 'composer-unavailable');
  }
  for (const change of [state => state.root.children.delete('#author-name'), state => { state.author.textContent = ''; },
    state => { state.author.textContent = '@'.repeat(101); }, state => { state.author.textContent = '@\u0000test'; },
    state => state.author.attrs.set('hidden', ''), state => state.author.attrs.set('aria-hidden', 'true')]) {
    const signedOut = fixture({ setup: change });
    assert.equal(signedOut.status().reason, 'signed-out'); assert.equal(signedOut.status().accountLabel, '');
    signedOut.send(); result(signedOut, 'not-sent', 'signed-out');
  }
  const normalized = fixture({ setup: state => { state.author.textContent = ' \n @Display  Name \t '; } });
  assert.equal(normalized.status().accountLabel, '@Display Name');
  for (const [which, attribute, value] of [
    ['parent', 'hidden', ''], ['root', 'hidden', ''], ['input', 'hidden', ''], ['input', 'contenteditable', 'false'],
    ['input', 'disabled', ''], ['input', 'readonly', ''], ['input', 'aria-disabled', 'true'],
    ['root', 'disabled', ''], ['root', 'aria-disabled', 'true'],
  ]) {
    const blocked = fixture({ setup: state => state[which].attrs.set(attribute, value) });
    assert.equal(blocked.status().reason, 'restricted'); blocked.send(); result(blocked, 'not-sent', 'restricted');
  }
  const blockedCountdown = fixture({ setup: state => state.root.attrs.set('block-send-message-with-countdown', '') });
  assert.equal(blockedCountdown.status().reason, 'ready', 'normal countdown attribute does not disable the composer');
  for (const which of ['parent', 'root', 'input']) {
    for (const [property, value] of [['display', 'none'], ['visibility', 'hidden'], ['visibility', 'collapse']]) {
      const blocked = fixture({ setup: state => { state[which].style[property] = value; } });
      assert.equal(blocked.status().reason, 'restricted'); blocked.send(); result(blocked, 'not-sent', 'restricted');
      assert.equal(blocked.clicks, 0);
    }
  }

  // Live YouTube keeps the bound account chip hidden even after drafting. Its
  // native Send wrapper starts hidden and is revealed by the input handler.
  for (const hiddenButton of [false, true]) {
    const idle = fixture({ setup: state => {
      const chip = element('', state.root); chip.tagName = 'YT-LIVE-CHAT-AUTHOR-CHIP';
      chip.attrs.set('hidden', ''); chip.style.display = 'none'; state.author.parentElement = chip;
      const wrapper = element('', state.root); state.button.parentElement = wrapper;
      if (hiddenButton) { wrapper.attrs.set('hidden', ''); wrapper.style.display = 'none'; }
    } });
    assert.equal(idle.status().reason, 'ready'); assert.equal(idle.status().accountLabel, '@Viewer');
    const originalCapability = idle.status().capability;
    idle.onClick = () => {
      idle.input.textContent = ''; idle.button.disabled = true;
      idle.button.parentElement.attrs.set('hidden', ''); idle.button.parentElement.style.display = 'none';
    };
    idle.send();
    if (hiddenButton) {
      assert.equal(idle.clicks, 0, 'an enabled button still hidden while preparing cannot be activated');
      idle.tick(100); assert.equal(idle.clicks, 0);
      idle.button.parentElement.attrs.delete('hidden'); idle.button.parentElement.style.display = 'block';
      idle.tick(100);
    }
    result(idle, 'submitted', 'submitted'); assert.equal(idle.clicks, 1);
    assert.equal(idle.status().capability, originalCapability, 'collapsed presentation does not change account identity');
    assert.equal(idle.author.parentElement.attrs.has('hidden'), true);
    idle.author.textContent = '@viewer'; idle.sender.refresh();
    assert.ok(idle.status().capability > originalCapability, 'a hidden bound account still detects case-sensitive changes');
  }
  for (const useStyle of [false, true]) {
    const hiddenButton = fixture({ setup: state => {
      const wrapper = element('', state.root); state.button.parentElement = wrapper;
      if (useStyle) wrapper.style.display = 'none'; else wrapper.attrs.set('hidden', '');
    } });
    assert.equal(hiddenButton.status().reason, 'ready', 'idle button visibility is not account availability');
    hiddenButton.send(); hiddenButton.tick(1000);
    result(hiddenButton, 'not-sent', 'restricted'); assert.equal(hiddenButton.clicks, 0);
    assert.equal(hiddenButton.input.textContent, '', 'a blocked prepared draft is cleared without activation');
    assert.equal(hiddenButton.timers.size, 0);
  }
  const noCurrent = fixture({ setup: state => { state.current = false; } });
  noCurrent.send(); result(noCurrent, 'not-sent', 'not-current');
  const currentThrows = fixture({ setup: state => { state.onCurrent = () => { throw Error('context gone'); }; } });
  currentThrows.send(); result(currentThrows, 'not-sent', 'not-current');

  const deferred = fixture({ autoEnable: false });
  deferred.send(); assert.equal(deferred.clicks, 0);
  deferred.send('second', { sequence: 2 }); result(deferred, 'not-sent', 'busy');
  deferred.send('replayed', { sequence: 1 }); assert.equal(deferred.results.length, 1);
  deferred.button.disabled = false; deferred.tick(100); assert.equal(deferred.clicks, 1);
  deferred.input.textContent = ''; deferred.tick(100); result(deferred, 'submitted', 'submitted');
  assert.equal(deferred.results.at(-1).sequence, 1, 'the first pending request retains its identity');
  deferred.tick(5000); assert.equal(deferred.clicks, 1);

  for (const blocker of [state => { state.button.disabled = true; },
    state => { state.button.disabled = false; state.button.attrs.set('disabled', ''); },
    state => { state.button.disabled = false; state.button.attrs.set('aria-disabled', 'true'); }]) {
    const timeout = fixture({ autoEnable: false }); blocker(timeout); timeout.send(); timeout.tick(1000);
    result(timeout, 'not-sent', 'timeout'); assert.equal(timeout.clicks, 0); assert.equal(timeout.input.textContent, '');
    assert.equal(timeout.events.at(-1).inputType, 'deleteContentBackward');
  }
  const uncertain = fixture(); uncertain.send(); uncertain.tick(2000);
  result(uncertain, 'uncertain', 'timeout'); assert.equal(uncertain.clicks, 1);
  assert.equal(uncertain.input.textContent, 'A test message', 'uncertain post-click drafts are never cleared or retried');
  uncertain.tick(10000); assert.equal(uncertain.results.length, 1);

  for (const clicked of [false, true]) {
    for (const change of ['account', 'input', 'button', 'root', 'current', 'restriction', 'error', 'edited']) {
      const changing = fixture({ autoEnable: clicked }); changing.send();
      const previousCapability = changing.status().capability;
      if (change === 'account') changing.author.textContent = '@DifferentAccount';
      if (change === 'input') changing.root.children.set('yt-live-chat-text-input-field-renderer div#input[contenteditable]', element('', changing.root));
      if (change === 'button') changing.root.children.set('#send-button button', element('', changing.root));
      if (change === 'root') { const replacement = element(); replacement.children = changing.root.children; changing.root = replacement; }
      if (change === 'current') changing.current = false;
      if (change === 'restriction') changing.input.attrs.set('contenteditable', 'false');
      if (change === 'error') changing.error.textContent = 'Slow mode';
      if (change === 'edited') changing.input.textContent = 'User changed draft';
      changing.tick(100);
      result(changing, clicked ? 'uncertain' : 'not-sent', ['account', 'input', 'button', 'root'].includes(change)
        ? 'stale-capability' : change === 'current' ? 'not-current' : change === 'restriction' ? 'restricted' : change === 'error' ? 'native-error' : 'input-rejected');
      assert.equal(changing.clicks, clicked ? 1 : 0);
      if (change === 'edited') assert.equal(changing.input.textContent, 'User changed draft');
      if (change === 'account') assert.ok(changing.status().capability > previousCapability);
    }
  }

  const error = fixture(); error.error.textContent = 'Cannot send'; error.send();
  result(error, 'not-sent', 'native-error'); assert.equal(error.events.length, 0);
  const hiddenError = fixture(); hiddenError.error.textContent = 'An old error'; hiddenError.error.attrs.set('hidden', '');
  hiddenError.onClick = () => { hiddenError.input.textContent = ''; }; hiddenError.send(); result(hiddenError, 'submitted', 'submitted');
  for (const [property, value] of [['display', 'none'], ['visibility', 'hidden'], ['visibility', 'collapse']]) {
    const cssError = fixture(); cssError.error.textContent = 'An inactive error'; cssError.error.style[property] = value;
    cssError.onClick = () => { cssError.input.textContent = ''; }; cssError.send(); result(cssError, 'submitted', 'submitted');
  }
  const noError = fixture(); noError.root.children.delete('#error-message'); noError.onClick = () => { noError.input.textContent = ''; };
  noError.send(); result(noError, 'submitted', 'submitted');
  const errorThrows = fixture(); errorThrows.root.querySelector = selector => {
    if (selector === '#error-message') throw Error('unavailable');
    return errorThrows.root.children.get(selector);
  };
  errorThrows.send(); result(errorThrows, 'not-sent', 'composer-unavailable');

  const dispatchThrows = fixture(); dispatchThrows.onInput = () => { throw Error('input handler'); };
  dispatchThrows.send(); result(dispatchThrows, 'not-sent', 'input-rejected'); assert.equal(dispatchThrows.clicks, 0);
  const nativeThrows = fixture(); nativeThrows.onClick = () => { throw Error('native activation'); };
  nativeThrows.send(); result(nativeThrows, 'uncertain', 'native-error'); assert.equal(nativeThrows.clicks, 1);
  const inputChanged = fixture(); inputChanged.onInput = () => { inputChanged.input.textContent = 'Different'; };
  inputChanged.send(); result(inputChanged, 'not-sent', 'input-rejected'); assert.equal(inputChanged.input.textContent, 'Different');
  const handlerAccount = fixture(); handlerAccount.onInput = () => { handlerAccount.author.textContent = '@viewer'; };
  handlerAccount.send(); result(handlerAccount, 'not-sent', 'stale-capability'); assert.equal(handlerAccount.clicks, 0, 'account identity is case-sensitive');
  const handlerError = fixture(); handlerError.onInput = () => { handlerError.error.textContent = 'Restricted'; };
  handlerError.send(); result(handlerError, 'not-sent', 'native-error');

  const lastCurrent = fixture(); lastCurrent.onInput = event => {
    if (event.inputType === 'insertText') { let calls = 0; lastCurrent.onCurrent = () => ++calls === 1; }
  };
  lastCurrent.send(); result(lastCurrent, 'not-sent', 'not-current'); assert.equal(lastCurrent.clicks, 0, 'current session is checked immediately before activation');
  const lastIdentity = fixture(); lastIdentity.onInput = event => {
    if (event.inputType === 'insertText') {
      let calls = 0; lastIdentity.onQuery = () => { if (++calls === 2) lastIdentity.author.textContent = '@Other'; };
    }
  };
  lastIdentity.send(); result(lastIdentity, 'not-sent', 'stale-capability'); assert.equal(lastIdentity.clicks, 0);

  for (const clicked of [false, true]) {
    const destroyed = fixture({ autoEnable: clicked }); destroyed.send();
    const staleTimer = [...destroyed.timers.values()][0].fn;
    destroyed.sender.destroy(); destroyed.sender.destroy(); destroyed.sender.refresh(); staleTimer();
    result(destroyed, clicked ? 'uncertain' : 'not-sent', 'disconnected'); assert.equal(destroyed.results.length, 1);
    assert.equal(destroyed.clicks, clicked ? 1 : 0); assert.equal(destroyed.timers.size, 0);
    destroyed.send('later', { sequence: 2 }); result(destroyed, 'not-sent', 'not-current');
  }
  const teardownOnClick = fixture(); teardownOnClick.onClick = () => { teardownOnClick.sender.destroy(); throw Error('gone'); };
  teardownOnClick.send(); result(teardownOnClick, 'uncertain', 'disconnected'); assert.equal(teardownOnClick.results.length, 1);
  const teardownOnState = fixture(); teardownOnState.onState = state => { if (state.reason === 'busy') teardownOnState.sender.destroy(); };
  teardownOnState.send(); result(teardownOnState, 'not-sent', 'disconnected'); assert.equal(teardownOnState.input.textContent, '');
  assert.equal(teardownOnState.clicks, 0);
  const changeRefresh = fixture({ autoEnable: false }); changeRefresh.send();
  changeRefresh.author.textContent = '@Other'; changeRefresh.sender.refresh(); result(changeRefresh, 'not-sent', 'stale-capability');
  const teardownOnStep = fixture({ autoEnable: false }); teardownOnStep.send();
  teardownOnStep.onState = state => { if (state.reason === 'busy') teardownOnStep.sender.destroy(); };
  teardownOnStep.author.textContent = '@Changed'; teardownOnStep.tick(100);
  result(teardownOnStep, 'not-sent', 'disconnected'); assert.equal(teardownOnStep.clicks, 0);
  console.log('YouTube native sender tests passed.');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
