# Issue #70 validation — October 2, 2026

Implemented locally on `codex/issue-70-recent-emote-limit`, based on
`d4d1718e4200cc1d772661841e64030ced4cf649` (version 1.23.1).

## Issue and resulting behavior

`gh issue list --repo JRBlaze/FriendlyChatExtension --state open --limit 100
--json number,title,body,url,labels,comments,updatedAt` returned one open issue:
[#70, Limit Recently Used Quick Select Emote Selector](https://github.com/JRBlaze/FriendlyChatExtension/issues/70).
The previous bar could render 12 Twitch plus 12 Kick emotes and explicitly
enabled horizontal scrolling. The owner selected combined newest-first ordering
and clarified that the bar must display no more than eight total, reduce to as
few as one when narrowed, and stay on one row.

The bar now selects the newest available entries across joined Twitch/Kick
platforms and caps the visible count at the number that fits, from one to eight.
At the existing 32px button width and 4px gap, 284px fits eight, 283px fits seven,
160px fits four, and 32px fits one. ResizeObserver updates the count and is removed
on teardown. Existing histories stay separate and retain up to 12 names per
platform. Only eligible successful sends update them, using the existing overlay
integration. A bounded local ordering list adds combined recency without dates,
account identifiers, message text or image URLs. Neither names nor ordering enter
sync or backups. Existing records without that list use their prior platform
order until new uses establish combined recency.

## Changed files

| File | Change |
| --- | --- |
| `src/content/compose.js` | Combined ordering, width-dependent one-to-eight display limit, local metadata validation/persistence, observer cleanup |
| `src/content/overlay.css` | Remove horizontal scrolling; retain one row and constrain the bar width |
| `tests/recent-emotes.test.js` | Unit regressions for bounds, ordering, legacy metadata, reload, same-name isolation, storage updates, resize thresholds and cleanup; CSS contract checks |
| `tests/youtube-send-browser.js` | Browser regressions for mixed entries, eight/four/one controls, one row, no overflow, insertion and widening |
| `README.md` | Document the eight-total cap and responsive visible count |
| `PRIVACY.md` | Document the additional local ordering record and existing privacy boundaries |
| `VALIDATION-issue-70.md` | This verification record |
| `docs/handoff/36_ISSUE_70_RECENT_EMOTES.md` | Local handoff update; ignored by existing exclusions |

Existing untracked `AGENTS.md` and `store-screenshots/2026-09-17/` were preserved.
Ignored evidence lives in `dist/issue-70/`; no exclusion changes or force-adds.
Updated existing files preserve their Windows CRLF line endings.

## Commands and results

| Command | Result |
| --- | --- |
| `node tests/run.js` before edits | 3,365 passed, zero failed |
| `node tests/run.js recentemotes` after each relevant update | Passed; test-first failures reproduced missing behavior before its implementation |
| `node tests/run.js repo` after documentation updates | 14 passed, zero failed |
| `node --check src/content/compose.js` | Passed |
| `node --check tests/recent-emotes.test.js` | Passed |
| `node --check tests/youtube-send-browser.js` | Passed |
| `node tests/youtube-send-browser.js dist/issue-70/browser` | All four host/browser-mode fixtures passed; every external request was blocked |
| `node tests/release-coverage.js --changed-only dist/issue-70/node-coverage.json` | Changed runtime JavaScript: 58/58 executable lines, 16/16 functions, 51/51 V8 ranges; all 100% |
| `node tests/run.js` final | 3,365 passed, zero failed; `dist/issue-70/full-suite.log` |
| `git diff --check` | Passed |

Browser command uses the preinstalled Playwright package, with
`FCM_PLAYWRIGHT_PATH=C:\Users\jrbla\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright`.
It runs installed Chrome with Chrome and simulated Firefox branches on both
synthetic Twitch and Kick layouts. Screenshots were inspected to confirm the
single-row layout. It exercises only mocked sends; no real chat messages were sent.

## Final review and limits

Reviewed the final code and test diff for the hard total cap, newest-first
platform identity, observer lifecycle, bounded additive storage, existing saved
data, input insertion, script ordering, browser support, permissions and unintended
changes. No unresolved defect was identified in the changed behavior.

Coverage is of changed runtime JavaScript, matching the established acceptance
scope; it is not repository-wide coverage and does not claim CSS coverage. CSS
has both unit contract checks and browser layout checks. Native Firefox and live
Twitch/Kick checks were not run. No standalone JavaScript lint/type-check command
exists; external web-ext lint was not run. Full-suite package and Firefox checks
passed, but no separately signed or published package was produced.

At the end of the initial implementation, the manifest/version, browser identity, host permissions, dependencies, worker,
account credentials and production configuration are unchanged. No commits,
pushes, PRs, tags, issue closures, signing, uploads or releases were performed.
Issue #70 remained open on GitHub pending an authorized publication workflow.

## Authorized release preparation

The owner subsequently authorized PR creation, merge to main, Chrome/Firefox
publication and issue closure. The release version is 1.23.2. Manifest and README
download names were updated together, with the existing repository unit tests
checking their agreement. No runtime behavior changed during release preparation.

- `node tests/run.js repo`: 14 passed, zero failed after both version edits.
- `node tests/release-coverage.js --changed-only dist/issue-70/release-coverage.json`:
  unchanged 100% changed-code coverage (58 lines, 16 functions, 51 V8 ranges).
- `node tools/pack.js dist/issue-70/v1.23.2 --target all`: both packages built.
- `node tools/release.js verify-packages dist/issue-70/v1.23.2 1.23.2`: all good.
- Final full release-preparation suite is saved in `dist/issue-70/release-suite.log`.

Publication uses the existing tag-triggered workflow. Public assets, signed-XPI
contents and the latest update feed are verified before closing issue #70.
