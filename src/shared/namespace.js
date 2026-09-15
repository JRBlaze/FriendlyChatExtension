// Every shared file hangs off one global so the same source can be loaded as a
// classic content script, via importScripts() in Chrome's service worker, or
// listed in background.scripts on Firefox, where the background is an event page.
// Content scripts run in an isolated world, so this never collides with the page.
//
// It also says which browser this is, once, before anything else has run, so
// the few places that have to behave differently ask FCM.BROWSER rather than
// each working it out their own way.
//
// Worked out from the extension's own address, because that is the one thing
// the two browsers cannot agree on: Firefox serves an extension from
// moz-extension://, Chrome from chrome-extension://. Not from whether a
// `browser` global exists — Chrome 148 and later define one too, so that test
// would call every current Chrome a Firefox. And anywhere there is no extension
// API to ask, which is every test sandbox that never stubbed one, the answer is
// Chrome, which is what everything was written against.
(function (root) {
  root.FCM = root.FCM || {};
  if (!root.FCM.BROWSER) {
    let browser = 'chrome';
    try {
      // Bare `chrome`, not `root.chrome`: in a Firefox content script `self`
      // is the page window's Xray, and the extension API lives on the sandbox.
      if (typeof chrome !== 'undefined'
        && String(chrome.runtime.getURL('')).startsWith('moz-extension:')) browser = 'firefox';
    } catch (e) { /* not an extension context */ }
    root.FCM.BROWSER = browser;
  }
})(typeof self !== 'undefined' ? self : globalThis);
