# Friendly Chat Extension

A Chrome extension that puts [Friendly Chat](https://github.com/JRBlaze/FriendlyChat)'s merged
chat feed directly on the page you are already watching.

Open a Twitch channel and the merged chat overlay appears over Twitch's own chat. If that
streamer is also live on Kick, the overlay says so and offers to add the Kick chat to the same
feed. Open a Kick channel and it works the other way round.

![Platform](https://img.shields.io/badge/Chrome-MV3-blue)
[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FJRBlaze%2FFriendlyChatExtension%2Fmain%2Fmanifest.json&query=%24.version&label=version&color=green)](../../releases/latest)

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
- **Pop it out into a window of its own.** The panel moves into a picture-in-picture window that
  floats above everything, including full-screen video and other applications, and comes back to
  the page when you close it. It is *moved*, not copied: the same panel, the same connections,
  the same composer still typing into the page's own chat box when that is how a message has to
  go. Which means Cheers and anything else that needs the site's own controls keep working while
  it is out there. See [Popping the panel out](#popping-the-panel-out).
- **Where a message goes is remembered per channel.** Pick *Kick only* on one stream and it stays
  Kick only on that stream, next time too — without changing anything on the other streams you
  have open in other tabs. See [Which chats a message goes to](#which-chats-a-message-goes-to).
- **Opens the stream when Kick shows the profile.** Kick gives a streamer their own channel page —
  Home, About, Videos, Clips, Schedule — even while they are live, so the one person whose address
  does not open their own stream is the person sending it. The overlay presses Kick's own
  *Watch now* for them, once, on arrival. See
  [The profile the streamer never asked for](#the-profile-the-streamer-never-asked-for).
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
- **Events**: subs, resubs, gifted subs, raids, cheers, hype trains, redemptions, timeouts and
  bans, shown as muted rows so they never look like something a viewer typed. The half of an
  event the viewer actually typed — the message under a resub, the text of an announcement — is
  drawn with its emotes; the summary around it is not, so a display name that happens to spell an
  emote name stays a name.
- **Channel point redemptions**, including the ones that never reach a chat socket. A reward that
  asks for a message arrives over IRC and always has; a reward that asks for nothing is drawn by
  Twitch's own page from a private live-update channel and is sent to nobody. Those are read back
  off the page the site has already painted — Twitch only, only while the panel is showing the
  same channel the page is, and only for lines that actually say a redemption happened. See
  [Reading redemptions off the page](#reading-redemptions-off-the-page).
- **`/me` renders as an action**, not as `\x01ACTION waves\x01`. The wrapper comes off before
  anything else looks at the message, because the emote positions Twitch sends are counted from
  the text inside it.
- **Replies say what they are answering.** Both platforms send the original message alongside the
  reply, so the row carries a quoted line naming who was answered and what they said — which is
  the point, because the original has usually scrolled away by the time the answer arrives.
  Replying from the username menu threads the reply properly on Twitch rather than only
  @mentioning them.
- **First messages are marked**, on Twitch's own say-so. Twitch flags the first message a person
  has ever sent in a channel and that flag is the only thing this uses — never a guess from what
  the panel happens to have seen since it opened. The replayed history is left unmarked: the
  highlight is a prompt to do something about somebody who has just turned up, and acting on it an
  hour late is meaningless.
- **@mentions wear the mentioned person's colour**, once this feed has seen them speak. Somebody
  nobody here has heard from falls back to the platform's own tint rather than a colour invented
  for them.
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
  colour the platform hands over is nudged until it is readable while keeping its hue. Connection
  state is carried by shape and words as well as colour, and every animation stops when the system
  asks for reduced motion.
- **Link two channels by hand when the names differ.** `twitch.tv/chefsteve330` and
  `kick.com/chefsteve` are one person; type the name (or paste the address) once and the pair is
  remembered both ways, so arriving from either side merges the right chat.
- **Moderation tools** in the username menu, for the channels you actually moderate — with the
  last few messages that person sent shown above the buttons, so a timeout is a judgement about
  something you can still read.
- **Tells you when there is a new release.** The releases page is checked in the background and
  the toolbar icon gets a dot when there is something newer; the popup turns that into the file
  and the page to drop it on. Nothing installs itself — no extension outside the Web Store can —
  but the steps that are left are two clicks rather than a trip to GitHub you had to think of.
- **Follows the site's own theme.** Twitch or Kick in dark mode gets a dark overlay, light mode
  gets a light one, and it switches the moment you change it on the site.
- **Several streams at once.** Each tab keeps its own sockets, channels and feed.

## Install

There is nothing to build and nothing to install first — Chrome loads the folder as it is.

**[⬇ Download the latest release](../../releases/latest)** — grab
`FriendlyChatExtension-v1.12.0.zip` from the Assets list, then follow the steps below.

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
| Your own Kick channel opens on Home/About/Videos instead of your stream | That is Kick's own layout for a channel's owner. The overlay presses its *Watch now* for you on arrival; if you would rather it did not, turn off *Open the stream when Kick shows the channel's profile* in settings. |
| The pop-out button does nothing | Picture-in-picture windows need Chrome 116 or newer, and Chrome refuses a second one while the first is open. Close the existing pop-out and try again. |
| Nothing at all after a Chrome restart | Developer-mode extensions stay installed, but Chrome may prompt you to keep them. Re-enable it on `chrome://extensions`. |

### Updating or removing it

Chrome only updates extensions it installed itself, and it did not install this one. So the
extension watches for you: it asks GitHub for the latest release every six hours, and when there
is one newer than the version running, the toolbar icon gets a dot. Open the popup and it names
the version, offers the zip and offers `chrome://extensions` to drop it on. Dismissing it hides
that one version, not every future one. *Check for updates* in the popup's footer asks now.

Nothing here can install the update. An extension cannot replace itself, and no permission
changes that — what this removes is having to remember to go and look.

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
   This never expires and is never overwritten by a guess. See
   [Linking two channels yourself](#linking-two-channels-yourself).
2. **A cached result** from a previous visit (six hours).
3. **A link on the channel page itself.** The streamer's own about panel and social links are
   scanned for a URL pointing at the other platform. This is the strongest automatic signal,
   because the streamer put it there.
4. **The same name** on the other platform.

Misses are cached too, so a channel with no counterpart is not re-probed on every page view.
Everything found this way is listed in the extension's options page, where you can correct or
remove individual entries.

### Linking two channels yourself

The guesses run out when a streamer uses different names on the two platforms and links neither
page to the other. `twitch.tv/chefsteve330` and `kick.com/chefsteve` are one person; nothing on
either page says so, and the same-name guess from the Kick side lands on `twitch.tv/chefsteve`,
who is somebody else entirely.

So you can say it yourself. Open the overlay's settings, find **&lt;other platform&gt; channel for
this streamer** under *Cross-platform*, type the name and press *Save link*. If nothing matched at
all, clicking the greyed-out chip for the other platform takes you straight there with the field
focused.

- **Paste whatever you have.** A name, an `@name`, or the address of the channel —
  `https://kick.com/chefsteve`, `kick.com/chefsteve`, even a link to one of their videos. The
  channel name is taken out of it.
- **Say it once, from either side.** The pair is recorded both ways, so having linked
  chefsteve330 to chefsteve on Twitch, arriving at `kick.com/chefsteve` later already knows to
  merge chefsteve330 — and no longer guesses at the wrong `twitch.tv/chefsteve`.
- **It sticks.** Manual mappings never expire, are never overwritten by a guess, and survive
  *Clear* in the options page, which only drops the automatic ones.
- **Correct it or undo it.** Saving a different name moves both halves; the channel it used to
  point at stops pointing back. *Reset* forgets the pair and goes back to guessing.
- **Or say there is nobody.** Save an empty box to record that this channel has no counterpart,
  and the lookup stops running for it. That says nothing about any other channel, so nothing is
  written the other way.

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

**Nothing is said in colour alone.** Whether a chat is connecting, connected, disconnected or not
connected at all was a coloured dot and nothing else — amber, green, red or grey — which is no
information at all to a viewer who cannot separate those. Each state now has its own *shape* as
well: a filled disc when connected, a hollow ring while connecting, a square when it has dropped,
and a dim ring when there is nothing there. The chip's tooltip and its accessible name say the
same thing in words, so it reads correctly out loud too.

**Motion is optional.** The pulsing dots run for as long as the panel is open, and new messages
fade in. Every one of those is decoration on top of something already said in text or shape, so
`prefers-reduced-motion: reduce` stops all of it rather than trying to be clever about which parts
are safe.

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
  worker and never reaches the browser. Kick needs no setup.

Tokens live in `chrome.storage.local`, never in `storage.sync`, so they are not replicated across
your browsers. Kick tokens refresh silently; a Twitch implicit token cannot be refreshed, so when
it expires the overlay says so and asks you to reconnect.

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
    profile.js         who a chatter is: join date, follow date, sub length
    emote-cache.js     last visit's emote lists, so a channel you have been
                       in before has them on arrival
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

### Reading redemptions off the page

Almost everything in the feed arrives over a socket. Channel point redemptions are the exception,
and only some of them.

A reward that asks the viewer for a message is delivered over IRC as an ordinary `PRIVMSG` with a
`custom-reward-id` tag. Those have always been in the feed. A reward that asks for nothing — most
of them — is not sent over IRC at all: Twitch's own web client draws that line from a private
live-update channel, and the public API for redemptions only answers to the broadcaster's own
token, so there is nothing to subscribe to for a channel you are merely watching. The only copy of
that event in the tab is the one the site has already painted.

So `src/content/native-events.js` reads it back, and is written to fail closed at every step:

- Twitch only, and only while the panel is showing the very channel the page is. Reading one
  channel's page into a feed joined to another would be worse than the row being missing.
- Only lines the site marks as a notice, and only those carrying no chat message of their own —
  a reward with a message is already in the feed from IRC, and twice is not an improvement.
- Only lines that say a redemption happened. Subs, resubs, raids and watch streaks are drawn as
  notices too, and every one of them arrives as a `USERNOTICE` with the platform's own structured
  fields, which is a better source than words read off a screen.

The last of those is why nothing there tries to be clever about wording. If the site is not in
English, or Twitch rewrites the line, this finds nothing and the feed is exactly as complete as it
was before. It can go quiet; it cannot start inventing rows.

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

### Popping the panel out

The pop-out button in the title bar moves the panel into a
[document picture-in-picture](https://developer.chrome.com/docs/web-platform/document-picture-in-picture)
window, and moves it back when that window closes.

*Moves*, not copies, and everything else follows from that. The content script never leaves the
tab, so the port to the background worker, the feed, the emote picker and the bridge that reads
this page's balances and types into this page's chat box all carry on exactly as they were. What
crosses into the other window is one element — the overlay's host — with its shadow root and its
stylesheet hanging off it. There is no second copy to keep in step, no second connection, and no
message that has to be forwarded anywhere.

That is also why it is a picture-in-picture document rather than a `window.open`. A real second
window would be a second page with no access to this one's chat box, and sending a Cheer — which
has to go through the site's own composer, because Twitch's API takes the text and none of the
Bits — would have had to stop working the moment the panel left the tab.

While it is out there the panel is no longer over a page, so the parts that exist only because it
was stop: placement no longer tracks the chat column, and it no longer stands aside for the site's
menus. What does keep running is everything about the page itself, because the page is still where
the channel is: its balances are still read, its own chat is still hidden if that is the setting,
and the redemptions it draws still reach the feed.

Closing the window puts the panel back. So does hiding the overlay, and so does moving to another
channel — otherwise a channel switch would leave an empty window behind with nothing in it.

### Which chats a message goes to

The *Send to* chips are remembered per channel, in `storage.local`, under their own key.

Both halves of that are deliberate. Settings live in one blob that is broadcast to every open tab
the moment any part of it changes, and every overlay re-reads the whole thing when it arrives —
which is exactly how picking *Kick only* on one stream re-picked it on every other stream already
open. And a choice about one channel is a choice about that channel, not a preference to
replicate to a person's other devices.

So an overlay reads its channel's entry once, on mount, and after that only its own chips change
it. A channel that has never been given one starts from the default, and a broadcast started by
another tab is allowed to change anything except this. The map is capped at 200 channels, oldest
dropped first.

### The profile the streamer never asked for

Kick draws a channel two ways. A visitor arriving at a live one gets the player and the chat; the
profile — Home, About, Videos, Clips, Schedule — is what an offline channel gets. The streamer is
the exception: Kick hands them their own profile whether or not they are live, so the one person
who cannot watch the stream by typing its address is the person sending it.

Kick's own way across is a *Watch now* button in the card floating over the collapsed player, and
pressing it swaps the profile for the player without touching the address. So there is nothing to
navigate and nothing to reload — the overlay finds Kick's button and presses it, once, on arrival.

Three things have to hold, and each one is a reason not to press:

- **The address is the channel itself.** `/name/about`, `/name/videos` and `/name/clips` are pages
  someone asked for by name, and taking them to the player instead would be taking away what they
  chose.
- **The profile is what is on screen.** The button stays in the page after the swap, sized and
  all, so it cannot report its own success. The tab strip going is what says it worked.
- **The button is there at all.** Kick only draws it while the channel is live, which makes its
  presence the liveness test as well as the control. Nothing has to ask an API whether to bother,
  and an offline profile is left exactly as it is.

Finding it is a matter of telling it from the video's own play control, which carries the same
`data-ds-icon="Play"`. What separates them is a label: the button in the card says what it does,
and the one in the player is an icon and nothing else. Matching on the icon rather than on the
words is what keeps this working in a language other than English; the words are still preferred
where they are there.

It is pressed once per arrival and then not again. Someone who goes back to their profile of their
own accord is left there, and a press that changes nothing — because Kick rewired the button —
stops too, because a page that fights whoever is using it is worse than one that gave up.

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

898 assertions, no network. It drives the real parsers with real payload shapes: IRC lines with
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
`states`, `resilience`, `errors`, `feed`, `navigation`, `moderation`, `channelswitch`,
`endtoend`, `reload`, `linking`, `multitab`, `background`).

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

- **The account menu and the notifications popover were painted straight over.** Every test for
  "is one of the site's menus open" asks what an element *measures*, which is what makes it
  survive both sites renaming their markup. Twitch's top-right menus defeated all of them at once
  by having nothing to measure. The menu is drawn through four nested elements:

  ```
  body
   +- div.tw-dialog-layer          1440x0, position: relative, parked below the fold
      +- div.ReactModal__Overlay      1x1, position: fixed
         +- div[role="dialog"]        1x0, position: static
            +- div[data-popper-...] 207x193   <- the only part anyone can see
  ```

  The one element carrying a role measures 1x0. The one that is a child of `<body>` measures
  1440x0 and sits at y=900. The panel with a box is three levels down, carries no role, no id and
  no test hook, and is a child of nothing that was being looked at. So the search found the
  wrappers, measured nothing, and concluded no menu was open — while the menu sat there under the
  overlay.

  Twitch positions those panels with Popper, which stamps `data-popper-placement` onto the
  floating element as it places it. That is a mark on the thing actually being painted, which
  makes it the same kind of hook `data-state="open"` already is for Kick's Radix menus, and it is
  why both are now asked for by name. The account menu, the notifications popover and the chat
  settings menu are the same wrappers around a different panel, so one hook covers all three.

  A hook can be renamed, though, so it is backed by shape as well: a named panel that measures
  nothing is descended into, breadth-first and four levels at most, for the box it is drawing —
  stopping if the tree fans out, because a menu is drawn through wrappers with one child each and
  anything wider is the page. That is the same answer the cards above chat already needed, for the
  same reason: a wrapper collapsing to no size does not mean nothing is on screen, it means the box
  is further in.

  The existing floors do the rest of the work unchanged. Twitch positions its *tooltips* with the
  same attribute, and hiding the whole overlay for a tooltip would be worse than letting the
  tooltip be covered — so the 80x80 minimum and the 40px overlap test are what keep this to menus.

- **A long channel name painted over the title bar's buttons.** The chips carrying the channel's
  name sit between the *MERGED* mark and the row of buttons on the right. They set their own width
  from their own text and were told never to wrap it, and nothing told them they could give way —
  so a thirty-character name, which is as long as either platform allows, drew a chip 267px wide
  into a strip with 131px for it and straight over full screen, refresh, settings, minimize and
  close. Measured against the real panel, the chip's right edge landed 128px past where the first
  button starts.

  A flex item will not shrink below its own content unless it is told it may, which is the whole
  fix: the chips may shrink, the name inside them ellipsises, the row no longer wraps to a second
  line, and anything that still does not fit is clipped rather than painted outside. The status
  dot and the disconnect cross are held at their own size, so a squeezed chip still says what it
  is doing and can still be clicked to leave.

- **Picking where messages go on one stream changed it on all the others.** The *Send to* chips
  wrote to the settings blob. Every setting is broadcast to every open tab the moment any part of
  it changes, and every overlay re-applies the whole thing when it lands — so choosing *Kick only*
  on one stream reached every other stream open at the time, and there was nowhere for a choice
  about one channel to live anyway. It is now kept per channel, in `storage.local`, under its own
  key, and read once on mount. See [Which chats a message goes to](#which-chats-a-message-goes-to).

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

- **A message deleted the instant it arrived stayed on screen for good.** Rows are batched and
  attached on the next animation frame, and every operation that changed the feed — a deletion, a
  ban, a platform filter, leaving a chat — looked only at what was already attached. Twitch sends
  a message and the CLEARMSG that deletes it down the same socket, often in the same read, so the
  delete landed while the message was still in the queue, found nothing, and the message flushed a
  moment later looking perfectly ordinary. The overlay then showed a message the platform had
  removed, permanently. Everything that changes rows now sees the queued ones too, and leaving a
  chat drops its queued messages rather than drawing them after the leave. The `feed` suite holds
  each case open across the flush.

- **Renaming the markup quietly switched off "hide the site's own chat".** The overlay finds the
  chat column by climbing from the message list, so a site redrawing itself leaves the panel
  correctly placed — but the block to hide was looked up by name alone, and when the name went it
  returned nothing and the setting simply stopped working, with nothing to say so. It now falls
  back to the same climb: the block one short of the column. Cards are still forced visible
  through it, so a hype train stays on screen either way. The `sites` suite runs both platforms
  with every hook but one renamed.

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
  the extension's redirect URL is registered with them. The overlay's *Settings -> Accounts*
  panel shows the URL to register and whatever the platform actually said, and keeps it there
  until the account connects. Nothing in the extension can do that part for you.
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
  Kick moves them.
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
