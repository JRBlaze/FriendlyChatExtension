# Friendly Chat 1.23.8 validation

October 13, 2026. Addresses issue #80; all three supported chat sources were
reviewed. This record describes local validation before publication. Public
release verification will be recorded separately after the release workflow.

## Behavior and evidence

Kick/Twitch previously stopped after ten failed retries. They now retain bounded
two-to-thirty-second backoff, pause for five minutes after exhaustion, then start
a fresh cycle. Leaving/changing a chat cancels recovery; manual reconnect retries
immediately. Kick now honors a shorter advertised heartbeat timeout, pings at
least every 25 seconds, and closes a silent connection after a thirty-second
response deadline. Socket-owned timers and generations protect replacement chats.

YouTube had a separate three-retry hard stop and never reset its counter after
healthy reading. It now waits five minutes after its two/four/eight-second retry
burst and resets the counter after thirty seconds of stable reading. Recovery
checks access and binds fresh frames/nonces. Pending sends remain uncertain and
are never replayed. Stale cooldown callbacks cannot replace a recovered reader.

The supplied screenshot identifies Kick; red marks error system rows rather
than a failure of every service. It does not establish the reporter's underlying
network/provider failure. No live reporter reproduction was performed.

## Local verification

- Baseline and final `node tests/run.js`: **3404 passed, 0 failed**, plus the new
  `node:assert/strict` regressions integrated into `reconnects`. Those assertions
  fail the suite on error but do not increment the custom runner's total.
- `node tests/connection-recovery.js --coverage`: **66/66 changed executable
  lines, 3/3 selected/new functions, 63/63 changed V8 ranges (100%)**. Complete
  current source equality and Git-diff selection are checked by the existing
  coverage gate. This is changed-runtime coverage, not whole-repository coverage.
- `node tests/run.js reconnects`, `node tests/youtube-transport.test.js` and
  `node tests/run.js youtube`: pass, including permissions and no-send-replay.
- `node tests/run.js releasenotes`: passes version/order/copy and lifecycle checks.
- `node tests/run.js defaults`: 9/0; `node tests/run.js repo`: 14/0.
- `node --check` for changed JavaScript and `git diff --check`: pass.
- `node tools/pack.js dist/release-1.23.8/packages --target all` and
  `node tools/release.js verify-packages dist/release-1.23.8/packages 1.23.8`:
  pass, 68-file Chrome and Firefox packages, Chrome minimum 116/Firefox minimum 140.0.
- With the existing bundled Playwright dependency, `node
  tests/collapsible-controls-browser.js dist/release-1.23.8/browser-notes` passes
  Chrome and simulated Firefox modes. Both host layouts retain controls,
  notices, keyboard interaction, destinations and remembered layout. Nine
  release-note sections fit 375/1100px widths in light/dark modes. All external
  traffic is blocked. Native Firefox was unavailable and not run.

New fixtures failed against the old heartbeat, retry exhaustion and stale
YouTube cooldown behavior, then passed after the corresponding changes.
Focused commands were run after each file update. Local coverage output,
packages and browser screenshots are under `dist/release-1.23.8/`.

## Changed files and review

Runtime: `src/shared/constants.js`, `src/background/kick-source.js`,
`src/background/twitch-source.js`, `src/content/youtube-source.js`.

Tests: new `tests/connection-recovery.js`, `tests/run.js`,
`tests/youtube-transport.test.js`, `tests/release-notes.test.js`,
`tests/collapsible-controls-browser.js`.

Release/product documentation: `manifest.json` (1.23.8), `README.md`,
`src/releases/notes.html`, and this validation record. Local ignored handoffs
02/06/13/55 were updated without exclusion changes or force-adds.

Final review covered compatibility/script ordering, bounded backoff, timer and
generation isolation, permissions, frame cleanup, uncertain-send non-replay,
storage/credential safety, tests and unrelated changes. No remaining actionable
findings were identified. The version change has corresponding repository and
release-notes assertions; runtime changes have focused unit regressions.

No new dependency, permission, storage key, account scope, service endpoint,
worker change, telemetry or credential flow was introduced. PRIVACY.md remains
accurate. User settings/accounts/links, backup formats, platform-scoped replies,
moderation standing and extension identity/update contracts are preserved.
Existing untracked AGENTS.md and screenshots are excluded from the release commit.

Live Twitch/Kick/YouTube behavior, actual installed-client updates and native
Firefox UI remain unverified. No real messages/moderation or account changes
were performed. Firefox lint/signing/publication are performed by the existing
authorized tag-driven release workflow and require separate terminal evidence.
Chrome Web Store submission is separate from the GitHub Chrome release.
