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
  let watchTimers = [];
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
        announceSession();
      }, 1200);
    });

    clearInterval(keepaliveTimer);
    // A message over the port resets the worker's idle timer, which is what
    // stops a quiet channel from having its sockets collected.
    keepaliveTimer = setInterval(() => post({ cmd: 'ping' }), 20000);
  }

  // True while the session is being re-announced, so a failed send inside it
  // cannot start a second one on top.
  let announcing = false;

  /**
   * Tells a worker that has never heard of this tab everything it needs.
   *
   * Which channel is on screen, and which chats were joined. Anything that
   * opens a fresh port has to do this, because the worker keeps its session
   * against the port and a new one starts empty.
   */
  function announceSession() {
    if (!port || announcing || !currentChannel) return;
    announcing = true;
    try {
      sendHello();
      // Only replay joins for the channel actually on screen.
      activeJoins.forEach((chan, platform) => {
        post({ cmd: 'join', platform, channel: chan });
      });
    } finally {
      announcing = false;
    }
  }

  function post(msg) {
    if (!port) {
      const epoch = navEpoch;
      connectPort();
      // Opening a port is not rejoining. The worker on the other end of this
      // one has never heard of this tab, and connectPort() has just cancelled
      // the reconnect that would have told it — so sending only the message
      // that prompted this left the overlay showing a connection that no longer
      // existed: chips still reading "connected", no chat ever arriving again,
      // and nothing but a reload to get it back. Pressing Send or closing a
      // chip in the second after the worker was evicted was enough.
      if (port && epoch === navEpoch) announceSession();
    }
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
      case 'event': overlay.event(msg.platform, msg.text, msg.meta); break;
      case 'chat': overlay.chat(msg.msg); break;
      case 'batch': overlay.batch(msg.rows || []); break;
      case 'emotes': overlay.setEmotes(msg.platform, msg.kind, msg.store); break;
      case 'needKickEmotes': fetchKickEmotesFromPage(msg.channel); break;
      case 'needKickModerator': reportKickStandingFromPage(msg.channel); break;
      case 'badges': overlay.setBadges(msg.platform, msg.badges); break;
      case 'cheermotes': overlay.setCheermotes(msg.prefixes, msg.tiers); break;
      case 'profile': overlay.profileResult(msg.id, msg.platform, msg.username, msg.profile); break;
      case 'clip': overlay.clipResult(msg.id, msg.clip); break;
      case 'update': overlay.updateNotice(msg.status); break;
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

      case 'subscription':
        overlay.setSubscription(msg.platform, msg.subscription);
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
    const epoch = navEpoch;
    const settings = await FCM.loadSettings();
    // Reading the settings is a real wait, and a channel switch inside it takes
    // the overlay away — so this used to throw on a null overlay and abandon
    // the rest of the handler, leaving the new channel unjoined.
    if (epoch !== navEpoch || !overlay) return;
    // Re-attach to anything the worker still has open for this tab.
    FCM.PLATFORMS.forEach((platform) => {
      const conn = (msg.connections || {})[platform];
      if (conn && conn.channel) {
        activeJoins.set(platform, conn.channel);
        overlay.setStatus(platform, conn.state, conn.channel);
        if (conn.canModerate) overlay.setModerator(platform, true);
        if (conn.subscription) overlay.setSubscription(platform, conn.subscription);
      }
    });
    if (settings.autoConnectHost && !activeJoins.get(site.id)) {
      post({ cmd: 'join', platform: site.id, channel: currentChannel });
    }
    // Which accounts are connected decides what the send targets can do.
    post({ cmd: 'authStatus' });
  }

  // ── Hints ───────────────────────────────────────────────────────────────────

  /**
   * Tells the worker which channel is on screen.
   *
   * Deliberately carries no hints. This runs the moment the address changes,
   * and on a single-page app the address changes before the page it names has
   * been drawn — so anything scraped here is the channel we just left. On Kick
   * that meant arriving at one streamer and being offered the last one's Twitch
   * chat, which was then written down as this channel's counterpart.
   *
   * The scans scheduled after this send them once the new page exists, which is
   * the only moment they mean anything.
   */
  function sendHello() {
    post({ cmd: 'hello', site: site.id, channel: currentChannel, hints: [] });
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

  // ── The profile the streamer never asked for ────────────────────────────────

  // How long after arriving the page is worth re-asking. The button is drawn
  // once Kick's own data lands, which on a cold load is well after the address
  // changed, and the last of these is late enough to cover a slow one.
  const WATCH_SCAN_DELAYS = [700, 1600, 3200, 6000, 10000];

  function cancelWatchScans() {
    watchTimers.forEach((t) => clearTimeout(t));
    watchTimers = [];
  }

  /**
   * Presses Kick's "Watch now" when it has opened a channel's profile over a
   * stream that is running — which is what Kick does to the streamer on their
   * own channel, live or not.
   *
   * Pressed once and then never again for this arrival, which is the whole of
   * the restraint here. The site adapter will not offer the button unless the
   * address is the channel itself and the profile is the thing on screen, so
   * this cannot fire on a page someone chose; and stopping at the first press
   * means someone who goes back to the profile of their own accord is left
   * there rather than dragged forward again.
   *
   * A press that changes nothing — because Kick rewired the button — also
   * stops, for the same reason. Trying once and leaving it is better than a
   * page that fights whoever is using it.
   */
  function scheduleWatchScans(epoch) {
    cancelWatchScans();
    watchTimers = WATCH_SCAN_DELAYS.map((delay) => setTimeout(async () => {
      if (epoch !== navEpoch || !currentChannel) return;
      const button = site.watchNow();
      // Asked before the settings are, because it is the cheap half and it is
      // almost always no: on Twitch there is never a button, and on Kick there
      // is one only for the streamer's own live channel. Reading the settings
      // first would have meant a storage round-trip on every arrival anywhere
      // to answer a question that had already been settled by the page.
      if (!button) return;
      // Nothing else may fire now, whatever the setting turns out to be: this
      // is the one press this arrival gets.
      cancelWatchScans();
      const settings = await FCM.loadSettings();
      // A navigation can land inside that read.
      if (epoch !== navEpoch || settings.watchWhenLive === false) return;
      try {
        button.click();
      } catch (e) { /* the page moved on; the profile is still usable */ }
      if (overlay) overlay.sys('Kick opened this channel’s profile — switched to the stream');
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
  /**
   * Asks Kick whether this viewer moderates the channel, from the page's own
   * origin — the only place Kick will answer it.
   *
   * The worker cannot: this endpoint does not read the OAuth token the
   * extension holds, and Chrome withholds a SameSite cookie from an
   * extension's cross-site request. A fetch from here is same-origin and
   * carries what the viewer is actually signed in with.
   *
   * Being same-origin is necessary but not sufficient. Kick answers `/me` to a
   * bearer token, not to the cookie jar: sending the session cookie alone —
   * which is all a plain same-origin fetch does — is answered
   * "Unauthenticated." with a 401, and that 401 is exactly why an ordinary
   * moderator still saw no tools after the page was the one asking. Kick's own
   * site reads its `session_token` cookie and puts it in an Authorization
   * header, so that is what happens here. The cookie is not HttpOnly, which is
   * what makes it readable at all, and it goes nowhere but back to kick.com.
   *
   * Nothing is posted back unless Kick actually answered. Not signed in, a
   * challenge page, or a body that is not JSON all leave the worker exactly
   * where it was rather than claiming the viewer moderates nothing.
   */
  async function reportKickStandingFromPage(channel) {
    if (site.id !== 'kick') return;
    const slug = FCM.normalizeChannel(channel || '');
    if (!slug) return;
    const epoch = navEpoch;
    const headers = { Accept: 'application/json' };
    const token = readCookie('session_token');
    if (token) headers.Authorization = `Bearer ${token}`;
    let standing = null;
    try {
      const res = await fetch(
        `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/me`,
        { headers, credentials: 'include' }
      );
      if (!res.ok) return;
      standing = FCM.readKickStanding(await res.json());
    } catch (e) {
      return;
    }
    // The channel can change inside that fetch, and this answer is about the
    // one it was asked for.
    if (!standing || !standing.known || epoch !== navEpoch) return;
    // `/me` describes a standing without ever naming whose it is, and the
    // worker wants the name: it declines to offer tools when this browser is
    // signed in as one person and the extension holds a token for another,
    // because the moderation calls would go out as the other one and be
    // refused. Asked only when there is something to compare, and a failure
    // here just leaves the name unknown — which is where it was before.
    let username = standing.username;
    if (!username && standing.canModerate && token) {
      username = await readKickAccountName(headers);
      if (epoch !== navEpoch) return;
    }
    post({
      cmd: 'kickModerator',
      channel: slug,
      canModerate: standing.canModerate,
      username,
    });
  }

  /** The account kick.com is signed in as in this browser, or '' if unknown. */
  async function readKickAccountName(headers) {
    try {
      const res = await fetch('https://kick.com/api/v1/user', { headers, credentials: 'include' });
      if (!res.ok) return '';
      return String(FCM.usernameFrom(await res.json()) || '');
    } catch (e) {
      return '';
    }
  }

  /** One cookie of this page's, decoded. '' when the page has no such cookie. */
  function readCookie(name) {
    // Split rather than matched: a name is being compared, not searched for,
    // and a regex built from one would have to escape it.
    const pairs = String(document.cookie || '').split(';');
    for (let i = 0; i < pairs.length; i += 1) {
      const at = pairs[i].indexOf('=');
      if (at < 0) continue;
      if (pairs[i].slice(0, at).trim() !== name) continue;
      const raw = pairs[i].slice(at + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch (e) {
        // A cookie that is not percent-encoded is still a cookie.
        return raw;
      }
    }
    return '';
  }

  async function fetchKickEmotesFromPage(channel) {
    if (site.id !== 'kick' || !overlay) return;
    const slug = FCM.normalizeChannel(channel || '');
    if (!slug) return;
    const epoch = navEpoch;
    try {
      const res = await fetch(`https://kick.com/emotes/${encodeURIComponent(slug)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const store = FCM.parseKickEmotePayload(await res.json(), slug);
      const count = Object.keys(store).length;
      // The fetch is a real wait and a channel change lands inside it often
      // enough to matter, so this is one channel's emote list and it must not
      // be poured into the next channel's picker.
      if (!count || !overlay || epoch !== navEpoch) return;
      overlay.setEmotes('kick', 'native', store);
      overlay.sys(`Loaded ${count} Kick emotes for this channel`);
      // Sent back to be remembered. The worker only asks the page for this list
      // when Kick's edge refused it — so the channels this path exists for were
      // exactly the ones that were never cached, and every visit to one of them
      // started with an empty picker and emote names rendering as plain text
      // until the page fetched it again.
      post({ cmd: 'cacheKickEmotes', channel: slug, store });
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
    cancelWatchScans();
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
    scheduleWatchScans(epoch);
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
  //
  // Either area, not just sync. A save is written to both and is allowed to
  // succeed on one — which is the whole point of writing both — so a browser
  // that is not signed in, or has extension sync switched off, or has spent its
  // sync write quota, stores the change locally and told nobody. Every tab in
  // this browser reads the same local area, so that is the copy that actually
  // has to be followed.
  //
  // Both landing means the same change arrives twice, so it is recognised by
  // the stamp the save wrote rather than acted on again.
  let lastSettingsStamp = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    const change = changes[FCM.STORAGE_KEYS.settings];
    if (!change || !overlay) return;
    const stamp = (change.newValue && change.newValue.savedAt) || 0;
    if (stamp && stamp === lastSettingsStamp) return;
    lastSettingsStamp = stamp;
    FCM.loadSettings().then((settings) => {
      overlay.applyStoredSettings(settings);
      overlay.toast('Settings updated');
    });
  });

  evaluate();
})(self.FCM);
