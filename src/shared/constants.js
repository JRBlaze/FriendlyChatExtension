(function (FCM) {
  'use strict';

  FCM.PLATFORMS = ['twitch', 'kick'];

  // The other platform, for the cross-platform prompt.
  FCM.otherPlatform = (p) => (p === 'twitch' ? 'kick' : 'twitch');

  FCM.PLATFORM_META = {
    twitch: { name: 'Twitch', short: 'TW', color: '#9146ff', host: 'twitch.tv' },
    kick:   { name: 'Kick',   short: 'KI', color: '#53fc18', host: 'kick.com' },
  };

  // Twitch's own web client id. It is public (it ships in every page load of
  // twitch.tv) and is what lets an unauthenticated GQL "is this channel live"
  // lookup work without asking the user to sign in to anything.
  FCM.TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  FCM.TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
  FCM.TWITCH_USELIVE_HASH =
    '639d5f11bfb8bf3053b424d9ef650d04c4ebb7d94711d644afb08fe9a0fad5d9';

  // ── Authentication ──────────────────────────────────────────────────────────
  // Sending a message (as opposed to reading chat) needs a real account token.
  // Twitch uses the implicit grant, which needs only a client id. Kick uses
  // OAuth 2.1 with PKCE, and its token exchange requires a client secret, so it
  // goes through the same Cloudflare Worker the desktop app uses — the secret
  // stays there and never reaches the browser.
  // The "Friendly Chat Extension" Twitch application: a public client whose only
  // registered redirect is this extension's chromiumapp.org URL. It is separate
  // from the desktop app's client id, so neither can break the other's sign-in.
  FCM.DEFAULT_TWITCH_CLIENT_ID = '4bfkouj78vsa1crhf7juucfkb273nv';
  FCM.DEFAULT_KICK_PROXY_URL = 'https://friendly-chat-kick-proxy.jrblaze.workers.dev';
  // Kick's client id is deliberately not kept here. The proxy holds the client
  // secret, so only the proxy knows which application that secret belongs to —
  // it is asked at sign-in. A copy in this file could only ever go stale and
  // send people to authorise against the wrong application.
  // The redirect the Friendly Chat desktop app registers with that same Kick
  // application: its local server's origin plus page, per config.json's port.
  // Reusing it means Kick sign-in works with no registration at all.
  FCM.KICK_SHARED_REDIRECT = 'http://localhost:8080/friendly-chat.html';

  FCM.TWITCH_AUTH_URL = 'https://id.twitch.tv/oauth2/authorize';
  FCM.TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
  FCM.TWITCH_HELIX = 'https://api.twitch.tv/helix';
  FCM.TWITCH_SCOPES = [
    'chat:read', 'chat:edit', 'user:write:chat', 'user:read:emotes',
    // Moderation, so a mod or the broadcaster can act from the overlay.
    'moderator:manage:banned_users', 'moderator:manage:chat_messages',
    // When someone started following. Twitch will only answer this for the
    // broadcaster or a moderator of the channel, so for everyone else the scope
    // is carried and the answer still withheld — that is Twitch's rule, not a
    // missing permission.
    'moderator:read:followers',
  ].join(' ');

  FCM.KICK_AUTH_URL = 'https://id.kick.com/oauth/authorize';
  FCM.KICK_API = 'https://api.kick.com/public/v1';
  FCM.KICK_SCOPES = [
    'user:read', 'channel:read', 'chat:write',
    'moderation:ban', 'moderation:chat_message:manage',
  ].join(' ');

  FCM.KICK_PUSHER_KEY = '32cbd69e4b950bf97679';
  FCM.KICK_PUSHER_URL =
    `wss://ws-us2.pusher.com/app/${FCM.KICK_PUSHER_KEY}?protocol=7&client=js&version=7.4.0&flash=false`;
  FCM.TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

  FCM.RECONNECT_BASE_DELAY_MS = 2000;
  FCM.RECONNECT_MAX_DELAY_MS  = 30000;
  FCM.MAX_RECONNECT_ATTEMPTS  = 10;

  FCM.TWITCH_HISTORY_LIMIT = 60;
  FCM.KICK_HISTORY_LIMIT   = 60;

  // How many favourites are kept. Enough to never be the reason someone runs
  // out, small enough that the settings blob stays a settings blob.
  FCM.FAVOURITE_EMOTE_LIMIT = 100;

  FCM.MAX_MESSAGES_DEFAULT = 400;
  FCM.MAX_MESSAGES_MIN     = 100;
  FCM.MAX_MESSAGES_MAX     = 3000;
  FCM.SEEN_MESSAGE_LIMIT   = 4000;

  // How often the background re-checks whether the counterpart channel went live.
  // Timeout presets offered in the moderation menu, in seconds.
  FCM.TIMEOUT_PRESETS = [
    { label: '1s', seconds: 1, hint: 'Purge their messages' },
    { label: '1m', seconds: 60 },
    { label: '10m', seconds: 600 },
    { label: '1h', seconds: 3600 },
    { label: '24h', seconds: 86400 },
  ];

  FCM.LIVE_POLL_MS = 90 * 1000;
  // Counterpart lookups are cached this long so switching between channels does
  // not re-hit the platform APIs for something that rarely changes.
  FCM.LINK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  FCM.LIVE_CACHE_TTL_MS = 45 * 1000;

  FCM.STORAGE_KEYS = {
    settings: 'fcm_settings_v1',
    links:    'fcm_channel_links_v1',
    choices:  'fcm_connect_choices_v1',
    // Tokens live in storage.local, never storage.sync: they are per-device
    // credentials and must not be replicated across a user's browsers.
    auth:     'fcm_auth_v1',
    // Last visit's emote lists. By far the largest thing kept here, which is
    // why the options page can show its size and empty it.
    emoteCache: 'fcm_emote_cache_v1',
    // What the last look at the releases page found. storage.local, because it
    // describes this installation rather than this person's preferences.
    update:   'fcm_update_v1',
  };

  FCM.DEFAULT_SETTINGS = {
    // Overlay behaviour
    autoOpen: true,             // open the overlay automatically on a channel page
    autoConnectHost: true,      // join the chat of the site you are on
    crossPromptMode: 'ask',     // 'ask' | 'always' | 'never'
    startCollapsed: false,
    opacity: 96,
    fontSize: 14,
    theme: 'auto',              // 'auto' follows the site | 'dark' | 'light'
    // Feed behaviour
    maxMessages: FCM.MAX_MESSAGES_DEFAULT,
    showHistory: true,
    showEvents: true,
    animations: true,
    timestamps: true,
    showBadges: true,
    thirdPartyEmotes: true,
    highlightNames: '',
    // Emote names kept to hand, newest first. Names rather than urls, because
    // the same emote can arrive from a different provider tomorrow.
    favouriteEmotes: [],
    hideNativeChat: false,      // collapse the site's own chat while merged
    // Press Kick's own "Watch now" when it opens a channel's profile over a
    // stream that is running. Kick does that to the streamer on their own
    // channel, which is the one place the layout is never what was wanted.
    watchWhenLive: true,
    // The site's own chat furniture, which the overlay would otherwise cover.
    revealHighlights: true,     // shrink so hype trains, polls, predictions and
                                // pinned messages stay visible above the panel
    showNativeStats: true,      // read bits, Kicks and channel points off the
                                // page, and open the site's own rewards menu
    // Press the site's own "claim bonus" control as soon as it appears. The
    // chest is only there for a couple of minutes and is the one part of
    // channel points that is lost purely by not being at the keyboard.
    autoClaimBonus: true,
    // Composer
    sendTargets: ['twitch', 'kick'],  // which platforms a typed message goes to
    // Credentials the OAuth flows use. Defaults are the desktop app's, and can
    // be replaced with your own in the options page.
    twitchClientId: FCM.DEFAULT_TWITCH_CLIENT_ID,
    kickProxyUrl: FCM.DEFAULT_KICK_PROXY_URL,
    // Which URL Kick is told to redirect back to after sign-in.
    //   'shared'    — the redirect the desktop app already registers with the
    //                 same Kick application. Nothing to register; the extension
    //                 watches for the tab reaching it and reads the code from
    //                 the address, so no local server has to be running.
    //   'extension' — straight back to this extension via chrome.identity.
    //                 Tidier, but that URL carries the extension's id and has
    //                 to be registered with Kick.
    //   'proxy'     — via the worker's /kick-callback, which forwards it here.
    //                 One fixed URL to register, and it never changes.
    kickRedirect: 'shared',
  };

  // Every state a connection can be in, and how each one reads.
  //
  // The status dot tells them apart by colour and by shape; this is the same
  // fact in words, for the chip's tooltip and for a screen reader, so the state
  // is never something only a sighted user can work out. Every state the
  // background worker can report has to appear here.
  FCM.CONNECTION_STATES = ['connecting', 'connected', 'disconnected', 'error', 'idle'];
  FCM.CONNECTION_STATE_WORDS = {
    connecting: 'connecting',
    connected: 'connected',
    disconnected: 'disconnected — trying again',
    error: 'disconnected — trying again',
    idle: 'not connected',
  };

  // Platforms a typed message can be sent to.
  FCM.SEND_PLATFORMS = ['twitch', 'kick'];

  // Twitch URL segments that are pages, not channels.
  //
  // The sign-in and consent paths matter more than they look: the OAuth flow
  // redirects through twitch.tv/login, and mounting an overlay there would sit
  // on top of the login form inside the sign-in window.
  FCM.TWITCH_RESERVED = new Set([
    '', 'directory', 'settings', 'videos', 'p', 'downloads', 'jobs', 'turbo',
    'friends', 'subscriptions', 'inventory', 'wallet', 'drops', 'search',
    'following', 'store', 'prime', 'bits', 'privacy', 'legal', 'about', 'u',
    'moderator', 'popout', 'embed', 'team', 'collections', 'products', 'payments',
    'login', 'signup', 'logout', 'oauth2', 'authorize', 'connect', 'activate',
    'dashboard', 'broadcast', 'creatorcamp', 'security', 'redeem', 'gift',
    'checkout', 'subscribe', 'terms', 'admin', 'user', 'directory-following',
  ]);

  // Kick URL segments that are pages, not channels.
  FCM.KICK_RESERVED = new Set([
    '', 'browse', 'following', 'categories', 'category', 'search', 'settings',
    'dashboard', 'clips', 'about', 'help', 'careers', 'privacy', 'terms',
    'community-guidelines', 'transparency-report', 'creator', 'subscriptions',
    'wallet', 'messages', 'notifications', 'video', 'popout',
    'login', 'signup', 'logout', 'oauth', 'oauth2', 'authorize', 'connect',
    'account', 'verify', 'password', 'checkout', 'subscribe', 'admin', 'user',
  ]);

  // ── Cheers ───────────────────────────────────────────────────────────────────────

  // Twitch's global Cheermote prefixes. A Cheer is a prefix with an amount
  // stuck to it — "Cheer100", "uni500" — and the prefix is what tells one apart
  // from an ordinary word that happens to end in digits.
  //
  // The live list for a channel is fetched on join and includes whatever
  // Cheermotes the broadcaster has of their own; this is the fallback for when
  // that call has not landed yet or was refused, and on its own it covers the
  // ones almost everybody actually types.
  FCM.GLOBAL_CHEERMOTES = [
    'Cheer', 'BibleThump', 'cheerwhal', 'Corgo', 'uni', 'ShowLove', 'Party',
    'SeemsGood', 'Pride', 'Kappa', 'FrankerZ', 'HeyGuys', 'DansGame', 'EleGiggle',
    'TriHard', 'Kreygasm', '4Head', 'SwiftRage', 'NotLikeThis', 'VoHiYoo',
    'KappaPride', 'MrDestructoid', 'bday', 'RIPCheer', 'Shamrock', 'Streamlabs',
    'Muxy', 'HolidayCheer', 'Anon', 'Charity',
  ];

  /**
   * The Cheer in a message, if there is one.
   *
   * Twitch has no API for spending Bits — the Helix endpoint the overlay sends
   * through posts "Cheer100" as dead text and takes nothing from the balance —
   * so a message carrying one has to go through the page's own chat box
   * instead, which is the only thing that actually cheers. Finding it is what
   * lets that decision be made before the message goes to the wrong place.
   *
   * @param {string} text the typed message
   * @param {string[]|Set<string>} [prefixes] the Cheermotes this channel knows,
   *   defaulting to the global ones
   * @returns {{prefix: string, amount: number, total: number, tokens: number}|null}
   */
  FCM.findCheer = function (text, prefixes) {
    const supplied = prefixes && (prefixes.length || prefixes.size) ? prefixes : null;
    const known = new Set([...(supplied || FCM.GLOBAL_CHEERMOTES)]
      .map((name) => String(name).toLowerCase()));
    let first = null;
    let total = 0;
    let tokens = 0;
    String(text || '').split(/\s+/).forEach((word) => {
      // Anchored, so "notacheer100x" and a bare "100" are both left alone.
      const m = /^([A-Za-z][A-Za-z0-9_]*?)([0-9]+)$/.exec(word);
      if (!m) return;
      if (!known.has(m[1].toLowerCase())) return;
      const amount = Number(m[2]);
      if (!Number.isSafeInteger(amount) || amount < 1) return;
      if (!first) first = { prefix: m[1], amount };
      total += amount;
      tokens++;
    });
    if (!first) return null;
    return { prefix: first.prefix, amount: first.amount, total, tokens };
  };
})(self.FCM);
