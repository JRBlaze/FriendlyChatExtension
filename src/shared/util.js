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

  /**
   * A channel name out of whatever someone pasted.
   *
   * Asked for "the Kick channel", people paste the address of it — which is
   * the most reliable thing they could give us, and used to be stored verbatim
   * as a channel name that could never match anything. A bare name, an @name,
   * a full URL and a bare `kick.com/name` all mean the same thing here.
   *
   * Only the first path segment is taken, so a link to a clip or a video still
   * yields the channel it belongs to.
   */
  FCM.channelFromInput = function (input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    // Anything with a slash in it is treated as an address, with or without a
    // scheme: "kick.com/name" is what you get from copying the address bar of
    // a browser that hides the https.
    const path = /^[a-z]+:\/\//i.test(raw)
      ? raw.replace(/^[a-z]+:\/\/[^/]*/i, '')
      : (raw.includes('/') ? raw.replace(/^[^/]*\.[^/]*/, '') : '');
    const candidate = path
      ? (path.split(/[?#]/)[0].split('/').filter(Boolean)[0] || '')
      : raw;
    return FCM.normalizeChannel(candidate);
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

  /**
   * A date the way a person reads one: month, day and year.
   *
   * The day itself is the answer here, not how long ago it was. "9 years" and
   * "3 months" are a summary of the date, and a summary is not what someone
   * clicking a name is after — they want to see the day the account was made or
   * the day this person started following, and judge it themselves.
   *
   * Rendered in the viewer's own locale, so the order of the parts is whatever
   * they are used to reading.
   *
   * @returns {string} a date, or '' for anything that is not one
   */
  FCM.shortDate = function (value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  FCM.backoffDelay = function (attempt) {
    return Math.min(
      FCM.RECONNECT_BASE_DELAY_MS * (2 ** attempt),
      FCM.RECONNECT_MAX_DELAY_MS
    );
  };

  /**
   * The same, but saying whether anybody answered.
   *
   * `getJson` returns null for "there is nothing there" and for "the request
   * never got through", and most callers are right not to care. The ones that
   * write the answer down are not: remembering "this streamer has no channel on
   * the other platform" because the network was out for five seconds keeps a
   * merge that would have worked from being offered for the next six hours.
   *
   * A 404 is an answer; a refusal, a rate limit, a 5xx or a connection that
   * never opened is not.
   *
   * @returns {Promise<{reachable: boolean, data: *}>}
   */
  FCM.getJsonResult = function (url, init) {
    return fetch(url, init)
      .then(async (r) => {
        if (r.ok) return { reachable: true, data: await r.json().catch(() => null) };
        if (r.status === 404 || r.status === 410) return { reachable: true, data: null };
        return { reachable: false, data: null };
      })
      .catch(() => ({ reachable: false, data: null }));
  };

  // Fetch JSON without letting a failing provider reject the caller.
  FCM.getJson = function (url, init) {
    return fetch(url, init)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  };

  // Settings are written to sync so they follow the account between browsers,
  // and mirrored to local so they survive sync refusing the write.
  //
  // Sync has quotas that local does not: 8KB per item and 120 writes a minute.
  // Starring a run of emotes can reach the second of those, and a refused write
  // used to be swallowed — the star lit up, nothing was stored, and the
  // favourites were gone at the next reload. The mirror is what makes that
  // recoverable rather than silent.
  const stamped = (settings) => ({ ...settings, savedAt: Date.now() });

  async function readArea(area) {
    try {
      const stored = await chrome.storage[area].get(FCM.STORAGE_KEYS.settings);
      return stored[FCM.STORAGE_KEYS.settings] || null;
    } catch (e) {
      return null;
    }
  }

  // An async wrapper, so an area that is not there at all rejects like a failed
  // write rather than throwing where the call is written — which would take the
  // other area's write down with it, and that is the one meant to be the
  // backstop.
  async function writeArea(area, value) {
    await chrome.storage[area].set({ [FCM.STORAGE_KEYS.settings]: value });
  }

  FCM.loadSettings = async function () {
    const [synced, local] = await Promise.all([readArea('sync'), readArea('local')]);
    // Whichever was written last is the one the viewer meant. A device that has
    // never saved has no local copy and simply uses what synced in.
    const newest = (!local && !synced) ? null
      : !local ? synced
        : !synced ? local
          : ((local.savedAt || 0) > (synced.savedAt || 0) ? local : synced);
    return { ...FCM.DEFAULT_SETTINGS, ...(newest || {}) };
  };

  // Saving is read-modify-write, so two of them overlapping would let the second
  // read stale settings and drop the first one's change — which is easy to hit
  // by flipping two toggles quickly. Writes are chained so each one sees the
  // result of the last.
  let savingChain = Promise.resolve();

  FCM.saveSettings = function (patch) {
    savingChain = savingChain.then(async () => {
      const current = await FCM.loadSettings();
      const next = stamped({ ...current, ...patch });
      // Both areas, and neither failure is allowed to stop the other: local is
      // the copy that has to survive, sync is the one that travels.
      const results = await Promise.allSettled([
        writeArea('local', next),
        writeArea('sync', next),
      ]);
      // Only worth saying anything when nothing was written at all. One of the
      // two refusing is exactly what the other is there for.
      if (results.every((r) => r.status === 'rejected')) {
        throw new Error('settings could not be stored');
      }
      return next;
    }).catch(async () => {
      // A failed write must not poison every save that follows it, so the chain
      // is handed a usable object either way — but nothing here pretends the
      // write happened.
      const current = await FCM.loadSettings();
      return { ...current, ...patch };
    });
    return savingChain;
  };

  // ── Backup ──────────────────────────────────────────────────────────────────
  //
  // Everything worth keeping, in one file that can be put somewhere safe.
  //
  // Chrome deletes an extension's storage when the extension is removed, and
  // "remove it, load it again" is a perfectly ordinary way to update one loaded
  // unpacked — so the favourites, the channel pairings and every setting can go
  // without anything having gone wrong. storage.sync brings them back only for
  // somebody signed into Chrome with sync switched on, which is not everybody
  // and is not something this extension can arrange. A file does not depend on
  // any of that.
  //
  // Deliberately not in it:
  //   auth        account tokens. They are per-device credentials, which is why
  //               they live in local and never in sync, and a settings file
  //               that anybody might mail themselves is not where one belongs.
  //               Importing therefore never signs anyone in.
  //   emoteCache  the largest thing stored and the one thing that rebuilds
  //               itself on the next visit anyway.
  //   update      describes this installation rather than this person.
  FCM.BACKUP_FORMAT = 'friendly-chat-extension-backup';
  FCM.BACKUP_VERSION = 1;
  // The storage keys a backup carries, by their name in STORAGE_KEYS.
  FCM.BACKUP_STORES = ['settings', 'links', 'geometry', 'sendTargets'];

  const plainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  // "twitch:somechannel". Anything else was not written by this extension.
  function channelKeyed(store, valueOk) {
    if (!plainObject(store)) return null;
    const out = {};
    Object.keys(store).forEach((key) => {
      const at = String(key).indexOf(':');
      if (at < 1 || key.length <= at + 1) return;
      if (!FCM.PLATFORMS.includes(key.slice(0, at))) return;
      const value = store[key];
      if (!valueOk(value)) return;
      out[key] = value;
    });
    return out;
  }

  /**
   * A settings object with everything this build does not recognise removed.
   *
   * Every key is checked against the type of its default, which is the whole
   * guard: a file is something a person can edit, mail, or be handed, and this
   * writes to storage. A key that is not a setting cannot get in, and neither
   * can a number where a boolean belongs — an opacity of "wide" would apply
   * itself to the panel on the next load and there would be nothing on screen
   * to say why. Anything dropped simply falls back to its default, because
   * loadSettings merges over those anyway.
   */
  function cleanSettings(value) {
    if (!plainObject(value)) return null;
    const out = {};
    Object.keys(FCM.DEFAULT_SETTINGS).forEach((key) => {
      if (!(key in value)) return;
      const fallback = FCM.DEFAULT_SETTINGS[key];
      const incoming = value[key];

      if (Array.isArray(fallback)) {
        if (!Array.isArray(incoming)) return;
        const strings = incoming.filter((v) => typeof v === 'string' && v.trim());
        if (key === 'sendTargets') {
          const targets = strings.filter((p) => FCM.PLATFORMS.includes(p));
          // At least one target always stays selected, so an empty list is not
          // a state to restore anybody into.
          if (targets.length) out[key] = Array.from(new Set(targets));
          return;
        }
        out[key] = Array.from(new Set(strings)).slice(0, FCM.FAVOURITE_EMOTE_LIMIT);
        return;
      }
      if (typeof fallback === 'boolean') {
        if (typeof incoming === 'boolean') out[key] = incoming;
        return;
      }
      if (typeof fallback === 'number') {
        if (typeof incoming === 'number' && Number.isFinite(incoming)) out[key] = incoming;
        return;
      }
      if (typeof incoming === 'string') out[key] = incoming;
    });
    // Dropped on purpose: the stamp says when the settings were last written,
    // and importing is writing them. saveSettings puts the real one on.
    delete out.savedAt;
    return out;
  }

  /**
   * A file, from whatever the storage areas currently hold.
   *
   * @param {object} stores  by BACKUP_STORES name, as read out of storage
   * @param {string} [appVersion]  which build wrote it, for a human reading it
   */
  FCM.buildBackup = function (stores, appVersion) {
    const out = {
      format: FCM.BACKUP_FORMAT,
      backupVersion: FCM.BACKUP_VERSION,
      extensionVersion: String(appVersion || ''),
      savedAt: new Date().toISOString(),
    };
    FCM.BACKUP_STORES.forEach((name) => {
      const value = stores && stores[name];
      if (plainObject(value)) out[name] = value;
    });
    return out;
  };

  /**
   * What is safe to write back, out of a file somebody chose.
   *
   * Never throws and never half-applies: everything is checked first and the
   * caller is handed either a complete set of stores to write or a reason not
   * to write anything. A section that does not survive its check is left out
   * rather than emptied, so importing a file with no channel links in it keeps
   * the links already here instead of quietly deleting them.
   *
   * @param {*} parsed  the parsed JSON, from anywhere
   * @returns {{ok: boolean, error?: string, stores?: object, counts?: object}}
   */
  FCM.readBackup = function (parsed) {
    if (!plainObject(parsed)) {
      return { ok: false, error: 'That file is not a Friendly Chat backup.' };
    }
    if (parsed.format !== FCM.BACKUP_FORMAT) {
      return { ok: false, error: 'That file is not a Friendly Chat backup.' };
    }
    // Forward compatibility is not something this can fake: a newer file may
    // mean things this build would apply wrongly, and saying so is better than
    // importing three quarters of it.
    if (Number(parsed.backupVersion) > FCM.BACKUP_VERSION) {
      return {
        ok: false,
        error: 'That backup was written by a newer version of the extension. '
          + 'Update the extension and try again.',
      };
    }

    const stores = {};
    const counts = {};

    const settings = cleanSettings(parsed.settings);
    if (settings && Object.keys(settings).length) {
      stores.settings = settings;
      counts.settings = Object.keys(settings).length;
      counts.favourites = (settings.favouriteEmotes || []).length;
    }

    const links = channelKeyed(parsed.links, plainObject);
    if (links && Object.keys(links).length) {
      // The same ceiling the discovery cache keeps for itself. A file is not a
      // way around it.
      const keys = Object.keys(links).slice(0, FCM.LINK_STORE_LIMIT);
      const capped = {};
      keys.forEach((k) => { capped[k] = links[k]; });
      stores.links = capped;
      counts.links = keys.length;
    }

    const sendTargets = channelKeyed(parsed.sendTargets, (v) => Array.isArray(v)
      && v.length > 0 && v.every((p) => FCM.PLATFORMS.includes(p)));
    if (sendTargets && Object.keys(sendTargets).length) {
      stores.sendTargets = sendTargets;
      counts.sendTargets = Object.keys(sendTargets).length;
    }

    if (plainObject(parsed.geometry)) {
      const geometry = {};
      FCM.PLATFORMS.forEach((platform) => {
        const box = parsed.geometry[platform];
        if (!plainObject(box)) return;
        // Only the numbers, and only real ones. A width of null lands in
        // clampWhollyOnScreen and comes back out as a panel of no size.
        const ok = ['left', 'top', 'width', 'height']
          .every((f) => typeof box[f] === 'number' && Number.isFinite(box[f]));
        if (ok) geometry[platform] = { ...box, manual: !!box.manual };
      });
      if (Object.keys(geometry).length) {
        stores.geometry = geometry;
        counts.geometry = Object.keys(geometry).length;
      }
    }

    if (!Object.keys(stores).length) {
      return { ok: false, error: 'That backup had nothing in it this version can use.' };
    }
    return { ok: true, stores, counts };
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
