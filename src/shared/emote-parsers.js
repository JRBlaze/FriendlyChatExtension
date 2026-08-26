// Emote payload parsing shared by the background fetchers and the renderer.
(function (FCM) {
  'use strict';

  FCM.normalizeKickEmoteMeta = function (emotes = []) {
    if (!Array.isArray(emotes)) return [];
    return emotes.map((emote) => {
      const id = emote?.id || emote?.emote_id || emote?.emote?.id;
      const name = emote?.name || emote?.emote_name || emote?.emote?.name;
      const url = emote?.url || emote?.src || emote?.image || emote?.image_url
        || emote?.emote?.url || (id ? `https://files.kick.com/emotes/${id}/fullsize` : '');
      if (!name || !url) return null;
      return { name: String(name), url: String(url) };
    }).filter(Boolean);
  };

  // Kick returns an array of emote sets: the channel's own set, "Global" and
  // "Emoji". Only numeric ids resolve on the CDN.
  FCM.parseKickEmotePayload = function (data, channelName) {
    const store = {};
    if (!data) return store;

    const root = Array.isArray(data) ? data : (data.data || data.emotes || data);
    const sets = Array.isArray(root) ? root : [root];

    const labelFor = (set) => {
      const id = String(set?.id ?? '').toLowerCase();
      const name = String(set?.name ?? '').toLowerCase();
      if (id === 'global' || name === 'global') return 'Kick Global';
      if (id === 'emoji' || name === 'emoji' || name === 'emojis') return 'Kick Emoji';
      return 'Kick Channel';
    };

    const addEmote = (emote, source) => {
      const id = emote?.id ?? emote?.emote_id;
      const name = emote?.name || emote?.slug || emote?.code;
      if (id === undefined || id === null || !name) return;
      if (!/^\d+$/.test(String(id))) return;
      const record = {
        url: `https://files.kick.com/emotes/${id}/fullsize`,
        source,
      };
      // The picker groups by the channel an emote belongs to, and Kick is
      // the one platform that says outright which set an emote came from.
      if (source === 'Kick Channel') {
        record.channel = true;
        if (channelName) record.owner = channelName;
      }
      store[String(name)] = record;
    };

    sets.forEach((set) => {
      if (!set || typeof set !== 'object') return;
      if (Array.isArray(set.emotes)) {
        const source = labelFor(set);
        set.emotes.forEach((emote) => addEmote(emote, source));
        return;
      }
      addEmote(set, 'Kick Channel');
    });

    return store;
  };

  FCM.sevenTvUrl = function (emote) {
    const host = emote?.data?.host?.url || emote?.host?.url;
    if (!host) return null;
    const prefix = host.startsWith('//') ? 'https:' : '';
    const files = emote?.data?.host?.files || emote?.host?.files || [];
    const file = files.find((f) => f.name === '2x.webp')
      || files.find((f) => f.name === '1x.webp')
      || files.find((f) => /\.webp$/.test(f.name || ''))
      || null;
    return `${prefix}${host}/${file?.name || '1x.webp'}`;
  };

})(self.FCM);
