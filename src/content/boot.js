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
  // Re-issued after a service-worker restart, which drops every socket.
  const activeJoins = new Map();

  // ── Port ────────────────────────────────────────────────────────────────────

  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: 'fcm' });
    } catch (e) {
      // The extension was reloaded or disabled; stop trying.
      port = null;
      return;
    }

    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      clearInterval(keepaliveTimer);
      // The worker sleeps aggressively; reconnecting revives it and replays the
      // joins that were live before it went away.
      if (currentChannel) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          connectPort();
          if (port) {
            sendHello();
            activeJoins.forEach((chan, platform) => post({ cmd: 'join', platform, channel: chan }));
          }
        }, 1200);
      }
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
      case 'badges': overlay.setBadges(msg.platform, msg.badges); break;
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
  function scheduleHintScans() {
    [1500, 4000, 9000].forEach((delay) => {
      setTimeout(() => {
        if (!currentChannel || !overlay) return;
        const hints = site.hints();
        if (hints.length) post({ cmd: 'hints', hints });
      }, delay);
    });
  }

  // ── Mounting ────────────────────────────────────────────────────────────────

  async function mountFor(channel) {
    overlay = FCM.createOverlay({
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
    await overlay.mount();
  }

  function unmount() {
    if (overlay) { overlay.destroy(); overlay = null; }
    activeJoins.clear();
  }

  async function evaluate() {
    const channel = site.channelFromUrl();

    if (channel === currentChannel) return;

    currentChannel = channel;
    unmount();

    if (!channel) {
      // Left the channel page (directory, settings, a clip). Drop the sockets.
      if (port) post({ cmd: 'hello', site: site.id, channel: '', hints: [] });
      return;
    }

    await mountFor(channel);
    connectPort();
    sendHello();
    scheduleHintScans();
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
