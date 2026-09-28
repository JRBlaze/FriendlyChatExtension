// Permission requests originate in this extension page's button gesture.
// Content scripts cannot call chrome.permissions themselves.
(function () {
  'use strict';
  const button = document.getElementById('allow');
  const status = document.getElementById('status');
  const done = document.getElementById('continue');
  const permission = { origins: ['https://www.youtube.com/*'] };
  let granted = false, pending = false, closed = false, revision = 0, refreshAfterRequest = false;

  function show(allowed, message) {
    granted = allowed;
    button.disabled = granted || pending;
    button.textContent = granted ? 'YouTube access allowed' : 'Allow YouTube access';
    done.textContent = granted ? 'Done' : 'Not now';
    status.dataset.granted = String(granted);
    status.textContent = message || (granted
      ? 'YouTube is ready. Open a Twitch or Kick channel, then use YouTube to add chat or save a channel link. Sending turns on automatically when the signed-in YouTube chat box is ready. Check the displayed account and turn the target off if you do not want to send there. On an already open stream page, choose Check YouTube or refresh it.'
      : 'You can keep using Twitch and Kick without YouTube access, and enable it here later.');
  }

  async function refresh() {
    if (closed) return;
    if (pending) { refreshAfterRequest = true; return; }
    const current = ++revision;
    try {
      const allowed = await chrome.permissions.contains(permission);
      if (closed || pending || current !== revision) return;
      show(allowed);
    } catch (error) {
      if (closed || pending || current !== revision) return;
      status.textContent = 'Unable to check YouTube access. Reopen this page or use Allow YouTube access to try again.';
    }
  }

  button.addEventListener('click', async event => {
    if (!event.isTrusted || pending || closed || granted) return;
    pending = true;
    revision++;
    refreshAfterRequest = false;
    button.disabled = true;
    done.disabled = true;
    status.textContent = 'Approve the YouTube site-access request from your browser to continue.';
    try {
      // Keep this call directly in the trusted click, before any asynchronous work.
      const allowed = await chrome.permissions.request(permission);
      if (closed) return;
      show(allowed, allowed ? '' : 'Access was not granted. YouTube chat remains off. Choose Allow YouTube access to try again.');
    } catch (error) {
      if (!closed) show(false, 'The browser could not grant access. Choose Allow YouTube access to try again.');
    } finally {
      pending = false;
      if (!closed) {
        button.disabled = granted;
        done.disabled = false;
        if (refreshAfterRequest) refresh();
      }
    }
  });

  function deactivate() { closed = true; revision++; }
  done.addEventListener('click', event => {
    if (!event.isTrusted || pending || closed) return;
    deactivate();
    button.disabled = true;
    done.disabled = true;
    // Browser-created setup tabs normally close; direct navigation may refuse it.
    status.textContent = 'You can close this setup tab and return to your stream. YouTube access can be changed later in extension settings.';
    try { window.close(); } catch (error) { /* The close-tab instruction remains visible. */ }
  });
  chrome.permissions.onAdded.addListener(refresh);
  chrome.permissions.onRemoved.addListener(refresh);
  window.addEventListener('focus', refresh);
  window.addEventListener('pagehide', deactivate);
  refresh();
})();
