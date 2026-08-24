// The parts of the host site's own chat that the overlay sits on top of: the
// cards Twitch and Kick draw above the message list — hype trains, polls,
// predictions, pinned messages, leaderboards — and the balance controls they
// draw below it, where bits, Kicks and channel points live.
//
// None of them are reimplemented here, and that is deliberate. A hype train, a
// poll and a prediction each carry live state, their own animations and their
// own redemption rules, and a copy would be wrong within a release. So the
// overlay gets out of their way instead: it measures the card the site is
// already drawing and shrinks so the real one shows through, reads the balances
// straight out of the page, and hands a click to the site's own button so the
// site's own menu opens and the site's own redemption runs.
(function (FCM) {
  'use strict';

  // Below this a sibling is a spacer or a rounding artefact, not a card.
  const MIN_CARD_HEIGHT = 6;
  const MIN_CARD_WIDTH = 40;
  // A banner drawn over the messages has to clear a higher bar than one in
  // flow: Kick keeps an empty slot up there permanently, and its padding alone
  // measures a few pixels.
  const MIN_BANNER_HEIGHT = 20;
  // How much of the message list a banner may cover before it stops being a
  // banner. Both sites park full-height layers over their messages — Twitch's
  // viewer card, the jump-to-bottom pill's container — and those are not cards.
  const MAX_BANNER_SHARE = 0.5;
  // A popup smaller than this is a tooltip, and hiding the whole overlay for a
  // tooltip would be worse than letting the tooltip be covered.
  const MIN_DIALOG = 80;
  const DIALOG_SELECTOR = '[role="dialog"],[role="menu"],[role="listbox"],.tw-balloon';
  // A menu nobody has closed in this long is almost certainly not a menu.
  // Whatever it is, it stops being a reason to keep the overlay invisible.
  const PEEK_MAX_MS = 2 * 60 * 1000;
  // Menus are portalled to the end of <body> by both sites, so a positioned
  // child of the body is a candidate even when it carries no role at all.
  const PORTAL_POSITIONS = ['fixed', 'absolute'];
  // Kick builds its menus with Radix, which writes the open state onto the
  // element itself. It is the most precise signal either site gives, and it
  // finds a panel wherever it is drawn rather than only at the end of <body>.
  const OPEN_STATE_SELECTOR = '[data-state="open"]';

  /**
   * Splits the message list's own siblings into what sits above it and what
   * sits below it.
   *
   * Class names are no use for this. Both sites now hash every wrapper around
   * their highlight stack, so there is nothing left to match on — but position
   * is stable, and the message list is the one element on either site that has
   * kept a name. So the search starts there and climbs until it reaches the
   * level where the site places its cards and its composer as siblings, which
   * is the first level where anything sits wholly above or wholly below.
   *
   * Most things overlapping the list are skipped rather than counted. Both
   * sites park absolutely-positioned layers over the messages — viewer cards,
   * the jump-to-bottom pill — and those are not cards to make room for.
   *
   * The exception is a banner pinned to the top of the list, which is how Kick
   * draws a pinned message: it floats over the messages rather than pushing
   * them down, but it is still a card the overlay must not cover. See
   * `isTopBanner` for how the two are told apart.
   */
  function splitSiblings(list) {
    let node = list;
    for (let depth = 0; depth < 8; depth++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      const own = node.getBoundingClientRect();
      const above = [];
      const below = [];
      for (const sib of parent.children) {
        if (sib === node) continue;
        const r = sib.getBoundingClientRect();
        if (r.height < MIN_CARD_HEIGHT || r.width < MIN_CARD_WIDTH) continue;
        if (r.bottom <= own.top + 2) above.push(sib);
        else if (r.top >= own.bottom - 2) below.push(sib);
        else if (isTopBanner(sib, r, own)) above.push(sib);
      }
      if (above.length || below.length) return { above, below };
      node = parent;
    }
    return { above: [], below: [] };
  }

  // Whether an element painting something has anything in it worth showing.
  // Kick keeps its banner slot in the page permanently and empty, where its own
  // padding still measures; requiring content is what keeps that from being
  // mistaken for a card and costing a strip of feed for nothing.
  function hasContent(el) {
    if ((el.textContent || '').trim()) return true;
    return !!el.querySelector('img,svg,video,canvas');
  }

  /**
   * Whether an element overlapping the message list is a card drawn over the
   * top of it rather than a layer covering it.
   *
   * Three things have to hold: it hugs the top of the list, it covers only a
   * small part of it, and it actually has something in it.
   */
  function isTopBanner(el, r, own) {
    if (r.top > own.top + 4) return false;
    if (r.height < MIN_BANNER_HEIGHT) return false;
    if (r.bottom >= own.top + own.height * MAX_BANNER_SHARE) return false;
    return hasContent(el);
  }

  FCM.splitChatSiblings = splitSiblings;

  // Twitch abbreviates a large balance ("12.4K"), so this is deliberately loose:
  // it asks "does this read as a number", it does not parse one.
  const BALANCE_RE = /^\d[\d.,]*\s*[KMB]?$/i;

  // Whether a piece of text is a balance and nothing else. Kick labels almost
  // nothing in its chat footer, so this is what lets a control there be
  // recognised by what it displays rather than by a name it does not carry.
  FCM.looksLikeBalance = function (text) {
    return BALANCE_RE.test(String(text || '').replace(/\s+/g, ' ').trim());
  };

  FCM.readNativeBalance = function (el) {
    if (!el) return '';
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (BALANCE_RE.test(text)) return text.replace(/\s+/g, '');
    // Kick puts the number inside a button with other content around it, and
    // both sites spell the balance out in the accessible name.
    const label = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
    const found = /(\d[\d.,]*\s*[KMB]?)/i.exec(`${text} ${label}`);
    return found ? found[1].replace(/\s+/g, '') : '';
  };

  /**
   * Presses a control the way a mouse does.
   *
   * `el.click()` alone is not enough. It raises a click and nothing else, and
   * plenty of menu triggers — Radix's among them, which is what Kick builds
   * with — open on pointerdown rather than on click. Kick's Kicks button did
   * nothing at all for exactly that reason. The full sequence is harmless to a
   * control that only listens for the click at the end of it.
   */
  function press(el) {
    // The sequence is best-effort: the click at the end is the part that must
    // happen, so nothing above it is allowed to prevent it.
    try {
      const opts = { bubbles: true, cancelable: true, composed: true, button: 0 };
      const Pointer = window.PointerEvent || window.MouseEvent;
      if (el.dispatchEvent && window.MouseEvent) {
        el.dispatchEvent(new Pointer('pointerdown', { ...opts, buttons: 1, pointerId: 1, isPrimary: true }));
        el.dispatchEvent(new window.MouseEvent('mousedown', { ...opts, buttons: 1 }));
        el.dispatchEvent(new Pointer('pointerup', { ...opts, buttons: 0, pointerId: 1, isPrimary: true }));
        el.dispatchEvent(new window.MouseEvent('mouseup', { ...opts, buttons: 0 }));
      }
    } catch (e) { /* no pointer events here; the click below still stands */ }
    el.click();
  }

  function onScreen(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function boxOf(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }

  // Everything about one element that could be used to find it again.
  function describe(el) {
    if (!el) return null;
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : null,
      id: el.id || null,
      testid: el.getAttribute ? el.getAttribute('data-testid') : null,
      testSelector: el.getAttribute ? el.getAttribute('data-test-selector') : null,
      aTarget: el.getAttribute ? el.getAttribute('data-a-target') : null,
      aria: el.getAttribute ? el.getAttribute('aria-label') : null,
      title: el.getAttribute ? el.getAttribute('title') : null,
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      icons: el.querySelectorAll
        ? Array.from(el.querySelectorAll('[data-ds-icon]'))
          .map((i) => i.getAttribute('data-ds-icon')).slice(0, 4)
        : [],
      box: boxOf(el),
    };
  }

  /**
   * A snapshot of what the adapters can and cannot find on this page.
   *
   * Both sites move their markup, and when they do the useful question is
   * always the same: what is actually in the chat's footer, and what did the
   * selectors make of it. Answering that from a bug report is the difference
   * between fixing it and guessing at it.
   *
   * It reads only the chat's own controls. That does include whatever those
   * controls display, which is why the button that copies it says so.
   */
  FCM.nativeDiagnostics = function (site, bridge) {
    const controls = (() => {
      try { return (site.nativeControls && site.nativeControls()) || {}; } catch (e) { return {}; }
    })();
    const footer = site.nativeFooter && site.nativeFooter();
    const cards = bridge && bridge.cards ? bridge.cards() : null;

    return {
      site: site.id,
      url: location.href,
      viewport: [window.innerWidth, window.innerHeight],
      chatColumn: boxOf(site.chatContainer && site.chatContainer()),
      messageList: boxOf(site.messageList && site.messageList()),
      nativeChatBody: boxOf(site.nativeChatBody && site.nativeChatBody()),
      composer: describe(site.composer && site.composer()),
      sendButton: describe(site.sendButton && site.sendButton()),
      cards: cards ? { count: cards.elements.length, top: Math.round(cards.top), bottom: Math.round(cards.bottom) } : null,
      resolved: {
        pointsValue: describe(controls.pointsValue),
        bitsValue: describe(controls.bitsValue),
        openBalances: describe(controls.openBalances),
        cheer: describe(controls.cheer),
        claim: describe(controls.claim),
      },
      stats: bridge && bridge.stats ? bridge.stats() : null,
      // The part that matters most when a control cannot be found: everything
      // the footer actually contains.
      footerFound: !!footer,
      // Anything carrying a name comes first. An open emote picker puts dozens
      // of unlabelled buttons in this list, and they were pushing the ones
      // worth reading off the end of it.
      footerControls: footer
        ? (() => {
          const all = Array.from(footer.querySelectorAll('button,[data-testid],[role="button"]'))
            .map(describe);
          const named = all.filter((d) => d.testid || d.testSelector || d.aTarget
            || d.aria || d.title || d.text || d.icons.length);
          const rest = all.filter((d) => named.indexOf(d) === -1);
          return named.concat(rest).slice(0, 60);
        })()
        : [],
    };
  };

  /**
   * @param {object} site one of FCM.SITES
   * @returns the bridge the overlay uses to see and drive the page's own chat
   */
  FCM.createNativeBridge = function (site) {
    // Elements forced back into view while the site's own chat is hidden.
    // Neither site sets visibility inline, so clearing the property is enough
    // to put one back the way it was found.
    const forced = new Set();
    // A popup already on screen when the overlay mounted is the page's own
    // furniture, not a menu the user just opened. Without this, one mismatched
    // element would leave the panel permanently invisible with no way back.
    const furniture = new WeakSet();
    let peekStarted = 0;
    let peekTarget = null;
    // Which menu-like elements were on screen the last time this looked.
    //
    // "Has it just opened" is the question, and it has to be asked that way
    // rather than as "has it just been added". Kick's menus are Radix dialogs:
    // closing one leaves it mounted and opening it again reuses the same
    // element, so nothing is added the second time and every time after.
    const wasOpen = new WeakSet();

    /**
     * Whether an element is genuinely on screen right now.
     *
     * A rectangle is not enough on its own. Kick leaves its menus mounted when
     * they are closed, and a closed one still measures — the page has several
     * body children sized 300x150 and 1280x1 that are `visibility: hidden`.
     * Counting those as open made them furniture on the first look, so the menu
     * that mattered could never be seen opening later.
     *
     * Where the site says so outright, that is believed over the geometry.
     */
    function isOpen(el) {
      const state = el.getAttribute && el.getAttribute('data-state');
      if (state === 'closed') return false;
      // Geometry first: it is several times cheaper than a computed style, and
      // most of what gets here measures nothing at all.
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    }

    /**
     * Everything that could be one of the site's menus.
     *
     * Twitch names its rewards panel `role="dialog"` and draws it inside the
     * chat column. Kick names nothing and portals to the end of `<body>`, as a
     * full-screen backdrop plus a panel that is centred on the window and so
     * never overlaps the chat column at all — the backdrop is the part that
     * covers the overlay, and the part worth standing aside for.
     */
    function menuCandidates() {
      const list = [];
      const add = (el) => { if (list.indexOf(el) === -1) list.push(el); };
      document.querySelectorAll(DIALOG_SELECTOR).forEach(add);
      // Anything that has said it is open, wherever it happens to be drawn.
      // Kick's rewards panel is anchored to its own button rather than
      // portalled, so looking only at the end of <body> never found it.
      document.querySelectorAll(OPEN_STATE_SELECTOR).forEach(add);
      if (document.body) {
        for (const el of document.body.children) {
          if (list.indexOf(el) !== -1) continue;
          // Anything last seen open stays a candidate whatever it measures now,
          // or closing it would never be noticed — and an element that is never
          // noticed closing can never be seen opening a second time.
          if (wasOpen.has(el)) { add(el); continue; }
          // Otherwise geometry first, style second. Kick leaves around 190
          // children on <body>, nearly all of them spent Radix portals
          // measuring nothing, and asking each one for its computed style cost
          // more than every other part of this put together.
          const r = el.getBoundingClientRect();
          if (r.width < MIN_DIALOG || r.height < MIN_DIALOG) continue;
          if (PORTAL_POSITIONS.indexOf(getComputedStyle(el).position) !== -1) add(el);
        }
      }
      return list;
    }

    // Everything already open is the page's own furniture until it closes and
    // opens again, which is what stops the overlay hiding for something that
    // was on screen before it ever mounted.
    function snapshot() {
      menuCandidates().forEach((el) => {
        if (isOpen(el)) wasOpen.add(el);
        else wasOpen.delete(el);
      });
    }

    snapshot();

    // Whether an element is big enough, and overlapping enough, to be the menu.
    function coversBox(r, box) {
      if (r.width < MIN_DIALOG || r.height < MIN_DIALOG) return false;
      const overX = Math.min(r.right, box.right) - Math.max(r.left, box.left);
      const overY = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
      return overX > 40 && overY > 40;
    }

    function controls() {
      if (!site.nativeControls) return null;
      try { return site.nativeControls(); } catch (e) { return null; }
    }

    const bridge = {
      /**
       * The block of the site's own cards above the message list, as one box.
       * @returns {{elements: Element[], top: number, bottom: number, height: number}|null}
       */
      cards() {
        const list = site.messageList && site.messageList();
        if (!list) return null;
        const { above } = splitSiblings(list);
        if (!above.length) return null;
        let top = Infinity;
        let bottom = -Infinity;
        above.forEach((el) => {
          const r = el.getBoundingClientRect();
          top = Math.min(top, r.top);
          bottom = Math.max(bottom, r.bottom);
        });
        if (!(bottom > top)) return null;
        return { elements: above, top, bottom, height: bottom - top };
      },

      /**
       * The balances the page is showing, and which of the site's own controls
       * are there to be driven.
       *
       * Whether a control *exists* is reported separately from whatever it
       * displays, because the two do not always go together. Kick's Kicks
       * button reads "Get KICKs" and carries no number at all — it is still a
       * way in, and hiding it because there was nothing to count was why it
       * never appeared.
       */
      stats() {
        const c = controls();
        if (!c) {
          return { points: '', bits: '', hasPoints: false, hasBits: false, canClaim: false, hasMenu: false };
        }
        const hasPoints = onScreen(c.pointsValue) || onScreen(c.openBalances);
        const hasBits = onScreen(c.bitsValue) || onScreen(c.cheer);
        return {
          points: FCM.readNativeBalance(c.pointsValue),
          bits: FCM.readNativeBalance(c.bitsValue),
          hasPoints,
          hasBits,
          canClaim: onScreen(c.claim),
          hasMenu: hasPoints || hasBits,
        };
      },

      /**
       * Clicks the site's own control, so the site's own menu opens and its own
       * redemption runs. The overlay never spends anything itself: it holds no
       * token that could, and standing between a viewer and their balance is
       * not a thing to get subtly wrong.
       *
       * @param {'points'|'bits'|'claim'} kind
       * @returns {boolean} whether there was a control to click
       */
      activate(kind) {
        const c = controls();
        if (!c) return false;
        const el = kind === 'claim' ? c.claim
          : kind === 'bits' ? (c.cheer || c.openBalances)
            : (c.openBalances || c.cheer);
        if (!onScreen(el)) return false;
        try { press(el); } catch (e) { return false; }
        return true;
      },

      /**
       * Takes a fresh note of what is already open, immediately before one of
       * the site's own controls is clicked. Whatever opens next is then the
       * thing that just opened, however the site chooses to draw it.
       */
      expectMenu() {
        snapshot();
      },

      /**
       * The site's own menu currently covering the given box, if there is one.
       * Twitch draws its rewards panel at z-index 2000 inside the chat column,
       * which the overlay would otherwise paint straight over.
       */
      dialogOver(box) {
        if (!box) { peekTarget = null; return null; }
        if (peekTarget && peekStarted && Date.now() - peekStarted > PEEK_MAX_MS) {
          furniture.add(peekTarget);
          peekTarget = null;
        }
        // Nothing inside the message list is ever a menu. Both sites add rows
        // there constantly, and a tall one arriving would otherwise read as
        // something that had just opened over the panel.
        const messages = site.messageList && site.messageList();

        let found = null;
        menuCandidates().forEach((el) => {
          const open = isOpen(el);
          // Open now and not last time: this is the one that just opened.
          if (open && !found && !wasOpen.has(el) && !furniture.has(el)
            && !(messages && messages.contains(el))
            && coversBox(el.getBoundingClientRect(), box)) {
            found = el;
          }
          if (open) wasOpen.add(el);
          else wasOpen.delete(el);
        });

        if (found !== peekTarget) {
          peekTarget = found;
          peekStarted = found ? Date.now() : 0;
        }
        return found;
      },

      /**
       * Whether the menu that is currently being stood aside for is still up.
       *
       * This is the check that runs while peeking, so it deliberately costs one
       * `isConnected` test and one rect rather than the document-wide scan
       * `dialogOver` does — the answer while a menu is open only concerns the
       * element already found.
       */
      dialogStillOpen() {
        if (!peekTarget) return false;
        const gone = !peekTarget.isConnected
          || (peekStarted && Date.now() - peekStarted > PEEK_MAX_MS);
        if (!gone) {
          const r = peekTarget.getBoundingClientRect();
          if (r.width >= MIN_DIALOG && r.height >= MIN_DIALOG) return true;
        }
        // A menu nobody closed inside the cap is written off as furniture, so
        // it cannot keep the panel invisible a second time either.
        if (peekStarted && Date.now() - peekStarted > PEEK_MAX_MS) furniture.add(peekTarget);
        peekTarget = null;
        peekStarted = 0;
        return false;
      },

      /**
       * Hides or shows the site's own chat.
       *
       * The cards are exempt while they are being revealed: `visibility` is
       * inherited, so setting it back to `visible` on a card inside a hidden
       * subtree shows that card and nothing else around it.
       *
       * The caller passes the cards rather than this looking them up, because
       * the caller already has them: finding them is the expensive part and it
       * is done once per tick, not once per visibility change.
       *
       * @param {boolean} hidden
       * @param {Element[]} cards the cards to keep visible, empty for none
       */
      setNativeHidden(hidden, cards) {
        const keep = hidden && Array.isArray(cards) ? cards : [];

        forced.forEach((el) => {
          if (keep.indexOf(el) !== -1) return;
          el.style.visibility = '';
          forced.delete(el);
        });
        keep.forEach((el) => {
          if (forced.has(el)) return;
          el.style.visibility = 'visible';
          forced.add(el);
        });

        const body = site.nativeChatBody && site.nativeChatBody();
        if (!body) return;
        body.style.visibility = hidden ? 'hidden' : '';
      },

      // Puts every element this bridge touched back the way it was found.
      release() {
        forced.forEach((el) => { el.style.visibility = ''; });
        forced.clear();
        const body = site.nativeChatBody && site.nativeChatBody();
        if (body) body.style.visibility = '';
      },
    };

    return bridge;
  };
})(self.FCM);
