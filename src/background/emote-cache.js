// Last time's emote lists, kept so a channel you have been in before has its
// emotes the moment you arrive rather than several round-trips later.
//
// Four providers are asked on every join — 7TV twice, BTTV, FFZ — plus up to
// sixty pages of Helix for an account subscribed to a lot of channels. Until
// all of that lands the picker has nothing in it and messages render emote
// names as plain text, which on a slow connection is the first several seconds
// of every visit.
//
// The cache is never the final answer. It is sent immediately and the real
// fetch still runs, so anything added since last time arrives a moment later
// and anything removed stops being offered on the next visit. What it buys is
// the gap at the start, which is exactly where it was worst.
(function (FCM) {
  'use strict';

  // Bounded because these are the largest thing this extension stores: a big
  // account's Twitch emotes alone run to a megabyte of JSON, and storage.local
  // is ten. Least recently used goes first.
  const MAX_CHANNELS = 6;
  // Old enough to be worth distrusting on its own. Nothing depends on this —
  // the fetch corrects whatever is stale — so it only stops the store filling
  // with channels that were visited once a year ago.
  const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  // A store larger than this is not written at all. One runaway channel must
  // not be able to push everything else out, or exceed the quota by itself.
  const MAX_ENTRIES_PER_STORE = 20000;

  /**
   * What identifies a cached list.
   *
   * The account is part of it because Twitch's answer to "which emotes may this
   * viewer use" is about the viewer as much as the channel — two people in the
   * same chat have different subscription emotes, and handing one of them the
   * other's would offer emotes they cannot send.
   */
  function cacheKey(platform, channel, accountId) {
    return `${platform}:${FCM.normalizeChannel(channel)}:${accountId || ''}`;
  }

  async function readAll() {
    try {
      const stored = await chrome.storage.local.get(FCM.STORAGE_KEYS.emoteCache);
      const all = stored[FCM.STORAGE_KEYS.emoteCache];
      return (all && typeof all === 'object') ? all : {};
    } catch (e) {
      return {};
    }
  }

  // Writes are read-modify-write over one storage key, so they are queued
  // rather than raced. See write() below.
  let writeChain = Promise.resolve();

  FCM.emoteCache = {
    /**
     * The emotes last seen for this channel, or null.
     *
     * Never throws and never rejects: an unreadable cache is the same as an
     * empty one, and the fetch behind it is what the extension actually relies
     * on.
     *
     * @returns {Promise<{native: object, thirdparty: object}|null>}
     */
    async read(platform, channel, accountId) {
      const all = await readAll();
      const hit = all[cacheKey(platform, channel, accountId)];
      if (!hit || !hit.kinds) return null;
      if (!hit.at || Date.now() - hit.at > MAX_AGE_MS) return null;
      return hit.kinds;
    },

    /**
     * Remembers a store for next time, alongside whatever else is cached for
     * this channel.
     *
     * Merged rather than replaced, because the two kinds arrive from different
     * requests at different moments and writing one must not forget the other.
     *
     * Which is exactly why the writes are chained. Every one of them is
     * read-modify-write over the whole cache, and the two kinds for a single
     * join are fetched at the same time — so both used to read the map before
     * either had written to it, and whichever finished last stored a copy with
     * only its own half in it. The merge this comment describes never happened
     * in the one case it was written for. Two tabs restoring at once lose a
     * whole channel the same way.
     */
    write(platform, channel, accountId, kind, store) {
      if (!store || !Object.keys(store).length) return writeChain;
      if (Object.keys(store).length > MAX_ENTRIES_PER_STORE) return writeChain;
      writeChain = writeChain.then(async () => {
        const all = await readAll();
        const key = cacheKey(platform, channel, accountId);
        const existing = all[key] || { kinds: {} };
        all[key] = {
          at: Date.now(),
          kinds: { ...existing.kinds, [kind]: store },
        };
        // Oldest first, so the channels someone actually watches stay.
        const keys = Object.keys(all).sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
        while (keys.length > MAX_CHANNELS) delete all[keys.shift()];
        await chrome.storage.local.set({ [FCM.STORAGE_KEYS.emoteCache]: all });
      }).catch(() => {
        // A cache that cannot be written costs a slower start and nothing else,
        // and must not stop the writes queued behind it.
      });
      return writeChain;
    },

  };
})(self.FCM);
