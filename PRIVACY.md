# Privacy Policy — Friendly Chat Extension

_Last updated: September 26, 2026_

Friendly Chat Extension shows merged Twitch and Kick chat on the stream you
are watching, with optional YouTube chat and explicitly selected native sending. This page explains what
information it uses, where that information goes, and what it never does.

The short version: **your information stays in your browser, except when the
extension sends it to Twitch, Kick, YouTube, or the emote and chat services listed below
so the chat can work. Friendly Chat adds no ads, analytics or tracking, and
does not sell your information.** Third-party platform pages and services have
their own data practices, described below.

## What the extension uses

### Optional YouTube chat

Installation or the first update containing this feature opens a local setup page
with an optional access button. No permission is requested until you click it.
The popup and settings offer the same control. A local version marker
(`fcm_youtube_onboarding_v1`, value `1.23.0`) prevents repeated introductions;
it contains no channel or account information and is not synced, backed up or sent
to a server. Opening setup itself makes no YouTube request.

YouTube requires optional site access. After you grant it, visiting a
Twitch/Kick channel allows bounded public-page lookups for
YouTube suggestions. The extension considers visible YouTube channel links outside
site chat. If no valid channel link is available, it tries the current and
matched Twitch/Kick usernames as possible YouTube handles. YouTube receives the requested channel/video and your network address.
These metadata requests omit cookies and credentials. Without site access, they
do not contact YouTube.

Three delayed scans let the channel page finish loading. At most six distinct
candidates are checked per visit; up to 64 results are cached in background memory
for 30 seconds to reduce repeat requests. The cache is not stored, synced or
included in backups, and disappears when the background stops. There is no
continuous polling. Dismiss, manual Add and Remove pause these suggestions until
you choose Check YouTube or visit another channel. No suggested identity is saved.

An explicit Add action or a saved YouTube link loads two hidden YouTube
chat frames. One only captures messages; the other provides the native composer
for explicitly selected sending. Message rows in the sending frame are not
forwarded to the merged feed, so its temporary send previews cannot duplicate
captured messages. Both frames use normal YouTube page requests and may consume
more browser resources than a single chat frame. Both close when capture stops.
Saving opts the selected Twitch/Kick host into a fresh live lookup and
automatic capture on future visits. A paired host is included only when you select
the named Also link option. Offline or failed lookups do not load a frame, and site
access is always required. Saved links take priority over suggestions.
The extension reads the frame's displayed author names, message IDs, plain
message text, emoji alternatives and explicit deletion markers. It does not read
YouTube account tokens, moderate chat or change a normal YouTube page's layout.
The reader runs in the extension's isolated content-script world
only in a marked chat frame. A channel URL is resolved again when you choose Add,
Save, Check for a saved link, or visit a host with a saved link;
a failed lookup does not load chat. Direct video input does not need discovery.

YouTube sending is off by default and is never enabled by granting site access,
adding chat or saving a channel link. When the sending frame exposes a signed-in editable
composer, the extension reads its displayed account label and shows it beside the
YouTube send target. You must select that target for the current visit. This choice
and account label stay in memory, are not synced or backed up, and the choice resets
when the source or account changes.

An explicit send passes the typed text through the extension's local message bridge
to the sending frame's native composer and presses its Send button once. YouTube receives the
message under the displayed account, using its normal website session and requests.
Friendly Chat does not read or copy YouTube tokens or cookies for sending and adds
no API, hosted relay or browser permission. Messages are limited to 200 characters;
normal YouTube restrictions remain in effect. Existing native drafts are preserved.
The extension treats a cleared editor as submitted, without claiming server delivery,
and never retries an uncertain result. The native composer must be available in the
embedded context; a separate signed-in YouTube tab does not guarantee that, particularly
when the browser partitions or blocks third-party cookies. Captured messages have no
reply or moderation controls in Friendly Chat.

In Firefox, an optional **Enable sending** setup briefly shows the sender frame
with a Friendly Chat permission button. Clicking that button inside the frame
uses the browser's Storage Access API to let YouTube use its own sign-in cookies
on the current Twitch or Kick site. Enhanced Tracking Protection remains enabled.
These are separate browser-managed site grants, which can expire or be revoked;
they are not saved in extension settings, sync, or backups. The extension reads
only access/permission status, never cookie contents or account credentials.
When Firefox reports a previously granted permission and the native sender is
unavailable, the extension can reactivate that existing grant without a prompt.
It never requests new access automatically when permission is prompt, denied,
unknown, or unsupported. After a grant, the same sender frame reloads once to
load YouTube with that browser-approved session. The capture frame keeps running.
Setup can be cancelled, and failed access leaves reading available. Successful
setup still requires checking the native account and explicitly selecting YouTube
before sending; it does not send a message or change Twitch/Kick send choices.

Temporary input and captured rows stay in the current tab's memory/feed,
not extension storage, sync or settings backups. Explicit saved links store only
the Twitch/Kick host, canonical YouTube channel URL and save time in local storage
(`fcm_youtube_links_v1`, at most 400 hosts). They are included in portable settings
backups and do not sync automatically. No video IDs, chat history or tokens are
stored in those records. Remove stops the current capture; Forget removes the
current host's saved link. The options page also offers individual removal.
Changing channels or reloading stops that reader; a saved host can then start a
fresh reader for its current live stream. Browser caching and YouTube's own retention
are separate. YouTube receives normal embedded-page requests, including your
network address, video selection and embedding site; browser-permitted cookies
may accompany them. Its page loads its own normal website scripts and resources.
No Google API key or additional hosted relay is used.

As with the existing merged feed, the overlay has an open shadow root: the Twitch
or Kick page can access the messages displayed on it. Captured rows are not sent
by the extension to an analytics service or stored by a Friendly Chat server.
You can revoke YouTube site access in the browser's extension settings.

### Sent-message recall

The composer keeps up to 50 recently sent message texts in the current tab's
memory so Up/Down can recall them for editing or an explicit resend. It keeps
texts accepted by at least one destination, excluding uncertain YouTube sends
and Cheers; consecutive identical texts use one entry. The draft you were typing
is held while browsing and restored when you move back past the newest entry.
This history is discarded when the overlay is destroyed, including on channel
navigation or page reload. It is not written to extension storage, synced,
included in backups or sent to any service by recalling it. A resend uses the
currently selected destinations and their existing sending paths.

### Existing Twitch/Kick data

- **Your Twitch and Kick sign-ins.** When you connect an account, the extension
  receives a sign-in token from Twitch or Kick. It uses the token for the chat,
  account, emote and moderation features you use, subject to that platform's
  permissions, and stores the token in your browser's local
  extension storage on that device.
- **Your Kick session cookie.** If you are signed in to kick.com, the extension
  reads Kick's `session_token` cookie so it can ask Kick about your standing in
  a channel (for example, whether you are a moderator), the same way Kick's own
  website does. The cookie is sent only to kick.com and is never stored or
  shared anywhere else.
- **Chat and channel information.** The extension reads the chat messages,
  channel names, and emotes for the streams you watch so it can display them.
  It does not keep a history of what you watch.
- **Your settings.** Your preferences, favourites, and channel pairings are
  stored in your browser's extension storage. General preferences use the browser's
  sync storage and can follow your browser account when sync is enabled. Tokens,
  saved YouTube links, per-channel send choices and display-specific sizes stay
  local. If you choose to export your
  settings to a file, that file is saved only where you put it. Sign-in tokens
  are never included in an export.
- **Display text sizes.** If you choose a text size for a display, the extension
  stores that size alongside the screen width and height reported by your browser.
  This stays in local extension storage on that device. It is not sent to a service,
  synced to other devices, or included in portable settings exports.
- **Channel and account identifiers.** Display names, usernames, account IDs,
  channel URLs and selected video IDs identify the chats and accounts needed for
  reading, linking and sending. The extension checks the current supported page
  and channel links; it does not collect a general browsing-history log or read
  unrelated pages through the browser history API.
- **Rewards and transaction-related chat information.** The overlay can display
  the Bits, Kicks and channel-point balances shown by the native page, along with
  subscription, gift and Cheer events and related chat metadata. These features
  can involve virtual-currency amounts or paid activity. Purchases and their
  confirmation remain with the platform's own controls. Friendly Chat does not
  request or store credit-card numbers, bank details or billing credentials.
- **Chat interactions.** Typed drafts, selected destinations, replies, supported
  moderation actions and recalled messages are handled to carry out your chat
  actions. There is no general click, pointer, scroll or keystroke analytics log.
  Services contacted over the network receive your IP address as part of normal
  requests. Friendly Chat does not obtain GPS coordinates or use IP geolocation.

## Who the extension talks to

To make the chat work, the extension connects to these services. Each one
receives only what it needs, such as a channel name or your sign-in token for
that same platform:

- **Twitch** (twitch.tv) and **Kick** (kick.com): to read and send chat and
  sign you in.
- **YouTube / Google** (youtube.com and its normal page-resource services):
  for optional permitted channel suggestions, explicitly attached chat, and messages you
  choose to send through its native composer, as described above.
- **7TV**, **BetterTTV**, and **FrankerFaceZ**: to load emotes for a channel.
- **recent-messages.robotty.de**: to show recent Twitch chat when you open a
  channel.
- **GitHub** (api.github.com): unpacked Chrome builds check for newer releases.
  Chrome Web Store builds instead use Chrome's update system and do not include
  this GitHub API host permission. Firefox uses its browser-managed update feed.
- **The extension's own sign-in helper** (friendly-chat-kick-proxy.jrblaze.workers.dev,
  run on Cloudflare): Kick requires a private key to finish signing in, which
  cannot be kept safely inside an extension, so this small helper completes the
  Kick sign-in and passes the result straight back to your browser. It does not
  store or log your token, sign-in codes, or requests.

Each of these services has its own privacy policy, which applies to what they
receive.

## What the extension never does

- It never sells or rents your information.
- It never uses your information for advertising, profiling, or anything
  unrelated to showing and sending chat.
- It never sends your information to any service other than the ones listed
  above.
- Its extension code is bundled with the installed package; it does not download
  and execute remote code as extension code. The embedded YouTube page loads and
  runs YouTube's own website scripts, as described above.

## Limited Use

Friendly Chat Extension's use and transfer of information received through
browser permissions follows the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data),
including its Limited Use requirements. Information is used only for the
extension's disclosed chat features and shared with the services needed to
provide them. It is not sold, used for advertising, used for creditworthiness or
lending decisions, or transferred for unrelated purposes. Friendly Chat does not
operate a service that stores chat conversations for the developer to read.

## Removing your information

You can disconnect an account at any time in the extension's settings. Removing
the extension from your browser deletes everything it has stored on your
device. You can also revoke the extension's access from your Twitch or Kick
account's connection settings.

## Changes and contact

If this policy changes, the new version will be posted here with a new date.
Questions are welcome at
[github.com/JRBlaze/FriendlyChatExtension/issues](https://github.com/JRBlaze/FriendlyChatExtension/issues).
