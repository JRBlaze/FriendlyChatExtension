# Chrome Web Store listing and privacy answers — Friendly Chat 1.23.0

Prepared from the released Chrome Web Store package, not the broader unpacked Chrome manifest. These are copy-ready entries for the Developer Dashboard. This document does not submit or certify the listing for you. The extension code and released packages are unchanged.

## Package to upload

Use `FriendlyChatExtension-v1.23.0-chrome-web-store.zip` from the release workflow's `chrome-web-store-zip` artifact. Do not upload the outer artifact wrapper or the ordinary GitHub Chrome ZIP. The verified local copy is at `dist/youtube-1.23.0/published-store/FriendlyChatExtension-v1.23.0-chrome-web-store.zip`.

## Store listing

**Name:** Friendly Chat Extension

**Short description:**

```text
Merge Twitch, Kick, and optional YouTube live chat, with emotes, linked channels, and multi-platform messaging.
```

This 111-character summary comes from the package manifest. Use the existing product name. Recommended category: Social & Communication, if offered in the dashboard. Language: English. Keep your existing verified support/contact email; no email address is invented here.

**Detailed description — paste the following:**

```text
Twitch, Kick, and YouTube chat together while you watch.

Friendly Chat Extension brings the conversation into one merged feed on Twitch and Kick stream pages. Follow chat across platforms, choose where your messages go, and keep watching without switching between chat windows.

NEW: OPTIONAL YOUTUBE CHAT
• Add a YouTube live-video URL or channel URL.
• See live YouTube suggestions and choose the channel you want to add.
• Save a YouTube channel link to a Twitch or Kick channel so its live chat can load on future visits.
• Send to YouTube when its signed-in native chat box is available. YouTube sending starts off; check the displayed account and select its red send target for the current visit.
• Allow YouTube access through the setup page, toolbar popup, or settings. You can keep using Twitch and Kick without enabling it.

ONE CHAT, YOUR CHOICES
• Read Twitch, Kick, and attached YouTube messages in one scrolling feed.
• Choose your sending destinations. Twitch/Kick cross-platform sending uses connected accounts; YouTube uses your available browser session.
• Press Up/Down in the message box to recall recently sent messages, edit them, and send again.
• Use Twitch/Kick emotes, supported 7TV, BetterTTV and FrankerFaceZ emotes, emote favorites, and autocomplete.
• Adjust the theme, text size, spacing, and overlay position. Pop chat into its own window when you prefer.
• Save channel pairings and back up portable settings.
• Use supported Twitch/Kick reply and moderation controls when your account has the required permissions.

MADE TO FIT THE STREAM PAGE
Friendly Chat appears on supported Twitch and Kick channel pages, including Kick's live-chat dashboard at /stream. Other Kick dashboard, Drops, and inventory pages stay clear. Recognized native notifications and chat menus remain visible and usable.

GET STARTED
Open a Twitch or Kick channel after installing. Add the other chat or connect accounts through Friendly Chat. For YouTube, allow optional site access and add a live-video or channel URL. No YouTube Data API key or server you operate is needed.

PLEASE NOTE
The overlay appears on Twitch and Kick, not on YouTube watch pages. YouTube reading and sending depend on its embedded live chat and your browser's session/cookie settings. Being signed into a normal YouTube tab does not always make sending available. YouTube messages are plain text, up to 200 characters, and normal channel restrictions still apply. YouTube reply/moderation tools, rich stickers, and full badge rendering are not supported. Features vary by platform.

PRIVACY
Friendly Chat has no advertising or analytics of its own and does not sell your information. It handles chat content, account details, and the supported channel you are viewing to provide its features. Connected Twitch/Kick tokens stay in local extension storage; YouTube uses its native browser session. Platform, emote, history, and sign-in services receive the requests needed to operate those features. Embedded YouTube pages load YouTube's own resources under its policies. See the privacy policy for details.

Independent project; not affiliated with or endorsed by Twitch, Kick, or YouTube.
```

**Website/homepage:** https://github.com/JRBlaze/FriendlyChatExtension

**Support URL:** https://github.com/JRBlaze/FriendlyChatExtension/issues

**Privacy policy URL:** https://github.com/JRBlaze/FriendlyChatExtension/blob/main/PRIVACY.md

**What's new / reviewer release summary:**

```text
Version 1.23.0 adds optional YouTube live-chat reading, channel/video URL discovery, saved YouTube links, install/update access setup, and explicitly selected native YouTube sending. It also adds recent-message recall with Up/Down, fixes duplicate YouTube rows and Firefox editing, preserves native Twitch/Kick notifications, excludes non-chat Kick pages, and correctly enlarges Twitch Gigantify emotes.
```

## Privacy practices: single purpose

```text
Merge live-stream chat from Twitch, Kick, and optionally YouTube into one overlay on Twitch and Kick channel pages, with reading, selected sending, and related chat controls.
```

## Permission justifications

Paste each entry into its matching field. These are the five permissions actually present in the Chrome Web Store ZIP.

### storage

```text
Stores chat preferences, emote favorites, channel links, overlay geometry and per-channel Twitch/Kick send choices. General preferences use sync storage with a local fallback. Connected Twitch/Kick authentication tokens and saved YouTube links stay in local storage. Tokens are excluded from settings exports. YouTube send selection and recent sent-message recall remain in memory for the current visit.
```

### alarms

```text
Schedules the background heartbeat needed to maintain active chat sessions and periodic validation of a connected Twitch account. These alarms support chat connectivity and account validity. The Chrome Web Store build uses Chrome-managed extension updates, not GitHub update polling.
```

### identity

```text
Uses the browser-managed OAuth sign-in flow and redirect URL to connect Twitch and Kick accounts for the user's selected chat features. The extension receives platform tokens rather than asking for account passwords. YouTube does not use this OAuth connection; its optional sending uses its native browser session.
```

### cookies

```text
Reads Kick's session_token cookie when available to ask Kick about the signed-in user's channel standing and support permitted native-account/moderation features. It is sent only to Kick and is not persisted or included in backups. This permission is not used to read YouTube cookies or collect cookies from unrelated sites.
```

### scripting

```text
After the user grants optional YouTube site access, registers the packaged reader and sender content scripts for YouTube live-chat frames. The scripts act only in Friendly Chat's marked frames and bridge the displayed chat plus explicitly selected sends to the overlay. All injected extension JavaScript is bundled in the submitted package; no remote script is downloaded and executed as extension code.
```

### Host permissions — combined field

```text
Twitch/Kick site access places the overlay on supported channel pages, reads native chat/rewards controls and supports selected native actions. Twitch/Kick API and sign-in hosts provide chat, channel metadata, emotes, account validation and authorized sending/moderation. The specific Cloudflare helper completes OAuth configuration and Kick token exchange. localhost:8080 supports the existing optional Kick loopback OAuth redirect. 7TV, BetterTTV, FrankerFaceZ and Robotty supply emotes/recent Twitch chat. Optional www.youtube.com access enables public live-channel lookups and attached native live-chat reading/sending after permission is granted. Access is used for chat features, not general browsing surveillance.
```

If the dashboard asks about hosts individually, use this mapping:

| Host in store package | Reason |
| --- | --- |
| `*://*.twitch.tv/*` | Overlay on supported Twitch pages; native chat, rewards, chat identity and other user-selected chat controls. |
| `*://*.kick.com/*` | Overlay on supported Kick pages, channel/chat resources, Kick session standing and supported native chat controls. Non-chat pages are excluded by the adapter. |
| `https://gql.twitch.tv/*` | Twitch public channel/live metadata, badges and related chat information. |
| `https://api.twitch.tv/*` | Account-scoped chat, emotes, validation-related features and authorized moderation/sending. |
| `https://id.twitch.tv/*` | Twitch OAuth and token validation. |
| `https://api.kick.com/*` | Kick account, chat and authorized sending/moderation APIs. |
| `http://localhost:8080/*` | Existing optional Kick OAuth loopback redirect (`/friendly-chat.html`); not a general local-network scanner. |
| `https://friendly-chat-kick-proxy.jrblaze.workers.dev/*` | Existing configuration and Kick OAuth token exchange/refresh helper. No chat relay or analytics. |
| `https://7tv.io/*` | Channel/global emote metadata. |
| `https://api.betterttv.net/*` | Channel/global emote metadata. |
| `https://api.frankerfacez.com/*` | Channel/global emote metadata. |
| `https://recent-messages.robotty.de/*` | Recent Twitch messages on joining a channel. |
| Optional `https://www.youtube.com/*` | Public channel/live-video resolution plus marked embedded live-chat frames after explicit host permission. |

Do not add a justification for `https://api.github.com/*` or `https://*.workers.dev/*` to this store submission: those broader hosts are not in the store ZIP. There is no `tabs`, `history`, `debugger`, or `declarativeNetRequest` permission.

## Remote code

**Recommended selection: Yes — disclose the embedded third-party website scripts.** This is a transparent disclosure of the YouTube website context, not a claim that extension scripts are downloaded remotely.

**Justification:**

```text
All Friendly Chat extension logic is bundled in the uploaded package. Optional YouTube support embeds normal https://www.youtube.com/live_chat pages, which load YouTube's own website JavaScript in their web-page context. That remote website code is isolated from extension APIs. Packaged content scripts read rendered chat and drive explicitly selected native sends through a validated, role-bound bridge. Friendly Chat does not fetch/eval remote JavaScript as extension code. The embedded site's requests and cookies are disclosed in the privacy policy; no remote script can add arbitrary extension functionality.
```

Google's Manifest V3 policy distinguishes isolated website/iframe code from remote extension code. Its privacy form separately asks for remote-code disclosure. This selection and explanation are our mapping of the implementation to those fields; Google makes the review decision. Do not claim “no remote scripts anywhere,” since the YouTube page loads its own scripts.

## Data usage checkboxes

The following is a conservative mapping of the current features to Google's broad categories. It includes local/temporary handling, not just data stored by the developer. Do not select “no data collected.” If your dashboard offers purpose options, choose **App functionality**; do not select advertising, marketing or analytics.

| Dashboard category | Recommended selection | Scope / explanation |
| --- | --- | --- |
| Personally identifiable information | Check | Display names, usernames and account/channel identifiers used for chat and connections. No address or phone-number collection feature. |
| Health information | Leave unchecked | No health-data feature, profiling or health-record access. Incidental user-written chat is handled as chat content. |
| Financial and payment information | Check | Narrow scope: displayed Bits/Kicks balances, subscription/gift/Cheer events and transaction-related chat/reward metadata. No credit-card, banking or billing credentials; native platform controls handle purchases. |
| Authentication information | Check | Twitch/Kick OAuth tokens and Kick session-cookie use. No password form; YouTube credentials remain with its native website session. |
| Personal communications | Check | Incoming/outgoing chat, drafts and up to 50 recent sent texts held in current-visit memory. |
| Location | Check, IP address only | Google's category explicitly includes IP addresses. Network services, including embedded YouTube and the sign-in helper, receive the user's IP as part of normal requests. No GPS permission, coordinates or geolocation feature. This is conservative disclosure of network exposure, not a stored location history. |
| Web history | Check | Current supported channel/video URLs and saved channel associations are processed to connect the right chats. No general browsing-history log or history API access. |
| User activity | Check | Supported-page navigation and chat/rewards/menu input interactions are processed locally to operate the overlay. No general clickstream, mouse-position or keystroke analytics log. |
| Website content | Check | Chat text, displayed account labels, channel links, emotes, badges and supported native chat/rewards content. |

These selections should agree with the public privacy policy. “No developer analytics or chat database” does not mean the extension handles no user data. No external ad SDK or analytics SDK is included. Third-party platform websites retain their own policies.

## Three data-use certifications

The code and described operating model support checking all three statements:

- User data is not sold to third parties outside the approved use cases.
- User data is not used or transferred for purposes unrelated to the extension's single purpose.
- User data is not used or transferred to determine creditworthiness or for lending purposes.

Read the exact statements shown by your dashboard before you personally certify them. Normal user-directed chat transfers to Twitch, Kick or YouTube are required functionality, not a promise of “no sharing.”

## Reviewer testing instructions (if requested)

```text
Install the uploaded package and open a Twitch or Kick channel. The merged overlay appears on supported channel pages. YouTube is optional: use the local setup page or settings access button to allow www.youtube.com, then paste a currently live YouTube video/channel URL into the overlay's YouTube controls and choose Add chat. Reading requires an available live chat. Sending is off by default; sign into YouTube in the same Chrome profile, verify the displayed account and select the YouTube target when its native composer is available. Browser third-party-cookie restrictions may leave reading available while sending is unavailable. No API key, paid Friendly Chat account or developer-provided credentials are needed. Use your own accounts and test channels for any real messages. The project README and privacy policy describe the feature limits and data flows.
```

## Screenshots

Use the five numbered 1280×800 PNGs in `store-screenshots/2026-09-27/`, in numerical order. They show the actual packaged UI with synthetic sample chat/account state and promotional captions. They do not represent a signed-in live account. The capture notes identify the fixture boundaries. The screenshot ZIP and copy kit are delivery artifacts, not extension upload packages.

## Official references checked for this preparation

- Privacy fields: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- Data handling, including local-only handling: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- Manifest V3 and isolated iframe contexts: https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements
- Image sizes and screenshot guidance: https://developer.chrome.com/docs/webstore/images

Current guidance asks for 1–5 screenshots at 1280×800 or 640×400. This set uses 1280×800, square corners, RGB PNG, no alpha. Keep the existing required 440×280 promotional tile unless you separately replace it; these screenshots do not replace that tile or the extension icon.
