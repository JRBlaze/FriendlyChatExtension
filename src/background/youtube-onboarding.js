// First installs get the general guide; eligible updates introduce YouTube.
// Both use the existing once-per-installation marker. Background starts,
// permission changes and later updates must not keep opening setup tabs.
(function (FCM) {
  'use strict';
  const FEATURE = '1.23.0';
  let opening = Promise.resolve();

  async function introduce(reason) {
    try {
      const version = chrome.runtime.getManifest().version;
      if (FCM.compareVersions(version, FEATURE) < 0) return;
      const key = FCM.STORAGE_KEYS.youtubeOnboarding;
      const stored = await chrome.storage.local.get(key);
      if (stored[key] === FEATURE) return;
      // Claim before opening, including when the browser refuses the tab. The
      // popup and options page remain a way to find setup without repeated nags.
      await chrome.storage.local.set({ [key]: FEATURE });
      const page = reason === 'install' ? 'src/setup/quick-start.html' : 'src/youtube/permission.html';
      await chrome.tabs.create({
        url: `${chrome.runtime.getURL(page)}?source=${reason}`,
        active: reason === 'install',
      });
    } catch (e) { /* Onboarding failure must not interrupt chat or force a retry. */ }
  }

  // Register synchronously so Chrome's worker and Firefox's event page both
  // receive installation events; isolated test pages may have no such event.
  if (typeof chrome === 'undefined' || !chrome.runtime?.onInstalled) return;
  chrome.runtime.onInstalled.addListener(details => {
    const reason = details?.reason;
    if (reason !== 'install' && reason !== 'update') return;
    // Chrome also reports an unpacked reload as an update. Serialization plus
    // the local feature marker prevents overlapping events from opening twice.
    opening = opening.then(() => introduce(reason));
    return opening;
  });
})(self.FCM);
