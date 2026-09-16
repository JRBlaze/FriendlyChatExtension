(function (FCM) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function stateLabel(conn) {
    if (!conn || !conn.channel) return 'not connected';
    if (conn.state === 'connected') return conn.channel;
    return `${conn.channel} (${conn.state})`;
  }

  // ── Site access (Firefox) ───────────────────────────────────────────────────
  //
  // Firefox can be keeping the add-on off any of the sites it asks for — taken
  // back in about:addons, or never granted because an update added it — and
  // says nothing about it. Asking for them back needs a click on one of the
  // add-on's own pages, and this is one of the two (the options page is the
  // other). The popup checks each time it opens, which is the only time it
  // exists, so an answer it never saw costs nothing but the next open.

  const ALL_ALLOWED = { origins: [], missing: [], sitesMissing: [] };
  // The latest check, as a promise, so the status line can wait on it.
  let access = Promise.resolve(ALL_ALLOWED);
  // What Allow access asks for: the latest check's answer, kept, because the
  // click that asks cannot wait for a fresh one (see where it is wired up).
  let missingAccess = [];

  function checkAccess() {
    access = FCM.hostAccess().catch(() => ALL_ALLOWED);
    return access.then(renderAccess);
  }

  function renderAccess(found) {
    missingAccess = found.missing;
    const card = $('access');
    if (!found.missing.length) { card.classList.add('hidden'); return; }
    const names = [...new Set(found.missing.map(FCM.originLabel))].join(', ');
    const effect = found.sitesMissing.length
      ? 'The overlay cannot appear on a site it is not allowed on.'
      : 'Emotes, history or sign-in that depend on them will be missing.';
    $('access-note').textContent = `Firefox is not letting Friendly Chat use: ${names}. ${effect}`;
    card.classList.remove('hidden');
  }

  async function renderStatus() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    let host = '';
    try { host = new URL(tab.url || '').hostname; } catch (e) { host = ''; }
    const onSupportedSite = /(^|\.)twitch\.tv$/.test(host) || /(^|\.)kick\.com$/.test(host);

    if (!onSupportedSite) {
      // Firefox leaves a tab's address out when the add-on is not allowed on
      // its site, so a Twitch page it is being kept off looks exactly like a
      // page that is not Twitch at all. With a site missing, then, "not a Twitch
      // or Kick page" may well be untrue, and so may the line promising an
      // overlay on the next channel opened: the card says what is known instead.
      if (FCM.BROWSER === 'firefox') {
        const { sitesMissing } = await access;
        $('idle').classList.toggle('hidden', sitesMissing.length > 0);
        if (sitesMissing.length) {
          $('context').textContent = 'Site access needed';
          return;
        }
      }
      $('context').textContent = 'Not a Twitch or Kick page';
      return;
    }

    const info = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ cmd: 'status', tabId: tab.id }, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    });

    if (!info || !info.channel) {
      $('context').textContent = `${host} — no channel open`;
      return;
    }

    $('idle').classList.add('hidden');
    $('status').classList.remove('hidden');
    $('context').textContent = `${FCM.PLATFORM_META[info.site].name} channel page`;
    $('host-channel').textContent = `${FCM.PLATFORM_META[info.site].name}/${info.channel}`;

    FCM.PLATFORMS.forEach((platform) => {
      const conn = (info.connections || {})[platform];
      const el = $(`state-${platform}`);
      el.textContent = stateLabel(conn);
      el.dataset.state = conn && conn.channel ? conn.state : '';
    });

    const cp = info.counterpart;
    const cpEl = $('counterpart');
    if (!cp || !cp.exists) {
      cpEl.textContent = 'no match found';
      cpEl.dataset.live = 'false';
    } else {
      const other = FCM.PLATFORM_META[cp.platform].name;
      cpEl.textContent = `${other}/${cp.channel} — ${cp.live ? 'LIVE' : 'offline'}`;
      cpEl.dataset.live = String(!!cp.live);
      cpEl.title = cp.match ? `Matched by: ${cp.match}` : '';
    }
  }

  async function bindSettings() {
    const settings = await FCM.loadSettings();
    ['autoOpen', 'autoConnectHost'].forEach((key) => {
      const el = $(key);
      el.checked = !!settings[key];
      el.addEventListener('change', () => FCM.saveSettings({ [key]: el.checked }));
    });
    const mode = $('crossPromptMode');
    mode.value = settings.crossPromptMode;
    mode.addEventListener('change', () => FCM.saveSettings({ crossPromptMode: mode.value }));
  }

  // ── Releases ────────────────────────────────────────────────────────────────
  //
  // The extension cannot install its own update — nothing can, outside the Web
  // Store — so what this does is remove every step it can from the ones that
  // are left: the file, the page to drop it on, and the reason to bother.
  //
  // Except where the browser installs it. A Firefox build that names an
  // update_url is kept up to date by Firefox itself (FCM.updatedByBrowser), and
  // the background makes no check of its own there, so the popup offers none
  // and asks nothing about one: a card offering the file would be offering to
  // do by hand what Firefox is already doing. The footer says so instead, where
  // "Check for updates" would be.
  const updatedByBrowser = FCM.updatedByBrowser();
  // The version this install actually is, which the footer shows and the
  // release-notes link points at.
  let installed = '';
  try {
    installed = String(chrome.runtime.getManifest().version || '');
  } catch (e) { /* not an extension page */ }

  function ask(cmd, extra) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ cmd, ...(extra || {}) }, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    });
  }

  function openTab(url) {
    if (!url) return;
    // chrome://extensions is a page Chrome is entitled to refuse, and a refusal
    // here throws. Nothing else in the popup should go down with it.
    //
    // A refusal can also arrive later, as a rejected promise, which is how
    // Firefox gives one. So the popup waits for the tab to be there before it
    // closes: closed straight away, a refused tab looked like a button that
    // had worked, when all that had happened was the popup going away.
    try {
      // Closed at all because Chrome keeps the popup open over the new tab
      // otherwise, which reads as nothing having happened.
      Promise.resolve(chrome.tabs.create({ url })).then(() => window.close(), () => {});
    } catch (e) { /* refused on the spot */ }
  }

  function renderUpdate(status) {
    const card = $('update');
    if (!status || !status.available) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    $('update-title').textContent = `Version ${status.version} is available`;
    $('update-note').textContent = status.notes
      ? `${status.notes} — you are on ${status.installed}.`
      : `You are on ${status.installed}.`;
    // The asset itself when the release has one, and the release page when it
    // does not: a page with the file on it still beats no link at all. What
    // the asset is depends on the browser — Chrome's is a zip to unpack,
    // Firefox's a signed add-on to open — so the button says which.
    $('update-get').textContent = status.downloadUrl
      ? (FCM.BROWSER === 'firefox' ? 'Download the add-on' : 'Download the zip')
      : 'Open the release';
    $('update-get').onclick = () => openTab(
      FCM.releasePageUrl(status.downloadUrl || status.url, status.version)
    );
    // What changed in the release being offered — which the card could not say
    // before, its note being the release's title and its button a file to
    // download. The footer's version says the same about the version running,
    // which is the other question and is asked from the other place.
    const notes = FCM.releasePageUrl(status.url, status.version);
    // A release with no file for this browser is already offered as its page by
    // the button above, and two controls opening the same page is one of them
    // saying nothing. The strip does the same.
    $('update-whats-new').hidden = !status.downloadUrl;
    // A real href, not only a handler: a middle-click or a ctrl-click opens
    // what the anchor says, and "#" is nowhere.
    $('update-whats-new').href = notes;
    $('update-whats-new').onclick = (ev) => {
      ev.preventDefault();
      openTab(notes);
    };
    $('update-dismiss').onclick = async () => {
      await ask('updateDismiss', { version: status.version });
      card.classList.add('hidden');
    };
  }

  // The second button opens the page an unpacked update is dropped onto, and
  // the note under both says how. Neither applies to Firefox, where there is no
  // folder to drop: the signed add-on the first button fetches installs over
  // this one when it is opened. So on Firefox the button goes, and the note
  // gives the one step there is instead.
  if (FCM.BROWSER === 'firefox') {
    $('update-install').classList.add('hidden');
    $('update-how').textContent = 'Open the downloaded file in Firefox to install the update over this one.';
  } else {
    $('update-install').addEventListener('click', () => openTab('chrome://extensions'));
  }

  // Whether this is an add-on loaded from about:debugging, which Firefox calls a
  // "development" install and removes at the next restart. management.getSelf
  // needs no permission. Anything that cannot say counts as an ordinary
  // install, which is what every build was taken to be before.
  function loadedTemporarily() {
    try {
      if (!chrome.management || typeof chrome.management.getSelf !== 'function') return Promise.resolve(false);
      return Promise.resolve(chrome.management.getSelf())
        .then((self) => Boolean(self && self.installType === 'development'), () => false);
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  if (updatedByBrowser) {
    $('check-updates').classList.add('hidden');
    // Firefox keeps a signed install up to date, but not an add-on loaded
    // temporarily, which names the same update_url all the same: the unsigned
    // package and a development folder are the very files Mozilla signs. So the
    // line waits until it is known which this is, and says so.
    loadedTemporarily().then((temporary) => {
      const line = $('updated-by-browser');
      line.textContent = `Kept up to date by ${FCM.updatingBrowserName()}`;
      if (temporary) line.textContent = 'Loaded temporarily, so Firefox does not update it';
      line.classList.remove('hidden');
      // A signed install came from a release, so the page for its version is
      // there to open. One loaded from about:debugging did not — it is whatever
      // was built locally, and nothing is published under that name — so it goes
      // to the releases page rather than to a tag that is not there. Nothing
      // here checks, so this is the only thing that can tell the two apart.
      if (temporary) setVersionUrl(FCM.GITHUB_RELEASES_URL);
    });
  } else {
    $('check-updates').addEventListener('click', async (e) => {
      e.preventDefault();
      const link = $('check-updates');
      link.textContent = 'Checking…';
      const status = await ask('updateCheck');
      renderUpdate(status);
      // A check is the first thing that can know the running version was never
      // published — it is the only thing that learns what the newest release
      // is. Pressing this is also the likeliest way to find out, so the answer
      // has to reach the version below as well as the card above.
      setVersionLink(status);
      // `checked === false` is a check that could not be made, which is a
      // different thing from one that found nothing new. The plain read below
      // carries no `checked` at all, so it keeps saying what it always did.
      link.textContent = status && status.available
        ? 'Update ready'
        : (status && status.checked !== false ? 'Up to date' : 'Could not check');
    });
  }

  $('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // The version is also the way to what changed in it, which is the only route
  // to the notes on a build the browser updates by itself: there the card above
  // never appears, because there is never anything to go and fetch — the update
  // simply arrives, and the first anyone knows of it is that something has
  // moved. Its own tag, until the background says otherwise; see below.
  $('version').textContent = `v${installed}`;
  let versionUrl = FCM.releaseNotesUrl(installed);
  $('version').href = versionUrl;
  $('version').addEventListener('click', (e) => {
    e.preventDefault();
    openTab(versionUrl);
  });

  function setVersionUrl(url) {
    versionUrl = url;
    $('version').href = url;
  }

  /**
   * Points the version somewhere else when its own tag would be a 404.
   *
   * A version newer than anything GitHub has published was built here rather
   * than installed from a release, so nothing is published under that name.
   * Only a build that checks can know that, since knowing it means knowing what
   * the newest release is — so the answer is worked out where the check is and
   * handed over here. A build the browser updates by itself never asks, and
   * says which it is a different way; see above.
   */
  function setVersionLink(status) {
    if (!status || !status.installedUrl) return;
    setVersionUrl(status.installedUrl);
  }

  if (FCM.BROWSER === 'firefox') {
    // Firefox asks the person before it grants anything, and only for a request
    // made while a click on one of the add-on's own pages is still being
    // handled. An `await` in front of the request would let the click finish
    // first, and Firefox would then refuse without asking anyone. So the
    // request is the very first thing the handler does, for what the last check
    // found, and everything else waits for the answer — yes, no or refused.
    $('access-allow').addEventListener('click', () => {
      chrome.permissions.request({ origins: missingAccess }).then(answeredFor(missingAccess), recheckAccess);
    });
  }

  function recheckAccess() {
    checkAccess().then(renderStatus).catch(() => {});
  }

  // What to do with Firefox's answer to a request for `asked`: check again, as
  // after any answer, and after a yes that took in Twitch or Kick, say that
  // tabs already open there need reloading. Firefox does not put the content
  // script into a page that was loaded before the site was allowed, so the tab
  // the viewer came from stays without a panel until it is loaded again — and
  // told nothing, that reads as Allow access having done nothing. A yes for
  // services alone changes nothing about where the panel appears, so it says
  // nothing about tabs.
  function answeredFor(asked) {
    return (granted) => {
      if (granted === true && asked.some((origin) => FCM.SITE_ORIGINS.includes(origin))) {
        $('access-reload').classList.remove('hidden');
      }
      recheckAccess();
    };
  }

  bindSettings();
  // Before the status, which waits on it to know whether "Not a Twitch or Kick
  // page" is true.
  if (FCM.BROWSER === 'firefox') checkAccess();
  renderStatus();
  // From what the last background check stored, so the banner is there the
  // moment the popup opens rather than a beat later. Not on a build Firefox
  // updates by itself, where no check has stored anything.
  if (!updatedByBrowser) {
    ask('updateStatus').then((status) => { renderUpdate(status); setVersionLink(status); });
  }
})(self.FCM);
