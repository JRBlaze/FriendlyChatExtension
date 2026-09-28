# Copy-message validation - September 28, 2026

Implemented locally on `codex/issues-67-68`, HEAD
`e2581ab19108d5d7368a4c6585a691f78174ab56`. All earlier issue #67/#68 and YouTube
reply/emote/parity changes are preserved. Nothing was committed or published.

## Behavior

Right-click a message in the merged Twitch, Kick or YouTube feed and choose
**Copy message**, then paste normally in the destination chat/app. The action is
also available from the existing Twitch/Kick author menu. Ordinary YouTube name
clicks still prepare replies.

Copies only the rendered message body. Username, timestamp, badges, reply quote
and paid-event headings are excluded. Mentions and links inside the message,
spacing, newlines, Unicode and literal markup remain text; emotes contribute
names. Cheer counts and hidden GIF labels are not duplicated. Copy preserves
the draft and does not send, paste, change reply targets, or require moderator
standing. Empty/deleted messages are disabled and a deletion after opening the
menu is rechecked. Success is shown only after the clipboard write resolves;
missing/denied clipboard access reports a manual-copy alternative.

## Validation

Baseline and final `node tests/run.js`: **3,365 passed, 0 failed**, exit 0.
Logs: temporary `fcm-copy-baseline.log` and `fcm-copy-full.log`.

| Command | Final result |
| --- | --- |
| `node tests/youtube-view.test.js` | All assertions passed, including all three platforms and clipboard errors |
| `node tests/run.js compose` | 73 passed, 0 failed |
| `node tests/run.js repo` | 14 passed, 0 failed after documentation updates |
| `node --check src/content/compose.js` | Passed |
| `node --check tests/youtube-view.test.js` | Passed |
| `node --check tests/youtube-browser.js` | Passed |
| `git diff --check` | Clean |
| `node tests/youtube-browser.js dist/copy-message/view-browser` | Passed, Chrome and simulated Firefox branches on Twitch and Kick layouts |
| `node tests/youtube-send-browser.js dist/copy-message/send-browser` | All four mode/host combinations passed |
| `node tests/youtube-options-browser.js dist/copy-message/options-browser` | Both modes passed |

Browser commands use the existing bundled Playwright through
`FCM_PLAYWRIGHT_PATH`. They run installed Chrome against local fixtures and block
external requests. Actual DOM right-clicks and menu buttons copy exact body-only
payloads, including rendered/fallback emotes, with unchanged drafts and no send
or moderation commands. Existing Twitch/Kick menu profile lookups remain.
The clipboard method is stubbed to capture its argument: these checks do not
write to the user's system clipboard or establish live OS permission behavior.
The compact menu screenshot was visually checked.

Coverage command:

```text
node tests/release-coverage.js --changed-only dist/copy-message/node-coverage.json dist/copy-message/send-browser/browser-coverage.json dist/copy-message/view-browser/browser-coverage.json dist/copy-message/options-browser/browser-coverage.json
```

Passed with **343/343 executable lines, 43/43 functions, 381/381 V8 ranges** across
the entire current JavaScript diff. Compose contributes 127/127 lines, 23/23
functions and 131/131 ranges; the other runtime files retain the parity report's
counts. This is **100% changed-JavaScript coverage**, not whole-repository
coverage. Counts include inherited uncommitted changes. No gate changes or
exclusions were added. Final browser captures match current runtime source.
The full-suite total does not include every assertion in standalone fixtures.

## Changed files in this follow-up

| File | Change |
| --- | --- |
| `src/content/compose.js` | Body text extraction, clipboard action and all-platform row context menu |
| `tests/youtube-view.test.js` | Rich-body unit fixtures, clipboard/deletion/error/routing regressions |
| `tests/youtube-browser.js` | Actual DOM copy clicks, exact payloads, draft preservation, screenshot |
| `README.md` | How to copy and paste raid messages |
| `PRIVACY.md` | User-selected clipboard write and no new persistence/send |
| `VALIDATION-copy-message.md` | This evidence record |
| `docs/handoff/32_YOUTUBE_CHAT_PARITY.md` | Follow-up pointer; locally ignored |
| `docs/handoff/33_COPY_MESSAGE.md` | Current copy contract and limits; locally ignored |

See `VALIDATION-youtube-parity.md` and its linked earlier reports for all inherited
working files. Pre-existing `AGENTS.md` and store screenshots are untouched.

## Final review and limits

Reviewed extraction order, escaping/text boundaries, missing/deleted messages,
clipboard failure, unchanged drafts/replies/sends, platform moderation gates,
existing author clicks, test fixtures, privacy and compatibility. No remaining
actionable defect was found. Extension identity, manifests, permissions, storage
keys, backup format, credentials, worker routes and versions are unchanged.
Artifacts and handoffs remain ignored; exclusions were not changed.

Native Firefox, actual OS clipboard permissions, live chats and pasting/sending
into a real destination chat were not tested. No authenticated live browser/API
actions, purchases, moderation, installs, signing, deployment, store submission,
commit or push occurred. External CI and Firefox lint were not run; the full
suite includes local package/startup regression checks.
