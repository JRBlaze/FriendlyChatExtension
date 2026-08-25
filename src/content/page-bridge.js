// The isolated world's side of the conversation with `main-world.js`.
//
// Everything that comes back through here was produced in the page's own world,
// where Twitch's scripts and every other extension also live. So it is treated
// the way anything off the network is treated: shapes are checked, strings are
// bounded, and none of it is allowed to decide anything. It is rendered as text
// in a menu and nothing more — it never reaches a send, a moderation action, a
// stored setting or an auth flow.
(function (FCM) {
  'use strict';

  const OUTBOUND = 'fcm-page-request';
  const INBOUND = 'fcm-page-reply';
  // Long enough for a cold Apollo cache on a slow connection, short enough that
  // a menu never sits waiting on a page that is not going to answer.
  const TIMEOUT_MS = 6000;
  // Nothing this returns is longer than a timestamp or a display name.
  const MAX_STRING = 120;

  function randomNonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  const str = (value) => (typeof value === 'string' ? value.slice(0, MAX_STRING) : '');
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  /**
   * Opens the bridge to the page's own world.
   *
   * Returns an object whose calls resolve to null rather than rejecting when
   * the page cannot answer — there is no version of "the site changed its
   * internals" that a chat overlay should turn into an error.
   */
  FCM.createPageBridge = function () {
    const nonce = randomNonce();
    const pending = new Map();
    let seq = 0;
    let closed = false;

    function onMessage(event) {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const msg = event.data;
      if (!msg || msg.channel !== INBOUND) return;
      // Anything not bearing this page's handle came from somewhere else.
      if (msg.nonce !== nonce || typeof msg.id !== 'string') return;
      const waiting = pending.get(msg.id);
      if (!waiting) return;
      pending.delete(msg.id);
      waiting(msg.ok ? { ok: true, data: msg.data } : { ok: false, error: str(msg.error) });
    }

    window.addEventListener('message', onMessage);

    function call(op, args) {
      if (closed) return Promise.resolve(null);
      const id = `${nonce.slice(0, 8)}-${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(null);
        }, TIMEOUT_MS);
        pending.set(id, (result) => {
          clearTimeout(timer);
          resolve(result && result.ok ? result : null);
        });
        window.postMessage({
          channel: OUTBOUND, nonce, id, op, args: args || {},
        }, location.origin);
      });
    }

    return {
      /**
       * Whether the page can actually do each of these right now. Asked before
       * anything is offered, so the menu never shows a gift button on a page
       * whose checkout could not be found.
       */
      async capabilities() {
        const res = await call('capabilities');
        const data = res && res.data;
        return {
          relationship: !!(data && data.relationship),
          gifting: !!(data && data.gifting),
        };
      },

      /**
       * When this viewer started following the channel, and their subscription
       * to it, as the page's own signed-in session sees it.
       */
      async relationship(login, channelId) {
        const res = await call('relationship', { login, channelId });
        const data = res && res.data;
        if (!data || typeof data !== 'object') return null;
        return {
          displayName: str(data.displayName),
          createdAt: str(data.createdAt),
          followedAt: str(data.followedAt),
          subscriptionTier: str(data.subscriptionTier),
          subscriptionMonths: num(data.subscriptionMonths),
        };
      },

      /**
       * Asks the page to open Twitch's own gift-subscription checkout.
       *
       * Opens a dialog and nothing else. Twitch draws the price and the confirm
       * button, and the viewer completes it there — this extension never sees a
       * payment method and cannot complete a purchase.
       */
      async giftSub(tier, recipient) {
        const res = await call('giftSub', { tier, recipient });
        return !!(res && res.data && res.data.opened);
      },

      close() {
        closed = true;
        window.removeEventListener('message', onMessage);
        pending.forEach((resolve) => resolve(null));
        pending.clear();
      },
    };
  };
})(self.FCM);
