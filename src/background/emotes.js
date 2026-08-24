// Emote loading. Twitch's own emotes need no lookup — they arrive as id +
// position in the IRC tag — so this only covers the sets that have to be
// fetched: Kick's channel list and the third-party providers.
(function (FCM) {
  'use strict';

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

    async kickNative(slug) {
      try {
        return await FCM.kickApi.emotes(slug);
      } catch (e) {
        return {};
      }
    },
  };
})(self.FCM);
