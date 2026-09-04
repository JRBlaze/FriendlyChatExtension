// Feed plumbing.
//
// Every row goes through one queue that is flushed on the next animation frame.
// Appending each message individually forces a layout per message, which is
// what makes a busy channel stutter.
(function (FCM) {
  'use strict';

  // How long the queue may sit unflushed when no animation frame arrives.
  // Short enough that a covered window still reads as live chat, long enough
  // that it never beats the frame in a window that is actually being drawn.
  const FLUSH_FALLBACK_MS = 250;

  FCM.createFeed = function (feedEl, getSettings) {
    const pending = [];
    let scheduled = false;
    let frameId = null;
    let timerId = null;
    let msgCount = 0;
    // The empty-state row, while one is on show. Held rather than looked up, so
    // the hot path never searches the feed for it.
    let placeholderEl = null;
    const seen = new Set();
    let onCount = null;
    // Told whenever the feed starts or stops following the live end, and how
    // many messages have arrived since it stopped.
    let onPinChange = null;
    // Whether the feed is following the live end.
    //
    // This is what the viewer asked for, not what a measurement says, and the
    // difference is the whole of it. The feed's content moves underneath itself
    // constantly: rows are trimmed off the top, an emote finishes loading and
    // grows the row it is in, a row that was scrolled out of view is measured
    // for real the moment it comes back. Every one of those moves the numbers
    // an "are we at the bottom?" test reads.
    //
    // Deciding it afresh from those numbers on every flush meant any one of
    // them reading wrong once stopped the feed following for good: nothing
    // scrolled again while it was behind, so the gap only ever grew, and the
    // way back was a button the viewer had to keep pressing while the chat ran
    // away from them again. Nothing but the viewer scrolling up stops it now.
    let following = true;
    // The scroll position this feed last set for itself, so its own scrolling
    // is never mistaken for the viewer's.
    let lastTop = 0;
    let missed = 0;

    function limit() {
      const s = getSettings();
      return FCM.clampNumber(s.maxMessages, FCM.MAX_MESSAGES_MIN, FCM.MAX_MESSAGES_MAX, FCM.MAX_MESSAGES_DEFAULT);
    }

    // Close enough to the end to count as being at it. Only ever asked about
    // a feed the viewer has scrolled, to know whether they have come back.
    const AT_BOTTOM_SLACK = 120;
    function atBottom() {
      // A collapsed or hidden panel gives the feed no box at all and every
      // measurement off it reads zero, which is not an answer. Whatever was
      // true when it had a box is still true now.
      if (!feedEl.clientHeight) return following;
      return feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight <= AT_BOTTOM_SLACK;
    }

    function stickToBottom() {
      feedEl.scrollTop = feedEl.scrollHeight;
      lastTop = feedEl.scrollTop;
    }

    function setFollowing(next) {
      if (next === following) return;
      following = next;
      // Coming back to the live end clears what was missed while away from it.
      if (next) missed = 0;
      if (onPinChange) onPinChange(next, missed);
    }

    function isPinned() { return following; }

    function trim() {
      let excess = feedEl.childElementCount - limit();
      while (excess > 0 && feedEl.firstElementChild) {
        feedEl.removeChild(feedEl.firstElementChild);
        excess--;
      }
    }

    /**
     * Reads one scroll, and decides nothing it does not have to.
     *
     * A feed that is following the live end and finds itself no longer at it
     * got there one of two ways, and they want opposite answers:
     *
     *   * The viewer moved away from the end. The scroll position changed, and
     *     they are reading something — hold still and offer them the way back.
     *   * The end moved away from the viewer. The scroll position did not
     *     change at all; the feed simply grew below it, because a row that had
     *     been scrolled out of view was measured for real, or an emote finished
     *     loading and grew the row it is in. On a busy channel that is a few
     *     hundred pixels at a time. Follow it down.
     *
     * Telling them apart by whether the scroll position moved is what makes
     * this safe. Measuring the distance to the end and calling anything far
     * enough "the viewer scrolled up" is what used to strand people: one growth
     * spurt read as a gesture, the feed stopped following, and it never started
     * again on its own however long they waited.
     *
     * The way back needs no gesture, because there is none to give: a viewer
     * who has scrolled back is following again once they are at the end,
     * however they got there.
     *
     * Called on every scroll of a busy chat, so it reads the layout values it
     * needs and nothing else, and reports only when the answer has changed.
     */
    function notePinState() {
      const top = feedEl.scrollTop;
      const moved = top !== lastTop;
      lastTop = top;

      if (!following) {
        if (atBottom()) setFollowing(true);
        return;
      }
      if (atBottom()) return;
      if (moved) setFollowing(false);
      else stickToBottom();
    }

    feedEl.addEventListener('scroll', notePinState, { passive: true });

    function flush() {
      scheduled = false;
      if (!pending.length) return;

      // A scroll the viewer has just made, whose event has not been delivered
      // yet, has to be seen before this decides to take them back to the end.
      notePinState();

      const cap = limit();
      // If a single burst already exceeds the cap, drop the surplus before it is
      // ever attached instead of attaching and immediately removing it.
      if (pending.length > cap) pending.splice(0, pending.length - cap);

      // Counted before the queue is emptied. Only chat rows count: a status
      // line arriving is not something the viewer scrolled up to avoid missing.
      if (!following) {
        missed += pending.filter((el) => el.classList
          && el.classList.contains('fcm-msg')).length;
      }

      const fragment = document.createDocumentFragment();
      pending.forEach((node) => fragment.appendChild(node));
      pending.length = 0;
      feedEl.appendChild(fragment);

      trim();
      if (following) {
        settleToBottom();
      } else if (onPinChange) {
        // Appending does not move the scroll position, so the feed has just
        // fallen further behind. Say so, or the count on the button stops
        // climbing while messages carry on arriving.
        onPinChange(false, missed);
      }
    }

    /**
     * Puts the feed back on the live end, and again once the browser has
     * caught up with itself.
     *
     * Scrolling to the end is only as good as the height the feed has at that
     * moment, and rows just attached are measured after this, not during it —
     * so the end is a little further down than it was when it was scrolled to.
     * A scroll of its own does not always follow (the position may not have
     * changed, only the height below it), so one more look on the next frame is
     * what keeps the newest messages on screen rather than just below the fold.
     */
    let settleFrame = null;
    function settleToBottom() {
      stickToBottom();
      if (settleFrame !== null || !window.requestAnimationFrame) return;
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = null;
        if (following && !atBottom()) stickToBottom();
      });
    }

    /**
     * Asks for the next flush.
     *
     * requestAnimationFrame is the right way to batch this — it lands the rows
     * just before the browser paints them — but it stops arriving whenever the
     * page is not being drawn: a hidden tab, and also a window that is merely
     * covered by another one, which leaves `document.hidden` false.
     *
     * Choosing between a frame and a timer up front was not enough, because the
     * page can stop being drawn *after* the frame is asked for. That frame never
     * arrives, `scheduled` stays set, and every message after it returns early
     * without asking again — the feed stops drawing for good while the message
     * count carries on climbing.
     *
     * So both are started and whichever arrives first does the work. In a window
     * that is being drawn the frame wins within ~16 ms and cancels the timer, so
     * the fallback costs nothing when it is not needed.
     */
    function schedule() {
      if (window.requestAnimationFrame) frameId = window.requestAnimationFrame(run);
      timerId = setTimeout(run, FLUSH_FALLBACK_MS);
    }

    function run() {
      if (frameId !== null && window.cancelAnimationFrame) window.cancelAnimationFrame(frameId);
      if (timerId !== null) clearTimeout(timerId);
      frameId = null;
      timerId = null;
      flush();
    }

    function queue(el) {
      // The "nothing here yet" placeholder, cleared by the first row to arrive.
      // Looked up through a held reference rather than by searching the feed:
      // the search ran on every message and had to walk the whole feed to fail,
      // so its cost grew with every row kept — several thousand nodes on a busy
      // channel, for a placeholder that has not been there since the first
      // message of the session.
      if (placeholderEl) {
        placeholderEl.remove();
        placeholderEl = null;
      }
      pending.push(el);
      // Bound the queue on the way in as well as on the way out: a busy channel
      // left in a background tab would otherwise pile up nodes between flushes.
      const cap = limit();
      if (pending.length > cap) pending.splice(0, pending.length - cap);
      if (scheduled) return;
      scheduled = true;
      schedule();
    }

    /**
     * Visits every row this feed owns, attached or not.
     *
     * A row sits in the queue for up to a frame before it is attached, and a
     * deletion, a filter change or a leave can all land inside that window.
     * Twitch in particular sends a message and the CLEARMSG that deletes it
     * down the same socket, often in the same read — so the delete would find
     * nothing, the message would flush a moment later undeleted, and the feed
     * would go on showing a message the platform had removed. Anything that
     * changes rows has to see the ones not yet on screen.
     */
    function eachRow(selector, fn) {
      pending.forEach((el) => { if (el.matches && el.matches(selector)) fn(el); });
      feedEl.querySelectorAll(selector).forEach(fn);
    }

    // Bounded so a long session cannot grow the dedupe set without limit.
    function rememberSeen(platform, messageId) {
      const key = `${platform}:${messageId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > FCM.SEEN_MESSAGE_LIMIT) {
        const drop = seen.size - FCM.SEEN_MESSAGE_LIMIT;
        const it = seen.values();
        for (let i = 0; i < drop; i++) seen.delete(it.next().value);
      }
      return true;
    }

    return {
      get count() { return msgCount; },
      // Whether the feed is showing anybody's message. Asked only when the
      // empty state is being decided, which is a status change rather than
      // anything on the message path.
      get hasMessages() { return !!feedEl.querySelector('.fcm-msg'); },
      onCount(fn) { onCount = fn; },

      // The "nothing here yet" row. The feed owns it because the feed is what
      // takes it away: the first message to arrive clears it.
      setPlaceholder(build) {
        if (placeholderEl) return;
        placeholderEl = build();
        if (placeholderEl) feedEl.appendChild(placeholderEl);
      },

      clearPlaceholder() {
        if (!placeholderEl) return;
        placeholderEl.remove();
        placeholderEl = null;
      },
      // Called with (pinned, missed) whenever the feed leaves or rejoins the
      // live end, and again as messages pile up while it is away from it.
      onPinChange(fn) { onPinChange = fn; },

      addMessage(msg, activeFilter) {
        if (msg.messageId && !rememberSeen(msg.platform, msg.messageId)) return null;
        const el = FCM.buildMessageEl(msg, activeFilter);
        queue(el);
        msgCount++;
        if (onCount) onCount(msgCount);
        return el;
      },

      addSys(text) { queue(FCM.buildSysEl(text)); },

      addEvent(platform, text, activeFilter, meta) {
        queue(FCM.buildEventEl(platform, text, activeFilter, meta));
      },

      // A row the caller built itself — one carrying buttons with handlers,
      // which innerHTML cannot carry. It goes through the same queue as
      // everything else so it lands in order and under the same cap.
      addRow(el) { if (el) queue(el); },

      // Dim every message from a user after a timeout or ban, the way the
      // platforms' own chats do, so the feed stays an accurate picture of the room.
      markUserDeleted(platform, username) {
        const lower = String(username || '').toLowerCase();
        if (!lower) return;
        eachRow(`.fcm-msg[data-platform="${platform}"]`, (el) => {
          if (el.dataset.user === lower || el.dataset.login === lower) {
            el.classList.add('fcm-deleted');
          }
        });
      },

      markMessageDeleted(platform, messageId) {
        const id = String(messageId).replace(/["\\]/g, '\\$&');
        eachRow(
          `.fcm-msg[data-platform="${platform}"][data-msg-id="${id}"]`,
          (el) => el.classList.add('fcm-deleted'),
        );
      },

      applyFilter(activeFilter) {
        eachRow('[data-platform]', (el) => {
          el.classList.toggle('fcm-hide', !activeFilter.has(el.dataset.platform));
        });
      },

      // Drops every row belonging to one platform, used when its chat is left.
      dropPlatform(platform) {
        // Including the ones still queued: flushing them after the leave would
        // put that platform's messages back into a feed that has left it.
        for (let i = pending.length - 1; i >= 0; i--) {
          const el = pending[i];
          if (el.matches && el.matches(`[data-platform="${platform}"]`)) pending.splice(i, 1);
        }
        feedEl.querySelectorAll(`[data-platform="${platform}"]`).forEach((el) => el.remove());
        // The dedupe set has to forget them too, or rejoining the channel would
        // silently discard the replayed history as "already seen".
        const prefix = `${platform}:`;
        seen.forEach((key) => { if (key.startsWith(prefix)) seen.delete(key); });
      },

      clear() {
        pending.length = 0;
        feedEl.replaceChildren();
        placeholderEl = null;
        seen.clear();
        msgCount = 0;
        missed = 0;
        following = true;
        lastTop = 0;
        if (onCount) onCount(0);
        if (onPinChange) onPinChange(true, 0);
      },

      scrollToBottom() {
        stickToBottom();
        missed = 0;
        following = true;
        if (onPinChange) onPinChange(true, 0);
      },
      isPinned,
      trim,
    };
  };
})(self.FCM);
