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

  $('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  bindSettings();
  renderStatus();
})(self.FCM);
