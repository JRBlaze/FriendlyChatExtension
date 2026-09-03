(function (FCM) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const CHECKBOXES = [
    'autoOpen', 'autoConnectHost', 'startCollapsed', 'hideNativeChat',
    'watchWhenLive', 'revealHighlights', 'showNativeStats', 'autoClaimBonus',
    'showHistory', 'showEvents', 'thirdPartyEmotes', 'timestamps', 'showBadges',
    'animations', 'showGifs', 'showShareReminders', 'modHoverTools', 'showClipPreviews',
  ];
  const SELECTS = ['crossPromptMode', 'theme', 'kickRedirect'];
  const RANGES = [
    { id: 'opacity', suffix: '%' },
    { id: 'fontSize', suffix: 'px' },
    { id: 'maxMessages', suffix: '' },
  ];

  // How long a slider has to stop moving before the change is written down.
  const SETTLE_MS = 300;

  // bind() both fills the controls in and wires them up, and an import calls it
  // again to show what was just restored. The listeners must not be attached a
  // second time when it does: a checkbox with two of them writes the same
  // setting twice per click, and the count doubles with every import after
  // that.
  let wired = false;

  async function bind() {
    const settings = await FCM.loadSettings();

    CHECKBOXES.forEach((key) => {
      const el = $(key);
      el.checked = !!settings[key];
      if (wired) return;
      el.addEventListener('change', () => FCM.saveSettings({ [key]: el.checked }));
    });

    SELECTS.forEach((key) => {
      const el = $(key);
      el.value = settings[key];
      if (wired) return;
      el.addEventListener('change', () => FCM.saveSettings({ [key]: el.value }));
    });

    // A slider fires an input event per pixel of the drag. Writing each one
    // through is a chrome.storage write per pixel — enough of them in a minute
    // that the browser starts refusing, which loses the setting the viewer just
    // chose — so the number beside the slider follows the hand and the write
    // waits for it to stop.
    RANGES.forEach(({ id, suffix }) => {
      const el = $(id);
      const out = $(`${id}-out`);
      el.value = settings[id];
      out.textContent = `${el.value}${suffix}`;
      if (wired) return;
      let timer = null;
      el.addEventListener('input', () => {
        out.textContent = `${el.value}${suffix}`;
        clearTimeout(timer);
        timer = setTimeout(() => FCM.saveSettings({ [id]: Number(el.value) }), SETTLE_MS);
      });
      // Letting go is the end of the adjustment, so it need not wait out the
      // timer as well.
      el.addEventListener('change', () => {
        clearTimeout(timer);
        FCM.saveSettings({ [id]: Number(el.value) });
      });
    });

    // The free-text fields, all debounced the same way: a save per keystroke is
    // a storage write per keystroke, and chrome starts refusing them.
    //
    // The last two are here because three separate messages — two from the
    // sign-in code, one from the overlay's own settings sheet — tell people to
    // set them "in the extension options", and until now there was nowhere in
    // this page to do it. A blank value means "use the default", which is what
    // every reader of these keys already falls back to, so the default is shown
    // as the placeholder rather than filled in.
    //
    // The Twitch client id has no default to show: it comes from the proxy,
    // which is not asked until somebody signs in. Its placeholder says so in
    // the markup instead.
    const TEXTS = [
      { id: 'highlightNames' },
      { id: 'twitchClientId' },
      { id: 'kickProxyUrl', fallback: FCM.DEFAULT_KICK_PROXY_URL },
    ];
    TEXTS.forEach(({ id, fallback }) => {
      const el = $(id);
      if (!el) return;
      if (fallback) el.placeholder = fallback;
      // Shown empty when it is only the default, so clearing the box and
      // leaving it clear reads the same as never having touched it.
      const stored = settings[id] || '';
      el.value = (fallback && stored === fallback) ? '' : stored;
      if (wired) return;
      let timer = null;
      el.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => FCM.saveSettings({ [id]: el.value.trim() }), 400);
      });
    });

    wired = true;
  }

  // ── Backup ──────────────────────────────────────────────────────────────────

  // Which storage area each backed-up store actually lives in. Settings are
  // written to both, and loadSettings takes whichever was stamped last — so an
  // import that wrote only local would be beaten by whatever sync still held.
  const BACKUP_AREAS = { settings: 'both', links: 'local', geometry: 'local', sendTargets: 'local' };

  function backupNote(text, kind) {
    const note = $('backup-note');
    note.textContent = text;
    note.dataset.kind = kind || '';
  }

  async function readStores() {
    const out = {};
    await Promise.all(FCM.BACKUP_STORES.map(async (name) => {
      const key = FCM.STORAGE_KEYS[name];
      try {
        // Settings are read through loadSettings so the file carries the
        // resolved set — the same one the overlay is running on — rather than
        // whichever area happened to be written last.
        if (name === 'settings') { out[name] = await FCM.loadSettings(); return; }
        const stored = await chrome.storage.local.get(key);
        if (stored[key]) out[name] = stored[key];
      } catch (e) { /* a store that will not read is one the file does without */ }
    }));
    return out;
  }

  $('export-settings').addEventListener('click', async () => {
    let version = '';
    try { version = chrome.runtime.getManifest().version; } catch (e) { /* not an extension page */ }
    const backup = FCM.buildBackup(await readStores(), version);
    const stamp = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `friendly-chat-settings-${stamp}.json`;
    a.click();
    // Freed on a turn of its own: revoking it in the same tick can beat the
    // download that was just started to it.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const favourites = ((backup.settings || {}).favouriteEmotes || []).length;
    backupNote(`Exported ${favourites} favourite emote${favourites === 1 ? '' : 's'} and every setting.`, 'ok');
  });

  $('import-settings').addEventListener('click', () => $('import-file').click());

  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    // Cleared straight away, so choosing the same file twice in a row is two
    // imports rather than one and then nothing.
    e.target.value = '';
    if (!file) return;

    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      backupNote('That file could not be read as JSON.', 'error');
      return;
    }

    const result = FCM.readBackup(parsed);
    if (!result.ok) { backupNote(result.error, 'error'); return; }

    const c = result.counts;
    const parts = [];
    if (c.settings) parts.push(`${c.settings} setting${c.settings === 1 ? '' : 's'}`);
    if (c.favourites) parts.push(`${c.favourites} favourite emote${c.favourites === 1 ? '' : 's'}`);
    if (c.links) parts.push(`${c.links} channel link${c.links === 1 ? '' : 's'}`);
    if (c.sendTargets) parts.push(`${c.sendTargets} remembered send target${c.sendTargets === 1 ? '' : 's'}`);
    if (c.geometry) parts.push('the panel position');
    const summary = parts.join(', ');

    // Asked before rather than undone after: this replaces what is here now,
    // and the settings it replaces include ones nobody would think to look at
    // until the overlay next behaved differently. Clearing the emote cache is
    // reversible by waiting; this is not.
    if (!window.confirm(`Replace your current settings with this backup?\n\nIt contains ${summary}.\n\nAccount sign-ins are not affected.`)) {
      backupNote('Import cancelled — nothing was changed.', '');
      return;
    }

    try {
      await Promise.all(Object.keys(result.stores).map(async (name) => {
        const value = result.stores[name];
        if (name !== 'settings') {
          await chrome.storage.local.set({ [FCM.STORAGE_KEYS[name]]: value });
          return;
        }
        // Through saveSettings, so it lands in both areas with a fresh stamp —
        // which is also what tells every open overlay to re-read, so the import
        // reaches the tabs already watching a stream without a reload.
        await FCM.saveSettings(value);
      }));
    } catch (err) {
      backupNote('Some of that backup could not be written to storage.', 'error');
      return;
    }

    backupNote(`Imported ${summary}.`, 'ok');
    // The page is drawn from storage, so it has to be drawn again.
    await bind();
    renderLinks();
  });

  async function renderLinks() {
    const container = $('links');
    const stored = await chrome.storage.local.get(FCM.STORAGE_KEYS.links);
    const links = stored[FCM.STORAGE_KEYS.links] || {};
    const entries = Object.entries(links).sort(([a], [b]) => a.localeCompare(b));

    container.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nothing matched yet. Open a channel and the link shows up here.';
      container.appendChild(empty);
      return;
    }

    entries.forEach(([key, record]) => {
      const [platform, channel] = key.split(':');
      const other = FCM.otherPlatform(platform);
      const row = document.createElement('div');
      row.className = 'link-row';

      // A pairing set by hand says so, including one that says there is no
      // counterpart: the section promises hand-set links are kept, and tagging
      // one 'none' made it look like a guess the extension would re-derive.
      const match = record.manual ? 'manual'
        : (record.none ? 'none' : (record.match || 'cache'));
      row.innerHTML = `
        <span class="from">${FCM.escapeHtml(FCM.PLATFORM_META[platform].name)}/${FCM.escapeHtml(channel)}</span>
        <span class="arrow">→</span>
        <span class="to">${record.none
          ? 'no counterpart'
          : `${FCM.escapeHtml(FCM.PLATFORM_META[other].name)}/${FCM.escapeHtml(record.channel || '')}`}</span>
        <span class="tag" data-match="${FCM.escapeHtml(match)}">${FCM.escapeHtml(match)}</span>
      `;

      const remove = document.createElement('button');
      remove.className = 'btn btn-ghost';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        // Re-read rather than writing back the map this page was drawn from.
        // The worker writes to it every time a channel is opened in any tab,
        // and a page left open for an evening holds a snapshot from before all
        // of them — so removing one row put every link discovered since back to
        // how it was, including pairings the viewer had set by hand.
        const current = await chrome.storage.local.get(FCM.STORAGE_KEYS.links);
        const live = current[FCM.STORAGE_KEYS.links] || {};
        delete live[key];
        await chrome.storage.local.set({ [FCM.STORAGE_KEYS.links]: live });
        renderLinks();
      });
      row.appendChild(remove);

      container.appendChild(row);
    });
  }

  $('clear-links').addEventListener('click', async () => {
    const stored = await chrome.storage.local.get(FCM.STORAGE_KEYS.links);
    const links = stored[FCM.STORAGE_KEYS.links] || {};
    // Mappings the user typed in themselves are kept.
    const kept = {};
    Object.entries(links).forEach(([key, record]) => {
      if (record.manual) kept[key] = record;
    });
    await chrome.storage.local.set({ [FCM.STORAGE_KEYS.links]: kept });
    renderLinks();
  });

  // The emote cache is written by the worker and read here only to say how much
  // of it there is, so "clear" is a decision someone can make with a number in
  // front of them rather than a shrug.
  async function renderEmoteCacheNote() {
    const note = $('emote-cache-note');
    const button = $('clear-emote-cache');
    let channels = 0;
    let emotes = 0;
    try {
      const stored = await chrome.storage.local.get(FCM.STORAGE_KEYS.emoteCache);
      const all = stored[FCM.STORAGE_KEYS.emoteCache] || {};
      Object.values(all).forEach((entry) => {
        channels++;
        Object.values((entry && entry.kinds) || {}).forEach((store) => {
          emotes += Object.keys(store || {}).length;
        });
      });
    } catch (e) { /* an unreadable cache is an empty one */ }
    button.disabled = !channels;
    note.textContent = channels
      ? `${emotes.toLocaleString()} emotes from ${channels} channel${channels === 1 ? '' : 's'}`
      : 'Nothing cached yet.';
  }

  $('clear-emote-cache').addEventListener('click', async () => {
    try {
      await chrome.storage.local.remove(FCM.STORAGE_KEYS.emoteCache);
    } catch (e) { /* already gone */ }
    renderEmoteCacheNote();
  });

  // Guarded the way the overlay guards the same call: this runs before
  // anything is bound, so letting it throw would leave the whole page inert
  // rather than merely missing a version number.
  try {
    $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  } catch (e) { /* not running as an extension page */ }

  bind();
  renderLinks();
  renderEmoteCacheNote();
})(self.FCM);
