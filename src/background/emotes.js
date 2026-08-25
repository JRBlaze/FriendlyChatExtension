// Emote loading.
//
// Incoming Twitch messages need no lookup — an emote arrives as an id and a
// position in the IRC tag, so it renders without anyone having fetched a list.
// The picker is a different question: it can only offer what it has been told
// about, and for a long time it was told about nothing from Twitch at all.
//
// What a viewer may use comes from four places, and the difference between them
// matters. Global emotes everyone has. Channel emotes belong to the channel and
// not every viewer can send them. The user endpoint is the authoritative answer
// to "what may *this* account use" — subs, follows, bits tiers, hype train
// rewards, Turbo, the lot — and needs the `user:read:emotes` scope. And the
// emote-set ids Twitch hands out in USERSTATE cover the same ground from the
// other direction, which is how Chatterino does it, and work with any user
// token. All four are asked and merged, because each one knows something the
// others do not.
(function (FCM) {
  'use strict';

  const TWITCH_EMOTE_CDN = 'https://static-cdn.jtvnw.net/emoticons/v2';
  // Helix takes at most 25 set ids per request, and pages user emotes 100 at a
  // time. The page cap is a guard against a cursor that never terminates, at a
  // ceiling no real account comes close to.
  const EMOTE_SET_CHUNK = 25;
  const MAX_EMOTE_PAGES = 60;

  // What a Helix emote record says about where it came from, which is what the
  // picker groups by. Null when the record says nothing, so the caller can
  // supply the label it already knows.
  function twitchEmoteSource(e) {
    if (e.emote_type === 'subscriptions') return 'Twitch Sub';
    if (e.emote_type === 'follower') return 'Twitch Follow';
    if (e.emote_type === 'bitstier') return 'Twitch Bits';
    if (e.emote_type === 'hypetrain') return 'Twitch Hype Train';
    if (e.emote_type === 'rewards' || e.emote_type === 'channelpoints') return 'Twitch Rewards';
    if (e.emote_type === 'prime' || e.emote_type === 'turbo') return 'Twitch Prime';
    if (e.emote_type === 'smilies') return 'Twitch Global';
    if (e.emote_type === 'globals' || e.owner_id === '0') return 'Twitch Global';
    if (e.emote_type || e.owner_id !== undefined) return 'Twitch';
    return null;
  }

  FCM.emoteLoader = {
    /**
     * 7TV for both platforms, BTTV and FFZ for Twitch.
     *
     * Every provider keys channel sets by the platform's own numeric user id,
     * never the channel name — including 7TV's Kick integration, which 404s if
     * you hand it a slug. Requests run in parallel and write into one store, so
     * a slow or failing provider never blocks or erases the others.
     *
     * @param {string} platform      'twitch' | 'kick'
     * @param {string} channelLogin  channel name, used only for logging context
     * @param {string} platformUserId numeric user id on that platform
     */
    async thirdParty(platform, channelLogin, platformUserId) {
      const store = {};
      const put = (name, url, source) => {
        if (!name || !url) return;
        if (!store[name]) store[name] = { url, source };
      };

      const add7tv = (payload) => {
        if (!payload) return;
        const emotes = payload.emotes
          || (payload.emote_set && payload.emote_set.emotes)
          || [];
        emotes.forEach((e) => put(e.name, FCM.sevenTvUrl(e), '7TV'));
      };

      const addFfz = (data) => {
        if (!data) return;
        Object.values(data.sets || {}).forEach((set) => {
          (set.emoticons || []).forEach((e) => {
            const url = (e.urls && (e.urls[2] || e.urls[1] || e.urls[4])) || null;
            put(e.name, url && url.startsWith('//') ? `https:${url}` : url, 'FFZ');
          });
        });
      };

      const jobs = [
        FCM.getJson('https://7tv.io/v3/emote-sets/global').then(add7tv),
      ];

      if (platformUserId) {
        jobs.push(FCM.getJson(
          `https://7tv.io/v3/users/${platform}/${encodeURIComponent(platformUserId)}`
        ).then(add7tv));
      }

      if (platform === 'twitch') {
        if (platformUserId) {
          jobs.push(FCM.getJson(
            `https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(platformUserId)}`
          ).then((data) => {
            if (!data) return;
            [...(data.channelEmotes || []), ...(data.sharedEmotes || [])].forEach((e) => {
              put(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`, 'BTTV');
            });
          }));
          jobs.push(FCM.getJson(
            `https://api.frankerfacez.com/v1/room/id/${encodeURIComponent(platformUserId)}`
          ).then(addFfz));
        }
        jobs.push(FCM.getJson('https://api.betterttv.net/3/cached/emotes/global').then((list) => {
          (list || []).forEach((e) => put(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`, 'BTTV'));
        }));
        jobs.push(FCM.getJson('https://api.frankerfacez.com/v1/set/global').then(addFfz));
      }

      await Promise.all(jobs.map((job) => job.catch(() => null)));
      return store;
    },

    /**
     * Every Twitch emote this viewer may use, as far as each source can say.
     *
     * The four fetches write into one store and each is allowed to fail on its
     * own: a viewer with no account still gets globals, and one whose token is
     * missing the emote scope still gets everything the USERSTATE set ids
     * cover. Later writes do not overwrite earlier ones, so the most specific
     * label a record carried is the one that survives.
     *
     * @param {object} opts { clientId, token, userId, broadcasterId, setIds }
     * @returns {Promise<object>} name -> { url, source }
     */
    async twitchNative(opts) {
      const { clientId, token, userId, broadcasterId, setIds } = opts || {};
      const store = {};
      if (!clientId) return store;

      const headers = { 'Client-Id': clientId };
      if (token) headers.Authorization = `Bearer ${token}`;

      const put = (e, fallback) => {
        if (!e || !e.name || !e.id) return;
        if (store[e.name]) return;
        store[e.name] = {
          // 2.0 is the size the inline renderer uses, so the same emote is not
          // fetched twice at two different sizes.
          url: `${TWITCH_EMOTE_CDN}/${e.id}/default/dark/2.0`,
          source: twitchEmoteSource(e) || fallback || 'Twitch',
        };
      };

      const get = (url) => FCM.getJson(url, { headers });

      const jobs = [
        get(`${FCM.TWITCH_HELIX}/chat/emotes/global`)
          .then((d) => (d && d.data ? d.data : []).forEach((e) => put(e, 'Twitch Global'))),
      ];

      if (broadcasterId) {
        jobs.push(
          get(`${FCM.TWITCH_HELIX}/chat/emotes?broadcaster_id=${encodeURIComponent(broadcasterId)}`)
            .then((d) => (d && d.data ? d.data : []).forEach((e) => put(e, 'Twitch Channel')))
        );
      }

      // The authoritative list, and the only one that knows about the channels
      // this account subscribes to elsewhere.
      if (token && userId) {
        jobs.push((async () => {
          let cursor = '';
          for (let page = 0; page < MAX_EMOTE_PAGES; page++) {
            const qs = `user_id=${encodeURIComponent(userId)}`
              + (broadcasterId ? `&broadcaster_id=${encodeURIComponent(broadcasterId)}` : '')
              + (cursor ? `&after=${encodeURIComponent(cursor)}` : '');
            const data = await get(`${FCM.TWITCH_HELIX}/chat/emotes/user?${qs}`);
            if (!data || !data.data) break;
            data.data.forEach((e) => put(e));
            cursor = (data.pagination && data.pagination.cursor) || '';
            if (!cursor) break;
          }
        })());
      }

      // The same ground from the other direction, and it needs no extra scope.
      const sets = Array.from(new Set((setIds || []).filter(Boolean)));
      if (token && sets.length) {
        for (let i = 0; i < sets.length; i += EMOTE_SET_CHUNK) {
          const chunk = sets.slice(i, i + EMOTE_SET_CHUNK);
          const qs = chunk.map((id) => `emote_set_id=${encodeURIComponent(id)}`).join('&');
          jobs.push(
            get(`${FCM.TWITCH_HELIX}/chat/emotes/set?${qs}`)
              .then((d) => (d && d.data ? d.data : []).forEach((e) => put(e)))
          );
        }
      }

      await Promise.all(jobs.map((job) => job.catch(() => null)));
      return store;
    },

    async kickNative(slug) {
      try {
        return await FCM.kickApi.emotes(slug);
      } catch (e) {
        return {};
      }
    },
  };
})(self.FCM);
