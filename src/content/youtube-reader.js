// This isolated-world reader runs only in an explicitly marked embedded chat.
// Visiting YouTube normally, including a top-level popout, does not activate it.
(function (FCM) {
  'use strict';

  if (window === window.top) return;
  const sourceUrl = location.href;
  const url = new URL(sourceUrl);
  const marker = /^#fcm-youtube=([a-f0-9]{32})(&role=sender)?$/.exec(url.hash);
  if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/live_chat'
    || !marker || url.searchParams.getAll('v').length !== 1) return;
  let video;
  try { video = FCM.youtube.videoId(url.searchParams.get('v')); } catch (_) { return; }
  if (video !== url.searchParams.get('v')) return;
  const run = marker[1];
  const sending = !!marker[2];
  let port;
  try { port = chrome.runtime.connect({ name: 'fcm-youtube-reader' }); } catch (_) { return; }

  let stopped = false, active = false, observer = null;
  let nativeSender = null;
  let accessHelper = null, accessOpen = false, accessReloadReady = false;
  let nativeState = { available: false, reason: 'composer-unavailable' }, restoringAccess = false;
  let ackTimer = null, heartbeat = null, queued = null;
  let initialScanDone = false;
  const seen = new Map();

  function stop(disconnect) {
    if (stopped) return;
    stopped = true;
    clearTimeout(ackTimer);
    clearInterval(heartbeat);
    clearTimeout(queued);
    if (observer) observer.disconnect();
    if (nativeSender) nativeSender.destroy();
    if (accessHelper) accessHelper.destroy();
    seen.clear();
    window.removeEventListener('pagehide', onPageHide);
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
    if (disconnect) {
      try { port.disconnect(); } catch (_) { /* The extension may already be gone. */ }
    }
  }

  function onDisconnect() { void chrome.runtime.lastError; stop(false); }
  function onPageHide() { stop(true); }

  function postSend(type, value) {
    if (stopped) return;
    try { port.postMessage({ ...value, type, videoId: video, run }); }
    catch (_) { stop(true); }
  }

  function remember(id, state) {
    seen.set(id, state);
    if (seen.size > 4000) seen.delete(seen.keys().next().value);
  }

  function scan() {
    if (stopped) return;
    if (location.href !== sourceUrl) { stop(true); return; }
    if (nativeSender) nativeSender.refresh();
    if (stopped) return;
    // Sending has its own native page. Its optimistic rows never enter capture.
    if (sending) return;
    const ready = !!document.querySelector('yt-live-chat-item-list-renderer');
    const history = !initialScanDone;
    if (ready) initialScanDone = true;
    let messages = [], deleted = [];
    function flush() {
      try { port.postMessage({ type: 'batch', run, videoId: video, messages, deleted, ready }); }
      catch (_) { stop(true); return false; }
      messages = [];
      deleted = [];
      return true;
    }
    const rows = document.querySelectorAll(FCM.youtube.ROW_SELECTOR);
    // A source can show history as well as live rows. Only read the most recent
    // 1000 DOM rows per scan; batches and the dedupe window are separately bounded.
    for (let i = Math.max(0, rows.length - 1000); i < rows.length; i++) {
      const row = rows[i], id = FCM.youtube.rowId(row, video);
      if (!id) continue;
      if (row.hasAttribute('is-deleted')) {
        if (seen.get(id) === 'deleted') continue;
        deleted.push(id);
        remember(id, 'deleted');
      } else {
        if (seen.has(id)) continue;
        const message = FCM.youtube.parseRow(row, video, Date.now());
        if (!message) continue;
        if (history) message.history = true;
        messages.push(message);
        remember(id, 'message');
      }
      if (messages.length + deleted.length === 100 && !flush()) return;
    }
    // Empty batches are also heartbeats; no chat content is persisted or logged.
    flush();
  }

  function schedule() {
    if (stopped || queued !== null) return;
    queued = setTimeout(() => { queued = null; scan(); }, 100);
  }

  function onMessage(message) {
    if (stopped || !message || message.videoId !== video || message.run !== run) return;
    if (message.cmd === 'send') {
      if (active && nativeSender && !accessOpen && !restoringAccess) nativeSender.send({ sequence: message.sequence, capability: message.capability, text: message.text });
      return;
    }
    if (message.cmd === 'access-open') {
      if (active && accessHelper) { accessOpen = true; accessHelper.open(); }
      return;
    }
    if (message.cmd === 'access-close') {
      if (accessHelper) { accessOpen = false; restoringAccess = false; accessReloadReady = false; accessHelper.close(); }
      return;
    }
    if (message.cmd === 'access-reload') {
      if (accessReloadReady && accessHelper && location.href === sourceUrl) {
        accessReloadReady = false;
        try { location.reload(); }
        catch (_) {
          accessOpen = false; restoringAccess = false; accessHelper.close();
          postSend('access-state', { access: 'error' }); postSend('access-close', {});
        }
      }
      return;
    }
    if (active || message.type !== 'reader-ready') return;
    active = true;
    clearTimeout(ackTimer);
    if (sending && FCM.createYouTubeSender) {
      nativeSender = FCM.createYouTubeSender({ document,
        onState: value => { nativeState = value; postSend('send-state', value); }, onResult: value => postSend('send-result', value),
        isCurrent: () => !stopped && location.href === sourceUrl });
      if (stopped) { nativeSender.destroy(); return; }
    }
    if (sending && FCM.BROWSER === 'firefox' && FCM.createYouTubeAccess) {
      accessHelper = FCM.createYouTubeAccess({ document,
        onState(access) {
          if (access === 'requesting') restoringAccess = true;
          else if (access !== 'granted') restoringAccess = false;
          postSend('access-state', { access });
        },
        onReload() {
          if (stopped || (!accessOpen && !restoringAccess) || accessReloadReady || location.href !== sourceUrl) return;
          accessReloadReady = true; postSend('access-reload', {});
        },
        onClose() { accessOpen = false; restoringAccess = false; accessReloadReady = false; postSend('access-close', {}); },
        canRestore: () => !stopped && location.href === sourceUrl && !nativeState.available && nativeState.reason !== 'busy' && !accessOpen,
        isCurrent: () => !stopped && location.href === sourceUrl });
      if (stopped) { accessHelper.destroy(); return; }
    }
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['is-deleted'] });
    heartbeat = setInterval(scan, 5000);
    scan();
  }

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  window.addEventListener('pagehide', onPageHide);
  ackTimer = setTimeout(() => stop(true), 10000);
})(self.FCM);
