# v1.23.7 Share reminder fix and release validation

Twitch can redraw a private Share action with changing streak/reward text. The
reader previously deduplicated only exact text, expired it after ten minutes,
and cleared it on watcher stop. One action could therefore add multiple rows.

The fix associates native Share controls, normalized text, stream-streak counts,
and resub month counts with a single reminder. Redraws update that reminder's
native button and element. Temporary stop/start retains identity; a different
milestone still appears. A fresh page/channel watcher starts fresh. This reader
runs only on Twitch; Kick does not attach its observer or poll.

## Local verification

- Baseline full suite: 3383 passed, 0 failed.
- Regression fixtures initially produced 15 expected failures. An additional
  progressive-render fixture exposed one failure that was fixed.
- `node tests/run.js prompts`: 63 passed, 0 failed (21 new assertions).
- `node tests/run.js nativeevents`: 10 passed, 0 failed.
- Final `node tests/run.js`: 3404 passed, 0 failed, including repository,
  packaging, Firefox compatibility, integration and simulated release checks.
- `node tests/run.js releasenotes`: passed. New version, ordering and reminder
  content checks verify the bundled 1.23.7 notes.
- `node tests/run.js repo`: 14 passed, 0 failed after documentation edits.
- `node --check` on changed JavaScript and `git diff --check`: passed.
- Actual-source V8 precise coverage: 23/23 executable changed runtime lines,
  1/1 new function definition, 22/22 selected V8 ranges (100%). Existing modified
  function bodies are measured by their changed lines/ranges. This is changed
  runtime coverage, not whole-repository 100% coverage.
- Chrome and simulated Firefox browser fixtures passed Twitch/Kick collapse,
  discovery notices, keyboard use, destination preservation and saved remounts.
  Bundled release notes passed eight-section ordering, 375/1100px light/dark
  layouts and no horizontal overflow. The 375px light screenshot was inspected.
- `node tools/pack.js dist/release-1.23.7/packages --target all` and
  `node tools/release.js verify-packages dist/release-1.23.7/packages 1.23.7`:
  passed, 68 files per package.

Browser fixture command (using an existing bundled runtime, no installation):

```powershell
$env:FCM_PLAYWRIGHT_PATH = 'C:\Users\jrbla\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
node tests/collapsible-controls-browser.js dist/release-1.23.7/browser-notes
```

Coverage was collected with a temporary inspector driver running the actual
`prompts` suite and the existing `tests/youtube-coverage.js` gate against the
base source diff. Local driver/raw evidence is retained under
`dist/release-1.23.7/`. The gate verifies exact source equality and execution of
the selected changed lines and V8 ranges.

## Review and limits

Reviewed the final source/test/documentation diff for unit-test correspondence,
observer lifecycle, channel isolation, current native controls, memory bounds,
Chrome/Firefox compatibility, permissions, credentials and unintended changes.
No blocking findings. No new setting, storage key, permission, OAuth scope,
dependency, backup format or worker route. Identity and existing data are intact.

Text aliases/current controls are bounded to 200 entries. Still-mounted buttons
remain deduplicated after eviction; an evicted identity with a completely new
button could reappear after more than 200 distinct identities in one visit.

Native Firefox UI and the reporter's live Twitch DOM were not newly tested.
Browser fixtures use isolated local pages with remote traffic blocked. Firefox
lint and Mozilla signing are performed by the tag-driven workflow.

## Publication gate

After PR checks pass on Node 20/22/24, merge and tag v1.23.7 on the merge commit.
Wait for release tests, package checks, Firefox lint/signing and publication.
Verify exactly four public assets: Chrome ZIP, unsigned Firefox XPI, signed
Firefox XPI and updates.json. Match downloaded hashes/sizes to GitHub metadata,
all Chrome package files to exact tagged source bytes, signed XPI contents to
the unsigned reference, and the live latest update feed to the signed 1.23.7 link.
Keep the separate Chrome Web Store artifact outside the public release assets;
building it does not establish store submission.

This record precedes publication. Final PR/merge/tag/run identities and public
verification evidence are recorded in the local handoff and GitHub workflow.
Ignored handoffs, user AGENTS.md and existing screenshots are not force-added.
