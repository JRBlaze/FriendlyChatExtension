# Privacy Policy — Friendly Chat Extension

_Last updated: September 20, 2026_

Friendly Chat Extension shows a merged Twitch and Kick chat on the stream you
are watching. This page explains what information it uses, where that
information goes, and what it never does.

The short version: **your information stays in your browser, except when the
extension sends it to Twitch, Kick, or the emote and chat services listed below
so the chat can work. There are no ads, no analytics, and no tracking, and
nothing is sold.**

## What the extension uses

- **Your Twitch and Kick sign-ins.** When you connect an account, the extension
  receives a sign-in token from Twitch or Kick. It uses the token only to read
  and send chat for you, and it stores the token in your browser's local
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
  stored in your browser's extension storage. If you choose to export your
  settings to a file, that file is saved only where you put it. Sign-in tokens
  are never included in an export.
- **Display text sizes.** If you choose a text size for a display, the extension
  stores that size alongside the screen width and height reported by your browser.
  This stays in local extension storage on that device. It is not sent to a service,
  synced to other devices, or included in portable settings exports.

## Who the extension talks to

To make the chat work, the extension connects to these services. Each one
receives only what it needs, such as a channel name or your sign-in token for
that same platform:

- **Twitch** (twitch.tv) and **Kick** (kick.com): to read and send chat and
  sign you in.
- **7TV**, **BetterTTV**, and **FrankerFaceZ**: to load emotes for a channel.
- **recent-messages.robotty.de**: to show recent Twitch chat when you open a
  channel.
- **GitHub** (api.github.com): to check whether a newer version has been
  released.
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
- It never runs code downloaded from the internet.

## Removing your information

You can disconnect an account at any time in the extension's settings. Removing
the extension from your browser deletes everything it has stored on your
device. You can also revoke the extension's access from your Twitch or Kick
account's connection settings.

## Changes and contact

If this policy changes, the new version will be posted here with a new date.
Questions are welcome at
[github.com/JRBlaze/FriendlyChatExtension/issues](https://github.com/JRBlaze/FriendlyChatExtension/issues).
