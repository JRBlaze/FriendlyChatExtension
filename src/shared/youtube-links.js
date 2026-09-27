// Saved YouTube channels belong to explicit Twitch/Kick hosts. They never
// participate in account identities, sending targets or guessed pairings.
(function (FCM) {
  'use strict';

  FCM.youtubeLinkHostKey = function (platform, channel) {
    if (!['twitch', 'kick'].includes(platform) || typeof channel !== 'string') return '';
    const name = channel.trim().toLowerCase();
    const valid = platform === 'twitch' ? /^[a-z0-9_]{2,30}$/ : /^[a-z0-9_-]{2,30}$/;
    const reserved = platform === 'twitch' ? FCM.TWITCH_RESERVED : FCM.KICK_RESERVED;
    return valid.test(name) && !reserved.has(name) ? `${platform}:${name}` : '';
  };

  FCM.cleanYouTubeLinks = function (value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const clean = {};
    for (const [key, record] of Object.entries(value)) {
      if (Object.keys(clean).length >= FCM.LINK_STORE_LIMIT) break;
      const parts = key.split(':');
      const host = parts.length === 2 && FCM.youtubeLinkHostKey(parts[0], parts[1]);
      if (!host || !record || typeof record !== 'object' || Array.isArray(record)) continue;
      let channelUrl;
      try { channelUrl = FCM.youtube.parseInput(record.channelUrl).channelUrl; }
      catch (_) { continue; }
      if (!channelUrl) continue;
      clean[host] = { channelUrl, at: Number.isFinite(record.at) && record.at >= 0 ? record.at : 0 };
    }
    return clean;
  };
})(self.FCM);
