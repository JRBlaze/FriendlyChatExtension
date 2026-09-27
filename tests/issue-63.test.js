// Offline Twitch notification regressions. No accounts, network or page actions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

function element(attrs = {}, rect = {}) {
  return {
    attrs, style: {}, children: [], parentElement: null, isConnected: true, textContent: '',
    getAttribute(name) { return this.attrs[name] ?? null; },
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    contains(child) { for (; child; child = child.parentElement) if (child === this) return true; return false; },
    querySelector() { return null; },
    matches(selector) {
      return selector.split(',').some(part => {
        const role = /^\[role="([^"]+)"\]$/.exec(part);
        if (role) return attrs.role === role[1];
        if (part === '.tw-toast') return String(attrs.class || '').split(/\s+/).includes('tw-toast');
        if (part === '[data-a-target*="toast" i]') return /toast/i.test(attrs['data-a-target'] || '');
        if (part === '[data-sonner-toast]') return 'data-sonner-toast' in attrs;
        const drop = /^\[(data-testid|aria-label|title)\*="drop" i\]$/.exec(part);
        return !!drop && /drop/i.test(attrs[drop[1]] || '');
      });
    },
    getBoundingClientRect() {
      const { top = 60, left = 900, width = 340, height = 700 } = rect;
      return { top, left, width, height, right: left + width, bottom: top + height };
    },
  };
}

function fixture(platform = 'twitch', present = []) {
  const html = element(), body = html.appendChild(element());
  const chat = body.appendChild(element()), messages = chat.appendChild(element());
  const candidates = present;
  const document = {
    documentElement: html, body,
    querySelectorAll: selector => candidates.filter(node => node.matches(selector)),
    elementFromPoint: () => null,
  };
  const context = vm.createContext({ self: { FCM: {} }, document, window: {}, getComputedStyle: node => {
    let owner = node;
    while (owner.parentElement && (!owner.style.visibility || owner.style.visibility === 'inherit')) owner = owner.parentElement;
    return { position: 'static', display: node.style.display || 'block', visibility: owner.style.visibility || 'visible' };
  } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/native.js'), 'utf8'), context,
    { filename: 'src/content/native.js' });
  const site = { id: platform, messageList: () => messages, nativeChatBody: () => chat };
  return { bridge: context.self.FCM.createNativeBridge(site), candidates, chat, messages, body, site };
}

function toast(attrs = { role: 'alert' }, rect = {}) {
  const node = element(attrs, { top: 70, height: 52, ...rect });
  node.textContent = 'A followed channel is live';
  return node;
}

async function run() {
  for (const platform of ['twitch', 'kick']) {
    const f = fixture(platform), card = element({}, { top: 60, height: 40 });
    // A structural highlight is optional; a portal notification is not.
    f.messages.getBoundingClientRect = () => ({ top: 100, bottom: 760, left: 900, right: 1240, width: 340, height: 660 });
    card.textContent = 'Native highlight'; f.chat.appendChild(card);
    assert.ok(f.bridge.cards().elements.includes(card));
    assert.equal(f.bridge.cards(false), null, 'turning highlights off excludes structural cards');
    const first = toast({ role: 'alert' }, { top: 105 });
    const second = toast({ role: 'status' }, { top: 165 });
    f.candidates.push(first, second);
    const protectedNotices = f.bridge.cards(false);
    assert.deepEqual(Array.from(protectedNotices.elements), [first, second], 'both platforms retain stacked notifications with highlights off');
    assert.equal(protectedNotices.bottom, 217);
    assert.equal(protectedNotices.noticeBottom, 217, 'notification clearance is separate from optional card sizing');
    assert.ok(f.bridge.cards(true).elements.includes(card), 'enabling highlights includes cards again');
    first.attrs['data-state'] = 'closed';
    assert.deepEqual(Array.from(f.bridge.cards(false).elements), [second]);
    second.style.display = 'none';
    assert.equal(f.bridge.cards(false), null, 'dismissed stacked notifications return their space');
  }
  // A short portal isn't a structural chat sibling or an 80px dialog. It still
  // needs its painted space, including when it already existed at mount.
  for (const attrs of [
    { role: 'alert' }, { role: 'status' }, { class: 'tw-toast' },
    { 'data-a-target': 'followed-channel-toast' },
  ]) {
    const notice = toast(attrs), f = fixture('twitch', [notice]);
    const cards = f.bridge.cards();
    assert.ok(cards && cards.elements.includes(notice), 'Twitch live notification reserves its space');
    assert.equal(cards.top, 70); assert.equal(cards.bottom, 122);
    assert.equal(cards.height, 52);
    f.candidates.length = 0;
    assert.equal(f.bridge.cards(), null, 'dismissal immediately gives the space back');
  }

  // This is a native card, not a temporary menu peek: it never hides the whole
  // overlay, clicks the notification, or consumes a rewards/user-card dialog.
  const f = fixture(), notice = toast(); f.candidates.push(notice);
  assert.equal(f.bridge.dialogOver(f.messages.getBoundingClientRect()), null);
  const nativeDialog = element({ role: 'dialog' }, { top: 100, height: 240 });
  f.candidates.push(nativeDialog);
  assert.equal(f.bridge.dialogOver(f.messages.getBoundingClientRect()), nativeDialog);
  assert.equal(f.bridge.dialogStillOpen(), true);

  // Keep the host-specific hooks separate, and do not promote chat announcements
  // or transient status text inside a Twitch message list into a top banner.
  const inside = fixture(); inside.candidates.push(notice); inside.messages.appendChild(notice);
  assert.equal(inside.bridge.cards(), null, 'Twitch chat rows never move the overlay');
  for (const attrs of [{ 'data-testid': 'drop-notice' }, { 'data-sonner-toast': '' }]) {
    const drop = toast(attrs);
    assert.equal(fixture('twitch', [drop]).bridge.cards(), null, 'Kick-only hooks do not affect Twitch');
    assert.ok(fixture('kick', [drop]).bridge.cards().elements.includes(drop), 'Kick drops retain their existing inset');
  }
  assert.equal(fixture('unknown', [toast()]).bridge.cards(), null);

  // A closing notification can collapse between discovery and the final bounds
  // measurement. Do not return a zero-height region to the placement code.
  const collapsing = toast(), transient = fixture('twitch', [collapsing]);
  const initialBounds = collapsing.getBoundingClientRect();
  let measurements = 0;
  collapsing.getBoundingClientRect = () => ++measurements === 1 ? initialBounds
    : { ...initialBounds, bottom: initialBounds.top, height: 0 };
  assert.equal(transient.bridge.cards(false), null, 'collapsed notification does not reserve invalid bounds');

  for (const [label, rect, style, attrs, text] of [
    ['tooltip height', { height: 10 }, {}, {}, 'live'],
    ['zero width', { width: 0 }, {}, {}, 'live'],
    ['left of chat', { left: 100 }, {}, {}, 'live'],
    ['right of chat', { left: 1300 }, {}, {}, 'live'],
    ['above chat', { top: 0, height: 40 }, {}, {}, 'live'],
    ['lower half', { top: 500 }, {}, {}, 'live'],
    ['full-height layer', { height: 600 }, {}, {}, 'live'],
    ['empty slot', {}, {}, {}, ''],
    ['display none', {}, { display: 'none' }, {}, 'live'],
    ['hidden portal', {}, { visibility: 'hidden' }, {}, 'live'],
    ['closed portal', {}, {}, { 'data-state': 'closed' }, 'live'],
  ]) {
    const decoy = toast({ role: 'alert', ...attrs }, rect);
    Object.assign(decoy.style, style); decoy.textContent = text;
    assert.equal(fixture('twitch', [decoy]).bridge.cards(), null, label + ' does not take chat space');
  }

  // A notification in the chat column (outside the messages) can inherit our
  // native-chat hiding. Reveal it and restore the exact inline value on release.
  const hidden = fixture(), nested = toast();
  nested.style.visibility = 'inherit'; hidden.chat.appendChild(nested); hidden.candidates.push(nested);
  hidden.bridge.setNativeHidden(true, []);
  const shown = hidden.bridge.cards();
  assert.ok(shown.elements.includes(nested));
  hidden.bridge.setNativeHidden(true, shown.elements);
  assert.equal(nested.style.visibility, 'visible');
  hidden.bridge.release();
  assert.equal(nested.style.visibility, 'inherit');
  assert.equal(hidden.chat.style.visibility, '');
  hidden.site.messageList = () => null;
  assert.equal(hidden.bridge.cards(), null, 'missing chat does not guess where to reserve space');
  console.log('Issue #63 Twitch notification tests passed.');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
