const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'src/youtube/permission.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const turn = async () => { for (let n = 0; n < 6; n++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(browser, options = {}) {
  const elements = new Map(), events = new Map();
  for (const id of ['allow', 'status', 'continue']) {
    const listeners = new Map();
    elements.set(id, { disabled: false, textContent: '', dataset: {}, listeners,
      addEventListener(type, fn) { listeners.set(type, fn); } });
  }
  const state = { allowed: !!options.allowed, requests: 0, reads: 0, closes: 0,
    contains: options.contains, request: options.request };
  const permissionEvent = name => ({ addListener(fn) { events.set(name, fn); } });
  function validate(input) {
    assert.deepEqual(JSON.parse(JSON.stringify(input)), { origins: ['https://www.youtube.com/*'] });
  }
  const chrome = { permissions: {
    contains(input) {
      validate(input); state.reads++;
      return state.contains ? state.contains() : Promise.resolve(state.allowed);
    },
    request(input) {
      validate(input); state.requests++;
      assert.equal(elements.get('allow').disabled, true);
      assert.equal(elements.get('continue').disabled, true);
      return state.request ? state.request() : Promise.resolve(state.allowed = true);
    },
    onAdded: permissionEvent('added'), onRemoved: permissionEvent('removed'),
  } };
  const context = vm.createContext({ document: { getElementById: id => elements.get(id) }, chrome,
    ...(browser === 'firefox' ? { browser: chrome } : {}),
    window: {
      addEventListener(name, fn) { events.set(name, fn); },
      close() { state.closes++; if (options.closeThrows) throw Error('close refused'); },
    } });
  vm.runInContext(SOURCE, context, { filename: FILE });
  return { state, elements, events,
    click: (id, trusted = true) => elements.get(id).listeners.get('click')({ isTrusted: trusted }),
    text: () => elements.get('status').textContent,
  };
}
async function run() {
  for (const browser of ['chrome', 'firefox']) {
    const f = fixture(browser);
    assert.equal(f.state.requests, 0, 'opening the page never requests access');
    await turn();
    assert.match(f.text(), /without YouTube access/);
    await f.click('allow', false);
    assert.equal(f.state.requests, 0, 'synthetic clicks cannot prompt');
    const request = deferred();
    f.state.request = () => request.promise;
    const granting = f.click('allow');
    assert.equal(f.state.requests, 1, 'request is synchronous within the trusted click');
    await f.click('allow'); f.click('continue');
    assert.equal(f.state.requests, 1, 'a pending browser prompt cannot be duplicated');
    assert.equal(f.state.closes, 0);
    request.resolve(true); await granting;
    assert.match(f.text(), /YouTube is ready/);
    assert.match(f.text(), /Sending turns on automatically when the signed-in YouTube chat box is ready/);
    assert.doesNotMatch(f.text(), /read only/);
    assert.equal(f.elements.get('allow').disabled, true);
    assert.equal(f.elements.get('continue').textContent, 'Done');
    assert.equal(f.elements.get('continue').disabled, false);
    await f.click('allow'); assert.equal(f.state.requests, 1, 'existing access never reprompts');
    f.state.allowed = false; await f.events.get('removed')();
    assert.match(f.text(), /without YouTube access/);
    assert.equal(f.elements.get('allow').disabled, false);
    assert.equal(f.elements.get('continue').textContent, 'Not now');
    f.state.allowed = true; await f.events.get('added')();
    assert.match(f.text(), /YouTube is ready/);
    f.state.allowed = false; await f.events.get('focus')();
    assert.match(f.text(), /without YouTube access/, 'focus reconciles browser settings changes');

    for (const outcome of ['deny', 'throw', 'reject']) {
      const retry = fixture(browser, { request: () => {
        if (outcome === 'throw') throw Error('browser rejected gesture');
        return outcome === 'reject' ? Promise.reject(Error('request failed')) : Promise.resolve(false);
      } });
      await turn(); await retry.click('allow');
      assert.match(retry.text(), outcome === 'deny' ? /not granted/ : /could not grant/);
      assert.equal(retry.elements.get('allow').disabled, false);
      assert.equal(retry.elements.get('continue').disabled, false);
      retry.state.request = null;
      await retry.click('allow');
      assert.match(retry.text(), /YouTube is ready/);
      assert.equal(retry.state.requests, 2, 'denial and errors remain retryable');
    }

    for (const allowed of [false, true]) for (const closeThrows of [false, true]) {
      const done = fixture(browser, { allowed, closeThrows });
      await turn();
      assert.equal(done.elements.get('allow').disabled, allowed);
      assert.equal(done.state.requests, 0, 'an existing grant is detected without request');
      done.click('continue', false); assert.equal(done.state.closes, 0);
      done.click('continue');
      assert.equal(done.state.closes, 1);
      assert.match(done.text(), /You can close this setup tab/, 'manual close fallback remains visible');
      const reads = done.state.reads;
      await done.events.get('focus')(); done.click('continue'); await done.click('allow');
      assert.equal(done.state.reads, reads);
      assert.equal(done.state.requests, 0);
      assert.equal(done.state.closes, 1);
    }

    const unknown = fixture(browser, { contains: () => Promise.reject(Error('check failed')) });
    await turn(); assert.match(unknown.text(), /Unable to check/);
    await unknown.click('allow'); assert.match(unknown.text(), /YouTube is ready/);

    for (const rejected of [false, true]) {
      const old = deferred(), latest = deferred();
      const stale = fixture(browser, { contains: () => old.promise });
      stale.state.contains = () => latest.promise;
      const refreshing = stale.events.get('focus')();
      latest.resolve(true); await refreshing;
      if (rejected) old.reject(Error('late read')); else old.resolve(false);
      await turn(); assert.match(stale.text(), /YouTube is ready/);

      const read = deferred(), grant = deferred();
      const busy = fixture(browser, { contains: () => read.promise, request: () => grant.promise });
      const action = busy.click('allow');
      if (rejected) read.reject(Error('late read')); else read.resolve(false);
      await turn(); assert.match(busy.text(), /Approve the YouTube/);
      grant.resolve(true); await action; assert.match(busy.text(), /YouTube is ready/);

      const leavingRead = deferred();
      const leaving = fixture(browser, { contains: () => leavingRead.promise });
      leaving.events.get('pagehide')();
      if (rejected) leavingRead.reject(Error('closed read')); else leavingRead.resolve(true);
      await turn(); assert.equal(leaving.text(), '', 'closed pages ignore late initial reads');

      const leavingGrant = deferred();
      const prompting = fixture(browser, { request: () => leavingGrant.promise });
      await turn(); const pending = prompting.click('allow');
      prompting.events.get('pagehide')();
      if (rejected) leavingGrant.reject(Error('closed request')); else leavingGrant.resolve(true);
      await pending;
      assert.match(prompting.text(), /Approve the YouTube/, 'closed pages ignore late request results');
    }

    for (const allowed of [false, true]) {
      const grant = deferred();
      const changed = fixture(browser, { request: () => grant.promise });
      await turn(); const pending = changed.click('allow');
      changed.state.allowed = allowed;
      await changed.events.get(allowed ? 'added' : 'removed')();
      await changed.events.get('focus')();
      assert.equal(changed.state.reads, 1, 'permission events wait for the active prompt');
      grant.resolve(!allowed); await pending; await turn();
      assert.equal(changed.elements.get('allow').disabled, allowed,
        'events during the prompt trigger a fresh query after it finishes');
      assert.equal(changed.state.reads, 2, 'pending events coalesce into one fresh check');
    }
  }
  const html = fs.readFileSync(path.join(ROOT, 'src/youtube/permission.html'), 'utf8');
  for (const text of ['New in 1.23.0', 'YouTube joins your merged chat.', 'live-video or channel URL',
    'Add YouTube chat', 'Settings → Cross-platform', 'automatically on future visits',
    'Sending turns on automatically', 'displayed account', 'turn its send target off or on', '200 characters',
    'normal chat restrictions', 'especially in Firefox', 'click a name or select an @mention suggestion', 'no moderation controls',
    'not that delivery was confirmed', 'never retried automatically',
    'Access is optional', 'lookups omit cookies and credentials',
    'may use cookies allowed by your browser', 'not saved to extension storage',
    'id="allow" type="button"', 'id="continue"', 'id="status" role="status"',
    'href="permission.css"', 'src="permission.js"', 'href="../options/options.html"']) assert.ok(html.includes(text), text);
  assert.match(html, /<title>YouTube access · Friendly Chat<\/title>/);
  assert.doesNotMatch(html, /experimental|local trial|<script[^>]*>\s*[^<\s]/i);
  assert.doesNotMatch(html, /YouTube · read only|YouTube is read only|cannot send/i);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /Sending to YouTube turns on automatically/);
  assert.match(readme, /200 characters/);
  assert.match(readme, /never retries\s+an uncertain send/);
  assert.match(readme, /no separate YouTube account connection,\s+API key, hosted service, token reading or additional extension permission/);
  assert.match(readme, /Allow YouTube sign-in/);
  assert.match(readme, /keeping Enhanced Tracking Protection enabled/);
  assert.match(readme, /Twitch\s+and Kick have separate access grants/);
  assert.match(readme, /approval alone never sends a message/);
  const privacy = fs.readFileSync(path.join(ROOT, 'PRIVACY.md'), 'utf8');
  assert.match(privacy, /Explicit off\/on choices are saved in\s+local extension storage, keyed by the Twitch\/Kick host platform and channel/);
  assert.match(privacy, /not synced or included in portable backups/);
  assert.match(privacy, /No YouTube\s+account labels or source identifiers are saved with these choices/);
  assert.match(privacy, /account labels\s+remain in memory/);
  assert.match(privacy, /does not read or copy YouTube tokens or cookies for sending/);
  assert.match(privacy, /cleared editor as submitted, without claiming server delivery/);
  const css = fs.readFileSync(path.join(ROOT, 'src/youtube/permission.css'), 'utf8');
  assert.match(css, /max-width: 650px/);
  assert.match(css, /focus-visible/);
  console.log('YouTube permission setup tests passed (Chrome and Firefox).');
}
module.exports = run;
if (require.main === module) run().catch(e => { console.error(e); process.exitCode = 1; });
