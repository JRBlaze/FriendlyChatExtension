// Public-page lookup for permitted suggestions and manual Add; no API key or script execution.
(function (FCM) {
  'use strict';

  const VIDEO = /^[A-Za-z0-9_-]{11}$/;
  const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
  const PAGE_LIMIT = 4 * 1024 * 1024;

  function initialData(html, name) {
    const assignment = new RegExp('<script\\b[^>]*>\\s*(?:var\\s+)?' + name + '\\s*=\\s*\\{').exec(html);
    if (!assignment) throw Error('Unsupported page');
    const start = assignment.index + assignment[0].length - 1;
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < html.length; index++) {
      const character = html[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) return JSON.parse(html.slice(start, index + 1));
    }
    throw Error('Incomplete page');
  }

  async function readPage(url, signal) {
    const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal });
    if (!response.ok || response.url !== url || !/^text\/html\b/i.test(response.headers.get('content-type'))) throw Error('Unavailable page');
    const reader = response.body.getReader(), decoder = new TextDecoder(), pieces = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > PAGE_LIMIT) throw Error('Page too large');
        pieces.push(decoder.decode(value, { stream: true }));
      }
      return pieces.join('') + decoder.decode();
    } finally { reader.releaseLock(); }
  }

  function liveCard(content) {
    if (content.videoRenderer) {
      const card = content.videoRenderer;
      const live = (card.badges || []).some(badge => badge.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW')
        || (card.thumbnailOverlays || []).some(overlay => overlay.thumbnailOverlayTimeStatusRenderer?.style === 'LIVE');
      return { id: card.videoId, live };
    }
    if (content.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      const card = content.lockupViewModel;
      const live = (card.contentImage?.thumbnailViewModel?.overlays || []).some(overlay =>
        (overlay.thumbnailBottomOverlayViewModel?.badges || []).some(badge => badge.thumbnailBadgeViewModel?.badgeStyle === 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE'));
      return { id: card.contentId, live };
    }
    return null;
  }

  function channelStreams(data) {
    const owner = data.metadata?.channelMetadataRenderer?.externalId;
    const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs;
    if (!CHANNEL.test(owner) || !Array.isArray(tabs)) throw Error('Unsupported channel');
    const tab = tabs.find(value => value.tabRenderer?.selected === true)?.tabRenderer;
    const endpoint = tab?.endpoint;
    if (endpoint?.browseEndpoint?.browseId !== owner || !endpoint.commandMetadata?.webCommandMetadata?.url?.endsWith('/streams')) throw Error('Unsupported live tab');
    const items = tab.content?.richGridRenderer?.contents;
    if (!Array.isArray(items)) throw Error('Unsupported stream list');
    const ids = new Set(); let cards = 0;
    for (const item of items) {
      const card = liveCard(item.richItemRenderer?.content || {});
      if (!card) continue;
      cards++;
      if (card.live) {
        if (!VIDEO.test(card.id)) throw Error('Invalid live video');
        ids.add(card.id);
      }
    }
    if (!cards) throw Error('Unsupported stream cards');
    return { owner, ids: [...ids] };
  }

  FCM.resolveYouTubeChannel = async function (input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const parsed = FCM.youtube.parseInput(input);
      if (!parsed.channelUrl) return { error: 'unavailable' };
      const data = initialData(await readPage(parsed.channelUrl + '/streams?hl=en', controller.signal), 'ytInitialData');
      const { owner, ids } = channelStreams(data);
      if (!ids.length) return { error: 'not-live' };
      if (ids.length > 1) return { error: 'ambiguous' };
      const videoId = ids[0];
      const player = initialData(await readPage('https://www.youtube.com/watch?v=' + videoId + '&hl=en', controller.signal), 'ytInitialPlayerResponse');
      if (player.videoDetails?.videoId !== videoId || player.videoDetails.channelId !== owner || player.playabilityStatus?.status !== 'OK') return { error: 'unavailable' };
      const live = player.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow;
      if (live === false) return { error: 'not-live' };
      if (live !== true) return { error: 'unavailable' };
      return { videoId };
    } catch (_) { return { error: 'unavailable' }; }
    finally { clearTimeout(timer); controller.abort(); }
  };
})(self.FCM);
