// Optional YouTube access uses the same origin and trusted-button request as
// the existing YouTube setup page. It does not connect a YouTube account.
(function (FCM) {
  'use strict';
  FCM.createQuickStartYouTubeAccess = function ({ button, status, isBusy, onBusy }) {
    const permission = { origins: ['https://www.youtube.com/*'] };
    let granted = false, pending = false, closed = false, revision = 0, refreshAfterRequest = false;

    function render() {
      button.disabled = granted || pending || closed || isBusy();
      button.textContent = granted ? 'YouTube access allowed' : pending ? 'Waiting for permission…' : 'Allow YouTube access';
    }
    function show(message) {
      render();
      status.textContent = message || (granted
        ? 'YouTube is ready. Add a live chat from your stream panel. Sending still needs your signed-in YouTube chat box.'
        : 'Access is optional. You can continue without it and allow YouTube later.');
    }
    async function refresh() {
      if (closed) return;
      if (pending) { refreshAfterRequest = true; return; }
      const current = ++revision;
      try {
        const allowed = await chrome.permissions.contains(permission);
        if (closed || pending || current !== revision) return;
        granted = allowed === true;
        show();
      } catch (error) {
        if (closed || pending || current !== revision) return;
        show('Unable to check YouTube access. Choose Allow YouTube access to try again, or continue without it.');
      }
    }
    button.addEventListener('click', async event => {
      if (!event.isTrusted || closed || pending || granted || isBusy()) return;
      pending = true; revision++; refreshAfterRequest = false;
      onBusy(true);
      render();
      status.textContent = 'Approve the YouTube site-access request from your browser to continue.';
      try {
        // No await precedes this API call: preserve the trusted user gesture.
        const allowed = await chrome.permissions.request(permission);
        if (closed) return;
        granted = allowed === true;
        show(granted ? '' : 'Access was not granted. You can try again or continue without YouTube.');
      } catch (error) {
        if (!closed) show('The browser could not grant access. Try again or continue without YouTube.');
      } finally {
        pending = false;
        if (!closed) {
          onBusy(false);
          render();
          if (refreshAfterRequest) refresh();
        }
      }
    });
    chrome.permissions.onAdded.addListener(refresh);
    chrome.permissions.onRemoved.addListener(refresh);
    refresh();
    return { refresh, render, destroy() {
      closed = true; revision++;
      chrome.permissions.onAdded.removeListener(refresh);
      chrome.permissions.onRemoved.removeListener(refresh);
      render();
    } };
  };
})(self.FCM);
