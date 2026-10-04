const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

function fixture(options = {}) {
  const frames = new Map(), timers = new Map(), observers = [], resizers = [];
  let id = 0;
  function events(target) {
    const listeners = new Map();
    target.addEventListener = (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    };
    target.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
    target.fire = (type, event = { target }) => {
      for (const fn of [...(listeners.get(type) || [])]) fn(event);
    };
    target.listenerCount = type => listeners.get(type)?.size || 0;
    return target;
  }
  function makeWindow(noObserver = false) {
    const win = {
      requestAnimationFrame(fn) { const key = ++id; frames.set(key, fn); return key; },
      cancelAnimationFrame(key) { frames.delete(key); },
      ResizeObserver: options.noResize ? undefined : class {
        constructor(callback) { this.callback = callback; resizers.push(this); }
        observe() {}
        disconnect() { this.disconnected = true; }
      },
    };
    if (!noObserver) win.IntersectionObserver = class {
      constructor(callback, settings) { this.callback = callback; this.settings = settings; this.rows = new Set(); observers.push(this); }
      observe(row) { this.rows.add(row); }
      unobserve(row) { this.rows.delete(row); }
      disconnect() { this.rows.clear(); this.disconnected = true; }
      deliver(row, visible) { this.callback([{ target: row, isIntersecting: visible }]); }
    };
    return win;
  }
  function makeDocument(noObserver = false) {
    const doc = events({ hidden: false, defaultView: makeWindow(noObserver) });
    doc.createDocumentFragment = () => element('fragment', doc);
    return doc;
  }
  const doc = makeDocument(options.noObserver);
  function element(tag = 'div', ownerDocument = doc) {
    const attrs = new Map(), classes = new Set();
    const el = events({ nodeType: tag === 'fragment' ? 11 : 1, tagName: tag.toUpperCase(), ownerDocument,
      children: [], dataset: {}, style: { width: '', height: '' }, clientHeight: 320,
      complete: true, naturalWidth: 56, naturalHeight: 56,
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
      hasAttribute(name) { return attrs.has(name); },
      removeAttribute(name) { attrs.delete(name); },
      appendChild(child) {
        if (child.nodeType === 11) { [...child.children].forEach(node => this.appendChild(node)); return child; }
        child.remove(); this.children.push(child); child.parentElement = this; return child;
      },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentElement = null; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      replaceChildren() { [...this.children].forEach(child => child.remove()); },
      matches(selector) {
        return selector.split(',').some(part => {
          const text = part.trim();
          if (text === 'img') return this.tagName === 'IMG';
          const platform = /\[data-platform="([^"]+)"\]/.exec(text);
          if (platform) return this.dataset.platform === platform[1];
          if (text === '[data-platform]') return !!this.dataset.platform;
          return text.startsWith('.') && classes.has(text.slice(1));
        });
      },
      querySelectorAll(selector) {
        const found = [];
        for (const child of this.children) {
          if (child.matches(selector)) found.push(child);
          found.push(...child.querySelectorAll(selector));
        }
        return found;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); },
    });
    el.classList = {
      add(name) { classes.add(name); },
      contains(name) { return classes.has(name); },
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    };
    Object.defineProperties(el, {
      className: { get: () => [...classes].join(' '), set(value) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); } },
      childElementCount: { get: () => el.children.length },
      firstElementChild: { get: () => el.children[0] || null },
      isConnected: { get: () => el === feedEl || !!el.parentElement?.isConnected },
      scrollHeight: { get: () => el.children.length * 40 },
      width: { configurable: true, get: () => parseFloat(el.style.width) || 26 },
      height: { configurable: true, get: () => parseFloat(el.style.height) || 26 },
    });
    let top = 0;
    Object.defineProperty(el, 'scrollTop', { get: () => top, set(value) { top = Math.max(0, Math.min(value, el.scrollHeight - el.clientHeight)); } });
    return el;
  }
  const rows = [];
  function row(platform = 'twitch', imageCount = 1) {
    const item = element(); item.className = 'fcm-msg'; item.dataset.platform = platform;
    item.textContent = 'Retained message';
    for (let i = 0; i < imageCount; i++) {
      const img = element('img'); img.setAttribute('src', `https://example.test/${rows.length}-${i}.gif`);
      img.setAttribute('alt', 'Kappa'); item.appendChild(img);
    }
    rows.push(item); return item;
  }
  const builtModes = [];
  const FCM = {
    MAX_MESSAGES_MIN: 100, MAX_MESSAGES_MAX: 3000, MAX_MESSAGES_DEFAULT: 400, SEEN_MESSAGE_LIMIT: 12000,
    clampNumber(value, min, max, fallback) { return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback; },
    buildMessageEl(message, filter, deferImages) {
      builtModes.push(deferImages);
      const item = row(message.platform, message.images === undefined ? 1 : message.images);
      if (deferImages) item.children.forEach(image => {
        image.setAttribute('data-fcm-src', image.getAttribute('src'));
        image.removeAttribute('src');
      });
      item.dataset.msgId = message.messageId;
      if (filter && !filter.has(message.platform)) item.classList.add('fcm-hide');
      return item;
    },
    buildSysEl() { const item = row('twitch', 0); item.className = 'fcm-sys'; return item; },
    buildEventEl() { return row('twitch'); },
  };
  const sandbox = vm.createContext({ self: { FCM }, window: doc.defaultView, document: doc, Date,
    setTimeout(fn) { const key = ++id; timers.set(key, fn); return key; },
    clearTimeout(key) { timers.delete(key); },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/feed.js'), 'utf8'), sandbox,
    { filename: path.join(ROOT, 'src/content/feed.js') });
  const feedEl = element(), settings = { maxMessages: options.cap || 100 }, api = FCM.createFeed(feedEl, () => settings);
  function flush() { const [key, callback] = timers.entries().next().value; timers.delete(key); callback(); }
  return { api, feedEl, settings, doc, frames, timers, observers, resizers, rows, row, element, makeDocument, flush, builtModes,
    observer: () => observers[observers.length - 1],
    resize() { resizers[0]?.callback(); },
  };
}

function run() {
  const f = fixture();
  for (let i = 0; i < 400; i++) f.api.addMessage({ platform: 'twitch', messageId: `m${i}`, images: 8 });
  assert.equal(f.api.addMessage({ platform: 'twitch', messageId: 'm0', images: 8 }), null,
    'duplicate delivery never builds another set of deferred images');
  assert.equal(f.observers.length, 0, 'pending and discarded bursts do not retain observer records');
  assert.ok(f.builtModes.every(value => value === true), 'supported feeds build image URLs deferred from the outset');
  f.flush();
  assert.equal(f.feedEl.children.length, 100);
  assert.equal(f.observer().rows.size, 100, 'observer records remain bounded with the feed cap');
  assert.equal(f.observer().settings.root, f.feedEl);
  assert.equal(f.observer().settings.rootMargin, '128px 0px');
  const first = f.feedEl.children[0], last = f.feedEl.children[99], img = last.children[0];
  assert.equal(img.getAttribute('src'), null, 'offscreen rows do not hold active image sources');
  assert.ok(img.getAttribute('data-fcm-src').endsWith('.gif'));
  assert.equal(last.textContent, 'Retained message', 'suspension preserves message text');
  f.observer().deliver(last, true);
  [...f.frames.values()][0]();
  const src = img.getAttribute('src');
  assert.equal(img.getAttribute('loading'), 'eager', 'the observer supplies lazy loading without browser adoption heuristics');
  assert.equal(src, img.getAttribute('data-fcm-src'));
  assert.equal(img.style.width, ''); assert.equal(img.style.height, '');
  f.observer().deliver(last, true);
  f.observer().deliver(last, false);
  assert.equal(img.style.width, '26px'); assert.equal(img.style.height, '26px');
  f.observer().deliver(last, true);
  assert.equal(img.getAttribute('src'), src); assert.equal(img.style.width, '');
  assert.equal(img.hasAttribute('data-fcm-width'), false);
  img.style.width = '18px'; img.style.height = '18px';
  f.doc.hidden = true; f.doc.fire('visibilitychange');
  assert.equal(img.getAttribute('src'), null);
  f.doc.hidden = false; f.doc.fire('visibilitychange');
  assert.equal(img.style.width, '18px'); assert.equal(img.style.height, '18px');
  f.feedEl.clientHeight = 0; f.resize();
  assert.equal(img.getAttribute('src'), null, 'collapsed feeds release images');
  f.feedEl.clientHeight = 320; f.resize();
  assert.equal(img.getAttribute('src'), src, 'expanding restores the visible images');
  f.api.applyFilter(new Set(['kick']));
  assert.equal(img.getAttribute('src'), null);
  f.observer().deliver(last, true);
  assert.equal(img.getAttribute('src'), null, 'intersection cannot reactivate filtered platform rows');
  f.api.applyFilter(new Set(['twitch'])); assert.equal(img.getAttribute('src'), src);
  f.observer().deliver(first, true);
  f.api.addMessage({ platform: 'twitch', messageId: 'new' }); f.flush();
  assert.equal(f.observer().rows.size, 100);
  assert.equal(first.children[0].getAttribute('src'), null, 'trimming releases even externally retained rows');
  f.observer().deliver(first, true);
  assert.equal(first.children[0].getAttribute('src'), null, 'late observer entries cannot restore discarded rows');

  const oldDoc = f.doc, oldObserver = f.observer(), nextDoc = f.makeDocument();
  f.feedEl.ownerDocument = nextDoc; f.api.resettle();
  assert.equal(oldObserver.disconnected, true);
  assert.equal(oldDoc.listenerCount('visibilitychange'), 0);
  assert.equal(nextDoc.listenerCount('visibilitychange'), 1);
  oldObserver.deliver(last, true);
  assert.equal(img.getAttribute('src'), null, 'the old document observer cannot act after adoption');
  f.observer().deliver(last, true); assert.equal(img.getAttribute('src'), src);
  assert.equal(img.getAttribute('loading'), 'eager', 'adopted visible images decode in their new document');
  oldDoc.hidden = true; oldDoc.fire('visibilitychange'); assert.equal(img.getAttribute('src'), src);
  nextDoc.hidden = true; nextDoc.fire('visibilitychange'); assert.equal(img.getAttribute('src'), null);
  nextDoc.hidden = false; nextDoc.fire('visibilitychange'); assert.equal(img.getAttribute('src'), src);
  f.feedEl.ownerDocument = oldDoc; oldDoc.hidden = false; f.api.scrollToBottom();
  assert.equal(nextDoc.listenerCount('visibilitychange'), 0);
  f.observer().deliver(last, true); assert.equal(img.getAttribute('src'), src);
  const unsupportedDoc = f.makeDocument(true);
  f.feedEl.ownerDocument = unsupportedDoc; f.api.resettle();
  assert.equal(f.observer().disconnected, true);
  assert.equal(img.getAttribute('src'), src, 'unsupported documents retain the existing rendering fallback');
  f.feedEl.ownerDocument = oldDoc; f.api.resettle();
  f.api.addEvent('twitch', 'notice'); f.flush();
  f.api.addSys('status'); f.flush();
  f.feedEl.ownerDocument = { ...oldDoc, defaultView: null }; f.api.resettle();
  f.feedEl.ownerDocument = null; f.api.resettle();

  const mixed = fixture();
  const twitch = mixed.api.addMessage({ platform: 'twitch', messageId: 'tw' });
  mixed.api.addMessage({ platform: 'kick', messageId: 'pending' });
  mixed.api.dropPlatform('kick'); mixed.flush();
  assert.equal(mixed.feedEl.children.length, 1);
  const kick = mixed.api.addMessage({ platform: 'kick', messageId: 'ki' }); mixed.flush();
  mixed.observer().deliver(kick, true); mixed.api.dropPlatform('kick');
  assert.equal(mixed.observer().rows.size, 1);
  assert.equal(kick.children[0].getAttribute('src'), null);
  mixed.observer().deliver(twitch, true); mixed.api.clear();
  assert.equal(mixed.observer().rows.size, 0); assert.equal(mixed.feedEl.children.length, 0);
  assert.equal(twitch.children[0].getAttribute('src'), null);
  mixed.observer().deliver(twitch, true);
  assert.equal(twitch.children[0].getAttribute('src'), null);

  const dynamic = fixture();
  const plain = dynamic.api.addMessage({ platform: 'twitch', images: 0 }); dynamic.flush();
  assert.equal(dynamic.observer().rows.size, 0);
  const clip = dynamic.row().children[0]; plain.appendChild(clip);
  dynamic.feedEl.fire('load', { target: clip });
  assert.equal(dynamic.observer().rows.size, 1, 'late clip images enter the same visibility lifecycle');
  dynamic.observer().deliver(plain, true); assert.ok(clip.getAttribute('src'));
  dynamic.feedEl.fire('load', { target: clip });
  dynamic.observer().deliver(plain, false);

  const batched = fixture();
  const dense = batched.api.addMessage({ platform: 'twitch', images: 20 }), operations = [];
  dense.children.forEach((image, index) => {
    Object.defineProperty(image, 'width', { configurable: true, get() { operations.push(`read width ${index}`); return 26; } });
    Object.defineProperty(image, 'height', { configurable: true, get() { operations.push(`read height ${index}`); return 26; } });
    const setAttribute = image.setAttribute.bind(image), removeAttribute = image.removeAttribute.bind(image);
    image.setAttribute = (name, value) => { operations.push(`write ${name} ${index}`); setAttribute(name, value); };
    image.removeAttribute = name => { operations.push(`write ${name} ${index}`); removeAttribute(name); };
    image.style = new Proxy(image.style, { set(target, key, value) { operations.push(`write style ${index}`); target[key] = value; return true; } });
  });
  batched.flush();
  assert.equal(operations.filter(item => item.startsWith('read')).length, 0,
    'never-attached images are suspended without measuring intrinsic dimensions');
  batched.observer().deliver(dense, true); operations.length = 0;
  batched.observer().deliver(dense, false);
  assert.equal(operations.findIndex(item => item.startsWith('write')), 40,
    'all twenty image boxes are read before the first attribute or style mutation');
  assert.equal(operations.filter(item => item.startsWith('read')).length, 40,
    'each image width and height is read exactly once');
  assert.ok(operations.slice(40).every(item => item.startsWith('write')),
    'no layout read follows a mutation during row suspension');
  batched.observer().deliver(dense, true); operations.length = 0;
  batched.api.clear();
  assert.equal(operations.filter(item => item.startsWith('read')).length, 0,
    'discarding rows releases image sources without layout measurements');
  assert.ok(dense.children.every(image => image.getAttribute('src') === null));
  batched.api.destroy();

  const shared = fixture(), sharedRows = [];
  for (let i = 0; i < 3; i++) sharedRows.push(shared.api.addMessage({ platform: 'twitch', images: 2 }));
  shared.flush();
  const availabilityWork = [];
  Object.defineProperty(shared.feedEl, 'clientHeight', { configurable: true,
    get() { availabilityWork.push('read feed'); return 320; } });
  sharedRows.forEach(item => item.children.forEach(image => {
    const set = image.setAttribute.bind(image);
    image.setAttribute = (name, value) => { availabilityWork.push('write image'); set(name, value); };
  }));
  shared.observer().callback(sharedRows.map(item => ({ target: item, isIntersecting: true })));
  assert.equal(availabilityWork.filter(item => item === 'read feed').length, 1,
    'one observer batch reads feed availability once for all visible rows');
  assert.equal(availabilityWork[0], 'read feed', 'feed availability is read before any image mutations');
  shared.doc.hidden = true; shared.doc.fire('visibilitychange');
  availabilityWork.length = 0;
  shared.doc.hidden = false; shared.doc.fire('visibilitychange');
  assert.equal(availabilityWork.filter(item => item === 'read feed').length, 1,
    'visibility refresh shares one feed availability reading across all rows');
  assert.equal(availabilityWork[0], 'read feed');
  shared.api.destroy();
  const laterClip = dynamic.row().children[0]; plain.appendChild(laterClip);
  dynamic.feedEl.fire('load', { target: laterClip });
  assert.equal(laterClip.getAttribute('src'), null, 'a late thumbnail on an already tracked offscreen row is suspended');
  dynamic.observer().deliver(plain, true);
  dynamic.doc.hidden = true; dynamic.doc.fire('visibilitychange');
  const hiddenClip = dynamic.row().children[0]; plain.appendChild(hiddenClip);
  dynamic.feedEl.fire('load', { target: hiddenClip });
  assert.equal(hiddenClip.getAttribute('src'), null, 'a late thumbnail stays suspended in a hidden document');
  dynamic.doc.hidden = false; dynamic.doc.fire('visibilitychange');
  assert.ok(hiddenClip.getAttribute('src'));
  const queryImages = plain.querySelectorAll.bind(plain);
  let loadScans = 0;
  plain.querySelectorAll = selector => { loadScans++; return queryImages(selector); };
  for (let i = 0; i < 20; i++) {
    const fresh = dynamic.element('img'), imageUrl = `https://example.test/fresh-${i}.gif`;
    fresh.setAttribute('src', imageUrl); plain.appendChild(fresh);
    dynamic.feedEl.fire('load', { target: fresh });
    assert.equal(fresh.getAttribute('src'), imageUrl, 'an active new image keeps its source');
    assert.equal(fresh.hasAttribute('data-fcm-src'), false, 'active unknown images are left untouched');
  }
  assert.equal(loadScans, 0, 'N image loads do not cause N whole-row image scans');
  dynamic.observer().deliver(plain, false); loadScans = 0;
  for (const image of plain.children) dynamic.feedEl.fire('load', { target: image });
  assert.equal(loadScans, 0, 'inactive load events only suspend their own image');
  dynamic.observer().deliver(plain, true);
  const withoutSource = dynamic.element('img'); plain.appendChild(withoutSource);
  dynamic.observer().deliver(plain, true);
  const unloaded = dynamic.element('img'); unloaded.complete = false;
  unloaded.setAttribute('src', 'https://example.test/loading.gif'); plain.appendChild(unloaded);
  dynamic.observer().deliver(plain, false);
  assert.equal(unloaded.hasAttribute('data-fcm-width'), false, 'unloaded images do not invent dimensions');
  dynamic.observer().deliver(plain, true); assert.ok(unloaded.getAttribute('src'));
  unloaded.complete = true; unloaded.naturalWidth = 0;
  dynamic.observer().deliver(plain, false); dynamic.observer().deliver(plain, true);
  unloaded.naturalWidth = 56;
  Object.defineProperty(unloaded, 'width', { configurable: true, get: () => 0 });
  dynamic.observer().deliver(plain, false);

  const paused = fixture();
  for (let i = 0; i < 20; i++) paused.api.addMessage({ platform: 'twitch' });
  paused.flush();
  paused.feedEl.fire('wheel'); paused.feedEl.scrollTop = 0; paused.feedEl.fire('scroll');
  assert.equal(paused.api.isPinned(), false);
  [...paused.frames.values()][0]();
  paused.api.scrollToBottom(); paused.feedEl.clientHeight = 0;
  [...paused.frames.values()][0]();
  paused.api.destroy();

  const beforeDestroy = fixture();
  const pending = beforeDestroy.api.addMessage({ platform: 'twitch' });
  const lateRun = [...beforeDestroy.timers.values()][0];
  beforeDestroy.api.destroy(); lateRun();
  assert.equal(beforeDestroy.timers.size, 0); assert.equal(beforeDestroy.frames.size, 0);
  assert.equal(beforeDestroy.feedEl.children.length, 0, 'destroy cancels unflushed rows');
  beforeDestroy.api.addSys('late'); assert.equal(beforeDestroy.timers.size, 0);
  assert.equal(pending.parentElement, undefined);
  const dying = fixture();
  const live = dying.api.addMessage({ platform: 'twitch' }); dying.flush();
  dying.observer().deliver(live, true);
  const lateStep = [...dying.frames.values()][0]; dying.api.destroy(); lateStep();
  dying.observer().deliver(live, true); dying.feedEl.fire('load'); dying.api.resettle();
  assert.equal(dying.frames.size, 0, 'late loads and animation callbacks cannot restart destroyed work');
  assert.equal(live.children[0].getAttribute('src'), null);
  assert.equal(dying.doc.listenerCount('visibilitychange'), 0);
  assert.equal(dying.resizers[0].disconnected, true);
  dying.doc.fire('visibilitychange');
  for (const item of [f, mixed, dynamic]) item.api.destroy();
  const fallback = fixture({ noObserver: true, noResize: true });
  const untouched = fallback.api.addMessage({ platform: 'twitch' }); fallback.flush();
  assert.equal(fallback.builtModes[0], false, 'unsupported feeds preserve the renderer default');
  fallback.api.resettle(); assert.ok(untouched.children[0].getAttribute('src'));
  fallback.doc.hidden = true; fallback.doc.fire('visibilitychange');
  assert.ok(untouched.children[0].getAttribute('src')); fallback.api.destroy();
  const selection = fixture();
  const deferred = selection.api.addMessage({ platform: 'twitch' });
  assert.equal(deferred.children[0].getAttribute('src'), null);
  selection.feedEl.ownerDocument = selection.makeDocument(true);
  selection.api.addMessage({ platform: 'twitch' }); selection.flush();
  assert.deepEqual(selection.builtModes, [true, false], 'rendering follows the current owner document after adoption');
  assert.ok(deferred.children[0].getAttribute('src'),
    'a deferred pending row restores its source if adopted without observer support before flushing');
  selection.feedEl.ownerDocument = { ...selection.doc, defaultView: null };
  selection.api.addMessage({ platform: 'twitch' });
  selection.feedEl.ownerDocument = null;
  selection.api.addMessage({ platform: 'twitch' }); selection.flush();
  assert.deepEqual(selection.builtModes, [true, false, true, true], 'missing document or window uses the existing fallbacks');
  selection.api.destroy();
}

module.exports = { run, fixture };
if (require.main === module) { run(); console.log('feed performance regressions passed'); }
