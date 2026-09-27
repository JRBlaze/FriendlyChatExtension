'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const CHANNEL = 'https://www.youtube.com/@Example';
const OWNER = 'UC' + 'a'.repeat(22);
const VIDEO = 'abcdefghijk';
const OTHER = 'lmnopqrstuv';
const streamUrl = CHANNEL + '/streams?hl=en';
const watchUrl = 'https://www.youtube.com/watch?v=' + VIDEO + '&hl=en';

function legacy(id = VIDEO, style = 'LIVE') {
  return { videoRenderer: { videoId: id, thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style } }] } };
}
function modern(id = VIDEO, style = 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE') {
  return { lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentImage: {
    thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { badgeStyle: style } }] } }] },
  } } };
}
function listing(cards = [modern()]) {
  return { metadata: { channelMetadataRenderer: { externalId: OWNER } }, contents: { twoColumnBrowseResultsRenderer: { tabs: [
    { tabRenderer: { selected: false, content: { richGridRenderer: { contents: [{ richItemRenderer: { content: legacy(OTHER) } }] } } } },
    { tabRenderer: { selected: true, endpoint: { browseEndpoint: { browseId: OWNER }, commandMetadata: { webCommandMetadata: { url: '/@Example/streams' } } },
      content: { richGridRenderer: { contents: cards.map(content => ({ richItemRenderer: { content } })) } } } },
  ] } } };
}
function player() {
  return { playabilityStatus: { status: 'OK' }, videoDetails: { videoId: VIDEO, channelId: OWNER, isLiveContent: true },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true } } } };
}
function html(name, value, extra = '') {
  return '<html><script nonce="synthetic">var ' + name + ' = ' + JSON.stringify(value) + ';' + extra + '</script></html>';
}
function reply(text, url, options = {}) {
  const chunks = options.chunks || [new TextEncoder().encode(text)];
  let index = 0;
  const state = { released: false };
  return { state, ok: options.ok !== false, url: options.url || url,
    headers: { get() { return options.type === undefined ? 'text/html; charset=utf-8' : options.type; } },
    body: options.noBody ? null : { getReader() { return {
      async read() { if (options.readError) throw Error('read'); return index < chunks.length ? { value: chunks[index++], done: false } : { done: true }; },
      releaseLock() { state.released = true; },
    }; } },
  };
}
function harness(responses) {
  const requests = [], timers = new Map(); let sequence = 0;
  const context = vm.createContext({ URL, Set, TextDecoder, AbortController,
    FCM: { youtube: { parseInput(input) {
      if (input === 'video') return { videoId: VIDEO };
      if (input !== CHANNEL) throw Error('invalid input');
      return { channelUrl: CHANNEL };
    } } },
    setTimeout(fn, ms) { assert.equal(ms, 15000); timers.set(++sequence, fn); return sequence; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      requests.push({ url, options });
      assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
      const next = responses.shift();
      if (typeof next === 'function') return next(url, options);
      if (next instanceof Error) throw next;
      assert.ok(next, 'unexpected network request'); return next;
    },
  });
  context.self = context;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background/youtube-lookup.js'), 'utf8'), context,
    { filename: path.join(ROOT, 'src/background/youtube-lookup.js') });
  return { requests, timers, resolve: context.FCM.resolveYouTubeChannel };
}
const plain = value => JSON.parse(JSON.stringify(value));
async function check(data, expected, p = player(), pageOptions = {}) {
  const page = reply(typeof data === 'string' ? data : html('ytInitialData', data), streamUrl, pageOptions);
  const watch = reply(typeof p === 'string' ? p : html('ytInitialPlayerResponse', p), watchUrl);
  const h = harness([page, watch]);
  assert.deepEqual(plain(await h.resolve(CHANNEL)), expected);
  assert.equal(h.timers.size, 0, 'deadline cleared');
  for (const request of h.requests) assert.equal(request.options.signal.aborted, true, 'network work cancelled after completion');
  return { h, page, watch };
}

async function run() {
  const success = await check(listing(), { videoId: VIDEO });
  assert.deepEqual(success.h.requests.map(r => r.url), [streamUrl, watchUrl]);
  assert.equal(success.page.state.released, true); assert.equal(success.watch.state.released, true);
  await check(listing([legacy()]), { videoId: VIDEO });
  await check(listing([{ videoRenderer: { videoId: VIDEO, badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] } }]), { videoId: VIDEO });
  await check(listing([legacy(), modern(), { unrelatedRenderer: { videoId: OTHER, style: 'LIVE' } }]), { videoId: VIDEO });
  const escaped = listing(); escaped.description = 'Quoted "brace } and slash\\ plus { remain data';
  await check(html('ytInitialData', escaped, 'window.unrelated = true;'), { videoId: VIDEO });
  await check(listing([modern(VIDEO, 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT'), legacy(OTHER, 'UPCOMING')]), { error: 'not-live' });
  const ambiguous = await check(listing([modern(), legacy(OTHER)]), { error: 'ambiguous' });
  assert.equal(ambiguous.h.requests.length, 1, 'ambiguous channels do not load a chosen video');
  await check(listing([modern('invalid')]), { error: 'unavailable' });
  await check(listing([legacy('invalid')]), { error: 'unavailable' });
  await check(listing([]), { error: 'unavailable' });
  await check(listing([{ lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_CHANNEL' } }]), { error: 'unavailable' });
  await check(listing([{ videoRenderer: { videoId: VIDEO } }, { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: OTHER } }]), { error: 'not-live' });
  const missingBadge = modern(); missingBadge.lockupViewModel.contentImage.thumbnailViewModel.overlays = [{}, { thumbnailBottomOverlayViewModel: {} }];
  await check(listing([missingBadge]), { error: 'not-live' });
  const sparse = listing([legacy()]); sparse.contents.twoColumnBrowseResultsRenderer.tabs.unshift({ unrelated: true });
  sparse.contents.twoColumnBrowseResultsRenderer.tabs[2].tabRenderer.content.richGridRenderer.contents.unshift({ continuationItemRenderer: {} });
  await check(sparse, { videoId: VIDEO });
  for (const mutate of [
    d => { delete d.metadata; }, d => { d.metadata.channelMetadataRenderer.externalId = 'wrong'; },
    d => { delete d.contents; }, d => { d.contents.twoColumnBrowseResultsRenderer.tabs = {}; },
    d => { d.contents.twoColumnBrowseResultsRenderer.tabs[1].tabRenderer.selected = false; },
    d => { delete d.contents.twoColumnBrowseResultsRenderer.tabs[1].tabRenderer.endpoint; },
    d => { d.contents.twoColumnBrowseResultsRenderer.tabs[1].tabRenderer.endpoint.browseEndpoint.browseId = 'other'; },
    d => { d.contents.twoColumnBrowseResultsRenderer.tabs[1].tabRenderer.endpoint.commandMetadata.webCommandMetadata.url = '/@Example/videos'; },
    d => { delete d.contents.twoColumnBrowseResultsRenderer.tabs[1].tabRenderer.content; },
  ]) { const d = listing(); mutate(d); await check(d, { error: 'unavailable' }); }
  for (const text of ['<html>consent</html>', '<script>var ytInitialData = {', '<script>var ytInitialData = {bad};</script>',
    '<script>var ytInitialData = {"unclosed":"value };</script>']) await check(text, { error: 'unavailable' });
  for (const mutate of [
    p => { delete p.videoDetails; }, p => { p.videoDetails.channelId = 'UC' + 'b'.repeat(22); },
    p => { p.videoDetails.videoId = OTHER; }, p => { p.playabilityStatus.status = 'LOGIN_REQUIRED'; },
    p => { delete p.playabilityStatus; }, p => { delete p.microformat; },
    p => { p.microformat.playerMicroformatRenderer.liveBroadcastDetails.isLiveNow = 'true'; },
  ]) { const p = player(); mutate(p); await check(listing(), { error: 'unavailable' }, p); }
  const ended = player(); ended.microformat.playerMicroformatRenderer.liveBroadcastDetails.isLiveNow = false;
  await check(listing(), { error: 'not-live' }, ended);
  await check(listing(), { error: 'unavailable' }, '<html>watch unavailable</html>');
  for (const options of [{ ok: false }, { url: 'https://other.example/' }, { type: 'application/json' }, { type: null }, { noBody: true }, { readError: true },
    { chunks: [new Uint8Array(4 * 1024 * 1024 + 1)] }]) await check(listing(), { error: 'unavailable' }, player(), options);
  const network = harness([Error('network')]); assert.deepEqual(plain(await network.resolve(CHANNEL)), { error: 'unavailable' }); assert.equal(network.timers.size, 0);
  for (const value of ['video', 'https://evil.example/', null]) { const h = harness([]); assert.deepEqual(plain(await h.resolve(value)), { error: 'unavailable' }); assert.equal(h.requests.length, 0); }
  const hung = harness([(_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted'))))]);
  const pending = hung.resolve(CHANNEL); [...hung.timers.values()][0]();
  assert.deepEqual(plain(await pending), { error: 'unavailable' }); assert.equal(hung.timers.size, 0);
  console.log('YouTube channel lookup tests passed.');
}
module.exports = run;
module.exports.fixtures = { CHANNEL, OWNER, VIDEO, streamUrl, watchUrl, listing, player, html, reply };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
