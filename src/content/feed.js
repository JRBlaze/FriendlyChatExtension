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
    // away from them again. Only the viewer stops it now.
    let following = true;
    // The scroll position this feed last looked at, so a move can be told from
    // a stay, and which way it went.
    let lastTop = 0;
    let missed = 0;
    // When the viewer last touched the feed with their hands. Nothing else can
    // stop it following, which is what the rest of this file is about.
    let gestureAt = 0;

    function limit() {
      const s = getSettings();
      return FCM.clampNumber(s.maxMessages, FCM.MAX_MESSAGES_MIN, FCM.MAX_MESSAGES_MAX, FCM.MAX_MESSAGES_DEFAULT);
    }

    // How far below the last visible line the newest message is. Zero means the
    // live end is on screen, which is the only thing this file is trying to be
    // true.
    //
    // Two pixels of slack, because a scroller sitting exactly on its end does
    // not reliably say zero: scrollTop is fractional while the two heights it
    // is subtracted from are whole numbers, and on a display at 125% or 150%
    // every layout value underneath them is fractional too. Without the slack
    // a feed already on the end can read a pixel short of it and spend every
    // frame writing a scroll position it is already at. Two pixels is below
    // anything a person can see; the message is on screen either way.
    const AT_END_EPSILON = 2;
    function distanceFromEnd() {
      return feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight;
    }

    // Close enough to the end to count as having come back to it. Only ever
    // asked about a feed the viewer has scrolled away from, so it can be
    // generous: landing within a few rows of the newest message is a viewer
    // who has finished reading back, and making them find the last pixel to be
    // let go again would be a worse answer than starting to follow one row
    // early. It is never used to decide the feed is close enough to *stay*
    // where it is — while following, the end is the end.
    const AT_BOTTOM_SLACK = 160;
    function atBottom() {
      // A collapsed or hidden panel gives the feed no box at all and every
      // measurement off it reads zero, which is not an answer. Whatever was
      // true when it had a box is still true now.
      if (!feedEl.clientHeight) return following;
      return distanceFromEnd() <= AT_BOTTOM_SLACK;
    }

    function stickToBottom() {
      feedEl.scrollTop = feedEl.scrollHeight;
      lastTop = feedEl.scrollTop;
    }

    // A scroll that follows one of these within living memory is the viewer's.
    // A scroll that follows none of them is the browser's, however far it went.
    const GESTURE_MS = 700;
    function viewerDriving() { return Date.now() - gestureAt < GESTURE_MS; }

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
     *   * The viewer moved away from the end. They are reading something —
     *     hold still and offer them the way back.
     *   * The end moved away from the viewer. The feed grew below them, because
     *     a row that had been scrolled out of view was measured for real, or an
     *     emote finished loading and grew the row it is in, or the panel was
     *     resized around them. Follow it down.
     *
     * What tells them apart is whether the viewer's hands were on it. A scroll
     * position changing does not: the browser moves it by itself constantly and
     * has every right to. Scroll anchoring shifts it to hold the visible line
     * still whenever rows are trimmed off the top, and it is *supposed* to —
     * that is what keeps somebody reading back from being jerked around. The
     * scroller re-clamps it whenever the panel is resized or a strip appears
     * above the feed. Rows that have never been drawn are guesses until they
     * are measured, and the correction lands after the scroll that was aimed at
     * the old number.
     *
     * Reading any of those as "the viewer scrolled up" is what stranded people:
     * one of them landing while the feed happened to be a few hundred pixels
     * short stopped it following, and it never started again on its own however
     * long they waited. So the question asked here is not "did the position
     * change" but "did the viewer change it" — a wheel, a drag, a finger, a
     * key, within the last breath — and upwards, since scrolling *towards* the
     * live end is nobody's way of leaving it. Distance is not the test either:
     * the distance to the end grows whenever the feed grows, which is exactly
     * the thing that must not read as somebody reading back.
     *
     * Anything else that finds the feed short of the end goes after it, because
     * nothing else can have meant to be short of the end.
     *
     * The way back needs no gesture, because there is none to give: a viewer
     * who has scrolled back is following again once they are near the end,
     * however they got there.
     *
     * Called on every scroll of a busy chat, so it reads the layout values it
     * needs and nothing else, and reports only when the answer has changed.
     */
    function notePinState() {
      const top = feedEl.scrollTop;
      // Up: the only direction anybody leaves the live end in.
      const wentUp = top < lastTop;
      lastTop = top;

      if (!following) {
        if (atBottom()) setFollowing(true);
        return;
      }
      // No box, no answer: a collapsed or hidden panel measures zero for
      // everything, and being told the feed is at the end of nothing is not
      // worth acting on either way.
      if (!feedEl.clientHeight) return;
      const away = distanceFromEnd();
      if (away <= AT_END_EPSILON) return;
      if (viewerDriving()) {
        // Their hand is on it. The feed does not move itself under a hand, so
        // whatever they are doing it stays where they put it — which also means
        // a scroll of theirs cannot be undone before it has been read.
        //
        // Whether that is somebody reading back is a different question, and a
        // nudge of the wheel is not: they can still see the newest line, and
        // answering that with a button offering to take them to it would be
        // silly. Past a few rows they mean it, and the way back is worth
        // offering. Short of that the feed simply holds, and picks the live end
        // up again by itself once their hand comes off it.
        if (wentUp && away > AT_BOTTOM_SLACK) setFollowing(false);
        return;
      }
      stickToBottom();
    }

    feedEl.addEventListener('scroll', notePinState, { passive: true });

    // Every way a viewer has of moving a scroller: the wheel, a finger dragged
    // across it, the scrollbar or the middle button under the pointer, and the
    // keys when something inside the feed has focus. Listened for on the way
    // down so a row's own handlers cannot swallow them, and only to note the
    // time — what they did to the scroll position is read from the scroll event
    // that follows, like any other.
    //
    // `touchmove` rather than `touchstart`, and `pointerdown` rather than both
    // it and `mousedown`: a tap or a click that scrolls nothing still opens the
    // window, and the fewer of those the better. `pointerdown` has to stay,
    // because dragging the scrollbar or middle-clicking to autoscroll is a
    // press followed by scrolling and nothing else.
    function noteGesture() { gestureAt = Date.now(); }
    ['wheel', 'touchmove', 'pointerdown', 'keydown'].forEach((type) => {
      feedEl.addEventListener(type, noteGesture, { passive: true, capture: true });
    });

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
     * Puts the feed back on the live end, and keeps checking that it is still
     * there while the page settles around it.
     *
     * Scrolling to the end is only ever as good as the height the feed has at
     * that instant, and that height is a guess for any row the browser has not
     * drawn yet: rows out of view carry an assumed height until they are
     * measured for real. A batch of history replayed on join is sixty rows per
     * platform that have never been drawn, so the scroll that lands on the end
     * is aimed at a number that is about to change.
     *
     * The corrections do not all arrive at once, and none of them arrives
     * during this call:
     *
     *   * The browser decides which rows are worth drawing as part of the frame
     *     *after* they are attached, so the real heights land a frame or two
     *     late, and the end drops a few hundred pixels below where it was.
     *   * Emotes, badges and thumbnails are images with no size until they have
     *     been fetched, and they grow the row they are in whenever they land —
     *     a quarter of a second later, or a second, and later still for the
     *     lazy ones scrolled out of view.
     *
     * One extra look on the next frame caught none of that. It measured the
     * feed before the browser had drawn the rows it was measuring, found it
     * within the slack, and left the newest four rows below the fold — where
     * they stayed, because on a channel between messages nothing came along to
     * look again. So this keeps looking, every frame, for as long as any of
     * that can still be arriving, and it is looking for the end rather than for
     * something close enough to it.
     *
     * The cost of looking is a layout read on a layout that is almost always
     * already clean, and on a channel busy enough for that to be untrue the
     * feed is appending rows on the same frames anyway.
     */
    const SETTLE_MS = 700;
    let settleFrame = null;
    let settleUntil = 0;
    function keepSettling(ms) {
      settleUntil = Math.max(settleUntil, Date.now() + ms);
      if (settleFrame !== null || !window.requestAnimationFrame) return;
      // Through the same reading every scroll gets, rather than by scrolling on
      // its own account. The difference matters: a viewer can put their hand on
      // the wheel between two frames, and a feed that spent this frame moving
      // itself to the end would be taking that back before it had even been
      // told about it. Asking the question instead means a hand on the feed is
      // noticed here as readily as it is in a scroll event — and everything
      // else still ends up on the live end, which is the point of looking.
      const step = () => {
        settleFrame = null;
        if (!following) return;
        notePinState();
        if (following && Date.now() < settleUntil) {
          settleFrame = window.requestAnimationFrame(step);
        }
      };
      settleFrame = window.requestAnimationFrame(step);
    }

    function settleToBottom() {
      // Not under a hand: a flush landing mid-gesture would take back a scroll
      // the viewer has only just made. The looking that follows picks the end
      // up the moment their hand comes off.
      if (!viewerDriving()) stickToBottom();
      keepSettling(SETTLE_MS);
    }

    /**
     * The two things that move the live end without touching the feed's rows,
     * and so without a flush to notice.
     *
     * An image finishing its fetch grows the row it is in, long after the flush
     * that brought that row. `load` does not bubble, so it is caught on the way
     * down; there is no work in it beyond asking for the looking to carry on a
     * little longer.
     *
     * And the feed's own box changes size without any scroll event at all: the
     * panel is collapsed and expanded, popped out into a window of its own and
     * brought home, dragged to a new size, fitted to the site's chat column
     * once the placement code finds it — and the stylesheet that makes the feed
     * a scroller in the first place is fetched, so for the first frames of a
     * page there is no scroller here at all and nothing to scroll to the end
     * of. Every one of those moves where the end is.
     */
    feedEl.addEventListener('load', () => {
      if (following) keepSettling(SETTLE_MS);
    }, true);

    if (typeof window.ResizeObserver === 'function') {
      new window.ResizeObserver(() => {
        if (following) keepSettling(SETTLE_MS);
      }).observe(feedEl);
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

      // The way back, and also what expanding, showing or popping the panel
      // means. It settles rather than simply scrolling: the rows it is landing
      // on may not have been drawn since they arrived, so the end it can see
      // from here is a guess until the browser has caught up. Being asked to go
      // to the live end and stopping four rows short of it is the whole of the
      // complaint this exists to answer.
      scrollToBottom() {
        missed = 0;
        following = true;
        // Asked for outright, so it goes, whatever the viewer's hands have been
        // doing a moment ago: pressing the button is itself the gesture, and
        // what it asks for is the end. Forgetting the last one is what stops
        // the hold that keeps the feed still under a hand from arguing with it.
        gestureAt = 0;
        stickToBottom();
        keepSettling(SETTLE_MS);
        if (onPinChange) onPinChange(true, 0);
      },
      isPinned,
      trim,
    };
  };
})(self.FCM);
