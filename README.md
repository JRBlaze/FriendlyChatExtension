# Friendly Chat Extension

A Chrome extension that puts [Friendly Chat](https://github.com/JRBlaze/FriendlyChat)'s merged
chat feed directly on the page you are already watching.

Open a Twitch channel and the merged chat overlay appears over Twitch's own chat. If that
streamer is also live on Kick, the overlay says so and offers to add the Kick chat to the same
feed. Open a Kick channel and it works the other way round.

![Platform](https://img.shields.io/badge/Chrome-MV3-blue)
![Version](https://img.shields.io/badge/version-1.4.1-green)

## What it does

- **Exactly covers the site's own chat.** The panel takes the chat column's own width, height
  and position — not an approximation — and keeps matching it as you drag Twitch's chat-width
  handle, toggle theatre mode, collapse the sidebar or resize the window.
- **Leaves the site's own cards showing, on both platforms.** A hype train, poll, prediction,
  pinned message or leaderboard at the top of chat is measured and the panel starts below it, so
  the real card stays visible and stays clickable. Nothing about it is redrawn or reimplemented.
  Kick has two of these slots and gets both: the gifter leaderboard, which pushes the chat down,
  and the pinned message, which floats over the top of it.
- **Your bits, Kicks and channel points**, read off the page and shown above the composer, with
  a *Claim bonus* button when one is waiting. Clicking a balance opens the site's own rewards or
  cheer menu, and the panel steps out of the way for as long as it is open.
- **Drag and resize it, and put it back.** Move or resize the panel and it stays where you put
  it, on that platform, across reloads. A reset button appears in the title bar the moment you
  do, and snaps it back over the site's own chat at the size it first opened at.
- **Tells you when they are live on the other platform.** While you watch Twitch it works out
  which Kick channel belongs to the same streamer, checks whether it is live, and offers to
  connect it. The same logic runs in reverse on Kick.
- **One merged feed.** Twitch and Kick messages interleave in a single scroll, each tagged with
  a coloured dot and the platform's own username colour, and each filterable on and off.
- **Every emote you can actually use.** Twitch global, channel, subscriber, follower, bits-tier,
  hype-train, rewards and Prime emotes; Kick's channel, global and emoji sets; and 7TV, BetterTTV
  and FrankerFaceZ on both platforms. They are grouped by where they came from in the picker, and
  the Twitch list is the one Twitch itself says your account may send. Twitch badge images and
  Kick badge labels render inline.
- **Recent history on join,** with the original timestamps, so you are not staring at an empty
  panel when you arrive mid-stream.
- **Events**: subs, resubs, gifted subs, raids, cheers, hype trains, timeouts and bans, shown as
  muted rows so they never look like something a viewer typed.
- **A full composer**: an emote picker grouped by source with search, `:emote` and `@name`
  autocomplete with Tab completion, and click-a-username for reply.
- **Emotes appear as you type them.** Finish an emote name, press space, and it is drawn in the
  message box — so what you are about to send is what you can see. The message still goes out as
  text, because that is what chat is.
- **Favourite emotes.** Star one in the picker and it gets a row of its own at the top, and sorts
  first in `:` autocomplete.
- **Send to both platforms at once**, or either one — the same target chips the desktop app has.
- **System and event rows** render exactly as they do in the desktop app: a `SYSTEM`/`EVENT` tag,
  a chip naming the source, then the body, in a muted style that never reads like a viewer's
  message.
- **Messages wrap under the username**, like the platforms' own chats, rather than into a narrow
  column beside it.
- **Timestamps and username badges can each be turned off**, and the change applies to the
  messages already on screen, not just the next one in.
- **Readable at WCAG AA throughout.** Every piece of text in the overlay, the options page and
  the popup clears 4.5:1 against what is actually painted behind it, in both themes. Event rows
  and timestamps follow the *Text size* setting rather than sitting at a fixed 10px, and a name
  colour the platform hands over is nudged until it is readable while keeping its hue.
- **Moderation tools** in the username menu, for the channels you actually moderate.
- **Follows the site's own theme.** Twitch or Kick in dark mode gets a dark overlay, light mode
  gets a light one, and it switches the moment you change it on the site.
- **Several streams at once.** Each tab keeps its own sockets, channels and feed.

## Install

There is nothing to build and nothing to install first — Chrome loads the folder as it is.

**[⬇ Download the latest release](../../releases/latest)** — grab
`FriendlyChatExtension-v1.4.1.zip` from the Assets list, then follow the steps below.

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
| A control the site has is missing from the overlay | Open the overlay's settings, scroll to **Diagnostics**, and press *Copy diagnostics*. That is the report worth attaching to a bug — it lists what the overlay found and everything in the chat's footer that it did not. |

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
- **Send wears the site's colour** — Twitch purple on Twitch, Kick green on Kick — so the box
  reads as part of the chat you are in. Kick's green is bright enough that the label goes dark on
  it, and on a light page the green is darkened so white stays readable; every combination clears
  the WCAG AA contrast ratio. The rest of the overlay keeps its own accent.

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

## Bits, points and the cards above chat

Both platforms put things in the chat column that are not messages. Twitch stacks cards at the
top — hype train, poll, prediction, pinned message, the bits leaderboard — and puts your bits and
channel-points balances at the bottom. Kick does much the same. An overlay sized to cover the
chat column covers all of it.

**The cards stay visible.** The panel measures whatever the site has stacked above its message
list and starts below it, so the real card is on screen and still fully interactive — you can
click through a prediction or vote in a poll exactly as you would without the overlay. That
costs feed height, so it is a setting: *Leave room for the site's cards*, on by default.

However tall the card is, the panel keeps 260 pixels for itself — enough for its header, a few
lines of chat, the composer and the status bar. That is a floor on the panel rather than a share
of the column, because the two sites' cards are not remotely the same size: Kick's gifter
leaderboard opens to 310 px, which a percentage generous enough for Twitch would have clipped.

Note that on many Twitch channels there is a card there permanently — the bits leaderboard —
so the panel will usually start an inch or so down the column. Turn the setting off if you would
rather have the height.

**Kick has two card slots and both are handled.** Its gifter leaderboard sits above the messages
and pushes them down, the same shape as Twitch's stack. Its pinned message does not: it is drawn
as a banner *over* the top of the message list. Both end up revealed, but only the second needed
new work — see *Finding the cards above chat* below.

**The balances are lifted into the overlay.** A row above the composer shows what the site is
showing: channel points, bits or Kicks, and a *Claim bonus* button while there is a bonus
waiting. These are read straight off the page, so they are the balances of whichever account is
signed in there, and reading them needs no token, no scope and no API call.

Twitch labels its balances with test selectors that have outlived several redesigns. Kick labels
nothing in its chat footer — no test selectors, no `aria-label`, no `title`, and generated class
names — so its controls are found by what they are rather than by a name they do not carry: the
icon Kick tags itself with `data-ds-icon`, and failing that a footer button whose entire visible
text is a number, which in a chat footer is a balance and nothing else. The send button is
identified first and excluded from both searches, so the worst case is finding nothing rather
than clicking the wrong control.

**Redeeming opens the site's own menu.** Clicking a balance hands the click to Twitch's or
Kick's own button. The site's real rewards panel opens, over the site's own chat, with the
current costs, the paused rewards greyed out and the prompts that some rewards need — and the
overlay makes itself invisible and click-through for as long as it is up, then comes back when
you close it. Nothing here holds a token that could spend anything, and none of the redemption
rules are duplicated: the platform owns them.

Claiming a bonus is the one exception, because it is a single click with no menu behind it, so
the overlay just clicks it and tells you it did.

## Readability

Everything the extension draws is measured against WCAG AA — 4.5:1 for text, 3:1 for large text —
and the measurement is taken from what is *rendered*, not from reading the stylesheet. That
distinction turned out to matter twice over.

**Sizes follow the Text size setting.** Event and system rows, timestamps and the little tags on
them used to be pinned at 10px, 9.5px and 8.5px however large the messages were set. They are now
derived from that setting with a floor, so raising it raises all of them. The default is 14px,
which puts timestamps at 12, event rows at 13 and their tags at 10.5.

**Opacity is no longer used to dim text.** Several states were faded rather than recoloured — a
send target that is off, a filtered platform, a message a moderator deleted — and opacity
multiplies down the whole ancestor chain. A target chip at 0.4 inside a panel at 0.96 with a tag
at 0.75 came out at **1.55:1**. Those states are carried by colour and background now, which do
not compound, and a deleted message is struck through and muted rather than faded.

**The panel's own opacity is part of the sum.** It ships at 96%, which lifts every colour slightly
toward whatever is behind it and was quietly taking values that computed as 4.79 down to 4.49.
The palette is chosen with that margin built in. Turning the *Opacity* slider down further will
erode contrast — that is the point of the setting, and it is your call, but it is worth knowing
the default is the level the palette is designed around.

**Brand colours are split in two.** Twitch purple on its own tinted chip is 3.1:1: fine for a
border, not fine for a label. `--twitch` and `--kick` still draw dots, edges and the brand mark,
where the 3:1 non-text bar applies; anything carrying *words* uses a separate pair chosen to clear
4.5:1 on the tint it sits on, in each theme.

**Name colours are nudged, not replaced.** Twitch and Kick both let people pick their own colour
and plenty pick one that lands near 2:1 on a dark feed — pure blue is 2.26:1. The colour belongs
to the person who chose it, so only its lightness moves, and only until it is readable: the hue
and saturation are untouched, so a blue name stays blue. A colour that already reads well is
passed through byte for byte. Both a dark-theme and a light-theme value are emitted per name, so
switching theme under an already-rendered row still lands on a readable one.

## The message box

Emotes are drawn where they are typed. Finish a name, press space, and the name becomes the
picture — so a message with six emotes in it can be read before it is sent rather than after.

An `<input>` cannot hold an image, so the box is a contenteditable. Nothing else in the composer
had to learn that. The autocomplete, the emote picker, the reply bar and the send path all treat
it as an input, and they are right to: `value`, `selectionStart` and `setSelectionRange` are the
whole vocabulary they need, so those three are defined over the contenteditable and every one of
those call sites carries on unchanged.

What makes that work is that **an emote is worth exactly its own name**. An `<img>` counts as
`alt.length` characters both when reading the value and when counting to the caret, so `Kappa`
typed and `Kappa` shown as a picture occupy the same offsets. Code that slices the value around
the cursor has no idea anything changed, and the message that goes out is still plain text.

The trigger is the separator rather than the name, so typing through a longer name that starts
with a shorter one is never interrupted — `KappaPride` does not turn into `Kappa` halfway
through. Drawing only happens when a name is actually finished; typing itself never rewrites the
box, because replacing its contents on every keystroke would take the caret with it.

**Favourites** are stored by name rather than by url, because the same emote can arrive from a
different provider tomorrow. Starring one puts it in a row of its own at the top of the picker,
newest first, and sorts it ahead of the alphabet in `:` autocomplete — which is the point of
starring it, rather than scrolling past everything else sharing its first two letters.

## Where the emotes come from

Incoming Twitch messages never needed a lookup — an emote arrives as an id and a position in the
IRC tag, so it renders whether or not anyone has fetched a list. The picker is a different
question: it can only offer what it has been told about, and it was being told about nothing from
Twitch at all.

What an account may use comes from four places, and the difference between them matters:

| | what it knows | needs |
| --- | --- | --- |
| `chat/emotes/global` | what everyone has | nothing |
| `chat/emotes?broadcaster_id=` | the channel's own — sub, follower, bits tiers | nothing |
| `chat/emotes/user?user_id=` | **what this account may send**, everywhere | a connected account with `user:read:emotes` |
| `chat/emotes/set?emote_set_id=` | the sets Twitch names in USERSTATE | any connected account |

All four are asked and merged. The user endpoint is the authoritative answer and covers channels
you subscribe to that you are not currently watching; the emote-set ids cover the same ground from
the other direction and work with any token, which is how Chatterino does it. Each is allowed to
fail on its own, so a viewer with no account still gets globals and the channel's own.

They arrive at different times — the join, then the room id, then USERSTATE — so the load runs
more than once and each pass adds to what is there. The view merges emote stores rather than
replacing them, so nothing an earlier pass found is lost, and the label from the most specific
source is the one that survives.

Kick answers `/emotes/<channel>` with the channel's set, the global set and the emoji set. That
request is made from the background worker, which is not a browser tab — and Kick sits behind
Cloudflare, which sometimes minds. When it comes back empty and the tab is on Kick, the page is
asked to fetch the same list from its own origin instead, which Cloudflare has no reason to
refuse.

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
    compose.js       emote picker, : and @ autocomplete, favourites, the
                     username menu
    emote-input.js   the message box: draws emotes as they are typed, and
                     presents an input's interface over a contenteditable
    native.js        the site's own cards, balances and menus: measuring,
                     reading and driving them
    render.js        message tokenising and row building
    feed.js          the batched, bounded message feed
    sites.js         per-site selectors, the native composer and the
                     bits/points controls
    overlay.css
  options/ popup/
tests/
  run.js           offline test suite
  background.js    boots the real service worker with the platforms stubbed
  harness.html     the overlay against a mock channel page
  contrast.js      WCAG AA auditor, run from the harness or either page
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

Dragging or resizing the panel by hand switches placement off and is remembered per platform
across reloads, so there has to be a way back: a reset button appears in the title bar the moment
you move it, there is a *Reset* in the overlay's settings under *Overlay*, and double-clicking
the title bar does the same. All three put the panel back over the chat column at the size it
first opened at.

### Finding the cards above chat

Twitch has hashed the class names off every wrapper around its highlight stack — there is no
`community-highlight-stack` to match on any more — and Kick's are generated Tailwind. So the
cards are found by position instead.

The message list is the anchor, because it is the one element on either site that has kept a
name. The search climbs from it until it reaches the first level where a sibling sits *wholly*
above or *wholly* below it, which is the level where both sites place their cards and their
composer. Everything above that line is the card block; the overlay starts at its bottom edge.

Most things overlapping the list are skipped rather than counted, which is what keeps the
absolutely-positioned layers both sites park over their messages — Twitch's viewer card, the
jump-to-bottom pill — from being mistaken for cards.

The exception is Kick's pinned message, which is drawn as a banner over the top of the messages
rather than pushing them down. That is still a card the overlay must not cover, so a sibling
overlapping the list counts as one when three things hold: it hugs the top of the list, it covers
less than half of it, and it actually has something in it. The last of those matters more than it
sounds — Kick keeps that banner slot in the page permanently and empty, where its own padding
still measures about 12 px, and counting it would have cost a strip of feed on every channel for
nothing.

Hiding the site's own chat and revealing its cards would contradict each other, so the cards are
exempted rather than un-hidden: `visibility` is inherited, and setting it back to `visible` on a
card inside a hidden subtree shows that card and nothing else around it.

### Getting out of the way of the site's own menus

Twitch draws its rewards panel inside the chat column at `z-index: 2000`. The overlay sits at
`2147483000`, so a menu opened underneath it would be painted straight over.

So the panel watches for one. Any dialog, menu or balloon that overlaps the panel's box makes it
go `visibility: hidden` and `pointer-events: none` until that element goes away — the menu is
then both visible and usable, and clicking outside it closes it through the panel exactly as it
would without one. The check runs on the same 500 ms tick as placement, and a click anywhere on
the page brings the next few checks forward so a menu you just opened is noticed in under a tenth
of a second rather than half of one.

Two things stop that from ever stranding the panel invisible. Anything matching those selectors
that was already on screen when the overlay mounted is treated as the page's own furniture and
never triggers it, so one mismatched element cannot hide the overlay for good; and a "menu" that
nobody has closed in two minutes is written off as furniture too.

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

827 assertions, no network. It drives the real parsers with real payload shapes: IRC lines with
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

Run one suite with `node tests/run.js <name>` (
`irc`, `kick`, `render`, `settings`, `compose`, `favourites`, `reply`, `authpages`,
`sites`, `discovery`, `twitchEmotes`, `emotes`, `theme`, `native`, `auth`, `send`,
`resilience`, `errors`, `feed`, `navigation`, `moderation`, `channelswitch`, `endtoend`,
`reload`, `multitab`, `background`).

The **`native`** suite covers the part of the overlay that reads the page rather than a protocol:
splitting the message list's siblings into the cards above and the bar below against both sites'
real nesting, reading a balance out of text or an accessible name, driving the site's own buttons
without ever clicking one that is not on screen, hiding the site's chat while keeping its cards,
and the rules that stop a popup from stranding the panel invisible.

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
without signing in to anything.

The mock page also carries the furniture this version reads and drives. *+ hype train card* and
*+ pinned card* stack cards above the message list, so the panel can be watched shrinking out of
their way and coming back when they clear; *toggle claim bonus* puts a bonus chest in the mock
rewards row; and clicking a balance opens a mock menu at the same `z-index` Twitch uses, so the
panel can be watched standing aside for it. The mock column mirrors Twitch's real nesting,
including keeping the chat header *outside* the chat-room section — that detail is why the header
is not a sibling of the message list and so is never mistaken for a card.

**Contrast is checked from the harness too.** *check contrast* loads `tests/contrast.js` and
reports anything below WCAG AA to the console, measured from the rendered page rather than the
stylesheet so the panel's opacity and any inherited fading are composited in. It works on the
options page and the popup as well — load the script and call `__auditContrast([document])`.
Turn transitions off before measuring: a colour part-way through one reads as its start value,
and in a window that is not compositing it never finishes at all.

**There is a Kick column too**, and *site: twitch* / *site: kick* rebuild the overlay against the
other adapter the way a navigation would, taking the other column out of the layout so that
site's selectors stop matching. It mirrors Kick's real nesting, including the second zero-sized
copy of the chat carrying the same ids — placed first in the document, so the layout-aware
lookups are actually exercised. *kick: leaderboard* fills the slot that pushes the chat down and
*kick: pinned banner* the one that floats over it, which are the two different shapes Kick uses.
Both columns have a composer wired to the same controlled-editor mock, so the send path can be
driven on either site. Setting `window.autoSendResult` answers a send with a canned
per-platform result, which is how the partial-failure and expired-token paths get exercised. Setting `composerMode` in the console to `paste-only`, `beforeinput`, `plain`,
`readonly` or `no-submit` switches how the mock composer behaves, which covers each branch of
the send path.

## Bugs this testing found

- **The panel came straight back over the menu it had just opened.** Clicking a balance hides the
  panel and then asks the site to open its rewards menu, and the panel is meant to stay out of the
  way until that menu closes. It stayed hidden for about a second and then reappeared on top of
  it. The peek was ended by a hold expiring rather than by the menu going away, because the check
  that keeps a peek alive only ever tracked a menu already *found* — and a peek the overlay starts
  itself begins before the site has drawn anything to find. Nothing went looking afterwards. It
  does now.

  That fix alone did not cover Kick, which turned out to draw menus in two different shapes.
  Its emote picker is a Radix dialog portalled to the end of `<body>` — a full-screen backdrop
  plus a panel centred on the window, so only the backdrop covers the overlay. Its rewards and
  gift-shop panels are anchored *inside the chat column* instead, and are not portalled at all.
  Neither shape carries a role. Watching for an element being *added* did not work either,
  because Radix leaves a closed panel mounted and reuses it: nothing is added the second time.

  So the question asked is whether a menu has just **opened**, not whether one has just been
  added. Candidates are anything carrying a dialog role, anything carrying `data-state="open"` —
  which is how Radix announces itself, and finds a panel wherever it is drawn — and any
  positioned child of `<body>`. Whatever is already on screen when the overlay looks is the
  page's own furniture; anything going from closed to open that covers the panel is the menu.

  Two details earned their place the hard way. "Open" cannot be judged from a rectangle alone:
  Kick keeps body children sized 300x150 and 1280x1 permanently `visibility: hidden`, and
  counting those as open made them furniture on the first look, so the panel that mattered could
  never be seen opening later. And nothing inside the message list is ever a menu, because a
  busy channel adds rows constantly and a tall one covers plenty of the panel.

  Recognising the panel is not the whole answer, though, and three attempts at it in a row is
  enough to say so. While the overlay is standing aside there is a better question available:
  is anything painted over the chat right now? That is asked by sampling what is actually on top
  at four points inside the message list — off-centre, because both sites float a jump-to-bottom
  pill down the middle. If what comes back is the messages, or something the messages sit inside,
  nothing is covering them. It needs no knowledge of the site's markup at all, which is the
  point: it was checked against a live Kick channel, where it reports nothing while the chat is
  idle and reports a cover the moment a panel opens over it.

- **The feed could freeze permanently, and silently.** Rows are batched and flushed on the next
  animation frame. Frames stop arriving whenever the page is not being drawn — a background tab,
  but also a window merely covered by another one, which leaves `document.hidden` false — and the
  code chose between a frame and a timer at the moment of scheduling. That was not enough: the
  page can stop being drawn *after* the frame is asked for. The frame never arrived, the
  "already scheduled" flag stayed set, and every message after it returned early without asking
  again. Chat stopped drawing for the rest of the session while the message counter carried on
  climbing, so the overlay looked alive and was not. Both a frame and a timer are now started and
  whichever arrives first does the work, cancelling the other. Found by running the overlay in a
  window that never composites, which is the same condition as a covered one.

- **Kick renders its whole chat twice and the wrong copy could be hidden.** Kick ships a second,
  zero-sized copy of the chat inside a `display: none` streaming placeholder, carrying the same
  `id`s — `#channel-chatroom`, `#chatroom-messages`, `#chatroom-footer` all match twice. Anything
  resolving them with a plain `querySelector` gets whichever comes first in the document, which
  is not something to depend on across a hydration. *Hide the site's own chat* could therefore
  hide the invisible copy and leave the real one showing. Those lookups now skip anything the
  page is not laying out.

- **Kick's send button was never found.** It carries no test selector, no `aria-label` and no
  `title` — only `id="send-message-button"`. The send path fell through to pressing Enter, which
  works, but is a guess about a key binding rather than the button the site actually wired up.

- **A navigation that overtook a mount left no overlay at all.** Mounting is asynchronous — it
  reads settings and geometry out of `chrome.storage` — and a second channel change lands inside
  that window readily enough on a fast connection. When the overtaken call resumed, it checked
  that it had been superseded and correctly tore an overlay down, but it tore down whichever one
  the module variable currently held: by then, the *newer* navigation's. The page was left with
  no panel until the next navigation. `mountFor` now returns the overlay it built and the caller
  tears down that one by identity. Separately, `mount()` itself carried on after a `destroy()`
  landed mid-flight, appending a host nobody owned and starting a poll and page listeners that
  nothing was left holding a reference to remove; it now bails at each await point. The
  `navigation` suite reproduces both by holding each mount open until the test releases it —
  with the old code, zero overlays survive.

- **A card that appeared while the site's chat was hidden stayed hidden with it.** The exemption
  that keeps hype trains and polls visible was applied when a *setting* changed, but both sites
  replace those nodes outright when a card starts, and a fresh node inside a hidden subtree
  inherits the hiding. So turning on *hide the site's own chat* and then waiting for a hype train
  got a gap where the card should be. The card search now runs on the tick and re-applies the
  exemption whenever the set of cards changes, not just when a setting does.

- **Switching channels churned between connect and disconnect.** Two races, either of which
  alone was enough. A socket's `close()` is asynchronous, so the one being replaced reported its
  close *after* the replacement had already reset the shared "closing on purpose" flag — the drop
  then read as unexpected and queued a reconnect to the channel just left, which closed the new
  socket, whose close did the same in reverse. Separately, `joinChannel` awaits two storage reads
  between leaving one channel and opening the next, so clicking through quickly let a stale join
  finish last and connect to the wrong channel. Sockets now carry a generation and joins a
  sequence number; anything superseded stands down. Reverting either fix makes the `endtoend`
  suite fail on socket count and on a reported drop.

- **Reloading a channel page came back to an empty overlay.** A reload is a new page on the same
  channel, and the worker's sockets are not part of the page: they carry on. Nothing re-joined,
  and history, badges and emotes only ever ran on a join — so the fresh tab reattached to a live
  chat with nothing above the first message that happened to arrive next, and an empty emote
  picker. The worker now re-sends everything a new page needs whenever a tab says hello about a
  channel it is already connected to, without touching the socket. Repeating it is safe by
  construction: the feed drops messages it has already seen, emote stores merge rather than
  replace, and badges are a straight swap. Kick needed one more thing — replaying its history
  takes the chatroom id, which is only learnt when the socket subscribes, so that id is now kept
  on the connection instead of being passed straight through. The `reload` suite is the whole
  sequence against the real worker: join, confirm, reload, and assert the second page is told
  everything the first one was, on one unbroken socket.

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
- **Kick's two chat-footer controls are easy to confuse with their neighbours.** Channel points
  are `data-testid="channel-points-button"`, carrying the balance as the button's own text. Kicks
  are a `kicks-balance` element *inside* a button — the little "K 0" — and pressing that button
  opens the gift shop. Sitting beside it is `data-testid="get-kicks"`, which looks like the same
  thing and is not: it opens a page for buying Kicks. The balance button is preferred and the
  purchase link is a last resort, which is the difference between opening the shop and opening
  the till. `kick.nativeControls()` in `src/content/sites.js` is the one function to update if
  Kick moves them, and *Copy diagnostics* under **Diagnostics** in the overlay's settings
  produces exactly what is needed to update it.
- **The Opacity setting can take contrast below AA.** The palette is built to clear 4.5:1 at the
  default 96%. Below roughly 90% the panel starts blending enough of the page underneath to erode
  that, and how far depends on what is behind it. Nothing is stopping you — it is a deliberate
  setting — but AA is only guaranteed at the default.
- **A name colour is nudged, never guaranteed.** The clamp targets the feed background of each
  theme. A name sitting on the highlight tint of a mention row, rather than the plain feed, can
  land slightly under.
- **The card strip costs feed height.** Twitch keeps a bits leaderboard above chat on many
  channels, so *Leave room for the site's cards* usually gives up an inch of column even when
  there is no hype train running. Turning it off puts the panel back over the whole column.
- **Twitch emotes from other channels need a connected account.** Global emotes and the current
  channel's own load for anyone. The list of what *your* account may send — every channel you
  subscribe to, follower emotes, bits tiers, hype train rewards — comes from an endpoint that
  needs `user:read:emotes`, which is requested at sign-in. A token created before that scope was
  asked for still works for everything else; the overlay says so and reconnecting fixes it.
- **Kick emotes on a Twitch tab depend on the background request working.** The page-side fallback
  only applies when the tab is actually on Kick, because a content script cannot make a
  cross-origin request the way the worker can. Watching Twitch with Kick chat merged, Kick's emote
  list is whatever the worker managed to fetch.
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

Two costs went the wrong way when the overlay learned to read the page, and were measured on
twitch.tv rather than the harness — the harness page has 79 nodes and a real channel has upwards
of 1,500, which is the difference between a `querySelectorAll` that costs nothing and one that
does not:

- **Finding the site's cards ran on every scroll event.** Placement is bound to `scroll` with
  capture, and on a busy channel the site's own message list scrolls on every message that
  arrives. Adding the structural card search to it took that path from 55 µs to 109 µs, each one
  forcing layout. The search now runs on the 500 ms tick and keeps the elements it found;
  everything in between re-measures those, which put the scroll path back to **64 µs**.
- **Looking for the site's menus was a document-wide query every tick.** At 169 µs it cost more
  than everything else on the tick combined, to answer "no" almost every time. A menu can only
  appear because the viewer did something, so the scan is now armed by clicks and keystrokes,
  with a five-second backstop; while one *is* open the check is against that element alone. Idle
  cost went from 169 µs every tick to **2 µs**, measured as one scan per five seconds instead of
  ten.

The same two paths were then measured on kick.com, which is the larger page of the two — about
2,980 nodes against Twitch's 1,554:

| | Twitch | Kick |
| --- | --- | --- |
| scroll → placement | 64 µs | **6 µs** |
| card search (on the 500 ms tick) | 78 µs | 28 µs |
| balance read (on the tick) | 43 µs | 29 µs |
| menu scan, when armed | 169 µs | **339 µs** |

Kick's chat is addressed by `id`, which is why its hot path is an order of magnitude cheaper than
Twitch's attribute selectors. Its menu scan is twice as expensive, being a bigger document —
which is the argument for arming that scan by input rather than running it every tick, twice over.

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
