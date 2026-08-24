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

    document.querySelectorAll(DIALOG_SELECTOR).forEach((el) => furniture.add(el));

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
       * The balances the page is showing, and whether the site's own controls
       * are there to be driven.
       * @returns {{points: string, bits: string, canClaim: boolean, hasMenu: boolean}}
       */
      stats() {
        const c = controls();
        if (!c) return { points: '', bits: '', canClaim: false, hasMenu: false };
        return {
          points: FCM.readNativeBalance(c.pointsValue),
          bits: FCM.readNativeBalance(c.bitsValue),
          canClaim: onScreen(c.claim),
          hasMenu: onScreen(c.openBalances) || onScreen(c.cheer),
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
        try { el.click(); } catch (e) { return false; }
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
        let found = null;
        document.querySelectorAll(DIALOG_SELECTOR).forEach((el) => {
          if (found || furniture.has(el)) return;
          const r = el.getBoundingClientRect();
          if (r.width < MIN_DIALOG || r.height < MIN_DIALOG) return;
          const overX = Math.min(r.right, box.right) - Math.max(r.left, box.left);
          const overY = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
          if (overX > 40 && overY > 40) found = el;
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
