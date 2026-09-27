// A tab-local bridge for the opt-in YouTube frame. Credentials stay inside the
// native page; capture and sending use separate, role-bound frames.
(function () {
  'use strict';
  const hosts = new Map();
  const HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'kick.com', 'www.kick.com']);
  const RUN = /^[a-f0-9]{32}$/;
  const READER_ID = 'fcm-youtube-reader';
  const ACCESS_STATES = ['unknown', 'needed', 'granted', 'denied', 'unsupported', 'error', 'requesting'];
  const lookups = new Set();
  const suggestions = new Map();
  const pendingSuggestions = new Map();
  let networkJobs = 0;
  let registration = null;
  let accessRevoked = false;

  function ensureReader() {
    if (!registration) {
      registration = (async () => {
        const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [READER_ID] });
        if (!existing.length) {
          await chrome.scripting.registerContentScripts([{
            id: READER_ID, matches: ['https://www.youtube.com/live_chat*'],
            js: ['src/shared/namespace.js', 'src/shared/youtube.js', 'src/content/youtube-send.js', 'src/content/youtube-access.js', 'src/content/youtube-reader.js'],
            allFrames: true, runAt: 'document_idle', persistAcrossSessions: false,
          }]);
        }
      })().finally(() => { registration = null; });
    }
    return registration;
  }

  function senderUrl(sender, reader) {
    if (!sender || sender.id !== chrome.runtime.id || !sender.tab
      || !Number.isInteger(sender.tab.id) || sender.tab.id < 0
      || !Number.isInteger(sender.frameId) || (reader ? sender.frameId <= 0 : sender.frameId !== 0)) return null;
    try {
      const url = new URL(sender.url);
      if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
      if (reader) {
        if (url.hostname !== 'www.youtube.com' || url.pathname !== '/live_chat'
          || url.searchParams.getAll('v').length !== 1 || !/^#fcm-youtube=[a-f0-9]{32}(&role=sender)?$/.test(url.hash)) return null;
      } else if (!HOSTS.has(url.hostname)) return null;
      return url;
    } catch (e) { return null; }
  }

  function disconnect(port) {
    try { port.disconnect(); } catch (e) { /* Already disconnected. */ }
  }

  function post(port, message) {
    try { port.postMessage(message); return true; } catch (e) { return false; }
  }

  function close(entry) {
    if (hosts.get(entry.tabId) !== entry) return;
    hosts.delete(entry.tabId);
    if (entry.reader) disconnect(entry.reader);
    if (entry.sender) disconnect(entry.sender);
    disconnect(entry.host);
  }

  function includesYouTube(permissions) {
    return Array.isArray(permissions?.origins) && permissions.origins.some(origin => [
      'https://www.youtube.com/*', '*://www.youtube.com/*', 'https://*.youtube.com/*', '*://*.youtube.com/*',
      'https://*/*', '*://*/*', '<all_urls>',
    ].includes(origin));
  }

  // Injected readers may outlive a removed permission. Close their ports so
  // any pending native preparation is cancelled before a later button click.
  if (chrome.permissions?.onRemoved) chrome.permissions.onRemoved.addListener(permissions => {
    if (!includesYouTube(permissions)) return;
    accessRevoked = true;
    for (const entry of [...hosts.values()]) {
      post(entry.host, { type: 'permission-revoked', videoId: entry.videoId, run: entry.run });
      close(entry);
    }
  });
  if (chrome.permissions?.onAdded) chrome.permissions.onAdded.addListener(permissions => {
    if (includesYouTube(permissions)) accessRevoked = false;
  });

  const RESULT_REASONS = ['invalid-request', 'stale-capability', 'busy', 'draft-not-empty', 'signed-out', 'restricted',
    'composer-unavailable', 'not-current', 'input-rejected', 'native-error', 'timeout', 'submitted', 'disconnected', 'permission', 'stale-sequence'];

  function cleanSendState(message) {
    if (typeof message.available !== 'boolean' || !['ready', 'signed-out', 'restricted', 'composer-unavailable', 'busy'].includes(message.reason)
      || message.available !== (message.reason === 'ready') || typeof message.accountLabel !== 'string'
      || message.accountLabel.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(message.accountLabel)
      || (message.available && !message.accountLabel.trim()) || !Number.isSafeInteger(message.capability)
      || message.capability <= 0 || message.maxLength !== 200) return null;
    return { type: 'send-state', available: message.available, reason: message.reason, accountLabel: message.accountLabel,
      capability: message.capability, maxLength: 200 };
  }

  function sendResult(entry, sequence, outcome, reason) {
    const result = { type: 'send-result', videoId: entry.videoId, run: entry.run, sequence, outcome, reason };
    entry.lastResult = result;
    if (!post(entry.host, result)) close(entry);
  }

  function finishSend(entry, request, outcome, reason) {
    if (hosts.get(entry.tabId) !== entry || entry.pending !== request) return;
    entry.pending = null;
    sendResult(entry, request.sequence, outcome, reason);
  }

  function endAccess(entry, error = '') {
    if (entry.reload) { dropSender(entry); error = 'failed'; }
    entry.accessVersion++; entry.accessOpen = false; entry.accessRestoring = false; entry.accessReloadPending = false; entry.reload = null;
    if (entry.sender && !post(entry.sender, { cmd: 'access-close', videoId: entry.videoId, run: entry.run })) {
      dropSender(entry); error = 'failed';
    }
    if (error && !post(entry.host, { type: 'access-state', access: error, videoId: entry.videoId, run: entry.run })) { close(entry); return; }
    if (!post(entry.host, { type: 'access-close', videoId: entry.videoId, run: entry.run })) close(entry);
  }

  function dropSender(entry) {
    const sender = entry.sender;
    entry.sender = null; entry.sendState = null; entry.senderDisabled = true;
    if (sender) disconnect(sender);
  }

  async function accessCommand(entry, reload) {
    if (!entry.sender || entry.pending || entry.reload || entry.reloadCount || entry.accessReloadPending) {
      if (!reload && !entry.accessOpen && !entry.accessRestoring && !entry.reload) endAccess(entry, 'error');
      return;
    }
    if (reload ? (!entry.accessOpen && entry.access !== 'granted') : entry.accessOpen) return;
    if (reload) entry.accessReloadPending = true; else entry.accessOpen = true;
    const sender = entry.sender, version = ++entry.accessVersion;
    let granted = false;
    try { granted = await chrome.permissions.contains({ origins: ['https://www.youtube.com/*'] }); }
    catch (_) { /* Access setup cannot outlive optional extension permission. */ }
    if (hosts.get(entry.tabId) !== entry || entry.sender !== sender || version !== entry.accessVersion) return;
    entry.accessReloadPending = false;
    if (granted !== true) { endAccess(entry, 'error'); return; }
    if (reload) {
      entry.reload = { frameId: sender.sender.frameId, oldPort: sender, newPort: null };
      entry.reloadCount++; entry.sendState = null;
      if (!post(entry.host, { type: 'access-reloading', videoId: entry.videoId, run: entry.run })) { close(entry); return; }
    }
    if (!post(sender, { cmd: reload ? 'access-reload' : 'access-open', videoId: entry.videoId, run: entry.run })) {
      dropSender(entry); endAccess(entry, 'failed');
    }
  }

  async function sendNative(entry, message) {
    if (message.videoId !== entry.videoId || message.run !== entry.run
      || !Number.isSafeInteger(message.sequence) || message.sequence <= 0) return;
    const sequence = message.sequence;
    if (sequence <= entry.sequence) {
      if (entry.lastResult && entry.lastResult.sequence === sequence) {
        if (!post(entry.host, entry.lastResult)) close(entry);
      } else if (!entry.pending || entry.pending.sequence !== sequence) sendResult(entry, sequence, 'not-sent', 'stale-sequence');
      return;
    }
    entry.sequence = sequence;
    if (entry.pending || entry.accessOpen || entry.accessRestoring || entry.reload) { sendResult(entry, sequence, 'not-sent', 'busy'); return; }
    const request = entry.pending = { sequence, sender: entry.sender, forwarded: false };
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 200
      || /[\u0000-\u001f\u007f-\u009f]/.test(message.text) || !Number.isSafeInteger(message.capability) || message.capability <= 0) {
      finishSend(entry, request, 'not-sent', 'invalid-request'); return;
    }
    if (!entry.sender || !entry.sendState || !entry.sendState.available) {
      finishSend(entry, request, 'not-sent', 'composer-unavailable'); return;
    }
    if (message.capability !== entry.sendState.capability) { finishSend(entry, request, 'not-sent', 'stale-capability'); return; }
    let granted = false;
    try { granted = await chrome.permissions.contains({ origins: ['https://www.youtube.com/*'] }); }
    catch (e) { /* A failed permission check cannot authorize a send. */ }
    if (hosts.get(entry.tabId) !== entry || entry.pending !== request || entry.sender !== request.sender) return;
    if (granted !== true) { finishSend(entry, request, 'not-sent', 'permission'); return; }
    if (!entry.sendState.available || message.capability !== entry.sendState.capability) {
      finishSend(entry, request, 'not-sent', 'stale-capability'); return;
    }
    request.forwarded = true;
    if (!post(request.sender, { cmd: 'send', videoId: entry.videoId, run: entry.run, sequence,
      capability: message.capability, text: message.text })) {
      finishSend(entry, request, 'uncertain', 'disconnected'); close(entry);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || message.cmd !== 'youtubePermission') return false;
    if (!senderUrl(sender, false)) { respond({ granted: false }); return false; }
    try {
      chrome.permissions.contains({ origins: ['https://www.youtube.com/*'] })
        .then(async granted => {
          if (granted !== true) { respond({ granted: false }); return; }
          try { await ensureReader(); respond({ granted: true }); }
          catch (e) { respond({ granted: true, error: 'reader-registration' }); }
        }, () => respond({ granted: false }));
    } catch (e) { respond({ granted: false }); return false; }
    return true;
  });

  async function lookupChannel(channelUrl) {
    if (networkJobs >= 4) return { error: 'busy' };
    networkJobs++;
    try {
      const result = await FCM.resolveYouTubeChannel(channelUrl);
      if (result && typeof result.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(result.videoId)) {
        return { videoId: result.videoId };
      }
      if (result && ['not-live', 'ambiguous', 'unavailable', 'permission', 'busy'].includes(result.error)) {
        return { error: result.error };
      }
      return { error: 'unavailable' };
    } catch (e) { return { error: 'unavailable' }; }
    finally { networkJobs--; }
  }

  function suggestChannel(channelUrl) {
    const cached = suggestions.get(channelUrl);
    if (cached) {
      if (cached.expires > Date.now()) return Promise.resolve(cached.result);
      suggestions.delete(channelUrl);
    }
    if (pendingSuggestions.has(channelUrl)) return pendingSuggestions.get(channelUrl);
    const pending = lookupChannel(channelUrl).then(result => {
      if (result.videoId || result.error === 'not-live' || result.error === 'ambiguous') {
        if (suggestions.size >= 64) suggestions.delete(suggestions.keys().next().value);
        suggestions.set(channelUrl, { result, expires: Date.now() + 30000 });
      }
      return result;
    }).finally(() => { pendingSuggestions.delete(channelUrl); });
    pendingSuggestions.set(channelUrl, pending);
    return pending;
  }

  // Suggestions only inspect public channel metadata after permission. Their
  // short, bounded memory cache never replaces a fresh user-started lookup.
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || (message.cmd !== 'youtubeResolve' && message.cmd !== 'youtubeSuggest')) return false;
    if (!senderUrl(sender, false)) { respond({ error: 'permission' }); return false; }
    let channelUrl;
    try {
      channelUrl = FCM.youtube.parseInput(message.channelUrl).channelUrl;
      if (!channelUrl) throw Error('Not a channel');
    } catch (e) { respond({ error: 'unavailable' }); return false; }
    const key = `${sender.tab.id}:${message.cmd}`;
    if (lookups.has(key)) { respond({ error: 'busy' }); return false; }
    lookups.add(key);
    (async () => {
      let result;
      try {
        const granted = await chrome.permissions.contains({ origins: ['https://www.youtube.com/*'] });
        result = granted === true
          ? await (message.cmd === 'youtubeSuggest' ? suggestChannel(channelUrl) : lookupChannel(channelUrl))
          : { error: 'permission' };
      } catch (e) { result = { error: 'unavailable' }; }
      finally { lookups.delete(key); }
      respond(result);
    })();
    return true;
  });

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'fcm-youtube-host' && port.name !== 'fcm-youtube-reader') return;
    const reader = port.name === 'fcm-youtube-reader';
    const url = senderUrl(port.sender, reader);
    if (!url) { disconnect(port); return; }
    const tabId = port.sender.tab.id;
    if (!reader) {
      const previous = hosts.get(tabId);
      if (previous) close(previous);
      const entry = { tabId, host: port, reader: null, sender: null, videoId: '', run: '', sequence: 0, pending: null, lastResult: null, sendState: null,
        accessOpen: false, accessRestoring: false, access: 'unknown', accessReloadPending: false, accessVersion: 0,
        reload: null, reloadCount: 0, senderDisabled: false };
      hosts.set(tabId, entry);
      port.onDisconnect.addListener(() => close(entry));
      port.onMessage.addListener(message => {
        if (hosts.get(tabId) !== entry || !message) return;
        if (message.cmd === 'send') { sendNative(entry, message); return; }
        if (['access-open', 'access-close', 'access-abort'].includes(message.cmd)) {
          if (message.videoId !== entry.videoId || message.run !== entry.run) return;
          if (message.cmd === 'access-open') { accessCommand(entry, false); return; }
          if (message.cmd === 'access-abort') { dropSender(entry); endAccess(entry); return; }
          if (!entry.accessOpen && !entry.accessRestoring && !entry.reload) return;
          endAccess(entry); return;
        }
        if (message.cmd !== 'start'
          || typeof message.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(message.videoId)
          || typeof message.run !== 'string' || !RUN.test(message.run)) return;
        if (accessRevoked) {
          post(port, { type: 'permission-revoked', videoId: message.videoId, run: message.run });
          close(entry); return;
        }
        if (entry.videoId === message.videoId && entry.run === message.run) {
          if (!post(port, { type: 'host-ready', videoId: entry.videoId, run: entry.run })) close(entry);
          return;
        }
        const oldReaders = [entry.reader, entry.sender];
        entry.reader = null; entry.sender = null;
        for (const oldReader of oldReaders) if (oldReader) disconnect(oldReader);
        entry.videoId = message.videoId;
        entry.run = message.run;
        entry.sequence = 0; entry.pending = null; entry.lastResult = null; entry.sendState = null;
        entry.accessVersion++; entry.accessOpen = false; entry.accessRestoring = false; entry.access = 'unknown'; entry.accessReloadPending = false;
        entry.reload = null; entry.reloadCount = 0; entry.senderDisabled = false;
        if (!post(port, { type: 'host-ready', videoId: entry.videoId, run: entry.run })) close(entry);
      });
      return;
    }
    const entry = hosts.get(tabId);
    const role = url.hash.endsWith('&role=sender') ? 'sender' : 'reader';
    const otherRole = role === 'sender' ? 'reader' : 'sender';
    const replacement = role === 'sender' && entry?.reload && !entry.reload.newPort && entry.reload.frameId === port.sender.frameId;
    if (!entry || (entry[role] && !replacement) || entry[otherRole]?.sender.frameId === port.sender.frameId
      || (role === 'sender' && (entry.senderDisabled || (entry.reload && !replacement)))
      || entry.videoId !== url.searchParams.get('v')
      || entry.run !== url.hash.slice('#fcm-youtube='.length, '#fcm-youtube='.length + 32)) { disconnect(port); return; }
    if (replacement && entry.sender) { const old = entry.sender; entry.sender = null; disconnect(old); }
    entry[role] = port;
    if (replacement) entry.reload.newPort = port;
    port.onDisconnect.addListener(() => {
      if (hosts.get(tabId) !== entry || entry[role] !== port) return;
      entry[role] = null;
      entry.sendState = null;
      if (role === 'sender' && entry.reload) return;
      if (role === 'sender' && (entry.accessOpen || entry.accessRestoring)) { entry.senderDisabled = true; endAccess(entry, 'failed'); return; }
      if (entry.pending) finishSend(entry, entry.pending, 'uncertain', 'disconnected');
      if (!post(entry.host, { type: 'reader-disconnected', videoId: entry.videoId, run: entry.run })) close(entry);
    });
    port.onMessage.addListener(message => {
      if (hosts.get(tabId) !== entry || entry[role] !== port) return;
      if (role === 'sender') {
        if (!message || message.videoId !== entry.videoId || message.run !== entry.run) return;
        if (message.type === 'access-state') {
          if (ACCESS_STATES.includes(message.access)) {
            entry.access = message.access;
            if (message.access === 'requesting') entry.accessRestoring = true;
            else if (message.access !== 'granted') entry.accessRestoring = false;
            if (!post(entry.host, { type: 'access-state', access: message.access, videoId: entry.videoId, run: entry.run })) close(entry);
          }
          return;
        }
        if (message.type === 'access-reload') { accessCommand(entry, true); return; }
        if (message.type === 'access-close') { if (entry.accessOpen || entry.accessRestoring || entry.reload) endAccess(entry); return; }
        if (message.type === 'send-state') {
          if (entry.reload && entry.reload.oldPort === port) return;
          const state = cleanSendState(message);
          if (state) {
            entry.sendState = state;
            if (entry.reload && entry.reload.oldPort !== port && state.available) {
              entry.reload = null; entry.accessOpen = false; entry.accessRestoring = false; entry.accessVersion++;
            }
            if (!post(entry.host, { ...state, videoId: entry.videoId, run: entry.run })) close(entry);
          }
          return;
        }
        if (message.type === 'send-result') {
          const request = entry.pending;
          if (request && request.forwarded && message.sequence === request.sequence
            && ['not-sent', 'submitted', 'uncertain'].includes(message.outcome) && RESULT_REASONS.includes(message.reason)
            && (message.outcome !== 'submitted' || message.reason === 'submitted')) {
            finishSend(entry, request, message.outcome, message.reason);
          }
          return;
        }
        return;
      }
      const batch = FCM.youtube.sanitizeBatch(message, entry.videoId, entry.run);
      if (batch && !post(entry.host, batch)) close(entry);
    });
    if (!post(port, { type: 'reader-ready', videoId: entry.videoId, run: entry.run })) {
      entry[role] = null;
      disconnect(port);
      if (role === 'sender' && (entry.accessOpen || entry.accessRestoring || entry.reload)) {
        entry.senderDisabled = true; endAccess(entry, 'failed'); return;
      }
      if (!post(entry.host, { type: 'reader-disconnected', videoId: entry.videoId, run: entry.run })) close(entry);
    }
  });
})();
