(function (FCM) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const CHECKBOXES = [
    'autoOpen', 'autoConnectHost', 'startCollapsed', 'hideNativeChat',
    'revealHighlights', 'showNativeStats',
    'showHistory', 'showEvents', 'thirdPartyEmotes', 'timestamps', 'showBadges',
    'animations',
  ];
  const SELECTS = ['crossPromptMode', 'theme', 'kickRedirect'];
  const RANGES = [
    { id: 'opacity', suffix: '%' },
    { id: 'fontSize', suffix: 'px' },
    { id: 'maxMessages', suffix: '' },
  ];

  async function bind() {
    const settings = await FCM.loadSettings();

    CHECKBOXES.forEach((key) => {
      const el = $(key);
      el.checked = !!settings[key];
      el.addEventListener('change', () => FCM.saveSettings({ [key]: el.checked }));
    });

    SELECTS.forEach((key) => {
      const el = $(key);
      el.value = settings[key];
      el.addEventListener('change', () => FCM.saveSettings({ [key]: el.value }));
    });

    RANGES.forEach(({ id, suffix }) => {
      const el = $(id);
      const out = $(`${id}-out`);
      el.value = settings[id];
      out.textContent = `${el.value}${suffix}`;
      el.addEventListener('input', () => {
        out.textContent = `${el.value}${suffix}`;
        FCM.saveSettings({ [id]: Number(el.value) });
      });
    });

    const names = $('highlightNames');
    names.value = settings.highlightNames || '';
    let namesTimer = null;
    names.addEventListener('input', () => {
      clearTimeout(namesTimer);
      namesTimer = setTimeout(() => FCM.saveSettings({ highlightNames: names.value }), 400);
    });
  }

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

      const match = record.none ? 'none' : (record.match || 'cache');
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
        delete links[key];
        await chrome.storage.local.set({ [FCM.STORAGE_KEYS.links]: links });
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

  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  bind();
  renderLinks();
  renderEmoteCacheNote();
})(self.FCM);
