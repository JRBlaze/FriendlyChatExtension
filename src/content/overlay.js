// The overlay itself: a shadow-DOM panel pinned over the host site's own chat
// column, showing the merged feed and the cross-platform prompt.
(function (FCM) {
  'use strict';

  const GEOMETRY_KEY = 'fcm_geometry_v1';

  const ICONS = {
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  };

  FCM.createOverlay = function (options) {
    const { site, channel, onCommand } = options;
    const hostPlatform = site.id;
    const otherPlatform = FCM.otherPlatform(hostPlatform);

    let settings = { ...FCM.DEFAULT_SETTINGS };
    const filter = new Set(FCM.PLATFORMS);
    const status = { twitch: { state: 'idle', channel: null }, kick: { state: 'idle', channel: null } };
    let counterpart = null;
    // Which platforms a typed message goes to, and which have a connected
    // account to send it with.
    let sendTargets = new Set(FCM.SEND_PLATFORMS);
    // Who the current message is addressed to, as platform -> display name.
    // A reply has to land in the chat the person actually spoke in, so while
    // this is non-empty it overrides the chosen send targets entirely.
    const replyTo = new Map();
    let accounts = { twitch: { connected: false }, kick: { connected: false } };
    // Whether this viewer holds a moderator (or broadcaster) badge in each
    // connected channel. The platforms tell us; we never assume.
    const canModerate = { twitch: false, kick: false };
    const pendingSends = new Map();
    let sendSeq = 0;
    let compose = null;
    let themeWatcher = null;
    // The last sign-in failure, kept so the settings sheet can explain it in
    // full rather than flashing it past in a toast.
    let authProblem = null;
    // Set while a drag is in progress, so its window listeners can be removed
    // even if the overlay goes away before the mouse comes back up.
    let endDrag = null;
    let manualPlacement = false;
    let collapsed = false;
    let destroyed = false;
    let nativeChatPrev = null;

    // ── DOM ───────────────────────────────────────────────────────────────────

    const host = document.createElement('div');
    host.id = 'friendly-chat-merge-host';
    host.style.cssText = 'all:initial;position:static;';
    const shadow = host.attachShadow({ mode: 'open' });

    const root = document.createElement('div');
    root.className = 'fcm-root';
    shadow.appendChild(root);

    // The stylesheet is a web-accessible resource rather than an inline string
    // so it stays editable as real CSS.
    fetch(chrome.runtime.getURL('src/content/overlay.css'))
      .then((r) => r.text())
      .then((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        shadow.insertBefore(style, root);
      })
      .catch(() => { /* the panel still works unstyled */ });

    root.innerHTML = `
      <button class="fcm-launcher fcm-hidden" part="launcher">
        <span class="fcm-brand-mark"></span>
        <span class="fcm-launcher-text">Merged chat</span>
        <span class="fcm-launcher-badge fcm-hidden">1</span>
      </button>

      <div class="fcm-panel">
        <div class="fcm-header">
          <span class="fcm-brand"><span class="fcm-brand-mark"></span>Merged</span>
          <div class="fcm-chips"></div>
          <div class="fcm-actions">
            <button class="fcm-icon-btn" data-act="recheck" title="Re-check the other platform">${ICONS.refresh}</button>
            <button class="fcm-icon-btn" data-act="settings" title="Overlay settings">${ICONS.gear}</button>
            <button class="fcm-icon-btn" data-act="collapse" title="Collapse">${ICONS.minus}</button>
            <button class="fcm-icon-btn" data-act="close" title="Hide overlay">${ICONS.close}</button>
          </div>
        </div>

        <div class="fcm-prompt fcm-hidden"></div>

        <div class="fcm-feed"></div>

        <div class="fcm-composer">
          <div class="fcm-reply fcm-hidden"></div>
          <div class="fcm-targets"><span class="fcm-targets-label">Send to</span></div>
          <div class="fcm-composer-row">
            <button class="fcm-emote-btn" title="Emotes (or type : in the box)">&#9786;</button>
            <input class="fcm-input" type="text" maxlength="480">
            <button class="fcm-send">Send</button>
          </div>
        </div>

        <div class="fcm-statusbar">
          <span class="fcm-count">0 messages</span>
          <a class="fcm-sendnote"></a>
        </div>

        <div class="fcm-resize"><div class="fcm-resize-corner"></div></div>
        <div class="fcm-toast"></div>
      </div>
    `;

    const $ = (sel) => root.querySelector(sel);
    const panel = $('.fcm-panel');
    const launcher = $('.fcm-launcher');
    const chipsEl = $('.fcm-chips');
    const promptEl = $('.fcm-prompt');
    const feedEl = $('.fcm-feed');
    const inputEl = $('.fcm-input');
    const sendEl = $('.fcm-send');
    const emoteBtn = $('.fcm-emote-btn');
    const targetsEl = $('.fcm-targets');
    const replyEl = $('.fcm-reply');
    const countEl = $('.fcm-count');
    const sendNoteEl = $('.fcm-sendnote');
    const toastEl = $('.fcm-toast');

    const feed = FCM.createFeed(feedEl, () => settings);
    feed.onCount((n) => { countEl.textContent = `${n} message${n === 1 ? '' : 's'}`; });

    // ── Placement ─────────────────────────────────────────────────────────────

    // Last box we successfully matched. Keeping it means a momentary miss —
    // the site re-rendering its chat, an ad break swapping the column out —
    // leaves the overlay where it is instead of making it jump.
    let lastGoodRect = null;

    // Only used before the chat has ever been found, so the overlay is not
    // invisible on a page whose chat markup we do not recognise.
    function dockRight() {
      if (lastGoodRect) return;
      const w = Math.min(360, Math.max(260, Math.round(window.innerWidth * 0.24)));
      applyRect({
        left: window.innerWidth - w - 16,
        top: 80,
        width: w,
        height: Math.round(window.innerHeight * 0.68),
      });
    }

    function applyRect(r) {
      panel.style.left = `${Math.round(r.left)}px`;
      panel.style.top = `${Math.round(r.top)}px`;
      panel.style.width = `${Math.round(r.width)}px`;
      panel.style.height = `${Math.round(r.height)}px`;
    }

    function syncPlacement() {
      if (destroyed || manualPlacement) return;
      const target = site.chatContainer();
      if (!target) { dockRight(); return; }

      const r = target.getBoundingClientRect();
      // A chat that is currently hidden (collapsed right column, mid re-render)
      // reports a zero or near-zero box; hold the last good one rather than
      // shrinking the overlay to nothing.
      if (r.width < 80 || r.height < 60) { dockRight(); return; }

      // The panel is border-box, so these are exactly the chat's own outer
      // width and height — no insets, no padding of our own.
      lastGoodRect = { left: r.left, top: r.top, width: r.width, height: r.height };
      observeTarget(target);
      // While collapsed the panel is auto-height, so only track position and
      // width; the full height is restored when it expands again.
      if (collapsed) {
        panel.style.left = `${Math.round(r.left)}px`;
        panel.style.top = `${Math.round(r.top)}px`;
        panel.style.width = `${Math.round(r.width)}px`;
        return;
      }
      applyRect(lastGoodRect);
    }

    let placementTimer = null;
    let resizeObserver = null;
    let observedTarget = null;

    // The site replaces its chat node on navigation and on theatre-mode toggles,
    // which silently detaches the observer, so the observed element is
    // re-checked every sync rather than only at mount.
    function observeTarget(target) {
      if (target === observedTarget) return;
      if (!window.ResizeObserver) return;
      if (!resizeObserver) resizeObserver = new ResizeObserver(() => syncPlacement());
      resizeObserver.disconnect();
      resizeObserver.observe(target);
      observedTarget = target;
    }

    function watchPlacement() {
      syncPlacement();
      window.addEventListener('resize', syncPlacement, { passive: true });
      window.addEventListener('scroll', syncPlacement, { passive: true, capture: true });
      // Twitch's own chat-width drag handle, sidebar collapses and ad breaks all
      // move the column without firing anything we can hook, so a poll backs the
      // observer up.
      placementTimer = setInterval(syncPlacement, 500);
    }

    async function loadGeometry() {
      try {
        const stored = await chrome.storage.local.get(GEOMETRY_KEY);
        const geo = (stored[GEOMETRY_KEY] || {})[hostPlatform];
        if (geo && geo.manual) {
          manualPlacement = true;
          panel.style.left = `${geo.left}px`;
          panel.style.top = `${geo.top}px`;
          panel.style.width = `${geo.width}px`;
          panel.style.height = `${geo.height}px`;
        }
      } catch (e) { /* fall back to auto placement */ }
    }

    async function saveGeometry() {
      try {
        const stored = await chrome.storage.local.get(GEOMETRY_KEY);
        const all = stored[GEOMETRY_KEY] || {};
        all[hostPlatform] = manualPlacement ? {
          manual: true,
          left: parseInt(panel.style.left, 10) || 0,
          top: parseInt(panel.style.top, 10) || 0,
          width: parseInt(panel.style.width, 10) || 320,
          height: parseInt(panel.style.height, 10) || 520,
        } : { manual: false };
        await chrome.storage.local.set({ [GEOMETRY_KEY]: all });
      } catch (e) { /* geometry is a convenience */ }
    }

    function enableDragAndResize() {
      const header = $('.fcm-header');
      const grip = $('.fcm-resize');
      const corner = $('.fcm-resize-corner');

      function drag(e, mode) {
        if (e.button !== 0) return;
        e.preventDefault();
        const start = {
          x: e.clientX, y: e.clientY,
          left: panel.offsetLeft, top: panel.offsetTop,
          width: panel.offsetWidth, height: panel.offsetHeight,
        };
        const move = (ev) => {
          const dx = ev.clientX - start.x;
          const dy = ev.clientY - start.y;
          manualPlacement = true;
          if (mode === 'move') {
            panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, start.left + dx))}px`;
            panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, start.top + dy))}px`;
          } else if (mode === 'height') {
            panel.style.height = `${Math.max(160, start.height + dy)}px`;
          } else {
            panel.style.width = `${Math.max(240, start.width - dx)}px`;
            panel.style.left = `${start.left + dx}px`;
          }
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          endDrag = null;
          saveGeometry();
        };
        // Held so that tearing the overlay down mid-drag — a channel switch
        // while the mouse is still held — cannot leave these on window.
        endDrag = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          endDrag = null;
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }

      header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        drag(e, 'move');
      });
      // Double-clicking the header snaps the panel back over the native chat.
      header.addEventListener('dblclick', (e) => {
        if (e.target.closest('button')) return;
        manualPlacement = false;
        saveGeometry();
        syncPlacement();
        toast('Snapped back over the native chat');
      });
      grip.addEventListener('mousedown', (e) => drag(e, 'height'));
      corner.addEventListener('mousedown', (e) => { e.stopPropagation(); drag(e, 'width'); });
    }

    // ── Header chips ──────────────────────────────────────────────────────────

    function chipLabel(platform) {
      const meta = FCM.PLATFORM_META[platform];
      const conn = status[platform];
      if (conn.channel) return `${meta.name} · ${conn.channel}`;
      if (platform === otherPlatform && counterpart && counterpart.exists) {
        return `${meta.name} · ${counterpart.channel}`;
      }
      return meta.name;
    }

    function renderChips() {
      chipsEl.replaceChildren();
      FCM.PLATFORMS.forEach((platform) => {
        const conn = status[platform];
        const connected = !!conn.channel;
        const isCounterpartLive = platform === otherPlatform
          && counterpart && counterpart.live && !connected;

        const btn = document.createElement('button');
        btn.className = 'fcm-chip-btn';
        btn.dataset.platform = platform;
        btn.dataset.on = String(connected && filter.has(platform));
        btn.title = connected
          ? `${FCM.PLATFORM_META[platform].name}: click to show/hide in the feed`
          : (counterpart && platform === otherPlatform && counterpart.exists
            ? `${counterpart.displayName} on ${FCM.PLATFORM_META[platform].name} — ${counterpart.live ? 'live now' : 'offline'}. Click to connect.`
            : `Connect ${FCM.PLATFORM_META[platform].name} chat`);

        const dot = document.createElement('span');
        dot.className = isCounterpartLive ? 'fcm-live-pip' : 'fcm-live-dot';
        dot.dataset.state = connected ? conn.state : 'idle';
        btn.appendChild(dot);

        const label = document.createElement('span');
        label.textContent = chipLabel(platform);
        btn.appendChild(label);

        if (connected) {
          const x = document.createElement('span');
          x.textContent = '×';
          x.dataset.act = 'disconnect';
          x.style.cssText = 'opacity:.6;font-size:12px;line-height:1;padding-left:1px;';
          x.title = `Disconnect ${FCM.PLATFORM_META[platform].name}`;
          btn.appendChild(x);
        }

        btn.addEventListener('click', (e) => {
          if (e.target.dataset && e.target.dataset.act === 'disconnect') {
            onCommand({ cmd: 'leave', platform });
            return;
          }
          if (connected) {
            if (filter.has(platform)) filter.delete(platform);
            else filter.add(platform);
            // Hiding every platform would leave a blank feed with no way back.
            if (!filter.size) filter.add(platform);
            feed.applyFilter(filter);
            renderChips();
            return;
          }
          connectPlatform(platform);
        });

        chipsEl.appendChild(btn);
      });
    }

    function connectPlatform(platform) {
      if (platform === hostPlatform) {
        onCommand({ cmd: 'join', platform, channel });
        return;
      }
      if (counterpart && counterpart.exists) {
        onCommand({ cmd: 'join', platform, channel: counterpart.channel });
        return;
      }
      toast(`No ${FCM.PLATFORM_META[platform].name} channel matched — set one in settings`);
      openSheet();
    }

    // ── The cross-platform prompt ─────────────────────────────────────────────

    const dismissed = new Set();

    function promptKey() {
      return `${hostPlatform}:${channel}`;
    }

    function renderPrompt() {
      const other = otherPlatform;
      const connected = !!status[other].channel;
      const show = counterpart && counterpart.exists && counterpart.live
        && !connected
        && settings.crossPromptMode !== 'never'
        && !dismissed.has(promptKey());

      if (!show) { promptEl.classList.add('fcm-hidden'); return; }

      const meta = FCM.PLATFORM_META[other];
      const bits = [];
      if (counterpart.viewers) bits.push(`${counterpart.viewers.toLocaleString()} watching`);
      if (counterpart.category) bits.push(counterpart.category);
      const sub = counterpart.title || bits.join(' · ');

      promptEl.dataset.platform = other;
      promptEl.innerHTML = `
        ${counterpart.avatar ? `<img class="fcm-prompt-avatar" src="${FCM.escapeHtml(counterpart.avatar)}" alt="">` : ''}
        <div class="fcm-prompt-main">
          <div class="fcm-prompt-kicker"><span class="fcm-live-pip"></span>Also live on ${FCM.escapeHtml(meta.name)}</div>
          <div class="fcm-prompt-title"><b>${FCM.escapeHtml(counterpart.displayName)}</b> is streaming on ${FCM.escapeHtml(meta.name)} right now.</div>
          ${sub ? `<div class="fcm-prompt-sub" title="${FCM.escapeHtml(sub)}">${FCM.escapeHtml(bits.length ? `${bits.join(' · ')}` : sub)}</div>` : ''}
          <div class="fcm-prompt-actions">
            <button class="fcm-btn fcm-btn-primary" data-act="accept">Add ${FCM.escapeHtml(meta.name)} chat</button>
            <button class="fcm-btn fcm-btn-ghost" data-act="dismiss">Not now</button>
            <button class="fcm-btn fcm-btn-ghost" data-act="always" title="Connect the other platform automatically from now on">Always</button>
            <button class="fcm-btn fcm-btn-ghost" data-act="never" title="Stop offering this">Never</button>
          </div>
        </div>
      `;
      promptEl.classList.remove('fcm-hidden');

      promptEl.querySelectorAll('button[data-act]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const act = btn.dataset.act;
          if (act === 'accept' || act === 'always') {
            if (act === 'always') {
              settings = await FCM.saveSettings({ crossPromptMode: 'always' });
              FCM.setViewSettings(settings);
              toast('The other platform will connect automatically from now on');
            }
            onCommand({ cmd: 'join', platform: other, channel: counterpart.channel });
          } else if (act === 'never') {
            settings = await FCM.saveSettings({ crossPromptMode: 'never' });
            FCM.setViewSettings(settings);
            toast('Cross-platform prompts turned off — re-enable them in settings');
          }
          dismissed.add(promptKey());
          renderPrompt();
          renderChips();
        });
      });
    }

    // ── Settings sheet ────────────────────────────────────────────────────────

    let sheet = null;

    function closeSheet() {
      if (sheet) { sheet.remove(); sheet = null; }
    }

    function openSheet() {
      if (sheet) { closeSheet(); return; }
      sheet = document.createElement('div');
      sheet.className = 'fcm-sheet';
      const linkedTo = counterpart && counterpart.exists ? counterpart.channel : '';
      const accountRows = FCM.SEND_PLATFORMS.map((platform) => {
        const meta = FCM.PLATFORM_META[platform];
        const acct = accounts[platform] || { connected: false };
        return `<div class="fcm-field">
            <label>${FCM.escapeHtml(meta.name)}
              <small>${acct.connected
                ? `Connected${acct.login ? ` as ${FCM.escapeHtml(acct.login)}` : ''}`
                : 'Not connected — read-only'}</small>
            </label>
            <button class="fcm-btn" data-account="${platform}">${acct.connected ? 'Disconnect' : 'Connect'}</button>
          </div>`;
      }).join('');

      sheet.innerHTML = `
        <div class="fcm-sheet-head">
          <span>Overlay settings</span>
          <button class="fcm-icon-btn" data-act="close-sheet">${ICONS.close}</button>
        </div>
        <div class="fcm-sheet-body">
          <div class="fcm-section-title">Accounts</div>
          <p class="fcm-note">Reading chat needs no account. Connect one only to send
            messages — and to send to the platform you are <em>not</em> currently browsing.</p>
          ${accountRows}
          ${authProblem ? `<div class="fcm-authfail">
            <b>${FCM.escapeHtml(FCM.PLATFORM_META[authProblem.platform].name)} sign-in failed</b>
            <p>${FCM.escapeHtml(authProblem.message)}</p>
            ${authProblem.needsRedirectSetup
              ? `<code class="fcm-code">${FCM.escapeHtml(authProblem.redirectUri || '')}</code>
                 <p class="fcm-authfail-hint">Click the URL to select it, then copy it. Add it under
                 <b>OAuth Redirect URLs</b> in the Twitch developer console, or the redirect list
                 for the Kick app behind the proxy. It must match exactly, trailing slash included.</p>
                 <p class="fcm-authfail-hint">If that app is not yours to edit, register your own
                 application on the platform and put its client ID in the extension's options page
                 instead.</p>`
              : ''}
            ${authProblem.authUrl
              ? `<p class="fcm-authfail-hint"><b>To find out which half is wrong:</b> open the
                 sign-in link below in a normal tab. If it shows the consent screen, the redirect
                 is registered correctly and the problem is the sign-in window itself. If it shows
                 an error, that error names what still needs fixing.</p>
                 <button class="fcm-btn" data-act="open-auth-url">Open the sign-in page in a tab</button>`
              : ''}
            ${authProblem.raw && authProblem.raw !== authProblem.message
              ? `<p class="fcm-authfail-raw">${FCM.escapeHtml(authProblem.raw)}</p>` : ''}
          </div>` : ''}
          <p class="fcm-note">Both platforms must list this extension's redirect URL in their
            developer console before sign-in will work:
            <code class="fcm-code">${FCM.escapeHtml(chrome.identity ? chrome.identity.getRedirectURL() : '')}</code></p>

          <div class="fcm-section-title">Cross-platform</div>
          <div class="fcm-field">
            <label>When they are live on the other platform
              <small>Currently watching ${FCM.escapeHtml(FCM.PLATFORM_META[hostPlatform].name)}/${FCM.escapeHtml(channel)}</small>
            </label>
            <select data-set="crossPromptMode">
              <option value="ask">Ask me</option>
              <option value="always">Connect automatically</option>
              <option value="never">Do nothing</option>
            </select>
          </div>
          <div class="fcm-field fcm-field-col">
            <label>${FCM.escapeHtml(FCM.PLATFORM_META[otherPlatform].name)} channel for this streamer
              <small>${counterpart && counterpart.match ? `Matched by: ${FCM.escapeHtml(counterpart.match)}` : 'No match found yet'} — set it by hand if the guess is wrong.</small>
            </label>
            <input type="text" data-link-input placeholder="${FCM.escapeHtml(FCM.PLATFORM_META[otherPlatform].name)} username" value="${FCM.escapeHtml(linkedTo)}">
          </div>
          <div class="fcm-field">
            <label>&nbsp;</label>
            <span style="display:flex;gap:6px;">
              <button class="fcm-btn" data-act="save-link">Save link</button>
              <button class="fcm-btn fcm-btn-ghost" data-act="clear-link">Reset</button>
            </span>
          </div>

          <div class="fcm-section-title">Overlay</div>
          <div class="fcm-field">
            <label>Open automatically on a channel page</label>
            <input type="checkbox" data-set="autoOpen">
          </div>
          <div class="fcm-field">
            <label>Join this site's chat on open</label>
            <input type="checkbox" data-set="autoConnectHost">
          </div>
          <div class="fcm-field">
            <label>Hide the site's own chat<small>The overlay covers it either way</small></label>
            <input type="checkbox" data-set="hideNativeChat">
          </div>
          <div class="fcm-field">
            <label>Theme<small>Follows the site's own dark or light mode</small></label>
            <select data-set="theme">
              <option value="auto">Match this site</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div class="fcm-field">
            <label>Opacity</label>
            <input type="range" min="50" max="100" step="1" data-set="opacity">
          </div>
          <div class="fcm-field">
            <label>Text size</label>
            <input type="number" min="10" max="22" step="1" data-set="fontSize">
          </div>

          <div class="fcm-section-title">Feed</div>
          <div class="fcm-field">
            <label>Messages kept<small>${FCM.MAX_MESSAGES_MIN}–${FCM.MAX_MESSAGES_MAX}</small></label>
            <input type="number" min="${FCM.MAX_MESSAGES_MIN}" max="${FCM.MAX_MESSAGES_MAX}" step="50" data-set="maxMessages">
          </div>
          <div class="fcm-field">
            <label>Load recent history on join</label>
            <input type="checkbox" data-set="showHistory">
          </div>
          <div class="fcm-field">
            <label>Show subs, raids and other events</label>
            <input type="checkbox" data-set="showEvents">
          </div>
          <div class="fcm-field">
            <label>Third-party emotes<small>7TV, BTTV, FrankerFaceZ</small></label>
            <input type="checkbox" data-set="thirdPartyEmotes">
          </div>
          <div class="fcm-field">
            <label>Timestamps</label>
            <input type="checkbox" data-set="timestamps">
          </div>
          <div class="fcm-field">
            <label>Username badges<small>Mod, sub, VIP and channel badges</small></label>
            <input type="checkbox" data-set="showBadges">
          </div>
          <div class="fcm-field">
            <label>Fade in new messages</label>
            <input type="checkbox" data-set="animations">
          </div>
          <div class="fcm-field fcm-field-col">
            <label>Highlight these names<small>Comma separated</small></label>
            <input type="text" data-set="highlightNames" placeholder="yourname, your_other_name">
          </div>
        </div>
      `;
      panel.appendChild(sheet);

      sheet.querySelectorAll('[data-set]').forEach((el) => {
        const key = el.dataset.set;
        if (el.type === 'checkbox') el.checked = !!settings[key];
        else el.value = settings[key];
        const evt = (el.type === 'range' || el.type === 'number' || el.type === 'text') ? 'input' : 'change';
        el.addEventListener(evt, async () => {
          let value;
          if (el.type === 'checkbox') value = el.checked;
          else if (el.type === 'range' || el.type === 'number') value = Number(el.value);
          else value = el.value;
          settings = await FCM.saveSettings({ [key]: value });
          applySettings(settings);
        });
      });

      const openAuth = sheet.querySelector('[data-act="open-auth-url"]');
      if (openAuth) {
        openAuth.addEventListener('click', () => {
          window.open(authProblem.authUrl, '_blank', 'noopener');
        });
      }

      sheet.querySelectorAll('[data-account]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const platform = btn.dataset.account;
          const connected = accounts[platform] && accounts[platform].connected;
          if (connected) {
            onCommand({ cmd: 'disconnectAccount', platform });
          } else {
            btn.textContent = 'Waiting…';
            btn.disabled = true;
            onCommand({ cmd: 'connectAccount', platform });
          }
        });
      });

      sheet.querySelector('[data-act="close-sheet"]').addEventListener('click', closeSheet);
      sheet.querySelector('[data-act="save-link"]').addEventListener('click', () => {
        const value = FCM.normalizeChannel(sheet.querySelector('[data-link-input]').value);
        onCommand({ cmd: 'setLink', target: value });
        toast(value ? `Linked to ${FCM.PLATFORM_META[otherPlatform].name}/${value}` : 'Link cleared');
        closeSheet();
      });
      sheet.querySelector('[data-act="clear-link"]').addEventListener('click', () => {
        onCommand({ cmd: 'clearLink' });
        toast('Reset — looking the channel up again');
        closeSheet();
      });
    }

    // ── Settings application ──────────────────────────────────────────────────

    function applySettings(next) {
      settings = { ...FCM.DEFAULT_SETTINGS, ...(next || {}) };
      FCM.setViewSettings(settings);
      const stored = Array.isArray(settings.sendTargets) ? settings.sendTargets : FCM.SEND_PLATFORMS;
      sendTargets = new Set(stored.filter((p) => FCM.SEND_PLATFORMS.includes(p)));
      if (!sendTargets.size) sendTargets = new Set(FCM.SEND_PLATFORMS);
      applyTheme();
      root.dataset.animate = String(!!settings.animations);
      root.dataset.timestamps = String(settings.timestamps !== false);
      root.dataset.badges = String(settings.showBadges !== false);
      root.style.setProperty('--fcm-size', `${FCM.clampNumber(settings.fontSize, 10, 22, 13)}px`);
      panel.style.opacity = String(FCM.clampNumber(settings.opacity, 50, 100, 96) / 100);
      applyNativeChatVisibility();
      feed.trim();
      renderPrompt();
      renderTargets();
      refreshSendNote();
    }

    // 'auto' mirrors the host page, so the overlay never looks like a light
    // panel pasted onto a dark site or the reverse.
    function applyTheme() {
      let theme = settings.theme;
      if (theme !== 'light' && theme !== 'dark') {
        theme = themeWatcher ? themeWatcher.current() : FCM.detectSiteTheme(site.chatContainer());
      }
      root.dataset.theme = theme;
    }

    function applyNativeChatVisibility() {
      const body = site.nativeChatBody();
      if (!body) return;
      if (settings.hideNativeChat && !collapsed) {
        if (nativeChatPrev === null) nativeChatPrev = body.style.visibility || '';
        body.style.visibility = 'hidden';
      } else if (nativeChatPrev !== null) {
        body.style.visibility = nativeChatPrev;
        nativeChatPrev = null;
      }
    }

    // ── Misc UI ───────────────────────────────────────────────────────────────

    let toastTimer = null;
    function toast(text) {
      toastEl.textContent = text;
      toastEl.classList.add('fcm-toast-on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('fcm-toast-on'), 2600);
    }

    function setCollapsed(next) {
      collapsed = next;
      panel.classList.toggle('fcm-collapsed', collapsed);
      const btn = root.querySelector('[data-act="collapse"]');
      btn.innerHTML = collapsed ? ICONS.plus : ICONS.minus;
      btn.title = collapsed ? 'Expand' : 'Collapse';
      applyNativeChatVisibility();
      // Expanding has to restore the full chat-sized height, and collapsing
      // still needs the position and width kept in step.
      syncPlacement();
    }

    function setVisible(next) {
      panel.classList.toggle('fcm-hidden', !next);
      launcher.classList.toggle('fcm-hidden', next);
      if (!next) {
        // Park the launcher where the panel was, so it is easy to find again.
        const left = panel.style.left;
        const top = panel.style.top;
        if (left && top) {
          launcher.style.cssText = `left:${left};top:${top};`;
        } else {
          launcher.style.cssText = 'right:18px;bottom:18px;';
        }
      }
      applyNativeChatVisibility();
      if (next) syncPlacement();
    }

    function refreshSendNote() {
      const active = effectiveTargets();
      const replying = replyTo.size > 0;
      const live = FCM.SEND_PLATFORMS.filter(
        (p) => active.has(p) && ['api', 'native'].includes(routeFor(p))
      );
      const names = live.map((p) => FCM.PLATFORM_META[p].name);

      if (replying) {
        const who = [...replyTo.values()].join(', ');
        inputEl.placeholder = names.length
          ? `Reply to ${who} on ${names.join(' + ')}…`
          : `Cannot reply on ${[...replyTo.keys()].map((p) => FCM.PLATFORM_META[p].name).join(' + ')}`;
      } else {
        inputEl.placeholder = names.length
          ? `Message ${names.join(' + ')}…`
          : 'Connect a chat to send a message…';
      }

      sendNoteEl.textContent = names.length
        ? `${replying ? 'replying on' : 'sending to'} ${names.join(' + ')}`
        : (replying ? 'reply has nowhere to go' : 'nowhere to send');
      sendNoteEl.title = live.map((p) => {
        const meta = FCM.PLATFORM_META[p];
        return routeFor(p) === 'api'
          ? `${meta.name}: as ${accounts[p].login || 'your connected account'}`
          : `${meta.name}: through this page's own chat box`;
      }).join('\n') || 'Connect an account, or connect this chat, to send a message.';
    }

    // ── Send targets ──────────────────────────────────────────────────────────

    // How a message to this platform would actually go out right now.
    // 'api'    — a connected account, so it works for either platform
    // 'native' — no account, but this is the site we are on, so the page's own
    //            chat box can be driven instead
    // 'blocked'— the other platform with no account: nothing we can do
    function routeFor(platform) {
      if (!status[platform].channel) return 'no-channel';
      if (accounts[platform] && accounts[platform].connected) return 'api';
      return platform === hostPlatform ? 'native' : 'blocked';
    }

    // Where a typed message actually goes. A reply wins over the chips: clicking
    // a Kick viewer's name and typing must not post to Twitch.
    function effectiveTargets() {
      return replyTo.size ? new Set(replyTo.keys()) : sendTargets;
    }

    function renderReplyBar() {
      if (!replyTo.size) { replyEl.classList.add('fcm-hidden'); replyEl.innerHTML = ''; return; }

      const parts = [...replyTo.entries()].map(([platform, name]) =>
        `<span class="fcm-reply-who"><span class="fcm-dot fcm-dot-${platform}"></span>`
        + `${FCM.escapeHtml(name)}<em>on ${FCM.escapeHtml(FCM.PLATFORM_META[platform].name)}</em></span>`);

      replyEl.innerHTML = `<span class="fcm-reply-label">Replying to</span>${parts.join('')}`
        + '<button class="fcm-reply-clear" title="Cancel the reply and send to the chosen chats">&times;</button>';
      replyEl.classList.remove('fcm-hidden');
      replyEl.querySelector('.fcm-reply-clear').addEventListener('click', () => {
        clearReplyTo();
        inputEl.focus();
      });
    }

    function clearReplyTo() {
      if (!replyTo.size) return;
      replyTo.clear();
      renderReplyBar();
      renderTargets();
      refreshSendNote();
    }

    function setReplyTo(platform, name) {
      if (!FCM.SEND_PLATFORMS.includes(platform)) return;
      replyTo.set(platform, name);
      renderReplyBar();
      renderTargets();
      refreshSendNote();

      // Say so now rather than letting the user type a reply that cannot land.
      const route = routeFor(platform);
      const meta = FCM.PLATFORM_META[platform];
      if (route === 'no-channel') {
        toast(`${meta.name} chat is not connected here, so this reply cannot be sent`);
      } else if (route === 'blocked') {
        toast(`Connect a ${meta.name} account in settings to reply on ${meta.name}`);
      }
    }

    function renderTargets() {
      targetsEl.querySelectorAll('.fcm-target').forEach((el) => el.remove());
      const active = effectiveTargets();
      const locked = replyTo.size > 0;
      targetsEl.dataset.locked = String(locked);

      FCM.SEND_PLATFORMS.forEach((platform) => {
        const meta = FCM.PLATFORM_META[platform];
        const route = routeFor(platform);
        const on = active.has(platform) && route !== 'blocked' && route !== 'no-channel';

        const btn = document.createElement('button');
        btn.className = 'fcm-target';
        btn.dataset.platform = platform;
        btn.dataset.on = String(on);
        btn.dataset.route = route;

        const label = document.createElement('span');
        label.textContent = meta.name;
        btn.appendChild(label);

        if (route === 'native') {
          const tag = document.createElement('span');
          tag.className = 'fcm-target-tag';
          tag.textContent = 'via page';
          btn.appendChild(tag);
          btn.title = `Messages go through this page's own ${meta.name} chat box, `
            + `as whoever is signed in here. Connect a ${meta.name} account in settings `
            + 'to send without it.';
        } else if (route === 'api') {
          const tag = document.createElement('span');
          tag.className = 'fcm-target-tag';
          tag.textContent = accounts[platform].login || 'connected';
          btn.appendChild(tag);
          btn.title = `Sending to ${meta.name} as ${accounts[platform].login || 'your connected account'}.`;
        } else if (route === 'no-channel') {
          btn.title = `${meta.name} chat is not connected in this overlay.`;
        } else {
          const tag = document.createElement('span');
          tag.className = 'fcm-target-tag';
          tag.textContent = 'connect';
          btn.appendChild(tag);
          btn.title = `Connect a ${meta.name} account to send there. Click to set it up.`;
        }

        btn.addEventListener('click', () => {
          if (route === 'blocked') { openSheet(); return; }
          if (route === 'no-channel') { toast(`${meta.name} chat is not connected yet`); return; }
          // Touching the chips is the user taking control back, so the reply
          // lock is released rather than silently ignoring the click.
          if (replyTo.size) {
            clearReplyTo();
            toast('Reply cancelled — sending to the chats you pick');
            return;
          }
          if (sendTargets.has(platform)) {
            // Never let the last target be switched off, or Send does nothing
            // with no explanation.
            const others = FCM.SEND_PLATFORMS.filter(
              (p) => p !== platform && sendTargets.has(p) && ['api', 'native'].includes(routeFor(p))
            );
            if (!others.length) { toast('At least one target has to stay selected'); return; }
            sendTargets.delete(platform);
          } else {
            sendTargets.add(platform);
          }
          FCM.saveSettings({ sendTargets: [...sendTargets] });
          renderTargets();
          refreshSendNote();
        });

        targetsEl.appendChild(btn);
      });
    }

    const SEND_FAILURE_TEXT = {
      // Native-composer failures
      'no-composer': (name) => `No ${name} chat box on this page — sending needs the site's own composer.`,
      'composer-disabled': (name) => `${name}'s chat box is disabled — sign in, or the channel may be in a restricted mode.`,
      'insert-failed': (name) => `Could not type into ${name}'s chat box. Try sending from the site's own box.`,
      'not-submitted': (name) => `${name} did not accept the message — check for slow mode, follower-only mode, or a timeout.`,
      // Connected-account failures
      'not-connected': (name) => `No ${name} account connected — set one up in settings.`,
      'no-channel': (name) => `${name} chat is not connected in this overlay.`,
      expired: (name) => `Your ${name} sign-in expired — reconnect it in settings.`,
      rejected: (name) => `${name} refused the message.`,
      dropped: (name) => `${name} accepted but did not post the message.`,
      network: (name) => `Could not reach ${name}.`,
      timeout: (name) => `${name} did not answer in time.`,
      error: (name) => `Something went wrong handing the message to ${name}.`,
    };

    function focusInput() {
      if (destroyed || !panel.isConnected) return;
      try {
        inputEl.focus({ preventScroll: true });
        const end = inputEl.value.length;
        inputEl.setSelectionRange(end, end);
      } catch (e) { /* the panel was torn down mid-send */ }
    }

    // Resolved by the background worker's sendResult message.
    function sendViaApi(platforms, text) {
      const id = `s${++sendSeq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSends.delete(id);
          const timedOut = {};
          platforms.forEach((p) => { timedOut[p] = { ok: false, reason: 'timeout' }; });
          resolve(timedOut);
        }, 12000);
        pendingSends.set(id, (results) => { clearTimeout(timer); resolve(results); });
        onCommand({ cmd: 'send', id, text, targets: platforms });
      });
    }

    async function doSend() {
      const text = inputEl.value.trim();
      if (!text) return;

      const active = effectiveTargets();
      const replying = replyTo.size > 0;
      const chosen = FCM.SEND_PLATFORMS.filter((p) => active.has(p));
      const routes = new Map(chosen.map((p) => [p, routeFor(p)]));
      const apiTargets = chosen.filter((p) => routes.get(p) === 'api');
      const nativeTargets = chosen.filter((p) => routes.get(p) === 'native');

      if (!apiTargets.length && !nativeTargets.length) {
        const blocked = chosen.filter((p) => routes.get(p) === 'blocked');
        const who = blocked[0] || chosen[0];
        const name = who ? FCM.PLATFORM_META[who].name : '';
        if (replying) {
          // Falling back to the other chat would send the reply to people who
          // cannot see what it is answering, so refuse instead.
          toast(blocked.length
            ? `Connect a ${name} account in settings to reply on ${name}`
            : `${name} chat is not connected, so this reply cannot be sent`);
        } else {
          toast(blocked.length
            ? `Connect a ${name} account in settings to send there`
            : 'No connected chat selected to send to');
        }
        return;
      }

      sendEl.disabled = true;
      // Clear straight away so a slow send does not swallow the next message,
      // and put the text back if none of the targets accepted it.
      inputEl.value = '';
      if (compose) compose.closeAll();

      const failures = [];
      let delivered = 0;

      try {
        const work = [];
        if (apiTargets.length) {
          work.push(sendViaApi(apiTargets, text).then((results) => {
            apiTargets.forEach((p) => {
              const r = results[p] || { ok: false, reason: 'timeout' };
              if (r.ok) delivered++;
              else failures.push({ platform: p, reason: r.reason, detail: r.detail });
            });
          }));
        }
        nativeTargets.forEach((p) => {
          work.push(FCM.sendViaNativeComposer(site, text).then((r) => {
            if (r.ok) delivered++;
            else failures.push({ platform: p, reason: r.reason });
          }));
        });
        await Promise.all(work);
      } finally {
        sendEl.disabled = false;
        // Always end up back in the box. Clicking Send moves focus to the
        // button, and the native-composer route moves it into the page's own
        // chat box, so without this the next thing typed goes nowhere visible.
        focusInput();
      }

      if (!delivered && !inputEl.value) inputEl.value = text;
      // The reply is finished with once the message has gone out; keep it if
      // nothing was delivered so a retry still goes to the right chat.
      if (delivered) clearReplyTo();

      if (failures.length) {
        const first = failures[0];
        const name = FCM.PLATFORM_META[first.platform].name;
        const describe = SEND_FAILURE_TEXT[first.reason];
        const message = describe ? describe(name) : `Could not send to ${name}.`;
        toast(failures.length > 1 ? `${message} (${failures.length} targets failed)` : message);
        // A failure worth acting on belongs in the feed too, not just a toast
        // that disappears.
        if (['expired', 'rejected', 'dropped'].includes(first.reason)) {
          feed.addSys(`${name}: ${first.detail || message}`);
        }
      }
    }

    root.querySelectorAll('.fcm-actions [data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'collapse') setCollapsed(!collapsed);
        else if (act === 'close') setVisible(false);
        else if (act === 'settings') openSheet();
        else if (act === 'recheck') { onCommand({ cmd: 'recheck' }); toast('Re-checking the other platform…'); }
      });
    });

    launcher.addEventListener('click', () => setVisible(true));
    sendEl.addEventListener('click', doSend);
    inputEl.addEventListener('input', () => {
      // Clearing the box abandons the reply, so the targets go back to normal.
      if (!inputEl.value.trim()) clearReplyTo();
    });
    inputEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // Tab, the arrows, Enter and Escape belong to the suggestion list while it
      // is open, so it gets first refusal on every key.
      if (compose && compose.handleKey(e)) return;
      if (e.key === 'Escape' && replyTo.size) { e.preventDefault(); clearReplyTo(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    inputEl.addEventListener('keyup', (e) => e.stopPropagation());
    // Twitch and Kick both bind single-key shortcuts to the document.
    root.addEventListener('keydown', (e) => e.stopPropagation());

    // ── Public surface ────────────────────────────────────────────────────────

    const api = {
      async mount() {
        settings = await FCM.loadSettings();
        FCM.setViewSettings(settings);
        document.documentElement.appendChild(host);
        await loadGeometry();
        applySettings(settings);
        renderChips();
        renderTargets();
        refreshSendNote();
        compose = FCM.createCompose({
          panel, inputEl, feedEl, emoteBtn, toast,
          onReplyTo: setReplyTo,
          canModerate: (platform) => !!canModerate[platform],
          onModerate: (platform, action, opts) => {
            onCommand({ cmd: 'moderate', id: `m${++sendSeq}`, platform, action, opts });
            const who = opts.username;
            toast(action === 'delete' ? `Deleting that message…`
              : action === 'unban' ? `Lifting the ban on ${who}…`
                : action === 'ban' ? `Banning ${who}…`
                  : `Timing ${who} out…`);
          },
        });
        themeWatcher = FCM.watchSiteTheme(
          () => site.chatContainer(),
          () => { applyTheme(); }
        );
        applyTheme();
        watchPlacement();
        enableDragAndResize();
        setCollapsed(!!settings.startCollapsed);
        setVisible(settings.autoOpen !== false);
        feed.addSys(`[Merged] Watching ${FCM.PLATFORM_META[hostPlatform].name}/${channel}`);
        showEmpty();
        return api;
      },

      destroy() {
        destroyed = true;
        if (compose) compose.closeAll();
        pendingSends.clear();
        clearInterval(placementTimer);
        window.removeEventListener('resize', syncPlacement);
        window.removeEventListener('scroll', syncPlacement, true);
        if (resizeObserver) resizeObserver.disconnect();
        if (themeWatcher) { themeWatcher.stop(); themeWatcher = null; }
        if (endDrag) endDrag();
        if (nativeChatPrev !== null) {
          const body = site.nativeChatBody();
          if (body) body.style.visibility = nativeChatPrev;
          nativeChatPrev = null;
        }
        host.remove();
      },

      sys(text) { feed.addSys(text); },

      event(platform, text) {
        if (!settings.showEvents) return;
        feed.addEvent(platform, text, filter);
      },

      chat(msg) { feed.addMessage(msg, filter); },

      batch(rows) { rows.forEach((row) => feed.addMessage(row, filter)); },

      setStatus(platform, state, chan) {
        status[platform] = { state, channel: chan || null };
        if (state === 'idle') feed.dropPlatform(platform);
        if (chan) filter.add(platform);
        renderChips();
        renderPrompt();
        renderTargets();
        refreshSendNote();
        showEmpty();
      },

      setCounterpart(info, wentLive) {
        counterpart = info;
        renderChips();
        if (info && info.exists && info.live) {
          const other = FCM.PLATFORM_META[otherPlatform].name;
          if (settings.crossPromptMode === 'always' && !status[otherPlatform].channel) {
            feed.addSys(`[Merged] ${info.displayName} is also live on ${other} — connecting automatically`);
            onCommand({ cmd: 'join', platform: otherPlatform, channel: info.channel });
          } else if (wentLive) {
            feed.addSys(`[Merged] ${info.displayName} just went live on ${other}`);
          }
        }
        renderPrompt();
      },

      setEmotes(platform, kind, store) {
        FCM.setEmotes(platform, kind, store);
      },

      // Re-applies settings changed elsewhere (the options page, another tab) to
      // an overlay that is already open.
      applyStoredSettings(next) {
        applySettings(next);
      },

      setModerator(platform, can) {
        canModerate[platform] = !!can;
        if (can) {
          feed.addSys(`[Merged] Moderation tools enabled for ${FCM.PLATFORM_META[platform].name}`);
        }
      },

      // The worker already writes the outcome into the feed; this surfaces a
      // failure as a toast too, so it is not missed in a fast-moving chat.
      modResult(platform, result, text) {
        if (result && result.ok) return;
        toast(text || `${FCM.PLATFORM_META[platform].name}: the action failed`);
      },

      setAccounts(next) {
        accounts = next || accounts;
        // A successful connection retires whatever the last failure was.
        if (authProblem && accounts[authProblem.platform]
          && accounts[authProblem.platform].connected) authProblem = null;
        renderTargets();
        refreshSendNote();
        // The settings sheet shows connection state, so rebuild it if it is open.
        if (sheet) { closeSheet(); openSheet(); }
      },

      authError(platform, info) {
        const name = FCM.PLATFORM_META[platform].name;
        const detail = info && info.message ? info.message : String(info || 'sign-in failed');
        // Held so the settings sheet can show it in full. A toast is no use for
        // something the user has to act on outside the browser.
        authProblem = { platform, ...(info || {}), message: detail };
        feed.addSys(`[Account] ${detail}`);
        toast(`${name} sign-in failed — see Accounts in settings`);
        if (sheet) { closeSheet(); openSheet(); }
        else openSheet();
      },

      sendResult(id, results) {
        const resolve = pendingSends.get(id);
        if (!resolve) return;
        pendingSends.delete(id);
        resolve(results || {});
      },

      setBadges(platform, badges) { FCM.setBadges(platform, badges); },

      deleteMessage(platform, messageId) { feed.markMessageDeleted(platform, messageId); },
      deleteUser(platform, username) { feed.markUserDeleted(platform, username); },

      toast,
      get channel() { return channel; },
      get hostPlatform() { return hostPlatform; },
    };

    function showEmpty() {
      const existing = feedEl.querySelector('.fcm-empty');
      const anyConnected = FCM.PLATFORMS.some((p) => status[p].channel);
      if (anyConnected || feedEl.querySelector('.fcm-msg')) {
        if (existing) existing.remove();
        return;
      }
      if (existing) return;
      const el = document.createElement('div');
      el.className = 'fcm-empty';
      el.innerHTML = '<div class="fcm-empty-icon">◈</div>'
        + `<div>Click a platform above to start watching ${FCM.escapeHtml(channel)}</div>`;
      feedEl.appendChild(el);
    }

    return api;
  };
})(self.FCM);
