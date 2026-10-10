(function (FCM) {
  'use strict';
  const $ = id => document.getElementById(id);
  const platforms = ['twitch', 'kick'];
  const names = { twitch: 'Twitch', kick: 'Kick' };
  let step = 0, accounts = null, pending = false, connecting = '', closed = false, revision = 0;

  function renderAccounts() {
    for (const platform of platforms) {
      const account = accounts?.[platform];
      const connected = account?.connected === true;
      $(`connect-${platform}`).disabled = pending || !accounts || connected;
      $(`connect-${platform}`).textContent = connected ? `${names[platform]} connected`
        : connecting === platform ? 'Connecting…' : `Connect ${names[platform]}`;
      $(`account-${platform}`).textContent = connected
        ? account.login ? `Connected as ${account.login}` : 'Account connected'
        : accounts ? 'Not connected — you can do this later.' : 'Checking your connection…';
    }
    for (const id of ['next', 'back', 'settings', 'skip', 'check', 'review']) $(id).disabled = pending;
    youtubeAccess.render();
  }

  function showStep(next, focus = true) {
    step = next;
    for (let index = 0; index < 3; index++) {
      $(`step-${index + 1}`).hidden = index !== step;
      const progress = $(`progress-${index + 1}`);
      if (index === step) progress.setAttribute('aria-current', 'step');
      else progress.removeAttribute('aria-current');
    }
    $('complete').hidden = step !== 3;
    $('navigation').hidden = step >= 2;
    $('back').hidden = step === 0;
    $('next').textContent = step === 0 ? 'Get started' : 'Continue';
    $('progress-label').textContent = step < 3 ? `Step ${step + 1} of 3` : 'Setup complete';
    if (focus) $(step === 3 ? 'complete-title' : `title-${step + 1}`).focus();
  }

  async function refresh() {
    if (closed || pending) return;
    const current = ++revision;
    try {
      const result = await chrome.runtime.sendMessage({ cmd: 'quickStartAccounts' });
      if (closed || pending || current !== revision) return;
      if (!result?.ok || !result.accounts) throw Error('Accounts unavailable');
      accounts = result.accounts;
      $('status').textContent = '';
    } catch (error) {
      if (closed || pending || current !== revision) return;
      accounts = null;
      $('status').textContent = 'Unable to check your connections. Choose Check connections to try again, or continue and connect later.';
    }
    renderAccounts();
  }

  for (const platform of platforms) $(`connect-${platform}`).addEventListener('click', async event => {
    if (!event.isTrusted || closed || pending || step !== 1 || !accounts || accounts[platform]?.connected) return;
    pending = true; connecting = platform; revision++;
    renderAccounts();
    $('status').textContent = `Complete ${names[platform]} sign-in in the window your browser opens. You can cancel and connect later.`;
    try {
      // Only this explicit click starts the extension's existing OAuth flow.
      const result = await chrome.runtime.sendMessage({ cmd: 'quickStartConnect', platform });
      if (closed) return;
      if (!result?.ok || !result.accounts || result.accounts[platform]?.connected !== true) {
        $('status').textContent = result?.code === 'busy'
          ? 'A sign-in window is already open. Complete or cancel it, then try again.'
          : 'Connection was not completed. Try again, or continue and connect later.';
      } else {
        accounts = result.accounts;
        $('status').textContent = `${names[platform]} is connected. You can connect the other account or continue.`;
      }
    } catch (error) {
      if (!closed) $('status').textContent = 'Connection was not completed. Try again, or continue and connect later.';
    } finally {
      pending = false; connecting = '';
      if (!closed) renderAccounts();
    }
  });

  const youtubeAccess = FCM.createQuickStartYouTubeAccess({
    button: $('allow-youtube'), status: $('youtube-status'), isBusy: () => pending,
    onBusy(value) { pending = value; renderAccounts(); },
  });

  $('next').addEventListener('click', event => {
    if (event.isTrusted && !closed && !pending && step < 2) { $('status').textContent = ''; showStep(step + 1); }
  });
  $('back').addEventListener('click', event => {
    if (event.isTrusted && !closed && !pending && step > 0 && step < 3) { $('status').textContent = ''; showStep(step - 1); }
  });
  $('check').addEventListener('click', event => { if (event.isTrusted) refresh(); });
  $('skip').addEventListener('click', event => {
    if (event.isTrusted && !closed && !pending && step === 2) { $('status').textContent = ''; showStep(3); }
  });
  $('settings').addEventListener('click', async event => {
    if (!event.isTrusted || closed || pending || step !== 2) return;
    pending = true; renderAccounts();
    try {
      await chrome.runtime.openOptionsPage();
      if (!closed) { $('status').textContent = ''; showStep(3); }
    } catch (error) {
      if (!closed) $('status').textContent = 'Unable to open All Settings. Try again, or choose Skip and finish.';
    } finally { pending = false; if (!closed) renderAccounts(); }
  });
  $('review').addEventListener('click', event => {
    if (event.isTrusted && !closed && !pending) { $('status').textContent = ''; showStep(0); }
  });
  function storageChanged(changes, area) {
    if (area === 'local' && changes[FCM.STORAGE_KEYS.auth]) refresh();
  }
  chrome.storage.onChanged.addListener(storageChanged);
  window.addEventListener('focus', () => { refresh(); youtubeAccess.refresh(); });
  window.addEventListener('pagehide', () => {
    closed = true; revision++;
    youtubeAccess.destroy();
    chrome.storage.onChanged.removeListener(storageChanged);
  });
  showStep(0, false);
  renderAccounts();
  refresh();
})(self.FCM);
