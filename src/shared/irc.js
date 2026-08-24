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
    };

    const summary = summaryById[msgId] || `${name} triggered ${msgId.replace(/_/g, ' ')}.`;
    return `${summary}${fallbackText ? ` ${fallbackText}` : ''}`.trim();
  };
})(self.FCM);
