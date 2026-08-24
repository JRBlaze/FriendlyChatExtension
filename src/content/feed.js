// Feed plumbing.
//
// Every row goes through one queue that is flushed on the next animation frame.
// Appending each message individually forces a layout per message, which is
// what makes a busy channel stutter.
(function (FCM) {
  'use strict';

  FCM.createFeed = function (feedEl, getSettings) {
    const pending = [];
    let scheduled = false;
    let msgCount = 0;
    const seen = new Set();
    let onCount = null;

    function limit() {
      const s = getSettings();
      return FCM.clampNumber(s.maxMessages, FCM.MAX_MESSAGES_MIN, FCM.MAX_MESSAGES_MAX, FCM.MAX_MESSAGES_DEFAULT);
    }

    function isPinned() {
      return feedEl.scrollHeight - feedEl.scrollTop < feedEl.clientHeight + 120;
    }

    function trim() {
      let excess = feedEl.childElementCount - limit();
      while (excess > 0 && feedEl.firstElementChild) {
        feedEl.removeChild(feedEl.firstElementChild);
        excess--;
      }
    }

    function flush() {
      scheduled = false;
      if (!pending.length) return;

      const pinned = isPinned();
      const cap = limit();
      // If a single burst already exceeds the cap, drop the surplus before it is
      // ever attached instead of attaching and immediately removing it.
      if (pending.length > cap) pending.splice(0, pending.length - cap);

      const fragment = document.createDocumentFragment();
      pending.forEach((node) => fragment.appendChild(node));
      pending.length = 0;
      feedEl.appendChild(fragment);

      trim();
      if (pinned) feedEl.scrollTop = feedEl.scrollHeight;
    }

    // requestAnimationFrame is suspended while the tab is hidden, so a
    // background tab has to fall back to a timer or the queue never drains.
    function schedule(fn) {
      if (document.hidden || !window.requestAnimationFrame) {
        setTimeout(fn, 250);
        return;
      }
      window.requestAnimationFrame(fn);
    }

    function queue(el) {
      const placeholder = feedEl.querySelector('.fcm-empty');
      if (placeholder) placeholder.remove();
      pending.push(el);
      // Bound the queue on the way in as well as on the way out: a busy channel
      // left in a background tab would otherwise pile up nodes between flushes.
      const cap = limit();
      if (pending.length > cap) pending.splice(0, pending.length - cap);
      if (scheduled) return;
      scheduled = true;
      schedule(flush);
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
      onCount(fn) { onCount = fn; },

      addMessage(msg, activeFilter) {
        if (msg.messageId && !rememberSeen(msg.platform, msg.messageId)) return null;
        const el = FCM.buildMessageEl(msg, activeFilter);
        queue(el);
        msgCount++;
        if (onCount) onCount(msgCount);
        return el;
      },

      addSys(text) { queue(FCM.buildSysEl(text)); },

      addEvent(platform, text, activeFilter) {
        queue(FCM.buildEventEl(platform, text, activeFilter));
      },

      // Dim every message from a user after a timeout or ban, the way the
      // platforms' own chats do, so the feed stays an accurate picture of the room.
      markUserDeleted(platform, username) {
        const lower = String(username || '').toLowerCase();
        if (!lower) return;
        feedEl.querySelectorAll(`.fcm-msg[data-platform="${platform}"]`).forEach((el) => {
          if (el.dataset.user === lower) el.classList.add('fcm-deleted');
        });
      },

      markMessageDeleted(platform, messageId) {
        const id = String(messageId).replace(/["\\]/g, '\\$&');
        const el = feedEl.querySelector(`.fcm-msg[data-platform="${platform}"][data-msg-id="${id}"]`);
        if (el) el.classList.add('fcm-deleted');
      },

      applyFilter(activeFilter) {
        feedEl.querySelectorAll('[data-platform]').forEach((el) => {
          el.classList.toggle('fcm-hide', !activeFilter.has(el.dataset.platform));
        });
      },

      // Drops every row belonging to one platform, used when its chat is left.
      dropPlatform(platform) {
        feedEl.querySelectorAll(`[data-platform="${platform}"]`).forEach((el) => el.remove());
        // The dedupe set has to forget them too, or rejoining the channel would
        // silently discard the replayed history as "already seen".
        const prefix = `${platform}:`;
        seen.forEach((key) => { if (key.startsWith(prefix)) seen.delete(key); });
      },

      clear() {
        pending.length = 0;
        feedEl.replaceChildren();
        seen.clear();
        msgCount = 0;
        if (onCount) onCount(0);
      },

      scrollToBottom() { feedEl.scrollTop = feedEl.scrollHeight; },
      isPinned,
      trim,
    };
  };
})(self.FCM);
