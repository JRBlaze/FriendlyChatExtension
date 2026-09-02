// The events the site draws in its own chat that never reach a chat socket.
//
// Channel point redemptions are the whole reason this exists. A reward that
// asks for a message arrives over IRC as an ordinary PRIVMSG carrying a
// `custom-reward-id` tag, and the overlay has always shown those. A reward that
// asks for nothing — the great majority of them — is not sent over IRC at all:
// Twitch's own page draws that line from a private live-update channel, so the
// only place it exists in this tab is the DOM the site has already painted.
//
// So this reads it back off the page, and does nothing else. It is deliberately
// the narrowest possible scrape:
//
//   * Twitch only, and only while the overlay is showing the same channel the
//     page is. Reading one channel's page into another channel's feed would be
//     worse than the missing row.
//   * Only lines the site marks as a notice, and only those carrying no chat
//     message of their own — a reward with a message is already in the feed
//     from IRC, and showing it twice is not an improvement.
//   * Only lines that say a redemption happened. Everything else the site draws
//     as a notice — subs, resubs, raids, watch streaks — arrives over IRC as a
//     USERNOTICE and is already handled properly there, with the platform's own
//     structured fields rather than by reading words off a screen.
//
// The last of those is why nothing here tries to be clever about wording: if
// the site is not in English, or Twitch rewrites the line, this finds nothing
// and the feed is exactly as complete as it was before. It can go quiet; it
// cannot start inventing rows.
//
// The second thing read here is the prompts Twitch draws for this viewer and
// nobody else: "share your watch streak", "share your resub". Those are not
// events — nothing has happened yet — they are the site asking the person at
// the keyboard to press a button, and the panel is sitting on top of that
// button. What is read off them is the text and the button itself, so the
// overlay can say what is being asked and hand the press to Twitch's own
// control. The same rules apply: Twitch only, the same channel only, and a
// line only counts when it actually carries a Share button.
(function (FCM) {
  'use strict';

  // "someone redeemed Feed your hedgehog". The name is the first word, and
  // everything after the verb is what they redeemed.
  const REDEEMED_RE = /^(\S+)\s+redeemed\s+(.+)$/i;

  // A redemption line ends with the reward's cost in its own element, which
  // innerText leaves as a trailing line of digits.
  const COST_RE = /^[\d,]+$/;

  // Nothing on either site draws a notice this long. A cap keeps a page that
  // has changed shape from turning some unrelated block of text into an event.
  const MAX_NOTICE_CHARS = 300;

  // Long enough that a line redrawn during a scroll is not reported twice,
  // short enough that the same reward redeemed again later still is.
  const REPEAT_WINDOW_MS = 20 * 1000;

  const NOTICE_SELECTOR = '[data-test-selector="user-notice-line"]';
  // How the site marks a line that is somebody's actual message. A notice
  // wrapping one of these came from IRC and is already in the feed.
  const MESSAGE_SELECTOR = '[data-a-target="chat-line-message"],[data-a-target="chat-message-text"]';

  /**
   * The redemption one of the site's notice lines describes, or null.
   *
   * @returns {{text: string}|null} the summary to show, already in the feed's
   *   own words rather than the site's
   */
  function readRedemption(el) {
    if (!el || el.querySelector(MESSAGE_SELECTOR)) return null;
    const raw = String(el.innerText || '');
    if (!raw || raw.length > MAX_NOTICE_CHARS) return null;

    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return null;

    // The cost sits on its own once the line is broken up, and is worth
    // keeping: "redeemed Feed your hedgehog" and "for 50 points" are different
    // amounts of information about the same thing.
    let cost = '';
    if (lines.length > 1 && COST_RE.test(lines[lines.length - 1])) {
      cost = lines.pop();
    }

    const said = lines.join(' ');
    const match = REDEEMED_RE.exec(said);
    if (!match) return null;
    const who = match[1];
    // The reward's own name can end in the cost when the site draws the two
    // with nothing between them.
    const reward = match[2].replace(/\s+$/, '');
    if (!reward) return null;

    return { text: `${who} redeemed ${reward}${cost ? ` (${cost} points)` : ''}.` };
  }

  // ── Prompts for this viewer ─────────────────────────────────────────────────

  // Nothing Twitch asks a viewer to share runs to a paragraph.
  const MAX_PROMPT_CHARS = 400;
  // A prompt is drawn once and stays until it is answered. The site redraws it
  // as the list scrolls, and each redraw is the same prompt; a new one of the
  // same wording inside this window is not something that happens.
  const PROMPT_REPEAT_MS = 10 * 60 * 1000;
  // How often the chat column is looked over for a prompt drawn somewhere other
  // than the message list, which is where the resub one has been seen to sit.
  const PROMPT_POLL_MS = 2000;
  // The button that answers the prompt, by what it says. Bounded: a control
  // says what it does in a word or two, and a longer label is a sentence that
  // happens to contain the word.
  const SHARE_RE = /\bshare\b/i;
  const MAX_BUTTON_LABEL = 60;
  // How far up from a Share button to look for the words that go with it, on
  // the pages where the prompt is not a row in the list.
  const PROMPT_CLIMB = 6;

  function buttonLabel(btn) {
    const aria = (btn.getAttribute && btn.getAttribute('aria-label')) || '';
    return `${btn.textContent || ''} ${aria}`.replace(/\s+/g, ' ').trim();
  }

  function shareButtonIn(el) {
    if (!el || !el.querySelectorAll) return null;
    for (const btn of el.querySelectorAll('button')) {
      const label = buttonLabel(btn);
      if (!label || label.length > MAX_BUTTON_LABEL) continue;
      if (SHARE_RE.test(label)) return btn;
    }
    return null;
  }

  /**
   * What kind of prompt this is, from its words. Only used to label the row;
   * the words themselves are what the viewer reads.
   */
  function promptKind(text) {
    if (/watch\s*streak|streams?\s+in\s+a\s+row|consecutive/i.test(text)) return 'streak';
    if (/resub|anniversar|month|subscri/i.test(text)) return 'resub';
    return 'share';
  }

  /**
   * The words in an element that are not on one of its buttons.
   *
   * Walked rather than read off innerText, because the buttons sit inline
   * with the words on the site's own row: innerText ran "Share" and "Not now"
   * straight on from the sentence with nothing between them, and no amount of
   * matching labels against lines could take them back out. Each element's
   * text is set apart by a space, so a heading and the sentence under it do
   * not run together either.
   *
   * Falls back to innerText, minus any line that is exactly a button's
   * label, where there is no tree to walk.
   */
  function wordsOutsideButtons(el) {
    if (el.childNodes) {
      const parts = [];
      const walk = (node) => {
        if (node.nodeType === 3) { parts.push(node.nodeValue || ''); return; }
        if (node.nodeType !== 1 || node.tagName === 'BUTTON') return;
        node.childNodes.forEach(walk);
        parts.push(' ');
      };
      walk(el);
      return parts.join('').replace(/\s+/g, ' ').trim();
    }
    const labels = new Set();
    el.querySelectorAll('button').forEach((btn) => {
      const label = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (label) labels.add(label);
    });
    return String(el.innerText || el.textContent || '').split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line && !labels.has(line))
      .join(' ');
  }

  /**
   * The prompt one of the site's elements is drawing for this viewer, or null.
   *
   * A prompt is a block of text with a Share button in it. The button is the
   * whole test: a chat line has none, a notice about somebody else's streak
   * has none, and nothing that is not asking the viewer to do something has
   * one either.
   *
   * @returns {{kind: string, text: string, share: Element}|null}
   */
  function readPrompt(el) {
    if (!el || el.nodeType !== 1) return null;
    const raw = String(el.innerText || el.textContent || '');
    if (!raw || raw.length > MAX_PROMPT_CHARS) return null;
    const share = shareButtonIn(el);
    if (!share) return null;

    // The buttons' own labels are not part of what is being asked.
    const text = wordsOutsideButtons(el);
    if (!text) return null;
    return { kind: promptKind(text), text, share };
  }

  /**
   * The smallest block around a Share button that reads as a prompt, for a
   * button drawn outside the message list.
   */
  function promptAround(btn, stopAt) {
    let el = btn;
    for (let depth = 0; depth < PROMPT_CLIMB; depth++) {
      el = el.parentElement;
      if (!el || el === stopAt || el === document.body) return null;
      const found = readPrompt(el);
      if (found && found.text.length >= 12) return { ...found, el };
    }
    return null;
  }

  /**
   * Watches the site's own chat for the events it draws but never sends.
   *
   * @param {object} site      the site adapter for this page
   * @param {function} onEvent called with the summary of each redemption
   * @param {function} [onPrompt] called with {kind, text, share, el} for each
   *   prompt the site draws for this viewer. `share` is the site's own button,
   *   to be pressed by the caller; `el` is the prompt itself.
   * @returns {{start: function, stop: function}} start() is safe to call
   *   repeatedly — it re-attaches if the site replaced its message list, which
   *   both sites do on a channel change.
   */
  FCM.createNativeEventWatcher = function (site, onEvent, onPrompt) {
    // Kick sends its redemptions down the same socket as everything else, so
    // there is nothing here for it to do and no observer to pay for.
    const supported = site && site.id === 'twitch';
    let observer = null;
    let watched = null;
    let pollTimer = null;
    // Summary -> when it was last reported. The site redraws rows as the list
    // is scrolled and virtualised, and a redraw is not a second redemption.
    const reported = new Map();
    const prompted = new Map();

    function alreadySaid(text) {
      const now = Date.now();
      // Swept on the way past rather than on a timer: this runs only when a
      // notice appears, which is rare enough that the map stays small.
      reported.forEach((at, key) => { if (now - at > REPEAT_WINDOW_MS) reported.delete(key); });
      if (reported.has(text)) return true;
      reported.set(text, now);
      return false;
    }

    function alreadyPrompted(text) {
      const now = Date.now();
      prompted.forEach((at, key) => { if (now - at > PROMPT_REPEAT_MS) prompted.delete(key); });
      if (prompted.has(text)) return true;
      prompted.set(text, now);
      return false;
    }

    function offerPrompt(found, el) {
      if (!onPrompt || !found || alreadyPrompted(found.text)) return;
      onPrompt({ ...found, el });
    }

    function consider(node) {
      if (!node || node.nodeType !== 1) return;
      const notices = node.matches && node.matches(NOTICE_SELECTOR)
        ? [node]
        : (node.querySelectorAll ? node.querySelectorAll(NOTICE_SELECTOR) : []);
      notices.forEach((notice) => {
        const found = readRedemption(notice);
        if (!found || alreadySaid(found.text)) return;
        onEvent(found.text);
      });
      // A row added to the list that is asking this viewer to share something.
      // Read off the row itself: the prompt is the row, not a notice inside it.
      if (onPrompt) offerPrompt(readPrompt(node), node);
    }

    /**
     * Looks for a prompt the site drew somewhere in the chat column other than
     * the message list — above the composer, say — where no observer is
     * watching. Cheap: one query for buttons over the column, and a climb from
     * any that say Share.
     */
    function pollPrompts() {
      if (!onPrompt) return;
      let column = null;
      try { column = site.chatContainer && site.chatContainer(); } catch (e) { column = null; }
      if (!column || !column.querySelectorAll) return;
      const list = watched;
      for (const btn of column.querySelectorAll('button')) {
        if (list && list.contains && list.contains(btn)) continue;
        const label = buttonLabel(btn);
        if (!label || label.length > MAX_BUTTON_LABEL || !SHARE_RE.test(label)) continue;
        if (btn.getBoundingClientRect && !btn.getBoundingClientRect().height) continue;
        const found = promptAround(btn, column);
        if (found) offerPrompt(found, found.el);
      }
    }

    return {
      start() {
        if (!supported) return;
        if (onPrompt && !pollTimer) pollTimer = setInterval(pollPrompts, PROMPT_POLL_MS);
        const list = site.messageList && site.messageList();
        // Same list as last time: the observer already attached to it is still
        // the right one, and re-observing would report every line twice.
        if (!list || list === watched) return;
        if (observer) observer.disconnect();
        watched = list;
        observer = new MutationObserver((records) => {
          records.forEach((record) => record.addedNodes.forEach(consider));
        });
        // childList only. The site appends whole rows to this list, and each
        // added node is searched for a notice on the way past — watching the
        // subtree as well would fire for every attribute and text change
        // inside a chat that is already the busiest thing on the page.
        observer.observe(list, { childList: true });
      },

      stop() {
        if (observer) { observer.disconnect(); observer = null; }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        watched = null;
        reported.clear();
        prompted.clear();
      },
    };
  };

  // Exposed for the tests, which drive it with the markup the site actually
  // produces rather than with a live page.
  FCM.readNativeRedemption = readRedemption;
  FCM.readNativePrompt = readPrompt;
})(self.FCM);
