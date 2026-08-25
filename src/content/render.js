// Message rendering.
//
// Bodies are built as a token list and serialized exactly once at the end.
// Running regexes over half-built HTML (the obvious shortcut) double-escapes
// ampersands inside links, can replace text inside an anchor with an emote, and
// breaks on emote names containing characters that escaping rewrites.
//
// Token kinds: {type:'text',text} | {type:'emote',url,name,cls,source}
//              {type:'link',url,text} | {type:'mention',text}
(function (FCM) {
  'use strict';

  // The feed background each theme paints behind a username, which is what a
  // name colour has to be readable against.
  const AUTHOR_BACKDROP = { dark: [13, 13, 15], light: [245, 247, 251] };
  // Aimed well above the 4.5 bar on purpose. The panel ships at 96% opacity,
  // which lifts every colour slightly toward the background behind it, so names
  // clamped to exactly 4.5 measured about 4.3 once actually rendered. This is
  // the margin that survives the default setting.
  const AUTHOR_MIN_CONTRAST = 5.2;

  const srgb = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  function toHsl([r, g, b]) {
    const R = r / 255; const G = g / 255; const B = b / 255;
    const max = Math.max(R, G, B); const min = Math.min(R, G, B);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6;
    else if (max === G) h = ((B - R) / d + 2) / 6;
    else h = ((R - G) / d + 4) / 6;
    return [h, sat, l];
  }

  function toRgb([h, sat, l]) {
    if (sat === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    const p = 2 * l - q;
    const channel = (t) => {
      let x = t;
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((v) => Math.round(v * 255));
  }

  const hex2 = (n) => n.toString(16).padStart(2, '0');
  const toHex = ([r, g, b]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

  /**
   * Moves a name colour's lightness until it is readable on the given
   * background, leaving its hue and saturation alone.
   *
   * The colour belongs to the person who picked it, so this is the smallest
   * change that works: step the lightness away from the background — up on a
   * dark feed, down on a light one — and stop at the first step that clears the
   * contrast bar. A colour that is already readable is returned untouched.
   */
  function readableOn(rgb, backdrop) {
    if (contrast(rgb, backdrop) >= AUTHOR_MIN_CONTRAST) return rgb;
    const [h, sat] = toHsl(rgb);
    const up = luminance(backdrop) < 0.5;
    let best = rgb;
    for (let i = 1; i <= 100; i++) {
      const l = up ? Math.min(1, toHsl(rgb)[2] + i / 100) : Math.max(0, toHsl(rgb)[2] - i / 100);
      const candidate = toRgb([h, sat, l]);
      best = candidate;
      if (contrast(candidate, backdrop) >= AUTHOR_MIN_CONTRAST) return candidate;
      if (l === 0 || l === 1) break;
    }
    return best;
  }

  /**
   * The inline style for a username, carrying one readable value per theme so a
   * theme switch under an already-rendered row still lands on a readable name.
   * Returns an empty string when the platform sent no usable colour, which
   * leaves the row on the stylesheet's own platform colour.
   */
  FCM.authorColorStyle = function (value) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(value || ''))) return '';
    const raw = [1, 3, 5].map((i) => parseInt(String(value).slice(i, i + 2), 16));
    const dark = toHex(readableOn(raw, AUTHOR_BACKDROP.dark));
    const light = toHex(readableOn(raw, AUTHOR_BACKDROP.light));
    return ` style="--author-dark:${dark};--author-light:${light}"`;
  };

  const view = {
    emotes: {
      twitch: { native: {}, thirdparty: {} },
      kick: { native: {}, thirdparty: {} },
    },
    badges: { twitch: { global: {}, channel: {} } },
    settings: { ...FCM.DEFAULT_SETTINGS },
    selfNames: [],
  };
  FCM.view = view;

  // Bumped whenever an emote store actually gains something, so anything
  // derived from them — the picker list, the autocomplete index — can cache
  // against it instead of rebuilding on every keystroke.
  view.emoteVersion = 0;

  FCM.setEmotes = function (platform, kind, store) {
    const target = view.emotes[platform] && view.emotes[platform][kind];
    if (!target || !store) return;
    // Merge rather than replace: a later call must not drop emotes already
    // rendered on screen.
    let changed = false;
    Object.keys(store).forEach((name) => {
      if (target[name]) return;
      target[name] = store[name];
      changed = true;
    });
    if (changed) view.emoteVersion++;
  };

  FCM.setBadges = function (platform, badges) {
    if (platform !== 'twitch' || !badges) return;
    if (badges.global) view.badges.twitch.global = badges.global;
    if (badges.channel && Object.keys(badges.channel).length) {
      view.badges.twitch.channel = badges.channel;
    }
  };

  // Everyone who has spoken recently, newest first, for @mention autocomplete.
  const chatters = new Map(); // "platform:lowername" -> { name, platform, time }
  const CHATTER_LIMIT = 200;

  FCM.rememberChatter = function (platform, author) {
    const key = `${platform}:${String(author).toLowerCase()}`;
    const existing = chatters.get(key);
    if (existing) {
      existing.time = Date.now();
      // Re-inserted so the map's own order is recency order. Without this the
      // oldest *key* was dropped rather than the least recently heard from, so
      // in a channel with more than a few hundred names a regular who had been
      // talking since you arrived was evicted ahead of somebody who said one
      // word and left.
      chatters.delete(key);
      chatters.set(key, existing);
      return;
    }
    chatters.set(key, { name: author, platform, time: Date.now() });
    if (chatters.size > CHATTER_LIMIT) chatters.delete(chatters.keys().next().value);
  };

  FCM.recentChatters = function () {
    return [...chatters.values()];
  };

  /**
   * Forgets everything that belonged to the channel being left.
   *
   * This module is loaded once for the page and outlives the overlay, which is
   * torn down and rebuilt on every channel change. Nothing here was ever
   * cleared, so a session spent moving between channels kept every one of their
   * emote sets — tens of thousands of entries after an hour, and worse than the
   * memory: a name that is an emote somewhere you have been renders as that
   * emote here, where the real chat shows plain text and you could not send it
   * if you tried.
   *
   * Everything dropped here is sent again by the worker when the next channel
   * is joined, so this costs nothing but the re-send that already happens.
   */
  FCM.resetChannelView = function () {
    FCM.PLATFORMS.forEach((platform) => {
      view.emotes[platform] = { native: {}, thirdparty: {} };
    });
    // Global badges are the same everywhere and are re-sent on join regardless;
    // the channel's own are the ones that would be wrong here.
    view.badges.twitch.channel = {};
    chatters.clear();
    // Anything cached against this — the picker list, the autocomplete index —
    // has to rebuild rather than keep offering what is no longer loaded.
    view.emoteVersion++;
  };

  FCM.setViewSettings = function (settings) {
    view.settings = { ...FCM.DEFAULT_SETTINGS, ...(settings || {}) };
    view.selfNames = String(view.settings.highlightNames || '')
      .split(/[,\n]/)
      .map((n) => FCM.normalizeChannel(n))
      .filter(Boolean);
    // Compiled once here rather than per message: on a busy channel that was a
    // regex build for every line that arrived.
    view.mentionPattern = view.selfNames.length
      ? new RegExp(`@?(?:${view.selfNames.map(FCM.escapeRegExp).join('|')})`, 'gi')
      : null;
  };

  /**
   * An emote by name, from whichever platform has one. The composer can send to
   * either, so a name is drawn if either side knows it.
   */
  FCM.findEmote = function (name) {
    if (!name) return null;
    for (const platform of FCM.PLATFORMS) {
      const sets = view.emotes[platform];
      if (!sets) continue;
      const hit = sets.native[name] || sets.thirdparty[name];
      if (hit && hit.url) return hit;
    }
    return null;
  };

  function lookupEmote(platform, name) {
    const sets = view.emotes[platform];
    if (!sets) return null;
    return sets.native[name] || sets.thirdparty[name] || null;
  }

  // Captures opening punctuation the URL is wrapped in — "(https://x)" is a
  // link with a stray bracket either side, not plain text.
  const URL_RE = /^([([{<"']*)(https?:\/\/[^\s]+)$/i;

  // The same shape with the scheme left off. Almost nobody types the https:
  // "kick.com/name" and "youtu.be/xYz" are what people actually paste, and both
  // Twitch's and Kick's own chats draw them as links.
  const BARE_RE = /^([([{<"']*)((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})([^\s]*)$/i;

  // Trailing punctuation is almost never part of the link.
  const TRAILING_PUNCT = /[.,!?;:'")\]}>]+$/;

  // A bare host only becomes a link when its last label is a real top-level
  // domain, because "any dotted word" would turn "node.js", "README.md" and
  // "run.sh" into links pointing at nothing. Anything under www. is taken on
  // the prefix alone.
  const BARE_TLDS = new Set([
    'com', 'net', 'org', 'edu', 'gov', 'int', 'mil', 'info', 'biz', 'name', 'pro',
    'io', 'co', 'tv', 'gg', 'me', 'ai', 'app', 'dev', 'xyz', 'link', 'live', 'stream',
    'online', 'site', 'shop', 'store', 'news', 'blog', 'wiki', 'art', 'fun', 'club',
    'life', 'world', 'today', 'space', 'cloud', 'tech', 'media', 'video', 'watch',
    'games', 'gallery', 'design', 'studio', 'social', 'chat', 'fm', 'am', 'ly', 'gl',
    'to', 'be', 'cc', 'ws', 'uk', 'us', 'ca', 'de', 'fr', 'nl', 'es', 'it', 'se',
    'no', 'fi', 'dk', 'br', 'au', 'nz', 'jp', 'kr', 'cn', 'in', 'ru', 'ua', 'tr',
    'mx', 'ar', 'cl', 'pt', 'gr', 'cz', 'ro', 'hu', 'at', 'ch', 'ie', 'il',
    'za', 'ph', 'id', 'th', 'vn', 'my', 'sg', 'hk', 'tw', 'eu',
  ]);

  /**
   * A link token for one whitespace-separated word, or null when the word is
   * not a link. The punctuation that has to stay as text comes back alongside
   * it, because "(kick.com/name)." is a link with three characters of sentence
   * wrapped around it.
   *
   * The visible text is always exactly what was typed, so a row can never show
   * one address while pointing at another.
   */
  function linkTokenFor(word) {
    const scheme = word.match(URL_RE);
    if (scheme) {
      const clean = scheme[2].replace(TRAILING_PUNCT, '');
      // "https://" on its own is punctuation, not a destination.
      if (!/^https?:\/\/[^/\s]/i.test(clean)) return null;
      return {
        lead: scheme[1],
        token: { type: 'link', url: clean, text: clean },
        tail: scheme[2].slice(clean.length),
      };
    }

    const bare = word.match(BARE_RE);
    if (!bare) return null;
    const host = bare[2];
    const tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase();
    if (!/^www\./i.test(host) && !BARE_TLDS.has(tld)) return null;
    const rest = bare[3].replace(TRAILING_PUNCT, '');
    // Whatever follows the host has to look like a path, a query or a fragment.
    // Anything else means the dotted word was never an address.
    if (rest && !/^[/?#]/.test(rest)) return null;
    const text = host + rest;
    return {
      lead: bare[1],
      // The scheme people left off. http would be a downgrade nobody asked for.
      token: { type: 'link', url: `https://${text}`, text },
      tail: bare[3].slice(rest.length),
    };
  }

  function expandTextRun(text, platform) {
    const out = [];
    if (!text) return out;
    let buffer = '';
    const flush = () => { if (buffer) { out.push({ type: 'text', text: buffer }); buffer = ''; } };

    // Split keeping the whitespace so spacing is preserved verbatim.
    String(text).split(/(\s+)/).forEach((word) => {
      if (!word) return;
      if (/^\s+$/.test(word)) { buffer += word; return; }

      const emote = lookupEmote(platform, word);
      if (emote) {
        flush();
        out.push({ type: 'emote', url: emote.url, name: word, cls: 'thirdparty-emote', source: emote.source });
        return;
      }

      const link = linkTokenFor(word);
      if (link) {
        buffer += link.lead;
        flush();
        out.push(link.token);
        if (link.tail) buffer += link.tail;
        return;
      }

      buffer += word;
    });

    flush();
    return out;
  }

  function tokenizeTwitch(text, emoteMap) {
    if (!emoteMap || !Object.keys(emoteMap).length) return [{ type: 'text', text }];
    const tokens = [];
    // Twitch emote positions are Unicode codepoint indices, so the string has to
    // be walked as codepoints or any emoji in the message shifts every position.
    const chars = [...String(text)];
    let run = '';
    let i = 0;
    while (i < chars.length) {
      const hit = emoteMap[i];
      // `end` must be at or past the cursor. A range that points backwards —
      // malformed, or crafted — would otherwise send the cursor back to where
      // it has already been and spin here forever, allocating a token each
      // time until the tab dies.
      if (hit && hit.end >= i) {
        if (run) { tokens.push({ type: 'text', text: run }); run = ''; }
        tokens.push({
          type: 'emote',
          url: `https://static-cdn.jtvnw.net/emoticons/v2/${hit.id}/default/dark/2.0`,
          name: chars.slice(i, hit.end + 1).join(''),
          cls: 'twitch-emote',
          source: 'Twitch',
        });
        i = hit.end + 1;
      } else {
        run += chars[i];
        i++;
      }
    }
    if (run) tokens.push({ type: 'text', text: run });
    return tokens;
  }

  function tokenizeKick(text, emotes) {
    const tokens = [];
    const metadata = FCM.normalizeKickEmoteMeta(emotes);
    const byName = new Map(metadata.map((e) => [e.name, e]));

    String(text).split(/(\[emote:\d+:[^\]]+\])/).forEach((part) => {
      if (!part) return;
      const m = part.match(/^\[emote:(\d+):([^\]]+)\]$/);
      if (m) {
        const id = m[1];
        const name = m[2];
        const known = byName.get(name);
        tokens.push({
          type: 'emote',
          url: (known && known.url) || `https://files.kick.com/emotes/${id}/fullsize`,
          name,
          cls: 'kick-emote',
          source: 'Kick',
        });
        return;
      }
      tokens.push({ type: 'text', text: part });
    });

    // History payloads sometimes ship emote metadata separately from the text.
    if (!byName.size) return tokens;
    const expanded = [];
    tokens.forEach((token) => {
      if (token.type !== 'text') { expanded.push(token); return; }
      let buffer = '';
      token.text.split(/(\s+)/).forEach((word) => {
        const hit = byName.get(word);
        if (hit) {
          if (buffer) { expanded.push({ type: 'text', text: buffer }); buffer = ''; }
          expanded.push({ type: 'emote', url: hit.url, name: hit.name, cls: 'kick-emote', source: 'Kick' });
        } else {
          buffer += word;
        }
      });
      if (buffer) expanded.push({ type: 'text', text: buffer });
    });
    return expanded;
  }

  // Splits text tokens so each occurrence of one of the user's names becomes its
  // own token. Word boundaries are checked by hand because names can contain
  // underscores and may be preceded by '@'.
  function highlightMentionTokens(tokens) {
    const pattern = view.mentionPattern;
    if (!pattern) return { tokens, mentioned: false };
    const isWordChar = (ch) => /[A-Za-z0-9_]/.test(ch);
    let mentioned = false;

    const out = [];
    tokens.forEach((token) => {
      if (token.type !== 'text') { out.push(token); return; }
      const text = token.text;
      let last = 0;
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const beforeOk = start === 0 || !isWordChar(text[start - 1]) || text[start] === '@';
        const afterOk = end >= text.length || !isWordChar(text[end]);
        if (!beforeOk || !afterOk) {
          if (pattern.lastIndex === start) pattern.lastIndex++;
          continue;
        }
        if (start > last) out.push({ type: 'text', text: text.slice(last, start) });
        out.push({ type: 'mention', text: match[0] });
        mentioned = true;
        last = end;
      }
      if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
      else if (last === 0 && !text) out.push(token);
    });

    return { tokens: out, mentioned };
  }

  function serializeTokens(tokens) {
    return tokens.map((token) => {
      if (token.type === 'emote') {
        const title = token.source ? `${token.name} (${token.source})` : token.name;
        return `<img class="fcm-emote ${token.cls}" src="${FCM.escapeHtml(token.url)}"`
          + ` alt="${FCM.escapeHtml(token.name)}" title="${FCM.escapeHtml(title)}" loading="lazy">`;
      }
      if (token.type === 'link') {
        return `<a href="${FCM.escapeHtml(token.url)}" target="_blank" rel="noopener noreferrer"`
          + ` class="fcm-link">${FCM.escapeHtml(token.text)}</a>`;
      }
      if (token.type === 'mention') {
        return `<span class="fcm-mention">${FCM.escapeHtml(token.text)}</span>`;
      }
      return FCM.escapeHtml(token.text);
    }).join('');
  }

  /**
   * Text with its links made clickable and everything else escaped, for the
   * rows that are not chat: status lines, account notices, channel events.
   * A sign-in page or a channel address named in one of those is worth clicking
   * rather than retyping, and emotes are deliberately not expanded here — a
   * status line is not something a viewer typed.
   */
  FCM.renderLinkedText = function (text) {
    // No platform, so the emote lookup finds nothing and only links are split
    // out of the run.
    return serializeTokens(expandTextRun(String(text === null || text === undefined ? '' : text), null));
  };

  FCM.renderMessageBody = function (platform, text, opts = {}) {
    let tokens;
    if (platform === 'twitch') tokens = tokenizeTwitch(text, opts.emoteMap);
    else if (platform === 'kick') tokens = tokenizeKick(text, opts.emotes);
    else tokens = [{ type: 'text', text }];

    const expanded = [];
    tokens.forEach((token) => {
      if (token.type === 'text') expanded.push(...expandTextRun(token.text, platform));
      else expanded.push(token);
    });

    const result = highlightMentionTokens(expanded);
    return { html: serializeTokens(result.tokens), mentioned: result.mentioned };
  };

  // ── Badges ──────────────────────────────────────────────────────────────────

  // Short labels for the roles worth calling out when no badge image is
  // available. Anything not listed here is decoration, not a role, so an
  // unresolved badge is dropped rather than dumped into the row as raw text.
  const ROLE_LABELS = {
    broadcaster: 'HOST', moderator: 'MOD', subscriber: 'SUB', vip: 'VIP',
    founder: 'FOUNDER', staff: 'STAFF', admin: 'ADMIN', global_mod: 'GMOD',
    verified: 'VERIFIED', partner: 'PARTNER', artist: 'ARTIST',
    gifter: 'GIFTER', gifted: 'GIFTED', og: 'OG', event: 'EVENT',
    sub_gifter: 'GIFTER', 'sub-gifter': 'GIFTER', sidekick: 'SIDEKICK',
  };

  function twitchBadgeVersion(setId, version) {
    const channel = view.badges.twitch.channel[setId];
    const global = view.badges.twitch.global[setId];
    const map = (channel && channel[version]) ? channel : global;
    return map ? map[version] : null;
  }

  function renderTwitchBadges(badgesTag = '') {
    if (!badgesTag) return '';
    const rendered = [];
    badgesTag.split(',').forEach((entry) => {
      const slash = entry.indexOf('/');
      if (slash === -1) return;
      const setId = entry.slice(0, slash);
      const version = entry.slice(slash + 1);
      const badge = twitchBadgeVersion(setId, version);
      const img = badge && (badge.image_url_1x || badge.image_url_2x || badge.image_url_4x);
      if (img) {
        const title = (badge && badge.title) || setId;
        rendered.push(`<img class="fcm-badge-img" src="${FCM.escapeHtml(img)}"`
          + ` alt="${FCM.escapeHtml(setId)}" title="${FCM.escapeHtml(title)}">`);
        return;
      }
      // Badge images have not arrived yet (or this set is unknown): fall back to
      // a label, but only for the roles that actually say something.
      const label = ROLE_LABELS[setId];
      if (label) {
        rendered.push(`<span class="fcm-kbadge fcm-kbadge-${FCM.escapeHtml(setId)}">${label}</span>`);
      }
    });
    return rendered.length ? `<span class="fcm-badges">${rendered.join('')}</span>` : '';
  }

  function kickBadgeImageUrl(badge) {
    if (!badge || typeof badge !== 'object') return '';
    const direct = badge.image_url || badge.image || badge.icon || badge.badge_image || badge.badge_url;
    if (typeof direct === 'string' && direct) return direct;
    return (badge.image && badge.image.url)
      || (badge.icon && badge.icon.url)
      || (badge.badge && (badge.badge.image_url || (badge.badge.image && badge.badge.image.url)))
      || (badge.asset && badge.asset.url)
      || (badge.urls && (badge.urls.small || badge.urls.medium || badge.urls.large))
      || '';
  }

  function renderKickBadges(badges = []) {
    if (!Array.isArray(badges) || !badges.length) return '';
    const rendered = badges.map((badge) => {
      if (!badge || typeof badge !== 'object') return '';
      const type = String(badge.type || '').toLowerCase();
      const label = ROLE_LABELS[type]
        || (type ? type.replace(/[_-]+/g, ' ').toUpperCase() : 'BADGE');
      const imageUrl = kickBadgeImageUrl(badge);
      if (imageUrl) {
        return `<img class="fcm-badge-img" src="${FCM.escapeHtml(imageUrl)}"`
          + ` alt="${FCM.escapeHtml(label)}" title="${FCM.escapeHtml(label)}">`;
      }
      const cls = type ? `fcm-kbadge-${FCM.escapeHtml(type)}` : 'fcm-kbadge-default';
      return `<span class="fcm-kbadge ${cls}">${FCM.escapeHtml(label)}</span>`;
    }).filter(Boolean);
    return rendered.length ? `<span class="fcm-badges">${rendered.join('')}</span>` : '';
  }

  FCM.renderBadges = function (platform, badgesRaw) {
    if (platform === 'twitch') return renderTwitchBadges(String(badgesRaw || ''));
    return renderKickBadges(Array.isArray(badgesRaw) ? badgesRaw : []);
  };

  // ── Row builders ────────────────────────────────────────────────────────────

  FCM.buildMessageEl = function (msg, activeFilter) {
    const platform = msg.platform;
    const el = document.createElement('div');
    const classes = ['fcm-msg'];
    if (activeFilter && !activeFilter.has(platform)) classes.push('fcm-hide');

    const body = FCM.renderMessageBody(platform, msg.text, msg);
    const authorLower = String(msg.author || '').toLowerCase();
    const isSelf = view.selfNames.includes(authorLower);
    if (body.mentioned && !isSelf) classes.push('fcm-mentioned');

    el.className = classes.join(' ');
    el.dataset.platform = platform;
    if (msg.messageId) el.dataset.msgId = String(msg.messageId);
    // Kept so a moderation action can name the sender directly instead of
    // resolving their id from the username all over again.
    if (msg.userId) el.dataset.userId = String(msg.userId);
    el.dataset.user = authorLower;
    FCM.rememberChatter(platform, msg.author);

    // The per-badge labels already say MOD/SUB/VIP, so the summary chip is only
    // rendered when nothing else identified the role — otherwise every Kick row
    // reads "SUBSUBname".
    const badgeHtml = FCM.renderBadges(platform, msg.badgesRaw);
    const chip = (!badgeHtml && msg.badgeClass)
      ? `<span class="fcm-chip fcm-chip-${msg.badgeClass}">${msg.badgeClass.toUpperCase()}</span>`
      : '';
    // Timestamps and badges are always built and hidden with CSS rather than
    // skipped here, so turning either off applies to the whole feed at once
    // instead of only to messages that arrive afterwards.
    const time = `<span class="fcm-time">${FCM.ftime(msg.timestamp || null)}</span>`;
    // Twitch hands out per-user name colours; Kick does the same via identity.
    // Both let people pick one, and plenty pick a dark blue that lands at 2:1 on
    // a dark feed. The hue is theirs to choose, so it is kept and only the
    // lightness is moved until the name is readable — and because the panel can
    // switch between light and dark under an already-rendered row, a value for
    // each theme is emitted and CSS picks.
    const colorAttr = FCM.authorColorStyle(msg.color);

    el.innerHTML = `<span class="fcm-dot fcm-dot-${platform}"></span>`
      + time
      + `<span class="fcm-author fcm-author-${platform}"${colorAttr}`
      + ` data-name="${FCM.escapeHtml(msg.author)}" data-platform="${platform}"`
      + ` title="${FCM.escapeHtml(msg.author)} — click for reply and more">`
      + `${badgeHtml}${chip}${FCM.escapeHtml(msg.author)}</span>`
      + '<span class="fcm-colon">:</span>'
      + `<span class="fcm-body">${body.html}</span>`;

    return el;
  };

  // System and event rows are built the same way the desktop app builds them:
  // time, a SYSTEM/EVENT tag, a labelled chip naming the source, then the body.
  // Keeping the tag matters — it is what stops a status line from reading like
  // something a viewer typed.
  FCM.buildSysEl = function (text) {
    const sys = FCM.formatSystemMessage(text);
    const el = document.createElement('div');
    el.className = `fcm-sys${sys.type === 'error' ? ' fcm-sys-error' : ''}`;
    el.innerHTML = `<span class="fcm-sys-time">${FCM.ftime()}</span>`
      + '<span class="fcm-sys-tag">SYSTEM</span>'
      + `<span class="fcm-sys-label fcm-sys-${FCM.escapeHtml(sys.type)}">${FCM.escapeHtml(sys.label)}</span>`
      + `<span class="fcm-sys-body">${FCM.renderLinkedText(sys.message)}</span>`;
    return el;
  };

  FCM.buildEventEl = function (platform, text, activeFilter) {
    const el = document.createElement('div');
    el.className = `fcm-sys fcm-sys-event${activeFilter && !activeFilter.has(platform) ? ' fcm-hide' : ''}`;
    el.dataset.platform = platform;
    el.innerHTML = `<span class="fcm-sys-time">${FCM.ftime()}</span>`
      + '<span class="fcm-sys-tag">EVENT</span>'
      + `<span class="fcm-sys-label fcm-sys-${platform}">${FCM.escapeHtml(FCM.PLATFORM_META[platform].name)}</span>`
      + `<span class="fcm-sys-body">${FCM.renderLinkedText(text)}</span>`;
    return el;
  };
})(self.FCM);
