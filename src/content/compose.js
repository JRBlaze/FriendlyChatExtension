// Composer helpers, ported from Friendly Chat: the emote picker, `:emote` and
// `@name` autocomplete with Tab completion, and the click-a-username menu.
(function (FCM) {
  'use strict';

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

    const seen = new Map();
    const items = [];
    FCM.PLATFORMS.forEach((platform) => {
      const sets = FCM.view.emotes[platform];
      if (!sets) return;
      [sets.native, sets.thirdparty].forEach((store) => {
        Object.keys(store || {}).forEach((name) => {
          const emote = store[name];
          if (!emote || !emote.url) return;
          const already = seen.get(name);
          if (already) {
            // The same name in both stores is one emote listed once, and the
            // first store to have it decides how it looks. Whose it is, though,
            // is only ever learnt: the platform's own list and a provider's list
            // do not both know, so whichever does gets to say.
            if (emote.channel) already.channel = true;
            if (emote.owner && !already.owner) already.owner = emote.owner;
            return;
          }
          const entry = {
            type: 'emote',
            name,
            // Folded once here rather than on every keystroke of every search.
            lower: name.toLowerCase(),
            url: emote.url,
            source: emote.source || platform,
            // Whether it belongs to the channel being watched rather than to a
            // provider's global set. What the picker puts at the top.
            channel: !!emote.channel,
            // Which channel it came from, when one owns it. The picker groups
            // by this, so a subscriber sees their channels by name instead of
            // one undifferentiated pile of "Twitch Sub".
            owner: emote.owner || '',
          };
          seen.set(name, entry);
          items.push(entry);
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
    // Opens the site's own card for a viewer. Returns false when their name is
    // not in the site's own chat to press — both sites virtualise, so someone
    // who scrolled away is genuinely not there.
    const onUserCard = ctx.onUserCard || function () { return false; };
    const onProfile = ctx.onProfile || function () { return Promise.resolve(null); };
    // Which site the panel is sitting on. The site's own card only exists for
    // the chat that page is actually showing.
    const hostPlatform = ctx.hostPlatform || '';

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
      // A fill still in flight would otherwise write sections into a popup that
      // has been emptied and closed.
      cancelPickerFill();
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
      // No `title` here either: the panel's own preview covers a cell in the
      // picker the same way it covers an emote in a message.
      return `<div class="fcm-emote-cell" data-index="${index}">`
        + `<img src="${esc(item.url)}" alt="${esc(item.name)}" loading="lazy">`
        + `<button class="fcm-emote-fav${fav ? ' fcm-emote-fav-on' : ''}"`
        + ` data-fav="${esc(item.name)}" tabindex="-1"`
        + ` title="${fav ? 'Remove from favourites' : 'Add to favourites'}"`
        + ` aria-label="${fav ? 'Remove' : 'Add'} ${esc(item.name)} ${fav ? 'from' : 'to'} favourites"`
        + '>★</button></div>';
    }

    // How many cells go in before the browser is allowed to paint. Enough to
    // fill the picker several times over, so what anyone actually looks at is
    // there on the first frame and the rest arrives while they are looking at
    // it. Ten thousand emotes in one write cost 300ms of frozen page.
    const PICKER_FIRST_CHUNK = 600;
    const PICKER_CHUNK = 900;
    // How long to wait for a frame that may never come. A window that is merely
    // covered by another one stops being painted while `document.hidden` stays
    // false, and then no animation frame ever arrives — the same trap the feed
    // works around, and the reason a picker built on frames alone stopped
    // halfway through and stayed there.
    const PICKER_FILL_FALLBACK_MS = 120;
    let pickerFrameId = null;
    let pickerTimerId = null;

    function cancelPickerFill() {
      if (pickerFrameId !== null && window.cancelAnimationFrame) {
        window.cancelAnimationFrame(pickerFrameId);
      }
      if (pickerTimerId !== null) clearTimeout(pickerTimerId);
      pickerFrameId = null;
      pickerTimerId = null;
    }

    /**
     * Writes the sections into the picker a few hundred cells at a time.
     *
     * Every emote still ends up in the list; this only decides how much of it
     * lands before the browser is allowed to paint. The images are lazy, so the
     * ones below the fold cost nothing until they are scrolled to — it is
     * building the elements that takes the time, and ten thousand of them in
     * one write froze the page for a third of a second.
     *
     * A long section is split across batches rather than going in whole, because
     * one account's subscription emotes are a single section of several
     * thousand and letting it through intact defeats the whole arrangement.
     */
    function fillSections(body, sections) {
      let si = 0;      // which section
      let ci = 0;      // how far into that section's entries
      let grid = null; // the grid being filled, held across batches

      const step = (budget) => {
        cancelPickerFill();
        let spent = 0;
        while (si < sections.length && spent < budget) {
          const section = sections[si];
          if (ci === 0) {
            body.insertAdjacentHTML('beforeend',
              `<div class="fcm-ac-header">${section.title} (${section.entries.length})</div>`
              + '<div class="fcm-emote-grid"></div>');
            grid = body.lastElementChild;
          }
          const take = Math.min(section.entries.length - ci, budget - spent);
          grid.insertAdjacentHTML('beforeend', section.entries
            .slice(ci, ci + take)
            .map(({ item, index }) => cellHtml(item, index))
            .join(''));
          ci += take;
          spent += take;
          if (ci >= section.entries.length) { si++; ci = 0; grid = null; }
        }
        if (si >= sections.length) return;
        // Both, and whichever arrives first does the work — a frame when the
        // page is being drawn, the timer when it is not.
        const next = () => step(PICKER_CHUNK);
        if (window.requestAnimationFrame) pickerFrameId = window.requestAnimationFrame(next);
        pickerTimerId = setTimeout(next, PICKER_FILL_FALLBACK_MS);
      };

      step(PICKER_FIRST_CHUNK);
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
      // A fill still in flight holds this same element, and would go on writing
      // its remaining sections in underneath whatever replaces them — so
      // typing a query that matches nothing showed "No emotes match" with a
      // wall of emotes below it, none of which could be clicked, because the
      // list they were drawn from had already been replaced.
      cancelPickerFill();

      if (!matches.length) {
        body.innerHTML = `<div class="fcm-ac-more">No emotes match "${esc(query)}"</div>`;
        return;
      }

      // Grouped by the channel an emote belongs to, and by what kind of emote
      // it is when no channel owns it. A subscriber to thirty channels had all
      // of it under one "Twitch Sub" heading, which is a list of every emote
      // they have rather than an answer to "what can I send here".
      const groups = new Map();   // lowercased key -> { title, entries }
      const favs = [];
      const order = favourites();

      const groupFor = (item) => {
        const owner = item.owner || '';
        const title = owner || item.source || 'Emotes';
        // Keyed case-insensitively: the same channel arrives as a login from
        // the third-party providers and as a display name from Twitch, and
        // "jynxzi" and "Jynxzi" are not two channels.
        const key = title.toLowerCase();
        let group = groups.get(key);
        if (!group) {
          group = { title, owner: !!owner, channel: false, entries: [] };
          groups.set(key, group);
        }
        // Prefer the spelling that carries capitals, which is the one the
        // platform shows people.
        if (owner && title !== title.toLowerCase() && group.title === group.title.toLowerCase()) {
          group.title = title;
        }
        if (item.channel) group.channel = true;
        return group;
      };

      matches.forEach((item, index) => {
        const entry = { item, index };
        // A favourite is listed once, at the top, rather than again under its
        // channel — the same emote twice in one list is a worse answer than
        // either placement on its own.
        if (isFavourite(item.name)) { favs.push(entry); return; }
        groupFor(item).entries.push(entry);
      });
      // In the order they were starred, not the order the providers list them.
      favs.sort((a, b) => order.indexOf(a.item.name) - order.indexOf(b.item.name));

      // The channel being watched first, then the other channels by name, then
      // everything that belongs to nobody — globals, Prime, hype train.
      const ordered = [...groups.values()].sort((a, b) => {
        if (a.channel !== b.channel) return a.channel ? -1 : 1;
        if (a.owner !== b.owner) return a.owner ? -1 : 1;
        return a.title.localeCompare(b.title);
      });

      // No cap. Every emote loaded is drawn, because "+340 more — type to
      // search" asked people to remember a name in order to find a picture,
      // which is what a picker is for in the first place.
      const sections = [];
      if (favs.length) sections.push({ title: '★ Favourites', entries: favs });
      ordered.forEach((group) => sections.push({
        // The channel being watched is worth saying so, because it is the one
        // set everyone in the room can see you use.
        title: esc(group.title) + (group.channel ? ' <em>· this channel</em>' : ''),
        entries: group.entries,
      }));

      body.innerHTML = '';
      fillSections(body, sections);
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

      // Debounced, because each keystroke rebuilds the list and a one-letter
      // query can match thousands. Typing "a" used to cost 200ms a character,
      // which reads as a stuck keyboard.
      const search = popup.querySelector('.fcm-ac-input');
      let searchTimer = null;
      search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => renderPickerBody(search.value), 110);
      });
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
        // A name is only an emote when something separates it from the word in
        // front of it. Picking Kappa after typing "gg" produced "ggKappa",
        // which is not an emote and is not what anyone meant — it went out as
        // that literal text.
        const sep = !before || /\s$/.test(before) ? '' : ' ';
        const insert = `${sep}${item.name} `;
        inputEl.value = before + insert + after;
        const next = (before + insert).length;
        inputEl.setSelectionRange(next, next);
      } else {
        // Typed: replace the trigger and the query with the chosen item.
        //
        // Both ends are measured from the trigger, never from the live caret.
        // The caret can have moved since the list opened — one press of the
        // left arrow, or Home — and a `before` and an `after` that no longer
        // meet duplicate whatever lies between them: "hey :Pog" completed after
        // Home gave "hey PogU hey :Pog".
        const val = inputEl.value;
        if (val[AC.triggerPos] !== AC.trigger) { closePopup(); return; }
        let end = AC.triggerPos + 1;
        while (end < val.length && !/\s/.test(val[end])) end++;
        const before = val.slice(0, AC.triggerPos);
        const after = val.slice(end);
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
      // Moving the caret without editing leaves the list describing a query the
      // caret is no longer in, so it goes away. The key itself is not consumed:
      // the caret still has to move.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'
        || e.key === 'Home' || e.key === 'End') { closePopup(); return false; }
      return false;
    }

    // ── User menu ─────────────────────────────────────────────────────────────

    function closeMenu() { menu.classList.add('fcm-hidden'); menu.innerHTML = ''; }

    /**
     * @param {string} [messageId] the message being answered, when the reply
     *   was started from a row rather than from the autocomplete. It is what
     *   lets the platform thread the reply onto the original instead of
     *   posting a message that merely names somebody.
     */
    function insertMention(name, platform, messageId) {
      const prefix = `@${name} `;
      const current = inputEl.value;
      // Replying to a second person should add to the message, not replace it.
      inputEl.value = current.trim() ? `${current.replace(/\s*$/, ' ')}${prefix}` : prefix;
      inputEl.focus();
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      if (platform) onReplyTo(platform, name, messageId);
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

    // Why the follow date is missing. Worth saying rather than leaving the line
    // out, because "no date" and "not allowed to see the date" are different
    // facts and only one of them means the person does not follow.
    const FOLLOW_REASONS = {
      'not-following': 'not following',
      'not-a-moderator': 'only shown to mods',
      'not-connected': 'connect an account',
      refused: 'unavailable',
      'no-channel': 'chat not connected',
    };

    // Why a lookup came back with nothing, in words that say what to do about
    // it rather than naming the failure.
    const PROFILE_REASONS = {
      'not-connected': 'Connect an account in settings to see profile details',
      'not-found': 'No account found by that name',
      // Nobody answered, which is not the same as nobody being there.
      refused: 'Could not reach the platform — try again in a moment',
      timeout: 'Could not reach the platform',
      failed: 'Could not load their profile',
      closed: '',
      'bad-request': '',
    };

    /**
     * Fills in the profile line once the worker answers.
     *
     * Rebuilt against the name it was asked about, because a menu opened for
     * someone else in the meantime must not be handed this answer — clicking
     * quickly through a busy chat does exactly that.
     */
    /**
     * Slides the menu back up when it is hanging off the bottom of the panel.
     *
     * Called after it is placed and again whenever something lands in it late,
     * because the menu's height is not settled when it opens: the profile is
     * fetched and fills in a moment later, and a menu that fitted when it was
     * positioned did not once three more lines arrived in it. What was hanging
     * past the bottom was the moderation controls, over the composer.
     */
    function keepMenuInPanel() {
      if (menu.classList.contains('fcm-hidden')) return;
      const panelRect = panel.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const spill = menuRect.bottom - (panelRect.bottom - 4);
      if (spill <= 0) return;
      const top = parseFloat(menu.style.top) || 0;
      menu.style.top = `${Math.round(Math.max(4, top - spill))}px`;
    }

    async function fillProfile(platform, name) {
      await renderProfile(platform, name);
      keepMenuInPanel();
    }

    async function renderProfile(platform, name) {
      const profile = await onProfile(platform, name);
      const row = menu.querySelector('.fcm-um-profile');
      if (!row || menu.classList.contains('fcm-hidden')) return;
      const head = menu.querySelector('.fcm-um-head b');
      if (!head || head.textContent !== name) return;

      const facts = [];
      const created = FCM.shortDate(profile && profile.createdAt);
      if (created) facts.push({ key: 'Account created', value: created });

      const followed = FCM.shortDate(profile && profile.followedAt);
      if (followed) {
        facts.push({ key: 'Following since', value: followed });
      } else if (profile && FOLLOW_REASONS[profile.followedReason]) {
        facts.push({ key: 'Following since', value: FOLLOW_REASONS[profile.followedReason], quiet: true });
      }

      if (profile && profile.subscribedMonths) {
        const m = profile.subscribedMonths;
        facts.push({ key: 'Subscribed', value: `${m} month${m === 1 ? '' : 's'}` });
      }
      if (profile && profile.accountType) {
        facts.push({ key: 'Account', value: String(profile.accountType) });
      }

      if (!facts.length) {
        const why = profile && PROFILE_REASONS[profile.reason];
        row.dataset.state = 'empty';
        // An empty row with nothing to say is worse than no row at all.
        if (!why) { row.remove(); return; }
        row.textContent = why;
        return;
      }

      row.dataset.state = 'ready';
      row.textContent = '';
      facts.forEach((fact) => {
        const line = document.createElement('div');
        // A reason rather than a value is set apart, so a glance down the column
        // does not read "Following since unavailable" as a date.
        line.className = `fcm-um-fact${fact.quiet ? ' fcm-um-fact-quiet' : ''}`;
        if (fact.title) line.title = fact.title;
        const k = document.createElement('span');
        k.className = 'fcm-um-fact-key';
        k.textContent = fact.key;
        const v = document.createElement('span');
        v.className = 'fcm-um-fact-val';
        // Set as text: every one of these came off a platform response.
        v.textContent = fact.value;
        line.appendChild(k);
        line.appendChild(v);
        row.appendChild(line);
      });
    }

    // Enough to see the shape of what somebody has been doing without the
    // menu becoming a second chat window.
    const HISTORY_LIMIT = 6;

    /**
     * The rows this feed still holds from one person, oldest first.
     *
     * Read out of the feed rather than fetched: no platform offers a
     * "what has this user said here" endpoint to an ordinary moderator, and
     * what is on screen is exactly what the decision is being made about.
     * A message the platform has already removed is kept and marked, because
     * "this was deleted" is part of the picture.
     */
    function recentMessagesFrom(platform, name) {
      const lower = String(name).toLowerCase();
      const rows = [];
      // The platform is one of a fixed pair, so it needs no escaping; the name
      // is compared as a value rather than written into the selector.
      feedEl.querySelectorAll(`.fcm-msg[data-platform="${platform}"]`).forEach((row) => {
        if (row.dataset.user === lower) rows.push(row);
      });
      return rows.slice(-HISTORY_LIMIT);
    }

    /**
     * Adds their recent messages to the menu.
     *
     * The bodies are cloned from rows already in the feed rather than rebuilt
     * from text, so emotes stay emotes and nothing is re-parsed as markup on
     * the way — the escaping that made those rows safe is not repeated and so
     * cannot be got wrong a second time.
     */
    function addHistory(platform, name) {
      const heading = document.createElement('div');
      heading.className = 'fcm-um-section';
      heading.textContent = 'Recent messages';
      menu.appendChild(heading);

      const rows = recentMessagesFrom(platform, name);
      const box = document.createElement('div');
      box.className = 'fcm-um-history';
      if (!rows.length) {
        box.dataset.state = 'empty';
        box.textContent = 'Nothing from them in this feed yet';
        menu.appendChild(box);
        return;
      }

      rows.forEach((row) => {
        const line = document.createElement('div');
        line.className = 'fcm-um-hline';
        if (row.classList.contains('fcm-deleted')) line.classList.add('fcm-um-hline-deleted');

        const stamp = row.querySelector('.fcm-time');
        const when = document.createElement('span');
        when.className = 'fcm-um-htime';
        when.textContent = stamp ? stamp.textContent : '';

        // The whole body element is cloned rather than its children moved:
        // childNodes is live, so appending them one at a time elsewhere
        // renumbers the list underneath the walk and drops every other node.
        const body = row.querySelector('.fcm-body');
        const said = body ? body.cloneNode(true) : document.createElement('span');
        said.classList.add('fcm-um-htext');

        line.appendChild(when);
        line.appendChild(said);
        box.appendChild(line);
      });
      menu.appendChild(box);
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
        + `<b>${esc(name)}</b><span>${esc(meta.name)}</span></div>`
        + '<div class="fcm-um-profile" data-state="loading">Looking them up…</div>';
      fillProfile(platform, name);

      addAction(`Reply on ${meta.name}`, {
        hint: `@${name}`,
        run: () => { insertMention(name, platform, target.messageId); closeMenu(); },
      });
      // The site's own card, which carries what only a logged-in session can
      // see — badges, when they followed, the gift button on Twitch, the join
      // date and level on Kick. Offered only for the chat this page is showing,
      // because that is the only one with a card to open.
      if (platform === hostPlatform) {
        addAction(`Open ${meta.name}'s user card`, {
          hint: 'profile, badges, follow date',
          run: () => {
            const opened = onUserCard(platform, name);
            closeMenu();
            if (!opened) {
              toast(`${meta.name} has not drawn ${name}'s name where it can be opened `
                + '— scroll their chat to a message from them');
            }
          },
        });
      }
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

        // What they have been saying comes before the buttons that act on
        // it: a timeout is a judgement about the messages, and scrolling the
        // feed back for them with the menu already open is not possible.
        addHistory(platform, name);

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
      keepMenuInPanel();
    }

    // ── The strip on a message, for moderators ────────────────────────────────
    //
    // The menu holds everything, and everything is three clicks away: the
    // name, then a section, then the button. A moderator dealing with a busy
    // chat wants the ordinary actions on the message itself, the way the
    // sites' own chats draw them — so a strip of delete, timeout and ban
    // appears on whichever row the pointer is over, for the chats this viewer
    // actually moderates.
    //
    // Built when a row is first hovered rather than when it is rendered. The
    // feed holds hundreds of rows and most are never pointed at, and whether
    // this viewer moderates can change after a row was drawn — the strip has
    // to answer for the moment it is looked at, not the moment the message
    // arrived.

    // Whether the strip is wanted at all. Read each time, because it is a
    // setting and settings change under an open panel.
    const modTools = ctx.modHoverTools || (() => FCM.view.settings.modHoverTools !== false);
    // How long the ban button stays armed after its first press. A permanent
    // ban from a strip that appears under a moving pointer should take two
    // deliberate presses, but not a dialog.
    const BAN_ARM_MS = 3000;

    function targetOf(row) {
      const author = row.querySelector('.fcm-author');
      return {
        username: (author && author.dataset.name) || row.dataset.user || '',
        userId: row.dataset.userId || '',
        messageId: row.dataset.msgId || '',
      };
    }

    function stripButton(label, title, run, extraClass) {
      const btn = document.createElement('button');
      btn.className = `fcm-modbar-btn${extraClass ? ` ${extraClass}` : ''}`;
      btn.type = 'button';
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        run(btn);
      });
      return btn;
    }

    /**
     * The strip for one row, or null when there is nothing to offer on it.
     *
     * @param {Element} row a `.fcm-msg` in the feed
     */
    function modBarFor(row) {
      const platform = row.dataset.platform;
      if (!FCM.PLATFORM_META[platform] || !canModerate(platform)) return null;
      const target = targetOf(row);
      if (!target.username) return null;
      const meta = FCM.PLATFORM_META[platform];
      const seconds = FCM.QUICK_TIMEOUT_SECONDS;
      const pretty = seconds >= 3600 ? `${Math.round(seconds / 3600)}h`
        : seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${seconds}s`;

      const bar = document.createElement('span');
      bar.className = 'fcm-modbar';
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', `Moderate ${target.username} on ${meta.name}`);

      if (target.messageId) {
        bar.appendChild(stripButton('\u2715', `Delete this message (${meta.name})`, () => {
          onModerate(platform, 'delete', Object.assign({}, target));
        }, 'fcm-modbar-delete'));
      }
      bar.appendChild(stripButton(pretty, `Time ${target.username} out for ${pretty} (${meta.name})`, () => {
        onModerate(platform, 'timeout', Object.assign({ seconds }, target));
      }, 'fcm-modbar-timeout'));

      // Two presses: the first arms it and says so, the second bans. A wrong
      // first press costs nothing and expires on its own.
      let armTimer = null;
      bar.appendChild(stripButton('Ban', `Ban ${target.username} from ${meta.name} chat`, (btn) => {
        if (btn.dataset.armed === '1') {
          clearTimeout(armTimer);
          btn.dataset.armed = '';
          btn.textContent = 'Ban';
          onModerate(platform, 'ban', Object.assign({}, target));
          return;
        }
        btn.dataset.armed = '1';
        btn.textContent = 'Ban?';
        btn.title = `Press again to ban ${target.username}`;
        clearTimeout(armTimer);
        armTimer = setTimeout(() => {
          btn.dataset.armed = '';
          btn.textContent = 'Ban';
          btn.title = `Ban ${target.username} from ${meta.name} chat`;
        }, BAN_ARM_MS);
      }, 'fcm-modbar-ban'));

      return bar;
    }

    function ensureModBar(row) {
      if (!row || row.querySelector('.fcm-modbar')) return;
      if (!modTools()) return;
      const bar = modBarFor(row);
      if (bar) row.appendChild(bar);
    }

    // mouseover rather than mouseenter, because only the former bubbles — one
    // listener on the feed, not one per row.
    feedEl.addEventListener('mouseover', (e) => {
      const row = e.target.closest ? e.target.closest('.fcm-msg') : null;
      if (row) ensureModBar(row);
    });

    // One delegated listener for every username in the feed, rather than a
    // handler on each of the hundreds of rendered rows.
    feedEl.addEventListener('click', (e) => {
      // The strip's own buttons handle themselves and stop the event; this is
      // for a click landing on the strip's padding.
      if (e.target.closest && e.target.closest('.fcm-modbar')) return;
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
      // The moderation strip for a row, for the tests and for anything that
      // wants one without waiting for a pointer.
      modBarFor,
    };
  };
})(self.FCM);
