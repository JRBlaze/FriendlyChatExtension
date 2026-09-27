# Friendly Chat 1.23.0 validation — September 26, 2026

Release candidate: version 1.23.0 includes all follow-ups below, through
[notification protection](#twitch-and-kick-top-right-notification-protection).
Full tests pass 3362/0. Actual-source coverage is 100% of new/changed JavaScript:
2029 executable lines, 272 functions and 2168 V8 ranges. This is not whole-repository
coverage. Earlier sections preserve the validation history and are superseded by
later results. Publication was authorized on September 26, 2026; the release PR,
tag workflow and published assets provide the final external publication status.

Release preparation corrected the manifest description's obsolete read-only
YouTube wording, with a package-boundary regression assertion. Runtime JavaScript
is unchanged from the final toast coverage/browser runs. The original untracked
AGENTS.md, old store screenshots and ignored local handoffs remain outside the PR.

Previous result: [Firefox message deletion](#firefox-message-deletion)
fixes Backspace/Delete by attaching the Firefox overlay inside the page body.
Native Firefox tests pass on both host layouts, including pop-out return.
Full tests pass 3362/0. New/changed JavaScript coverage is 100% (1982 lines,
268 functions, 2107 V8 ranges).
Chrome and Firefox local builds are rebuilt. The earlier Firefox sign-in access
flow remains included; live YouTube delivery still needs the owner's test.
Previous Chrome duplicate/status/badge fixes remain validated. Nothing was released.

## Result and scope

YouTube support is integrated into the regular Friendly Chat source at
`C:\Users\jrbla\Documents\FC Chrome Extension`, on local branch
`codex/youtube-integration`, based on `7c642ad355c68babda8ea6bc37215cd6cc443181`.
The manifest is version 1.23.0, keeps the production name/key, and has no experimental
or trial label. Generated Firefox identity and update URL remain unchanged.

The owner reported the prior YouTube tests working, including over 20 minutes of
capture, and requested promotion plus fixes for every open repository issue. The
three open issues at review time were #62, #63, and #64. Their fixes are included.
At the original integration checkpoint no commit, push, merge, tag, signing,
publication, store submission, issue closure or worker deployment had occurred.
Issues #62-64 are to be closed after published release verification.

The original untracked `AGENTS.md` and `store-screenshots/` were preserved. The
separate delivered YouTube trial, its browser profile, settings, and backups were
not modified. The development trial builder remains available under `tools/` and
is excluded from normal extension packages.

## User-visible behavior

- Optional YouTube chat joins the existing feed on Twitch and Kick.
  Direct live URLs/IDs and channel URLs are supported. Permitted metadata lookups
  offer live-channel suggestions; Add starts a temporary capture. An explicitly
  saved channel link authorizes fresh lookup and capture on future host visits.
- YouTube sending uses its embedded native composer when a signed-in account is
  available. Users explicitly select its send target for each visit; channel or
  account changes remove that selection. No API key or owner-hosted service is
  needed. Account connections, replies and moderation stay Twitch/Kick-only.
- New installs open a one-time YouTube setup page. Updates open it in a background
  tab; the popup and settings retain a New in 1.23.0 card and access button.
  Permission remains optional and requires a user click in Chrome or Firefox.
- [#62](https://github.com/JRBlaze/FriendlyChatExtension/issues/62): `drops` is a
  reserved Kick route. Drops, inventory and nested Drops pages cannot start a chat
  overlay, including through SPA navigation or popout-shaped paths.
- [#63](https://github.com/JRBlaze/FriendlyChatExtension/issues/63): short Twitch
  live notifications and Kick toasts reserve space above the overlay independently
  of the Leave room for site's cards setting. Dismissal restores normal placement;
  ordinary Twitch chat rows remain excluded from notification detection.
- [#64](https://github.com/JRBlaze/FriendlyChatExtension/issues/64): live and history
  Twitch rows retain the Gigantify marker. Only the last native Twitch emote is
  enlarged, using its larger image, while ordinary and third-party emotes retain
  normal sizing. Narrow chat columns still fit the enlarged image.

## Verification before native sending

All commands ran from the regular checkout unless a worktree is explicitly named.
The existing Playwright installation was selected through `FCM_PLAYWRIGHT_PATH`:
`C:\Users\jrbla\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright`.

| Check | Result |
| --- | --- |
| Original pre-promotion `node tests/run.js` | 3344 passed, 0 failed |
| YouTube worktree and exact-byte promoted source `node tests/run.js` | 3354 passed, 0 failed |
| Baseline before saved YouTube links | 3355 passed, 0 failed |
| Baseline before install/update onboarding | 3357 passed, 0 failed |
| Final `node tests/run.js` including onboarding, saved links and all three issues | 3360 passed, 0 failed |
| `node tests/run.js youtube` | Passed all internal YouTube assertions |
| `node tests/run.js openissues` | Passed all internal issue assertions |
| `node tests/run.js repo` after documentation and copied-file updates | 14 passed, 0 failed |
| Individual issue regression tests | Each reproduced the original failure before its fix, then passed |
| Existing sites/authpages/navigation/native/IRC/render/background/GIF/resilience checks | Passed |
| `node tests/youtube-browser.js dist/youtube-1.23.0/onboarding-merged-browser` | Saved links, both-host loading, offline/permission states, navigation, pause/forget, suggestions, read-only interactions and account settings passed; actual 260px panel verified |
| `node tests/youtube-options-browser.js dist/youtube-1.23.0/onboarding-options-browser` | Actual options page at 1360px/420px: rows, long URLs, individual Forget, backup/import labels and legacy preservation passed |
| `node tests/youtube-onboarding-browser.js dist/youtube-1.23.0/onboarding-browser` | All six real welcome/popup/options surfaces passed in Chrome and simulated Firefox modes, with trusted-click permission assertions and responsive screenshots |
| `node tests/open-issues-browser.js dist/youtube-1.23.0/saved-links-issues-browser` | Drops routes, clickable Twitch toast and 26px/112px emote sizing passed, including a 260px panel |
| `node tests/release-coverage.js dist/youtube-1.23.0/onboarding-node-coverage.json dist/youtube-1.23.0/onboarding-merged-browser/browser-coverage.json dist/youtube-1.23.0/onboarding-options-browser/browser-coverage.json dist/youtube-1.23.0/onboarding-browser/browser-coverage.json` | All new/changed executable lines, functions and V8 ranges covered; details in onboarding-coverage.txt |
| `node --check <changed-or-new-JavaScript-file>` | Passed |
| `git diff --check` | Passed |
| Independent runtime/security and final issue reviews | No actionable findings |

The legacy runner counts each additional suite once; its total does not count
every internal assertion. Coverage is measured separately with V8, exact current
source equality, and nested execution ranges. No ignored branches or padded VM
source are credited. New runtime modules and the trial builder are measured in
full; pre-existing runtime files are measured across their complete changed diff.

| File | Executable lines | Functions | V8 ranges |
| --- | ---: | ---: | ---: |
| src/background/youtube-links.js | 69/69 | 10/10 | 88/88 |
| src/background/youtube-lookup.js | 85/85 | 13/13 | 116/116 |
| src/background/youtube-onboarding.js | 23/23 | 5/5 | 24/24 |
| src/background/youtube-relay.js | 145/145 | 23/23 | 164/164 |
| src/content/youtube-controls.js | 283/283 | 30/30 | 162/162 |
| src/content/youtube-reader.js | 79/79 | 12/12 | 64/64 |
| src/content/youtube-source.js | 116/116 | 17/17 | 88/88 |
| src/content/youtube-suggestions.js | 94/94 | 22/22 | 91/91 |
| src/shared/youtube.js | 92/92 | 12/12 | 137/137 |
| src/shared/youtube-links.js | 23/23 | 4/4 | 41/41 |
| src/youtube/access-card.js | 40/40 | 5/5 | 27/27 |
| src/youtube/permission.js | 61/61 | 7/7 | 57/57 |
| tools/youtube-trial.js | 82/82 | 6/6 | 27/27 |
| src/shared/constants.js | 4/4 | 0/0 | 0/0 |
| src/content/render.js | 9/9 | 1/1 | 13/13 |
| src/content/compose.js | 4/4 | 1/1 | 11/11 |
| src/content/overlay.js | 15/15 | 1/1 | 8/8 |
| src/content/sites.js | 6/6 | 4/4 | 4/4 |
| src/background/service-worker.js | 7/7 | 0/0 | 0/0 |
| src/background/twitch-source.js | 2/2 | 0/0 | 0/0 |
| src/content/native.js | 6/6 | 1/1 | 8/8 |
| src/options/options.js | 56/56 | 5/5 | 28/28 |
| src/shared/util.js | 6/6 | 0/0 | 5/5 |
| **Total** | **1307/1307** | **179/179** | **1163/1163** |

This is **100% new/changed JavaScript coverage**, not whole-repository coverage.
HTML/CSS are checked through rendered fixtures and package/content assertions.

## Final local packages

Built from the final source after native sending, Firefox sign-in access, onboarding,
saved links, all three fixes and documentation updates, 59 files per
package. The production name/key, Firefox ID/update URL and package exclusions
were explicitly verified. Product/runtime text contains no experimental or trial
labels. These are local build artifacts, not published or signed releases.

| Command | Result |
| --- | --- |
| `node tools/pack.js dist/youtube-1.23.0/packages --target all` | Chrome ZIP and unsigned Firefox XPI built |
| `node tools/release.js verify-packages dist/youtube-1.23.0/packages 1.23.0` | All good |
| `node tools/pack.js dist/youtube-1.23.0/chrome-store --target chrome-store` | Separate upload-ready artifact built; not submitted |
| `node tools/pack.js --unpacked dist/youtube-1.23.0/chrome --target chrome` | Production-identity unpacked Chrome folder built |
| `node tools/pack.js --unpacked dist/youtube-1.23.0/firefox --target firefox` | Firefox event-page folder built |
| `npx --offline --yes web-ext@8.10.0 lint --source-dir dist/youtube-1.23.0/firefox --self-hosted --no-config-discovery` | 0 errors, 0 notices, 22 existing HTML-assignment warnings |

SHA-256:

- `packages/FriendlyChatExtension-v1.23.0.zip`: `FF8ADFE9173753F93EE67597ABB7CC753CFA69B889B75649EE2C21FFF2C1DEE2`
- `packages/FriendlyChatExtension-v1.23.0-firefox-unsigned.xpi`: `073158F29EB14FFA5A5C1CAEFFE5208A59AD96B1C152A265E930E097E7110685`
- `chrome-store/FriendlyChatExtension-v1.23.0-chrome-web-store.zip`: `C26F42EC1886B4FBCC2E9887B68F64FA1F4E1209E038A61F825318C9F4262E0D`

The hash paths above are relative to `dist/youtube-1.23.0/`. The Chrome Store ZIP is kept
outside the GitHub package directory to preserve the single-release-ZIP rule.

## Account settings cleanup

At the owner's request, the normal redirect URL box beneath Twitch/Kick connection
buttons was removed from `src/content/overlay.js`. OAuth addresses, account
commands, background plumbing and failure-specific redirect guidance are unchanged.
`tests/run.js` regression assertions failed before removal and now pass: the
Firefox suite reports 329/0. `tests/youtube-browser.js` verifies the absent box,
both Connect/Disconnect command paths, diagnostic visibility only on a relevant
failure, and cleanup on successful connection in both synthetic browser modes.
At that stage, coverage was 920/920 lines, 136/136 functions and 810/810 ranges.

This follow-up changed only `src/content/overlay.js`, `tests/run.js`,
`tests/youtube-browser.js`, `tests/harness.html` (comment), `README.md`, this report
and `docs/handoff/27_YOUTUBE_AND_OPEN_ISSUES.md`, plus rebuilt local artifacts.
That stage's settings screenshots are in `settings-cleanup-browser/`; current
screenshots are under `saved-links-browser-verified/`. No live account was connected
or disconnected. The version remains the unreleased 1.23.0.

## Saved YouTube links follow-up

Settings → Cross-platform → Link a YouTube channel opens the same YouTube controls,
including when the panel began collapsed. Save accepts canonical channel URLs;
video URLs remain session-only. An optional unchecked Also link checkbox names an
existing reciprocal manual Twitch/Kick counterpart. Selecting it writes independent
records for both hosts; guessed counterparts are never silently persisted.

The separate local `fcm_youtube_links_v1` map has a 400-host cap. Runtime reads and
backups sanitize host keys/URLs; serialized background writes avoid lost tab edits.
Save checks live status now and on later visits. Optional permission is still
required. Offline/ambiguous/error states retain the saved link without falling back
to guesses. The initial saved check does not open the control panel, and no recurring
live poll was added. Add is a temporary override, Remove pauses this visit, and
Forget deletes only the current host. Pending reads/writes cannot restart capture
after Remove, manual override, SPA navigation or teardown.

Options lists saved hosts separately, with stale-URL-safe individual Forget. Backup
version 1 gains an optional sanitized youtubeLinks section: missing/empty/invalid
sections preserve storage, while nonempty valid imports replace that section using
existing confirmation and nontransactional import semantics. No tokens, chat rows
or ephemeral video IDs enter this store. Existing Twitch/Kick mappings/send targets
and automatic-match cleanup remain unchanged.

New backend/schema, controls and backup unit tests cover all changed behavior.
The final independent review found one collapsed-panel navigation issue; it was
fixed and exercised in the browser. No unresolved findings remain. Live accounts,
real channel data and the separate installed trial were not used for this follow-up.

## Browser evidence and limits

All browser scripts use installed Chrome, once in Chrome mode and once with
Firefox branches simulated. Every mode reported zero JavaScript errors and zero
real external requests served. The YouTube fixture blocked 26 external requests
per mode; issue fixtures blocked seven and supplied seven synthetic emote images.
The options fixture attempted no external requests.
Screenshots were visually checked. An initial narrow-layout test assumed the
harness page button forced the panel to 260px; the corrected test explicitly sizes
the panel and verifies its measured width before checking overflow.

The owner reported successful manual Firefox testing before this onboarding change.
Native Firefox live testing was not run by the agent; the new native permission
dialog has not been independently exercised. These fixtures do not independently
verify live Twitch notification markup, a real paid Gigantify redemption, or every
YouTube layout. No purchase, real message, redemption, moderation action or account
change was performed. YouTube can stop working when its markup or browser embedding
behavior changes; errors and retries remain bounded. Same-name suggestions are
labelled possible matches and still require user acceptance.

The IRC Gigantify marker is not listed in Twitch's current IRC reference. Its
message type is in [Twitch's official EventSub reference](https://dev.twitch.tv/docs/eventsub/eventsub-reference/#channel-chat-message-event),
and the IRC marker plus final-emote selection are corroborated by Chatty's
[pinned parser](https://github.com/chatty/chatty/blob/02681ca2811a959f5646efeaf3f91f1478570410/src/chatty/util/irc/MsgTags.java#L132)
and [selection implementation](https://github.com/chatty/chatty/blob/02681ca2811a959f5646efeaf3f91f1478570410/src/chatty/gui/components/textpane/ChannelTextPane.java#L3211).
The regression fixtures cover absent/unknown markers, repeated and distinct native
emotes, Unicode/action messages, history/live parity, and other platforms.

## Changed files

Runtime and product documentation:
`PRIVACY.md`, `README.md`, `manifest.json`, `src/background/service-worker.js`,
`src/background/twitch-source.js`, `src/background/youtube-lookup.js`,
`src/background/youtube-relay.js`, `src/content/compose.js`, `src/content/native.js`,
`src/content/overlay.css`, `src/content/overlay.js`, `src/content/render.js`,
`src/content/sites.js`, `src/content/youtube-controls.js`, `src/content/youtube-reader.js`,
`src/content/youtube-source.js`, `src/content/youtube-suggestions.js`,
`src/shared/constants.js`, `src/shared/youtube.js`, `src/youtube/permission.html`,
`src/youtube/permission.js`, `src/shared/youtube-links.js`, `src/shared/util.js`,
`src/background/youtube-links.js`, `src/options/options.js`,
`src/options/options.html`, `src/options/options.css`, `src/popup/popup.html`,
`src/popup/popup.css`, `src/background/youtube-onboarding.js`,
`src/youtube/access-card.js`, `src/youtube/permission.css`.

Tests and local tooling:
`tests/harness.html`, `tests/run.js`, `tests/issue-62.test.js`, `tests/issue-63.test.js`,
`tests/issue-64.test.js`, `tests/open-issues-browser.js`, `tests/release-coverage.js`,
`tests/youtube-browser.js`, `tests/youtube-controls.test.js`, `tests/youtube-coverage.js`,
`tests/youtube-hints.test.js`, `tests/youtube-integration.test.js`,
`tests/youtube-lookup.test.js`, `tests/youtube-permission.test.js`,
`tests/youtube-reader.test.js`, `tests/youtube-resolve-route.test.js`,
`tests/youtube-suggestions.test.js`, `tests/youtube-transport.test.js`,
`tests/youtube-trial.test.js`, `tests/youtube-view.test.js`, `tools/youtube-trial.js`,
`tests/youtube-links.test.js`, `tests/youtube-links-backup.test.js`,
`tests/youtube-options-browser.js`, `tests/options-harness.html`,
`tests/youtube-access-card.test.js`, `tests/youtube-onboarding.test.js`,
`tests/youtube-onboarding-browser.js`.

Validation documentation: this file and the locally ignored
`docs/handoff/27_YOUTUBE_AND_OPEN_ISSUES.md` and
`docs/handoff/04_DATA_MODEL_AND_STORAGE.md`. Ignored build/browser evidence is under
`dist/youtube-1.23.0/`. Exclusions were not changed and no handoff was force-added.

## Install/update introduction follow-up

The synchronous onInstalled listener opens local setup on installation (focused)
or update (background), once per local installation. It uses the exact version
marker `fcm_youtube_onboarding_v1: "1.23.0"`, not a user setting. It persists the
marker before opening and serializes overlapping events. Reloads, worker starts,
future updates and backup imports do not repeat onboarding. A storage failure
skips opening; a tab failure retains the marker while the popup/options cards
remain available. Existing browser-managed update activation is untouched.

All three UI surfaces request only `https://www.youtube.com/*` directly within the
button gesture. No load-time request, mandatory permission, API key or service is
introduced. Existing grants are displayed immediately; denial and errors allow
retry. A deferred refresh ensures a permission change during a pending request
wins over its older result. The setup page handles focus, closure and late reads,
offers Not now/Done, and explains suggestions, saved links and optional sending.
The shared popup/options card links back to setup and highlights the update.

Onboarding unit tests cover version/event gating, update/install focus, restart,
serialization, storage/tab failures, package inclusion, Chrome/Firefox startup
and backup exclusion. UI tests cover permission/error/race outcomes. The new
browser harness uses actual shipped markup/scripts, checks trusted gestures and
the exact origin, and serves zero external requests. Desktop and narrow welcome,
popup (320px with all Firefox hosts withheld) and options screenshots were
visually reviewed; overflowing popup content remains vertically scrollable.

An initial combined coverage attempt rejected old browser evidence after the
constants change. Browser evidence was rerun against current source and the
strict gate then passed; stale evidence was not credited. Review also found and
fixed a pending permission-event race and clarified watched-channel wording.
Final independent reviews found no remaining actionable issues. Firefox lint is
recorded in `dist/youtube-1.23.0/onboarding-firefox-lint.txt` (0 errors, 0 notices,
22 existing warnings). Version remains unreleased 1.23.0.

## Native YouTube sending (current validation)

The owner requested local sending support before any releases. The merged composer
now supports an explicitly selected YouTube destination, alone or with Twitch/Kick.
It starts off on each visit, shows the embedded composer's public account label,
and resets on channel, reader or account changes. Saving a link or granting access
does not enable sending. No account credentials are copied from YouTube.

The native sender preserves occupied drafts, validates exact text (at most 200
JavaScript string units and no control characters), waits for the native button,
and clicks once. Native draft clearing is reported as submitted, not delivered.
An interrupted or unconfirmed submission is never retried or restored to the
Friendly Chat input. Combined sends validate YouTube text before any destination
receives a copy. Replies remain scoped to Twitch/Kick; YouTube row tooltips now
explain the unavailable reply/moderation actions. Existing binary account/target
storage, manual links, backups, permissions, extension identity and release
channels are preserved.

Review found and fixed stale host-channel dispatch, late completion after overlay
destruction, and permission revocation during native draft preparation. Revocation
closes the reader/source and reconnects must recheck permission. The final
independent reviews found no remaining actionable issues. Two unreachable old
send-path fallback branches were removed after tests established that API target
groups are nonempty and a threaded reply already has its reply object.

The live Chrome probe created a temporary hidden iframe on an existing Twitch
page. YouTube exposed a signed-in native composer. An isolated-world input event
enabled its Send button while hidden; clearing the owned draft disabled it again.
No Send click occurred. The iframe, temporary tab and local helper server were
cleaned up. Actual server delivery, account/channel restriction combinations and
native Firefox sending remain unverified. Firefox compatibility branches below
run in Chrome; they are not evidence of native Firefox delivery. Normal embedded
session/cookie restrictions still apply. No release, real message, credential,
account or browser-permission change was made.

| Check | Result |
| --- | --- |
| Baseline `node tests/run.js` before sending changes | 3360 passed, 0 failed |
| Final `node tests/run.js` | 3361 passed, 0 failed; `dist/youtube-1.23.0/send-full-tests.txt` |
| `node tests/run.js firefox` | 329 passed, 0 failed |
| `node tests/run.js repo` | 14 passed, 0 failed |
| `node tests/youtube-send-transport.test.js --coverage` | Full relay/source/reader lines, functions and V8 ranges 100%; real source-to-native fixture included |
| `node tests/youtube-send-browser.js dist/youtube-1.23.0/send-browser` | Both hosts in Chrome/Firefox modes: trusted selection/send, mixed and YouTube-only sends, replies, validation, uncertain results and 260px layout passed |
| `node tests/youtube-browser.js dist/youtube-1.23.0/send-merged-browser` | Fresh merge, saved-link, suggestion, row-action and navigation checks passed |
| `node tests/youtube-options-browser.js dist/youtube-1.23.0/send-options-browser` | Saved-link, backup and narrow layout checks passed |
| `node tests/youtube-onboarding-browser.js dist/youtube-1.23.0/send-onboarding-browser` | Six actual welcome/popup/options surfaces passed |
| `node tests/open-issues-browser.js dist/youtube-1.23.0/send-issues-browser` | Issues #62–64 passed in both browser modes |
| `node --check` for each changed/new JavaScript file | 53 files passed |
| Final local build/package verification and Firefox lint commands above | All passed; 0 lint errors, 0 notices, 22 existing warnings; `send-firefox-lint.txt` |
| `git diff --check` | Passed; normal Windows LF/CRLF notices only |

Browser commands used the already installed Playwright path through
`FCM_PLAYWRIGHT_PATH`, served local synthetic fixtures and blocked all external
traffic. Screenshots and JSON results are in the corresponding artifact folders.

Final exact-source coverage command:

```text
node tests/release-coverage.js dist/youtube-1.23.0/send-node-coverage.json dist/youtube-1.23.0/send-browser/browser-coverage.json dist/youtube-1.23.0/send-merged-browser/browser-coverage.json dist/youtube-1.23.0/send-options-browser/browser-coverage.json dist/youtube-1.23.0/send-onboarding-browser/browser-coverage.json dist/youtube-1.23.0/send-issues-browser/browser-coverage.json
```

It passed **1683/1683 executable lines, 235/235 selected functions and 1662/1662
V8 ranges** across all new/changed runtime JavaScript in the unreleased work and
the trial builder. This is **100% new/changed coverage**, not whole-repository
coverage. The gate rejected older browser evidence after retry changes; affected
fixtures were rerun before crediting their coverage. Final details are in
`dist/youtube-1.23.0/send-coverage.txt`.

Files changed for this sending follow-up (in addition to the earlier inventory):

- Runtime: `src/background/youtube-relay.js`, `src/content/youtube-controls.js`,
  `src/content/youtube-reader.js`, new `src/content/youtube-send.js`,
  `src/content/youtube-source.js`, `src/content/overlay.js`, `src/content/render.js`.
- Product/privacy: `README.md`, `PRIVACY.md`, `src/popup/popup.html`,
  `src/options/options.html`, `src/youtube/permission.html`, `src/youtube/permission.js`.
- Tests: `tests/run.js`, `tests/release-coverage.js`, `tests/youtube-coverage.js`,
  `tests/youtube-browser.js`, `tests/youtube-controls.test.js`,
  `tests/youtube-view.test.js`, `tests/youtube-permission.test.js`,
  `tests/youtube-access-card.test.js`, `tests/youtube-reader.test.js`,
  `tests/youtube-transport.test.js`, new `tests/youtube-send.test.js`,
  `tests/youtube-send-transport.test.js`, `tests/youtube-sending-ui.test.js`,
  `tests/youtube-send-browser.js`.
- Validation/handoff: this report, `docs/handoff/27_YOUTUBE_AND_OPEN_ISSUES.md`
  and new `docs/handoff/28_YOUTUBE_NATIVE_SENDING.md`. Handoffs remain ignored;
  no exclusions or original untracked user files were changed.

For a local delivery test, reload the unpacked Chrome extension (or reload the
generated `dist/youtube-1.23.0/firefox/manifest.json` temporary Firefox add-on),
then refresh the Twitch/Kick page. Add a live YouTube chat, confirm the displayed
YouTube account, and select its send target. Select only YouTube for the first
short test message and verify it in YouTube chat before testing combined targets.
Do not interpret a submitted status alone as proof of delivery.

## Live sending diagnosis and fix

The owner reported that sending did not work and explicitly authorized real test
messages only on `https://www.twitch.tv/jrblaze`, `https://kick.com/jrblaze`, and
`https://www.youtube.com/watch?v=lKoqfBKxOPs`. This supersedes the earlier no-live-
message scope for those pages only; it does not authorize releases or other
external actions. The Chrome profile used was `jrblaze.org`.

Both live overlays incorrectly showed YouTube as signed out. In the actual marked
YouTube iframe, the native composer had the correct account and editable input,
but its `yt-live-chat-author-chip` remained hidden while idle. The Send wrapper was
also hidden and disabled with an empty draft. An input event enabled and revealed
the button while the identity chip stayed hidden. The original hidden-ancestor
checks therefore rejected a working signed-in composer before any send attempt.

`src/content/youtube-send.js` now permits that specific author-chip presentation
state and evaluates native Send visibility after preparing the draft. An enabled
but still-hidden button is never clicked. Hidden/disabled composers, account and
capability changes, occupied native drafts, permission revocation and no-retry
behavior retain their guards. Computed CSS visibility is checked within the
YouTube document, including inactive hidden error text; the outer capture iframe
stays hidden. No new permissions, endpoints, credentials or account changes are
involved.

The authorized diagnostic `Friendly Chat test YT-1: native send from Twitch.` was
submitted once through the native embedded composer using isolated-world DOM
input and the native Send button. Its exact text appeared in the embedded chat
and independently on the authorized YouTube watch page. The native draft cleared
and no error appeared. Screenshot: `dist/youtube-1.23.0/live-native-send.png`.
This diagnostic established actual native delivery independently of the later
Friendly Chat UI tests below.

The browser tool's security policy blocks `chrome://extensions`; no alternate
surface or indirect reload was used. The owner manually reloaded the extension,
then the agent refreshed the authorized Twitch and Kick pages. The YouTube send
target became available as `@JRBlaze`. Twitch restored its saved YouTube channel;
Kick was given the authorized video URL for this visit without saving a new link.

The following messages were sent once through normal Friendly Chat controls:

| Exact message | Origin and selected destinations | Observed arrival |
| --- | --- | --- |
| `Friendly Chat test YT-2: sent from Friendly Chat on Twitch.` | Twitch overlay; YouTube only | Actual YouTube watch-page chat and merged feed |
| `Friendly Chat test YT-3: sent from Friendly Chat on Kick.` | Kick overlay; YouTube only | Actual YouTube watch-page chat and merged feed |
| `Friendly Chat test ALL-1: Twitch + Kick + YouTube.` | Twitch overlay; all three targets | Native Twitch chat, native Kick chat, and actual YouTube watch-page chat |

Each native chat showed one copy of its intended message. Both Friendly Chat
drafts cleared. Both overlays were restored to Twitch/Kick selected and YouTube
off; the visit-only Kick capture remains available. No draft was overwritten.
Proof: `dist/youtube-1.23.0/live-merged-send.png`,
`live-merged-send-chat.png`, `live-merged-send-chat-detail.png`, and
`live-merged-send-twitch.png` in the same directory.

The sending Twitch overlay captured ALL-1 twice under different YouTube IDs,
while the independent Kick overlay and native YouTube chat each showed one.
An additional authorized native watch-page diagnostic, `Friendly Chat test YT-4:
checking native message confirmation.`, showed one DOM element transitioning
from a temporary ID to a confirmed ID. There was no explicit pending attribute;
the confirmed row gained context-menu presentation attributes. The temporary
isolated-world observer was disconnected and removed afterward. No page script
or persistent diagnostic handler remains.

This is an unresolved capture/display issue, not evidence of a duplicate send.
No speculative ID-prefix or text/time deduplication was added: those rules can
discard legitimate messages. Native Firefox delivery also remains untested.
These live results establish the Chrome send path on the authorized channels,
not readiness for release or reliability across all YouTube DOM variants.

Changes for this fix are `src/content/youtube-send.js`,
`tests/youtube-send.test.js`, `tests/youtube-transport.test.js`, this report and
the ignored handoff 28. Existing user changes remain intact. No commit, release,
upload, signing or settings reset occurred.

Validation after the fix:

- Baseline and final `node tests/run.js`: **3361 passed, 0 failed**; logs
  `live-send-baseline.txt` and `live-send-full-tests.txt` under `dist/youtube-1.23.0/`.
- `node tests/run.js youtube`: passed all YouTube subtests.
- `node tests/youtube-send-transport.test.js --coverage`: relay/source/reader
  coverage 100%; the full-chain fixture now reproduces the real idle controls.
- `node tests/release-coverage.js dist/youtube-1.23.0/live-send-node-coverage.json dist/youtube-1.23.0/send-browser/browser-coverage.json dist/youtube-1.23.0/send-merged-browser/browser-coverage.json dist/youtube-1.23.0/send-options-browser/browser-coverage.json dist/youtube-1.23.0/send-onboarding-browser/browser-coverage.json dist/youtube-1.23.0/send-issues-browser/browser-coverage.json`:
  **1689/1689 lines, 235/235 functions, 1678/1678 V8 ranges**, all new/changed
  JavaScript; not whole-repository coverage. Unchanged browser-source evidence
  was accepted by the exact-source guard. Native sender alone is 130/130 lines,
  20/20 functions, 186/186 combined ranges. Log: `live-send-coverage.txt`.
- All five build/verification commands listed above were rerun successfully;
  packages still contain 58 files and their current hashes are recorded above.
- Firefox lint: **0 errors, 0 notices, 22 existing warnings**;
  `live-send-firefox-lint.txt`. Syntax and `git diff --check` passed.
- Independent review found no actionable regression in readiness, account binding,
  native draft preservation or uncertain-send handling.

## Duplicate display and presentation fixes

The owner requested a fix for the duplicate YouTube row, silent successful sends,
and removal of the YT badge beside chatter names. All three are implemented in
the local build. This supersedes the earlier unresolved-display finding above;
the new capture arrangement has automated verification and the live Chrome
verification recorded below.

Every attached YouTube session now has two hidden native chat frames. The capture
frame never constructs a sender or accepts a send command. The sender frame uses
the existing native composer but never queries or forwards message rows. Only
capture batches can reach the merged feed. The relay binds each role to its exact
extension/tab/frame/video/run, rejects duplicate roles and one frame claiming
both roles, and obtains account capabilities only from the sending frame. Closing,
switching, losing a role or revoking access tears down both frames. Reconnection
uses a fresh nonce and never replays a message.

This excludes the local temporary preview rather than comparing message text or
guessing from ID formats. The regression fixture changes a sender DOM row from
temporary ID to confirmed ID and verifies zero capture queries/batches. Separate
capture rows with the same text and different IDs, including recycled DOM nodes,
remain separate. A different account shown in the capture frame cannot replace
the sender's account identity. The tradeoff is an additional hidden YouTube page
and its normal resource/network costs while chat is attached; no new permission,
API, server, credentials, storage key or remote service was introduced.

Successful native submission still clears the Friendly Chat draft and counts as
a successful handoff, but adds no system row. Failure and uncertainty warnings
remain visible and uncertain sends are never automatically retried. YouTube rows
have no YT badge; their platform dot, color, identity metadata and existing reply/
moderation restrictions remain.

Files changed for this follow-up:

- Runtime: `src/background/youtube-relay.js`, `src/content/youtube-source.js`,
  `src/content/youtube-reader.js`, `src/content/overlay.js`,
  `src/content/render.js`, `src/content/overlay.css`.
- Regression tests: `tests/youtube-reader.test.js`, `tests/youtube-transport.test.js`,
  `tests/youtube-send-transport.test.js`, `tests/youtube-sending-ui.test.js`,
  `tests/youtube-view.test.js`, `tests/youtube-send-browser.js`,
  `tests/youtube-browser.js`.
- Documentation: `README.md`, `PRIVACY.md`, this report, and locally ignored
  `docs/handoff/28_YOUTUBE_NATIVE_SENDING.md`. Original untracked user files and
  ignore rules remain unchanged.

Validation (all paths below are under `dist/youtube-1.23.0/`):

- Baseline and final `node tests/run.js`: **3361 passed, 0 failed**;
  `display-fix-baseline.txt`, `display-fix-full-tests.txt`.
- `node tests/run.js youtube`: passed. Local tests were run after each file update;
  new UI regressions failed before their fixes and passed afterward.
- `node tests/youtube-send-transport.test.js --coverage`: relay **237/237 lines,
  31/31 functions, 298/298 ranges**; source **183/183, 26/26, 171/171**; reader
  **98/98, 16/16, 101/101**.
- Fresh `node tests/youtube-send-browser.js dist/youtube-1.23.0/display-send-browser`
  and `node tests/youtube-browser.js dist/youtube-1.23.0/display-merged-browser`:
  passed on both host layouts in Chrome and simulated Firefox modes, including
  silent success, visible uncertainty, absent YT badges and 260px panels. The
  badge-free screenshot `display-merged-browser/chrome-twitch-merged.png` was
  visually inspected.
- Fresh `node tests/youtube-options-browser.js dist/youtube-1.23.0/display-options-browser`,
  `node tests/youtube-onboarding-browser.js dist/youtube-1.23.0/display-onboarding-browser`,
  and `node tests/open-issues-browser.js dist/youtube-1.23.0/display-issues-browser`:
  all passed. External traffic was blocked in all synthetic browser fixtures.
- `node tests/release-coverage.js dist/youtube-1.23.0/display-fix-node-coverage.json dist/youtube-1.23.0/display-send-browser/browser-coverage.json dist/youtube-1.23.0/display-merged-browser/browser-coverage.json dist/youtube-1.23.0/display-options-browser/browser-coverage.json dist/youtube-1.23.0/display-onboarding-browser/browser-coverage.json dist/youtube-1.23.0/display-issues-browser/browser-coverage.json`:
  **1700/1700 lines, 235/235 functions, 1718/1718 V8 ranges** across new/changed
  JavaScript, using exact current sources. This is not whole-repository coverage.
  Log: `display-fix-coverage.txt`.
- All five build/verification commands listed above passed again; both unpacked
  trees and all three 58-file packages are current, with updated hashes above.
- `npx --offline --yes web-ext@8.10.0 lint --source-dir dist/youtube-1.23.0/firefox --self-hosted --no-config-discovery`:
  **0 errors, 0 notices, 22 existing warnings**; `display-fix-firefox-lint.txt`.
- `node --check` for affected runtime/browser scripts and `git diff --check`:
  passed. `node tests/run.js repo` after documentation updates: **14/0**.
- Independent final code review found no actionable issue in role isolation,
  permissions, teardown, account binding, silent success or badge removal.

The owner manually reloaded the completed local Chrome build. The authorized
Twitch/Kick pages were refreshed and exposed two distinct frames per source,
with the sender account shown as `@JRBlaze`. Two further real messages were sent
through normal Friendly Chat UI, within the same three authorized channels:

| Exact message | Origin / destinations | Live result |
| --- | --- | --- |
| `Friendly Chat test ALL-2: checking the duplicate display fix.` | Twitch / Twitch, Kick and YouTube | Once in each native chat; exactly one YouTube row in each merged overlay |
| `Friendly Chat test YT-5: one YouTube row from Kick.` | Kick / YouTube only | Once in native YouTube chat; exactly one YouTube row in each merged overlay |

Both overlays contained zero `.fcm-chip-youtube` badges and no `Submitted to
YouTube.` system text. Native YouTube delivery was independently read from the
authorized watch page; Twitch's native row and Kick's native page text confirmed
ALL-2 there too. Both Friendly Chat drafts cleared and original Twitch/Kick-on,
YouTube-off send selections were restored. Kick's visit-only YouTube capture
remains loaded; no persistent link or account setting was changed.

Screenshots under `dist/youtube-1.23.0/`: `display-fix-live-twitch.png`,
`display-fix-live-feed.png` (visually inspected), and `display-fix-live-youtube.png`.
The crop shows one row per destination for ALL-2, one YouTube row for YT-5, and
no YT name badge or intervening success system message.

Native Firefox delivery remains unverified; Chrome tests do not establish all
browser/privacy-setting or future YouTube DOM combinations. No commit, push,
merge, tag, signing, upload, release or external setting change occurred.

## Firefox sign-in access with tracking protection

The owner confirmed that YouTube became available when Enhanced Tracking
Protection was temporarily disabled on Twitch. Their native YouTube tab already
showed a signed-in composer. ETP is therefore the observed trigger. The fix uses
Firefox's Storage Access API so the sender can use YouTube's existing sign-in
session while tracking protection remains enabled.

The unavailable YouTube target now offers **Enable sending** when access setup
is supported. That action reveals the existing sender iframe in place. A trusted
click on **Allow YouTube sign-in** inside that document requests access; no host
message fabricates activation. Twitch and Kick have separate browser-managed
grants. A previously granted permission can reactivate without a prompt only
while the native sender is unavailable and idle. Granting access never selects
the send target or posts a message. The displayed account must still be checked
and selected explicitly.

After a permission recheck, the child reloads its own document once. The relay
accepts only the same frame, role, tab, video and source nonce, rejects stale
old-port readiness and changes the sender identity epoch. The capture frame
continues reading. A host **Cancel setup** action remains accessible during
reload. A timeout or terminal sender failure disables only sending, with a
remove-and-add instruction. No send is automatically retried or restored.

An isolated native Firefox 156.0.1 probe exercised the actual helper from a
temporary extension in fresh profiles, using loopback synthetic origins and
synthetic login cookies while blocking external traffic. Its real button
received trusted activation and granted access. A child-initiated reload
included the synthetic cookie on the HTML request; hiding the iframe retained
the grant. A new document reactivated an existing grant and reloaded correctly.
Assigning the iframe URL from the parent lost active access, which is why the
implementation avoids parent navigation and reparenting. Evidence:
`dist/youtube-1.23.0/firefox-access-probe/helper-result.json`,
`helper-result-isolated-profile-IdzgaI.json`, and `helper-setup.png`. The screenshot
was visually inspected. The exact tested helper SHA-256 is
`6953455a58119e7bddf6d4f610713fe3155720ce3de0d9b163bfd16cd7469ddf`.

This proves the native browser mechanism, not actual YouTube delivery. Automation
of the owner's Firefox was blocked by the computer tool's browser URL-enforcement
policy. No alternative interface was used to bypass that restriction. The final
live test requires the owner to reload the temporary extension, refresh the host
with ETP on, approve setup, check the account, select YouTube and send to their
own live channel. No real message was sent during this follow-up.

Files changed for this follow-up (previous YouTube and issue fixes are retained):

- Runtime: `src/content/youtube-access.js` (new),
  `src/background/youtube-relay.js`, `src/content/youtube-source.js`,
  `src/content/youtube-reader.js`, `src/content/youtube-controls.js`,
  `src/content/overlay.js`.
- Tests: `tests/youtube-storage-access.test.js` (new),
  `tests/youtube-send-transport.test.js`, `tests/youtube-transport.test.js`,
  `tests/youtube-controls.test.js`, `tests/youtube-sending-ui.test.js`,
  `tests/youtube-send-browser.js`, `tests/youtube-permission.test.js`,
  `tests/run.js`, `tests/release-coverage.js`.
- Documentation: `README.md`, `PRIVACY.md`, this report, and locally ignored
  `docs/handoff/28_YOUTUBE_NATIVE_SENDING.md`. Ignore rules are unchanged.
- Generated output: the existing Chrome/Firefox unpacked trees and local package
  directories under `dist/youtube-1.23.0/`, plus ignored validation artifacts.

No new extension permission, storage key, identity, backup field, dependency,
global privacy setting or server was introduced. The helper reads permission
states only; it does not read cookie/token values. This remains local and
unreleased. Live YouTube behavior, other Firefox versions/privacy combinations,
and future YouTube layout changes remain practical limitations.

Final verification (artifact paths relative to `dist/youtube-1.23.0/`):

- Baseline `node tests/run.js`: **3361 passed, 0 failed**;
  `firefox-access-baseline.txt`. Final run after the last runtime change:
  **3362 passed, 0 failed**, `firefox-access-full-tests.txt`.
- `node tests/run.js youtube`, `node tests/youtube-storage-access.test.js`,
  `node tests/youtube-controls.test.js`, `node tests/youtube-sending-ui.test.js`,
  `node tests/youtube-permission.test.js`: passed. Local tests followed every
  update. An initial full run caught the old documentation assertion claiming
  no additional permission of any kind; it now distinguishes extension permission
  from explicit site storage access and checks the ETP/consent explanation.
- `node tests/youtube-send-transport.test.js --coverage`: complete-source relay
  **298/298 lines, 34/34 functions, 432/432 V8 ranges**; source **251/251,
  32/32, 256/256**; reader **128/128, 21/21, 143/143**. The helper is
  **91/91 lines, 14/14 functions, 95/95 V8 ranges** in combined coverage.
- `node tests/youtube-send-browser.js dist/youtube-1.23.0/firefox-access-send-browser`
  and `node tests/youtube-browser.js dist/youtube-1.23.0/firefox-access-merged-browser`:
  passed both host layouts in Chrome and simulated Firefox modes. Checks include
  trusted setup/cancel actions, failed state, unchanged drafts/targets, normal
  sends and existing duplicate/status/badge regressions.
- `node tests/youtube-options-browser.js dist/youtube-1.23.0/firefox-access-options-browser`,
  `node tests/youtube-onboarding-browser.js dist/youtube-1.23.0/firefox-access-onboarding-browser`,
  and `node tests/open-issues-browser.js dist/youtube-1.23.0/firefox-access-issues-browser`:
  all passed. These browser fixtures block external traffic and are not native
  Firefox or live YouTube tests.
- `node tests/release-coverage.js dist/youtube-1.23.0/firefox-access-node-coverage.json dist/youtube-1.23.0/firefox-access-send-browser/browser-coverage.json dist/youtube-1.23.0/firefox-access-merged-browser/browser-coverage.json dist/youtube-1.23.0/firefox-access-options-browser/browser-coverage.json dist/youtube-1.23.0/firefox-access-onboarding-browser/browser-coverage.json dist/youtube-1.23.0/firefox-access-issues-browser/browser-coverage.json`:
  **1976/1976 lines, 267/267 functions, 2102/2102 V8 ranges**, across 25 new/changed
  JavaScript files. This is not whole-repository coverage. The exact-source guard
  rejected stale browser evidence after a lifecycle fix; the affected harness was
  rerun and the final command passed. Log: `firefox-access-coverage.txt`.
- All five commands in Final local packages were rerun successfully after the
  last runtime change. Both unpacked trees and all packages contain 59 files;
  current hashes are recorded above. The Firefox lint command also passed again:
  **0 errors, 0 notices, 22 existing warnings**, `firefox-access-firefox-lint.txt`.
- `node --check` for affected JavaScript, `git diff --check`,
  `node tests/release-coverage.js --self-test` and `node tests/run.js repo`:
  passed. Repository checks after documentation updates: **14/0**.
- Independent final review found no remaining actionable issue. Review-driven
  regressions cover old-port readiness, cancellation while approval is pending,
  permission-check cleanup, exhausted reload failures and a late timeout racing
  replacement readiness. Capture remains alive through sender-only failures.

Unrun checks: actual YouTube delivery in the owner's Firefox with ETP on, other
native Firefox versions/privacy combinations, signed installation and store
validation. No commit, push, merge, tag, signing, upload, release, worker action,
browser-wide privacy change or production configuration change occurred.

## Firefox message deletion

The owner reported Backspace could not delete typed text on either Twitch or
Kick in Firefox. The actual editor and overlay reproduced this in fresh Firefox
156.0.1 profiles with loopback fixtures and external traffic blocked. With the
shadow host directly under HTML, typing `hello` worked, but Backspace and selected
deletion left it unchanged. Events were trusted and not default-prevented;
Firefox emitted beforeinput but performed no edit. Moving that same host under
BODY immediately restored native deletion. This matches Mozilla's
[editing-outside-body defect](https://bugzilla.mozilla.org/show_bug.cgi?id=1634351).

`overlay.js` now resolves the page parent through a shared helper: Firefox uses
the current body, falling back to HTML only when no body exists; Chrome retains
its HTML parent. Initial mount and return from a popup use the same rule. The
same shadow host, draft and geometry are preserved. No keyboard interception,
synthetic deletion, new permission, storage change or sending change was added.

Final native Firefox tests use the actual current overlay source, SHA-256
`8da920d0c914e98c052eed3784db4002719a07c068b7ab06347ca3fc7cddcb84`.
Both host layouts passed trusted Backspace, forward Delete, Ctrl+A followed by
Backspace/Delete, selected replacement typing, text adjacent to rendered emotes,
whole-emote deletion, editing in a native popup and editing after its return.
The host was inside BODY before and after popup use. Panel geometry was identical
after return: Twitch `(1025,51,341,632)`, Kick `(1026,51,340,632)`.

Native diagnostic commands:

```text
node --check dist/youtube-1.23.0/firefox-input-probe/run-probe.js
node dist/youtube-1.23.0/firefox-input-probe/run-probe.js
```

Both passed. Reproduction evidence is under `firefox-input-probe/` in
`result-isolated-profile-nWegSv.json` and `result-isolated-profile-mm5Mk3.json`;
final evidence is `result-isolated-profile-MfejTa.json` and `editor.png` (visually
inspected). These are real Firefox engine tests using synthetic local pages,
not the owner's signed-in live browser. No message was sent.

Files changed for this follow-up:

- Runtime: `src/content/overlay.js` only.
- Tests: `tests/youtube-sending-ui.test.js`, `tests/youtube-send-browser.js`,
  `tests/issue-fixes.js`. The last supplies the new parent helper dependency to
  an older isolated popup fixture; real helper behavior is tested through the
  full overlay source in the first suite.
- Documentation: this report and locally ignored
  `docs/handoff/01_PRODUCT_AND_FEATURES.md`. Ignore rules remain unchanged.
- Generated local Chrome/Firefox trees, packages and diagnostic artifacts under
  the existing ignored `dist/youtube-1.23.0/` directory.

Validation:

- Baseline `node tests/run.js`: **3362 passed, 0 failed**;
  `backspace-baseline.txt`. The first final run identified the missing helper
  dependency in the older popup fixture; `node tests/run.js issuefixes` passed
  after that fixture update. Final full suite: **3362 passed, 0 failed**;
  `backspace-full-tests.txt`.
- `node tests/youtube-sending-ui.test.js`: passed Chrome/Firefox × Twitch/Kick ×
  body-present/missing, popup button/closure/pagehide return, replaced body,
  already-docked host, preserved draft, and no resurrection after destruction.
  A read-only in-memory mutation restoring the old parent failed the regression.
- `node tests/run.js emoteinput`: **23/0**; `node tests/run.js compose`: **73/0**.
- All five browser commands from the previous section passed again, replacing
  `firefox-access-` in their output paths with `backspace-`. The send browser
  fixture now checks actual Backspace, Delete and selected draft deletion,
  correct browser parent, and zero sends caused by editing. Its initial Firefox
  parent assertion failed before the fix; Chrome checks already passed.
- `node tests/release-coverage.js dist/youtube-1.23.0/backspace-node-coverage.json dist/youtube-1.23.0/backspace-send-browser/browser-coverage.json dist/youtube-1.23.0/backspace-merged-browser/browser-coverage.json dist/youtube-1.23.0/backspace-options-browser/browser-coverage.json dist/youtube-1.23.0/backspace-onboarding-browser/browser-coverage.json dist/youtube-1.23.0/backspace-issues-browser/browser-coverage.json`:
  **1982/1982 lines, 268/268 functions, 2107/2107 V8 ranges** across all new/changed
  JavaScript. Overlay changed coverage is **125/125 lines, 16/16 functions,
  143/143 ranges**. This is not whole-repository coverage. All source matches are
  exact; no padded source is credited. Log: `backspace-coverage.txt`.
- All five local build/package verification commands in Final local packages
  passed. Both unpacked trees and 59-file packages are current; hashes are above.
  Firefox lint passed: **0 errors, 0 notices, 22 existing warnings**;
  `backspace-firefox-lint.txt`.
- Local tests ran after every update. Syntax, repository checks and independent
  review passed. The final review found no actionable issue in mount, docking,
  draft preservation, teardown or browser compatibility.

The owner still needs to reload the temporary Firefox add-on and refresh both
live pages. Live site layouts and body transforms remain unverified; the local
fixtures establish unchanged normal placement and popup geometry. No commit,
push, signing, release, upload or production action occurred. The earlier live
YouTube sending verification remains a separate outstanding check.

## Red YouTube send target

The owner confirmed the Firefox deletion fix and requested a red highlight when
YouTube is selected for sending, matching Twitch/Kick. The target already tracked
selection correctly but lacked its platform-specific CSS rule. It now uses a red
label, border and background tint, with readable dark/light palettes. Deselecting
it returns it to neutral gray. Sending, readiness and account consent are unchanged.

Changed files: `src/content/overlay.css`, `tests/youtube-sending-ui.test.js`,
`tests/youtube-send-browser.js`, this report, and locally ignored
`docs/handoff/28_YOUTUBE_NATIVE_SENDING.md`. Generated artifacts remain under the
existing ignored `dist/youtube-1.23.0/` paths. No runtime JavaScript changed.

- Baseline and final `node tests/run.js`: **3362 passed, 0 failed**;
  `youtube-target-color-baseline.txt`, `youtube-target-color-full-tests.txt`.
- `node tests/youtube-sending-ui.test.js`: new style/variable regression failed
  before the CSS fix and passed after it. Existing behavior tests remain intact.
  Local tests followed every file update.
- `node tests/youtube-send-browser.js dist/youtube-1.23.0/youtube-target-color-browser`:
  passed both host layouts in Chrome and simulated Firefox modes, checking the
  actual computed label/background/border in both themes and neutral deselection.
  All nine new CSS declarations are exercised. Existing send/editing tests pass.
  Dark/light target-row screenshots were visually inspected; the selected red
  highlight matches Twitch/Kick's existing treatment. External traffic was blocked.
- `node tests/release-coverage.js dist/youtube-1.23.0/youtube-target-color-node-coverage.json dist/youtube-1.23.0/youtube-target-color-browser/browser-coverage.json dist/youtube-1.23.0/backspace-merged-browser/browser-coverage.json dist/youtube-1.23.0/backspace-options-browser/browser-coverage.json dist/youtube-1.23.0/backspace-onboarding-browser/browser-coverage.json dist/youtube-1.23.0/backspace-issues-browser/browser-coverage.json`:
  **1982/1982 lines, 268/268 functions, 2107/2107 V8 ranges** across new/changed
  JavaScript. Unchanged JavaScript browser evidence passed the exact-source gate.
  This is not whole-repository coverage or a V8 measurement of CSS; CSS is verified
  by the selected/deselected theme matrix above. Log: `youtube-target-color-coverage.txt`.
- All five build/package verification commands in Final local packages passed;
  both unpacked trees and 59-file packages are current. Hashes are recorded above.
  The offline Firefox lint command passed with **0 errors, 0 notices, 22 existing
  warnings**; `youtube-target-color-firefox-lint.txt`.
- Syntax, `git diff --check`, and `node tests/run.js repo` passed (repository:
  **14/0**). Independent final CSS/test review found no actionable issue.

No live messages, native Firefox recolor check, release, upload, signing, commit
or external setting change occurred. The user must reload the extension and
refresh existing Twitch/Kick tabs to receive the updated stylesheet.

## Sent-message recall with Up/Down

The composer now recalls recent sent text with Up (older) and Down (newer, then
back to the saved draft). Enter or Send is still required to send, using current
routing and validation. The per-overlay history holds 50 texts, collapses
consecutive duplicates, survives popup/dock moves and is discarded on destroy.
It contains accepted/submitted sends, including partial success, but excludes
all-failed sends, uncertain YouTube submissions, unconfirmed Cheers and all paid
Cheer text. YouTube submission still does not establish server delivery.
Autocomplete has priority. Modifiers, IME composition, active replies and pending
sends do not browse history. Edits restart browsing with that edit as the draft.
Old destinations and reply IDs are never recalled. No storage key or permission
was introduced, and no send transport changed.

Changed for this request: `src/content/overlay.js`,
`tests/youtube-sending-ui.test.js`, `tests/youtube-send-browser.js`, `README.md`,
`PRIVACY.md`, this report, and locally ignored
`docs/handoff/01_PRODUCT_AND_FEATURES.md`. Existing unrelated working changes
were preserved. Before/after snapshots and generated evidence are under the
ignored `dist/youtube-1.23.0/` directory; exclusions were not changed.

Validation:

- Baseline and final `node tests/run.js`: **3362 passed, 0 failed**, including the
  expanded composer unit assertions. Logs: `history-baseline.txt` and
  `history-full-tests.txt`. `node tests/youtube-sending-ui.test.js` passed after
  the runtime update and final test update. Repository checks followed each
  documentation update: `node tests/run.js repo`, **14 passed, 0 failed**.
- `node --check src/content/overlay.js`, `node --check tests/youtube-sending-ui.test.js`,
  `node --check tests/youtube-send-browser.js`,
  `node tests/release-coverage.js --self-test` and `git diff --check` passed.
- With the existing `FCM_PLAYWRIGHT_PATH`, the following passed against current
  source, with all external requests blocked:
  `node tests/youtube-send-browser.js dist/youtube-1.23.0/history-send-browser`,
  `node tests/youtube-browser.js dist/youtube-1.23.0/history-merged-browser`,
  `node tests/youtube-options-browser.js dist/youtube-1.23.0/history-options-browser`,
  `node tests/youtube-onboarding-browser.js dist/youtube-1.23.0/history-onboarding-browser`,
  `node tests/open-issues-browser.js dist/youtube-1.23.0/history-issues-browser`.
  These run installed Chrome with Chrome and simulated Firefox branches. The
  sending harness verifies real keys, autocomplete priority, draft restoration,
  emote/Unicode recall, editing, explicit resend and consecutive deduplication.
- Native **Firefox 156.0.1** also passed trusted keyboard checks on both synthetic
  host layouts: older/newer history, draft recovery, emotes, recalled Backspace,
  explicit resend, duplicate collapsing and history inside a popup. Command:
  `node dist/youtube-1.23.0/firefox-history-probe/run-probe.js`.
  Evidence: `firefox-history-probe/result-isolated-profile-a3peCo.json` and
  `history-native-firefox.txt`. This used a fresh isolated profile and a local
  rejecting proxy; the user's Firefox profile was not accessed. The first probe
  exposed the harness's no-op Kick send callback; the probe now supplies the
  same synthetic acknowledgement as Twitch. No runtime fix was needed. Browser
  shutdown logs include a feed timer termination and Firefox internal warnings;
  every final probe assertion passed.
- `node tests/release-coverage.js dist/youtube-1.23.0/history-node-coverage.json dist/youtube-1.23.0/history-send-browser/browser-coverage.json dist/youtube-1.23.0/history-merged-browser/browser-coverage.json dist/youtube-1.23.0/history-options-browser/browser-coverage.json dist/youtube-1.23.0/history-onboarding-browser/browser-coverage.json dist/youtube-1.23.0/history-issues-browser/browser-coverage.json`
  passed the exact-source gate: **2015/2015 executable lines, 270/270 functions,
  2157/2157 V8 ranges** across new/changed JavaScript. Overlay changed coverage is
  **158/158 lines, 18/18 functions, 193/193 ranges**. This is changed/new-code
  coverage, not whole-repository coverage. Log: `history-coverage.txt`.
- Builds passed:
  `node tools/pack.js --unpacked dist/youtube-1.23.0/chrome --target chrome`,
  `node tools/pack.js --unpacked dist/youtube-1.23.0/firefox --target firefox`,
  `node tools/pack.js dist/youtube-1.23.0/packages --target all`,
  `node tools/release.js verify-packages dist/youtube-1.23.0/packages 1.23.0`,
  `node tools/pack.js dist/youtube-1.23.0/chrome-store --target chrome-store`.
  Both unpacked overlays match tested source SHA-256
  `9fe2ca974e1e4b1c08503d2a7da6782612a192cdbe020239996d0325c7d70fc5`.
- `npx --offline --yes web-ext@8.10.0 lint --source-dir dist/youtube-1.23.0/firefox --self-hosted --no-config-discovery`
  passed with **0 errors, 0 notices, 22 existing warnings**.
- Final review of the task-only source, unit/browser tests and documentation diff
  found no actionable issue. Reply scope, current destination selection, bounded
  memory, teardown, asynchronous draft preservation and uncertain/Cheer behavior
  were checked. No dependency, identity, permission or storage-contract change.

Current 59-file package SHA-256 values, superseding earlier package hashes:

- Chrome ZIP: `9d379d8f3d59f2d3a1b01bf989fdd50514266ed90bafa86dc57131e02468f4f7`
- Firefox unsigned XPI: `12d358bc11224a8e3fe3820589c20250c88ffc6f1fcf1c42330ce3d0b8fb1ef0`
- Chrome Store ZIP: `25140d18c541cf7d92f29cee3d9a13ec7cc9a89457fe3917763c6592032b62fd`

No live messages, release, upload, signing, commit or external configuration change
was performed. Live platform delivery was not retested for this text-only feature.
Reload the local extension and refresh existing Twitch/Kick tabs to activate it.

## Kick dashboard activation with the live /stream exception

Kick's site matcher accepted every kick.com subdomain and parsed dashboard path
segments as channel names. Activation now accepts public kick.com/www.kick.com
and dashboard.kick.com, with dashboard channel detection restricted to exactly
`/stream` or `/stream/` (query/fragment allowed). All other dashboard routes are
excluded, including all 16 distinct URLs reported by the owner. `/channel/stream`
is excluded; `/stream` is explicitly preserved per the owner's clarification.
Navigation polling remains active on the dashboard so visiting `/stream` mounts
the overlay and leaving it destroys the overlay, disconnects chat and cancels
channel-specific timers. Public channel/popout behavior and the existing
`/stream` channel resolution remain unchanged. This patch does not redesign
creator account/channel discovery or validate live dashboard message delivery.

Changed for this request: `src/content/sites.js`, `tests/issue-62.test.js`,
`tests/open-issues-browser.js`, `README.md`, this report, and locally ignored
`docs/handoff/01_PRODUCT_AND_FEATURES.md`. No privacy/data-flow contract changed.
Existing working changes were preserved; ignored handoffs/artifacts were not
force-added. No permission, identity, storage, dependency or transport change.

Validation and commands:

- Baseline and final `node tests/run.js`: **3362 passed, 0 failed**. Logs:
  `dist/youtube-1.23.0/dashboard-baseline.txt` and
  `dist/youtube-1.23.0/dashboard-final-full-tests.txt`.
- `node tests/issue-62.test.js`: regression failed against the old matcher and
  passes with the final change. Covers every excluded URL, unknown future paths,
  exact `/stream` variants, public hosts/channels/popouts, service/lookalike hosts,
  direct loads and SPA entry/exit/return in Chrome and Firefox modes. Excluded
  pages open no chat session or discovery/watch timers; leaving `/stream`
  destroys the overlay and disconnects its session.
- `node tests/run.js sites`: **28/0**; `node tests/run.js authpages`: **57/0**;
  `node tests/run.js repo`: **14/0** after documentation edits. Local tests ran
  after each source/test update, including the owner's `/stream` clarification.
- `node --check src/content/sites.js`, `node --check tests/issue-62.test.js`,
  `node --check tests/open-issues-browser.js`, `git diff --check` and
  `node tests/release-coverage.js --self-test`: passed.
- Using the existing `FCM_PLAYWRIGHT_PATH`, all five browser commands passed:
  `node tests/open-issues-browser.js dist/youtube-1.23.0/dashboard-final-issues-browser`,
  `node tests/youtube-send-browser.js dist/youtube-1.23.0/dashboard-final-send-browser`,
  `node tests/youtube-browser.js dist/youtube-1.23.0/dashboard-final-merged-browser`,
  `node tests/youtube-options-browser.js dist/youtube-1.23.0/dashboard-final-options-browser`,
  `node tests/youtube-onboarding-browser.js dist/youtube-1.23.0/dashboard-final-onboarding-browser`.
  The dashboard fixture runs real site detection and boot scripts with synthetic
  overlay/port objects at intercepted URLs. Every reported page is checked on
  direct load and after SPA travel through `/stream`. No real Kick request is
  served. Browser engine: installed Chrome, including simulated Firefox mode;
  native Firefox/live dashboard behavior was not separately exercised here.
- `node tests/release-coverage.js dist/youtube-1.23.0/dashboard-final-node-coverage.json dist/youtube-1.23.0/dashboard-final-send-browser/browser-coverage.json dist/youtube-1.23.0/dashboard-final-merged-browser/browser-coverage.json dist/youtube-1.23.0/dashboard-final-options-browser/browser-coverage.json dist/youtube-1.23.0/dashboard-final-onboarding-browser/browser-coverage.json dist/youtube-1.23.0/dashboard-final-issues-browser/browser-coverage.json`:
  **2017/2017 executable lines, 271/271 functions, 2161/2161 V8 ranges** across
  new/changed JavaScript; sites.js **8/8 lines, 5/5 functions, 8/8 ranges**.
  This is not whole-repository coverage. The first browser fixture response
  lacked an explicit UTF-8 encoding; the exact-source gate caught it. UTF-8 is
  now explicit and the rerun passed. Log: `dashboard-final-coverage.txt`.
- Builds and package verification passed:
  `node tools/pack.js --unpacked dist/youtube-1.23.0/chrome --target chrome`,
  `node tools/pack.js --unpacked dist/youtube-1.23.0/firefox --target firefox`,
  `node tools/pack.js dist/youtube-1.23.0/packages --target all`,
  `node tools/release.js verify-packages dist/youtube-1.23.0/packages 1.23.0`,
  `node tools/pack.js dist/youtube-1.23.0/chrome-store --target chrome-store`.
  Both unpacked site adapters match tested source byte for byte.
- `npx --offline --yes web-ext@8.10.0 lint --source-dir dist/youtube-1.23.0/firefox --self-hosted --no-config-discovery`:
  **0 errors, 0 notices, 22 existing warnings**; `dashboard-final-firefox-lint.txt`.
- Final source/test/documentation review found no actionable issue. Exact host
  matching, exact dashboard path exception, public-channel preservation and SPA
  teardown/reentry were checked. No release, signing, upload, live chat message,
  commit or external configuration change occurred.

Current package SHA-256 values (supersede earlier local package hashes):

- Chrome ZIP: `7d3b7a719dd39165fcf37380b8680444148a16310a305218e1712802132f0607`
- Firefox unsigned XPI: `fa628a1638c40b85724e95d0ada98065408e740d07087372b38bf445009646f1`
- Chrome Store ZIP: `696ceae96161b7430f7a05bf5cc0a53430ca36e9368d9f8dc4e13e9adc4ccbba`

Reload the local extension and refresh existing Kick/dashboard tabs to replace
content scripts already running from the previous build.

## Twitch and Kick top-right notification protection

Short native notifications now reserve space independently of the optional
"Leave room for site's cards" setting. Stacked notifications remain clickable
when native chat is hidden. Both automatic and manually moved/resized panels
give notifications priority over their minimum height, then recover their saved
position and size after dismissal. Temporary adjustments are not persisted.
Existing notification selectors, position/size filters and the 500 ms placement
tick remain in use; notifications are never clicked or redeemed automatically.

Changed for this request: `src/content/native.js`, `src/content/overlay.js`,
`tests/issue-63.test.js`, `tests/youtube-sending-ui.test.js`,
`tests/open-issues-browser.js`, `README.md`, this report, and locally ignored
`docs/handoff/01_PRODUCT_AND_FEATURES.md`. Existing working changes were
preserved. No permissions, identities, storage schema, dependencies, privacy
contract or release channel changed. Ignored handoffs were not force-added.

Validation:

- Baseline and final `node tests/run.js`: **3362 passed, 0 failed**. Logs:
  `dist/youtube-1.23.0/toast-baseline.txt` and `toast-full-tests.txt`.
- Local checks ran after each source/test/documentation update.
  `node tests/issue-63.test.js`, `node tests/youtube-sending-ui.test.js`,
  `node tests/run.js native` (133/0), `node tests/run.js issuefixes` (1/0),
  and `node tests/run.js repo` (14/0) passed. Cases include highlights off,
  stacked/dismissed notices, hidden native chat, unrelated elements, collapsing
  notification geometry, minimum-height override and exact geometry restoration.
- `node --check src/content/native.js`, `node --check src/content/overlay.js`,
  `node --check tests/issue-63.test.js`, `node --check tests/open-issues-browser.js`,
  `node tests/release-coverage.js --self-test` and `git diff --check` passed.
- All five isolated browser commands passed using the existing Playwright:
  `node tests/youtube-send-browser.js dist/youtube-1.23.0/toast-send-browser`,
  `node tests/youtube-browser.js dist/youtube-1.23.0/toast-merged-browser`,
  `node tests/youtube-options-browser.js dist/youtube-1.23.0/toast-options-browser`,
  `node tests/youtube-onboarding-browser.js dist/youtube-1.23.0/toast-onboarding-browser`,
  `node tests/open-issues-browser.js dist/youtube-1.23.0/toast-final-issues-browser`.
  Actual overlay/native bridge code was exercised for both sites, highlights
  on/off, stacked notices, trusted dismiss clicks, manual placement and a panel
  resized to 180 pixels. Screenshots are in the last output directory.
  Tests use installed Chrome with Chrome and simulated Firefox modes; native
  Firefox and live platform notification markup were not exercised here.
- `node tests/release-coverage.js dist/youtube-1.23.0/toast-node-coverage.json dist/youtube-1.23.0/toast-send-browser/browser-coverage.json dist/youtube-1.23.0/toast-merged-browser/browser-coverage.json dist/youtube-1.23.0/toast-options-browser/browser-coverage.json dist/youtube-1.23.0/toast-onboarding-browser/browser-coverage.json dist/youtube-1.23.0/toast-final-issues-browser/browser-coverage.json`
  passed: **2029/2029 executable lines, 272/272 functions, 2168/2168 V8 ranges**
  across new/changed JavaScript, not whole-repository coverage. Native bridge:
  11/11 lines, 2/2 functions, 11/11 ranges; overlay: 165/165, 18/18, 197/197.
  Exact source matching passed. Log: `toast-coverage.txt`.
- Local builds and verification passed:
  `node tools/pack.js --unpacked dist/youtube-1.23.0/chrome --target chrome`,
  `node tools/pack.js --unpacked dist/youtube-1.23.0/firefox --target firefox`,
  `node tools/pack.js dist/youtube-1.23.0/packages --target all`,
  `node tools/release.js verify-packages dist/youtube-1.23.0/packages 1.23.0`,
  `node tools/pack.js dist/youtube-1.23.0/chrome-store --target chrome-store`.
  Both unpacked builds' native bridge and overlay match tested source byte for byte.
- `npx --offline --yes web-ext@8.10.0 lint --source-dir dist/youtube-1.23.0/firefox --self-hosted --no-config-discovery`:
  **0 errors, 0 notices, 22 existing warnings** (`toast-firefox-lint.txt`).
- Final source/test/documentation review found no actionable issue. Existing
  structural-card settings, native menu behavior and stored geometry are
  preserved. Protection applies to recognized short notices overlapping the
  upper chat area; future site markup changes may require adapter updates.
  No live message, commit, upload, signing, release or external change occurred.

Current package SHA-256 values (supersede earlier local hashes):

- Chrome ZIP: `bd9d495cc2190716063452cc271c0366d2d16a502bfbe6a478b8aaa6737657b0`
- Firefox unsigned XPI: `a472802177b3002f5294beca3a4dbc4800162c62bef3d06e17a69c08b8728c48`
- Chrome Store ZIP: `d4ace9bcd526e4644744a61e4d51173a2b163588bf1997f4079e9b7b64c0bb7b`

Reload the local extension and refresh Twitch/Kick tabs to activate the fix.
