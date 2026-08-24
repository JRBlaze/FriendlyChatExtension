(function (FCM) {
  'use strict';

  FCM.escapeHtml = function (str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  FCM.escapeRegExp = function (value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  FCM.normalizeChannel = function (name) {
    return String(name || '')
      .trim()
      .replace(/^[#@]/, '')
      .toLowerCase();
  };

  FCM.clampNumber = function (value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };

  FCM.safeJsonParse = function (value, fallback = {}) {
    if (typeof value !== 'string') return value || fallback;
    if (!value) return fallback;
    try { return JSON.parse(value); } catch (e) { return fallback; }
  };

  FCM.firstPresent = function (...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  };

  FCM.usernameFrom = function (value) {
    if (!value) return null;
    if (typeof value === 'string') return value;
    return value.username || value.name || value.login || value.slug || null;
  };

  FCM.ftime = function (ts) {
    const d = ts ? new Date(ts) : new Date();
    const safe = Number.isNaN(d.getTime()) ? new Date() : d;
    return `${String(safe.getHours()).padStart(2, '0')}:${String(safe.getMinutes()).padStart(2, '0')}`;
  };

  FCM.backoffDelay = function (attempt) {
    return Math.min(
      FCM.RECONNECT_BASE_DELAY_MS * (2 ** attempt),
      FCM.RECONNECT_MAX_DELAY_MS
    );
  };

  // Fetch JSON without letting a failing provider reject the caller.
  FCM.getJson = function (url, init) {
    return fetch(url, init)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  };

  FCM.loadSettings = async function () {
    try {
      const stored = await chrome.storage.sync.get(FCM.STORAGE_KEYS.settings);
      return { ...FCM.DEFAULT_SETTINGS, ...(stored[FCM.STORAGE_KEYS.settings] || {}) };
    } catch (e) {
      return { ...FCM.DEFAULT_SETTINGS };
    }
  };

  // Saving is read-modify-write, so two of them overlapping would let the second
  // read stale settings and drop the first one's change — which is easy to hit
  // by flipping two toggles quickly. Writes are chained so each one sees the
  // result of the last.
  let savingChain = Promise.resolve();

  FCM.saveSettings = function (patch) {
    savingChain = savingChain.then(async () => {
      const current = await FCM.loadSettings();
      const next = { ...current, ...patch };
      await chrome.storage.sync.set({ [FCM.STORAGE_KEYS.settings]: next });
      return next;
    }).catch(async () => {
      // A failed write must not poison every save that follows it.
      const current = await FCM.loadSettings();
      return { ...current, ...patch };
    });
    return savingChain;
  };

  // Turns a status line into a labelled row, the way the desktop app does, so
  // "Kick: disconnected" renders with a Kick chip rather than as body text.
  FCM.formatSystemMessage = function (txt) {
    let message = String(txt || '').trim();
    let label = 'Status';
    let type = 'status';

    const bracketMatch = message.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (bracketMatch) {
      label = bracketMatch[1].trim();
      message = bracketMatch[2].trim();
    } else {
      const prefixMatch = message.match(/^(Twitch|Kick)\s*:\s*(.*)$/i);
      if (prefixMatch) {
        label = prefixMatch[1];
        message = prefixMatch[2].trim();
      } else if (/\bTwitch\b/i.test(message)) {
        label = 'Twitch';
      } else if (/\bKick\b/i.test(message)) {
        label = 'Kick';
      }
    }

    if (/history/i.test(message)) {
      label = label === 'Status' ? 'History' : `${label} History`;
      type = 'history';
    } else if (/error|failed|could not|unavailable|disconnected|reconnect limit/i.test(message)) {
      type = 'error';
    } else if (/^twitch$/i.test(label)) {
      type = 'twitch';
    } else if (/^kick$/i.test(label)) {
      type = 'kick';
    }

    return { label, type, message: message || String(txt || '') };
  };
})(self.FCM);
