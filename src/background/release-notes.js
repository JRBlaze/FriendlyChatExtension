// Offer local release notes once per installed version, without taking focus.
(function (FCM) {
  'use strict';
  if (typeof chrome === 'undefined' || !chrome.runtime?.onInstalled) return;
  let opening = Promise.resolve();
  async function announce(details) {
    try {
      const version = chrome.runtime.getManifest().version;
      const key = FCM.STORAGE_KEYS.releaseNotes;
      const stored = await chrome.storage.local.get(key);
      if (stored[key] === version) return;
      // Claim before opening so background restarts or unpacked reloads do not
      // repeat a notification. Popup and Settings always offer the same page.
      await chrome.storage.local.set({ [key]: version });
      if (details.reason !== 'update' || FCM.compareVersions(version, details.previousVersion) <= 0) return;
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/releases/notes.html'), active: false });
    } catch (_) { /* A failed notice must not interrupt chat or repeatedly nag. */ }
  }
  chrome.runtime.onInstalled.addListener(details => {
    if (!details || !['install', 'update'].includes(details.reason)) return;
    opening = opening.then(() => announce(details));
    return opening;
  });
})(self.FCM);
