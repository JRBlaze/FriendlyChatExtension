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

  /**
   * Twitch's Cheermote payload, flattened to the little a drawn Cheer needs.
   *
   * A Cheermote is a prefix with tiers under it — 1, 100, 1000, 5000, 10000 —
   * and the tier a Cheer lands in is the largest one its amount reaches. Each
   * tier ships four sizes, in light and dark, animated and static, which is
   * hundreds of urls for something the feed draws one of. Only that one is
   * kept, and animated is preferred because the animation is the whole point
   * of a Cheermote: the static picture is what a Cheer looked like before.
   *
   * Dark, to match the Twitch emotes in the same row — those are requested
   * from the emote CDN's dark set for the same reason.
   *
   * @param {object} data the Helix bits/cheermotes response
   * @returns {Array<{prefix: string, minBits: number, color: string, url: string}>}
   */
  FCM.parseCheermoteTiers = function (data) {
    const entries = Array.isArray(data?.data) ? data.data : [];
    const tiers = [];
    entries.forEach((entry) => {
      const prefix = entry?.prefix;
      if (!prefix || !Array.isArray(entry.tiers)) return;
      entry.tiers.forEach((tier) => {
        const minBits = Number(tier?.min_bits);
        if (!Number.isFinite(minBits) || minBits < 1) return;
        const images = tier?.images?.dark || tier?.images?.light;
        const sizes = images?.animated || images?.static;
        const url = sizes?.['2'] || sizes?.['1.5'] || sizes?.['1'];
        if (!url) return;
        tiers.push({
          prefix: String(prefix),
          minBits,
          // The colour the amount is written in — Twitch's own ladder from
          // grey through purple to red, which is how a big Cheer reads as big
          // at a glance. Left empty when it is missing or not a plain hex
          // colour; the renderer falls back rather than trusting it into a
          // style attribute.
          color: /^#[0-9a-f]{3,8}$/i.test(String(tier?.color || '')) ? String(tier.color) : '',
          url: String(url),
        });
      });
    });
    return tiers;
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
