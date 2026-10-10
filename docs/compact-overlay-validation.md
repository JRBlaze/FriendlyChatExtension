# Compact top and bottom overlay controls — local validation

User requested smaller overlay menus, closer to native chat, for laptops and
small screens. Local branch remains `codex/issue-77-emote-availability`, HEAD
`a4af0587c2c062151feec8f1984cb53396b8254f`, source version 1.23.5. Earlier local
issue #77, quick start, mention highlighting, sound and pin changes are retained.

## Result

The header loses excess outer padding while icon buttons increase to 24px.
Expanded Platforms and Send to place their headings alongside their buttons,
and YouTube visibility/setup share a row. The duplicate selected-destination
summary disappears only while actual send buttons are visible. Closed summaries
retain destinations, replies and discovery notices. Existing independent collapse
choices, expanded defaults and persisted settings are unchanged.

Platform/target/native-tool buttons use flatter corners and tighter gaps. Footer,
status, input and recent-emote spacing is reduced. Buttons remain usable; normal
chat text sizing is retained. Long channel names wrap, discovery notices have
full rows, and YouTube URL input remains usable when expanded. Recent emotes keep
their original 32px cells and responsive eight-total limit. No control or tool is
removed. Replies, balances and send status remain visible. Flex formatting contexts
avoid clipping keyboard focus outlines while fitting beside disclosure headings.

Measured 76 synthetic layouts at 240/280/340px chat widths, both themes, text
sizes 10/14/22, Twitch/Kick and Chrome/simulated Firefox. Four additional layouts
use an 800x600 viewport with a 480px panel. Compared with the pre-change stylesheet,
chat gains **57.39–124.39px**; examples at 340px/default text are about 113px on
Twitch and 98px on Kick. Account/route combinations affect wrapping, so these are
fixture measurements rather than a guarantee for every live channel. Large text
and fully expanded controls can still take several rows in short windows; the
existing collapses retain readable chat and visible routing in that case.

Screenshots (synthetic messages and accounts; no real chat):
- [Twitch before](../dist/compact-overlay/browser/chrome-twitch-before.png)
- [Twitch after](../dist/compact-overlay/browser/chrome-twitch-after.png)
- [Kick after](../dist/compact-overlay/browser/chrome-kick-after.png)
- [Short laptop view](../dist/compact-overlay/browser/chrome-twitch-short-laptop.png)

## Files changed for this request

| File | Purpose |
| --- | --- |
| `src/content/overlay.css` | Compact header, platform/YouTube rows, footer and status styling; native disclosure layout. |
| `tests/compact-overlay.test.js` | Unit contracts for input/target size, names, focus, notices and preserved native disclosures. |
| `tests/compact-overlay-browser.js` | Actual geometry, before/after measurements, small windows, both themes/fonts/hosts, routing/replies/recent emotes, keyboard controls and changed-CSS rule usage. |
| `tests/run.js` | Register compactoverlay unit suite. |
| `README.md` | Explain compact rows and destination summaries. |
| `docs/compact-overlay-validation.md` | This evidence and review record. |
| `docs/handoff/51_COMPACT_OVERLAY_LAYOUT.md` | Locally ignored handoff supplement. |

## Validation

- Baseline `node tests/run.js`: **3382 passed, 0 failed**.
- After file updates, `node tests/run.js compactoverlay`, `youtube`, and `repo`
  passed. Initial new tests intentionally failed before style changes. Browser
  fixture setup was corrected for its development toolbar, unavailable synthetic
  send routes and long-name/not-added states. Short-window checks use rendered
  line height rather than an arbitrary fixed pixel threshold; larger text also
  exercises collapsed controls. These changes did not alter shipped runtime.
- Full `node tests/run.js` before the final focus-outline adjustment:
  **3383 passed, 0 failed**. The final rerun after that adjustment also passes
  **3383 checks, 0 failures** (`dist/compact-overlay/final-tests.log`).
- `FCM_PLAYWRIGHT_PATH=<bundled Playwright path> node tests/compact-overlay-browser.js dist/compact-overlay/browser`:
  **76 geometry cases passed**, plus full names, YouTube form width, reply context,
  recent-emote one-row/maximum, draft editing and disclosure checks. All remote
  traffic was blocked; automatic claim/watch behavior disabled in fixture setup.
- CSS coverage: Chrome DevTools `CSS.startRuleUsageTracking`/`stopRuleUsageTracking`
  verifies **34/34 changed stylesheet rules exercised (100%)** against matching
  shipped stylesheet text. Raw selector results are in `browser/css-coverage.json`.
  Rule matching does not establish every possible browser state; geometry and
  interaction assertions provide the behavioral checks for the stated matrix.
- `FCM_PLAYWRIGHT_PATH=<bundled Playwright path> node tests/collapsible-controls-browser.js dist/compact-overlay/disclosures`:
  passed for Twitch/Kick in Chrome and simulated Firefox, including found-channel
  and YouTube notices, mouse/keyboard collapse, target preservation, Add/Dismiss,
  persistence and remount. Native Firefox was not run: no existing Playwright runtime.
- No shipped JavaScript changed in this request. The cumulative exact-source
  changed-runtime coverage gate `node tests/emote-availability-coverage.js dist/pin-messages/combined-coverage.json`
  was rerun against the exact matching retained profiles: **460/460 executable
  lines, 97/97 functions, 533/533 V8 ranges (100%)**. This is new/changed runtime
  coverage, not whole-repository coverage; see `runtime-coverage.log`.
- `node tools/pack.js dist/compact-overlay/packages --target all`: Chrome ZIP and
  unsigned Firefox XPI built, **68 files each**.
- `node tools/release.js verify-packages dist/compact-overlay/packages 1.23.5`:
  **all good**. These are local validation artifacts; the source version stays 1.23.5.
- `node --check tests/compact-overlay.test.js`, `tests/compact-overlay-browser.js`,
  `tests/run.js`; `git diff --check`: passed.

## Final review and boundaries

Reviewed layout/overflow, disclosure keyboard behavior, focus outlines, complete
channel names, input space, discovery state, route/reply visibility, recent emote
sizes, both themes, stored settings and CSS compatibility with declared browser
floors. No actionable findings remain. Earlier runtime changes have their own
validation records. Styles use existing flex/float/native details support;
no new dependency, permission, storage key, event handler or runtime script.

Live Twitch/Kick pages and native Firefox were not newly tested. The browser tests
use isolated Chrome with Firefox mode to exercise existing application branches;
this is not evidence of native Firefox rendering. No extension reload, sign-in,
real sends/moderation, external configuration, signing/upload/publication, commit
or push. Handoff is locally ignored; exclusions and user AGENTS/screenshots remain
preserved. Privacy/data behavior is unchanged, so no policy edit is needed.
