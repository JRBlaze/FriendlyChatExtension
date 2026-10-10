# Prominent mention and keyword highlights

October 9, 2026. Local implementation on `codex/issue-77-emote-availability`.
Earlier issue fixes, the quick-start guide, and existing user files were retained.

## Result

Incoming messages matching the viewer's configured highlight names/words now
have a red-tinted full row, a 3px left edge and 1px right edge, a **HIGHLIGHTED**
label on its own line, and stronger matching-text styling. The supplied image
guided the appearance. The generic label works for keywords as well as names.
Both dark and light themes are supported, with no flashing, sound or notification
permission. Highlight styling remains visible on hover.

Connected Twitch/Kick usernames are included automatically from the account
summary the overlay already receives. They stay in memory, do not change the
saved `highlightNames` list, and are rebuilt on account changes or cleared on
host navigation. YouTube's existing sending-identity matching remains intact.
Custom entries still use the existing **Highlight these names** setting.
Names/words are deduplicated and longest matches come first so a short configured
word cannot prevent a longer connected username from matching.

Existing case-insensitive word boundaries, escaped text/regex inputs, emote/link
exclusions, and the own-message full-row exemption remain. This updates newly
rendered live/history messages; changes to account names or the word list do not
rescan older DOM rows. The label is outside `.fcm-body`, preserving the existing
body-only copy path and author/reply/moderation handling.

Name-color lightness is adjusted against the actual highlighted background for
both themes while retaining hue. Ordinary rows use their original backdrops.
The matched text and label use theme-specific red palettes. Highlighted rows
retain `content-visibility` and a larger intrinsic-size estimate for the extra
label line; no feed timer, observer, cap or routing changes were made.

## Changed files for this request

| File | Purpose |
| --- | --- |
| `src/content/render.js` | Transient account-name matching, deduplication/order, highlight label and row-aware author colors. |
| `src/content/overlay.js` | Forward account summaries to the current renderer matcher. |
| `src/content/overlay.css` | Stronger row/text highlights, red edges, label line and dark/light palettes. |
| `tests/mention-highlight.test.js` | Real-source matching/row, identity lifecycle, escaping, self-message and overlay-wiring regressions. |
| `tests/mention-highlight-browser.js` | Real stylesheet/renderer/feed, both themes, responsive layout, contrast and pinned scrolling. |
| `tests/run.js` | Register the new regression suite. |
| `tests/youtube-sending-ui.test.js` | Observe the new account-summary forwarding in the existing isolated overlay fixture. |
| `README.md` | Explain highlighting, automatic names and the existing custom-name/word setting. |
| `PRIVACY.md` | Document transient names without new lookups, storage or notifications. |
| `docs/mention-highlight-validation.md` | This review and verification record. |
| `docs/handoff/48_PROMINENT_MENTION_HIGHLIGHTS.md` | Local handoff supplement, ignored under existing exclusions. |

## Checks and evidence

- Baseline `node tests/run.js`: **3378 passed, 0 failed**.
- `node tests/run.js mentionhighlight`: passed after updates. Covers Twitch,
  Kick and YouTube; username/custom-word/phrase matches; no substring/link/emote
  false positives; self-post exemption; escaped markup; automatic names without
  preference writes; settings changes; missing/disconnected/malformed accounts;
  navigation cleanup; existing YouTube identity; color input handling and actual
  overlay account forwarding. The first new assertion failed on the original
  renderer because no highlight label existed.
- `node tests/run.js render`: **190 passed, 0 failed**. Targeted `youtube` and
  `repo` suites and the existing overlay UI fixture also passed after edits.
- Full `node tests/run.js`: **3379 passed, 0 failed**; assertions inside separately
  required suites are not included in the legacy runner's count.
- `FCM_EMOTE_COVERAGE=<absolute-output.json> node -r ./tests/emote-availability-coverage.js tests/run.js`
  collected actual full VM sources. `node tests/emote-availability-coverage.js dist/mention-highlights/full-coverage.json`
  passed the current Git-diff/new-runtime gate: **298/298 executable lines,
  60/60 functions and 343/343 V8 ranges (100%)** across this work and the preserved
  earlier changes. This is new/changed runtime coverage, not repository-wide
  or CSS coverage. Full output/report live under `dist/mention-highlights/`.
- `FCM_PLAYWRIGHT_PATH=<bundled-path> node tests/mention-highlight-browser.js dist/mention-highlights/browser`:
  Chrome and simulated Firefox passed dark/light themes, 320px width, 10/14/22px
  text, separate label/body lines, ordinary vs highlighted rows, body-only copy
  source, and pinned scrolling with 100 highlighted messages. The existing
  contrast auditor reported no failures at the default 96% opacity, including
  custom author colors, action text, timestamps, matched words, the highlight
  label and the first-message tag. All external requests were blocked; no page
  errors occurred. Desktop dark/light and narrow screenshots were reviewed.
- `node --check <file>` and `git diff --check`: passed.
- `node tools/pack.js dist/mention-highlights/packages --target all`: both local
  packages built, **67 files each**.
- `node tools/release.js verify-packages dist/mention-highlights/packages 1.23.5`:
  **all good**. Packages retain the source version and are validation artifacts.

## Review and limits

Reviewed the final diff for source matching, own-post behavior, account changes,
escaping, permissions, storage/backups, accessibility, row sizing/scrolling,
copy/reply/moderation interfaces, both browser load paths and unintended changes.
No dependency, identity, permission, OAuth scope, storage key, backup format,
manifest version, worker, send route or external configuration changed. Connected
names come from existing sanitized summaries; tokens never enter these additions.

Native Firefox and live Twitch/Kick/YouTube pages were not newly tested. The
Firefox browser mode uses an isolated Chrome context, not Firefox's native UI.
No real chat, account sign-in, moderation, permission grant, extension reload,
commit/push, release, signing, store submission or deployment was performed.
The new handoff file remains locally ignored; no exclusion or force-add changed.
