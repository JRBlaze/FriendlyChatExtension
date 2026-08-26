// Entry point for the content script: works out which channel is on screen,
// keeps a port open to the background worker, and mounts/tears down the overlay
// as the user moves around the site.
(function (FCM) {
  'use strict';

  const site = FCM.currentSite();
  if (!site) return;

  // A sign-in window is not a place for a chat overlay. The reserved-path list
  // already covers /login and friends, but the consent step can land on other
  // paths carrying OAuth parameters, and covering that form with a panel would
  // be worse than useless.
  function isAuthFlowPage() {
    const params = `${location.search}${location.hash}`;
    return /[?&#](client_id|redirect_uri|response_type|code_challenge)=/.test(params)
      || /[?&#](code|access_token|error)=/.test(params) && /oauth|authorize|login|signin/i.test(location.pathname)
      || /\/oauth2?\/|\/authorize/i.test(location.pathname);
  }
  if (isAuthFlowPage()) return;

  let overlay = null;
  let currentChannel = null;
  let port = null;
  let keepaliveTimer = null;
  let reconnectTimer = null;
  let hintTimers = [];
  // Bumped on every channel change. Anything still in flight from before the
  // change carries an older epoch and is ignored, which is what stops a
  // previous channel's messages being applied to the new overlay.
  let navEpoch = 0;
  // Re-issued after a service-worker restart, which drops every socket.
  const activeJoins = new Map();

  // ── Port ────────────────────────────────────────────────────────────────────

  // Closes the current port so nothing more arrives on it. Leaving an old port
  // open was what let a previous channel's messages reach the new overlay.
  function disconnectPort() {
    clearInterval(keepaliveTimer);
    clearTimeout(reconnectTimer);
    if (!port) return;
    try { port.disconnect(); } catch (e) { /* already gone */ }
    port = null;
  }

  function connectPort() {
    disconnectPort();

    let myPort;
    try {
      myPort = chrome.runtime.connect({ name: 'fcm' });
    } catch (e) {
      // The extension was reloaded or disabled; stop trying.
      port = null;
      return;
    }
    port = myPort;
    const epoch = navEpoch;

    // Both handlers check they are still the live port. A listener cannot be
    // removed once its port is gone, so they have to bow out on their own.
    myPort.onMessage.addListener((msg) => {
      if (port !== myPort || epoch !== navEpoch) return;
      handleMessage(msg);
    });

    myPort.onDisconnect.addListener(() => {
      if (port !== myPort || epoch !== navEpoch) return;
      port = null;
      clearInterval(keepaliveTimer);
      // The worker sleeps aggressively; reconnecting revives it and replays the
      // joins that were live before it went away.
      if (!currentChannel) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (epoch !== navEpoch) return;
        connectPort();
        if (!port) return;
        sendHello();
        // Only replay joins for the channel actually on screen.
        activeJoins.forEach((chan, platform) => {
          post({ cmd: 'join', platform, channel: chan });
        });
      }, 1200);
    });

    clearInterval(keepaliveTimer);
    // A message over the port resets the worker's idle timer, which is what
    // stops a quiet channel from having its sockets collected.
    keepaliveTimer = setInterval(() => post({ cmd: 'ping' }), 20000);
  }

  function post(msg) {
    if (!port) connectPort();
    if (!port) return;
    try {
      port.postMessage(msg);
    } catch (e) {
      port = null;
    }
  }

  function handleMessage(msg) {
    if (!msg || !msg.type) return;
    if (!overlay) return;

    switch (msg.type) {
      case 'sys': overlay.sys(msg.text); break;
      case 'event': overlay.event(msg.platform, msg.text); break;
      case 'chat': overlay.chat(msg.msg); break;
      case 'batch': overlay.batch(msg.rows || []); break;
      case 'emotes': overlay.setEmotes(msg.platform, msg.kind, msg.store); break;
      case 'needKickEmotes': fetchKickEmotesFromPage(msg.channel); break;
      case 'badges': overlay.setBadges(msg.platform, msg.badges); break;
      case 'cheermotes': overlay.setCheermotes(msg.prefixes); break;
      case 'profile': overlay.profileResult(msg.id, msg.platform, msg.username, msg.profile); break;
      case 'deleteMsg': overlay.deleteMessage(msg.platform, msg.messageId); break;
      case 'deleteUser': overlay.deleteUser(msg.platform, msg.username); break;

      case 'status':
        if (msg.channel) activeJoins.set(msg.platform, msg.channel);
        else if (msg.state === 'idle') activeJoins.delete(msg.platform);
        overlay.setStatus(msg.platform, msg.state, msg.channel);
        break;

      case 'counterpart':
        overlay.setCounterpart(msg.counterpart, msg.wentLive);
        break;

      case 'auth':
        overlay.setAccounts(msg.accounts);
        break;

      case 'moderator':
        overlay.setModerator(msg.platform, msg.canModerate);
        break;

      case 'modResult':
        overlay.modResult(msg.platform, msg.result, msg.text);
        break;

      case 'authError':
        overlay.authError(msg.platform, msg);
        break;

      case 'sendResult':
        overlay.sendResult(msg.id, msg.results);
        break;

      case 'ready':
        onReady(msg);
        break;

      default:
        break;
    }
  }

  async function onReady(msg) {
    const settings = await FCM.loadSettings();
    // Re-attach to anything the worker still has open for this tab.
    FCM.PLATFORMS.forEach((platform) => {
      const conn = (msg.connections || {})[platform];
      if (conn && conn.channel) {
        activeJoins.set(platform, conn.channel);
        overlay.setStatus(platform, conn.state, conn.channel);
        if (conn.canModerate) overlay.setModerator(platform, true);
      }
    });
    if (settings.autoConnectHost && !activeJoins.get(site.id)) {
      post({ cmd: 'join', platform: site.id, channel: currentChannel });
    }
    // Which accounts are connected decides what the send targets can do.
    post({ cmd: 'authStatus' });
  }

  // ── Hints ───────────────────────────────────────────────────────────────────

  function sendHello() {
    post({ cmd: 'hello', site: site.id, channel: currentChannel, hints: site.hints() });
  }

  // The about/social panels render well after the chat does, so the page is
  // re-scanned a few times before giving up on finding a link to the other
  // platform.
  function cancelHintScans() {
    hintTimers.forEach((t) => clearTimeout(t));
    hintTimers = [];
  }

  function scheduleHintScans(epoch) {
    cancelHintScans();
    hintTimers = [1500, 4000, 9000].map((delay) => setTimeout(() => {
      // A scan scheduled for the previous channel would otherwise report that
      // channel's links against this one.
      if (epoch !== navEpoch || !currentChannel || !overlay) return;
      const hints = site.hints();
      if (hints.length) post({ cmd: 'hints', hints });
    }, delay));
  }

  /**
   * Fetches Kick's emote list from the page itself.
   *
   * Kick sits behind Cloudflare, which can refuse a request that did not come
   * from a browser tab — and the background worker is not one. This tab is, so
   * when the worker comes back empty-handed it asks here instead. Only when the
   * tab is actually on Kick: from anywhere else this would be a cross-origin
   * request, and a content script does not carry the extension's permission to
   * make one.
   */
  async function fetchKickEmotesFromPage(channel) {
    if (site.id !== 'kick' || !overlay) return;
    const slug = FCM.normalizeChannel(channel || '');
    if (!slug) return;
    try {
      const res = await fetch(`https://kick.com/emotes/${encodeURIComponent(slug)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const store = FCM.parseKickEmotePayload(await res.json(), slug);
      const count = Object.keys(store).length;
      if (!count || !overlay) return;
      overlay.setEmotes('kick', 'native', store);
      overlay.sys(`Loaded ${count} Kick emotes for this channel`);
    } catch (e) { /* the picker simply has fewer emotes in it */ }
  }

  // ── Mounting ────────────────────────────────────────────────────────────────

  /**
   * Builds and mounts the overlay for a channel, and returns the one it built.
   *
   * Returning it matters. Mounting is asynchronous — it reads settings and
   * geometry out of chrome.storage — and a second navigation lands inside that
   * window often enough to matter. When this call resumes, the module's
   * `overlay` may already belong to that newer navigation, so the caller has to
   * be able to tear down its own rather than whatever is current.
   */
  async function mountFor(channel) {
    const mine = FCM.createOverlay({
      site,
      channel,
      onCommand: (command) => {
        if (command.cmd === 'join') {
          activeJoins.set(command.platform, FCM.normalizeChannel(command.channel));
        } else if (command.cmd === 'leave') {
          activeJoins.delete(command.platform);
        }
        post(command);
      },
    });
    overlay = mine;
    await mine.mount();
    return mine;
  }

  function unmount() {
    if (overlay) { overlay.destroy(); overlay = null; }
    activeJoins.clear();
    // The render module is loaded once for the page and outlives every overlay
    // built on it, so what it holds for this channel — emote sets, the channel's
    // badges, who has spoken — has to be dropped here or it follows us to the
    // next one and is offered there as if it belonged.
    FCM.resetChannelView();
  }

  async function evaluate() {
    const channel = site.channelFromUrl();
    if (channel === currentChannel) return;

    const epoch = ++navEpoch;
    currentChannel = channel;

    // Order matters. The port is closed first so nothing from the channel being
    // left can arrive while the new one is being set up — that was what made
    // the overlay flip back to the previous channel.
    cancelHintScans();
    if (!channel) {
      // Left the channel page (directory, settings, a clip). Tell the worker to
      // drop its sockets before closing the port.
      if (port) post({ cmd: 'hello', site: site.id, channel: '', hints: [] });
      disconnectPort();
      unmount();
      return;
    }
    disconnectPort();
    unmount();

    const mounted = await mountFor(channel);
    // A faster navigation may have overtaken this one while the overlay was
    // being built; if so, that one owns the page now. Only this call's own
    // overlay may be torn down here — clearing whichever one the module happens
    // to hold would take the newer navigation's panel down with it and leave
    // the page with no overlay at all.
    if (epoch !== navEpoch) {
      mounted.destroy();
      if (overlay === mounted) overlay = null;
      return;
    }

    connectPort();
    sendHello();
    scheduleHintScans(epoch);
  }

  // Twitch and Kick are both single-page apps, and neither fires an event the
  // isolated world can see on an in-app navigation, so the URL is polled.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    evaluate();
  }, 600);
  window.addEventListener('popstate', evaluate);

  // Settings changed in the options page or another tab have to reach an overlay
  // that is already open, not just the next one to be created.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[FCM.STORAGE_KEYS.settings]) return;
    if (!overlay) return;
    FCM.loadSettings().then((settings) => {
      overlay.applyStoredSettings(settings);
      overlay.toast('Settings updated');
    });
  });

  evaluate();
})(self.FCM);
