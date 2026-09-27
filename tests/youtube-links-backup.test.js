const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const KEY = 'fcm_youtube_links_v1';
const URL_A = 'https://www.youtube.com/@Example';
const URL_B = 'https://www.youtube.com/@Other';
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function element(tag = 'div') {
  const listeners = {};
  const el = { tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, value: '',
    checked: false, disabled: false, hidden: false, textContent: '', innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    async fire(type) { await Promise.all((listeners[type] || []).map(fn => fn({ target: el, preventDefault() {} }))); },
    click() { return el.fire('click'); },
    appendChild(child) { el.children.push(child); child.parentNode = el; return child; },
    replaceChildren(...children) { el.children = children; },
    remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter(child => child !== el); },
  };
  return el;
}

function openOptions(initial = {}) {
  const page = fs.readFileSync(path.join(ROOT, 'src/options/options.html'), 'utf8');
  const byId = new Map([...page.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], element()]));
  const requests = [], confirms = [], writes = [], changes = [], downloads = [];
  const permissionEvents = { added: [], removed: [] };
  const permissionGrants = new Set();
  const local = plain(initial), sync = {};
  const api = { local, requests, confirms, writes, downloads, answer: true, read: null, send: null };
  const area = store => ({
    async get(key) {
      if (store === local && api.read) return api.read(key, store);
      return key in store ? { [key]: plain(store[key]) } : {};
    },
    async set(values) { writes.push(plain(values)); Object.assign(store, plain(values)); },
    async remove(key) { delete store[key]; },
  });
  let lastBlob;
  class PageURL extends URL {
    static createObjectURL(blob) { lastBlob = blob; return 'blob:fixture/backup'; }
    static revokeObjectURL() {}
  }
  const document = { body: element('body'), getElementById: id => byId.get(id) || null,
    createElement(tag) {
      const el = element(tag);
      if (tag === 'a') el.click = () => downloads.push({ name: el.download, text: lastBlob.parts.join('') });
      return el;
    } };
  const context = { console, URL: PageURL, document, setTimeout: () => 0, clearTimeout() {},
    window: { confirm(text) { confirms.push(text); return api.answer; } },
    Blob: class { constructor(parts) { this.parts = parts; } },
    chrome: {
      runtime: { getURL: (p = '') => `chrome-extension://fixture/${p}`, getManifest: () => ({ version: '1.23.0' }),
        async sendMessage(message) {
          requests.push(plain(message));
          if (api.send) return api.send(message);
          assert.equal(message.cmd, 'youtubeLinkForgetSaved');
          if (!local[KEY] || local[KEY][message.hostKey]?.channelUrl !== message.channelUrl) return { error: 'link-changed' };
          delete local[KEY][message.hostKey];
          return { ok: true };
        } },
      storage: { local: area(local), sync: area(sync), onChanged: { addListener(fn) { changes.push(fn); } } },
      permissions: {
        async contains({ origins }) { return origins.every(origin => permissionGrants.has(origin)); },
        async request({ origins }) {
          origins.forEach(origin => permissionGrants.add(origin));
          permissionEvents.added.forEach(fn => fn({ origins }));
          return true;
        },
        onAdded: { addListener(fn) { permissionEvents.added.push(fn); } },
        onRemoved: { addListener(fn) { permissionEvents.removed.push(fn); } },
      },
    },
  };
  context.self = context;
  vm.createContext(context);
  for (const match of page.matchAll(/<script src="([^"]+)"/g)) {
    const filename = path.resolve(ROOT, 'src/options', match[1]);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  Object.assign(api, { FCM: context.FCM, $: id => byId.get(id),
    emit(value, area = 'local') { changes.forEach(fn => fn(value, area)); },
    async import(value) {
      api.$('import-file').files = [{ text: async () => JSON.stringify(value) }];
      await api.$('import-file').fire('change'); await flush();
    } });
  return api;
}

async function run() {
  const empty = openOptions();
  await flush();
  assert.match(empty.$('youtube-links').children[0].textContent, /No saved YouTube links/, 'older installations have no saved YouTube store');
  const fixture = openOptions({ [KEY]: { 'twitch:example': { channelUrl: URL_A, at: 12 } } });
  await flush();
  const { FCM } = fixture;
  const backup = (youtubeLinks, rest = {}) => ({ format: FCM.BACKUP_FORMAT, backupVersion: 1, youtubeLinks, ...rest });
  const raw = { 'twitch: EXAMPLE ': { channelUrl: URL_A + '/live?track=1', at: 12, token: 'do-not-export' },
    'kick:another': { channelUrl: URL_B, at: 15 },
    'youtube:example': { channelUrl: URL_A }, 'twitch:badvideo': { channelUrl: 'https://youtu.be/abcdefghijk' } };
  const expected = { 'twitch:example': { channelUrl: URL_A, at: 12 }, 'kick:another': { channelUrl: URL_B, at: 15 } };
  const file = FCM.buildBackup({ youtubeLinks: raw, settings: { opacity: 80 }, links: { 'twitch:one': { channel: 'two', manual: true } } }, '1.23.0');
  assert.equal(file.backupVersion, 1, 'adding optional saved links retains portable backup v1');
  assert.deepEqual(plain(file.youtubeLinks), expected, 'export only canonical channel records, never transient video or extra data');
  assert.equal(JSON.stringify(file).includes('do-not-export'), false);
  const read = FCM.readBackup(plain(file));
  assert.deepEqual(plain(read.stores.youtubeLinks), expected);
  assert.equal(read.counts.youtubeLinks, 2);
  assert.equal(read.stores.links['twitch:one'].channel, 'two', 'Twitch/Kick backup semantics stay separate');
  assert.equal(FCM.buildBackup({ youtubeLinks: [] }).youtubeLinks, undefined);
  for (const value of [undefined, null, [], {}, { 'twitch:example': { channelUrl: 'https://evil.invalid/@Example' } }]) {
    const result = FCM.readBackup(backup(value, { settings: { opacity: 75 } }));
    assert.equal(result.ok, true);
    assert.equal(result.stores.youtubeLinks, undefined, 'missing or unusable section cannot clear saved links');
    assert.equal(FCM.readBackup(backup(value)).ok, false);
  }
  assert.equal(fixture.$('youtube-links').children[0].children[0].textContent, 'Twitch/example');
  assert.equal(fixture.$('youtube-links').children[0].children[1].textContent, URL_A);
  assert.equal(fixture.$('youtube-links').children[0].innerHTML, '', 'saved metadata is rendered as text');
  await fixture.$('export-settings').click();
  const exported = JSON.parse(fixture.downloads[0].text);
  assert.deepEqual(exported.youtubeLinks, { 'twitch:example': { channelUrl: URL_A, at: 12 } });
  assert.equal(exported.auth, undefined);
  await fixture.import(backup(raw));
  assert.deepEqual(fixture.local[KEY], expected, 'nonempty validated section replaces saved links');
  assert.match(fixture.confirms.at(-1), /2 saved YouTube links/);
  assert.match(fixture.$('backup-note').textContent, /Imported 2 saved YouTube links/);
  assert.equal(fixture.$('youtube-links').children[0].children[0].textContent, 'Kick/another', 'rows are sorted by host key');
  await fixture.import(backup(undefined, { settings: { opacity: 70 } }));
  assert.deepEqual(fixture.local[KEY], expected, 'older backups retain current YouTube links');
  await fixture.import(backup({ 'kick:only': { channelUrl: URL_A } }));
  assert.match(fixture.confirms.at(-1), /1 saved YouTube link\./);
  assert.match(fixture.$('backup-note').textContent, /Imported 1 saved YouTube link\./);
  fixture.answer = false;
  await fixture.import(backup(expected));
  assert.deepEqual(fixture.local[KEY], { 'kick:only': { channelUrl: URL_A, at: 0 } });
  fixture.answer = true;

  fixture.local[KEY] = plain(expected);
  fixture.emit({ [KEY]: {} }, 'sync'); fixture.emit({}, 'local'); await flush();
  assert.equal(fixture.$('youtube-links').children[0].children[0].textContent, 'Kick/only', 'unrelated changes do not redraw');
  fixture.emit({ [KEY]: {} }); await flush();
  const remove = fixture.$('youtube-links').children[0].children[2];
  await remove.click();
  assert.deepEqual(fixture.requests.at(-1), { cmd: 'youtubeLinkForgetSaved', hostKey: 'kick:another', channelUrl: URL_B });
  assert.deepEqual(fixture.local[KEY], { 'twitch:example': expected['twitch:example'] }, 'forget applies to one host only');
  assert.match(fixture.$('youtube-links-note').textContent, /forgotten/);
  assert.equal(remove.disabled, false);
  const stale = fixture.$('youtube-links').children[0].children[2];
  fixture.local[KEY]['twitch:example'] = { channelUrl: URL_B, at: 30 };
  await stale.click();
  assert.equal(fixture.local[KEY]['twitch:example'].channelUrl, URL_B);
  assert.match(fixture.$('youtube-links-note').textContent, /changed in another tab/);
  assert.equal(fixture.$('youtube-links').children[0].children[1].textContent, URL_B);
  for (const response of [undefined, { error: 'storage' }]) {
    fixture.send = async () => response;
    await fixture.$('youtube-links').children[0].children[2].click();
    assert.match(fixture.$('youtube-links-note').textContent, /could not be forgotten/);
  }
  fixture.send = async () => { throw Error('worker unavailable'); };
  const refused = fixture.$('youtube-links').children[0].children[2];
  await refused.click();
  assert.equal(refused.disabled, false, 'an unavailable worker allows retry');
  fixture.send = null;
  await fixture.$('youtube-links').children[0].children[2].click();
  assert.match(fixture.$('youtube-links').children[0].textContent, /No saved YouTube links/);

  fixture.read = async key => { if (key === KEY) throw Error('blocked'); return {}; };
  fixture.emit({ [KEY]: {} }); await flush();
  assert.match(fixture.$('youtube-links-note').textContent, /could not be read/);
  let resolveOld, rejectOld;
  for (const rejects of [false, true]) {
    let first = true;
    fixture.read = key => {
      if (key !== KEY) return {};
      if (first) { first = false; return new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }); }
      return { [KEY]: expected };
    };
    fixture.emit({ [KEY]: {} }); fixture.emit({ [KEY]: {} }); await flush();
    fixture.$('youtube-links-note').textContent = 'newer status';
    if (rejects) rejectOld(Error('late failure')); else resolveOld({ [KEY]: {} });
    await flush();
    assert.equal(fixture.$('youtube-links').children.length, 2, 'late reads cannot overwrite newer rows');
    assert.equal(fixture.$('youtube-links-note').textContent, 'newer status', 'late failure cannot overwrite newer status');
  }
  const css = fs.readFileSync(path.join(ROOT, 'src/options/options.css'), 'utf8');
  assert.match(css, /\.youtube-link-row\s*\{\s*flex-wrap:\s*wrap/);
  assert.match(css, /\.youtube-link-row \.to\s*\{[^}]*overflow-wrap:\s*anywhere/);
}

module.exports = { run, openOptions };
if (require.main === module) run().then(() => console.log('YouTube link backup/options tests passed')).catch(error => { console.error(error); process.exitCode = 1; });
