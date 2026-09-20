// Noticing that a newer release has been published, in the builds the browser
// does not keep up to date by itself.
//
// Neither browser looks for an update to a build installed the way these are.
// Chrome's is loaded from a zip rather than from the Chrome Web Store, so
// Chrome never checks for one and never will; a Firefox package built without
// an update_url gives Firefox nowhere to ask. Nothing here can install an
// update either — an extension cannot replace itself, and no amount of
// permissions changes that. What it can do is stop the update being something
// you only find out about by going and looking: the releases page is checked
// in the background, the toolbar icon gets a badge when there is something
// newer, and the popup turns that into the few clicks it actually takes — the
// zip and the extensions page in Chrome, the signed .xpi in Firefox.
//
// A signed Firefox release is the other way round. Its manifest names an
// update_url (tools/pack.js, UPDATE_URL); Firefox asks that address for newer
// versions on its own and installs them, and everything above would only
// repeat it — a second check, spent from GitHub's hourly allowance for the
// whole address, announcing an update already on its way, and a download
// button offering to install by hand what arrives without one. So wherever the
// running manifest names an update_url (FCM.updatedByBrowser) none of it runs:
// no alarm, no request to GitHub, no dot, nothing reported as available, and
// the popup says Firefox keeps the add-on up to date instead. A Firefox package
// built without an update_url gets no updates from Firefox at all, so it is
// told about releases the way Chrome is, and pointed at the signed .xpi.
(function (FCM) {
  'use strict';
  // Register synchronously so an update event can wake either background type.
  // The browser has already downloaded the package; this only activates it.
  // GitHub notices for unpacked installs never call reload or install anything.
  if (typeof chrome !== 'undefined' && chrome.runtime?.onUpdateAvailable
      && typeof chrome.runtime.reload === 'function') {
    chrome.runtime.onUpdateAvailable.addListener(function activateUpdate() {
      chrome.runtime.reload();
    });
  }

  // The repo itself is named in constants.js, which every context loads; only
  // the API address is needed here, and only the background ever asks it.
  const LATEST_API = `https://api.github.com/repos/${FCM.GITHUB_REPO}/releases/latest`;

  // Once every six hours. A release is not an event anybody needs told about
  // within the minute, and GitHub rate-limits unauthenticated callers by IP —
  // which, behind a shared address, is an IP this extension does not have to
  // itself.
  const CHECK_INTERVAL_MINUTES = 6 * 60;
  const ALARM = 'fcm-update-check';
  // How long a failed check waits before the next one is allowed. Without it a
  // background that restarts often — which is normal: Chrome's service worker
  // and Firefox's event page are both put away constantly — would re-ask on
  // every wake.
  const RETRY_AFTER_MS = 30 * 60 * 1000;

  /**
   * Compares two dotted version strings.
   *
   * Written out rather than done with localeCompare's numeric collation,
   * because "1.10.4" against "1.9.0" is exactly the comparison that gets this
   * wrong when it is done as text: 1.9 sorts after 1.10 and the update is never
   * offered.
   *
   * @returns {number} > 0 when `a` is newer than `b`
   */
  FCM.compareVersions = function (a, b) {
    const parse = (value) => String(value || '')
      .trim()
      .replace(/^v/i, '')
      // A pre-release suffix is not part of the ordering here: this only has to
      // answer "is there something newer", and "1.11.0-beta.1" is 1.11.0 for
      // that purpose.
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => parseInt(part, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
    const left = parse(a);
    const right = parse(b);
    const len = Math.max(left.length, right.length);
    for (let i = 0; i < len; i++) {
      const diff = (left[i] || 0) - (right[i] || 0);
      if (diff) return diff;
    }
    return 0;
  };

  function installedVersion() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '0.0.0'; }
  }

  /**
   * The file a release carries for this browser, by the exact name it is
   * published under.
   *
   * Chrome's is the zip tools/pack.js builds. Firefox's is the .xpi Mozilla
   * signs from the Firefox package pack.js builds beside it, because the
   * signed file is the one Firefox will keep installed; the unsigned package
   * (`-firefox-unsigned.xpi`) only loads until the browser restarts. Nothing
   * but Chrome's ends in .zip, and nothing else ever may: Chrome builds from
   * before names were matched exactly take the first .zip they find
   * (tools/pack.js, ASSET_SUFFIXES).
   */
  FCM.releaseAssetName = function (version) {
    return FCM.BROWSER === 'firefox'
      ? `FriendlyChatExtension-v${version}-firefox.xpi`
      : `FriendlyChatExtension-v${version}.zip`;
  };

  async function readState() {
    try {
      const stored = await chrome.storage.local.get(FCM.STORAGE_KEYS.update);
      return stored[FCM.STORAGE_KEYS.update] || {};
    } catch (e) {
      return {};
    }
  }

  async function writeState(state) {
    try {
      await chrome.storage.local.set({ [FCM.STORAGE_KEYS.update]: state });
    } catch (e) {
      // The badge is a convenience; a storage failure must not take the
      // background down with it.
    }
  }

  // Whether Firefox is keeping the add-on off Twitch or Kick, as the last
  // site-access check found (see FCM.showSiteAccess below), and whether there
  // has been a check yet. Never set on Chrome, which does not check.
  let sitesBlocked = false;
  let sitesKnown = false;

  // The paint in progress, so the next one waits for it.
  let painting = Promise.resolve();

  /**
   * Puts the badge on the toolbar icon, or takes it off.
   *
   * A dot rather than a version number: the icon is 16 pixels wide and "1.11.0"
   * in it is a smear. What the badge has to say is "there is something to look
   * at", and the popup says the rest.
   *
   * Except while Firefox is keeping the add-on off Twitch or Kick. Then the
   * badge says that instead, whatever it would have said about a release: an
   * update is something to look at, but an overlay that cannot appear at all is
   * the thing to look at first. The dot comes back once the site is allowed.
   *
   * One paint at a time. A paint is three calls with a wait after each, and two
   * that overlapped — the release check's and the site check's both run as the
   * background starts — could leave one's text on the other's colours.
   *
   * Never the dot on a build Firefox updates by itself, whatever the caller
   * asked for: an update that installs without anyone doing anything is not
   * something to look at. The site-access "!" is still painted there, since
   * Firefox does nothing about that.
   */
  function paintBadge(on) {
    const dot = !!on && !FCM.updatedByBrowser();
    painting = painting.then(() => paintNow(dot));
    return painting;
  }

  async function paintNow(on) {
    try {
      if (sitesBlocked) {
        await chrome.action.setBadgeText({ text: '!' });
        await chrome.action.setBadgeBackgroundColor({ color: '#ffb400' });
        if (chrome.action.setBadgeTextColor) {
          await chrome.action.setBadgeTextColor({ color: '#000000' });
        }
        return;
      }
      await chrome.action.setBadgeText({ text: on ? '●' : '' });
      if (!on) return;
      await chrome.action.setBadgeBackgroundColor({ color: '#7c6bff' });
      // Only where it is supported: setBadgeTextColor came to Chrome well after
      // the other badge calls, and a browser without it must not be where this
      // throws.
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: '#ffffff' });
      }
    } catch (e) {
      // No toolbar icon to badge (the popup is open in a window of its own, or
      // the action is not available yet). Nothing else depends on this.
    }
  }

  /**
   * What the popup shows, worked out from what the last check stored.
   *
   * Deliberately reads rather than checks: the popup is opened at a moment the
   * user chose, and making them wait on a network call to see their own
   * settings would be a worse trade than showing an answer up to six hours old.
   *
   * On a build Firefox updates by itself there is never anything available,
   * whatever an earlier build without an update_url left stored: a release
   * Firefox has not installed yet is on its way, not something to go and get.
   * Storage is not even read.
   *
   * `installedUrl` is where to read what is in the version running, and is
   * only worked out on the builds that check — a build the browser updates by
   * itself never asks GitHub anything, so it has nothing to work it out from
   * and the popup answers that question for itself.
   *
   * @returns {Promise<{available: boolean, version: string, url: string,
   *   downloadUrl: string, notes: string, installed: string,
   *   installedUrl?: string}>}
   */
  FCM.updateStatus = async function () {
    if (FCM.updatedByBrowser()) {
      return {
        available: false,
        version: '',
        installed: installedVersion(),
        url: FCM.GITHUB_RELEASES_URL,
        downloadUrl: '',
        notes: '',
        checkedAt: 0,
      };
    }
    const state = await readState();
    const installed = installedVersion();
    const latest = state.latest || '';
    // Compared here rather than trusted from storage, so an extension that has
    // since been updated by hand stops advertising an update to itself.
    const available = !!latest
      && FCM.compareVersions(latest, installed) > 0
      && state.dismissed !== latest;
    return {
      available,
      version: latest,
      installed,
      url: state.url || FCM.GITHUB_RELEASES_URL,
      // Where to read what is in the version actually running. A version newer
      // than anything GitHub has published was built here rather than installed
      // from a release, and nothing is published under that name — so that one
      // goes to the releases page rather than to a tag that 404s. Only a build
      // that checks can tell the difference, which is why this is worked out
      // here rather than in the popup.
      installedUrl: (latest && FCM.compareVersions(installed, latest) > 0)
        ? FCM.GITHUB_RELEASES_URL
        : FCM.releaseNotesUrl(installed),
      downloadUrl: state.downloadUrl || '',
      notes: state.notes || '',
      checkedAt: state.checkedAt || 0,
    };
  };

  /**
   * Stops this version being advertised again.
   *
   * Per version, not a blanket "never tell me": someone who is not updating
   * today still wants to hear about the release after this one.
   */
  FCM.dismissUpdate = async function (version) {
    const state = await readState();
    state.dismissed = version || state.latest || '';
    await writeState(state);
    await paintBadge(false);
  };

  /**
   * Asks GitHub what the newest release is.
   *
   * Failure is silent and cheap on purpose. There is no part of this extension
   * that stops working because the check did not happen, so a rate limit, an
   * outage or a machine that is offline should cost nothing and say nothing.
   *
   * Not asked at all on a build Firefox updates by itself, where Firefox has
   * its own address to ask and GitHub's answer could change nothing. What comes
   * back says no check was made, which is true, and that nothing is available.
   *
   * @param {boolean} [force] skip the retry delay, for a check the user asked for
   */
  FCM.checkForUpdate = async function (force) {
    if (FCM.updatedByBrowser()) return { ...(await FCM.updateStatus()), checked: false };
    const state = await readState();
    const now = Date.now();
    if (!force && state.failedAt && now - state.failedAt < RETRY_AFTER_MS) {
      return FCM.updateStatus();
    }

    const data = await FCM.getJson(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!data || !data.tag_name) {
      state.failedAt = now;
      await writeState(state);
      // Still worth returning what is known — an update an earlier check found
      // is still there — but the caller has to be able to tell that this one
      // never reached GitHub. "Up to date" is a claim about the running
      // version, and it was being made without having asked anybody.
      return { ...(await FCM.updateStatus()), checked: false };
    }

    const latest = String(data.tag_name).replace(/^v/i, '');
    // The release asset, so the popup can offer the file itself rather than a
    // page with the file somewhere on it.
    //
    // Matched by its exact name, and the name is this browser's. A release
    // carries a package for each browser, and "the first .zip" was whichever
    // of them GitHub happened to list first: Firefox's archive offered to
    // Chrome as the update to install, or Chrome's to Firefox. A release
    // without this browser's file gets the release page instead, which is a
    // step further from the file but never the wrong one.
    const wanted = FCM.releaseAssetName(latest);
    const asset = (Array.isArray(data.assets) ? data.assets : [])
      .find((a) => a && a.name === wanted);

    const next = {
      latest,
      url: data.html_url || FCM.GITHUB_RELEASES_URL,
      downloadUrl: (asset && asset.browser_download_url) || '',
      notes: String(data.name || '').trim(),
      checkedAt: now,
      failedAt: 0,
      // A dismissal only ever covered the version it was made for, so it is
      // carried forward and compared rather than cleared here.
      dismissed: state.dismissed || '',
    };
    await writeState(next);

    const status = { ...(await FCM.updateStatus()), checked: true };
    await paintBadge(status.available);
    return status;
  };

  /**
   * Starts the periodic check.
   *
   * The alarm survives the background being put away, which a timer would not
   * — and Chrome's service worker and Firefox's event page are both put away
   * constantly. The check on start covers a browser that has been closed for
   * longer than the interval.
   *
   * None of it on a build Firefox updates by itself. Nothing is scheduled
   * there, and a check that is already scheduled — left by a build of the
   * add-on that had no update_url, since alarms outlive the background that
   * made them — is taken away, rather than left waking the background every
   * six hours to find it has nothing to do. The badge needs no repaint from
   * here either: the status there is never available, so there is no dot to
   * put up, and the site-access check paints its own.
   */
  FCM.watchForUpdates = function () {
    if (FCM.updatedByBrowser()) {
      try {
        Promise.resolve(chrome.alarms.clear(ALARM)).catch(() => {});
      } catch (e) {
        // No alarms available, so none left behind to take away.
      }
      return;
    }
    try {
      // Only when there is not one already. `create` replaces an alarm of the
      // same name, and this runs every time the background starts — which is
      // constantly — so re-arming pushed the check one minute into a future
      // that kept being moved. On a busy machine it never arrived at all, and a
      // new release was never noticed; on a quieter one every restart bought
      // another call against GitHub's hourly budget for the whole address.
      //
      // Alarms outlive the background. Chrome keeps them through a browser
      // restart as well, and fires an overdue one shortly after start; a
      // browser that has not kept one finds none here, and is given a new one a
      // minute out. Either way nothing is lost by leaving one that exists alone.
      Promise.resolve(chrome.alarms.get(ALARM)).then((existing) => {
        if (existing) return;
        chrome.alarms.create(ALARM, {
          periodInMinutes: CHECK_INTERVAL_MINUTES,
          // Not immediately: a browser start already has plenty to do, and this
          // is the least urgent thing in it.
          delayInMinutes: 1,
        });
      }).catch(() => {});
    } catch (e) {
      // No alarms available; the check on wake below still runs.
    }
    // Repaint from what is already known, so the badge survives the background
    // being put away without waiting on the network to come back.
    FCM.updateStatus().then((status) => paintBadge(status.available)).catch(() => {});
  };

  // ── The badge's other job: site access, on Firefox ──────────────────────────
  //
  // Firefox lets a person take Twitch or Kick back from the add-on in
  // about:addons, and an update that adds a site is installed without it. The
  // overlay is simply not there afterwards, and with no overlay there is no
  // panel to explain its own absence. The toolbar icon is the one place left
  // that can, so the badge says so, and the popup underneath it has the button
  // that puts it right. The other services the add-on reaches are told about
  // in the overlay instead (service-worker.js, tellSiteAccess), where what goes
  // missing without them shows.

  /**
   * Takes what a site-access check found and repaints the badge from it.
   *
   * Nothing is repainted when the answer is the one already showing, since the
   * background asks every time it starts and every time a tab first says hello.
   *
   * @param {{sitesMissing?: string[]}} access what FCM.hostAccess() answered
   */
  FCM.showSiteAccess = async function (access) {
    if (FCM.BROWSER !== 'firefox') return;
    const blocked = !!(access && Array.isArray(access.sitesMissing) && access.sitesMissing.length);
    if (sitesKnown && blocked === sitesBlocked) return;
    sitesKnown = true;
    sitesBlocked = blocked;
    try {
      const status = await FCM.updateStatus();
      await paintBadge(status.available);
    } catch (e) { /* the badge is a convenience */ }
  };

  /**
   * Checks site access as the background starts, and again whenever Firefox
   * grants or takes back a permission, so the badge follows a site allowed from
   * the popup or the options page, or one taken back in about:addons, without
   * waiting for the next start. Registered at the top level, as an event page's
   * listeners have to be. Nothing on Chrome.
   */
  FCM.watchSiteAccess = function () {
    if (FCM.BROWSER !== 'firefox') return;
    const check = () => FCM.hostAccess().then(FCM.showSiteAccess).catch(() => {});
    try {
      chrome.permissions.onAdded.addListener(check);
      chrome.permissions.onRemoved.addListener(check);
    } catch (e) {
      // No permission events to follow. Every start still checks, and an event
      // page starts often.
    }
    check();
  };

  FCM.isUpdateAlarm = (name) => name === ALARM;
})(self.FCM);
