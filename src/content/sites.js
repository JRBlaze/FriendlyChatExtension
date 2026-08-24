// Per-site adapters: where the channel name lives in the URL, where the native
// chat column is on screen, where the streamer's own links to the other
// platform are, and how to type into the site's own composer.
(function (FCM) {
  'use strict';

  function firstMatch(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // An element only counts as the chat if it is actually laid out and on screen.
  // A display:none or zero-size match would otherwise drag the overlay into a
  // sliver in the corner.
  function isLaidOut(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 120 && r.height >= 80;
  }

  function firstLaidOut(selectors) {
    for (const sel of selectors) {
      // Several nodes can match once a site keeps an offscreen copy around, so
      // every match is checked rather than only the first.
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        if (isLaidOut(el)) return el;
      }
    }
    return null;
  }

  /**
   * Climbs from the message list to the outermost element that is still the
   * same column, which is the chat panel as the site draws it: header, messages
   * and composer, and nothing of the page around it.
   *
   * Width is the signal. Going up through the chat's own wrappers keeps the
   * width identical; the moment a parent gets materially wider, that parent is
   * the page row holding the player as well, so we stop.
   */
  function expandToChatColumn(start) {
    let best = start;
    let node = start;
    for (let depth = 0; depth < 8; depth++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      const pr = parent.getBoundingClientRect();
      const br = best.getBoundingClientRect();
      if (pr.width - br.width > Math.max(16, br.width * 0.1)) break;
      if (pr.height < br.height) break;
      best = parent;
      node = parent;
    }
    return best;
  }

  // Resolves the box the overlay should cover: a known chat-column selector if
  // the site still uses one, otherwise the message list expanded up to its column.
  function resolveChatBox(columnSelectors, messageSelectors) {
    const column = firstLaidOut(columnSelectors);
    if (column) return column;
    const messages = firstLaidOut(messageSelectors);
    return messages ? expandToChatColumn(messages) : null;
  }

  // The message list is the anchor the native-region code climbs from, so it is
  // resolved with a far looser layout test than the chat column: an empty or
  // barely-started chat is a few pixels tall and still the right element.
  function firstPresent(selectors) {
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width >= 80 && r.height >= 8) return el;
      }
    }
    return null;
  }

  // First match for any of these selectors inside one subtree.
  function firstIn(root, selectors) {
    if (!root) return null;
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /**
   * Like firstMatch, but skips anything the page is not actually laying out.
   *
   * Kick renders its whole chat twice — once for real and once inside a
   * `display: none` streaming placeholder, both carrying the same ids. Which
   * copy comes first in the document is not something to depend on, and picking
   * the dead one would mean hiding a chat nobody can see while the real one
   * stays on screen.
   */
  function firstReal(selectors) {
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return el;
      }
    }
    return null;
  }

  // Looks inside the chat column first. Both sites have other contenteditable
  // and textbox elements on the page (search, the whisper composer, moderation
  // views), and the broadest selectors here would otherwise pick one of those.
  function findComposer(site, selectors) {
    const scope = site.chatContainer();
    for (const root of [scope, document]) {
      if (!root) continue;
      for (const sel of selectors) {
        for (const el of root.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          // The real composer is on screen and has some height to it.
          if (r.height >= 12 && r.width >= 60) return el;
        }
      }
    }
    return null;
  }

  /**
   * Works out whether the host page is currently in dark or light mode.
   *
   * Class and attribute names are checked first because they are exact, but
   * both sites rename them from time to time, so the reliable fallback is to
   * measure what the page is actually painted: walk up from the chat until an
   * element has a real background colour and judge its brightness.
   *
   * @returns {'dark'|'light'}
   */
  function detectTheme(chatEl) {
    const root = document.documentElement;
    const marks = `${root.className} ${root.dataset.theme || ''} `
      + `${root.getAttribute('data-a-theme') || ''} ${document.body ? document.body.className : ''}`;
    if (/(^|[\s-])dark($|[\s-])|theme-dark|--theme-dark/i.test(marks)) return 'dark';
    if (/(^|[\s-])light($|[\s-])|theme-light|--theme-light/i.test(marks)) return 'light';

    for (let el = chatEl || document.body; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(bg || '');
      if (!m) continue;
      // Fully transparent means this element paints nothing; keep climbing.
      if (m[4] !== undefined && Number(m[4]) === 0) continue;
      // Rec. 601 luma, which tracks perceived brightness closely enough here.
      const luma = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
      return luma < 0.5 ? 'dark' : 'light';
    }
    // Nothing said otherwise, so follow the browser.
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light' : 'dark';
  }

  FCM.detectSiteTheme = detectTheme;

  /**
   * Calls back whenever the host page's theme changes. Both sites toggle a
   * class or attribute on <html>, so that is what is watched; the callback
   * re-runs the full detection rather than trusting the mutation itself.
   */
  FCM.watchSiteTheme = function (chatElFn, onChange) {
    let current = detectTheme(chatElFn());
    const check = () => {
      const next = detectTheme(chatElFn());
      if (next === current) return;
      current = next;
      onChange(next);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-a-theme', 'style'],
    });
    if (document.body) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    }
    const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    if (media && media.addEventListener) media.addEventListener('change', check);

    return {
      current: () => current,
      stop() {
        observer.disconnect();
        if (media && media.removeEventListener) media.removeEventListener('change', check);
      },
    };
  };

  // Scrapes links to the other platform out of the channel page. A link the
  // streamer put in their own about panel is the most reliable way to know
  // which account on the other platform is theirs.
  function scrapeHints(otherHostPattern) {
    const out = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (otherHostPattern.test(href)) out.push(href);
    });
    return Array.from(new Set(out)).slice(0, 40);
  }

  const twitch = {
    id: 'twitch',
    matches: () => /(^|\.)twitch\.tv$/.test(location.hostname),

    channelFromUrl() {
      const parts = location.pathname.split('/').filter(Boolean);
      if (!parts.length) return null;
      // /popout/<channel>/chat and /moderator/<channel> are still channel pages.
      let slug = parts[0].toLowerCase();
      if ((slug === 'popout' || slug === 'moderator' || slug === 'embed') && parts[1]) {
        slug = parts[1].toLowerCase();
      } else if (FCM.TWITCH_RESERVED.has(slug)) {
        return null;
      }
      if (FCM.TWITCH_RESERVED.has(slug)) return null;
      return /^[a-z0-9_]{2,30}$/.test(slug) ? slug : null;
    },

    chatContainer() {
      return resolveChatBox(
        [
          'div[data-a-target="right-column-chat-bar"]',
          'section[data-test-selector="chat-room-component-layout"]',
          'div[data-test-selector="chat-room-component-layout"]',
          '.channel-root__right-column',
          '.right-column',
        ],
        [
          'div[data-test-selector="chat-scrollable-area__message-container"]',
          'div[data-a-target="chat-scroller"]',
          '.chat-scrollable-area__message-container',
          '.chat-list--default',
        ]
      );
    },

    // The element that, when hidden, removes the site's own chat without
    // collapsing the layout around it.
    nativeChatBody() {
      return firstReal([
        'section[data-test-selector="chat-room-component-layout"]',
        'div[data-test-selector="chat-room-component-layout"]',
        'div[data-a-target="right-column-chat-bar"] > div',
      ]);
    },

    // The scrolling list of messages, and the anchor everything the site draws
    // around it is measured from.
    messageList() {
      return firstPresent([
        'div[data-test-selector="chat-scrollable-area__message-container"]',
        '.chat-scrollable-area__message-container',
        'div[data-a-target="chat-scroller"]',
        '.chat-list--default',
      ]);
    },

    /**
     * The site's own bits and channel-points controls, at the foot of its chat.
     *
     * Twitch merged the two balances into one button — its accessible name is
     * "Bits and Points Balances" — and the two numbers inside it still carry
     * their old test selectors, `bits-balance-string` and `copo-balance-string`
     * ("copo" being Twitch's own name for community points).
     */
    // Where the site keeps its balance controls. Named separately so a
    // diagnostics report can list everything in it, which is the one thing
    // worth having when a control cannot be found.
    nativeFooter() {
      return firstMatch([
        '[data-test-selector="chat-input-buttons-container"]',
        '.chat-input__buttons-container',
        '[data-test-selector="community-points-summary"]',
        '.community-points-summary',
      ]);
    },

    nativeControls() {
      const summary = firstMatch([
        '[data-test-selector="community-points-summary"]',
        '.community-points-summary',
      ]);
      const bar = this.nativeFooter();
      const scope = summary || bar;
      // "Whichever button is there" is only safe inside the points summary. The
      // wider buttons container also holds the emote picker and Send, and a
      // rewards chip that clicked Send would be a great deal worse than one
      // that did nothing.
      const openBalances = firstIn(scope, [
        'button[aria-label*="balance" i]',
        'button[aria-label*="points" i]',
        'button[data-test-selector*="points" i]',
      ].concat(summary ? ['button'] : []));
      // The bonus chest only exists while there is a bonus waiting, so it is
      // looked for by name first and then, if Twitch has renamed it again, as
      // whichever other button the summary has grown.
      const named = firstIn(bar || summary, [
        'button[aria-label*="claim" i]',
        'button[data-test-selector*="claim" i]',
      ]);
      const spare = summary
        ? Array.from(summary.querySelectorAll('button'))
          .find((b) => b !== openBalances && b.getBoundingClientRect().height > 0)
        : null;

      return {
        pointsValue: firstIn(scope, [
          '[data-test-selector="copo-balance-string"]',
          '[data-test-selector*="points-balance" i]',
        ]),
        bitsValue: firstIn(scope, [
          '[data-test-selector="bits-balance-string"]',
          '[data-test-selector*="bits-balance" i]',
        ]),
        openBalances,
        cheer: firstMatch([
          'button[data-a-target="bits-button"]',
          'button[aria-label="Cheer"]',
        ]),
        claim: named || spare || null,
      };
    },

    hints() {
      return scrapeHints(/kick\.com/i);
    },

    composer() {
      return findComposer(this, [
        'div[data-a-target="chat-input"][contenteditable="true"]',
        'div[data-a-target="chat-input"] [contenteditable="true"]',
        'textarea[data-a-target="chat-input"]',
        '[data-a-target="chat-input"]',
        'div[role="textbox"][contenteditable="true"]',
        '.chat-wysiwyg-input__editor',
      ]);
    },

    sendButton() {
      return firstMatch([
        'button[data-a-target="chat-send-button"]',
        'button[data-test-selector="chat-send-button"]',
      ]);
    },
  };

  const kick = {
    id: 'kick',
    matches: () => /(^|\.)kick\.com$/.test(location.hostname),

    channelFromUrl() {
      const parts = location.pathname.split('/').filter(Boolean);
      if (!parts.length) return null;
      let slug = parts[0].toLowerCase();
      if (slug === 'popout' && parts[1]) slug = parts[1].toLowerCase();
      if (FCM.KICK_RESERVED.has(slug)) return null;
      return /^[a-z0-9_-]{2,30}$/.test(slug) ? slug : null;
    },

    chatContainer() {
      return resolveChatBox(
        [
          '#chatroom',
          '#channel-chatroom',
          '[data-testid="chat-container"]',
          'aside[class*="chatroom"]',
          'div[class*="chatroom"]',
        ],
        [
          '#chatroom-messages',
          '[data-testid="chat-message-list"]',
          '[data-chat-entry]',
          'div[class*="chat-message-list"]',
        ]
      );
    },

    nativeChatBody() {
      return firstReal([
        '#chatroom-messages',
        '#chatroom',
        '[data-testid="chat-container"]',
      ]);
    },

    messageList() {
      return firstPresent([
        '#chatroom-messages',
        '[data-testid="chatroom-messages"]',
        '[data-testid="chat-message-list"]',
        'div[class*="chat-message-list"]',
      ]);
    },

    /**
     * Kick's footer carries the Kicks and rewards buttons, but — unlike
     * Twitch — it labels nothing with a test selector, and the classes are
     * generated Tailwind. So the search goes by accessible name, which is the
     * one thing a control that has to be usable cannot drop. Where nothing
     * matches, the overlay simply shows no balances rather than guessing at a
     * button and sending a click somewhere unintended.
     */
    nativeFooter() {
      return firstReal([
        '#chatroom-footer',
        'div[class*="chatroom-footer"]',
        '#chat-input-wrapper',
      ]);
    },

    nativeControls() {
      const footer = this.nativeFooter();
      if (!footer) return {};

      // Sending is the one thing in this footer that must never be triggered by
      // accident, so it is identified once and excluded from every search below.
      const isSend = (btn) => !!btn
        && (btn.id === 'send-message-button'
          || /^(chat|send)$/i.test((btn.textContent || '').replace(/\s+/g, ' ').trim()));

      // Kick's icons are the one thing in its footer that carries a stable
      // name — everything else is generated Tailwind with no label at all.
      const byIcon = (pattern, skip) => {
        for (const icon of footer.querySelectorAll('[data-ds-icon]')) {
          if (!pattern.test(icon.getAttribute('data-ds-icon') || '')) continue;
          const btn = icon.closest('button');
          if (btn && btn !== skip && !isSend(btn)) return btn;
        }
        return null;
      };

      // Last resort, and safe as a last resort precisely because of what it
      // matches: a footer button whose entire visible text is a number is a
      // balance and nothing else. Anything that does something — send, emotes,
      // settings — either says so or shows only an icon.
      const byNumber = (skip) => {
        for (const btn of footer.querySelectorAll('button')) {
          if (isSend(btn) || btn === skip) continue;
          if (FCM.looksLikeBalance(btn.textContent)) return btn;
        }
        return null;
      };

      // Rewards is resolved first because it is the narrower search, and then
      // excluded from the Kicks one: the last resort there is "a button showing
      // a number", which would otherwise happily return the button Rewards had
      // already claimed and put two chips on the same control.
      // The two exact names Kick uses, confirmed against a signed-in channel,
      // ahead of the looser matches that stand in if it renames them.
      const points = firstIn(footer, [
        '[data-testid="channel-points-button"]',
        '[data-testid*="point" i]',
        'button[aria-label*="point" i]',
        'button[aria-label*="reward" i]',
        'button[title*="reward" i]',
      ]) || byIcon(/point|reward|trophy|bubble/i);

      // Kick's Kicks control is labelled "Get KICKs" and shows no balance at
      // all, which is why it is looked for by name rather than by a number.
      const notPoints = (el) => (el && el !== points ? el : null);
      const kicks = notPoints(firstIn(footer, [
        '[data-testid="get-kicks"]',
        '[data-testid*="kicks" i]',
        'button[aria-label*="kicks" i]',
        'button[title*="kicks" i]',
      ])) || notPoints(byIcon(/kick|spark|gift/i, points)) || notPoints(byNumber(points));

      return {
        // Kick keeps the number inside the button rather than in a labelled
        // node of its own, so the button is both the value and the way in.
        pointsValue: points,
        bitsValue: kicks,
        openBalances: points || kicks,
        cheer: kicks,
        claim: firstIn(footer, [
          'button[aria-label*="claim" i]',
          'button[title*="claim" i]',
        ]),
      };
    },

    hints() {
      return scrapeHints(/twitch\.tv/i);
    },

    composer() {
      return findComposer(this, [
        '#message-input',
        'div[data-testid="chat-input"][contenteditable="true"]',
        'div[data-testid="chat-input"] [contenteditable="true"]',
        'div[contenteditable="true"][data-input="true"]',
        'div.editor-input[contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
        'textarea[placeholder*="message" i]',
        'div[contenteditable="true"]',
      ]);
    },

    sendButton() {
      // Kick's send button carries no test selector, no aria-label and no
      // title — only an id. Without it the send path fell back to pressing
      // Enter, which works but is a guess about a key binding rather than the
      // button the site actually wired up.
      return firstReal([
        '#send-message-button',
        'button[data-testid="chat-send-button"]',
        'button[aria-label*="send" i]',
        'button[title*="send" i]',
      ]);
    },
  };

  FCM.SITES = { twitch, kick };

  FCM.currentSite = function () {
    if (twitch.matches()) return twitch;
    if (kick.matches()) return kick;
    return null;
  };

  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function readComposer(box) {
    if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') return box.value || '';
    return box.innerText || box.textContent || '';
  }

  function landed(box, message) {
    // Editors normalise whitespace and can add a trailing newline, so compare
    // on collapsed whitespace rather than demanding an exact string.
    const got = readComposer(box).replace(/\s+/g, ' ').trim();
    return got.includes(message.replace(/\s+/g, ' ').trim());
  }

  function selectAllIn(box) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(box);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // Insertion strategies, cheapest and most faithful first. Each returns after
  // attempting; the caller checks whether the text actually landed, because a
  // React-controlled editor will happily swallow an event and change nothing.
  const INSERT_STRATEGIES = [
    // A real paste is what Slate and Lexical both handle most reliably, and it
    // goes through the editor's own model rather than touching the DOM.
    function paste(box, message) {
      selectAllIn(box);
      const data = new DataTransfer();
      data.setData('text/plain', message);
      box.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: data,
      }));
    },
    // execCommand still drives contenteditable in Chrome and produces the full
    // beforeinput/input pair the editors listen for.
    function exec(box, message) {
      selectAllIn(box);
      document.execCommand('insertText', false, message);
    },
    function inputEvents(box, message) {
      selectAllIn(box);
      box.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: message,
      }));
      box.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: message,
      }));
    },
    // Last resort for a plain, uncontrolled contenteditable.
    function directWrite(box, message) {
      box.textContent = message;
      box.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: message,
      }));
    },
  ];

  function setNativeValue(box, message) {
    const proto = box.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(box, message);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Driving the site's composer means moving focus into it, so where focus was
  // has to be remembered and put back. Without that, the caret is left in the
  // page's own chat box — which the overlay is sitting on top of — and the next
  // thing the user types goes somewhere they cannot see.
  function captureFocus() {
    let active = document.activeElement;
    // The overlay's input lives in a shadow root, so document.activeElement
    // reports the host element; the real one is a level further in.
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function restoreFocus(el) {
    if (!el || typeof el.focus !== 'function') return;
    if (captureFocus() === el) return;
    try {
      el.focus({ preventScroll: true });
      // Put the caret back at the end rather than selecting the whole value.
      if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
        el.setSelectionRange(el.value.length, el.value.length);
      }
    } catch (e) { /* the element was removed while we were sending */ }
  }

  function pressEnter(box) {
    ['keydown', 'keypress', 'keyup'].forEach((type) => {
      box.dispatchEvent(new KeyboardEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: type === 'keypress' ? 13 : 0,
      }));
    });
  }

  /**
   * Types into the host site's own composer and submits it.
   *
   * The overlay never holds a platform token, so this is how a message gets
   * sent: it drives the page's real, already-signed-in chat box, and the
   * message goes out as the account signed in there.
   *
   * Neither site uses a plain input. Twitch's composer is Slate and Kick's is
   * Lexical, and both keep their own model of the text: assigning to the DOM
   * changes nothing they will read back. So each insertion strategy is tried in
   * turn and the box is read back afterwards to see whether it took.
   *
   * @returns {Promise<{ok: boolean, reason: string}>}
   */
  FCM.sendViaNativeComposer = async function (site, text) {
    const message = String(text || '').trim();
    if (!message) return { ok: false, reason: 'empty' };

    const box = site.composer();
    if (!box) return { ok: false, reason: 'no-composer' };

    const previousFocus = captureFocus();

    // The composer is unusable while hidden, and the "hide the site's own chat"
    // setting hides exactly the subtree it lives in — so un-hide it for the
    // duration of the send and put it back afterwards.
    const unhidden = [];
    for (let el = box; el && el !== document.body; el = el.parentElement) {
      if (el.style && el.style.visibility === 'hidden') {
        unhidden.push(el);
        el.style.visibility = 'visible';
      }
    }

    try {
      if (box.isContentEditable === false && box.disabled) {
        return { ok: false, reason: 'composer-disabled' };
      }

      box.focus();
      if (document.activeElement !== box && !box.contains(document.activeElement)) {
        // Some editors only accept input once their wrapper has been clicked.
        box.click();
        box.focus();
      }

      if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
        setNativeValue(box, message);
      } else {
        let ok = false;
        for (const strategy of INSERT_STRATEGIES) {
          try { strategy(box, message); } catch (e) { /* try the next one */ }
          await tick(20);
          if (landed(box, message)) { ok = true; break; }
        }
        if (!ok) return { ok: false, reason: 'insert-failed' };
      }

      // The send button is re-enabled by a React render, so give it a frame.
      await tick(60);

      const button = site.sendButton();
      if (button && !button.disabled) button.click();
      else pressEnter(box);

      // Hand focus back as soon as the message is away, so the checks below do
      // not keep the caret in the page's chat box any longer than necessary.
      restoreFocus(previousFocus);

      await tick(140);
      // A composer that emptied itself is the site telling us it accepted the
      // message. Anything still sitting there means it did not go out.
      if (readComposer(box).trim()) {
        pressEnter(box);
        await tick(160);
        if (readComposer(box).trim()) return { ok: false, reason: 'not-submitted' };
      }
      return { ok: true, reason: 'sent' };
    } catch (e) {
      return { ok: false, reason: 'error' };
    } finally {
      unhidden.forEach((el) => { el.style.visibility = 'hidden'; });
      // Backstop: every early return above lands here too, so focus is restored
      // even when the send failed part-way through.
      restoreFocus(previousFocus);
    }
  };
})(self.FCM);
