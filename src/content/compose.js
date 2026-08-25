// Composer helpers, ported from Friendly Chat: the emote picker, `:emote` and
// `@name` autocomplete with Tab completion, and the click-a-username menu.
(function (FCM) {
  'use strict';

  const EMOTE_PICKER_PER_GROUP = 250;
  const AC_MAX_EMOTES = 30;
  const AC_MAX_MENTIONS = 15;

  // Every emote currently known, de-duplicated by name. Order defines which
  // store wins when the same name exists in more than one place.
  //
  // Cached against the store version: autocomplete calls this on every
  // keystroke, and rebuilding a few thousand entries each time was by a wide
  // margin the most expensive thing the composer did.
  let emoteIndex = null;
  let emoteIndexVersion = -1;

  FCM.allEmoteEntries = function () {
    if (emoteIndex && emoteIndexVersion === FCM.view.emoteVersion) return emoteIndex;

    const seen = new Set();
    const items = [];
    FCM.PLATFORMS.forEach((platform) => {
      const sets = FCM.view.emotes[platform];
      if (!sets) return;
      [sets.native, sets.thirdparty].forEach((store) => {
        Object.keys(store || {}).forEach((name) => {
          const emote = store[name];
          if (!emote || !emote.url || seen.has(name)) return;
          seen.add(name);
          items.push({
            type: 'emote',
            name,
            // Folded once here rather than on every keystroke of every search.
            lower: name.toLowerCase(),
            url: emote.url,
            source: emote.source || platform,
          });
        });
      });
    });

    emoteIndex = items;
    emoteIndexVersion = FCM.view.emoteVersion;
    return items;
  };

  /**
   * @param {object} ctx { panel, inputEl, feedEl, emoteBtn, toast, onReplyTo }
   *   onReplyTo(platform, name) fires whenever the user addresses a specific
   *   person, so the overlay can point the reply at the chat they are in.
   */
  FCM.createCompose = function (ctx) {
    const { panel, inputEl, feedEl, emoteBtn, toast } = ctx;
    const onReplyTo = ctx.onReplyTo || function () {};
    const onFavourites = ctx.onFavourites || function () {};
    const onModerate = ctx.onModerate || function () {};
    // Asked fresh each time the menu opens: whether this viewer can moderate
    // changes as connections come and go.
    const canModerate = ctx.canModerate || function () { return false; };

    const popup = document.createElement('div');
    popup.className = 'fcm-ac fcm-hidden';
    panel.appendChild(popup);

    const menu = document.createElement('div');
    menu.className = 'fcm-um fcm-hidden';
    panel.appendChild(menu);

    // Mirrors the desktop app's AC object: what is on screen, which row is
    // selected, and where in the input the completion should be written back.
    const AC = { items: [], index: -1, trigger: null, triggerPos: 0, browse: false };

    function esc(v) { return FCM.escapeHtml(v); }

    // ── Popup plumbing ────────────────────────────────────────────────────────

    function positionPopup() {
      const composer = panel.querySelector('.fcm-composer');
      const status = panel.querySelector('.fcm-statusbar');
      const bottom = (composer ? composer.offsetHeight : 42) + (status ? status.offsetHeight : 20);
      popup.style.bottom = `${bottom}px`;
      const header = panel.querySelector('.fcm-header');
      const available = panel.clientHeight - bottom - (header ? header.offsetHeight : 36) - 8;
      popup.style.maxHeight = `${Math.max(120, Math.min(available, 360))}px`;
    }

    function isOpen() { return !popup.classList.contains('fcm-hidden'); }

    function closePopup() {
      popup.classList.add('fcm-hidden');
      popup.innerHTML = '';
      AC.items = []; AC.index = -1; AC.trigger = null; AC.browse = false;
    }

    function openPopup() {
      positionPopup();
      popup.classList.remove('fcm-hidden');
    }

    // One delegated handler covers the emote grid and the suggestion list alike,
    // so no per-item inline handler — and no user-controlled string in an
    // onclick attribute — is ever generated.
    popup.addEventListener('mousedown', (e) => {
      // The star sits inside the cell, so it gets asked first — otherwise
      // favouriting an emote would also insert it.
      const star = e.target.closest('[data-fav]');
      if (star) {
        e.preventDefault();
        e.stopPropagation();
        toggleFavourite(star.dataset.fav);
        return;
      }
      const target = e.target.closest('[data-index]');
      if (!target) return;
      // mousedown, not click: the input must not lose focus before we write to it.
      e.preventDefault();
      const index = Number(target.dataset.index);
      if (Number.isFinite(index)) applyAutocomplete(index);
    });

    // ── Favourites ────────────────────────────────────────────────────────────

    function favourites() {
      const list = FCM.view.settings.favouriteEmotes;
      return Array.isArray(list) ? list : [];
    }

    function isFavourite(name) {
      return favourites().indexOf(name) !== -1;
    }

    function toggleFavourite(name) {
      const list = favourites().slice();
      const at = list.indexOf(name);
      if (at === -1) {
        // Newest first, so the ones just reached for stay easiest to reach for.
        list.unshift(name);
        if (list.length > FCM.FAVOURITE_EMOTE_LIMIT) list.length = FCM.FAVOURITE_EMOTE_LIMIT;
      } else {
        list.splice(at, 1);
      }
      // Applied here as well as saved, so the picker redraws from the new list
      // rather than waiting for the round trip through storage.
      FCM.view.settings = { ...FCM.view.settings, favouriteEmotes: list };
      onFavourites(list);
      if (AC.browse) renderPickerBody(pickerQuery);
    }

    // ── Emote picker ──────────────────────────────────────────────────────────

    let pickerAll = [];
    let pickerQuery = '';

    function cellHtml(item, index) {
      const fav = isFavourite(item.name);
      return `<div class="fcm-emote-cell" data-index="${index}" title="${esc(item.name)}">`
        + `<img src="${esc(item.url)}" alt="${esc(item.name)}" loading="lazy">`
        + `<button class="fcm-emote-fav${fav ? ' fcm-emote-fav-on' : ''}"`
        + ` data-fav="${esc(item.name)}" tabindex="-1"`
        + ` title="${fav ? 'Remove from favourites' : 'Add to favourites'}"`
        + ` aria-label="${fav ? 'Remove' : 'Add'} ${esc(item.name)} ${fav ? 'from' : 'to'} favourites"`
        + '>★</button></div>';
    }

    function renderPickerBody(query) {
      pickerQuery = query || '';
      const q = String(query || '').trim().toLowerCase();
      const matches = q ? pickerAll.filter((e) => e.lower.includes(q)) : pickerAll;
      // Index by position in AC.items, which is what applyAutocomplete reads.
      AC.items = matches;

      const countEl = popup.querySelector('.fcm-ac-count b');
      if (countEl) countEl.textContent = String(matches.length);

      const body = popup.querySelector('.fcm-ac-results');
      if (!body) return;

      if (!matches.length) {
        body.innerHTML = `<div class="fcm-ac-more">No emotes match "${esc(query)}"</div>`;
        return;
      }

      const groups = new Map();
      const favs = [];
      const order = favourites();
      matches.forEach((item, index) => {
        if (isFavourite(item.name)) favs.push({ item, index });
        const key = item.source || 'Emotes';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ item, index });
      });
      // In the order they were starred, not the order the providers list them.
      favs.sort((a, b) => order.indexOf(a.item.name) - order.indexOf(b.item.name));

      const block = (title, entries, cap) => {
        const shown = cap ? entries.slice(0, cap) : entries;
        const hidden = entries.length - shown.length;
        return `<div class="fcm-ac-header">${title} (${entries.length})</div>`
          + '<div class="fcm-emote-grid">'
          + shown.map(({ item, index }) => cellHtml(item, index)).join('')
          + '</div>'
          + (hidden > 0 ? `<div class="fcm-ac-more">+${hidden} more — type to search</div>` : '');
      };

      body.innerHTML = (favs.length ? block('★ Favourites', favs, 0) : '')
        + [...groups.entries()].map(([source, entries]) =>
          block(esc(source), entries, EMOTE_PICKER_PER_GROUP)).join('');
    }

    function toggleEmotePicker() {
      if (isOpen() && AC.browse) { closePopup(); inputEl.focus(); return; }

      pickerAll = FCM.allEmoteEntries();
      if (!pickerAll.length) {
        toast('No emotes loaded yet — connect a chat first');
        return;
      }

      AC.items = pickerAll;
      AC.index = -1;
      AC.trigger = ':';
      AC.browse = true;

      popup.innerHTML = '<div class="fcm-ac-search">'
        + '<input type="text" class="fcm-ac-input" placeholder="Search emotes…" autocomplete="off">'
        + `<span class="fcm-ac-count"><b>${pickerAll.length}</b> emotes</span>`
        + '</div><div class="fcm-ac-results"></div>';

      renderPickerBody('');
      openPopup();

      const search = popup.querySelector('.fcm-ac-input');
      search.addEventListener('input', () => renderPickerBody(search.value));
      search.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); closePopup(); inputEl.focus(); }
      });
      search.focus();
    }

    // ── Typed autocomplete ────────────────────────────────────────────────────

    function updateAutocomplete() {
      const val = inputEl.value;
      const cursor = inputEl.selectionStart;

      // Walk back from the cursor to the nearest trigger, stopping at a space.
      let triggerChar = null;
      let triggerPos = -1;
      let query = '';
      for (let i = cursor - 1; i >= 0; i--) {
        if (val[i] === ':' || val[i] === '@') {
          triggerChar = val[i];
          triggerPos = i;
          query = val.slice(i + 1, cursor);
          break;
        }
        if (val[i] === ' ') break;
      }

      if (!triggerChar || !query.length) { closePopup(); return; }

      let items = [];

      if (triggerChar === ':' && query.length >= 2) {
        const q = query.toLowerCase();
        // Split in one pass instead of filtering then sorting the lot: a short
        // query can match thousands of emotes, and only the first handful are
        // ever shown. The second group is only sorted when it is actually needed.
        const prefix = [];
        const elsewhere = [];
        const all = FCM.allEmoteEntries();
        for (let i = 0; i < all.length; i++) {
          const at = all[i].lower.indexOf(q);
          if (at === 0) prefix.push(all[i]);
          else if (at > 0 && prefix.length < AC_MAX_EMOTES) elsewhere.push(all[i]);
        }
        // Favourites first, then alphabetical: the point of starring one is not
        // having to scroll past everything that shares its first two letters.
        const byName = (a, b) => {
          const fa = isFavourite(a.name);
          const fb = isFavourite(b.name);
          if (fa !== fb) return fa ? -1 : 1;
          return a.name.localeCompare(b.name);
        };
        prefix.sort(byName);
        if (prefix.length >= AC_MAX_EMOTES) {
          items = prefix.slice(0, AC_MAX_EMOTES);
        } else {
          elsewhere.sort(byName);
          items = prefix.concat(elsewhere).slice(0, AC_MAX_EMOTES);
        }
      }

      if (triggerChar === '@') {
        const q = query.toLowerCase();
        items = FCM.recentChatters()
          .filter((c) => c.name.toLowerCase().startsWith(q))
          .sort((a, b) => b.time - a.time)
          .slice(0, AC_MAX_MENTIONS)
          .map((c) => ({ type: 'mention', name: c.name, platform: c.platform }));
      }

      if (!items.length) { closePopup(); return; }

      AC.items = items;
      AC.index = 0; // pre-select, so Tab always has something to complete
      AC.trigger = triggerChar;
      AC.triggerPos = triggerPos;
      AC.browse = false;

      popup.innerHTML = `<div class="fcm-ac-header">${triggerChar === ':' ? 'Emotes' : 'Users'}</div>`
        + items.map((item, i) => {
          const sel = i === 0 ? ' fcm-ac-sel' : '';
          if (item.type === 'emote') {
            return `<div class="fcm-ac-item${sel}" data-index="${i}">`
              + `<img src="${esc(item.url)}" alt="${esc(item.name)}" loading="lazy">`
              + `<span class="fcm-ac-name">${esc(item.name)}</span>`
              + `<span class="fcm-ac-src">${esc(item.source)}</span></div>`;
          }
          return `<div class="fcm-ac-item${sel}" data-index="${i}">`
            + `<span class="fcm-dot fcm-dot-${esc(item.platform)}"></span>`
            + `<span class="fcm-ac-name">@${esc(item.name)}</span>`
            + `<span class="fcm-ac-src">${esc(FCM.PLATFORM_META[item.platform].name)}</span></div>`;
        }).join('');

      openPopup();
    }

    function applyAutocomplete(index) {
      const item = AC.items[index === undefined ? AC.index : index];
      if (!item) return;

      if (AC.browse) {
        // Picker: insert at the cursor, leaving what was already typed alone.
        const pos = inputEl.selectionStart;
        const before = inputEl.value.slice(0, pos);
        const after = inputEl.value.slice(pos);
        const insert = `${item.name} `;
        inputEl.value = before + insert + after;
        const next = (before + insert).length;
        inputEl.setSelectionRange(next, next);
      } else {
        // Typed: replace the trigger and the query with the chosen item.
        const before = inputEl.value.slice(0, AC.triggerPos);
        const after = inputEl.value.slice(inputEl.selectionStart);
        const insert = item.type === 'emote' ? `${item.name} ` : `@${item.name} `;
        inputEl.value = before + insert + after;
        const next = (before + insert).length;
        inputEl.setSelectionRange(next, next);
        // Picking a name out of the list names a person on a specific platform,
        // so the reply should follow them there just as the menu's Reply does.
        if (item.type === 'mention') onReplyTo(item.platform, item.name);
      }

      closePopup();
      inputEl.focus();
    }

    function highlight() {
      popup.querySelectorAll('.fcm-ac-item').forEach((el, i) => {
        el.classList.toggle('fcm-ac-sel', i === AC.index);
        if (i === AC.index) el.scrollIntoView({ block: 'nearest' });
      });
    }

    /** @returns {boolean} true when the key was consumed by the popup */
    function handleKey(e) {
      if (!isOpen()) return false;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        AC.index = Math.min(AC.index + 1, AC.items.length - 1);
        highlight();
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        AC.index = Math.max(AC.index - 1, 0);
        highlight();
        return true;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        // Tab always completes: the selected row, or the first one.
        applyAutocomplete(AC.index >= 0 ? AC.index : 0);
        return true;
      }
      if (e.key === 'Enter') {
        if (AC.browse) return false; // the picker is browsing, so Enter sends
        if (AC.items.length) { e.preventDefault(); applyAutocomplete(AC.index >= 0 ? AC.index : 0); return true; }
      }
      if (e.key === 'Escape') { e.preventDefault(); closePopup(); return true; }
      return false;
    }

    // ── User menu ─────────────────────────────────────────────────────────────

    function closeMenu() { menu.classList.add('fcm-hidden'); menu.innerHTML = ''; }

    function insertMention(name, platform) {
      const prefix = `@${name} `;
      const current = inputEl.value;
      // Replying to a second person should add to the message, not replace it.
      inputEl.value = current.trim() ? `${current.replace(/\s*$/, ' ')}${prefix}` : prefix;
      inputEl.focus();
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      if (platform) onReplyTo(platform, name);
    }

    // Kick counts timeouts in whole minutes, so a one-second purge is not a
    // thing there and offering it would quietly cost the viewer a full minute.
    function presetsFor(platform) {
      return platform === 'kick'
        ? FCM.TIMEOUT_PRESETS.filter((preset) => preset.seconds >= 60)
        : FCM.TIMEOUT_PRESETS;
    }

    function addAction(label, opts) {
      const btn = document.createElement('button');
      btn.className = `fcm-um-action${opts.danger ? ' fcm-um-danger' : ''}`;
      // Display names are user-controlled and must never end up in markup that
      // gets executed, so the label is set as text and the handler as a function.
      btn.textContent = label;
      if (opts.hint) {
        const hint = document.createElement('span');
        hint.className = 'fcm-um-hint';
        hint.textContent = opts.hint;
        btn.appendChild(hint);
      }
      if (opts.disabled) btn.disabled = true;
      else btn.addEventListener('click', opts.run);
      menu.appendChild(btn);
    }

    function openMenu(event, authorEl) {
      event.preventDefault();
      event.stopPropagation();
      const name = authorEl.dataset.name || '';
      const platform = authorEl.dataset.platform || '';
      if (!name || !FCM.PLATFORM_META[platform]) return;

      // Acting on the message that was actually clicked is more precise than
      // guessing at "their last one", and it is the id the APIs want.
      const row = authorEl.closest('.fcm-msg');
      const meta = FCM.PLATFORM_META[platform];
      const target = {
        username: name,
        userId: (row && row.dataset.userId) || '',
        messageId: (row && row.dataset.msgId) || '',
      };

      menu.innerHTML = `<div class="fcm-um-head"><span class="fcm-dot fcm-dot-${esc(platform)}"></span>`
        + `<b>${esc(name)}</b><span>${esc(meta.name)}</span></div>`;

      addAction(`Reply on ${meta.name}`, {
        hint: `@${name}`,
        run: () => { insertMention(name, platform); closeMenu(); },
      });
      addAction('Copy username', {
        run: () => { navigator.clipboard.writeText(name).catch(() => {}); closeMenu(); },
      });
      addAction(`Open their ${meta.name} channel`, {
        run: () => {
          window.open(
            platform === 'twitch'
              ? `https://www.twitch.tv/${encodeURIComponent(name.toLowerCase())}`
              : `https://kick.com/${encodeURIComponent(name.toLowerCase())}`,
            '_blank', 'noopener'
          );
          closeMenu();
        },
      });

      // ── Moderation, shown only where this viewer actually holds the badge ──
      if (canModerate(platform)) {
        const act = (action, extra) => {
          onModerate(platform, action, Object.assign({}, target, extra));
          closeMenu();
        };

        const heading = document.createElement('div');
        heading.className = 'fcm-um-section';
        heading.textContent = `Moderate on ${meta.name}`;
        menu.appendChild(heading);

        const timeouts = document.createElement('div');
        timeouts.className = 'fcm-um-timeouts';
        presetsFor(platform).forEach((preset) => {
          const btn = document.createElement('button');
          btn.className = 'fcm-um-timeout';
          btn.textContent = preset.label;
          btn.title = preset.hint || `Time ${name} out for ${preset.label}`;
          btn.addEventListener('click', () => act('timeout', { seconds: preset.seconds }));
          timeouts.appendChild(btn);
        });
        menu.appendChild(timeouts);

        addAction('Delete this message', {
          disabled: !target.messageId,
          hint: target.messageId ? '' : 'no id',
          run: () => act('delete'),
        });
        addAction('Remove timeout / unban', { run: () => act('unban') });
        addAction(`Ban ${name}`, { danger: true, run: () => act('ban') });
      }

      menu.classList.remove('fcm-hidden');
      // Position within the panel, kept inside its edges.
      const panelRect = panel.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const x = Math.max(4, Math.min(
        event.clientX - panelRect.left,
        panelRect.width - menuRect.width - 4
      ));
      const y = Math.max(4, Math.min(
        event.clientY - panelRect.top,
        panelRect.height - menuRect.height - 4
      ));
      menu.style.left = `${Math.round(x)}px`;
      menu.style.top = `${Math.round(y)}px`;
    }

    // One delegated listener for every username in the feed, rather than a
    // handler on each of the hundreds of rendered rows.
    feedEl.addEventListener('click', (e) => {
      const author = e.target.closest('.fcm-author');
      if (author) openMenu(e, author);
      else closeMenu();
    });

    panel.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.fcm-um') && !e.target.closest('.fcm-author')) closeMenu();
      if (!e.target.closest('.fcm-ac') && !e.target.closest('.fcm-input')
        && !e.target.closest('.fcm-emote-btn')) closePopup();
    });

    // ── Wiring ────────────────────────────────────────────────────────────────

    inputEl.addEventListener('input', updateAutocomplete);
    if (emoteBtn) emoteBtn.addEventListener('click', toggleEmotePicker);

    return {
      handleKey,
      closeAll() { closePopup(); closeMenu(); },
      insertMention,
      toggleEmotePicker,
      isPopupOpen: isOpen,
      // Exposed so the suggestion list can be driven without a real input event.
      updateAutocomplete,
    };
  };
})(self.FCM);
