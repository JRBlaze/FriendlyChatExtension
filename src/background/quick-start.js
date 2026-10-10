// The first-install guide uses the existing account flows. Only this bundled
// top-level page may use these routes; credentials never enter its response.
(function (FCM) {
  'use strict';
  let connecting = false;

  async function accounts() {
    const summary = await FCM.auth.summary();
    return Object.fromEntries(FCM.PLATFORMS.map(platform => [platform, {
      connected: summary?.[platform]?.connected === true,
      login: typeof summary?.[platform]?.login === 'string' ? summary[platform].login.slice(0, 100) : '',
    }]));
  }

  FCM.quickStartRequest = async function (message, sender) {
    if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== 'string'
      || sender.url.split(/[?#]/)[0] !== chrome.runtime.getURL('src/setup/quick-start.html')
      || (sender.frameId !== undefined && sender.frameId !== 0)) return { ok: false, code: 'refused' };
    if (!message || !['quickStartAccounts', 'quickStartConnect'].includes(message.cmd)) return { ok: false, code: 'invalid' };
    try {
      if (message.cmd === 'quickStartAccounts') return { ok: true, accounts: await accounts() };
      const platform = message.platform;
      if (!FCM.PLATFORMS.includes(platform)) return { ok: false, code: 'invalid' };
      if (connecting) return { ok: false, code: 'busy' };
      connecting = true;
      try {
        const current = await accounts();
        if (current[platform].connected) return { ok: true, changed: false, accounts: current };
        const settings = await FCM.loadSettings();
        await FCM.auth.connect(platform, settings);
        return { ok: true, changed: true, accounts: await accounts() };
      } finally { connecting = false; }
    } catch (error) {
      // Provider errors can contain request details. The guide gets a friendly
      // retry/skip message, never raw OAuth errors or credentials.
      return { ok: false, code: 'failed' };
    }
  };
})(self.FCM);
