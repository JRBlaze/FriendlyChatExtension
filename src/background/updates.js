// Noticing that a newer release has been published.
//
// This extension is installed from a zip rather than from the Chrome Web Store,
// so Chrome never checks for updates and never will. Nothing here can install
// one either — an extension cannot replace itself, and no amount of permissions
// changes that. What it can do is stop the update being something you only find
// out about by going and looking: the releases page is checked in the
// background, the toolbar icon gets a badge when there is something newer, and
// the popup turns that into the two clicks it actually takes.
(function (FCM) {
  'use strict';

  FCM.GITHUB_REPO = 'JRBlaze/FriendlyChatExtension';
  FCM.GITHUB_RELEASES_URL = `https://github.com/${FCM.GITHUB_REPO}/releases/latest`;
  const LATEST_API = `https://api.github.com/repos/${FCM.GITHUB_REPO}/releases/latest`;

  // Once every six hours. A release is not an event anybody needs told about
  // within the minute, and GitHub rate-limits unauthenticated callers by IP —
  // which, behind a shared address, is an IP this extension does not have to
  // itself.
  const CHECK_INTERVAL_MINUTES = 6 * 60;
  const ALARM = 'fcm-update-check';
  // How long a failed check waits before the next one is allowed. Without it a
  // worker that restarts often — which is normal, they are killed constantly —
  // would re-ask on every wake.
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
      // The badge is a convenience; a storage failure must not take the worker
      // down with it.
    }
  }

  /**
   * Puts the badge on the toolbar icon, or takes it off.
   *
   * A dot rather than a version number: the icon is 16 pixels wide and "1.11.0"
   * in it is a smear. What the badge has to say is "there is something to look
   * at", and the popup says the rest.
   */
  async function paintBadge(on) {
    try {
      await chrome.action.setBadgeText({ text: on ? '●' : '' });
      if (!on) return;
      await chrome.action.setBadgeBackgroundColor({ color: '#7c6bff' });
      // Only where it is supported: setBadgeTextColor arrived after the minimum
      // Chrome this extension declares, so it must not be the call that throws.
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
   * @returns {Promise<{available: boolean, version: string, url: string,
   *   downloadUrl: string, notes: string, installed: string}>}
   */
  FCM.updateStatus = async function () {
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
   * @param {boolean} [force] skip the retry delay, for a check the user asked for
   */
  FCM.checkForUpdate = async function (force) {
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
    // page with the file somewhere on it. Matched by name because a release
    // carries more than one asset once source archives are counted.
    const asset = (Array.isArray(data.assets) ? data.assets : [])
      .find((a) => a && typeof a.name === 'string' && /\.zip$/i.test(a.name));

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
   * The alarm survives the worker being killed, which a timer would not — and
   * the worker is killed constantly. The check on start covers a browser that
   * has been closed for longer than the interval.
   */
  FCM.watchForUpdates = function () {
    try {
      // Only when there is not one already. `create` replaces an alarm of the
      // same name, and this runs on every worker start — which is constantly —
      // so re-arming pushed the check one minute into a future that kept being
      // moved. On a busy machine it never arrived at all, and a new release was
      // never noticed; on a quieter one every restart bought another call
      // against GitHub's hourly budget for the whole address.
      //
      // Alarms outlive the worker and the browser, and Chrome fires an overdue
      // one shortly after start, so nothing is lost by leaving it alone.
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
    // Repaint from what is already known, so the badge survives the worker
    // being collected without waiting on the network to come back.
    FCM.updateStatus().then((status) => paintBadge(status.available)).catch(() => {});
  };

  FCM.isUpdateAlarm = (name) => name === ALARM;
})(self.FCM);
