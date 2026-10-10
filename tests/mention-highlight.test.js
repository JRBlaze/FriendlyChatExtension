const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

function fixture() {
  const document = { createElement() { return { className: '', dataset: {}, innerHTML: '',
    classList: { add() {} }, addEventListener() {} }; } };
  const context = vm.createContext({ document, console, URL }); context.self = context;
  for (const file of ['src/shared/namespace.js', 'src/shared/constants.js', 'src/shared/youtube.js', 'src/shared/youtube-links.js',
    'src/shared/util.js', 'src/shared/emote-parsers.js', 'src/content/render.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: path.join(ROOT, file) });
  }
  const F = context.FCM;
  F.setViewSettings({ ...F.DEFAULT_SETTINGS, highlightNames: 'JRBlaze, alert, red alert' });
  const row = (platform, text, extra = {}) => F.buildMessageEl({ platform, author: 'AnotherViewer', text, ...extra }, new Set([platform]));
  return { F, row };
}

async function run() {
  const { F, row } = fixture();
  for (const platform of ['twitch', 'kick', 'youtube']) {
    for (const text of ['@JRBlaze good day', 'jrblaze, hello', 'This is an ALERT!', 'red alert']) {
      const message = row(platform, text);
      assert.match(message.className, /fcm-mentioned/);
      assert.match(message.innerHTML, /class="fcm-highlight-tag">HIGHLIGHTED<\/span>/);
      assert.match(message.innerHTML, /class="fcm-mention"/);
    }
    for (const text of ['hello', 'NotJRBlaze', 'alertness', 'https://example.test/jrblaze']) {
      const message = row(platform, text);
      assert.doesNotMatch(message.className, /fcm-mentioned/);
      assert.doesNotMatch(message.innerHTML, /fcm-highlight-tag/);
    }
    const self = row(platform, '@JRBlaze alert', { author: 'JRBlaze' });
    assert.doesNotMatch(self.className, /fcm-mentioned/, 'own posts retain their existing exemption');
    assert.doesNotMatch(self.innerHTML, /fcm-highlight-tag/);
    const hostile = row(platform, '<img src=x onerror=alert(1)> @JRBlaze');
    assert.doesNotMatch(hostile.innerHTML, /<img src=x/);
  }
  F.setMentionAccounts({ twitch: { connected: true, login: 'ViewerOne' }, kick: { connected: true, login: '@ViewerTwo' } });
  assert.match(row('kick', '@ViewerOne').className, /fcm-mentioned/);
  assert.match(row('twitch', '@ViewerTwo').className, /fcm-mentioned/);
  assert.equal(F.view.settings.highlightNames, 'JRBlaze, alert, red alert', 'automatic identities never rewrite preferences');
  F.setViewSettings({ ...F.DEFAULT_SETTINGS, highlightNames: 'keyword' });
  assert.match(row('twitch', '@ViewerOne keyword').className, /fcm-mentioned/);
  F.setViewSettings({ ...F.DEFAULT_SETTINGS, highlightNames: 'Viewer, keyword' });
  assert.match(row('twitch', '@ViewerOne').className, /fcm-mentioned/, 'a shorter configured word cannot swallow an automatic username');
  F.setMentionAccounts({ twitch: { connected: false, login: 'ViewerOne' }, kick: { connected: true, login: 123 } });
  assert.doesNotMatch(row('twitch', '@ViewerOne').className, /fcm-mentioned/);
  assert.match(row('twitch', 'keyword').className, /fcm-mentioned/);
  F.setMentionAccounts(null);
  F.setMentionAccounts({ twitch: { connected: true, login: 'ViewerOne' } });
  F.resetChannelView();
  assert.doesNotMatch(row('twitch', 'ViewerOne').className, /fcm-mentioned/, 'navigation clears transient account identities');
  F.setYouTubeIdentity('@YTViewer');
  assert.match(row('youtube', '@YTViewer').className, /fcm-mentioned/);
  assert.doesNotMatch(row('youtube', 'keyword', { author: '@YTViewer' }).className, /fcm-mentioned/);
  F.setEmotes('twitch', 'thirdparty', { keyword: { url: 'https://example.test/emote.png' } });
  assert.doesNotMatch(row('twitch', 'keyword').className, /fcm-mentioned/, 'emote names do not trigger highlights');

  for (const value of ['', 'red', '#12345', '#000000', '#ffffff', '#ff0000', '#0000ff', '#1e90ff', '#8a2be2', '#daa520']) {
    const style = F.authorColorStyle(value, true);
    if (!/^#[0-9a-f]{6}$/i.test(value)) assert.equal(style, '');
    else assert.match(style, /--author-dark:#[0-9a-f]{6};--author-light:#[0-9a-f]{6}/);
  }
  const summaries = [];
  const overlay = require('./youtube-sending-ui.test').fixture({ onMentionAccounts: accounts => summaries.push(accounts) });
  await overlay.api.mount();
  overlay.api.setAccounts({ twitch: { connected: true, login: 'Viewer' }, kick: { connected: false, login: '' } });
  assert.equal(summaries.at(-1).twitch.login, 'Viewer', 'account summaries are forwarded to the current overlay matcher');
  overlay.api.setAccounts(null);
  assert.equal(summaries.at(-1).twitch.login, 'Viewer', 'an omitted summary does not discard known accounts');
  overlay.api.destroy();

  const css = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
  assert.match(css, /\.fcm-msg\.fcm-mentioned\s*\{[^}]*var\(--highlight-row-bg\)/);
  assert.match(css, /\.fcm-highlight-tag\s*\{/);
  console.log('Mention/highlight row regressions passed.');
}
module.exports = { run, fixture };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
