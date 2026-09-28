# GitHub issues #67 and #68 — local implementation

Validated September 28, 2026, with Node v24.19.0 on Windows.
Branch: `codex/issues-67-68`. Base: `e2581ab19108d5d7368a4c6585a691f78174ab56`.
The GitHub main SHA matched the local base when inspected. These were the only
open issues, and neither had comments or additional requirements.

## Result

- [#67](https://github.com/JRBlaze/FriendlyChatExtension/issues/67): an optional
  recent-emote bar above the input, enabled by default. Up to 12 successfully sent
  emote names are saved locally for each of Twitch and Kick, as the owner requested.
  Names are resolved against the currently loaded platform sets. Mouse and keyboard
  activation insert at the caret, preserve surrounding text, and never send.
  Overflow scrolls horizontally. The overlay and options page expose the toggle.
  Hiding the bar retains its records. The preference syncs/exports; names do neither.
- [#68](https://github.com/JRBlaze/FriendlyChatExtension/issues/68): a ready,
  signed-in YouTube composer automatically selects its send target. Manual
  deselection survives readiness, busy and restriction updates for that capability.
  A new source/account uses the automatic default. A real Send/Enter gesture is
  still required. Replies, emote-only routing, message validation, native drafts,
  and uncertain-send/no-retry behavior remain covered by regression tests.

The causes were missing recent-emote storage/UI and an intentional YouTube opt-in
selection rule. Issue #68 supersedes that earlier product rule. Public setup and
privacy text now describe automatic selection accurately.

## Validation

Local tests ran after each file update, including failing regression checks before
implementation. The original full-suite baseline was 3,362 passed, zero failed.
Final results:

| Command | Result |
| --- | --- |
| `node tests/run.js` | 3,365 passed, zero failed; includes registered standalone feature suites |
| `node tests/recent-emotes.test.js` | Passed persistence, platform separation, insertion, length limits, stale controls, disabled bar, bounded lists, queued writes, malformed storage, failures and teardown |
| `node tests/youtube-sending-ui.test.js` | Passed actual-overlay auto-selection, manual deselection, identity changes, replies, trusted sends, partial/native delivery and recent-emote integration |
| `node tests/run.js options` | 56 passed, zero failed |
| `node tests/run.js backup` | 46 passed, zero failed |
| `node tests/run.js defaults` | 9 passed, zero failed |
| `node tests/run.js compose` | 73 passed, zero failed |
| `node tests/run.js theme` | 14 passed, zero failed |
| `node tests/run.js repo` | 14 passed, zero failed |
| `node tests/youtube-permission.test.js` | Passed Chrome/Firefox setup and documentation checks |
| `node tests/youtube-access-card.test.js` | Passed popup/options access-card checks |
| `node tests/release-coverage.js --self-test` | Passed coverage gate self-tests |
| `node tests/youtube-send-browser.js dist/issues-67-68/youtube-browser` | Passed Twitch/Kick layouts in Chrome and simulated Firefox modes; settings, keyboard insertion, 260px overflow, both themes, and synthetic send regressions |
| `node tests/youtube-options-browser.js dist/issues-67-68/options-browser` | Passed both modes, preference saving/export and exclusion of seeded private recent-emote names from backups |
| `git diff --check` | Passed |

Browser tests used the existing Playwright installation selected through
`FCM_PLAYWRIGHT_PATH` at
`C:\Users\jrbla\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright`.
They ran installed Chrome headlessly against loopback fixtures, with all external
traffic blocked. Screenshots were inspected for narrow dark/light composer layout.
No dependencies were installed. The full suite includes temporary package tests;
no release or store packages were published.

Exact-source coverage command:

```powershell
node tests/release-coverage.js --changed-only dist/issues-67-68/node-coverage.json dist/issues-67-68/youtube-browser/browser-coverage.json dist/issues-67-68/options-browser/browser-coverage.json
```

| Runtime file | Changed executable lines | Functions | V8 ranges |
| --- | ---: | ---: | ---: |
| `src/content/compose.js` | 78/78 | 18/18 | 73/73 |
| `src/content/overlay.js` | 27/27 | 3/3 | 37/37 |
| `src/options/options.js` | 1/1 | 0/0 | 0/0 |
| `src/shared/constants.js` | 2/2 | 0/0 | 0/0 |
| `src/youtube/permission.js` | 1/1 | 0/0 | 1/1 |
| **Total** | **109/109** | **21/21** | **111/111** |

This is 100% coverage of changed executable JavaScript, not repository-wide
coverage. HTML/CSS are verified through DOM, settings and browser layout tests.
The coverage gate rejects stale/padded source and does not exclude uncovered
changed runtime code. `--changed-only` measures the current working diff against
HEAD; the existing default historical YouTube gate remains available.

## Changed files

| File | Change |
| --- | --- |
| `src/content/compose.js` | Bounded platform-specific local recent-emote controller and insertion UI |
| `src/content/overlay.js` | Mount/refresh/teardown, successful-send recording, toggle and YouTube selection |
| `src/content/overlay.css` | Scrollable recent-emote buttons with focus and platform indicators |
| `src/shared/constants.js` | Local recent-name key prefix and default visibility preference |
| `src/options/options.html` | Recent-emote toggle and corrected YouTube introduction |
| `src/options/options.js` | Save/restore the new preference |
| `src/popup/popup.html` | Corrected YouTube introduction |
| `src/youtube/permission.html` | Corrected setup explanation |
| `src/youtube/permission.js` | Corrected ready-state explanation |
| `README.md` | Product behavior, controls and limitations |
| `PRIVACY.md` | Local recent-name records and automatic YouTube target selection |
| `tests/recent-emotes.test.js` | New full-source unit suite |
| `tests/youtube-sending-ui.test.js` | Updated target expectations and integration regression tests |
| `tests/youtube-send-browser.js` | Auto-selection and recent-emote browser checks/screenshots |
| `tests/youtube-options-browser.js` | Preference and backup privacy checks |
| `tests/youtube-access-card.test.js` | Updated setup copy assertions |
| `tests/youtube-permission.test.js` | Updated setup/privacy/product assertions |
| `tests/run.js` | Register recent-emote tests; options defaults/restoration checks |
| `tests/release-coverage.js` | Current-diff mode and recent-emote coverage execution |
| `VALIDATION-issues-67-68.md` | This evidence and review record |
| `docs/handoff/28_YOUTUBE_NATIVE_SENDING.md` | Superseding note for the old opt-in rule; locally ignored |
| `docs/handoff/29_ISSUES_67_68.md` | Current behavior, storage and evidence pointer; locally ignored |

## Review and boundaries

Final diff review covered code, tests, compatibility, settings/backup boundaries,
permission and credential handling, native sending, and unrelated changes. No
remaining actionable defect was identified. Existing CRLF source and LF test-runner
conventions were preserved. Pre-existing untracked `AGENTS.md` and
`store-screenshots/2026-09-17/` were preserved.

No manifest, permissions, extension identity, dependency, token/auth storage,
worker route, release version or deployment changes were made. Recent records use
`fcm_recent_emotes_v1:twitch` and `fcm_recent_emotes_v1:kick`; existing keys and
backup format remain unchanged. Handoff files remain ignored; exclusions were not
changed and no ignored file was force-added.

Live Twitch/Kick/YouTube sending, native Firefox UI, external CI, Firefox lint,
signing and publication were not run. Simulated Firefox mode is not evidence of a
native Firefox test. Browser session restrictions and future platform DOM changes
can still affect the native composer. No real messages, purchases, moderation,
account changes, commits, pushes, PRs, issue closures or releases were performed.

Local logs, exact-source coverage, JSON browser results and screenshots are under
the existing ignored `dist/issues-67-68/` directory. Work is implemented locally
and ready for review, not released.
