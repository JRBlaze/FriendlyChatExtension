// Offline regressions for GitHub #56-60. No account, network or real moderation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

function element(attrs = {}, top = 100, height = 300) {
  const node = {
    attrs, style: { visibility: '' }, children: [], parentElement: null, isConnected: true,
    textContent: '',
    getAttribute(key) { return attrs[key] ?? null; },
    setAttribute(key, value) { attrs[key] = value; },
    removeAttribute(key) { delete attrs[key]; },
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    remove() { this.isConnected = false; },
    contains(child) { for (; child; child = child.parentElement) if (child === this) return true; return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    matches(selector) { return selector.includes('[role="dialog"]') && attrs.role === 'dialog'; },
    getBoundingClientRect() { return { top, bottom: top + height, left: 900, right: 1240, width: 340, height }; },
  };
  return node;
}

function nativeFixture(platform = 'twitch') {
  let body = element();
  const messages = element();
  body.appendChild(messages);
  const html = element(), pageBody = element(); html.appendChild(pageBody); pageBody.appendChild(body);
  const dialogs = [], notices = [];
  const document = {
    documentElement: html, body: pageBody,
    createElement: () => element(),
    querySelectorAll: selector => selector.includes('data-sonner-toast') ? notices : dialogs,
    elementFromPoint: () => null,
  };
  const context = vm.createContext({ document, window: {}, getComputedStyle: el => {
    let owner = el;
    while (owner.parentElement && !owner.style.visibility) owner = owner.parentElement;
    return { position: 'static', display: el.style.display || 'block', visibility: owner.style.visibility || 'visible' };
  } });
  context.self = { FCM: {} };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/native.js'), 'utf8'), context, { filename: 'src/content/native.js' });
  const site = { id: platform, messageList: () => messages, nativeChatBody: () => body };
  return { bridge: context.self.FCM.createNativeBridge(site), messages, dialogs, notices, html,
    body: () => body, replace: replacement => { body = replacement; }, site };
}

// Keep source offsets intact so V8 reports coverage against the actual file.
function overlayScope(first, last, extra, exports) {
  const file = 'src/content/overlay.js';
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const start = source.indexOf(first), end = source.indexOf(last, start);
  assert.ok(start >= 0 && end > start, 'overlay scope exists');
  const context = vm.createContext(extra);
  const selected = exports === 'onUserCard'
    ? source.slice(start, end).replace('onUserCard:', 'onUserCard=').replace(/,\s*$/, ';')
    : source.slice(start, end);
  vm.runInContext(source.slice(0, start).replace(/[^\r\n]/g, ' ') + selected
    + '\nObject.assign(globalThis, {' + exports + '});', context, { filename: file });
  return context;
}

async function run() {
  // #56: late/replaced native bodies are hidden, and every touched node is restored.
  for (const platform of ['twitch', 'kick']) {
    const f = nativeFixture(platform), original = f.body();
    original.style.visibility = 'collapse';
    const card = element(); card.style.visibility = 'inherit';
    f.bridge.setNativeHidden(true, [card]);
    assert.equal(original.style.visibility, 'hidden');
    assert.equal(card.style.visibility, 'visible');
    const replacement = element(); f.replace(replacement);
    f.bridge.setNativeHidden(true, [card]);
    assert.equal(original.style.visibility, 'collapse', 'replaced body restored');
    assert.equal(replacement.style.visibility, 'hidden');
    replacement.style.visibility = 'visible';
    f.bridge.setNativeHidden(true, [card]);
    assert.equal(replacement.style.visibility, 'visible', 'native send keeps its temporary visibility');
    replacement.style.visibility = 'hidden';
    f.bridge.setNativeHidden(false, []);
    assert.equal(replacement.style.visibility, '');
    assert.equal(card.style.visibility, 'inherit', 'card inline style restored');
    f.bridge.setNativeHidden(true, []);
    f.replace(null); f.bridge.setNativeHidden(true, []);
    assert.equal(replacement.style.visibility, '', 'detached body restored even with no replacement');
    f.replace(replacement); f.bridge.setNativeHidden(true, [card]);
    f.bridge.release(); f.bridge.release();
    assert.equal(replacement.style.visibility, '');
    assert.equal(card.style.visibility, 'inherit');
  }
  // #59: a named user-card dialog inside the message list is not a chat row.
  for (const platform of ['twitch', 'kick']) {
    const f = nativeFixture(platform), card = element({ role: 'dialog' });
    f.messages.appendChild(card); f.dialogs.push(card);
    assert.equal(f.bridge.dialogOver(f.messages.getBoundingClientRect()), card);
    assert.equal(f.bridge.dialogStillOpen(), true);
    card.attrs['data-state'] = 'closed';
    assert.equal(f.bridge.dialogStillOpen(), false, 'closed-but-mounted card releases overlay');
    f.bridge.dialogOver(f.messages.getBoundingClientRect());
    card.attrs['data-state'] = 'open';
    assert.equal(f.bridge.dialogOver(f.messages.getBoundingClientRect()), card, 'same card can reopen');
    card.isConnected = false;
    assert.equal(f.bridge.dialogStillOpen(), false);
  }
  // #57: short Kick drop notices can be outside the chat subtree or inside the list.
  const f = nativeFixture('kick'), notice = element({ role: 'status' }, 100, 44);
  notice.textContent = 'Emote drop available'; f.notices.push(notice);
  const cards = f.bridge.cards();
  assert.ok(cards && cards.elements.includes(notice));
  assert.equal(cards.bottom, 144);
  f.notices.length = 0;
  assert.equal(f.bridge.cards(), null, 'dismissed notice gives the space back');
  for (const [top, height, content, attrs] of [
    [100, 10, 'drop', {}], [100, 44, '', {}], [0, 44, 'drop', {}],
    [300, 44, 'drop', {}], [100, 200, 'drop', {}], [100, 44, 'drop', { 'data-state': 'closed' }],
  ]) {
    const decoy = element(attrs, top, height); decoy.textContent = content;
    f.notices.push(decoy);
    assert.equal(f.bridge.cards(), null, 'non-notice does not take chat space');
    f.notices.length = 0;
  }
  for (const change of [r => ({ ...r, width: 10 }), r => ({ ...r, right: 800 }), r => ({ ...r, left: 1400 })]) {
    const decoy = element(); decoy.textContent = 'drop';
    const rect = decoy.getBoundingClientRect(); decoy.getBoundingClientRect = () => change(rect);
    f.notices.push(decoy); assert.equal(f.bridge.cards(), null); f.notices.length = 0;
  }
  const invisible = element({}, 100, 44); invisible.textContent = 'drop';
  f.notices.push(invisible); invisible.style.display = 'none';
  assert.equal(f.bridge.cards(), null, 'display-none notice is ignored');
  invisible.style.display = ''; invisible.style.visibility = 'hidden';
  assert.equal(f.bridge.cards(), null, 'invisible portal is ignored');
  f.bridge.setNativeHidden(true, []);
  assert.equal(f.bridge.cards(), null, 'unrelated hidden portal is still ignored');
  invisible.style.visibility = ''; f.body().appendChild(invisible);
  assert.ok(f.bridge.cards().elements.includes(invisible), 'notice hidden only by our chat override is revealed');
  f.bridge.release(); f.notices.length = 0;

  // #58: ordinary popups are independent and do not consume the global PiP window.
  const make = () => {
    const windows = [], errors = [], listeners = new Map();
    const document = { documentElement: { appendChild(host) { host.parentNode = this; } } };
    const host = { parentNode: document.documentElement }, button = { setAttribute() {} };
    const context = overlayScope('    let pipWindow = null;', '    // ── Where a typed message goes', {
      window: {
        open(url, name, features) {
          const win = { closed: false, document: { body: { style: {}, appendChild(el) { el.parentNode = this; } } },
            addEventListener(type, fn) { this.onhide = fn; }, close() { this.closed = true; } };
          windows.push({ url, name, features, win }); return win;
        },
        addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type),
      }, document, host, root: { dataset: {} }, destroyed: false, collapsed: false,
      panel: { getBoundingClientRect: () => ({ width: 380, height: 640 }) },
      FCM: { PLATFORM_META: { twitch: { name: 'Twitch' } } }, hostPlatform: 'twitch', channel: 'test',
      $: () => button, ICONS: { popin: '', popout: '' },
      syncPlacement() {}, setPeek() {}, setCollapsed() {}, toast: text => errors.push(text),
    }, 'popOut, popIn, poppedOut, refreshPopButton');
    return { context, windows, errors, host, document, listeners };
  };
  const a = make(), b = make();
  await a.context.popOut(); await b.context.popOut();
  assert.equal(a.windows.length, 1); assert.equal(b.windows.length, 1);
  assert.equal(a.windows[0].name, '_blank');
  assert.equal(a.windows[0].win.closed, false);
  a.windows[0].win.onhide();
  assert.equal(a.host.parentNode, a.document.documentElement);
  assert.equal(b.context.poppedOut(), true, 'other channel stays open');
  b.context.popIn();
  const blocked = make(); blocked.context.window.open = () => null;
  await blocked.context.popOut();
  assert.equal(blocked.context.poppedOut(), false);
  assert.ok(blocked.errors.some(text => /allow|block/i.test(text)));
  const denied = make(); denied.context.window.open = () => { throw Error('denied'); };
  await denied.context.popOut(); assert.equal(denied.context.poppedOut(), false);
  const toggle = make(); await toggle.context.popOut(); await toggle.context.popOut();
  assert.equal(toggle.context.poppedOut(), false); toggle.context.popIn();
  const collapsed = make(); collapsed.context.collapsed = true;
  collapsed.context.panel.getBoundingClientRect = () => ({ width: 0, height: 0 });
  let expanded = false; collapsed.context.setCollapsed = value => { expanded = !value; };
  await collapsed.context.popOut(true); // missing PiP still offers normal windows
  assert.ok(expanded); assert.match(collapsed.windows[0].features, /400.*640/);
  collapsed.listeners.get('pagehide')(); assert.equal(collapsed.context.poppedOut(), false);
  const pip = make(); let finish;
  pip.context.window.documentPictureInPicture = { requestWindow: () => new Promise(resolve => { finish = resolve; }) };
  const pending = pip.context.popOut(true);
  pip.context.destroyed = true;
  let closed = 0; finish({ close() { closed++; } }); await pending;
  assert.equal(closed, 1); assert.equal(pip.context.poppedOut(), false);
  const tornDown = make(); await tornDown.context.popOut(); tornDown.context.destroyed = true;
  tornDown.context.popIn(); assert.equal(tornDown.windows[0].win.closed, true);
  tornDown.context.popIn();
  const stale = make(); await stale.context.popOut();
  const oldHide = stale.windows[0].win.onhide; stale.context.popIn(); await stale.context.popOut();
  oldHide(); assert.equal(stale.context.poppedOut(), true, 'old close cannot close a newer popup');
  stale.windows[1].win.closed = true; stale.context.popIn();
  stale.context.$ = () => null; stale.context.refreshPopButton();

  // #59: run the actual overlay callback to check visibility and delayed-menu hold ordering.
  const calls = [];
  const userCard = overlayScope('          onUserCard: (platform, name) => {', '          onModerate:', {
    hostPlatform: 'twitch', native: { expectMenu() { calls.push('expect'); }, openUserCard() { calls.push('open'); return true; } },
    peekHoldUntil: 0, NATIVE_MENU_PEEK_MS: 1800,
    setPeek: value => calls.push(value), schedulePeekCheck: () => calls.push('schedule'),
  }, 'onUserCard');
  assert.equal(userCard.onUserCard('kick', 'fixture'), false);
  assert.deepEqual(calls, []);
  assert.equal(userCard.onUserCard('twitch', 'fixture'), true);
  assert.deepEqual(calls, ['expect', true, 'open', 'schedule']);
  assert.ok(userCard.peekHoldUntil > Date.now());
  calls.length = 0; userCard.native.openUserCard = () => false;
  assert.equal(userCard.onUserCard('twitch', 'missing'), false);
  assert.deepEqual(calls, ['expect', true, false]); assert.equal(userCard.peekHoldUntil, 0);

  // #60: the toolbar has its own row space, rather than covering author/body text.
  const css = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
  assert.match(css, /\.fcm-msg:has\(\.fcm-modbar\):hover[\s\S]*?padding-top:\s*30px/);
  console.log('Issue #56-60 regression tests passed.');
}

module.exports = run;
module.exports.overlayScope = overlayScope;
module.exports.nativeFixture = nativeFixture;
module.exports.element = element;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
