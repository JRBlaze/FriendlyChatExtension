// The YouTube reader transports plain text only. No page-provided HTML,
// image URL, account capability, or sending instruction crosses this boundary.
(function (FCM) {
  'use strict';

  const VIDEO = /^[A-Za-z0-9_-]{11}$/;
  const RUN = /^[a-f0-9]{32}$/;
  const ROW_ID = /^[A-Za-z0-9_+=/-]{1,200}$/;
  const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
  const ROW_SELECTOR = 'yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer';

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

  // Iterative traversal has a node and character budget, so deeply nested or
  // enormous markup cannot turn a DOM update into unbounded work. Emoji become
  // their accessible text; their src attributes are deliberately never read.
  function plainText(element, limit) {
    if (!element) return '';
    const stack = [element];
    let text = '', visited = 0;
    while (stack.length && text.length < limit && visited++ < 1000) {
      const node = stack.pop();
      if (node.nodeType === 3) text += node.nodeValue.slice(0, limit - text.length);
      else if (node.nodeType === 1) {
        if (node.tagName === 'IMG') text += (node.getAttribute('alt') || '').slice(0, limit - text.length);
        else if (node.tagName === 'BR') text += '\n';
        else if (!['SCRIPT', 'STYLE', 'TEMPLATE'].includes(node.tagName)) {
          // Only queue the remaining node budget, even for a very broad tree.
          const count = Math.min(node.childNodes.length, 1000 - visited - stack.length);
          for (let i = count - 1; i >= 0; i--) stack.push(node.childNodes[i]);
        }
      }
    }
    return clean(text, limit);
  }

  function rowId(row, video) {
    const id = row.getAttribute('id');
    return typeof id === 'string' && ROW_ID.test(id) ? 'youtube:' + video + ':' + id : '';
  }

  function parseRow(row, video, now) {
    const id = rowId(row, video);
    if (!id || row.hasAttribute('is-deleted')) return null;
    const displayName = plainText(row.querySelector('#author-name'), 100);
    const text = plainText(row.querySelector('#message'), 2000);
    if (!displayName || !text) return null;
    return { platform: 'youtube', id, username: displayName, displayName, text, ts: now, badges: [], readOnly: true };
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
      messages.push({ platform: 'youtube', id: message.id, username: message.username,
        displayName: message.displayName, text: message.text, ts: message.ts, badges: [], readOnly: true });
    }
    const deleted = [];
    for (const id of input.deleted) {
      if (!validId(id, expectedVideo)) return null;
      deleted.push(id);
    }
    return { type: 'batch', run: expectedRun, videoId: expectedVideo, messages, deleted, ready: input.ready };
  }

  FCM.youtube = { videoId, parseInput, parseRow, rowId, sanitizeBatch, ROW_SELECTOR };
})(self.FCM);
