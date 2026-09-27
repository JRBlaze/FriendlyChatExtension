// Shared by the popup and options page. Request access directly in the button
// gesture so Firefox and Chrome can show their own optional-permission prompt.
(function () {
  'use strict';
  const button = document.getElementById('youtube-access-allow');
  const status = document.getElementById('youtube-access-status');
  const origins = { origins: ['https://www.youtube.com/*'] };
  let requesting = false, refreshAfterRequest = false, revision = 0;

  function render(granted, message) {
    button.disabled = granted;
    button.textContent = granted ? 'YouTube access allowed' : 'Allow YouTube access';
    status.textContent = message || (granted
      ? 'YouTube access is enabled. Add chat or save a channel link on a Twitch or Kick page.'
      : 'Optional YouTube access enables live suggestions. Chat loads only when you add it or use a saved link.');
  }

  async function refresh() {
    if (requesting) { refreshAfterRequest = true; return; }
    const current = ++revision;
    try {
      const granted = await chrome.permissions.contains(origins);
      if (current === revision) render(granted);
    } catch {
      if (current === revision) render(false, 'Could not check YouTube access. Use the button to try again.');
    }
  }

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    requesting = true;
    revision++;
    button.disabled = true;
    status.textContent = 'Waiting for the browser permission prompt…';
    try {
      const granted = await chrome.permissions.request(origins);
      render(granted, granted ? '' : 'Access was not granted. You can allow it whenever you are ready.');
    } catch {
      render(false, 'The browser could not grant access. Try again from this button.');
    } finally {
      requesting = false;
      if (refreshAfterRequest) {
        refreshAfterRequest = false;
        await refresh();
      }
    }
  });
  chrome.permissions.onAdded.addListener(refresh);
  chrome.permissions.onRemoved.addListener(refresh);
  refresh();
})();
