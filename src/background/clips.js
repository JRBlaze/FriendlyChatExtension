// What a linked clip is, for the card drawn under the message that linked it.
(function (FCM) {
  'use strict';

  // A clip does not change once made, so an answer is good for a long while,
  // and one that came back empty — deleted, private, never existed — is worth
  // remembering too, or every repeat of the link would ask again.
  const TTL_MS = 60 * 60 * 1000;
  const CACHE_LIMIT = 300;
  const cache = new Map(); // "platform:id" -> { at, clip }

  function remember(key, clip) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), clip });
    return clip;
  }

  // Only ever a picture from the platform's own hosts, over https. The address
  // goes into an <img> in the feed, and a platform answering with something
  // else is not something the feed should draw.
  const THUMB_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(jtvnw\.net|twitch\.tv|kick\.com)\//i;
  const thumb = (url) => (THUMB_HOSTS.test(String(url || '')) ? String(url) : '');

  const TWITCH_CLIP_QUERY = 'query($s:ID!){clip(slug:$s){slug title thumbnailURL durationSeconds'
    + ' viewCount broadcaster{displayName login}}}';

  // Twitch answers this for anyone: the same signed-out GQL route the channel
  // lookup uses.
  async function twitchClip(slug) {
    const body = await FCM.getJson(FCM.TWITCH_GQL_URL, {
      method: 'POST',
      headers: { 'Client-Id': FCM.TWITCH_GQL_CLIENT_ID, 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ query: TWITCH_CLIP_QUERY, variables: { s: slug } }),
    });
    const clip = body && body.data && body.data.clip;
    if (!clip || typeof clip !== 'object') return null;
    const who = clip.broadcaster || {};
    const id = String(clip.slug || slug);
    return {
      platform: 'twitch',
      id,
      url: `https://clips.twitch.tv/${encodeURIComponent(id)}`,
      title: String(clip.title || ''),
      thumbnail: thumb(clip.thumbnailURL),
      duration: Number(clip.durationSeconds) || 0,
      channel: String(who.displayName || who.login || ''),
      views: Number(clip.viewCount) || 0,
    };
  }

  // Kick's clip record is public. The thumbnail lives on a sharded host that
  // cannot be derived from the id, which is why this has to ask at all.
  async function kickClip(id) {
    const body = await FCM.getJson(
      `https://kick.com/api/v2/clips/${encodeURIComponent(id)}`,
      { headers: { Accept: 'application/json' }, credentials: 'omit' }
    );
    const clip = body && (body.clip || body);
    if (!clip || typeof clip !== 'object' || !clip.id) return null;
    const channel = clip.channel || {};
    const slug = String(channel.slug || channel.username || '').toLowerCase();
    const clipId = encodeURIComponent(String(clip.id));
    return {
      platform: 'kick',
      id: String(clip.id),
      url: slug
        ? `https://kick.com/${encodeURIComponent(slug)}/clips/${clipId}`
        : `https://kick.com/clips/${clipId}`,
      title: String(clip.title || ''),
      thumbnail: thumb(clip.thumbnail_url),
      duration: Number(clip.duration) || 0,
      channel: String(channel.username || channel.slug || ''),
      views: Number(clip.view_count || clip.views) || 0,
    };
  }

  /**
   * @returns {Promise<object|null>} the clip, or null when the platform has
   *   nothing to say about it — which the feed treats as "no card", never as
   *   an error worth a row.
   */
  FCM.lookupClip = async function (platform, id) {
    const clean = String(id || '').trim();
    if (!clean || !/^[A-Za-z0-9_-]+$/.test(clean)) return null;
    const key = `${platform}:${clean}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.clip;
    let clip = null;
    try {
      if (platform === 'twitch') clip = await twitchClip(clean);
      else if (platform === 'kick') clip = await kickClip(clean);
    } catch (e) {
      clip = null;
    }
    return remember(key, clip);
  };
})(self.FCM);
