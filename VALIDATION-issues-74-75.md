# GitHub issues 74 and 75 - implementation validation

Date: October 8, 2026. Branch: codex/issues-74-75.
Base HEAD: ab34bf01df2256b9dcf5f7bfaeb6105f473316f6 (1.23.4).
Only open issues at review and final recheck: 74 and 75.

## Changes and evidence

- [Issue 74](https://github.com/JRBlaze/FriendlyChatExtension/issues/74):
  Cheer routing previously changed Twitch to native while retaining the other
  selected destinations. It now narrows to Twitch before validating YouTube or
  dispatching any transport. The user explicitly retained paid events in the
  merged feed. Kick gifts already use Kick's native controls; tests confirm
  that opening Kicks performs no cross-platform send. Ordinary selected
  destinations, native Cheer spending and uncertain-send protection persist.
- [Issue 75](https://github.com/JRBlaze/FriendlyChatExtension/issues/75):
  The user clarified that about:blank in the URL bar was the problem. Ordinary
  pop-outs now open a temporary local Blob document. The address includes the
  source origin and #friendly-chat/platform/channel, and the existing panel
  moves after loading. Loading timeout, repeated-opening protection, resource
  cleanup and teardown checks are covered. Document PiP remains separate.
  The Blob URL is temporary and cannot be bookmarked or shared as a chat page.

## Every changed file

- src/content/overlay.js: isolated Cheer destinations and local pop-out document.
- tests/youtube-sending-ui.test.js: full-source unit fixtures for both issues,
  including failure/teardown paths, platform modes and unchanged ordinary sends.
- tests/issue-fixes.js: existing pop-out regression mock now models document load.
- tests/run.js: independent-window source assertion accepts the Blob address.
- tests/issues-74-75-browser.js: isolated browser regression script; external
  requests are blocked and native paid sends are mocked.
- README.md: describes paid routing and temporary pop-out addresses.
- VALIDATION-issues-74-75.md: this durable validation record.
- docs/handoff/44_ISSUES_74_75_VALIDATION.md: local ignored handoff update.

Release preparation additionally changes manifest.json (1.23.5),
src/releases/notes.html (current update highlights), tests/release-notes.test.js
(version/content assertions), and tests/collapsible-controls-browser.js
(the six-version history count). README.md also receives current asset names.

## Commands and results

- node tests/run.js: baseline and final runs each 3370 passed, 0 failed.
- node tests/youtube-sending-ui.test.js: passed after relevant file updates.
- node tests/run.js cheersend: 9 passed, 0 failed.
- node tests/run.js firefox: 329 passed, 0 failed.
- node tests/run.js issuefixes: 1 suite passed, 0 failed; its internal assertions passed.
- node tests/run.js repo: 14 passed, 0 failed after documentation updates.
- node tests/release-coverage.js --changed-only
  C:\Users\jrbla\AppData\Local\Temp\fcm-issues-74-75-node-coverage.json:
  changed executable runtime 27/27 lines, 3/3 functions, 31/31 V8 ranges.
  This is 100 percent of changed runtime, not whole-repository coverage.
- With FCM_PLAYWRIGHT_PATH set to the existing bundled Playwright:
  node tests/issues-74-75-browser.js
  C:\Users\jrbla\AppData\Local\Temp\fcm-issues-74-75-browser:
  Chrome and Firefox-mode in Chrome passed for both host layouts. Loaded popup
  URLs/titles, preserved draft/return and native-only Cheer dispatch verified.
  A separate local Chrome CDP isolated-world probe verified Blob navigation and
  same-origin DOM access. Generated popup screenshots were visually reviewed.
- node tools/pack.js C:\Users\jrbla\AppData\Local\Temp\fcm-issues-74-75-packages --target all:
  Chrome ZIP and unsigned Firefox XPI built; 62 files each.
- node tools/release.js verify-packages
  C:\Users\jrbla\AppData\Local\Temp\fcm-issues-74-75-packages 1.23.4: all good.
- node --check: overlay.js and all four changed JavaScript test files passed.
- git diff --check: passed; final diff reviewed for compatibility, permissions,
  data safety, uncertain paid-send retries, cleanup and unrelated changes.

The first added title-only regression failed, then was replaced after the
user's URL-bar clarification. An intermediate full run exposed an obsolete
blank-URL source assertion and an older mock missing Blob/loading support;
both were repaired. Final full-suite and measured changed-runtime coverage pass.

## Limits and release boundary

Native Firefox browser automation is unrun: no existing Playwright Firefox
runtime. Firefox-mode in Chrome is a simulation, not native Firefox evidence.
Live Twitch/Kick/YouTube, real paid sends/gifts and Firefox web-ext lint were not
run. No standalone JavaScript lint/type-check configuration exists. A live
installed-extension smoke test remains useful before release.

No permissions, dependencies, storage keys, backup formats, credentials,
privacy data flows, identity, versions or worker contracts changed.
PRIVACY.md remains applicable. Existing untracked AGENTS.md and screenshots
were preserved. The new handoff is ignored by existing local exclusions.
The initial local 1.23.4 packages were test artifacts, not a released update or
signed build. No external mutations occurred during that initial validation.

## Authorized release preparation

The user subsequently authorized a GitHub PR, merge to main, Chrome/Firefox
release publication and closure of resolved issues 74 and 75. Version 1.23.5
updates manifest.json, README asset names and highlights, and the bundled
release notes. Corresponding release-note tests and the browser history-count
assertion were updated. Native Firefox/live-platform limitations above still
apply. The standard release workflow handles Firefox lint/signing and publishes
the four GitHub assets; Chrome Web Store submission is a separate action.
Final workflow/assets/update-feed evidence is recorded in the local ignored
release handoff after publication, rather than inferred from these local tests.
