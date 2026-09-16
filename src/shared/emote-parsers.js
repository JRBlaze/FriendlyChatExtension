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

  // Kick returns an array of emote sets. Signed out that is the channel's own
  // set, "Global" and "Emoji"; signed in it also carries "Collectibles" — the
  // emotes this account has collected — and a set for every other channel this
  // viewer subscribes to. Only numeric ids resolve on the CDN.
  FCM.parseKickEmotePayload = function (data, channelName) {
    const store = {};
    if (!data) return store;

    const root = Array.isArray(data) ? data : (data.data || data.emotes || data);
    const sets = Array.isArray(root) ? root : [root];

    const watched = FCM.normalizeChannel(channelName || '');

    // What wins a name two sets both use. Everything a stranger would also be
    // shown ranks alike, and among those the last set listed still wins, which
    // is how a signed-out answer has always been read. Only the sets that are
    // here because of who is signed in rank below them: another channel's
    // emote must not take a global's name, or the room sees one picture and
    // this viewer sees another.
    const SHARED = 2;
    const PERSONAL = 1;
    const ranks = {};

    /**
     * What a set is, as the picker needs to hear it.
     *
     * `owner` is the channel a set belongs to and is what the picker makes a
     * section of; `channel` marks the one channel being watched. A signed-in
     * answer carries the sets of every channel this viewer subscribes to, not
     * just this one, so a numeric set is only "this channel" when it says it
     * is — filing another streamer's subscriber emotes under the streamer on
     * screen would claim the room can see you use emotes it cannot.
     *
     * The older shape had no slug on the set at all. There, the only channel
     * it could be about is the one that was asked for, which is what it has
     * always been read as.
     */
    const labelFor = (set) => {
      const id = String(set?.id ?? '').toLowerCase();
      const name = String(set?.name ?? '').toLowerCase();
      if (id === 'global' || name === 'global') return { source: 'Kick Global', rank: SHARED };
      if (id === 'emoji' || name === 'emoji' || name === 'emojis') {
        return { source: 'Kick Emoji', rank: SHARED };
      }
      // The emotes this account has collected. Kick's own picker gives them a
      // section of their own, and they belong to the viewer rather than to any
      // channel — so no owner, and a label that is its own heading.
      if (id === 'collectibles' || name === 'collectibles') {
        return { source: 'Kick Collectibles', collectible: true, rank: PERSONAL };
      }
      const slug = String(set?.slug || '');
      if (!slug && !/^\d+$/.test(String(set?.id ?? ''))) {
        // A set named neither by a channel nor by anything known here. Kick
        // added Collectibles without warning and can add another, so one is
        // offered rather than dropped — but it is not claimed for this channel
        // and not kept for whoever opens the channel next, because there is
        // nothing to say it is about the channel at all.
        return { source: 'Kick', rank: PERSONAL };
      }
      // Which channel a set is, is its slug and only its slug — the name in the
      // address bar, which is what the channel being watched is known by here.
      // A set carrying a channel's own id and no slug is the older shape, and
      // the only channel it can be about is the one that was asked for.
      const mine = !slug || !watched || FCM.normalizeChannel(slug) === watched;
      return {
        source: 'Kick Channel',
        // The slug for the channel on screen, because 7TV and the rest label
        // the same channel's emotes with the same slug, and the picker groups
        // by that label: two spellings of one channel would draw it twice, both
        // headed "this channel". Elsewhere the spelling with the capitals in it
        // is the one to show, and nothing else is producing it to clash with.
        owner: mine ? (slug || channelName || '') : (String(FCM.usernameFrom(set?.user) || '') || slug),
        channel: mine,
        rank: mine ? SHARED : PERSONAL,
      };
    };

    const addEmote = (emote, label) => {
      const id = emote?.id ?? emote?.emote_id;
      const name = emote?.name || emote?.slug || emote?.code;
      if (id === undefined || id === null || !name) return;
      if (!/^\d+$/.test(String(id))) return;
      const key = String(name);
      if (key in ranks && label.rank < ranks[key]) return;
      const record = {
        url: `https://files.kick.com/emotes/${id}/fullsize`,
        source: label.source,
      };
      // The picker groups by the channel an emote belongs to, and Kick is
      // the one platform that says outright which set an emote came from.
      if (label.channel) record.channel = true;
      if (label.owner) record.owner = label.owner;
      if (label.collectible) record.collectible = true;
      ranks[key] = label.rank;
      store[key] = record;
    };

    sets.forEach((set) => {
      if (!set || typeof set !== 'object') return;
      if (Array.isArray(set.emotes)) {
        const label = labelFor(set);
        set.emotes.forEach((emote) => addEmote(emote, label));
        return;
      }
      addEmote(set, {
        source: 'Kick Channel', channel: true, owner: channelName || '', rank: SHARED,
      });
    });

    return store;
  };

  /**
   * Whether a parsed Kick emote is one anybody in this channel is also shown.
   *
   * The globals, the emoji, and the channel's own set. Everything else in a
   * signed-in answer is there because of who is signed in: this viewer's
   * collectibles, the channels they subscribe to, and whatever set Kick adds
   * next — which is named rather than sorted out by what is left over, because
   * Collectibles arrived without warning and another set can just as quietly,
   * and an unrecognised one is far likelier to be about the viewer than about
   * the channel.
   */
  FCM.isSharedKickEmote = function (emote) {
    if (!emote || emote.collectible) return false;
    return emote.source === 'Kick Global'
      || emote.source === 'Kick Emoji'
      || (emote.source === 'Kick Channel' && !!emote.channel);
  };

  /**
   * What the feed says about a Kick emote list that has just loaded.
   *
   * "Loaded 2,400 Kick emotes for this channel" is not true of a signed-in
   * answer, and reads as a bug under a picker that has just filed most of them
   * under other headings: the channel's own set is a few dozen of that, and the
   * rest is this viewer's collectibles and every channel they subscribe to. So
   * the line only claims the channel when the channel is all there is.
   */
  FCM.kickEmoteCountLine = function (store) {
    const names = Object.keys(store || {});
    const shared = names.filter((name) => FCM.isSharedKickEmote(store[name])).length;
    if (names.length <= shared) return `Loaded ${names.length} Kick emotes for this channel`;
    return `Loaded ${shared} Kick emotes for this channel, and ${names.length - shared} of your `
      + 'own — your collectibles and the channels you subscribe to';
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
