# Friendly Chat Extension

A Chrome extension that puts [Friendly Chat](https://github.com/JRBlaze/FriendlyChat)'s merged
chat feed directly on the page you are already watching.

Open a Twitch channel and the merged chat overlay appears over Twitch's own chat. If that
streamer is also live on Kick, the overlay says so and offers to add the Kick chat to the same
feed. Open a Kick channel and it works the other way round.

![Platform](https://img.shields.io/badge/Chrome-MV3-blue)
![Version](https://img.shields.io/badge/version-1.0.0-green)

## What it does

- **Exactly covers the site's own chat.** The panel takes the chat column's own width, height
  and position — not an approximation — and keeps matching it as you drag Twitch's chat-width
  handle, toggle theatre mode, collapse the sidebar or resize the window.
- **Tells you when they are live on the other platform.** While you watch Twitch it works out
  which Kick channel belongs to the same streamer, checks whether it is live, and offers to
  connect it. The same logic runs in reverse on Kick.
- **One merged feed.** Twitch and Kick messages interleave in a single scroll, each tagged with
  a coloured dot and the platform's own username colour, and each filterable on and off.
- **Real emotes and badges.** Twitch emotes from the IRC tag, Kick's inline emote tokens, Kick's
  channel/global/emoji sets, plus 7TV, BetterTTV and FrankerFaceZ for both platforms. Twitch
  badge images and Kick badge labels render inline.
- **Recent history on join,** with the original timestamps, so you are not staring at an empty
  panel when you arrive mid-stream.
- **Events**: subs, resubs, gifted subs, raids, cheers, hype trains, timeouts and bans, shown as
  muted rows so they never look like something a viewer typed.
- **A full composer**: an emote picker grouped by source with search, `:emote` and `@name`
  autocomplete with Tab completion, and click-a-username for reply.
- **Send to both platforms at once**, or either one — the same target chips the desktop app has.
- **System and event rows** render exactly as they do in the desktop app: a `SYSTEM`/`EVENT` tag,
  a chip naming the source, then the body, in a muted style that never reads like a viewer's
  message.
- **Messages wrap under the username**, like the platforms' own chats, rather than into a narrow
  column beside it.
- **Timestamps and username badges can each be turned off**, and the change applies to the
  messages already on screen, not just the next one in.
- **Moderation tools** in the username menu, for the channels you actually moderate.
- **Follows the site's own theme.** Twitch or Kick in dark mode gets a dark overlay, light mode
  gets a light one, and it switches the moment you change it on the site.
- **Several streams at once.** Each tab keeps its own sockets, channels and feed.

## Install

There is nothing to build and nothing to install first — Chrome loads the folder as it is.

**[⬇ Download the latest release](../../releases/latest)** — grab
`FriendlyChatExtension-v1.0.2.zip` from the Assets list, then follow the steps below.

(You can also use the green **Code → Download ZIP** button, but that gives you the whole
repository — tests, the Cloudflare worker, and a folder named `FriendlyChatExtension-main`. The
release zip is just the extension.)

1. **Unzip it.** You get a folder called `FriendlyChatExtension` with `manifest.json` sitting
   directly inside it, next to `src` and `icons`. Put it somewhere it can stay — Chrome loads it
   from that location every time, so it must not be deleted or moved into the recycle bin.
2. **Open Chrome and go to `chrome://extensions`.** Type that into the address bar and press
   Enter. (It is also under ⋮ menu → Extensions → Manage Extensions.)
3. **Turn on Developer mode** using the switch in the top-right corner of that page.
4. **Click "Load unpacked"** — the button appears on the top left once Developer mode is on.
5. **Choose the `FriendlyChatExtension` folder** and click Select Folder. Pick the folder
   *itself* — the one containing `manifest.json` — not the file, and not a folder above it.
6. **Check it loaded.** A card titled *Friendly Chat Extension* appears with no red error text.

That is the whole install. Now open any channel — for example `twitch.tv/somechannel` or
`kick.com/somechannel` — and the merged chat overlay appears over that site's own chat.

**Worth doing:** click the jigsaw-piece icon in Chrome's toolbar and pin *Friendly Chat Extension*,
so its button is always visible for quick settings.

### If something looks wrong

| What you see | What to do |
| --- | --- |
| "Manifest file is missing or unreadable" | You picked the wrong folder. Go back and pick the one containing `manifest.json`. |
| The card loaded but no overlay on a channel | Reload the Twitch or Kick tab. The extension only attaches to pages opened after it was installed. |
| No overlay, and you are on a directory or settings page | The overlay only appears on an actual channel page, not on browse, search or settings pages. |
| Nothing at all after a Chrome restart | Developer-mode extensions stay installed, but Chrome may prompt you to keep them. Re-enable it on `chrome://extensions`. |

### Updating or removing it

- **After editing any file**, go back to `chrome://extensions` and click the circular reload arrow
  on the extension's card, then reload the Twitch or Kick tab.
- **To turn it off temporarily**, use the toggle on its card.
- **To remove it**, click *Remove* on its card. Deleting the folder while it is still loaded will
  break it, so remove it in Chrome first.

You can move or rename the folder freely. `manifest.json` pins the extension's ID with a `key`
field, so it stays `bbjieacidkcngofgddlfipiajcchdaik` wherever it lives — which is what keeps an OAuth
redirect registration valid. See [Connecting accounts](#connecting-accounts).

## How the cross-platform match works

The hard part is knowing that `twitch.tv/somebody` and `kick.com/somebodyelse` are the same
person. Candidates are tried in confidence order and the first one that resolves to a real
channel wins:

1. **A mapping you set by hand** — in the overlay's settings, under the other platform's name.
   This never expires and is never overwritten by a guess.
2. **A cached result** from a previous visit (six hours).
3. **A link on the channel page itself.** The streamer's own about panel and social links are
   scanned for a URL pointing at the other platform. This is the strongest automatic signal,
   because the streamer put it there.
4. **The same name** on the other platform.

Misses are cached too, so a channel with no counterpart is not re-probed on every page view.
Everything found this way is listed in the extension's options page, where you can correct or
remove individual entries.

Once a counterpart is known, its live state is re-checked every 90 seconds while you watch, so
if they start their Kick stream halfway through the Twitch one, the overlay notices and says so.

### What you are asked, and when

`Settings → When the streamer is also live on the other platform`:

- **Ask me** (default) — a banner appears at the top of the overlay with who they are, viewer
  count and category, and buttons to add that chat, dismiss, or change the setting.
- **Connect automatically** — the second chat joins on its own and a line in the feed says so.
- **Do nothing** — no banner. The other platform still shows a live pip in the header chips, and
  clicking that chip connects it.

Dismissing the banner keeps it dismissed for that channel until you reload the page.

## The composer

Everything below is in the overlay's own message box, so it works the same whichever site you
are on.

- **Emote picker** — the smiley button opens every emote currently loaded, grouped by source
  (Twitch, Kick Channel/Global/Emoji, 7TV, BTTV, FFZ) with a search box. Clicking one inserts it
  at the cursor.
- **`:emote` autocomplete** — type a colon and at least two characters. Exact prefix matches sort
  first. **Tab** completes the highlighted row, arrows move, Escape closes.
- **`@name` autocomplete** — type an at-sign and a letter to complete from everyone who has
  spoken recently, newest first, on either platform, each row tagged with which one.
- **Click a username** for reply, copy, or opening that person's channel. Reply drops
  `@name ` into the box, and doing it again appends rather than replacing, so you can address
  two people at once.

### Replies go to the chat the person is actually in

A merged feed makes it easy to reply into the wrong room: the Kick viewer you are answering
cannot see a message that went to Twitch. So addressing someone — from the username menu, or by
completing their name from the `@` list — points the send at *their* platform for that message
and shows a **Replying to** bar above the box saying who and where.

- Reply to two people on different platforms and the message goes to both chats, since both need
  to see it.
- If that chat cannot be posted to — no account connected, or its chat is not open in the overlay
  — the overlay says so when you click Reply, and **refuses to send rather than quietly
  rerouting** to the other platform.
- The scope lasts for one message. It clears when the message goes out, when you empty the box,
  on Escape, on the bar's `×`, or as soon as you touch the target chips yourself.

### Sending to one platform or both

The **Send to** chips above the box decide where a typed message goes. Each one shows how it
would actually be delivered:

| Chip shows | What it means |
| --- | --- |
| your account name | A connected account — works for either platform |
| `via page` | No account, but this is the site you are on, so the page's own chat box is driven |
| `connect` | The other platform with no account connected — click to set one up |

At least one target always stays selected. If a send only partly succeeds, the toast names the
platform that refused and the reason lands in the feed as a system row.

## Moderating

If you are a moderator or the broadcaster in a channel, clicking a name in the feed adds a
**Moderate** section to the menu: a row of timeout presets, then delete this message, remove
timeout / unban, and ban.

- The tools appear **per platform**, and only where the platform itself says you hold the badge.
  Twitch reports it in `USERSTATE` on an authenticated connection; Kick reports it on the channel
  record. Moderating Twitch does not put Kick buttons in a Kick viewer's menu.
- Actions apply to **the message you clicked**, so deleting removes that line rather than
  guessing at "their last one".
- Timeout presets are 1s, 1m, 10m, 1h and 24h on Twitch. Kick counts timeouts in whole minutes,
  so the 1s purge is not offered there — it would quietly cost the viewer a full minute.
- The worker re-checks the permission before acting, so a stale overlay cannot act on a badge
  you no longer hold.
- Every outcome is written into the feed in plain words, including refusals and why.

Connecting an account is what makes this possible, and the scopes are requested at sign-in
(`moderator:manage:banned_users` and `moderator:manage:chat_messages` on Twitch,
`moderation:ban` and `moderation:chat_message:manage` on Kick). If you connected an account
before this existed, disconnect and reconnect it to pick the new scopes up.

## Connecting accounts

Reading chat never needs an account. Connecting one buys you two things: sending without
touching the page's own chat box, and — the part that matters — **sending to the platform you
are not currently browsing**, so a message can go to Twitch and Kick at once.

- **Twitch** uses the implicit grant, so a client id is all it needs — which is why its
  application has to be registered as a *public* client.
- **Kick** uses OAuth 2.1 with PKCE. Its token exchange requires a client secret, so the code is
  exchanged through the same Cloudflare Worker the desktop app uses; the secret stays on the
  worker and never reaches the browser. Kick needs no setup — see below.

Tokens live in `chrome.storage.local`, never in `storage.sync`, so they are not replicated across
your browsers. Kick tokens refresh silently; a Twitch implicit token cannot be refreshed, so when
it expires the overlay says so and asks you to reconnect.

### Setup you have to do yourself

**Both platforms refuse the sign-in until this extension's redirect URL is registered with them.**

Kick says so plainly (*invalid redirect uri*). Twitch does not, and its behaviour is worth
understanding because the symptom points nowhere near the cause:

> When the redirect URL is not registered, Twitch still shows you the consent screen. You click
> Authorize, and Twitch then sends the browser to whichever redirect URL *is* registered on that
> application, carrying `?error=redirect_mismatch`. If nothing is listening there, that page fails
> to load and Chrome reports only **"Authorization page could not be loaded"** — which says
> nothing about redirects at all.

So if you see that message, look at the address bar of the window that flashed up. `redirect_mismatch`
in the URL confirms it, and the host it went to is the redirect the application *does* have
registered.

The URL to register is fixed for this extension:

```
https://bbjieacidkcngofgddlfipiajcchdaik.chromiumapp.org/
```

It does not change when you move the folder, because `manifest.json` pins the extension's ID with
a `key` field. Register it once and it keeps working.

**On Twitch:** this extension ships with its own application — *Friendly Chat Extension*, client ID
`4bfkouj78vsa1crhf7juucfkb273nv`, registered as a **Public** client with exactly the redirect URL
above. If that is the application you are using, there is nothing to do.

To use a different one, register it at the [developer console](https://dev.twitch.tv/console/apps):

- **Client Type** must be **Public** — the implicit grant this extension uses is not available to
  confidential clients.
- Paste the redirect URL into **OAuth Redirect URLs**, click **Add**, then **Save**. Typing it
  into the box is not enough on its own; it has to be added to the list.

Then put its client ID into the extension's options page. Nothing else needs to change.

**On Kick: nothing to do.** The extension uses the same proxy and the same registered redirect
as the desktop app, so the Connect button works as shipped.

It talks to the same worker
(`https://friendly-chat-kick-proxy.jrblaze.workers.dev`), the same endpoints (`/kick-config`,
`/kick-token`, `/kick-refresh`), and by default the same redirect the desktop app registers:
`http://localhost:8080/friendly-chat.html`.

The Kick client id is **not** kept in this repository. The worker holds the client secret, so
only the worker knows which application that secret belongs to — the extension asks it at
sign-in. A copy in the source could only go stale and send people to authorise against the wrong
application, and it would buy nothing: if the worker is unreachable, the token exchange fails
anyway, so the sign-in stops before the consent screen rather than after it.

Reusing that redirect is what removes the setup step, and it needs one trick.
`chrome.identity.launchWebAuthFlow` only ever finishes on a `chromiumapp.org` URL, so it cannot
be used here. Instead the extension opens an ordinary tab, and watches for it reaching the
redirect. That works even though nothing is listening on port 8080: the tab's address changes to
the redirect — carrying the authorization code — before the load fails. The extension reads the
code from there and closes the tab. **No local server has to be running.**

If you would rather not lean on the desktop app's registration, the options page offers two
alternatives, each needing one URL registered with Kick first:

| Setting | Register with Kick |
| --- | --- |
| **Reuse the desktop app's URL** (default) | *nothing — already registered* |
| Straight back to the extension | `https://bbjieacidkcngofgddlfipiajcchdaik.chromiumapp.org/` |
| Via the proxy worker | `https://friendly-chat-kick-proxy.jrblaze.workers.dev/kick-callback` |

Kick's token exchange requires a client secret even with PKCE — omitting it answers 400, a wrong
one answers 401 — which is why the exchange goes through the worker rather than the browser. The
client id itself is public and only starts the sign-in.

### The worker

`cloudflare-worker.js` and `wrangler.toml` in this folder deploy over the existing worker under
the same name, so its URL does not change and its secrets survive:

```bash
wrangler deploy
```

It differs from the desktop app's worker in two ways, both of which came out of debugging this:

- **Failures are reported properly.** Kick answers a rejected token request with 400 and an
  *empty body*, and calling `.json()` on that threw — so every exchange failure arrived as
  `Unexpected end of JSON input`, which says nothing. Responses are now read as text and only
  parsed when there is something to parse, and the reply carries Kick's own words, the HTTP
  status, and a hint naming the likely cause (401 means the worker's client secret does not match
  its client id; 400 on an authorization code usually means the redirect did not match).
- **`/kick-callback` bridges the redirect.** It reads the extension's own redirect out of the
  `state` parameter and forwards every parameter Kick returned. It only ever forwards to a
  `chromiumapp.org` URL, so it cannot be turned into an open redirect.

It must match **exactly** — same scheme, same id, and the trailing slash included.

If sign-in still fails, the overlay's **Settings → Accounts** panel shows the failure in full,
with the URL to copy and whatever the platform actually said. It stays there until the account
connects, rather than vanishing as a toast.

That panel also carries an **Open the sign-in page in a tab** button, which is the test that
separates the two possible causes:

- **The consent screen appears** — the redirect *is* registered, and the problem is the sign-in
  window rather than the registration.
- **An error appears** — that error names exactly what still needs fixing, in the platform's own
  words rather than Chrome's generic one.

Note that Twitch only checks the redirect URL *after* you are signed in to Twitch, so an
unregistered URL looks like an ordinary login page right up until the moment it fails.

If you would rather use your own credentials, the options page takes a Twitch client id and a
Kick proxy URL. Leave them alone to use the desktop app's.

## Where the data comes from

Nothing is proxied through a server, and no API key or sign-in is involved.

| What | Source |
| --- | --- |
| Twitch chat | `wss://irc-ws.chat.twitch.tv` — anonymous `justinfan` login |
| Twitch live state, metadata, badges | `gql.twitch.tv`, using Twitch's own public web client id |
| Twitch history | `recent-messages.robotty.de` (the service Chatterino uses) |
| Kick chat | Kick's Pusher WebSocket, subscribed anonymously to the chatroom |
| Kick channel, live state, history, emotes | `kick.com/api/v2/...` and `kick.com/emotes/...` |
| Third-party emotes | 7TV, BetterTTV, FrankerFaceZ |
| Sending, when an account is connected | `api.twitch.tv/helix/chat/messages`, `api.kick.com/public/v1/chat` |

Reading chat is anonymous — no account, no API key. Requests to Kick are made with
`credentials: 'omit'` so your Kick cookies are never attached. What gets stored is your settings,
the channel-to-channel mappings above, and — only if you connect an account — that account's
token in `chrome.storage.local`.

## Architecture

```
manifest.json
src/
  shared/          loaded by BOTH the service worker (importScripts) and the content script
    namespace.js     the single FCM global everything hangs off
    constants.js     endpoints, limits, defaults, reserved URL segments
    util.js          escaping, settings storage, system-message formatting
    irc.js           Twitch IRCv3 line/tag/emote-position parsing
    kick-events.js   Pusher event names -> readable summaries
    emote-parsers.js Kick emote payloads, 7TV url building
  background/      everything that touches the network
    service-worker.js  per-tab sessions, the port protocol, live polling
    twitch-source.js   IRC socket, reconnect/backoff, history
    kick-source.js     Pusher socket, reconnect/backoff, history
    discovery.js       platform lookups, badges, counterpart matching
    emotes.js          third-party emote providers
    auth.js            Twitch implicit + Kick PKCE sign-in, token storage
    send.js            posting a message to each platform's chat API
  content/         everything that touches the page
    boot.js          channel detection, SPA navigation, the port
    overlay.js       the shadow-DOM panel, prompt, targets and settings sheet
    compose.js       emote picker, : and @ autocomplete, the username menu
    render.js        message tokenising and row building
    feed.js          the batched, bounded message feed
    sites.js         per-site selectors and the native composer
    overlay.css
  options/ popup/
tests/
  run.js           offline test suite
  background.js    boots the real service worker with the platforms stubbed
  harness.html     the overlay against a mock channel page
cloudflare-worker.js   the Kick token-exchange proxy, deployed separately
wrangler.toml
```

### Why the sockets live in the service worker

Both WebSockets and every REST call run in the background worker, not the content script. A Kick
socket opened from a `twitch.tv` tab is a cross-origin connection that only the extension's host
permissions can make, and running there also puts the connections out of reach of the host page's
`connect-src` policy. The content script holds one long-lived `chrome.runtime` port, pings it
every 20 seconds to keep the worker alive, and re-issues its joins if the worker is ever recycled.

### How the overlay is sized

The panel is `position: fixed` and its box is set from the chat column's own
`getBoundingClientRect()` every sync, so it is the same width and height as the chat underneath
rather than a fixed guess. It carries no minimum width or height of its own, which means a
narrow chat column gets a narrow overlay.

Finding that column is done in two ways. Each site's known chat-column selectors are tried
first. If none of them match — which is what happens whenever Twitch or Kick renames its
markup — the message list is located instead (a far more stable target) and the overlay climbs
up from it to the outermost ancestor that is still the same width. That ancestor is the chat
panel as the site draws it: header, messages and composer, and nothing of the page around it.

A sync that finds nothing keeps the last box that worked rather than jumping, so a re-render or
an ad break does not throw the overlay across the screen. Placement is re-checked on resize, on
scroll, by a `ResizeObserver` that re-attaches whenever the site swaps the chat node out, and by
a 500 ms poll for the layout changes that fire no event at all.

### How sending works

The overlay holds no token, so a message you type is handed to the page's own chat box and goes
out as the account already signed in there.

That is harder than it sounds. Neither site uses a plain `<input>`: Twitch's composer is Slate
and Kick's is Lexical, and both keep their own model of the text, so writing to the DOM changes
nothing they will read back. The send path therefore tries a sequence of insertion routes — a
real `paste` event carrying a `DataTransfer` (which both editors handle), then `execCommand`,
then a `beforeinput`/`input` pair, then a direct write for a plain contenteditable — and reads
the box back after each one to see whether the text actually took.

Driving that box means moving focus into it, so where focus was is captured first and handed
back the moment the message is away — otherwise the caret is left in the page's own chat box,
which the overlay is sitting on top of, and the next thing you type goes somewhere you cannot
see. The overlay's input is refocused after every send for the same reason, including when you
click the Send button rather than pressing Enter.

It then clicks the site's send button if there is one, or presses Enter, and checks that the
composer emptied itself. An empty composer is the site confirming it accepted the message;
anything left sitting there means it did not go out, and the overlay says which of those
happened rather than reporting a silent success. Failed text is put back in the overlay's input
so it is not lost.

If you have turned on *hide the site's own chat*, the composer's subtree is un-hidden for the
duration of the send and re-hidden afterwards — a hidden element cannot be focused or typed into.

### Several streams at once

Every session in the background worker is keyed by tab id, so two channels open side by side
each keep their own sockets, their own joined channels and their own counterpart state. A
message that arrives on one tab's socket is posted only to that tab. Closing one tab drops that
tab's sockets and leaves the others running. Two tabs on the *same* channel deliberately keep
separate connections rather than sharing one, so leaving in one tab cannot cut the other off.

The lookup caches (channel records, live state, Twitch's global badge list) *are* shared across
tabs, which is the point: the second tab on a channel costs no extra requests.

### Why the overlay is in a shadow root

Twitch and Kick both ship large, aggressive stylesheets. A shadow root means the page cannot
restyle the overlay and the overlay cannot leak styles onto the page. The panel is positioned
`fixed` and synced to the chat column's bounding box rather than being inserted into the site's
DOM, so nothing in the page's layout or stacking contexts has to be fought with.

## Development

```bash
node tests/run.js
```

624 assertions, no network. It drives the real parsers with real payload shapes: IRC lines with
tags and emote positions, Kick Pusher events, emote sets from every provider, and the
counterpart matcher against stubbed platform APIs — including the cases that matter most, like a
manual mapping beating a same-name guess and a failing emote provider not taking the others down.

`tests/background.js` boots the **real service worker** with `chrome.*`, `WebSocket` and `fetch`
stubbed, then drives it exactly as a content script does — connect a port, say hello, join
channels, push raw IRC and Pusher frames in, and read back what it posts to the tab. That covers
the handshake order, ping/pong, reconnect backoff, moderation permissions, session teardown and
multi-tab isolation.

Two suites exist specifically to break things rather than to confirm they work:

- **`resilience`** feeds malformed and hostile input to everything that renders — truncated IRC
  lines, emote payloads of every wrong shape, 50k-character messages, astral emoji, RTL marks,
  and markup injection through usernames, emote names, emote URLs and badge URLs. Its strongest
  assertion is that every tag in the rendered output is one the renderer itself emits, so an
  injected element of any kind would fail it.
- **`errors`** points the background worker at platforms that are down, slow, or lying: every
  request failing, unparseable JSON, a channel with no chatroom, junk arriving on both sockets,
  and malformed commands from the page.

Run one suite with `node tests/run.js <name>` (`irc`, `kick`, `render`, `settings`, `compose`,
`reply`, `sites`, `discovery`, `emotes`, `theme`, `auth`, `send`, `resilience`, `errors`, `feed`,
`moderation`, `multitab`, `background`).

To look at the overlay without loading the extension, serve the project root and open the
harness. It mocks a channel page, the `chrome.*` APIs, and — importantly — a *controlled* chat
composer that reconciles the DOM back to its own model the way Slate and Lexical do, with a
switch for which input route it honours. That is what makes the send path testable offline:

```bash
python -m http.server 8123
```

Then open `http://127.0.0.1:8123/tests/harness.html`. The buttons along the bottom push messages,
events and the cross-platform prompt through the real rendering path, resize the mock chat column
to check the overlay tracks it, drop the chat-column selectors to exercise the walk-up fallback,
and fake connected accounts so the send-target chips and the send-to-both path can be driven
without signing in to anything. Setting `window.autoSendResult` answers a send with a canned
per-platform result, which is how the partial-failure and expired-token paths get exercised. Setting `composerMode` in the console to `paste-only`, `beforeinput`, `plain`,
`readonly` or `no-submit` switches how the mock composer behaves, which covers each branch of
the send path.

## Bugs this testing found

- **Switching channels churned between connect and disconnect.** Two races, either of which
  alone was enough. A socket's `close()` is asynchronous, so the one being replaced reported its
  close *after* the replacement had already reset the shared "closing on purpose" flag — the drop
  then read as unexpected and queued a reconnect to the channel just left, which closed the new
  socket, whose close did the same in reverse. Separately, `joinChannel` awaits two storage reads
  between leaving one channel and opening the next, so clicking through quickly let a stale join
  finish last and connect to the wrong channel. Sockets now carry a generation and joins a
  sequence number; anything superseded stands down. Reverting either fix makes the `endtoend`
  suite fail on socket count and on a reported drop.

- **Switching channels flipped back to the previous one.** Each channel change opened a new port
  to the background worker without closing the old one, so the channel being left kept delivering
  messages — and those messages repopulated the record of what was joined. The worker's
  confirmation for the *new* channel then saw a join already registered and skipped it, leaving
  the overlay on the old channel. The port is now closed before the new one opens, every message
  and timer carries the navigation it belongs to and stale ones bow out, and the worker refuses to
  let a disconnecting port clear one that has already replaced it. The `navigation` suite
  reproduces the original symptom exactly: with the old code, the new channel is never joined.

- **The overlay mounted on the platforms' own sign-in pages.** `twitch.tv/login` was not on the
  reserved-path list, so the extension treated `login` as a channel name: it mounted a chat panel
  over the login form and tried to join a channel called "login". That page is exactly where the
  Twitch OAuth flow redirects, so it landed in the middle of signing in. Both reserved lists now
  cover the sign-in, consent and account paths, and the content script additionally refuses to
  attach to any page carrying OAuth parameters, whatever its path.


Two of these would have been visible to users, and both were found by feeding the code input it
was never going to see in a friendly test:

- **A malformed emote range hung the tab and ate memory until it died.** Twitch sends emote
  positions as `id:start-end`. A range where `end` came *before* `start` sent the tokenizer's
  cursor backwards to a position it had already passed, so it looped forever, allocating a token
  each time. Node reached its 4 GB heap limit and aborted. The tokenizer now refuses to move the
  cursor backwards, and the tag parser drops ranges that do not run forwards from a real
  position — so nonsense is discarded before it ever reaches the renderer.
- **An unrecognised platform name in a command crashed the whole service worker**, which would
  have taken down chat in *every* open tab at once, not just the one that sent it. Commands are
  now validated against the known platforms, and the whole handler runs inside an error boundary
  so no single bad message can leave the worker broken.
- Two `null`-versus-`undefined` traps in the Kick event helpers: a default parameter only covers
  `undefined`, and a Pusher frame can carry a literal `null`. Both now coerce.

## Known limits

- **Sending to the other platform needs a connected account.** Without one, a typed message can
  only go to the site you are on, through its own chat box. The target chips say which case you
  are in, and connecting an account is what unlocks sending to both at once.
- **Sign-in needs a one-off registration step.** Both platforms reject the OAuth redirect until
  the extension's `chromiumapp.org` URL is listed in their developer console — see
  *Connecting accounts* above. Nothing in the extension can do that part for you.
- **Moderation needs a connected account** on the platform in question, with the scopes granted
  at sign-in. Without one the platform never tells us you hold the badge, so the tools stay
  hidden rather than appearing and then failing.
- **Site selectors move.** Twitch and Kick both reshuffle their DOM periodically. The overlay
  falls back to locating the message list and climbing to its column, so a renamed wrapper does
  not break sizing; only if that fails too does the panel dock to the right of the window.
  `src/content/sites.js` is the one file to update when that happens.
- **Kick's API sits behind Cloudflare.** The endpoints used here are the public ones and are
  currently reachable, but if Cloudflare starts challenging them, Kick channel lookups will fail
  and the overlay will say so.
- **Same-name matching is a guess.** Two unrelated people can hold the same handle on the two
  platforms. A link on the channel page always beats the guess, and you can override either from
  the overlay's settings.

## Performance

The feed is the part that has to survive a busy channel, so it is measured rather than assumed.
Numbers below are from `tests/harness.html` driving the real render path with 3,000 emotes
loaded — roughly what 7TV global plus BTTV plus FFZ comes to:

| | before tuning | now |
| --- | --- | --- |
| 3,000 messages queued | 118 µs each | **97 µs each** |
| `:` autocomplete, worst case | 3.69 ms per keystroke | **1.66 ms** |
| `:` autocomplete, typical | 2.56 ms | **1.05 ms** |
| Emote picker open | 11 ms | **7 ms** |

Three things were doing far more work than they needed to:

- **The emote index was rebuilt on every keystroke.** Autocomplete called it for each character
  typed, rebuilding a few thousand entries every time. It is now cached against a version
  counter that only moves when an emote store actually gains something.
- **Every emote name was lower-cased on every search.** The folded name is now computed once,
  when the index is built.
- **The mention-highlight pattern was compiled per message.** On a busy channel that was a regex
  build for every line that arrived; it is now compiled when the setting changes.

Emote search also stopped sorting the whole match set. A two-character query can match thousands
of emotes when only thirty are ever shown, so matches are split into prefix and substring groups
in one pass and the second group is only sorted when it is actually needed.

Bounds hold under sustained load. A soak of **8,000 messages** across eight rounds — each round
also running autocomplete and Tab completion, opening and closing the emote picker, toggling a
filter twice, opening a user menu and replying, and flipping the site theme — held the overlay
at **2,797 DOM nodes and 400 rows on every single round**, with the JS heap at 3 MB and no
uncaught errors. Twenty-five mount/unmount cycles (the equivalent of hopping between channels
all evening) left exactly one host element behind and the page's own node count unchanged.

The worker's own caches are bounded too: channel lookups are capped at 120 entries with the
least recently written evicted, and the saved channel-link table at 400, dropping automatic
matches oldest first and never the ones set by hand.

## Credit

Built on the chat parsing, emote handling and rendering from
[JRBlaze/FriendlyChat](https://github.com/JRBlaze/FriendlyChat).
