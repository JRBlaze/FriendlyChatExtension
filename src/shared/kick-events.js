// Kick Pusher event helpers, ported from Friendly Chat.
(function (FCM) {
  'use strict';

  // These take whatever arrived on the socket, so each one coerces rather than
  // relying on a default parameter: a default only covers `undefined`, and a
  // Pusher frame can carry a literal null.
  FCM.isPusherProtocolEvent = function (eventName) {
    const name = String(eventName || '');
    return name.startsWith('pusher:') || name.startsWith('pusher_internal:');
  };

  // Kick namespaces its events "App\Events\NameEvent".
  function kickEventShortName(eventName) {
    return String(eventName || '').replace(/^App\\Events\\/, '').replace(/Event$/, '');
  }

  /**
   * What Kick says about this viewer's own standing in a channel, out of the
   * `channels/<slug>/me` record.
   *
   * Kick will only answer that question to the browser session that asks it —
   * an OAuth token from its public API is not what that endpoint reads, and a
   * request carrying no session cookie is answered "Unauthenticated". Which is
   * why the channel record the worker already fetches cannot say it: that
   * record describes the channel, not the person looking at it. See
   * `loadKickStanding` in the worker for who asks, and from where.
   *
   * Kick documents none of these field names, so every plausible spelling is
   * checked — and the answer is only ever used to *offer* the moderation
   * tools, never to take them away. Guessing a name wrong then costs a viewer
   * nothing they already had, which is the right way round for a guess.
   *
   * @returns {{known: boolean, canModerate: boolean, username: string}}
   *   `known` is false for anything that is not an answer about somebody: no
   *   session, a challenge page, a body that was not JSON.
   */
  FCM.readKickStanding = function (payload) {
    const data = (payload && typeof payload === 'object' && !Array.isArray(payload))
      ? payload : null;
    const none = { known: false, canModerate: false, username: '' };
    if (!data) return none;
    // A message and nothing else — "Unauthenticated." — is Kick refusing to
    // say rather than saying no.
    if (data.message !== undefined && data.id === undefined
      && data.username === undefined && data.slug === undefined) return none;

    const yes = (v) => v === true || v === 1 || v === '1' || v === 'true';
    // Every spelling of "this viewer runs this room". Staff is deliberately
    // not among them: it is a Kick-wide role rather than a claim about this
    // channel, and the row this turns on says the channel.
    const FLAGS = ['is_moderator', 'is_broadcaster', 'is_channel_owner', 'is_owner',
      'is_super_admin'];
    const ROLE_WORDS = /^(moderator|mod|broadcaster|owner|channel[_-]?owner|super[_-]?admin)$/i;
    // The shapes Kick has used for a nested answer, alongside the flat one.
    const scopes = [data, data.chatroom, data.channel, data.user, data.identity]
      .filter((v) => v && typeof v === 'object');

    let canModerate = false;
    scopes.forEach((scope) => {
      FLAGS.forEach((flag) => { if (yes(scope[flag])) canModerate = true; });
      // A role, one or many, spelled as a word or as an object naming one.
      [].concat(scope.role || [], scope.roles || [], scope.badges || []).forEach((entry) => {
        const word = typeof entry === 'string'
          ? entry
          : (entry && (entry.type || entry.name || entry.slug || entry.role)) || '';
        if (ROLE_WORDS.test(String(word).trim())) canModerate = true;
      });
    });

    return {
      known: true,
      canModerate,
      username: String(FCM.usernameFrom(data) || FCM.usernameFrom(data.user) || ''),
    };
  };

  FCM.kickBadgeClass = function (badges = []) {
    if (!Array.isArray(badges) || !badges.length) return null;
    const types = badges.map((b) => String((b && b.type) || '').toLowerCase());
    if (types.includes('broadcaster') || types.includes('moderator')) return 'mod';
    if (types.includes('vip')) return 'vip';
    if (types.includes('subscriber') || types.includes('founder')) return 'sub';
    return null;
  };

  /**
   * The message a Kick reply is answering.
   *
   * Kick marks a reply by hanging the original off the message's metadata
   * rather than by a type alone, so the metadata is what is read: a message
   * carrying an original sender is a reply whatever it calls itself.
   *
   * @returns {{name: string, text: string, messageId: string}|null}
   */
  FCM.kickReplyContext = function (rawPayload) {
    const payload = (rawPayload && typeof rawPayload === 'object') ? rawPayload : {};
    const meta = (payload.metadata && typeof payload.metadata === 'object') ? payload.metadata : {};
    const original = (meta.original_message && typeof meta.original_message === 'object')
      ? meta.original_message : {};
    const name = FCM.usernameFrom(meta.original_sender);
    if (!name) return null;
    return {
      name: String(name),
      text: String(original.content || ''),
      messageId: String(original.id || ''),
    };
  };

  FCM.formatKickEventSummary = function (eventName, rawPayload) {
    // A default parameter only covers `undefined`, and Pusher can deliver a
    // data field of literal "null", which parses to null and would otherwise
    // throw on the first property read.
    const payload = (rawPayload && typeof rawPayload === 'object') ? rawPayload : {};
    const shortName = kickEventShortName(eventName);
    const sender = FCM.firstPresent(
      payload.gifter_username,
      payload.sender && payload.sender.username,
      payload.username,
      FCM.usernameFrom(payload.user),
      payload.banned_by && payload.banned_by.username,
      payload.host_username
    ) || 'Someone';

    const giftedUsernames = Array.isArray(payload.gifted_usernames) ? payload.gifted_usernames : [];
    const luckyUsernames = Array.isArray(payload.usernames) ? payload.usernames : [];
    const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
    const count = FCM.firstPresent(
      giftedUsernames.length || null,
      luckyUsernames.length || null,
      recipients.length || null,
      payload.gifted_quantity, payload.gift_count, payload.quantity,
      payload.total, payload.count, payload.amount
    );
    // What was redeemed, when the event says so. Kick spells the field
    // differently depending on which of its two redemption events fired, and a
    // row that can only say "channel points" is barely worth showing.
    const rewardTitle = FCM.firstPresent(
      payload.reward_title,
      payload.reward && payload.reward.title,
      payload.title
    );
    const recipient = FCM.firstPresent(
      FCM.usernameFrom(payload.receiver),
      FCM.usernameFrom(payload.recipient),
      FCM.usernameFrom(payload.target),
      FCM.usernameFrom(recipients[0]),
      giftedUsernames[0],
      luckyUsernames[0]
    );

    const map = {
      'App\\Events\\SubscriptionEvent': `${sender} subscribed.`,
      'App\\Events\\ChannelSubscriptionEvent': `${sender} subscribed.`,
      'App\\Events\\ResubscriptionEvent': `${sender} resubscribed.`,
      // Number(), not ===: Kick sends the quantity as a string often enough that
      // a single gift read as "gifted 1 subs" and dropped the name of the person
      // it went to. The heuristic further down already had this right.
      'App\\Events\\GiftedSubscriptionsEvent': `${sender} gifted ${count || '?'} sub${Number(count) === 1 ? '' : 's'}${recipient && Number(count) === 1 ? ` to ${recipient}` : ''}.`,
      'App\\Events\\SubscriptionGiftedEvent': `${sender} gifted a sub${recipient ? ` to ${recipient}` : ''}.`,
      'App\\Events\\LuckyUsersWhoGotGiftSubscriptionsEvent': `${sender} gifted ${count || '?'} sub${Number(count) === 1 ? '' : 's'}${luckyUsernames.length ? ` to ${luckyUsernames.slice(0, 3).join(', ')}${luckyUsernames.length > 3 ? ', and more' : ''}` : ''}.`,
      'App\\Events\\ChatroomClearEvent': 'Chat was cleared by a moderator.',
      'App\\Events\\StreamHostEvent': `${sender} is hosting the channel.`,
      'App\\Events\\HypeTrainStartedEvent': `${sender} started a Hype Train!`,
      'App\\Events\\HypeTrainProgressEvent': `Hype Train progress${count ? `: ${count}` : ''}.`,
      'App\\Events\\HypeTrainEndedEvent': 'Hype Train ended.',
      'App\\Events\\BitsEvent': `${sender} cheered${count ? ` ${count} bits` : ''}.`,
      'App\\Events\\ChannelPointsRedeemedEvent': `${sender} redeemed ${rewardTitle || 'channel points'}.`,
      'App\\Events\\RewardRedeemedEvent': `${sender} redeemed ${rewardTitle || 'a reward'}.`,
      'App\\Events\\PollUpdateEvent': 'Poll updated.',
    };
    if (map[eventName]) return map[eventName];

    if (shortName.includes('Gift') && shortName.includes('Subscription')) {
      return `${sender} gifted ${count || 1} sub${Number(count) === 1 ? '' : 's'}${recipient && Number(count) === 1 ? ` to ${recipient}` : ''}.`;
    }
    if (shortName.includes('Subscription')) return `${sender} subscribed.`;

    // Housekeeping events are not worth a row in the feed.
    //
    // The stream starting and stopping belongs here too. Those arrive on the
    // channel rather than the chatroom, match none of the shapes above, and
    // fell through to the last line — so restarting a stream put "Someone
    // triggered StreamerIsLive." in the feed, which is an internal event name
    // attributed to nobody. `Delete` rather than `Deleted` so PollDeleteEvent
    // is caught as well; PollUpdateEvent is named in the map above and Kick's
    // message deletions never reach here at all.
    if (/Updated|Statistic|Leaderboard|Livestream|Pinned|Delete|Banned|StreamerIsLive|StopStream|ChatMove/i
      .test(shortName)) return '';
    return `${sender} triggered ${shortName}.`;
  };
})(self.FCM);
