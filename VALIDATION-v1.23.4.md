# v1.23.4 validation

Platforms and Send to can be collapsed independently. Found, unadded-channel
notices and current send destinations remain visible in their compact headers.
Both sections default to expanded; the two independent choices are saved in
existing preference storage, synced and included in settings backups.

Each newer installed version offers bundled release notes once in a background
tab. Installation, same-version reloads and ordinary background starts do not
open update notes. Popup and Settings can reopen the page. This release includes
highlights from 1.23.0 through 1.23.4. The installation marker stays local and is
excluded from backups. No permissions, dependencies or credential flows changed.

## Local checks

- `node tests/run.js`: 3370 passed, 0 failed.
- `node tests/run.js youtube`, `releasenotes`, `defaults`, `popup`, `options`
  and `repo`: passed after the relevant edits.
- `node tests/release-coverage.js --changed-only <node-coverage.json>`:
  65/65 executable lines, 12/12 functions, 45/45 V8 ranges.
  This is 100% changed-runtime coverage, not whole-repository coverage.
- `node tests/collapsible-controls-browser.js <artifacts>` with the existing
  bundled Playwright: actual Chrome and Firefox mode in Chrome passed for
  Twitch/Kick layouts. Mouse/keyboard collapse, notification acceptance and
  dismissal, saved choices after remount, retained destinations and editable
  input passed. Release notes rendered at 375px/1100px in light/dark themes,
  with five version sections and no horizontal overflow; screenshots reviewed.
- `node tools/pack.js <packages> --target all` and
  `node tools/release.js verify-packages <packages> 1.23.4`: passed.
- Syntax and whitespace checks passed. Final diff reviewed for compatibility,
  persistence, permissions, data safety and unrelated changes.

Native Firefox and live platform services were not newly tested locally.
Firefox lint/signing and public asset/update-feed verification are separate
release checks. No live messages, moderation, purchases or worker deployment.

## Changed files

Product/docs: manifest.json, README.md, PRIVACY.md, this validation record.
Runtime: src/shared/constants.js; src/content/overlay.js, overlay.css,
youtube-controls.js; src/background/service-worker.js, release-notes.js;
src/releases/notes.html, notes.css; src/popup/popup.html;
src/options/options.html.
Tests: tests/run.js, release-coverage.js, release-notes.test.js,
youtube-sending-ui.test.js, youtube-controls.test.js,
collapsible-controls-browser.js.

Related docs/handoff updates remain locally ignored. Existing untracked
AGENTS.md and store-screenshots/2026-09-17 are preserved and excluded from the PR.

## Maintenance

For each future release, add its section to src/releases/notes.html and extend
the version-list regression. Keep prior notes from 1.23.0 onward. Notification
logic automatically handles the new manifest version once it is installed.
