# YouTube chat parity validation - September 28, 2026

Local implementation on `codex/issues-67-68`, based on HEAD
`e2581ab19108d5d7368a4c6585a691f78174ab56`. This expands the owner's earlier
issue #67/#68, YouTube mention-reply and emote requests. Those changes are retained.
No commit, push, release, external configuration change or live action was made.

## Behavior and remaining differences

| Capability | Current YouTube behavior |
| --- | --- |
| Sending and replies | Existing signed-in native composer; name click/@autocomplete prepares a YouTube-only plain-text mention; source/account changes invalidate unfinished replies |
| Message rendering | Clickable links, Unicode mentions, configured-name and current-sender highlights, escaped text, received emotes and hover preview |
| Highlight name overlap | Longer names match first so a saved shorter name cannot mask the current YouTube identity |
| Roles | Captured owner/moderator/member/verified text badges; captions on hover; existing Badges toggle; no permission inference |
| Paid messages | Super Chat label, supplied amount and text; Super Sticker image when supported, otherwise readable text |
| Membership events | Membership milestones, gifted-membership and gift-received headers, including rows without message bodies; Events off suppresses new membership/gift notices |
| Feed visibility | YouTube show/hide toggle persists across batches during this visit; removal resets it; cannot hide the last source |
| Author menu | Right-click for reply, Copy username and the last six matching messages already in the local feed; ordinary click still replies |
| Native controls | Open YouTube chat uses the validated current video; link clears on source removal |
| Existing shared tools | Feed bounds, timestamps, explicit deletion markers, themes, scrolling, draft/recall and composer limits retain their existing paths |
| Remaining native-only features | Emote picker/sending and membership entitlement checks, moderation, polls, gifts/purchases and native reply threads remain in YouTube's UI |
| Remaining data gaps | No full server history, profile/account lookup, complete moderation removal stream or third-party YouTube emote catalog |

Captured role/event data is bounded and validated at transport and render boundaries.
Role metadata never authorizes a moderator action. Sticker images use the same narrow
URL validation, no-referrer policy and text fallback as previously added emotes.
No new permissions, credentials, storage records, backup fields or worker routes
were introduced by this follow-up. Identity and feed visibility remain in memory.

YouTube's documented message types informed the feature comparison:
[Live chat messages](https://developers.google.com/youtube/v3/live/docs/liveChatMessages).
This is not proof of current live DOM behavior; this implementation consumes the
existing attached-page reader, not a new Data API integration.

## Validation

Baseline: `node tests/run.js` reported **3,365 passed, 0 failed** before these changes.
Final `node tests/run.js`: **3,365 passed, 0 failed**, exit 0.
All three final browser scripts passed. Combined exact-source coverage gate: exit 0.

| Changed runtime file | Executable lines | Functions | V8 ranges |
| --- | ---: | ---: | ---: |
| `src/content/compose.js` | 101/101 | 21/21 | 109/109 |
| `src/content/overlay.js` | 46/46 | 3/3 | 61/61 |
| `src/content/render.js` | 49/49 | 7/7 | 54/54 |
| `src/content/youtube-controls.js` | 36/36 | 2/2 | 17/17 |
| `src/options/options.js` | 1/1 | 0/0 | 0/0 |
| `src/shared/constants.js` | 3/3 | 0/0 | 0/0 |
| `src/shared/youtube.js` | 80/80 | 8/8 | 117/117 |
| `src/youtube/permission.js` | 1/1 | 0/0 | 1/1 |
| **Combined working diff** | **317/317** | **41/41** | **359/359** |

This is **100% changed-JavaScript coverage**, including earlier uncommitted issue,
reply and emote work, not whole-repository coverage. CSS/HTML behavior is covered
by unit assertions and browser checks rather than JavaScript instrumentation.
The gate rejects stale/padded source and was not weakened. Browser coverage was
regenerated after the final runtime edit. Full-suite assertion totals do not count
every assertion in separately invoked unit/browser scripts.

Commands exercised:

- `node tests/youtube-reader.test.js`, `node tests/youtube-transport.test.js`,
  `node tests/youtube-view.test.js`, `node tests/youtube-controls.test.js`, and
  `node tests/youtube-sending-ui.test.js`: targeted unit/regression assertions.
- `node tests/run.js render`: **190 passed, 0 failed**.
- `node tests/run.js theme`: **14 passed, 0 failed**.
- `node tests/run.js repo`: **14 passed, 0 failed** after each documentation update.
- `node tests/run.js youtube`: all included assertions passed; runner reports
  **1 suite passed, 0 failed** (this is not an assertion count).
- `node --check` on every changed JavaScript file and `tests/recent-emotes.test.js`.
- `git diff --check`: clean.
- `node tests/youtube-browser.js dist/youtube-parity/view-browser`
- `node tests/youtube-send-browser.js dist/youtube-parity/send-browser`
- `node tests/youtube-options-browser.js dist/youtube-parity/options-browser`
- `node tests/release-coverage.js --changed-only dist/youtube-parity/node-coverage.json dist/youtube-parity/send-browser/browser-coverage.json dist/youtube-parity/view-browser/browser-coverage.json dist/youtube-parity/options-browser/browser-coverage.json`
- `node tests/run.js` with final output in `dist/youtube-parity/full-suite.log`.

Browser commands use the existing bundled Playwright selected by
`FCM_PLAYWRIGHT_PATH`. They run installed Chrome with Chrome and simulated Firefox
branches, on both Twitch and Kick fixtures where applicable. External requests
are blocked; synthetic YouTube images are fulfilled locally. Merge, send, settings,
backup and narrow-layout checks passed, including real DOM right-click/copy/history,
badge visibility, event suppression, link destinations, mention highlights, source
removal, independent feed filtering, and continued receipt while hidden.
The compact paid/event layout was inspected in the generated screenshot.

Unit tests cover role/event sanitation and bounds, supported and rejected images,
empty/unknown metadata, bodyless events, transport forwarding, name overlap,
Unicode boundaries, self highlighting, stale identity cleanup, visibility reset,
last-source protection, local menu actions, and retained Twitch/Kick moderation
and profile-menu behavior. The shared highlighting helper also removes two
unreachable cases: configured patterns contain nonempty names and upstream token
expansion does not emit empty text tokens. No coverage exclusions were introduced.

## File inventory

Changed in this parity follow-up:

| File | Purpose |
| --- | --- |
| `src/shared/youtube.js` | Extract and validate optional role/event metadata; recognize additional native event rows |
| `src/content/render.js` | Links, Unicode/current-identity highlighting, text badges and event presentation |
| `src/content/compose.js` | YouTube right-click author menu and local history, with native moderation isolation |
| `src/content/overlay.js` | Set/clear YouTube highlighting identity with sender lifecycle |
| `src/content/youtube-controls.js` | Feed visibility, native-chat shortcut, event filtering and metadata forwarding |
| `src/content/overlay.css` | Badge/event/mention/filter presentation |
| `tests/youtube-reader.test.js` | Native row variants and sanitation tests |
| `tests/youtube-transport.test.js` | Metadata across synthetic capture/relay/host transport |
| `tests/youtube-view.test.js` | Rendering, identity, menu and native-platform regression tests |
| `tests/youtube-controls.test.js` | Filter, event, shortcut and lifecycle tests |
| `tests/youtube-sending-ui.test.js` | Sender identity lifecycle assertions |
| `tests/youtube-browser.js` | Synthetic parity fixtures, browser assertions and screenshots |
| `README.md` | Supported behavior and remaining native-only features |
| `PRIVACY.md` | In-memory identity, role/event data, local menu and user-opened links |
| `VALIDATION-youtube-parity.md` | This evidence record |
| `docs/handoff/31_YOUTUBE_EMOTE_RENDERING.md` | Historical-stage clarification and follow-up pointer; ignored |
| `docs/handoff/32_YOUTUBE_CHAT_PARITY.md` | Current subsystem contract and limits; ignored |

Inherited working changes are documented in `VALIDATION-issues-67-68.md`,
`VALIDATION-youtube-replies.md`, and `VALIDATION-youtube-emotes.md`. Additional
inherited files outside the table above: `src/options/options.html`,
`src/options/options.js`, `src/popup/popup.html`, `src/shared/constants.js`,
`src/youtube/permission.html`, `src/youtube/permission.js`,
`tests/issue-64.test.js`, `tests/release-coverage.js`, `tests/run.js`,
`tests/youtube-access-card.test.js`, `tests/youtube-options-browser.js`,
`tests/youtube-permission.test.js`, `tests/youtube-send-browser.js`, and
`tests/recent-emotes.test.js`. Pre-existing `AGENTS.md` and
`store-screenshots/2026-09-17/` were untouched.

## Review and limits

Final diff review covers platform/account/source isolation, bounds, sanitization,
HTML escaping, URL construction, cleanup, shared UI regression, tests, CSS and
documentation. Existing extension IDs, manifests, permissions, release versions,
storage/backup contracts, credentials and worker routes remain intact.
Handoffs and `dist/` artifacts remain locally ignored; no exclusions changed and
nothing was force-added.

Native Firefox and live YouTube DOM/CDN/account behavior remain unverified.
Changes in YouTube's markup, badge captions or image URLs can require a future
reader adjustment or cause text fallback. No authenticated browser/API testing,
real message, moderation, purchase, account change, external CI, Firefox lint,
signing, deployment, release or store submission was performed. The full suite
includes isolated package/startup checks; those do not constitute deployment.
