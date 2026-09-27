const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'src/youtube/access-card.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture({ contains = () => false, request = () => true } = {}) {
  const listeners = {}, calls = [];
  const button = { disabled: true, textContent: 'Allow YouTube access', addEventListener(type, listener) {
    assert.equal(type, 'click'); listeners.click = listener;
  } };
  const status = { textContent: 'Checking YouTube access…' };
  const elements = { 'youtube-access-allow': button, 'youtube-access-status': status };
  const api = { contains, request };
  const context = vm.createContext({ document: { getElementById: id => elements[id] }, chrome: { permissions: {
    contains(options) { calls.push('contains'); check(options); return api.contains(); },
    request(options) {
      calls.push('request'); check(options);
      assert.equal(button.disabled, true, 'the control prevents duplicate requests');
      return api.request();
    },
    onAdded: { addListener(fn) { listeners.added = fn; } },
    onRemoved: { addListener(fn) { listeners.removed = fn; } },
  } } });
  function check(options) {
    assert.deepEqual(JSON.parse(JSON.stringify(options)), { origins: ['https://www.youtube.com/*'] });
  }
  vm.runInContext(SOURCE, context, { filename: FILE });
  return { button, status, listeners, calls, api };
}

async function run() {
  for (const page of ['popup', 'options']) {
    const html = fs.readFileSync(path.join(ROOT, `src/${page}/${page}.html`), 'utf8');
    assert.equal((html.match(/id="youtube-access"/g) || []).length, 1);
    assert.match(html, /aria-labelledby="youtube-access-title"/);
    assert.match(html, /New in 1\.23\.0: YouTube chat/);
    assert.match(html, /Merge YouTube chat into Twitch and Kick/);
    assert.match(html, /Save channel links to load live chat automatically/);
    assert.match(html, /Sending is optional and starts off/);
    assert.match(html, /check the displayed account and select the YouTube send target for this visit when available/);
    assert.doesNotMatch(html, /read-only YouTube/);
    assert.match(html, /id="youtube-access-status"[^>]*role="status"/);
    assert.match(html, /id="youtube-access-allow"[^>]*type="button"[^>]*disabled/);
    assert.match(html, /href="\.\.\/youtube\/permission.html" target="_blank" rel="noopener"/);
    assert.match(html, /src="\.\.\/youtube\/access-card.js"/);
    assert.ok(html.indexOf('id="youtube-access"') < html.indexOf(page === 'popup' ? 'id="update"' : '<h2>Cross-platform</h2>'));
    const css = fs.readFileSync(path.join(ROOT, `src/${page}/${page}.css`), 'utf8');
    assert.match(css, /\.youtube-access button:disabled/);
  }

  const card = fixture();
  assert.deepEqual(card.calls, ['contains'], 'opening either surface never requests access');
  assert.equal(card.button.disabled, true, 'the permission check starts before enabling the button');
  await settle();
  assert.equal(card.button.disabled, false);
  assert.match(card.status.textContent, /Optional YouTube access enables live suggestions/);
  assert.match(card.status.textContent, /Chat loads only when you add it or use a saved link/);
  const clicked = card.listeners.click();
  assert.deepEqual(card.calls, ['contains', 'request'], 'request is called in the click stack without an earlier await');
  await clicked;
  assert.equal(card.button.disabled, true);
  assert.equal(card.button.textContent, 'YouTube access allowed');
  assert.match(card.status.textContent, /access is enabled/);
  await card.listeners.click();
  assert.equal(card.calls.filter(call => call === 'request').length, 1, 'the enabled state cannot request again');
  await card.listeners.removed();
  assert.equal(card.button.disabled, false, 'revoking optional access offers the button again');
  card.api.contains = () => true;
  await card.listeners.added();
  assert.equal(card.button.disabled, true, 'allowing access in another extension page updates this one');

  const already = fixture({ contains: () => true });
  await settle();
  assert.equal(already.button.disabled, true);
  assert.equal(already.button.textContent, 'YouTube access allowed');
  assert.deepEqual(already.calls, ['contains']);

  const retry = fixture({ request: () => false });
  await settle();
  await retry.listeners.click();
  assert.equal(retry.button.disabled, false);
  assert.match(retry.status.textContent, /Access was not granted/);
  retry.api.request = () => { throw Error('browser refused'); };
  await retry.listeners.click();
  assert.equal(retry.button.disabled, false);
  assert.match(retry.status.textContent, /browser could not grant/);
  retry.api.request = () => true;
  await retry.listeners.click();
  assert.equal(retry.button.disabled, true, 'a retry can grant access after a denial or browser error');

  const unknown = fixture({ contains: () => { throw Error('browser unavailable'); } });
  await settle();
  assert.equal(unknown.button.disabled, false);
  assert.match(unknown.status.textContent, /Could not check/);

  const old = deferred(), newer = deferred();
  const stale = fixture({ contains: () => old.promise });
  stale.api.contains = () => newer.promise;
  const refresh = stale.listeners.added();
  newer.resolve(false); await refresh;
  old.resolve(true); await settle();
  assert.equal(stale.button.disabled, false, 'an older check cannot overwrite a newer permission result');
  const staleError = deferred();
  stale.api.contains = () => staleError.promise;
  const olderRefresh = stale.listeners.removed();
  stale.api.contains = () => true;
  await stale.listeners.added();
  staleError.reject(Error('late failed check')); await olderRefresh;
  assert.equal(stale.button.disabled, true);
  assert.match(stale.status.textContent, /access is enabled/, 'an older failed check cannot replace current status');

  const pending = deferred(), initial = deferred();
  const busy = fixture({ contains: () => initial.promise, request: () => pending.promise });
  busy.api.contains = () => false;
  await busy.listeners.removed();
  const requesting = busy.listeners.click();
  initial.resolve(true); await settle();
  await busy.listeners.added();
  assert.equal(busy.button.disabled, true);
  assert.match(busy.status.textContent, /Waiting for the browser/);
  busy.api.contains = () => { throw Error('mid-request check'); };
  await busy.listeners.removed();
  assert.match(busy.status.textContent, /Waiting for the browser/);
  await busy.listeners.click();
  assert.equal(busy.calls.filter(call => call === 'request').length, 1, 'permission events and duplicate clicks cannot interrupt a request');
  busy.api.contains = () => false;
  pending.resolve(false); await requesting;
  assert.equal(busy.button.disabled, false);
  assert.match(busy.status.textContent, /Optional YouTube access/);
  assert.equal(busy.calls.filter(call => call === 'contains').length, 3, 'pending events coalesce into one fresh check after the request');

  const grantedThenRevoked = deferred();
  const revoked = fixture({ request: () => grantedThenRevoked.promise });
  await settle();
  const allowing = revoked.listeners.click();
  await revoked.listeners.removed();
  grantedThenRevoked.resolve(true); await allowing;
  assert.equal(revoked.button.disabled, false, 'a newer revocation wins over an older successful request result');
  assert.match(revoked.status.textContent, /Optional YouTube access/);
  console.log('YouTube popup/options access-card tests passed.');
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
