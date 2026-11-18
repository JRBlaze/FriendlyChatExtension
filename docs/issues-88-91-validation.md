# GitHub issues 88–91: local implementation and validation

This records the implementation snapshot before the subsequent request to open
a PR, merge, publish v1.23.13 and close the issues. Release operations are
tracked by the GitHub PR, tag and Release workflow.

Date: November 18, 2026. Branch: `codex/issues-88-91`, based on
`1b6198e90d66f96ea7ad1c224fbf39c9feb5bdd7`. Version remains 1.23.12;
these are unreleased working-tree changes.

## Reviewed scope

Reviewed the 21 closed issue descriptions and all four open issues and their
comment threads (no comments). Closed issues were historical context. No issue
state, comments, labels, commits, remote branches, PRs or releases were changed.

| Issue | Local behavior |
| --- | --- |
| #88 | Mirror English native Twitch shoutout notices carrying valid Twitch channel anchors into the existing event feed, with clickable canonical channel links. Reject ordinary messages, reserved/non-channel links, other origins, invalid URLs and oversized notice text. Deduplicate native redraws with the existing watcher. |
| #89 | Show Twitch/Kick restrictions above the composer. Merge partial room updates; retain other active restrictions; replay on content reconnection; reset when leaving the channel; reject stale-generation updates. Twitch uses ROOMSTATE. Kick uses the initial chatroom record and ChatroomUpdatedEvent, supporting flat initial fields and nested live mode flags. |
| #90 | Lazy viewer Reply/Copy shortcuts beneath hovered messages, separate from moderator tools. Preserve exact message/platform replies, rendered-body copying, clipboard error feedback and deletion-race checks. Focus keeps the action band visible. |
| #91 | Read both ends of the editable selection and replace that range on plain-text paste. Preserve surrounding text, emote-name offsets, newline normalization, max length and the existing collapsed-caret behavior. |

## Limits and external evidence

Shoutouts are read from the native Twitch notice DOM on the same joined channel.
They do not arrive through the existing IRC reader when the overlay is hosted on
Kick. English notice wording and the native notice selector are required. This
is a local DOM fixture fix, not proof that current live Twitch markup matches.
[Twitch documents EventSub shoutout notifications](https://dev.twitch.tv/docs/api/reference/chat),
which would require a separate account/scope and transport design for broader
delivery. No EventSub connection, hidden Twitch window or new permission was added.

Kick's Pusher interface is unofficial. The nested update shape is also recorded
in the author's [published Pusher type definitions](https://gist.github.com/Digital39999/ffe7df2bfc08797c2ba19d42e8f739a0).
Tests cover that shape and the initial API shape; no live Kick request was made.
YouTube mode indicators are not added in this change.

TextExpander itself and OS accessibility/keyboard integration were not run.
Tests reproduce the reported suffix through selected-range paste in real DOM
and through Chrome/Firefox selection APIs in VM fixtures. Native Firefox was
not run; browser Firefox checks simulate the application's Firefox branch in
Chromium. Live signed-in chats were not tested.

## Changed files

| File | Purpose |
| --- | --- |
| `src/background/twitch-source.js` | Forward ROOMSTATE settings to the session sink. |
| `src/background/kick-source.js` | Forward initial and live Kick chatroom settings. |
| `src/background/service-worker.js` | Session-local partial state, stale guards, status/ready replay, leave reset. |
| `src/shared/util.js` | Format known room restrictions, including nested Kick flags. |
| `src/content/boot.js` | Forward restrictions on status and ready messages. |
| `src/content/overlay.js` | Render platform-labelled restrictions with textContent. |
| `src/content/compose.js` | Viewer shortcuts and shared copy behavior. |
| `src/content/emote-input.js` | Selection-end offsets and replacing paste. |
| `src/content/native-events.js` | Native shoutout recognition and safe channel links. |
| `src/content/overlay.css` | Independent shortcut band and wrapping mode indicators. |
| `tests/issues-88-91.test.js` | Unit/integration regressions in both browser paths. |
| `tests/issues-88-91-browser.js` | Actual DOM/hover/focus/paste/link/layout checks and JS/CSS coverage. |
| `tests/endtoend.js` | Capture modes and use the actual boot filename for coverage attribution. |
| `tests/run.js` | Register `novemberissues` in the full suite. |
| `README.md` | Unreleased behavior and limitations. |
| `docs/issues-88-91-validation.md` | This validation record. |
| `docs/handoff/65_ISSUES_88_91.md` | Local handoff; ignored by existing local exclusions. |

The pre-existing untracked AGENTS.md and screenshot directory were preserved.
No exclusion rules were changed or ignored files force-added. No new storage
key, backup schema, credentials, host permission, dependency, identity, worker
route or automatic action was introduced. PRIVACY.md remains applicable.

## Validation commands

- Baseline `node tests/run.js`: 3405 passed, 0 failed.
- After each file update, ran the corresponding local test command. Relevant
  targets included `novemberissues`, `repo`, `emoteinput`, `irc`, `kick`,
  `background`, `endtoend`, `navigation`, `modstrip`, `nativeevents`,
  `performance`, `settings`, `updatedisplay`, and `node tests/youtube-view.test.js`.
  New regressions first reproduced their missing behavior before the fix.
- Full suite and precise V8 collection:
  `$env:FCM_EMOTE_COVERAGE='<absolute dist/issues-88-91/node-coverage.json>'; node -r ./tests/emote-availability-coverage.js tests/run.js`.
  Remove that environment variable after collection.
- Targeted precise V8 collection uses the same preload with
  `node tests/issues-88-91.test.js` and `extra-coverage.json`.
- Browser fixture:
  `$env:FCM_PLAYWRIGHT_PATH='C:/Users/jrbla/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'; node tests/issues-88-91-browser.js dist/issues-88-91/browser`.
  Uses the existing bundled runtime; nothing was installed. Passes Chrome and
  simulated Firefox, dark/light themes, 280px panel, real DOM paste replacement,
  copy/reply, focus, clickable shoutout events and wrapping indicators. All
  nonlocal requests blocked; clipboard writes stubbed. All 3 changed stylesheet
  rules exercised against the exact stylesheet source.
- Combined exact-source JS gate:
  `node tests/emote-availability-coverage.js dist/issues-88-91/combined-coverage.json`.
  Combine the full-suite, targeted and browser JSON arrays before this command.
  The existing gate selects the Git diff, requires exact current source, and
  checks executable lines, functions and V8 ranges. Test files are not runtime
  coverage targets; this is changed-runtime coverage, not whole-repository coverage.
- `node tools/pack.js dist/issues-88-91/packages --target all`: built both local
  packages, 68 files each. `node tools/release.js verify-packages dist/issues-88-91/packages 1.23.12`: all good.
- `node --check` on every changed JavaScript file and `git diff --check`: passed.

## Final review

Final results: **3406 passed, zero failed** in the full suite. The combined
exact-source changed-runtime gate passes **90/90 executable lines, 16/16
functions and 114/114 V8 ranges (100% each)**. All **3/3 added CSS rules** were
exercised in the browser fixture. Targeted tests also cover selection spanning
an emote image after the full-suite collection. Evidence is in ignored
`dist/issues-88-91/full-tests.log`, `coverage.log`, the JSON coverage profiles,
and `browser/results.json` / `browser/css-coverage.json`.

Reviewed the full diff for compatibility, session/channel isolation, stale work,
partial-update semantics, permission/moderation boundaries, clipboard failures,
untrusted link/text handling, selection endpoints, layout/focus and preservation
of existing changes. The additive status/ready field tolerates older consumers.
No send, moderation or native Cheer behavior was changed.

Firefox package lint, native Firefox, live sites, actual TextExpander, signing,
publication and deployment were not run. Local unsigned packages are validation
artifacts using the unchanged version, not a new release.
