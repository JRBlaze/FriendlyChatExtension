// Twitch IRCv3 parsing, ported from Friendly Chat.
(function (FCM) {
  'use strict';

  function unescapeIrcTagValue(value) {
    return String(value).replace(/\\(.)/g, (_, ch) => {
      if (ch === 's') return ' ';
      if (ch === ':') return ';';
      if (ch === 'r') return '\r';
      if (ch === 'n') return '\n';
      if (ch === '\\') return '\\';
      return ch;
    });
  }

  function parseTwitchIrcTags(rawLine) {
    const tags = {};
    const tagMatch = String(rawLine).match(/^@([^ ]+)/);
    if (!tagMatch) return tags;
    tagMatch[1].split(';').forEach((part) => {
      const eq = part.indexOf('=');
      if (eq !== -1) tags[part.slice(0, eq)] = unescapeIrcTagValue(part.slice(eq + 1));
      else if (part) tags[part] = '';
    });
    return tags;
  }

  // The command is read from the line's structure rather than by substring
  // matching, so a message that merely contains the word USERSTATE still renders.
  FCM.parseIrcLine = function (rawLine) {
    let rest = String(rawLine || '');
    const tags = parseTwitchIrcTags(rest);

    if (rest.startsWith('@')) {
      const sp = rest.indexOf(' ');
      if (sp === -1) return { tags, prefix: '', command: '', params: [] };
      rest = rest.slice(sp + 1);
    }

    let prefix = '';
    if (rest.startsWith(':')) {
      const sp = rest.indexOf(' ');
      if (sp === -1) return { tags, prefix: rest.slice(1), command: '', params: [] };
      prefix = rest.slice(1, sp);
      rest = rest.slice(sp + 1);
    }

    const sp = rest.indexOf(' ');
    const command = (sp === -1 ? rest : rest.slice(0, sp)).toUpperCase();
    let paramText = sp === -1 ? '' : rest.slice(sp + 1);

    const params = [];
    while (paramText.length) {
      if (paramText[0] === ':') { params.push(paramText.slice(1)); break; }
      const next = paramText.indexOf(' ');
      if (next === -1) { params.push(paramText); break; }
      params.push(paramText.slice(0, next));
      paramText = paramText.slice(next + 1);
    }

    return { tags, prefix, command, params };
  };

  /**
   * Unwraps the CTCP wrapper `/me` arrives in.
   *
   * Twitch sends an action as a PRIVMSG whose body is \u0001ACTION waves\u0001,
   * so a client that does not know about the wrapper prints the control
   * characters and the word ACTION as if the viewer had typed them.
   *
   * The emote positions in the `emotes` tag are counted from the text *inside*
   * the wrapper, which is why this has to run before anything looks at the
   * message: unwrapping later would leave every position eight characters out.
   *
   * @returns {{action: boolean, text: string}}
   */
  FCM.parseIrcAction = function (body) {
    const value = String(body === null || body === undefined ? '' : body);
    // The closing \u0001 is optional: every client sends it, and a line
    // truncated without it is still an action rather than a message about one.
    const match = /^\u0001ACTION(?: ([\s\S]*?))?\u0001?$/.exec(value);
    if (!match) return { action: false, text: value };
    return { action: true, text: match[1] || '' };
  };

  /**
   * The message a Twitch reply is answering, from the tags Twitch attaches to
   * every threaded reply.
   *
   * The parent body is carried verbatim in a tag, so the row can show what is
   * being replied to without the original still being in the feed — which it
   * usually is not, because a reply to something said an hour ago is exactly
   * when the context is worth having.
   *
   * @returns {{name: string, login: string, text: string, messageId: string}|null}
   */
  FCM.twitchReplyContext = function (tags = {}) {
    const name = tags['reply-parent-display-name'] || tags['reply-parent-user-login'] || '';
    if (!name) return null;
    // The parent can itself be a `/me`, and its wrapper is no more readable
    // quoted than it was first time around.
    const body = FCM.parseIrcAction(tags['reply-parent-msg-body'] || '');
    return {
      name: String(name),
      login: String(tags['reply-parent-user-login'] || ''),
      text: body.text,
      messageId: String(tags['reply-parent-msg-id'] || ''),
    };
  };

  FCM.ircNick = function (prefix = '') {
    const bang = prefix.indexOf('!');
    return bang === -1 ? prefix : prefix.slice(0, bang);
  };

  // "25:0-4,12-16/1902:6-10" -> { 0:{id:'25',end:4}, 12:{...}, 6:{...} }
  FCM.parseTwitchEmoteMap = function (emotesTag) {
    if (!emotesTag) return null;
    const emoteMap = {};
    emotesTag.split('/').forEach((entry) => {
      const colon = entry.indexOf(':');
      if (colon === -1) return;
      const id = entry.slice(0, colon);
      entry.slice(colon + 1).split(',').forEach((range) => {
        const dash = range.indexOf('-');
        const start = parseInt(range.slice(0, dash), 10);
        const end = parseInt(range.slice(dash + 1), 10);
        // A range has to run forwards from a real position. Dropping the
        // nonsense here means the tokenizer only ever sees ranges that advance.
        if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start) {
          emoteMap[start] = { id, end };
        }
      });
    });
    return Object.keys(emoteMap).length ? emoteMap : null;
  };

  /**
   * Whether an address is one a GIF in chat may be drawn from.
   *
   * Twitch's GIFs come from GIPHY and the tag carries the full media address,
   * which Twitch says to use as given. That is honoured — but only for GIPHY's
   * own hosts. The address in the tag is what an `<img>` in every viewer's
   * panel will be pointed at, and a tag on a replayed history line is a tag
   * this extension did not watch Twitch write, so anything that is not GIPHY
   * over https is left as the text it arrived in.
   */
  FCM.isGifUrl = function (url) {
    const value = String(url || '');
    if (!/^https:\/\//i.test(value)) return false;
    let host = '';
    try { host = new URL(value).hostname.toLowerCase(); } catch (e) { return false; }
    return host === 'giphy.com' || host.endsWith('.giphy.com');
  };

  /**
   * The GIFs a Twitch message carries, from its `gifs` tag.
   *
   * "0-33|joSNxeswxuc74Juo8X|https://media4.giphy.com/media/.../giphy.gif",
   * comma separated, one per GIF. The positions are codepoint indices into the
   * message the same way emote positions are, and the span they name is what
   * the picture stands in for.
   *
   * A GIF whose positions are missing or nonsense is kept with a start of -1,
   * so it is drawn after the text rather than lost: Twitch put it in the
   * message, and a picture at the end beats no picture at all.
   *
   * @returns {Array<{start: number, end: number, id: string, url: string}>|null}
   */
  FCM.parseTwitchGifs = function (gifsTag) {
    if (!gifsTag) return null;
    const out = [];
    String(gifsTag).split(',').forEach((entry) => {
      const parts = entry.split('|');
      if (parts.length < 3) return;
      const range = parts[0];
      const id = parts[1];
      // The address is everything after the second bar, in case it grows one.
      const url = parts.slice(2).join('|');
      if (!FCM.isGifUrl(url)) return;
      let start = -1;
      let end = -1;
      const dash = range.indexOf('-');
      if (dash !== -1) {
        start = parseInt(range.slice(0, dash), 10);
        end = parseInt(range.slice(dash + 1), 10);
      }
      if (!(Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start)) {
        start = -1;
        end = -1;
      }
      out.push({ start, end, id: String(id || ''), url });
    });
    return out.length ? out : null;
  };

  /**
   * This viewer's own subscription to the channel, as Twitch describes it in
   * the badges on their USERSTATE.
   *
   * The subscriber badge's version encodes the tier: Tier 1 badges are
   * numbered by months alone, Tier 2 badges are 2000 plus the months and Tier
   * 3 badges 3000 plus the months. `badge-info` carries the actual month count
   * for the same badge. A founder wears the founder badge instead, which says
   * they subscribe but not at which tier, so the tier comes back unknown (0)
   * for a founder unless the subscriber badge is there as well.
   *
   * @returns {{tier: number, months: number, founder: boolean}|null} null when
   *   the badges do not say they subscribe here at all
   */
  FCM.twitchSubscriptionFromTags = function (tags = {}) {
    const badges = String(tags.badges || '');
    const info = String(tags['badge-info'] || '');
    const pick = (list, set) => {
      for (const entry of list.split(',')) {
        const slash = entry.indexOf('/');
        if (slash !== -1 && entry.slice(0, slash) === set) return entry.slice(slash + 1);
      }
      return '';
    };
    const subBadge = pick(badges, 'subscriber');
    const founder = badges.split(',').some((b) => b.startsWith('founder/'));
    const subscribed = !!subBadge || founder || tags.subscriber === '1';
    if (!subscribed) return null;
    const version = parseInt(subBadge, 10);
    let tier = 0;
    if (Number.isFinite(version)) tier = version >= 3000 ? 3 : version >= 2000 ? 2 : 1;
    const months = parseInt(pick(info, 'subscriber') || pick(info, 'founder'), 10);
    return {
      tier,
      months: Number.isFinite(months) && months > 0 ? months : 0,
      founder,
    };
  };

  FCM.twitchBadgeClass = function (badgesTag = '', tags = {}) {
    if (badgesTag.includes('broadcaster') || badgesTag.includes('moderator') || tags.mod === '1') return 'mod';
    if (badgesTag.includes('vip')) return 'vip';
    if (badgesTag.includes('subscriber') || tags.subscriber === '1') return 'sub';
    return null;
  };

  FCM.twitchUserNoticeSummary = function (tags = {}, fallbackText = '') {
    const msgId = tags['msg-id'] || 'notice';
    const name = tags['display-name'] || tags.login || tags['msg-param-recipient-display-name'] || 'Someone';
    const count = tags['msg-param-cumulative-months'] || tags['msg-param-months'] || '';
    const giftCount = tags['msg-param-mass-gift-count'] || tags['msg-param-gift-months'] || tags['msg-param-sender-count'] || '';
    const tierLabel = tags['msg-param-sub-plan'] === '1000' ? 'Tier 1'
      : tags['msg-param-sub-plan'] === '2000' ? 'Tier 2'
        : tags['msg-param-sub-plan'] === '3000' ? 'Tier 3'
          : '';
    const recipient = tags['msg-param-recipient-display-name'] || tags['msg-param-recipient-user-name'] || 'a viewer';
    // Twitch's own sentence for the notice, which is what its chat draws. Used
    // for the milestones whose fields are not all documented, and for anything
    // this list has never heard of: "Someone triggered viewermilestone" is a
    // worse row than the words Twitch already wrote.
    const systemMsg = String(tags['system-msg'] || '').replace(/\s+/g, ' ').trim();
    // A watch streak: the number of streams in a row, and the channel points
    // Twitch paid out for it.
    const milestoneValue = tags['msg-param-value'] || '';
    const milestoneReward = tags['msg-param-copoReward'] || '';
    const milestone = tags['msg-param-category'] === 'watch-streak'
      ? `${name} watched ${milestoneValue || '?'} streams in a row and sparked a watch streak!`
        + (milestoneReward ? ` (+${milestoneReward} channel points)` : '')
      : (systemMsg || `${name} reached a ${String(tags['msg-param-category'] || 'viewer').replace(/-/g, ' ')} milestone.`);

    const summaryById = {
      sub: `${name} subscribed${tierLabel ? ` (${tierLabel})` : ''}.`,
      resub: `${name} resubscribed${count ? ` (${count} months)` : ''}${tierLabel ? ` (${tierLabel})` : ''}.`,
      subgift: `${name} gifted a sub to ${recipient}.`,
      anonsubgift: `An anonymous user gifted a sub to ${recipient}.`,
      submysterygift: `${name} gifted ${giftCount || '?'} subs to the community.`,
      anonsubmysterygift: `An anonymous user gifted ${giftCount || '?'} subs to the community.`,
      giftpaidupgrade: `${name} continued their gifted sub.`,
      anongiftpaidupgrade: `${name} continued an anonymous gifted sub.`,
      primepaidupgrade: `${name} upgraded from Prime to a paid sub.`,
      raid: `${name} is raiding with ${tags['msg-param-viewerCount'] || '?'} viewers.`,
      ritual: `${name} sent a ritual message.`,
      bitsbadgetier: `${name} reached Bits badge tier ${tags['msg-param-threshold'] || '?'}.`,
      announcement: `${name} posted a chat announcement.`,
      rewardgift: `${name} triggered a reward gift.`,
      communitypayforward: `${name} paid a sub forward.`,
      standardpayforward: `${name} paid a sub forward.`,
      // Watch streaks. Until 2026 these were only ever drawn by Twitch's own
      // page; they now arrive over IRC as a notice of their own.
      viewermilestone: milestone,
      // A moderator's anniversary in the role. Twitch's sentence is the whole
      // of what is documented about it.
      modiversary: systemMsg || `${name} is celebrating a modiversary!`,
    };

    const summary = summaryById[msgId]
      || systemMsg
      || `${name} triggered ${msgId.replace(/_/g, ' ')}.`;
    return `${summary}${fallbackText ? ` ${fallbackText}` : ''}`.trim();
  };
})(self.FCM);
