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

  /**
   * Watches the site's own chat for the events it draws but never sends.
   *
   * @param {object} site      the site adapter for this page
   * @param {function} onEvent called with the summary of each redemption
   * @returns {{start: function, stop: function}} start() is safe to call
   *   repeatedly — it re-attaches if the site replaced its message list, which
   *   both sites do on a channel change.
   */
  FCM.createNativeEventWatcher = function (site, onEvent) {
    // Kick sends its redemptions down the same socket as everything else, so
    // there is nothing here for it to do and no observer to pay for.
    const supported = site && site.id === 'twitch';
    let observer = null;
    let watched = null;
    // Summary -> when it was last reported. The site redraws rows as the list
    // is scrolled and virtualised, and a redraw is not a second redemption.
    const reported = new Map();

    function alreadySaid(text) {
      const now = Date.now();
      // Swept on the way past rather than on a timer: this runs only when a
      // notice appears, which is rare enough that the map stays small.
      reported.forEach((at, key) => { if (now - at > REPEAT_WINDOW_MS) reported.delete(key); });
      if (reported.has(text)) return true;
      reported.set(text, now);
      return false;
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
    }

    return {
      start() {
        if (!supported) return;
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
        watched = null;
        reported.clear();
      },
    };
  };

  // Exposed for the tests, which drive it with the markup the site actually
  // produces rather than with a live page.
  FCM.readNativeRedemption = readRedemption;
})(self.FCM);
