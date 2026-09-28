# YouTube mention replies — local implementation

Validated September 28, 2026 on Windows with Node v24.19.0.
Branch: `codex/issues-67-68`; base `e2581ab19108d5d7368a4c6585a691f78174ab56`.
This extends the existing local issue #67/#68 changes documented in
`VALIDATION-issues-67-68.md`; nothing has been committed or published.

## Behavior and cause

YouTube names were intentionally excluded from the composer candidate/reply
allowlists. Clicking a captured YouTube author now inserts an `@mention` directly,
preserves the existing draft and opens the reply bar. Typing `@` and selecting a
YouTube suggestion also prepares a reply. Repeated clicks do not duplicate the
same mention, including Unicode names and captured names beginning with `@`.

Replies go only to YouTube through the existing native sender, after a trusted
Send/Enter action. Mentions count toward the 200-character limit. These are
plain-text mentions, not native reply threads. No profile lookup or moderation
action is introduced. Twitch/Kick reply behavior remains separate.

Replies bind to the current YouTube source/account. A connection change blocks
the unfinished reply and preserves its draft until the recipient is selected
again. Removing/replacing/destroying the source clears YouTube autocomplete
candidates, and stale open suggestions cannot arm a reply. Candidates are bounded
in memory, never stored, synced or exported.

## Validation

Local tests ran after every file update. The full-suite baseline and final run
both reported **3,365 passed, zero failed**, including the registered standalone
feature suites. Their internal assertions are not individually added to that
runner count.

| Command | Result |
| --- | --- |
| `node tests/run.js` | Passed full suite |
| `node tests/youtube-view.test.js` | Passed names, Unicode, duplicate mentions, autocomplete, stale candidates, escaping and moderation boundaries |
| `node tests/youtube-sending-ui.test.js` | Passed actual-overlay routing, trusted gestures, limits, unavailable composer, source/account changes, cancellation and prior send regressions |
| `node tests/youtube-controls.test.js` | Passed candidate cleanup and source lifecycle |
| `node tests/youtube-permission.test.js` | Passed updated help/product/privacy assertions |
| `node tests/run.js theme` | 14 passed, zero failed |
| `node tests/run.js repo` | 14 passed, zero failed |
| `node tests/youtube-send-browser.js dist/youtube-replies/send-browser` | Passed click and autocomplete replies on Twitch/Kick host fixtures in Chrome and simulated Firefox modes |
| `node tests/youtube-browser.js dist/youtube-replies/view-browser` | Passed author interaction, plain-text rendering, styles, source controls and native-action boundaries in both modes |
| `node tests/youtube-options-browser.js dist/youtube-replies/options-browser` | Passed settings, saved links, backup and narrow-layout regressions in both modes |
| `git diff --check` | Passed |

The browser scripts used existing Playwright via `FCM_PLAYWRIGHT_PATH`, installed
Chrome headlessly and loopback fixtures with external traffic blocked. The narrow
reply screenshot was inspected. These are synthetic tests, not live YouTube
delivery or native Firefox verification. No dependencies were installed.

Exact-source coverage command:

```powershell
node tests/release-coverage.js --changed-only dist/youtube-replies/node-coverage.json dist/youtube-replies/send-browser/browser-coverage.json dist/youtube-replies/view-browser/browser-coverage.json dist/youtube-replies/options-browser/browser-coverage.json
```

| Runtime file | Changed executable lines | Functions | V8 ranges |
| --- | ---: | ---: | ---: |
| `src/content/compose.js` | 93/93 | 20/20 | 93/93 |
| `src/content/overlay.js` | 40/40 | 3/3 | 52/52 |
| `src/content/render.js` | 7/7 | 1/1 | 12/12 |
| `src/content/youtube-controls.js` | 2/2 | 0/0 | 0/0 |
| `src/options/options.js` | 1/1 | 0/0 | 0/0 |
| `src/shared/constants.js` | 3/3 | 0/0 | 0/0 |
| `src/youtube/permission.js` | 1/1 | 0/0 | 1/1 |
| **Total** | **147/147** | **24/24** | **158/158** |

This is 100% of changed executable JavaScript across the combined working diff,
including #67/#68, not repository-wide coverage. HTML/CSS behavior is checked
through unit/DOM assertions and browser tests. The gate rejected an older browser
capture after the source changed; it was replaced with a fresh exact-source run.

## Files changed for this follow-up

| File | Change |
| --- | --- |
| `src/shared/constants.js` | Separate reply-platform allowlist; API send-platform allowlist unchanged |
| `src/content/render.js` | YouTube mention candidates, normalization, cleanup and author tooltip |
| `src/content/compose.js` | YouTube author clicks and autocomplete; duplicate/stale mention guards |
| `src/content/overlay.js` | YouTube-only reply routing and source/account binding |
| `src/content/youtube-controls.js` | Clear candidates on source replacement/removal/teardown |
| `src/content/overlay.css` | Clickable YouTube author styling |
| `tests/youtube-view.test.js` | Rendering/composer regression cases |
| `tests/youtube-sending-ui.test.js` | Overlay send/reply isolation cases |
| `tests/youtube-controls.test.js` | Candidate lifecycle cases |
| `tests/youtube-send-browser.js` | Synthetic click/autocomplete/send/source-change cases |
| `tests/youtube-browser.js` | Updated browser author and moderation expectations |
| `tests/youtube-permission.test.js` | Updated help assertions |
| `src/youtube/permission.html` | Mention-reply help |
| `README.md` | Reply instructions and current limitations |
| `PRIVACY.md` | In-memory candidates, user action and source/account binding |
| `VALIDATION-youtube-replies.md` | This validation/review record |
| `docs/handoff/28_YOUTUBE_NATIVE_SENDING.md` | Superseding mention-reply note; locally ignored |
| `docs/handoff/30_YOUTUBE_MENTION_REPLIES.md` | Current implementation handoff; locally ignored |

The earlier issue report inventories the remaining changes already present in
this working tree. Pre-existing untracked `AGENTS.md` and
`store-screenshots/2026-09-17/` were preserved.

## Review and remaining limits

Final diff review covered routing, source/account isolation, escaping, moderation,
tests, compatibility, permissions and data safety. No actionable defect remained.
No manifest, identity, permission, dependency, credential, worker/API route,
storage/backup-format or release-version change was needed for mention replies.
Native sender validation and uncertain-send/no-retry behavior remain in place.

Live delivery and YouTube mention notification/highlighting were not verified.
Native Firefox, external CI, Firefox lint, signing and publication were not run.
Platform DOM and embedded-session restrictions remain existing runtime risks.
No real messages, moderation, purchases, account changes, commits, pushes, PRs,
issue closures or releases were performed. Handoff files remain locally ignored;
no exclusions changed and no files were force-added. Logs, coverage, browser
results and screenshots are in the ignored `dist/youtube-replies/` directory.
