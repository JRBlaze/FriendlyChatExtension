// Only explicit host-scoped choices persist. Background serialization keeps
// edits from separate tabs from overwriting each other.
(function (FCM) {
  'use strict';
  const COMMANDS = new Set(['youtubeLinkGet', 'youtubeLinkSave', 'youtubeLinkForget', 'youtubeLinkForgetSaved']);
  const HOSTS = new Map([['twitch.tv', 'twitch'], ['www.twitch.tv', 'twitch'], ['kick.com', 'kick'], ['www.kick.com', 'kick']]);
  let writes = Promise.resolve();

  function hostKey(message, sender) {
    if (!sender || sender.id !== chrome.runtime.id || !sender.tab
      || !Number.isInteger(sender.tab.id) || sender.tab.id < 0 || sender.frameId !== 0) return '';
    try {
      const url = new URL(sender.url), platform = HOSTS.get(url.hostname);
      if (url.protocol !== 'https:' || url.port || url.username || url.password || !platform) return '';
      const parts = url.pathname.split('/').filter(Boolean);
      const special = platform === 'twitch' ? ['popout', 'moderator', 'embed'] : ['popout'];
      const channel = special.includes(parts[0]) ? parts[1] : parts[0];
      const actual = FCM.youtubeLinkHostKey(platform, channel);
      return actual && actual === FCM.youtubeLinkHostKey(message.platform, message.channel) ? actual : '';
    } catch (_) { return ''; }
  }

  function pairFor(host, records, saved) {
    const [platform, channel] = host.split(':');
    const other = platform === 'twitch' ? 'kick' : 'twitch';
    const own = records[host];
    if (!own || own.manual !== true || own.none) return null;
    const key = FCM.youtubeLinkHostKey(other, own.channel), back = records[key];
    if (!key || !back || back.manual !== true || back.none
      || FCM.youtubeLinkHostKey(platform, back.channel) !== host) return null;
    return { platform: other, channel: key.split(':')[1], link: saved[key] || null };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || !COMMANDS.has(message.cmd)) return false;
    const options = message.cmd === 'youtubeLinkForgetSaved';
    let host;
    if (options) {
      const parts = typeof message.hostKey === 'string' ? message.hostKey.split(':') : [];
      host = sender && sender.id === chrome.runtime.id
        && sender.url === chrome.runtime.getURL('src/options/options.html')
        && parts.length === 2 && FCM.youtubeLinkHostKey(parts[0], parts[1]);
    } else host = hostKey(message, sender);
    if (!host) { respond({ ok: false, error: 'invalid-host' }); return false; }

    const operation = writes.then(async () => {
      const stored = await chrome.storage.local.get([FCM.STORAGE_KEYS.youtubeLinks, FCM.STORAGE_KEYS.links]);
      const saved = FCM.cleanYouTubeLinks(stored[FCM.STORAGE_KEYS.youtubeLinks]) || {};
      const records = stored[FCM.STORAGE_KEYS.links] || {};
      const counterpart = pairFor(host, records, saved);
      if (message.cmd === 'youtubeLinkGet') return { ok: true, link: saved[host] || null, counterpart };
      if (message.cmd === 'youtubeLinkForget' || options) {
        if (options && (!saved[host] || saved[host].channelUrl !== message.channelUrl)) {
          return { ok: false, error: 'link-changed' };
        }
        delete saved[host];
        await chrome.storage.local.set({ [FCM.STORAGE_KEYS.youtubeLinks]: saved });
        return { ok: true, link: null };
      }
      let channelUrl;
      try { channelUrl = FCM.youtube.parseInput(message.channelUrl).channelUrl; }
      catch (_) { return { ok: false, error: 'invalid-channel' }; }
      if (!channelUrl) return { ok: false, error: 'invalid-channel' };
      const targets = [host];
      if (message.counterpartChannel !== undefined) {
        if (!counterpart || message.counterpartChannel !== counterpart.channel) {
          return { ok: false, error: 'counterpart-changed' };
        }
        targets.push(`${counterpart.platform}:${counterpart.channel}`);
      }
      const added = targets.filter(key => !saved[key]).length;
      if (Object.keys(saved).length + added > FCM.LINK_STORE_LIMIT) return { ok: false, error: 'limit' };
      const link = { channelUrl, at: Date.now() };
      targets.forEach(key => { saved[key] = link; });
      await chrome.storage.local.set({ [FCM.STORAGE_KEYS.youtubeLinks]: saved });
      return { ok: true, link };
    }).catch(() => ({ ok: false, error: 'storage' }));
    writes = operation.then(() => undefined);
    operation.then(respond);
    return true;
  });
})(self.FCM);
