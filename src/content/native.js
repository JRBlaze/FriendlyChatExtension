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
  // Every shape the two sites give a menu.
  //
  // The roles are what a site puts on the panel when it names it at all.
  // `data-popper-placement` is Twitch's, and it is the one that matters most:
  // Twitch draws its account menu, its notifications and its chat settings as
  // a React modal whose `role="dialog"` wrapper measures 1x0, inside a fixed
  // overlay measuring 1x1, inside a body child measuring 1440x0 parked below
  // the fold — and the panel anyone can actually see is three levels under all
  // of that, carrying no role, no id and no test hook. Every test here is a
  // test of what something measures, so all three wrappers answered "nothing",
  // and the one element with a box was the one nothing was looking at.
  //
  // Popper stamps the placement onto that panel as it positions it, which
  // makes the attribute a mark on the thing actually being painted. That is
  // the same kind of hook `data-state="open"` is for Kick's Radix menus, and
  // it is why both are asked for by name rather than looked for by shape.
  const DIALOG_SELECTOR =
    '[role="dialog"],[role="menu"],[role="listbox"],.tw-balloon,[data-popper-placement]';
  // How far under a named-but-sizeless panel to look for the box it is drawing.
  // Twitch stacks three wrappers over its menus today; this leaves room for one
  // more without turning into a search of the page.
  const MENU_DESCENT = 4;
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

  // How far inside a sibling to look for the card it is drawing. Twitch stacks
  // four or five wrappers between the chat column and the card itself; nothing
  // either site draws needs more than this, and the bound is what keeps the
  // search cheap enough to run on the tick.
  const CARD_DESCENT = 5;

  /**
   * The element next to the message list that is actually drawing something,
   * starting from the sibling and descending through anything that measures
   * nothing itself.
   *
   * This is what a hype train and a pinned message on Twitch turn on. The site
   * draws its community highlight through a chain of wrappers that collapse to
   * zero height — the sibling of the message list measures 0px tall while an
   * 83px card is painted through it — so measuring the sibling and stopping
   * there found nothing, and the overlay sat straight over the card. Asking
   * what is being drawn rather than what the sibling measures is the whole
   * difference.
   *
   * The search is bounded by the box it started in. Both sites park
   * screen-reader text at coordinates like -99142, and a union of everything
   * underneath a wrapper would otherwise make one of those "the card" and push
   * the overlay off the page.
   *
   * @returns the element to measure the card from, or null for a wrapper that
   *   really is empty
   */
  function paintedCard(el, bounds, depth) {
    const r = el.getBoundingClientRect();
    // Big enough to be a card on its own: the common case, and the one that
    // must not cost a descent. This runs for every sibling on every tick.
    if (r.height >= MIN_CARD_HEIGHT && r.width >= MIN_CARD_WIDTH) return el;
    if (depth <= 0 || !el.children || !el.children.length) return null;
    for (const child of el.children) {
      const cr = child.getBoundingClientRect();
      // Drawn outside the column it lives in, so it is scaffolding rather than
      // anything a viewer can see here.
      if (cr.bottom < bounds.top - 1 || cr.top > bounds.bottom + 1) continue;
      if (cr.right < bounds.left - 1 || cr.left > bounds.right + 1) continue;
      const found = paintedCard(child, bounds, depth - 1);
      if (found) return found;
    }
    return null;
  }
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
   * The exception is a banner pinned to the top of the list, which is how both
   * sites draw a pinned message and how Twitch draws its community highlight:
   * it floats over the messages rather than pushing them down, but it is still
   * a card the overlay must not cover. See `isTopBanner` for how the two are
   * told apart.
   *
   * What each sibling contributes is resolved by `paintedCard` rather than
   * measured off the sibling itself, because on Twitch the sibling is an empty
   * wrapper and the card is several levels inside it.
   */
  function splitSiblings(list) {
    let node = list;
    for (let depth = 0; depth < 8; depth++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      const own = node.getBoundingClientRect();
      const bounds = parent.getBoundingClientRect();
      const above = [];
      const below = [];
      for (const sib of parent.children) {
        if (sib === node) continue;
        // Not the sibling, but whatever inside it is actually being drawn: on
        // Twitch the sibling is an empty wrapper and the card is five levels in.
        const card = paintedCard(sib, bounds, CARD_DESCENT);
        if (!card) continue;
        const r = card.getBoundingClientRect();
        if (r.bottom <= own.top + 2) above.push(card);
        else if (r.top >= own.bottom - 2) below.push(card);
        else if (isTopBanner(card, r, own, bounds)) above.push(card);
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
   * Four things have to hold: it hugs the top of the list, it stops short of
   * the bottom of it, it covers only a small part of the chat column, and it
   * actually has something in it.
   */
  function isTopBanner(el, r, own, bounds) {
    if (r.top > own.top + 4) return false;
    if (r.height < MIN_BANNER_HEIGHT) return false;
    // A card sits at the top of the messages; a layer covering them runs to the
    // bottom. That is the difference, and it holds whatever either is sized at.
    if (r.bottom >= own.bottom - 4) return false;
    // The share is measured against the chat column rather than the message
    // list, because the list is the thing the cards have already shrunk. Judging
    // a card against it means the more room the site takes for its own cards,
    // the less willing this was to admit there were any — which is backwards,
    // and on a short window it rejected a hype train by three pixels.
    const room = Math.max(own.height, (bounds && bounds.height) || 0);
    if (r.bottom >= own.top + room * MAX_BANNER_SHARE) return false;
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
     * What a named panel is actually drawing, when the named element itself
     * measures nothing.
     *
     * The same shape of problem as the cards above chat, and the same answer:
     * a site's wrapper collapsing to no size does not mean nothing is on
     * screen, it means the box is further in. Twitch's account menu is exactly
     * this — a `role="dialog"` measuring 1x0 with a 207x193 panel under it.
     *
     * Bounded, and it stops at the first level that has a box, so this is a
     * handful of rects on the one or two named panels a page has rather than a
     * walk of the document.
     */
    function drawnMenu(el) {
      let level = [el];
      for (let depth = 0; depth < MENU_DESCENT && level.length; depth++) {
        const sized = level.find((n) => {
          const r = n.getBoundingClientRect();
          return r.width >= MIN_DIALOG && r.height >= MIN_DIALOG;
        });
        if (sized) return sized;
        const next = [];
        // Breadth-first and capped: a menu is drawn through wrappers with one
        // child each, and anything fanning out more widely is the page itself.
        level.forEach((n) => { for (const kid of n.children) next.push(kid); });
        if (next.length > 8) return el;
        level = next;
      }
      return el;
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
      document.querySelectorAll(DIALOG_SELECTOR).forEach((el) => add(drawnMenu(el)));
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
       *
       * The horizontal edges are carried as well as the vertical ones, because
       * a panel the viewer has dragged somewhere of their own choosing has to
       * be asked whether it is over the cards at all before it moves for them.
       *
       * @returns {{elements: Element[], top: number, bottom: number,
       *   left: number, right: number, height: number}|null}
       */
      cards() {
        const list = site.messageList && site.messageList();
        if (!list) return null;
        const { above } = splitSiblings(list);
        if (!above.length) return null;
        let top = Infinity;
        let bottom = -Infinity;
        let left = Infinity;
        let right = -Infinity;
        above.forEach((el) => {
          const r = el.getBoundingClientRect();
          top = Math.min(top, r.top);
          bottom = Math.max(bottom, r.bottom);
          left = Math.min(left, r.left);
          right = Math.max(right, r.right);
        });
        if (!(bottom > top)) return null;
        return { elements: above, top, bottom, left, right, height: bottom - top };
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
          return {
            points: '', bits: '', hasPoints: false, hasBits: false,
            canClaim: false, claimNamed: false, hasMenu: false,
          };
        }
        const hasPoints = onScreen(c.pointsValue) || onScreen(c.openBalances);
        const hasBits = onScreen(c.bitsValue) || onScreen(c.cheer);
        return {
          points: FCM.readNativeBalance(c.pointsValue),
          bits: FCM.readNativeBalance(c.bitsValue),
          hasPoints,
          hasBits,
          canClaim: onScreen(c.claim),
          // Whether the site named that control or the adapter guessed at it.
          // Only a named one is pressed without being asked.
          claimNamed: onScreen(c.claim) && c.claimNamed !== false,
          hasIdentity: onScreen(c.chatIdentity),
          hasMenu: hasPoints || hasBits || onScreen(c.chatIdentity),
        };
      },

      /**
       * Clicks the site's own control, so the site's own menu opens and its own
       * redemption runs. The overlay never spends anything itself: it holds no
       * token that could, and standing between a viewer and their balance is
       * not a thing to get subtly wrong.
       *
       * @param {'points'|'bits'|'claim'|'identity'} kind
       * @returns {boolean} whether there was a control to click
       */
      activate(kind) {
        const c = controls();
        if (!c) return false;
        const el = kind === 'claim' ? c.claim
          : kind === 'identity' ? c.chatIdentity
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
       * Opens the site's own card for a viewer, by pressing their name in the
       * site's own chat.
       *
       * The card is the site's, not a copy: Twitch's carries the badges, the
       * mod tools and the gift button that only it can offer, and Kick's shows
       * when the account joined and when they followed. Neither could be
       * rebuilt here honestly — they are built from things only a logged-in
       * session can see — so the overlay asks for the real one instead.
       *
       * Fails rather than guesses. Both sites virtualise their message lists,
       * so someone who has scrolled out of the site's own chat is genuinely not
       * there to press, and pressing the wrong name would open the wrong card.
       *
       * @returns {boolean} whether there was a name to press
       */
      openUserCard(username) {
        if (!site.chatUsername) return false;
        let el = null;
        try { el = site.chatUsername(username); } catch (e) { return false; }
        if (!onScreen(el)) return false;
        // The card is anchored to where the name is, so it has to be somewhere
        // the viewer can see before it is worth opening.
        try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { /* not essential */ }
        // Pressed directly rather than climbing to a button ancestor. Twitch's
        // name is a bare span with the handler on it and its nearest ancestor
        // button is something else entirely, so climbing would open the wrong
        // thing on the one site where it matters most.
        try { press(el); } catch (e) { return false; }
        return true;
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
       * Whether something the site has drawn is sitting on top of the chat.
       *
       * This asks what is actually painted, rather than trying to recognise the
       * panel by its markup. Kick draws these in at least three shapes — a
       * centred modal with a backdrop, a panel anchored inside the chat column,
       * and a gift shop above the composer — gives none of them a name, and
       * moves them between releases. What matters is not which one it is, only
       * whether the chat is covered.
       *
       * Only meaningful while the panel is already standing aside. Its own host
       * would otherwise be the thing on top at every one of these points.
       */
      coveringChat() {
        const messages = site.messageList && site.messageList();
        if (!messages || !document.elementFromPoint) return false;
        const r = messages.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) return false;
        // Off-centre on purpose: both sites float a jump-to-bottom pill down
        // the middle, and it is not a menu.
        const xs = [r.left + r.width * 0.25, r.left + r.width * 0.75];
        const ys = [r.top + r.height * 0.45, r.top + r.height * 0.7];
        for (const x of xs) {
          for (const y of ys) {
            const el = document.elementFromPoint(x, y);
            if (!el) continue;
            // The messages themselves, or something they sit inside: the chat
            // is what is on top here, so nothing is covering it.
            if (messages.contains(el) || el.contains(messages)) continue;
            return true;
          }
        }
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
