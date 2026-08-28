(function (FCM) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function stateLabel(conn) {
    if (!conn || !conn.channel) return 'not connected';
    if (conn.state === 'connected') return conn.channel;
    return `${conn.channel} (${conn.state})`;
  }

  async function renderStatus() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    let host = '';
    try { host = new URL(tab.url || '').hostname; } catch (e) { host = ''; }
    const onSupportedSite = /(^|\.)twitch\.tv$/.test(host) || /(^|\.)kick\.com$/.test(host);

    if (!onSupportedSite) {
      $('context').textContent = 'Not a Twitch or Kick page';
      return;
    }

    const info = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ cmd: 'status', tabId: tab.id }, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    });

    if (!info || !info.channel) {
      $('context').textContent = `${host} — no channel open`;
      return;
    }

    $('idle').classList.add('hidden');
    $('status').classList.remove('hidden');
    $('context').textContent = `${FCM.PLATFORM_META[info.site].name} channel page`;
    $('host-channel').textContent = `${FCM.PLATFORM_META[info.site].name}/${info.channel}`;

    FCM.PLATFORMS.forEach((platform) => {
      const conn = (info.connections || {})[platform];
      const el = $(`state-${platform}`);
      el.textContent = stateLabel(conn);
      el.dataset.state = conn && conn.channel ? conn.state : '';
    });

    const cp = info.counterpart;
    const cpEl = $('counterpart');
    if (!cp || !cp.exists) {
      cpEl.textContent = 'no match found';
      cpEl.dataset.live = 'false';
    } else {
      const other = FCM.PLATFORM_META[cp.platform].name;
      cpEl.textContent = `${other}/${cp.channel} — ${cp.live ? 'LIVE' : 'offline'}`;
      cpEl.dataset.live = String(!!cp.live);
      cpEl.title = cp.match ? `Matched by: ${cp.match}` : '';
    }
  }

  async function bindSettings() {
    const settings = await FCM.loadSettings();
    ['autoOpen', 'autoConnectHost'].forEach((key) => {
      const el = $(key);
      el.checked = !!settings[key];
      el.addEventListener('change', () => FCM.saveSettings({ [key]: el.checked }));
    });
    const mode = $('crossPromptMode');
    mode.value = settings.crossPromptMode;
    mode.addEventListener('change', () => FCM.saveSettings({ crossPromptMode: mode.value }));
  }

  // ── Releases ────────────────────────────────────────────────────────────────
  //
  // The extension cannot install its own update — nothing can, outside the Web
  // Store — so what this does is remove every step it can from the ones that
  // are left: the file, the page to drop it on, and the reason to bother.

  function ask(cmd, extra) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ cmd, ...(extra || {}) }, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    });
  }

  function openTab(url) {
    if (!url) return;
    // chrome://extensions is a page Chrome is entitled to refuse, and a refusal
    // here throws. Nothing else in the popup should go down with it.
    try { chrome.tabs.create({ url }); } catch (e) { return; }
    // Chrome keeps the popup open over the new tab otherwise, which reads as
    // nothing having happened.
    window.close();
  }

  function renderUpdate(status) {
    const card = $('update');
    if (!status || !status.available) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    $('update-title').textContent = `Version ${status.version} is available`;
    $('update-note').textContent = status.notes
      ? `${status.notes} — you are on ${status.installed}.`
      : `You are on ${status.installed}.`;
    // The asset itself when the release has one, and the release page when it
    // does not: a page with the file on it still beats no link at all.
    $('update-get').textContent = status.downloadUrl ? 'Download the zip' : 'Open the release';
    $('update-get').onclick = () => openTab(status.downloadUrl || status.url);
    $('update-dismiss').onclick = async () => {
      await ask('updateDismiss', { version: status.version });
      card.classList.add('hidden');
    };
  }

  $('update-install').addEventListener('click', () => openTab('chrome://extensions'));

  $('check-updates').addEventListener('click', async (e) => {
    e.preventDefault();
    const link = $('check-updates');
    link.textContent = 'Checking…';
    const status = await ask('updateCheck');
    renderUpdate(status);
    link.textContent = status && status.available
      ? 'Update ready'
      : (status ? 'Up to date' : 'Could not check');
  });

  $('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  bindSettings();
  renderStatus();
  // From what the last background check stored, so the banner is there the
  // moment the popup opens rather than a beat later.
  ask('updateStatus').then(renderUpdate);
})(self.FCM);
