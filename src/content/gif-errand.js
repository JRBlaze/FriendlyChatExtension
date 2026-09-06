// Sending a GIF to Twitch from a page that is not Twitch.
//
// Twitch offers no endpoint for one, so the only thing that can post a GIF to
// Twitch chat is Twitch's own keyboard inside a twitch.tv document. On a Twitch
// page the overlay opens that keyboard where it stands. On a Kick page there is
// no Twitch document to open it in, so this opens one — Twitch's own popout
// chat for the channel the panel is already joined to, in a small window beside
// the stream, which presses its own picker and then stands back. Twitch applies
// its own rules there and sends the GIF under whatever account this browser is
// signed in to, and it arrives back in the merged feed down the Twitch socket
// the worker already holds, drawn by the code that has always drawn everybody
// else's.
(function (FCM) {
  'use strict';

  // The mark on an address opened for this errand. It rides in the fragment,
  // which is never sent to Twitch and which Twitch's own router ignores.
  FCM.GIF_ERRAND_MARK = '#fcm-gif';

  // And on the window's name, which is what the errand actually travels on.
  // Twitch is a single-page app whose router is free to rewrite the address
  // before a content script at document_idle has read it; a name given by
  // window.open survives that, and a reload, and is readable by the document it
  // names. The fragment is kept as well, for a window whose name was refused.
  FCM.GIF_ERRAND_NAME = 'fcm-gif-';

  // How long the errand waits for Twitch to draw its chat. A popout opened from
  // cold is a page load, not a React frame: the emote picker button does not
  // exist for a second or two, and pressing at mount is why an errand that did
  // not wait would say "Twitch is not showing its emote picker on this page"
  // almost every time.
  const PICKER_WAIT_MS = 20 * 1000;
  const PICKER_POLL_MS = 250;

  // The GIFs option inside the picker is given longer here than on a Twitch
  // page, for the same reason: this window has only just loaded, so its picker
  // is the coldest one there is. Nothing is hidden behind this wait — there is
  // no merged panel in this window to step aside — so it can afford to be
  // patient where the button on a Twitch page cannot.
  const ERRAND_TAB_WAIT_MS = 15000;

  // The window: tall and narrow, because it is a chat column and nothing else.
  const WINDOW_W = 420;
  const WINDOW_H = 640;
  // Overlapping the asking window by a few pixels is what makes a second window
  // read as attached to the first rather than dropped somewhere near it.
  const WINDOW_OVERLAP = 6;

  // What Twitch will accept as a login, which is not what normalizeChannel
  // guarantees — that only trims and lowercases. An address is being built
  // here, so the name goes out through the same gate the site adapter reads one
  // back in through.
  const SLUG = /^[a-z0-9_]{2,30}$/;

  const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);

  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function slugFor(channel) {
    const slug = FCM.normalizeChannel(channel);
    return SLUG.test(slug) ? slug : '';
  }

  /**
   * Twitch's own popout chat for a channel, marked as an errand.
   *
   * The popout rather than the channel page: it is the chat and nothing else,
   * it carries the same emote picker, the content script already treats
   * `/popout/<channel>/chat` as a channel page, and it costs a viewer who is
   * watching the stream on Kick no second copy of the video and no second audio
   * to go with it.
   *
   * @returns {string|null} null when the name is not one Twitch could have
   */
  FCM.gifErrandUrl = function (channel) {
    const slug = slugFor(channel);
    if (!slug) return null;
    return `https://www.twitch.tv/popout/${slug}/chat${FCM.GIF_ERRAND_MARK}`;
  };

  /**
   * The name the errand window is opened under.
   *
   * Named for the channel, so a second press that has lost its handle — a
   * channel switched away from and back, a panel rebuilt — reaches the window
   * that is already open instead of putting another one beside it.
   */
  FCM.gifErrandWindowName = function (channel) {
    const slug = slugFor(channel);
    return slug ? `${FCM.GIF_ERRAND_NAME}${slug}` : '';
  };

  /**
   * Whether this document is a window opened to fetch a GIF.
   *
   * All of it has to agree: Twitch, a channel page, and a mark this extension
   * put there itself. A mark on anything else is not an instruction — someone
   * who bookmarks the marked address gets the ordinary merged panel, the same
   * as any other popout chat.
   */
  FCM.isGifErrand = function (site, loc, name) {
    if (!site || site.id !== 'twitch') return false;
    if (!site.channelFromUrl || !site.channelFromUrl()) return false;
    const marked = String((loc && loc.hash) || '') === FCM.GIF_ERRAND_MARK;
    const named = String(name || '').startsWith(FCM.GIF_ERRAND_NAME);
    return marked || named;
  };

  /**
   * Where the errand window goes, and how big.
   *
   * Beside the window that asked for it, on the right; on the left when the
   * right has no room; and against the left edge of the screen for a window
   * that fills it, because the right is the side both sites put their chat
   * column on and it is the side the merged panel follows. The GIF is about to
   * appear in that panel, and covering the payoff is the one placement worth
   * going out of the way to avoid.
   *
   * Pure, and given both boxes rather than reading them, so it can be checked
   * without a screen.
   *
   * @returns {{left: number, top: number, width: number, height: number}}
   */
  FCM.gifWindowPlacement = function (view, screen) {
    const availLeft = num(screen && screen.availLeft, 0);
    const availTop = num(screen && screen.availTop, 0);
    const availW = Math.max(num(screen && screen.availWidth, WINDOW_W), 200);
    const availH = Math.max(num(screen && screen.availHeight, WINDOW_H), 200);

    const width = Math.min(WINDOW_W, availW);
    const height = Math.min(WINDOW_H, availH);

    const vx = num(view && view.screenX, availLeft);
    const vy = num(view && view.screenY, availTop);
    const vw = num(view && view.outerWidth, availW);
    const vh = num(view && view.outerHeight, availH);

    let left;
    if (vx + vw + width - WINDOW_OVERLAP <= availLeft + availW) left = vx + vw - WINDOW_OVERLAP;
    else if (vx - width + WINDOW_OVERLAP >= availLeft) left = vx - width + WINDOW_OVERLAP;
    else left = availLeft;

    // Centred on the window that asked, which is where the eye already is.
    let top = Math.round(vy + (vh - height) / 2);

    left = Math.round(Math.min(Math.max(left, availLeft), availLeft + availW - width));
    top = Math.min(Math.max(top, availTop), availTop + availH - height);
    return { left, top, width, height };
  };

  FCM.gifWindowFeatures = function (view, screen) {
    const box = FCM.gifWindowPlacement(view, screen);
    return `popup=1,width=${box.width},height=${box.height},left=${box.left},top=${box.top}`;
  };

  function tierNote(sub) {
    if (!sub || !sub.subscribed) return '';
    if (sub.tier >= 2) {
      const months = sub.months ? ` (${sub.months} month${sub.months === 1 ? '' : 's'})` : '';
      return `you are a Tier ${sub.tier} subscriber there${months}`;
    }
    if (sub.tier === 1) return 'your connected account is Tier 1 there';
    return 'you subscribe there, at a tier Twitch has not said';
  }

  /**
   * What the GIF button is, on either kind of page.
   *
   * On Twitch it follows the site's own picker, exactly as it always has: the
   * button is offered to everyone the picker is on screen for, because Twitch's
   * keyboard is where the tier rule is applied and it explains itself to a
   * viewer it turns away. On Kick there is no picker to follow, so it follows
   * the one thing that has to be true for a GIF to have anywhere to land —
   * Twitch chat joined in this panel — and is simply not drawn otherwise,
   * because the Twitch chip one row up is already the invitation to fix that.
   *
   * @returns {{show: boolean, cross: boolean, tier: number, title: string}}
   */
  FCM.gifButtonState = function (state) {
    const sub = state && state.subscription;
    const tier = sub && sub.subscribed ? sub.tier : 0;

    if (!state || state.hostPlatform === 'twitch') {
      let title;
      if (tier >= 2) {
        title = `Send a GIF — you are a Tier ${tier} subscriber here`
          + (sub.months ? ` (${sub.months} month${sub.months === 1 ? '' : 's'})` : '');
      } else if (sub && sub.subscribed) {
        title = 'Send a GIF — Twitch offers GIFs in chat to Tier 2 and Tier 3 '
          + `subscribers, and you are ${tier === 1 ? 'Tier 1' : 'subscribed at a tier it has not said'}`;
      } else {
        title = "Send a GIF through Twitch's own GIF keyboard "
          + '(a Tier 2 and Tier 3 subscriber perk)';
      }
      return { show: !!(state && state.pageHasGifs), cross: false, tier, title };
    }

    const where = state.twitchChannel || '';
    if (state.windowOpen) {
      return {
        show: !!where,
        cross: true,
        tier,
        title: "Twitch's GIF keyboard is open in a window of its own — "
          + 'click to bring it to the front',
      };
    }
    if (!where) {
      // Nothing is drawn in this state. The title is still written, because a
      // button with a sentence built around a channel that is not there reads
      // as nonsense the moment anything does show it.
      return {
        show: false,
        cross: true,
        tier,
        title: 'Send a GIF to Twitch — no Twitch chat is connected in this panel',
      };
    }
    const standing = tierNote(sub);
    const title = `Send a GIF to ${where} on Twitch`
      + (standing ? ` — ${standing}` : '')
      + ". Opens Twitch's own GIF keyboard in a window of its own, and posts as"
      + ' whoever this browser is signed in to on Twitch.';
    return { show: true, cross: true, tier, title };
  };

  /**
   * What a press of the GIF button on a page that is not Twitch should do.
   *
   * Never a refusal. The tier this panel knows is the connected account's, and
   * the account that will actually send is whichever one this browser is signed
   * in to on twitch.tv — usually the same person, and never required to be.
   * Turning away a viewer who can send, on the strength of the wrong account's
   * tier, would be a worse answer than opening the window and letting Twitch
   * give the right one. So what is known is said, and the window opens anyway,
   * which is what the button on a Twitch page has always done.
   *
   * @returns {{act: 'open'|'focus'|'none', url: string, name: string,
   *   note: string}}
   */
  FCM.gifClickPlan = function (state) {
    if (state && state.windowOpen) {
      return {
        act: 'focus',
        url: '',
        name: '',
        note: "Twitch's GIF keyboard is already open in its own window",
      };
    }
    const channel = (state && state.twitchChannel) || '';
    const url = FCM.gifErrandUrl(channel);
    if (!url) {
      return {
        act: 'none',
        url: '',
        name: '',
        note: 'Twitch chat is not connected here, so a GIF would have nowhere to go',
      };
    }
    const sub = state.subscription;
    let note;
    if (sub && sub.subscribed && sub.tier === 1) {
      note = 'GIFs in chat are a Tier 2 and Tier 3 perk — Twitch will offer the upgrade';
    } else if (sub && !sub.subscribed) {
      note = 'GIFs in chat are for Tier 2 and Tier 3 subscribers of this channel';
    } else {
      note = `Opening Twitch's GIF keyboard for ${channel} — the GIF posts to Twitch`;
    }
    return { act: 'open', url, name: FCM.gifErrandWindowName(channel), note };
  };

  // ── The window at the other end ─────────────────────────────────────────────

  const BANNER_CSS = `
    :host { all: initial; }
    .bar {
      position: fixed; inset: 0 0 auto 0; z-index: 2147483647;
      display: flex; align-items: center; gap: 10px;
      padding: 7px 10px; box-sizing: border-box;
      font: 500 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #efeff1; background: #18181b;
      border-bottom: 1px solid #2f2f35;
    }
    .text { flex: 1; min-width: 0; }
    .text b { color: #bf94ff; font-weight: 600; }
    .text small { display: block; color: #adadb8; font-size: 11px; }
    button {
      flex-shrink: 0; font: inherit; font-size: 11px; color: #efeff1;
      background: #26262c; border: 1px solid #3a3a44; border-radius: 4px;
      padding: 4px 9px; cursor: pointer;
    }
    button:hover { background: #33333b; }
  `;

  /**
   * The one line the errand window owes whoever is looking at it.
   *
   * A window that opens by itself has to say why it is there, who it will post
   * as, and how to be rid of it — on the surface the viewer is actually looking
   * at, not in the feed behind it in the other window. In a shadow root with
   * rules of its own, because this is Twitch's page and nothing of ours belongs
   * in its styles.
   */
  function mountBanner(doc, onClose) {
    const host = doc.createElement('div');
    host.id = 'fcm-gif-errand';
    const root = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = BANNER_CSS;
    const bar = doc.createElement('div');
    bar.className = 'bar';
    const text = doc.createElement('div');
    text.className = 'text';
    const line = doc.createElement('span');
    const note = doc.createElement('small');
    note.textContent = 'It posts as whoever this browser is signed in to on Twitch, '
      + 'and lands in your merged chat.';
    text.appendChild(line);
    text.appendChild(note);
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', onClose);
    bar.appendChild(text);
    bar.appendChild(close);
    root.appendChild(style);
    root.appendChild(bar);
    (doc.body || doc.documentElement).appendChild(host);

    return {
      say(html) { line.innerHTML = html; },
      remove() { host.remove(); },
    };
  }

  /**
   * Presses Twitch's GIF keyboard in a window opened to do exactly that.
   *
   * Nothing else happens in this document: no port, no join, no merged panel.
   * That is not tidiness — a panel here would cover the composer the viewer
   * came to use, and a port here would give the worker a second session and
   * with it a second Twitch socket for a channel this browser is already
   * reading in the tab that sent them.
   *
   * @param {object} [opts] { document, window, pickerWaitMs } — the surfaces to
   *   work on and how long to wait for Twitch to draw its chat. All three are
   *   the real ones in a browser; they are arguments so that the wait can be
   *   checked in a test without spending twenty seconds on it.
   * @returns {Promise<{ok: boolean, reason: string}>} for the tests. Nobody
   *   waits on it: the viewer is the one who acts next.
   */
  FCM.runGifErrand = async function (site, opts) {
    const doc = (opts && opts.document) || document;
    const win = (opts && opts.window) || doc.defaultView || window;
    const pickerWait = Number((opts && opts.pickerWaitMs) || 0) || PICKER_WAIT_MS;
    const channel = (site.channelFromUrl && site.channelFromUrl()) || '';
    const escape = FCM.escapeHtml || ((text) => text);

    // Both marks are spent the moment they are read, so a reload of this window
    // is an ordinary visit and nothing presses a second time.
    try { win.name = ''; } catch (e) { /* nothing to clear */ }
    try {
      win.history.replaceState(null, '', win.location.pathname + win.location.search);
    } catch (e) { /* the address keeps its mark; the name was the one that carried */ }

    const banner = mountBanner(doc, () => {
      // A window this script opened closes; a tab someone reached another way
      // cannot be closed by a script, and saying so is better than a dead
      // button that looks broken.
      try { win.close(); } catch (e) { /* not ours to close */ }
      setTimeout(() => {
        if (win.closed) return;
        banner.say('This opened as a tab rather than a window, so it cannot close '
          + 'itself — close it when you are done.');
      }, 150);
    });
    banner.say(`Friendly Chat opened this for a GIF to <b>${escape(channel)}</b> on Twitch.`);

    const until = Date.now() + pickerWait;
    let button = null;
    while (Date.now() < until) {
      try {
        button = (site.emotePickerButton && site.emotePickerButton()) || null;
      } catch (e) {
        button = null;
      }
      if (button) break;
      await tick(PICKER_POLL_MS);
    }
    if (!button) {
      banner.say('Twitch has not drawn a chat box here. Signing in to Twitch in this '
        + 'window is usually what it is waiting for.');
      return { ok: false, reason: 'no-picker' };
    }

    const result = await FCM.openNativeGifKeyboard(site, { tabWaitMs: ERRAND_TAB_WAIT_MS });
    if (!result.ok) {
      banner.say('Twitch would not open its emote picker here — the GIF keyboard is '
        + 'inside it, at the smiley beside the chat box.');
      return result;
    }
    if (result.reason === 'picker') {
      // Never stated as the channel's setting. A tab that did not appear in the
      // time given looks exactly like one that was never going to.
      banner.say("Twitch's emote picker is open, with no GIFs tab on it — a channel "
        + 'with GIFs switched off looks like this too.');
      return result;
    }
    banner.say(`Pick a GIF — it posts to <b>${escape(channel)}</b> on Twitch.`);
    return result;
  };
})(self.FCM);
