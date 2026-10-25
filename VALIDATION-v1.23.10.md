# Friendly Chat 1.23.10 validation

October 24, 2026 (Eastern). The owner authorized a PR, merge, Chrome/Firefox
publication and closure of issue #83. This records local pre-release validation;
public assets and the update feed are checked separately after the tag workflow.

## Changes and evidence

- Reduce work alongside Kick playback: share one native-control snapshot per tick,
  batch column resize callbacks through the placement frame, and skip placement
  for Kick's native message-list scrolling. Page/window movement, card clearance,
  the half-second backstop and teardown/fallback behavior remain covered.
- Remove the native-chat hiding setting from defaults, both settings screens and
  its overlay consumer. Old saved true values are ignored without resetting
  storage; older backups retain supported settings and links. Native chat remains
  visible underneath the overlay; menus and cards remain accessible.
- Address #83 by enabling browser spellchecking in the editable composer,
  including pop-outs. Browser/OS dictionaries and privacy settings govern spelling
  marks, suggestions and optional online checking; no spelling service is added.
- Update the version, download names and installed release notes to 1.23.10.

Live read-only inspection of the owner's existing Kick/Bwana tab found one
overlay, working offscreen image suspension, a native footer with 388 buttons,
and 1080p playback with about 2.09 seconds buffered ahead at the sample. This
does not establish what caused an earlier freeze. Live CPU profiling was
unsupported by the available browser interface.

The isolated before/after fixture (reference
`8c6ca38dd2fa91771883171a5279241e518e058c`) measured two native-control discoveries
per tick before versus one after; a synthetic 1000-callback resize burst caused
3000 column rect reads before versus three in one deferred pass after; twelve
native-message scroll events caused 36 extra column reads before versus zero
after. These are work counts, not measured CPU or freeze-rate improvements.

## Verification

Checks ran after individual file updates. Final results:

| Command | Result |
| --- | --- |
| `node tests/run.js` | 3404 passed, 0 failed |
| `node tests/youtube-sending-ui.test.js` | Spelling, removal, performance and existing composer assertions passed |
| `node tests/run.js performance` | Passed |
| `node tests/run.js emoteinput` | 23 passed, 0 failed |
| `node tests/run.js compose` | 74 passed, 0 failed |
| `node tests/run.js defaults` | 9 passed, 0 failed |
| `node tests/run.js backup` | 46 passed, 0 failed |
| `node tests/run.js options` | 56 passed, 0 failed |
| `node tests/run.js native` | 133 passed, 0 failed |
| `node tests/run.js claim` | 13 passed, 0 failed |
| `node tests/run.js sites` | 28 passed, 0 failed |
| `node tests/run.js chatcollapse` | 14 passed, 0 failed |
| `node tests/run.js stalepanel` | 13 passed, 0 failed |
| `node tests/run.js issuefixes` | Passed |
| `node tests/run.js releasenotes` | Passed; new version first, one latest marker |
| `node tests/run.js repo` | 14 passed, 0 failed |
| `node tests/release-coverage.js --changed-only dist/release-1.23.10/changed-runtime-coverage.json` | overlay: 17/17 changed executable lines, 5/5 functions, 25/25 selected V8 ranges; options: 1/1 changed line; constants: deletion only |
| `node tests/kick-playback-browser.js dist/kick-playback-performance/browser` | Spelling, both settings screens, video-dimension/layout/refresh and work-count checks passed |
| `node tests/issue-fixes-browser.js dist/kick-playback-performance/native-ui` | Native visibility/replacement, cards/menus, notifications and independent pop-outs passed |
| `node tests/collapsible-controls-browser.js dist/release-1.23.10/browser-notes` | Both host layouts and eleven release-note sections passed at 375/1100px, light/dark |
| `node --check` on edited JavaScript; `git diff --check` | Passed |
| `node tools/pack.js dist/release-1.23.10/packages --target all` | Chrome and unsigned Firefox packages built, 68 files each |
| `node tools/release.js verify-packages dist/release-1.23.10/packages 1.23.10` | all good |

Browser checks used the existing Playwright installation through
`FCM_PLAYWRIGHT_PATH`. Installed Chrome and simulated Firefox mode in Chrome were
tested; no new package dependencies were installed. Isolated contexts, pop-ups,
media tracks, browsers and local servers were closed. Screenshots were inspected.

Combined changed-runtime coverage is 18/18 executable lines, 5/5 functions and
25/25 selected V8 ranges: 100%. The existing actual-source and nested-range gate
is retained. A tested helper skips deletion-only diffs with no remaining lines
to execute; no nonempty selection is excluded or threshold weakened. Absence,
legacy flags and imports are tested separately. This is changed-runtime coverage
plus the full suite, not whole-repository coverage. Nested assertions do not
increase the legacy runner's 3404 count.

## Changed-file inventory

`manifest.json`, `PRIVACY.md`, `README.md`, `src/content/overlay.js`,
`src/options/options.html`, `src/options/options.js`, `src/releases/notes.html`,
`src/shared/constants.js`, `tests/collapsible-controls-browser.js`,
`tests/issue-fixes-browser.js`, `tests/kick-playback-browser.js`,
`tests/release-coverage.js`, `tests/release-notes.test.js`, `tests/run.js`,
`tests/youtube-sending-ui.test.js`, and this validation file.

## Review, limitations and release boundary

Final self-review covered the complete diff, unit/browser regressions, compatibility,
claim safety, snapshot lifetime, cancellation, visibility removal, browser privacy,
permissions and unintended changes. No remaining actionable finding was identified.
Existing user AGENTS.md/screenshots were preserved; ignored handoff reports remain
local and were not force-added. No secrets or real personal data are fixtures.

The canvas video changes intrinsic dimensions while chat and layout change; it
does not reproduce Kick's adaptive bitrate, codecs, network buffering or GPU
decoder switching. The spelling replacement is simulated; OS-native dictionary
contents/menus and native Firefox execution were not newly verified. The live
tab was not refreshed to load edited code, so it is not updated-build evidence.
No total CPU improvement or guaranteed elimination of all stutters is claimed.

No worker, OAuth scope, extension identity, permission, backup version or storage
key changes are included. No real chat, moderation, purchase, account reset or
worker deployment ran. Firefox lint/signing and public asset verification are
performed by or after the authorized release workflow. Chrome Web Store packaging
is a separate workflow artifact, not a second public ZIP or store submission.
