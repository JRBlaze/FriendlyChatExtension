// Platform lookups and cross-platform channel matching.
//
// This is what powers the core feature: while you watch a Twitch channel it
// works out whether the same person also streams on Kick (and vice versa), and
// whether that other channel is live right now.
(function (FCM) {
  'use strict';

  // ── Kick ────────────────────────────────────────────────────────────────────

  // Channel lookups are cached so a second tab on the same stream costs nothing,
  // but the worker can live for days across dozens of channels, so the caches
  // are bounded rather than growing for the life of the browser.
  const CHANNEL_CACHE_LIMIT = 120;

  function cachePut(cache, key, value) {
    // Re-inserting moves the key to the end, which makes the first key the
    // least recently written — that is the one to drop.
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > CHANNEL_CACHE_LIMIT) {
      cache.delete(cache.keys().next().value);
    }
  }

  const kickChannelCache = new Map(); // slug -> { at, data }

  FCM.kickApi = {
    /**
     * The channel record, and whether Kick answered at all.
     *
     * The second half only matters to callers that write the answer down; the
     * rest use `channel()` below and see exactly what they always did.
     */
    async probe(slug, { maxAge = FCM.LIVE_CACHE_TTL_MS, token = null } = {}) {
      const key = FCM.normalizeChannel(slug);
      if (!key) return { reachable: true, data: null };
      // An authenticated read carries this viewer's moderator flags, which an
      // anonymous cached copy does not, so it never reuses the cache.
      const hit = token ? null : kickChannelCache.get(key);
      if (hit && Date.now() - hit.at < maxAge) {
        return { reachable: hit.reachable !== false, data: hit.data };
      }

      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const init = { headers, credentials: 'omit' };

      // v2 carries the livestream object; v1 is the older shape and is only a
      // fallback for when v2 is unavailable.
      let res = await FCM.getJsonResult(`https://kick.com/api/v2/channels/${encodeURIComponent(key)}`, init);
      if (!res.data || !res.data.chatroom) {
        const older = await FCM.getJsonResult(`https://kick.com/api/v1/channels/${encodeURIComponent(key)}`, init);
        // Reachable if either version answered: one being retired is not the
        // network being out.
        res = { reachable: res.reachable || older.reachable, data: older.data || res.data };
      }
      const data = res.data;
      if (!data || (!data.chatroom && !data.id)) {
        if (!token) {
          cachePut(kickChannelCache, key, { at: Date.now(), data: null, reachable: res.reachable });
        }
        return { reachable: res.reachable, data: null };
      }
      if (!token) cachePut(kickChannelCache, key, { at: Date.now(), data, reachable: true });
      return { reachable: true, data };
    },

    async channel(slug, opts) {
      return (await FCM.kickApi.probe(slug, opts)).data;
    },

    summarize(slug, data) {
      if (!data) return { platform: 'kick', channel: slug, exists: false, live: false };
      const ls = data.livestream || null;
      const user = data.user || {};
      return {
        platform: 'kick',
        channel: data.slug || slug,
        exists: true,
        live: !!ls,
        displayName: user.username || data.slug || slug,
        avatar: user.profile_pic || '',
        title: ls ? (ls.session_title || '') : '',
        viewers: ls ? Number(ls.viewer_count || 0) : 0,
        category: ls && Array.isArray(ls.categories) && ls.categories[0]
          ? (ls.categories[0].name || '') : '',
        url: `https://kick.com/${data.slug || slug}`,
      };
    },

    async emotes(slug) {
      const key = FCM.normalizeChannel(slug);
      // Two published paths for the same list; the second is the newer one.
      const urls = [
        `https://kick.com/emotes/${encodeURIComponent(key)}`,
        `https://kick.com/api/v2/channels/${encodeURIComponent(key)}/emotes`,
      ];
      for (const url of urls) {
        const data = await FCM.getJson(url, {
          headers: { Accept: 'application/json' },
          credentials: 'omit',
        });
        const store = FCM.parseKickEmotePayload(data, slug);
        if (Object.keys(store).length) return store;
      }
      return {};
    },
  };

  // ── Twitch ──────────────────────────────────────────────────────────────────

  const twitchChannelCache = new Map();

  const TWITCH_CHANNEL_QUERY =
    'query($l:String!){user(login:$l){id login displayName profileImageURL(width:70)'
    + ' stream{id viewersCount title createdAt game{name}}}}';

  FCM.twitchApi = {
    // As with Kick: the record, plus whether Twitch answered at all.
    async probe(login, { maxAge = FCM.LIVE_CACHE_TTL_MS } = {}) {
      const key = FCM.normalizeChannel(login);
      if (!key) return { reachable: true, data: null };
      const hit = twitchChannelCache.get(key);
      if (hit && Date.now() - hit.at < maxAge) {
        return { reachable: hit.reachable !== false, data: hit.data };
      }

      let user = null;
      // Twitch answers an unknown login with a 200 and a null user, so getting
      // that far is itself the answer.
      let answered = false;
      try {
        const r = await fetch(FCM.TWITCH_GQL_URL, {
          method: 'POST',
          headers: {
            'Client-Id': FCM.TWITCH_GQL_CLIENT_ID,
            'Content-Type': 'application/json',
          },
          credentials: 'omit',
          body: JSON.stringify({ query: TWITCH_CHANNEL_QUERY, variables: { l: key } }),
        });
        if (r.ok) {
          const body = await r.json();
          user = body && body.data ? body.data.user : null;
          answered = true;
        }
      } catch (e) {
        user = null;
      }

      // If the ad-hoc query is ever refused, the persisted UseLive operation
      // still answers the only question that really matters: live or not.
      if (user === null) {
        const fallback = await FCM.getJson(FCM.TWITCH_GQL_URL, {
          method: 'POST',
          headers: {
            'Client-Id': FCM.TWITCH_GQL_CLIENT_ID,
            'Content-Type': 'application/json',
          },
          credentials: 'omit',
          body: JSON.stringify([{
            operationName: 'UseLive',
            variables: { channelLogin: key },
            extensions: { persistedQuery: { version: 1, sha256Hash: FCM.TWITCH_USELIVE_HASH } },
          }]),
        });
        const entry = Array.isArray(fallback) ? fallback[0] : fallback;
        user = entry && entry.data ? entry.data.user : null;
        if (fallback) answered = true;
      }

      cachePut(twitchChannelCache, key, { at: Date.now(), data: user, reachable: answered });
      return { reachable: answered, data: user };
    },

    async channel(login, opts) {
      return (await FCM.twitchApi.probe(login, opts)).data;
    },

    summarize(login, user) {
      if (!user) return { platform: 'twitch', channel: login, exists: false, live: false };
      const stream = user.stream || null;
      return {
        platform: 'twitch',
        channel: user.login || login,
        exists: true,
        live: !!stream,
        displayName: user.displayName || user.login || login,
        avatar: user.profileImageURL || '',
        title: stream ? (stream.title || '') : '',
        viewers: stream ? Number(stream.viewersCount || 0) : 0,
        category: stream && stream.game ? (stream.game.name || '') : '',
        url: `https://www.twitch.tv/${user.login || login}`,
      };
    },

    /**
     * Global badges plus the channel's own, in one request.
     *
     * The old badges.twitch.tv host no longer resolves at all, and the Helix
     * badge endpoints need a user token, so GQL is the only route left that
     * works for a signed-out viewer.
     */
    async badges(channelLogin) {
      const out = { global: {}, channel: {} };

      const fresh = globalBadgeCache.data
        && Date.now() - globalBadgeCache.at < GLOBAL_BADGE_TTL_MS;
      const query = fresh
        ? 'query($l:String!){user(login:$l){broadcastBadges{setID version title imageURL(size:NORMAL)}}}'
        : 'query($l:String!){badges{setID version title imageURL(size:NORMAL)}'
          + 'user(login:$l){broadcastBadges{setID version title imageURL(size:NORMAL)}}}';

      const body = await FCM.getJson(FCM.TWITCH_GQL_URL, {
        method: 'POST',
        headers: { 'Client-Id': FCM.TWITCH_GQL_CLIENT_ID, 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ query, variables: { l: FCM.normalizeChannel(channelLogin) } }),
      });

      const data = body && body.data ? body.data : {};
      if (Array.isArray(data.badges)) {
        globalBadgeCache.data = badgeListToMap(data.badges);
        globalBadgeCache.at = Date.now();
      }
      out.global = globalBadgeCache.data || {};
      if (data.user && Array.isArray(data.user.broadcastBadges)) {
        out.channel = badgeListToMap(data.user.broadcastBadges);
      }
      return out;
    },
  };

  // Twitch's global badge list is ~1000 entries and changes rarely, so it is
  // fetched once and reused for every channel joined afterwards.
  const GLOBAL_BADGE_TTL_MS = 12 * 60 * 60 * 1000;
  const globalBadgeCache = { at: 0, data: null };

  // GQL returns a flat list; the renderer wants { setId: { version: badge } }.
  function badgeListToMap(list) {
    const map = {};
    list.forEach((b) => {
      if (!b || !b.setID || !b.version) return;
      if (!map[b.setID]) map[b.setID] = {};
      map[b.setID][b.version] = {
        image_url_1x: b.imageURL || '',
        title: b.title || b.setID,
      };
    });
    return map;
  }

  FCM.platformApi = {
    async summary(platform, channel, opts) {
      const api = platform === 'kick' ? FCM.kickApi : FCM.twitchApi;
      const res = await api.probe(channel, opts);
      // `reachable` says whether "not there" was an answer or a silence, which
      // is the difference between a miss worth remembering and one that is not.
      return { ...api.summarize(channel, res.data), reachable: res.reachable };
    },
  };

  // ── Counterpart matching ────────────────────────────────────────────────────

  // Pulls a channel slug out of any twitch.tv / kick.com URL found on the page.
  FCM.slugFromUrl = function (rawUrl, platform) {
    let url;
    try {
      url = new URL(String(rawUrl), 'https://example.invalid');
    } catch (e) {
      return null;
    }
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (platform === 'twitch' && !/(^|\.)twitch\.tv$/.test(host)) return null;
    if (platform === 'kick' && !/(^|\.)kick\.com$/.test(host)) return null;

    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    const slug = FCM.normalizeChannel(parts[0]);
    const reserved = platform === 'twitch' ? FCM.TWITCH_RESERVED : FCM.KICK_RESERVED;
    if (!slug || reserved.has(slug)) return null;
    if (!/^[a-z0-9_-]{2,30}$/.test(slug)) return null;
    return slug;
  };

  // Writes here are read-modify-write over one storage key, and both tabs of a
  // two-stream evening write to it — as does the options page. Chained so each
  // sees the last, the same way settings and tokens are.
  let linkWriteChain = Promise.resolve();

  function updateLinkStore(change) {
    linkWriteChain = linkWriteChain.then(async () => {
      const store = await readLinkStore();
      const next = change(store);
      if (next) await writeLinkStore(next);
      return next;
    }).catch(() => {
      // A pairing that could not be written down is re-derived next time, and
      // must not stop the writes queued behind it.
    });
    return linkWriteChain;
  }

  async function readLinkStore() {
    try {
      const stored = await chrome.storage.local.get(FCM.STORAGE_KEYS.links);
      return stored[FCM.STORAGE_KEYS.links] || {};
    } catch (e) {
      return {};
    }
  }

  // Kept from growing forever across years of browsing. Mappings the user typed
  // in themselves are never evicted; automatic ones are dropped oldest first.
  const LINK_STORE_LIMIT = FCM.LINK_STORE_LIMIT;

  function pruneLinkStore(store) {
    const keys = Object.keys(store);
    if (keys.length <= LINK_STORE_LIMIT) return store;
    const automatic = keys
      .filter((k) => !store[k].manual)
      .sort((a, b) => (store[a].at || 0) - (store[b].at || 0));
    let excess = keys.length - LINK_STORE_LIMIT;
    for (let i = 0; i < automatic.length && excess > 0; i++, excess--) {
      delete store[automatic[i]];
    }
    return store;
  }

  async function writeLinkStore(store) {
    try {
      await chrome.storage.local.set({ [FCM.STORAGE_KEYS.links]: pruneLinkStore(store) });
    } catch (e) {
      // A full or unavailable storage area only costs us the cache.
    }
  }

  // Stamped on every record written since page links became trustworthy, and
  // raised each time they turn out not to have been.
  //
  //   1 → 2  they were read at the moment the address changed, which on a
  //          single-page app is before the page they describe exists.
  //   2 → 3  they were read off the previous channel's about panel, which Kick
  //          leaves mounted and unrendered after a click through to the next
  //          streamer.
  //
  // A record cannot say which page it was scraped from, so anything written
  // before the fault was found has to be re-derived rather than carried
  // forward. Without this the pairing already written down keeps being served
  // for its full six hours, and the fix appears not to have worked.
  const LINK_RECORD_VERSION = 3;

  FCM.links = {
    key: (platform, channel) => `${platform}:${FCM.normalizeChannel(channel)}`,

    async get(platform, channel) {
      const store = await readLinkStore();
      return store[FCM.links.key(platform, channel)] || null;
    },

    // `manual` entries are the user's own mapping and never expire or get
    // overwritten by a guess.
    async set(platform, channel, record) {
      await updateLinkStore((store) => {
        store[FCM.links.key(platform, channel)] = {
          ...record, at: Date.now(), v: LINK_RECORD_VERSION,
        };
        return store;
      });
    },

    /**
     * Whether a remembered pairing is still worth believing.
     *
     * A mapping typed in by hand always is. An automatic one is trusted unless
     * it came from a page link and predates the fix that stopped those being
     * read off the wrong page — those cannot be told apart from the good ones,
     * so they are re-derived instead of carried forward.
     */
    trustworthy(record) {
      if (!record) return false;
      if (record.manual) return true;
      if (record.match !== 'page-link') return true;
      return (record.v || 0) >= LINK_RECORD_VERSION;
    },

    async clear(platform, channel) {
      const store = await readLinkStore();
      delete store[FCM.links.key(platform, channel)];
      await writeLinkStore(store);
    },

    /**
     * Records a mapping the viewer typed in — in both directions.
     *
     * Saying "this Twitch channel is that Kick channel" says exactly the same
     * thing about the Kick channel, and someone who has told us once should not
     * have to go and tell us again from the other side.
     *
     * It is also what stops the wrong merge. Where the names differ,
     * kick.com/chefsteve would otherwise fall through to the same-name guess
     * and connect twitch.tv/chefsteve, who is a different person entirely. The
     * reverse entry is what makes that channel already spoken for.
     *
     * Where this contradicts a mapping set earlier from the other side, the
     * newest one wins: two manual links that disagree cannot both be honoured,
     * and the one just typed is the one being looked at.
     *
     * An empty target says "this channel has no counterpart", which says
     * nothing about any other channel, so nothing is written the other way.
     */
    async setManual(platform, channel, target) {
      const self = FCM.normalizeChannel(channel);
      if (!self) return;
      const to = FCM.normalizeChannel(target);
      const other = FCM.otherPlatform(platform);
      const store = await readLinkStore();
      const at = Date.now();
      const key = FCM.links.key(platform, self);

      // Correcting a link that pointed somewhere else leaves that channel still
      // pointing back here. Retire that half first, or the store ends up
      // holding two mappings that disagree about the same pair.
      const previous = store[key];
      if (previous && previous.channel && FCM.normalizeChannel(previous.channel) !== to) {
        const staleKey = FCM.links.key(other, previous.channel);
        const stale = store[staleKey];
        if (stale && FCM.normalizeChannel(stale.channel) === self) delete store[staleKey];
      }

      store[key] = to
        ? { channel: to, match: 'manual', manual: true, at }
        : { none: true, manual: true, at };
      if (to) {
        store[FCM.links.key(other, to)] = { channel: self, match: 'manual', manual: true, at };
      }
      await writeLinkStore(store);
    },

    /**
     * Forgets a manual mapping and the half of it pointing back here.
     *
     * Only that half. A link from the other channel to somewhere else is a
     * separate decision somebody made, and undoing this one is no reason to
     * throw it away.
     */
    async clearPair(platform, channel) {
      const self = FCM.normalizeChannel(channel);
      if (!self) return;
      const store = await readLinkStore();
      const key = FCM.links.key(platform, self);
      const record = store[key];
      delete store[key];

      if (record && record.channel) {
        const otherKey = FCM.links.key(FCM.otherPlatform(platform), record.channel);
        const back = store[otherKey];
        if (back && FCM.normalizeChannel(back.channel) === self) delete store[otherKey];
      }
      await writeLinkStore(store);
    },

    async all() {
      return readLinkStore();
    },
  };

  /**
   * Works out which channel on the other platform belongs to the one being
   * watched, in confidence order:
   *   1. a mapping the user set by hand
   *   2. a cached result from a previous visit
   *   3. a link to the other platform found on the channel page itself
   *   4. the same name on the other platform
   *
   * @param {object} args { platform, channel, hints: string[] }
   * @returns {Promise<object|null>} summary of the counterpart channel
   */
  FCM.resolveCounterpart = async function ({ platform, channel, hints = [] }) {
    const other = FCM.otherPlatform(platform);
    const self = FCM.normalizeChannel(channel);
    if (!self) return null;

    const saved = await FCM.links.get(platform, self);
    if (saved && saved.manual) {
      if (saved.none) return null;
      const summary = await FCM.platformApi.summary(other, saved.channel);
      return summary.exists ? { ...summary, match: 'manual' } : null;
    }

    const candidates = [];
    const push = (slug, match) => {
      const norm = FCM.normalizeChannel(slug);
      if (norm && !candidates.some((c) => c.slug === norm)) candidates.push({ slug: norm, match });
    };

    // Links the streamer put on their own channel page are the strongest signal
    // short of a mapping set by hand, so they are tried first — including ahead
    // of what was worked out last time.
    //
    // They used to come second, behind the remembered answer, which is how a
    // wrong pairing outlived the mistake that made it: once written down it won
    // for six hours against the page that disagreed with it. Trying the page
    // first is also what lets one already written down be corrected.
    hints.forEach((href) => push(FCM.slugFromUrl(href, other), 'page-link'));

    const fresh = saved && !saved.manual && FCM.links.trustworthy(saved)
      && Date.now() - (saved.at || 0) < FCM.LINK_CACHE_TTL_MS;
    if (fresh && saved.none && !candidates.length) return null;
    if (fresh && !saved.none) push(saved.channel, saved.match || 'cache');

    push(self, 'same-name');

    let everyoneAnswered = true;
    for (const candidate of candidates) {
      const summary = await FCM.platformApi.summary(other, candidate.slug);
      if (summary.reachable === false) everyoneAnswered = false;
      if (summary.exists) {
        // Only written when it is news. Re-writing on every visit reset the
        // clock, so a guess made once was renewed each time it was used and
        // could never expire — a wrong one included, which is how one survived
        // its own six-hour life indefinitely.
        const unchanged = saved && !saved.none
          && FCM.normalizeChannel(saved.channel) === FCM.normalizeChannel(summary.channel);
        if (!unchanged) {
          await FCM.links.set(platform, self, { channel: summary.channel, match: candidate.match });
        }
        return { ...summary, match: candidate.match };
      }
    }

    // Remember the miss too, so every page view does not re-probe the same name.
    //
    // Only when somebody actually said no. A lookup that never got through says
    // nothing about whether this streamer is on the other platform, and writing
    // it down as "there is nobody" stopped the merge being offered for the next
    // six hours — for a network blip that had already passed. Re-probing on the
    // next view is much the cheaper mistake.
    if (everyoneAnswered) await FCM.links.set(platform, self, { none: true });
    return null;
  };
})(self.FCM);
