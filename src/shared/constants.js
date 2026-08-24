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
    hideNativeChat: false,      // collapse the site's own chat while merged
    // The site's own chat furniture, which the overlay would otherwise cover.
    revealHighlights: true,     // shrink so hype trains, polls, predictions and
                                // pinned messages stay visible above the panel
    showNativeStats: true,      // read bits, Kicks and channel points off the
                                // page, and open the site's own rewards menu
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
})(self.FCM);
