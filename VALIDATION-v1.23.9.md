# Friendly Chat 1.23.9 validation

October 13, 2026 (Eastern). The owner authorized PR creation, merge to main and
Chrome/Firefox release publication. This record describes the reviewed local
source; public publication is verified separately after the tag workflow.

Kick's configured legacy Pusher app returned error 4001 and every retry reopened
the same obsolete endpoint. The fix immediately requests Kick's current public
Pusher-only descriptor after this rejection. Requesting both providers selected
Centrifugo, which rejects browser-extension origins with HTTP 403; that initial
implementation was removed. The final supported Pusher path accepts extension
origins without header/origin changes or page-world injection.

Descriptor setup validates the public app key/cluster, omits credentials,
rejects redirects, times out after ten seconds, and cancels on leave/replacement.
The random reader ID stays only in background tab-session memory. Subsequent
migrated retries recheck current connection details. Existing chat/event parsing,
subscriptions, heartbeat/deadline, retry cooldown and other-platform delivery
remain intact. Stale socket closes and queued timeout callbacks have regressions.

## Validation results and exact commands

- `node tests/run.js`: **3404 passed, 0 failed**, baseline and final; integrated
  `node:assert/strict` migration checks also pass but do not increment that count.
- `node tests/kick-realtime.test.js`: Chrome/Firefox source and real session
  coordinator startup paths pass, including Twitch delivery during Kick recovery.
- `node tests/run.js reconnects`: migration and existing Twitch/Kick/YouTube
  recovery tests pass; 7 custom assertions, 0 failed.
- `node tests/connection-recovery.js --coverage`: complete-source V8 gate and
  gate self-tests pass; **52/52 changed executable lines, 3/3 functions, 58/58
  ranges (100%)**. This measures changed runtime code, not repository coverage.
  Unchanged files have no selection and are skipped rather than falsely failing.
- `node tests/run.js releasenotes`: latest-version/order/copy/lifecycle checks pass.
- `node tests/run.js defaults`: 9 passed, 0 failed.
- `node tests/run.js repo`: 14 passed, 0 failed after documentation updates.
- `node tools/pack.js dist/release-1.23.9/packages --target all` and
  `node tools/release.js verify-packages dist/release-1.23.9/packages 1.23.9`:
  pass; 68-file Chrome and unsigned Firefox packages.
- With the existing bundled Playwright runtime, `node
  tests/collapsible-controls-browser.js dist/release-1.23.9/browser-notes`:
  isolated Chrome and Firefox-mode checks pass with external traffic blocked.
  Ten release-note sections fit 375/1100px widths in light/dark themes.
- `node --check` on kick-source.js, kick-realtime.test.js,
  connection-recovery.js, release-notes.test.js and
  collapsible-controls-browser.js, plus `git diff --check`: pass.

The owner reloaded the revised repository extension in Chrome. The authorized
Kick/kados tab visibly connected at 18:46 Eastern, loaded seven history messages,
native/third-party/personal emotes and moderator standing, and stayed connected
through 18:50 with no disconnect after the initial automatic app switch. No new
live publication arrived during that quiet-channel observation; forwarding is
tested with actual source and coordinator fixtures. Native Firefox UI was not
run; generated Firefox startup paths passed and release CI performs lint/signing.

## Changed files and final review

Runtime: `src/background/kick-source.js`.

Tests: new `tests/kick-realtime.test.js`, `tests/connection-recovery.js`,
`tests/release-notes.test.js`, `tests/collapsible-controls-browser.js`.

Release/product/privacy: `manifest.json` (1.23.9), `README.md`, `PRIVACY.md`,
`src/releases/notes.html`, and this validation record.

Ignored local handoffs: 01, 06, 13 and 57. They were updated without exclusion
changes or force-adds. Preexisting untracked AGENTS.md and screenshots are not
part of the release commit.

Final local diff review covered unit regressions, generation/timer cleanup,
compatibility/script/package contracts, permissions and credential/data safety,
version/download/notes consistency and unrelated changes. No actionable findings
remain. Focused checks ran after each file update; failing migration, timeout and
release-note assertions were corrected before the full gate passed.

No dependencies, permissions, storage schema, account scopes, worker source or
configuration, extension identity, backup formats, send targets or moderation
authorization changed. Setup introduces only anonymous Kick descriptor requests
and an in-memory reader identifier, documented in PRIVACY.md. No real messages,
moderation actions or purchases were performed. Chrome Web Store packaging is
separate from the requested GitHub Chrome/Firefox release; no store submission is
claimed. Public assets, Mozilla signing, CI and the Firefox feed must be verified
after publication before reporting the release complete.
