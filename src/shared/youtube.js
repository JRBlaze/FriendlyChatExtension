// The YouTube reader transports text and bounded, validated emote ranges.
// No page HTML, account capability or sending instruction crosses this boundary.
(function (FCM) {
  'use strict';

  const VIDEO = /^[A-Za-z0-9_-]{11}$/;
  const RUN = /^[a-f0-9]{32}$/;
  const ROW_ID = /^[A-Za-z0-9_+=/-]{1,200}$/;
  const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
  const EVENT_TAGS = {
    'yt-live-chat-paid-message-renderer': 'superchat', 'yt-live-chat-paid-sticker-renderer': 'sticker',
    'yt-live-chat-membership-item-renderer': 'membership',
    'yt-live-chat-sponsorships-gift-purchase-announcement-renderer': 'gift',
    'yt-live-chat-sponsorships-gift-redemption-announcement-renderer': 'gift-received',
  };
  const EVENT_LABELS = { superchat: 'Super Chat', sticker: 'Super Sticker', membership: 'Membership',
    gift: 'Gifted memberships', 'gift-received': 'Membership received' };
  const ROW_SELECTOR = ['yt-live-chat-text-message-renderer', ...Object.keys(EVENT_TAGS)].join(', ');

  function videoId(input) {
    if (typeof input !== 'string' || input.length > 2048) throw Error('Enter a YouTube live-video URL or video ID.');
    const value = input.trim();
    if (VIDEO.test(value)) return value;
    let url;
    try { url = new URL(value); } catch (_) { throw Error('Enter a YouTube live-video URL or video ID.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error('Use a public HTTPS YouTube video URL.');
    let id = '';
    if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
    else if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) {
      if (url.pathname === '/watch' || url.pathname === '/live_chat') id = url.searchParams.get('v');
      else if (url.pathname.startsWith('/live/')) id = url.pathname.slice(6);
    }
    if (!VIDEO.test(id)) throw Error('Enter a specific YouTube live video, not a channel URL.');
    return id;
  }

  // Keep videoId strict for the transport; channel inputs only enter the
  // permission-gated lookup and never become frame URLs themselves.
  function parseInput(input) {
    try { return { videoId: videoId(input) }; } catch (_) { /* Try a channel URL. */ }
    const invalid = () => Error('Enter a YouTube live video or channel URL.');
    if (typeof input !== 'string' || input.length > 2048) throw invalid();
    let url;
    try { url = new URL(input.trim()); } catch (_) { throw invalid(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) throw invalid();
    let parts;
    try { parts = url.pathname.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent); }
    catch (_) { throw invalid(); }
    const handle = parts[0].startsWith('@');
    const size = handle ? 1 : 2;
    if (parts.length > size && (parts.length !== size + 1
      || !['live', 'streams', 'videos', 'featured'].includes(parts[size]))) throw invalid();
    const name = handle ? parts[0].slice(1) : parts[1];
    if (typeof name !== 'string' || !/^[\p{L}\p{N}\p{M}_.·-]{1,100}$/u.test(name)) throw invalid();
    if (!handle && (parts[0] === 'channel' ? !/^UC[A-Za-z0-9_-]{22}$/.test(name)
      : !['c', 'user'].includes(parts[0]))) throw invalid();
    const channelPath = handle ? '@' + encodeURIComponent(name) : parts[0] + '/' + encodeURIComponent(name);
    return { channelUrl: 'https://www.youtube.com/' + channelPath };
  }

  function clean(value, limit) {
    return value.replace(CONTROLS, '').slice(0, limit).trim();
  }

  // Only native chat image hosts and YouTube's static emoji directory are allowed.
  // URLs stay separate from text and are checked again at each transport boundary.
  function emoteUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2048) return '';
    let url;
    try { url = new URL(value, 'https://www.youtube.com'); } catch (_) { return ''; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return '';
    const allowed = ['yt3.ggpht.com', 'yt3.googleusercontent.com'].includes(url.hostname)
      ? /^\/[A-Za-z0-9_=-]+$/.test(url.pathname)
      : url.hostname === 'www.youtube.com' && /^\/s\/gaming\/emoji\/[A-Za-z0-9_/-]+\.(?:png|webp|gif|svg)$/.test(url.pathname);
    return allowed ? url.href : '';
  }

  function sanitizeEmotes(value, text) {
    if (!Array.isArray(value) || value.length > 32) return [];
    const result = [];
    let end = 0;
    for (const item of value) {
      if (!item || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)
        || item.start < end || item.end <= item.start || item.end > text.length || item.end - item.start > 100) continue;
      const name = text.slice(item.start, item.end), url = emoteUrl(item.url);
      if (!url || !name.trim() || name.trim() !== name) continue;
      result.push({ start: item.start, end: item.end, url });
      end = item.end;
    }
    return result;
  }

  // Iterative traversal has a node and character budget, so deeply nested or
  // enormous markup cannot turn a DOM update into unbounded work. Image ranges
  // refer to their alt text; unsupported images always retain that text.
  function plainText(element, limit, emotes) {
    if (!element) return '';
    const stack = [element];
    let text = '', visited = 0;
    while (stack.length && text.length < limit && visited++ < 1000) {
      const node = stack.pop();
      if (node.nodeType === 3) text += node.nodeValue.slice(0, limit - text.length).replace(CONTROLS, '');
      else if (node.nodeType === 1) {
        if (node.tagName === 'IMG') {
          const raw = node.getAttribute('alt') || '';
          const start = text.length;
          const name = raw.slice(0, limit - start).replace(CONTROLS, '');
          text += name;
          if (emotes && emotes.length < 32 && name && raw.length <= 100 && raw.length <= limit - start
            && /(?:^|\s)emoji(?:\s|$)/.test(node.getAttribute('class') || '')) {
            const url = emoteUrl(node.getAttribute('src'));
            if (url) emotes.push({ start, end: text.length, url });
          }
        }
        else if (node.tagName === 'BR') text += '\n';
        else if (!['SCRIPT', 'STYLE', 'TEMPLATE'].includes(node.tagName)) {
          // Only queue the remaining node budget, even for a very broad tree.
          const count = Math.min(node.childNodes.length, 1000 - visited - stack.length);
          for (let i = count - 1; i >= 0; i--) stack.push(node.childNodes[i]);
        }
      }
    }
    const leading = text.length - text.trimStart().length;
    if (emotes) for (const item of emotes) { item.start -= leading; item.end -= leading; }
    return clean(text, limit);
  }

  function rowId(row, video) {
    const id = row.getAttribute('id');
    return typeof id === 'string' && ROW_ID.test(id) ? 'youtube:' + video + ':' + id : '';
  }

  function sanitizeBadges(value) {
    if (!Array.isArray(value) || value.length > 4) return [];
    const badges = [];
    for (const badge of value) {
      if (!badge || !['owner', 'moderator', 'member', 'verified'].includes(badge.type)
        || !boundedText(badge.label, 100) || badges.some(item => item.type === badge.type)) continue;
      const url = emoteUrl(badge.url);
      if (url) badges.push({ type: badge.type, label: badge.label, url });
    }
    return badges;
  }

  function sanitizeEvent(value) {
    if (!value || !Object.hasOwn(EVENT_LABELS, value.kind)) return null;
    return { kind: value.kind, amount: boundedText(value.amount, 100) ? value.amount : '',
      header: boundedText(value.header, 300) ? value.header : '' };
  }

  function parseRow(row, video, now) {
    const id = rowId(row, video);
    if (!id || row.hasAttribute('is-deleted')) return null;
    const displayName = plainText(row.querySelector('#author-name'), 100);
    const images = [];
    let text = plainText(row.querySelector('#message'), 2000, images);
    const kind = EVENT_TAGS[String(row.tagName || '').toLowerCase()];
    const youtubeEvent = sanitizeEvent({ kind,
      amount: kind ? plainText(row.querySelector('#purchase-amount'), 100) : '',
      header: kind ? plainText(row.querySelector('#header-subtext') || row.querySelector('#primary-text')
        || row.querySelector('#header-primary-text'), 300) : '',
    });
    if (kind === 'sticker' && !text) {
      const sticker = row.querySelector('#sticker img');
      text = sticker ? clean(sticker.getAttribute('alt') || '', 100) : '';
      const url = sticker && emoteUrl(sticker.getAttribute('src'));
      if (text && url) images.push({ start: 0, end: text.length, url });
    }
    if (!text && youtubeEvent) text = youtubeEvent.header || EVENT_LABELS[kind];
    const youtubeBadges = sanitizeBadges(Array.from(row.querySelectorAll
      ? row.querySelectorAll('yt-live-chat-author-badge-renderer') : []).slice(0, 4).map(badge => ({
      type: badge.getAttribute('type'), label: clean(badge.getAttribute('aria-label') || '', 100),
      url: badge.querySelector('img')?.getAttribute('src'),
    })));
    if (!displayName || !text) return null;
    const youtubeEmotes = sanitizeEmotes(images, text);
    return { platform: 'youtube', id, username: displayName, displayName, text, ts: now, badges: [], readOnly: true,
      ...(youtubeEmotes.length ? { youtubeEmotes } : {}),
      ...(youtubeEvent ? { youtubeEvent } : {}), ...(youtubeBadges.length ? { youtubeBadges } : {}) };
  }

  function validId(value, video) {
    const prefix = 'youtube:' + video + ':';
    return typeof value === 'string' && value.startsWith(prefix) && ROW_ID.test(value.slice(prefix.length));
  }

  function boundedText(value, limit) {
    return typeof value === 'string' && value.length > 0 && value.length <= limit && clean(value, limit) === value;
  }

  function sanitizeBatch(input, expectedVideo, expectedRun) {
    if (!input || input.type !== 'batch' || !VIDEO.test(expectedVideo) || !RUN.test(expectedRun)
      || input.videoId !== expectedVideo || input.run !== expectedRun || typeof input.ready !== 'boolean'
      || !Array.isArray(input.messages) || input.messages.length > 100
      || !Array.isArray(input.deleted) || input.deleted.length > 100) return null;
    const messages = [];
    for (const message of input.messages) {
      if (!message || !validId(message.id, expectedVideo) || !boundedText(message.username, 100)
        || !boundedText(message.displayName, 100) || !boundedText(message.text, 2000)
        || !Number.isSafeInteger(message.ts) || message.ts < 0) return null;
      const youtubeEmotes = sanitizeEmotes(message.youtubeEmotes, message.text);
      const youtubeEvent = sanitizeEvent(message.youtubeEvent), youtubeBadges = sanitizeBadges(message.youtubeBadges);
      messages.push({ platform: 'youtube', id: message.id, username: message.username,
        displayName: message.displayName, text: message.text, ts: message.ts, badges: [], readOnly: true,
        ...(message.history === true ? { history: true } : {}),
        ...(youtubeEmotes.length ? { youtubeEmotes } : {}),
        ...(youtubeEvent ? { youtubeEvent } : {}), ...(youtubeBadges.length ? { youtubeBadges } : {}) });
    }
    const deleted = [];
    for (const id of input.deleted) {
      if (!validId(id, expectedVideo)) return null;
      deleted.push(id);
    }
    return { type: 'batch', run: expectedRun, videoId: expectedVideo, messages, deleted, ready: input.ready };
  }

  FCM.youtube = { videoId, parseInput, parseRow, rowId, sanitizeBatch, emoteUrl, sanitizeEmotes, sanitizeBadges, sanitizeEvent, EVENT_LABELS, ROW_SELECTOR };
})(self.FCM);
