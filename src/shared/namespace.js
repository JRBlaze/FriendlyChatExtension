// Every shared file hangs off one global so the same source can be loaded as a
// classic content script and via importScripts() in the service worker.
// Content scripts run in an isolated world, so this never collides with the page.
(function (root) {
  root.FCM = root.FCM || {};
})(typeof self !== 'undefined' ? self : globalThis);
