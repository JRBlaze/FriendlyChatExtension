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
    const res = await FCM.getJson(FCM.TWITCH_GQL, {
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
    const user = res && res.data && res.data.user;
    return user || null;
  }

  async function twitchProfile(login, broadcasterId) {
    const record = await FCM.auth.get('twitch');
    const basic = await twitchCreatedAt(login);
    if (!basic && !record) return { reason: 'not-found' };

    const profile = {
      displayName: (basic && basic.displayName) || login,
      avatar: '',
      createdAt: (basic && basic.createdAt) || '',
      accountType: '',
      about: '',
      followedAt: '',
      followedReason: '',
    };

    // Everything past the join date needs the connected account: the avatar and
    // Twitch's own word for the account come from Helix, and the follow date
    // needs a token Twitch will accept for this channel.
    if (!record || !record.accessToken) {
      profile.followedReason = 'not-connected';
      return profile.createdAt ? profile : { reason: 'not-connected' };
    }
    const headers = {
      Authorization: `Bearer ${record.accessToken}`,
      'Client-Id': record.clientId,
    };

    const data = await FCM.getJson(
      `${FCM.TWITCH_HELIX}/users?login=${encodeURIComponent(login)}`,
      { headers }
    );
    const user = data && Array.isArray(data.data) ? data.data[0] : null;
    if (!user) return profile.createdAt ? profile : { reason: 'not-found' };

    profile.displayName = user.display_name || profile.displayName;
    profile.avatar = user.profile_image_url || '';
    profile.createdAt = profile.createdAt || user.created_at || '';
    // Twitch's own word for the account, when there is one. Partners and staff
    // are worth surfacing; a blank type is an ordinary account and is not worth
    // a line of its own.
    profile.accountType = user.broadcaster_type || user.type || '';
    profile.about = user.description || '';

    // Twitch will only say when someone started following if the account asking
    // runs the channel or moderates it — that is the rule on the endpoint, not
    // a matter of scopes alone. For everyone else the call succeeds and comes
    // back empty, so the absence is reported as "not allowed to know" rather
    // than as "they do not follow", which would be a lie.
    if (!broadcasterId) {
      profile.followedReason = 'no-channel';
      return profile;
    }
    const follows = await FCM.getJson(
      `${FCM.TWITCH_HELIX}/channels/followers`
      + `?broadcaster_id=${encodeURIComponent(broadcasterId)}`
      + `&user_id=${encodeURIComponent(user.id)}`,
      { headers }
    );
    const entry = follows && Array.isArray(follows.data) ? follows.data[0] : null;
    if (entry && entry.followed_at) profile.followedAt = entry.followed_at;
    else if (!follows) profile.followedReason = 'refused';
    else if (typeof follows.total === 'number' && !follows.data.length) {
      // The shape Twitch returns to someone who may not see the list: a total
      // and nothing else. Indistinguishable from "does not follow" except that
      // a viewer who cannot moderate was never going to be told either way.
      profile.followedReason = 'not-a-moderator';
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
    if (!info) return { reason: 'not-found' };
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
  FCM.lookupProfile = async function (platform, username, channel) {
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
        ? await twitchProfile(name, channel)
        : await kickProfile(name, channel);
    } catch (e) {
      return { reason: 'failed' };
    }
    // A miss is worth remembering too, or a name the platform does not know is
    // re-asked on every click.
    cachePut(key, value);
    return value;
  };
})(self.FCM);
