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
