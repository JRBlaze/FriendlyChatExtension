// The frame stays in the original Twitch/Kick document when the overlay pops out.
// A fresh nonce and port bind every attempt to this tab and this page lifetime.
(function () {
  'use strict';
  FCM.createYouTubeSource = function ({ onBatch, onStatus, onSendState, document: ownerDocument = document }) {
    let current = null;
    let generation = 0;
    let destroyed = false;
    let sendState = { available: false, reason: 'composer-unavailable', accountLabel: '', capability: 0, maxLength: 200, sourceId: '', videoId: '', run: '', access: 'unknown' };
    const accessStates = ['unknown', 'needed', 'granted', 'denied', 'unsupported', 'error', 'requesting', 'failed'];
    const reasons = ['invalid-request', 'stale-capability', 'busy', 'draft-not-empty', 'signed-out', 'restricted',
      'composer-unavailable', 'not-current', 'input-rejected', 'native-error', 'timeout', 'submitted', 'disconnected', 'permission', 'stale-sequence'];

    function setSendState(value) {
      sendState = value;
      if (onSendState) onSendState({ ...value });
    }

    function clearSendState() {
      setSendState({ available: false, reason: 'composer-unavailable', accountLabel: '', capability: 0, maxLength: 200, sourceId: '', videoId: '', run: '', access: 'unknown' });
    }

    function publishSendState(attempt) {
      const value = attempt.nativeState || { available: false, reason: 'composer-unavailable', accountLabel: '', capability: 0,
        maxLength: 200, sourceId: '', videoId: '', run: '' };
      const blocked = attempt.accessOpen || attempt.accessRestoring || attempt.accessReloading;
      setSendState({ ...value, access: attempt.accessReloading ? 'reloading' : blocked ? 'requesting' : attempt.access,
        ...(blocked ? { available: false, reason: 'composer-unavailable', sourceId: '' } : {}) });
    }

    function hideAccess(attempt) {
      attempt.accessOpen = false; attempt.accessRestoring = false; attempt.accessReloading = false;
      if (attempt.access === 'requesting') attempt.access = 'needed';
      clearTimeout(attempt.accessTimer);
      if (attempt.senderFrame) attempt.senderFrame.style.cssText = 'display: none !important;';
      publishSendState(attempt);
    }

    function failAccess(attempt) {
      if (current !== attempt || !attempt.accessReloading) return;
      attempt.access = 'failed'; attempt.nativeState = null; attempt.accessFailed = true;
      hideAccess(attempt);
      if (current !== attempt) return;
      try { attempt.port.postMessage({ cmd: 'access-abort', videoId: attempt.videoId, run: attempt.run }); }
      catch (_) { /* Capture has its own existing liveness/reconnect checks. */ }
      if (attempt.senderFrame) { attempt.senderFrame.remove(); attempt.senderFrame = null; }
      status('connected', 'YouTube chat is connected. Sending setup did not finish; remove and add YouTube chat to retry.');
    }

    function finishSend(attempt, result) {
      const pending = attempt.pending;
      if (!pending) return;
      attempt.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(result);
    }

    function receiveSendState(message, attempt) {
      if (attempt.accessFailed) return;
      if (typeof message.available !== 'boolean' || !['ready', 'signed-out', 'restricted', 'composer-unavailable', 'busy'].includes(message.reason)
        || message.available !== (message.reason === 'ready') || typeof message.accountLabel !== 'string'
        || message.accountLabel.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(message.accountLabel)
        || (message.available && !message.accountLabel.trim()) || !Number.isSafeInteger(message.capability)
        || message.capability <= 0 || message.maxLength !== 200) return;
      attempt.nativeState = { available: message.available, reason: message.reason, accountLabel: message.accountLabel,
        capability: message.capability, maxLength: 200, videoId: attempt.videoId, run: attempt.run,
        sourceId: `${attempt.videoId}:${attempt.run}:${message.capability}${attempt.senderEpoch ? ':' + attempt.senderEpoch : ''}` };
      if (attempt.accessReloading && message.available) hideAccess(attempt);
      else publishSendState(attempt);
    }

    function status(state, text) { onStatus({ state, text }); }

    function release(attempt) {
      if (attempt.pending) finishSend(attempt, { sequence: attempt.pending.sequence, outcome: 'uncertain', reason: 'disconnected' });
      clearSendState();
      clearTimeout(attempt.timer);
      clearTimeout(attempt.retryTimer);
      clearTimeout(attempt.accessTimer);
      attempt.accessOpen = false; attempt.accessRestoring = false; attempt.accessReloading = false;
      attempt.nativeState = null; attempt.access = 'unknown'; attempt.accessFailed = false; attempt.reloadUsed = false; attempt.senderEpoch = 0;
      const port = attempt.port;
      attempt.port = null;
      if (attempt.frame) { attempt.frame.remove(); attempt.frame = null; }
      if (attempt.senderFrame) { attempt.senderFrame.remove(); attempt.senderFrame = null; }
      if (port) {
        try { port.disconnect(); } catch (e) { /* Extension reload already closed it. */ }
      }
    }

    function cancel() {
      generation++;
      const attempt = current;
      current = null;
      if (attempt) release(attempt);
    }

    function failed(attempt) {
      if (current !== attempt) return;
      release(attempt);
      if (attempt.retries >= 3) {
        current = null;
        status('error', 'YouTube chat is unavailable or blocked. Check the live URL and choose Add chat to retry.');
        return;
      }
      const delay = 2000 * (2 ** attempt.retries++);
      status('connecting', 'YouTube chat disconnected. Reconnecting…');
      attempt.retryTimer = setTimeout(() => retry(attempt), delay);
    }

    async function retry(attempt) {
      let result;
      try { result = await chrome.runtime.sendMessage({ cmd: 'youtubePermission' }); }
      catch (e) { /* A restarted background must prove access again. */ }
      if (current !== attempt) return;
      if (!result || result.granted !== true || result.error) {
        cancel();
        status(result?.error ? 'error' : 'permission', result?.error
          ? 'Could not prepare YouTube chat. Reload the extension and try again.'
          : 'Allow YouTube access, then choose Add chat again.');
        return;
      }
      connect(attempt);
    }

    function connect(attempt) {
      if (current !== attempt) return;
      try {
        attempt.run = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
        const port = chrome.runtime.connect({ name: 'fcm-youtube-host' });
        attempt.port = port;
        attempt.timer = setTimeout(() => failed(attempt), 20000);
        port.onDisconnect.addListener(() => {
          if (current === attempt && attempt.port === port) failed(attempt);
        });
        port.onMessage.addListener(message => {
          if (current !== attempt || attempt.port !== port || !message
            || message.videoId !== attempt.videoId || message.run !== attempt.run) return;
          if (message.type === 'reader-disconnected') { failed(attempt); return; }
          if (message.type === 'permission-revoked') {
            cancel(); status('permission', 'YouTube access was removed. Allow access, then choose Add chat again.'); return;
          }
          if (message.type === 'send-state') { receiveSendState(message, attempt); return; }
          if (message.type === 'access-state') {
            if (!attempt.accessFailed && accessStates.includes(message.access)) {
              attempt.access = message.access;
              if (message.access === 'failed') {
                attempt.accessFailed = true; attempt.nativeState = null; hideAccess(attempt);
                if (attempt.senderFrame) { attempt.senderFrame.remove(); attempt.senderFrame = null; }
                return;
              }
              if (message.access === 'requesting') attempt.accessRestoring = true;
              else if (message.access !== 'granted') attempt.accessRestoring = false;
              publishSendState(attempt);
            }
            return;
          }
          if (message.type === 'access-close') {
            if (attempt.accessOpen || attempt.accessRestoring || attempt.accessReloading) hideAccess(attempt);
            return;
          }
          if (message.type === 'access-reloading') {
            if ((!attempt.accessOpen && !attempt.accessRestoring) || attempt.reloadUsed) return;
            attempt.reloadUsed = true; attempt.accessReloading = true; attempt.senderEpoch++;
            attempt.nativeState = null; publishSendState(attempt);
            attempt.accessTimer = setTimeout(() => failAccess(attempt), 20000);
            return;
          }
          if (message.type === 'send-result') {
            if (attempt.pending && message.sequence === attempt.pending.sequence
              && ['not-sent', 'submitted', 'uncertain'].includes(message.outcome) && reasons.includes(message.reason)
              && (message.outcome !== 'submitted' || message.reason === 'submitted')) {
              finishSend(attempt, { sequence: message.sequence, outcome: message.outcome, reason: message.reason });
            }
            return;
          }
          if (message.type === 'host-ready') {
            if (attempt.frame) return;
            try {
              // Capture never sends, so optimistic native rows cannot appear
              // alongside their confirmed IDs in the merged feed.
              for (const sending of [false, true]) {
                const url = new URL('https://www.youtube.com/live_chat');
                url.searchParams.set('v', attempt.videoId);
                url.searchParams.set('embed_domain', ownerDocument.location.hostname);
                url.hash = 'fcm-youtube=' + attempt.run + (sending ? '&role=sender' : '');
                const frame = ownerDocument.createElement('iframe');
                if (sending) attempt.senderFrame = frame; else attempt.frame = frame;
                frame.title = sending ? 'YouTube chat sender' : 'YouTube chat source';
                frame.referrerPolicy = 'origin';
                frame.style.cssText = 'display: none !important;';
                frame.src = url.href;
                ownerDocument.body.append(frame);
              }
            } catch (e) { failed(attempt); }
            return;
          }
          const batch = FCM.youtube.sanitizeBatch(message, attempt.videoId, attempt.run);
          if (!batch) return;
          if (batch.ready) {
            clearTimeout(attempt.timer);
            // Background tabs may have their timers batched once per minute.
            attempt.timer = setTimeout(() => failed(attempt), 120000);
            status('connected', 'YouTube connected');
          }
          onBatch(batch);
        });
        port.postMessage({ cmd: 'start', videoId: attempt.videoId, run: attempt.run });
      } catch (e) { failed(attempt); }
    }

    async function start(input) {
      if (destroyed) return false;
      cancel();
      const token = generation;
      let selection;
      try { selection = FCM.youtube.parseInput(input); }
      catch (e) { status('error', 'Enter a YouTube live video or channel URL.'); return false; }
      status('connecting', 'Checking YouTube access…');
      let result;
      try { result = await chrome.runtime.sendMessage({ cmd: 'youtubePermission' }); }
      catch (e) {
        if (token === generation) status('error', 'The extension connection closed. Reload this Twitch or Kick page.');
        return false;
      }
      if (token !== generation) return false;
      if (!result || result.granted !== true) {
        status('permission', 'Allow YouTube access, then choose Add chat again.');
        return false;
      }
      if (result.error) {
        status('error', 'Could not prepare YouTube chat. Reload the extension and try again.');
        return false;
      }
      let videoId = selection.videoId;
      if (selection.channelUrl) {
        status('connecting', 'Finding the channel’s current live stream…');
        try { result = await chrome.runtime.sendMessage({ cmd: 'youtubeResolve', channelUrl: selection.channelUrl }); }
        catch (e) {
          if (token === generation) status('error', 'The YouTube channel could not be checked. Try a direct live-video URL.');
          return false;
        }
        if (token !== generation) return false;
        if (!result || result.error || typeof result.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(result.videoId)) {
          const reason = result && result.error;
          const explanations = new Map([
            ['not-live', 'No current live stream was found on this channel. Try again when it is live, or paste a direct live-video URL.'],
            ['ambiguous', 'More than one live stream was found. Paste the direct live-video URL you want.'],
            ['permission', 'Allow YouTube access, then choose Add chat again.'],
            ['busy', 'A YouTube channel lookup is already in progress. Wait a moment and choose Add chat again.'],
          ]);
          status(reason === 'permission' ? 'permission' : 'error', explanations.get(reason)
            || 'The YouTube channel could not be checked. Try a direct live-video URL.');
          return false;
        }
        videoId = result.videoId;
      }
      const attempt = { videoId, run: '', retries: 0, port: null, frame: null, senderFrame: null,
        timer: null, retryTimer: null, sequence: 0, pending: null, nativeState: null, access: 'unknown',
        accessOpen: false, accessRestoring: false, accessReloading: false, accessFailed: false, accessTimer: null, reloadUsed: false, senderEpoch: 0 };
      current = attempt;
      status('connecting', 'Connecting YouTube chat…');
      connect(attempt);
      return true;
    }

    function send(text) {
      const attempt = current;
      if (typeof text !== 'string' || !text.trim() || text.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(text)) {
        return Promise.resolve({ sequence: 0, outcome: 'not-sent', reason: 'invalid-request' });
      }
      if (!attempt || !attempt.port || !sendState.available) {
        return Promise.resolve({ sequence: 0, outcome: 'not-sent', reason: sendState.reason });
      }
      if (attempt.pending) return Promise.resolve({ sequence: 0, outcome: 'not-sent', reason: 'busy' });
      const sequence = ++attempt.sequence;
      return new Promise(resolve => {
        const pending = attempt.pending = { sequence, resolve, timer: null };
        pending.timer = setTimeout(() => {
          if (attempt.pending !== pending) return;
          finishSend(attempt, { sequence, outcome: 'uncertain', reason: 'timeout' });
          // Tear down the frame to cancel delayed work. Reconnect only reads;
          // this command is never restored or replayed on a replacement frame.
          failed(attempt);
        }, 25000);
        try { attempt.port.postMessage({ cmd: 'send', videoId: attempt.videoId, run: attempt.run,
          sequence, capability: sendState.capability, text }); }
        catch (e) { finishSend(attempt, { sequence, outcome: 'uncertain', reason: 'disconnected' }); failed(attempt); }
      });
    }

    function openAccessSetup() {
      const attempt = current;
      if (destroyed || FCM.BROWSER !== 'firefox' || !attempt || !attempt.port || !attempt.senderFrame
        || attempt.pending || attempt.accessOpen || attempt.accessRestoring || attempt.reloadUsed || attempt.accessFailed || sendState.available
        || !['needed', 'denied', 'error'].includes(attempt.access)) return false;
      attempt.accessOpen = true;
      publishSendState(attempt);
      if (current !== attempt || !attempt.senderFrame) return false;
      attempt.senderFrame.style.cssText = 'display: block !important; position: fixed !important; left: 50% !important; top: 50% !important; transform: translate(-50%, -50%) !important; width: min(420px, 94vw) !important; height: 280px !important; border: 1px solid #777 !important; border-radius: 10px !important; background: #18181b !important; z-index: 2147483647 !important;';
      try { attempt.port.postMessage({ cmd: 'access-open', videoId: attempt.videoId, run: attempt.run }); }
      catch (_) { attempt.access = 'error'; hideAccess(attempt); return false; }
      return true;
    }

    function closeAccessSetup() {
      const attempt = current;
      if (!attempt || (!attempt.accessOpen && !attempt.accessRestoring && !attempt.accessReloading)) return;
      if (attempt.accessReloading) { failAccess(attempt); return; }
      hideAccess(attempt);
      try { attempt.port.postMessage({ cmd: 'access-close', videoId: attempt.videoId, run: attempt.run }); }
      catch (_) { /* Hiding setup never triggers another native action. */ }
    }

    function stop() { cancel(); clearSendState(); status('stopped', 'YouTube is off.'); }
    function destroy() { destroyed = true; stop(); }
    return { start, stop, destroy, send, openAccessSetup, closeAccessSetup, getSendState: () => ({ ...sendState }) };
  };
})();
