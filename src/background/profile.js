// Who a chatter is, for the card the overlay opens when their name is clicked.
//
// Deliberately modest about what it claims to know. The things people most want
// off a name — how long they have followed, whether they are subscribed and at
// what tier — are things Twitch will only tell the broadcaster or their
// moderators, and Kick will not tell anyone. Asking for them from a viewer's
// token gets a 401, not an answer.
//
// So this fetches the part that is genuinely public, and the overlay points at
// the site's own card for the rest. That card is drawn by a logged-in session
// and can show what no token here is allowed to see.
(function (FCM) {
  'use strict';

  // A profile is a join date and an avatar; neither changes while anyone is
  // watching. Caching them keeps clicking through a conversation from being one
  // request per click.
  const CACHE_LIMIT = 200;
  const CACHE_TTL_MS = 30 * 60 * 1000;
  const cache = new Map();

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
    return hit.value;
  }

  function cachePut(key, value) {
    cache.delete(key);
    cache.set(key, { value, at: Date.now() });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  /**
   * When a Twitch account was made, asked of the site's own GraphQL.
   *
   * Twitch answers this for anyone, with no token at all — which is why it is
   * asked here rather than through Helix. Helix would need a connected account
   * for the same fact, and the day someone joined Twitch should not be behind
   * a sign-in when Twitch itself hands it to a stranger.
   */
  async function twitchCreatedAt(login) {
    const res = await FCM.getJson(FCM.TWITCH_GQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-ID': FCM.TWITCH_GQL_CLIENT_ID,
      },
      body: JSON.stringify({
        query: 'query FCMUserCreated($login: String!) '
          + '{ user(login: $login) { id login displayName createdAt } }',
        variables: { login },
      }),
    });
    // Twitch answers a name nobody has with HTTP 200 and a null user, so a null
    // *response* is a different thing: nobody answered at all. Flattening the
    // two meant five seconds of bad wifi were remembered for half an hour as
    // "no account found by that name".
    if (!res) return { reason: 'refused' };
    const user = res.data && res.data.user;
    return user || null;
  }

  async function twitchProfile(login, broadcasterId, canModerate) {
    const record = await FCM.auth.get('twitch');

    // No account connected. Twitch's own GraphQL still gives the join date to
    // anyone, which is the part of this worth having without a sign-in.
    if (!record || !record.accessToken) {
      const basic = await twitchCreatedAt(login);
      if (basic && basic.reason) return basic;
      if (!basic) return { reason: 'not-found' };
      return {
        displayName: basic.displayName || login,
        avatar: '',
        createdAt: basic.createdAt || '',
        accountType: '',
        about: '',
        followedAt: '',
        followedReason: 'not-connected',
      };
    }

    // With a token, Helix carries the join date as well, so the GraphQL call is
    // not made at all — one request per lookup rather than two.
    const headers = {
      Authorization: `Bearer ${record.accessToken}`,
      'Client-Id': record.clientId,
    };
    const data = await FCM.getJson(
      `${FCM.TWITCH_HELIX}/users?login=${encodeURIComponent(login)}`,
      { headers }
    );
    // Same distinction as above: Helix answers an unknown login with an empty
    // list, and answers nothing at all when it could not be reached.
    if (!data) return { reason: 'refused' };
    const user = Array.isArray(data.data) ? data.data[0] : null;
    if (!user) return { reason: 'not-found' };

    const profile = {
      displayName: user.display_name || login,
      avatar: user.profile_image_url || '',
      createdAt: user.created_at || '',
      // Twitch's own word for the account, when there is one. Partners and staff
      // are worth surfacing; a blank type is an ordinary account and is not worth
      // a line of its own.
      accountType: user.broadcaster_type || user.type || '',
      about: user.description || '',
      followedAt: '',
      followedReason: '',
    };

    if (!broadcasterId) {
      profile.followedReason = 'no-channel';
      return profile;
    }

    // Twitch answers this only for the broadcaster and their moderators. For
    // everyone else the call succeeds and comes back empty — the same shape it
    // returns for somebody who simply does not follow.
    //
    // Those two are opposite answers and must not be told the same way, so
    // whether this viewer can moderate here decides which one it is. A mod
    // seeing an empty list is being told the person does not follow; anyone
    // else is being told nothing at all.
    const follows = await FCM.getJson(
      `${FCM.TWITCH_HELIX}/channels/followers`
      + `?broadcaster_id=${encodeURIComponent(broadcasterId)}`
      + `&user_id=${encodeURIComponent(user.id)}`,
      { headers }
    );
    if (!follows || !Array.isArray(follows.data)) {
      profile.followedReason = 'refused';
      return profile;
    }
    const entry = follows.data[0];
    if (entry && entry.followed_at) {
      profile.followedAt = entry.followed_at;
    } else {
      profile.followedReason = canModerate ? 'not-following' : 'not-a-moderator';
    }
    return profile;
  }

  async function kickProfile(slug, channel) {
    // Kick answers this for anyone, with no token at all: when the account was
    // made, when they started following this channel, and how long they have
    // subscribed. It is the same record Kick's own card is drawn from.
    if (channel) {
      const scoped = await FCM.getJson(
        `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`
        + `/users/${encodeURIComponent(slug)}`,
        { headers: { Accept: 'application/json' } }
      );
      if (scoped && (scoped.created_at || scoped.following_since)) {
        return {
          displayName: scoped.username || slug,
          avatar: scoped.profile_pic || '',
          createdAt: scoped.created_at || '',
          followedAt: scoped.following_since || '',
          followedReason: '',
          accountType: scoped.is_channel_owner ? 'channel owner'
            : scoped.is_staff ? 'staff' : '',
          subscribedMonths: Number(scoped.subscribed_for) || 0,
        };
      }
    }

    // No channel to ask about, or Kick refused. The channel record still names
    // the account, which is better than an empty card.
    const info = await FCM.kickApi.channel(slug);
    // Kick answers a channel that does not exist and a request its edge refused
    // in exactly the same way, so this is read as the one that may come back.
    // Being wrong the other way pins "no account by that name" on a real person
    // for half an hour.
    if (!info) return { reason: 'refused' };
    const user = info.user || {};
    return {
      displayName: FCM.usernameFrom(user) || slug,
      avatar: user.profile_pic || info.profile_pic || '',
      createdAt: '',
      followedAt: '',
      followedReason: channel ? 'refused' : 'no-channel',
      accountType: info.verified ? 'verified' : '',
      about: (user.bio || info.bio || ''),
    };
  }

  /**
   * What is publicly known about a chatter.
   *
   * Never throws and never rejects: this is decoration on a menu that has to
   * open instantly whatever the network is doing, so a failure comes back as a
   * reason the overlay can show rather than as an error it has to handle.
   *
   * @returns {Promise<{displayName?: string, avatar?: string, createdAt?: string,
   *   accountType?: string, about?: string, reason?: string}>}
   */
  // Answers that stop being true on their own, and so must not be remembered.
  // Connecting an account or a network coming back turns every one of these
  // into a different answer, and a viewer who signs in should not keep being
  // told to sign in for the next half hour.
  const TRANSIENT = new Set(['not-connected', 'refused', 'failed', 'no-channel']);

  function worthCaching(value) {
    if (!value) return false;
    if (TRANSIENT.has(value.reason)) return false;
    // A whole-profile answer is only as good as its weakest half: one that
    // could not reach the follow date is re-asked rather than pinned for half
    // an hour with a reason that may already be stale.
    if (TRANSIENT.has(value.followedReason)) return false;
    return true;
  }

  FCM.lookupProfile = async function (platform, username, channel, canModerate) {
    const name = FCM.normalizeChannel(username);
    if (!name || !FCM.PLATFORMS.includes(platform)) return { reason: 'bad-request' };
    // Keyed by the channel too. The follow date is about this pair of people,
    // so the same viewer looked up in two channels is two different answers.
    const key = `${platform}:${name}:${channel || ''}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    let value;
    try {
      value = platform === 'twitch'
        ? await twitchProfile(name, channel, canModerate)
        : await kickProfile(name, channel);
    } catch (e) {
      return { reason: 'failed' };
    }
    // A name the platform does not know is worth remembering too, so it is not
    // re-asked on every click — but only answers that will still be true later.
    if (worthCaching(value)) cachePut(key, value);
    return value;
  };
})(self.FCM);
