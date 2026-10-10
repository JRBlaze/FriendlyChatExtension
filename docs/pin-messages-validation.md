# Moderator message pinning — local validation

User request: moderators should be able to pin chat messages. User explicitly
selected Kick native controls after reviewing its missing public pin API.
Local work continues on codex/issue-77-emote-availability, HEAD
`a4af0587c2c062151feec8f1984cb53396b8254f`, source version 1.23.5.
Earlier issue #77, setup, visual highlights and optional sound changes are retained.

## Implemented behavior

Twitch moderator/broadcaster rows receive a **Pin** hover shortcut for five minutes.
The username menu offers **Pin this message for 5 minutes**, **Pin this message
until stream ends**, and **Unpin this message**. Labels explain that a new pin
replaces the channel pin and unpin applies only if this message is currently pinned.
Missing message IDs disable menu actions and omit the shortcut. Nonmoderators,
Kick rows and YouTube rows receive no pin controls.

The existing worker channel-standing check still runs before moderation. Twitch
checks the connected account's authority and channel pin permission. The existing
`moderator:manage:chat_messages` OAuth scope is reused. Pin uses PUT and unpin
uses DELETE on `/helix/chat/pins`, with encoded channel, moderator and message IDs.
Optional duration must be an integer from 30 to 1800 seconds; omission means
until the stream ends. There is no automatic retry or permanent-ban fallback.
Kick pin/unpin rejects before reading a credential or performing a request.

These are native channel-wide Twitch pins. Success/refusal uses the existing
feed notices/toasts. The host Twitch native banner is handled by existing native
highlight placement; counterpart pins are not mirrored into the merged feed.
No pin state, text or message history is stored, synced or backed up. No new host
permission, storage key, dependency, worker service contract or release version.

Primary-source contracts checked October 9, 2026:
- [Twitch Pin Chat Message](https://dev.twitch.tv/docs/api/reference/#pin-chat-message)
- [Twitch Unpin Chat Message](https://dev.twitch.tv/docs/api/reference/#unpin-chat-message)
- [Kick public pin API request, still open](https://github.com/KickEngineering/KickDevDocs/issues/417)

## Files changed for this request

| File | Purpose |
| --- | --- |
| `src/background/moderation.js` | Explicit pin/unpin allowlist, Twitch requests, validation, Kick rejection and outcome wording. |
| `src/content/compose.js` | Moderator menu actions and five-minute hover shortcut. |
| `tests/pin-messages.test.js` | Exact-source API and UI tests, failures/durations, stale moderator standing and both background load paths. |
| `tests/pin-messages-browser.js` | Actual DOM/CSS controls, menu callbacks, disabled IDs and narrow width in isolated browser fixtures. |
| `tests/youtube-view.test.js` | Export existing synthetic fixture helpers for new pin UI tests. |
| `tests/run.js` | Register pin suite; update explicit allowlist/strip expectations and select Ban by its class. |
| `README.md` | Explain native Twitch pin behavior, Kick choice and display limitations. |
| `PRIVACY.md` | Describe IDs/duration sent to Twitch only on explicit moderation action. |
| `docs/pin-messages-validation.md` | Evidence and review record. |
| `docs/handoff/50_TWITCH_MESSAGE_PINS.md` | Locally ignored handoff supplement. |

## Validation

- Baseline `node tests/run.js`: **3381 passed, 0 failed**.
- Local commands after affected file updates: `node tests/run.js pinmessages`,
  `moderation`, `modstrip`, `youtube` and `repo`; all final targeted runs pass.
  Initial new pin tests failed as expected before implementation. Fixture setup,
  old allowlist/last-button expectations and browser menu-dismiss sequencing were
  repaired; corresponding checks passed on rerun. Test-runner LF endings were
  restored after an editing script caused unrelated CRLF diff churn.
- Full instrumented `node -r ./tests/emote-availability-coverage.js tests/run.js`
  with `FCM_EMOTE_COVERAGE` set to the absolute full-coverage.json path:
  **3382 passed, 0 failed**. The runner count includes one new suite-level check;
  that suite additionally executes its own assertions.
- Exact-source coverage gate `node tests/emote-availability-coverage.js dist/pin-messages/combined-coverage.json`:
  **460/460 executable lines, 97/97 functions, 533/533 V8 ranges (100%)** for all
  current new/changed runtime, including the earlier retained features. This is
  changed-code coverage, not whole-repository or HTML/CSS coverage. Raw profiles
  combine the full/focused Node runs and exact matching browser profiles; stale
  sources are excluded. The Twitch moderation change is **22/22 lines,
  1/1 function, 39/39 ranges**; composer cumulative changes are **29/29 lines,
  6/6 functions, 25/25 ranges**. Previously uncovered shared moderation branches
  received additional unit assertions and passed the gate on rerun.
- Final ordinary `node tests/run.js` rerun: **3382 passed, 0 failed**
  (`dist/pin-messages/final-tests.log`).
- `FCM_PLAYWRIGHT_PATH=<bundled Playwright path> node tests/pin-messages-browser.js dist/pin-messages/browser`:
  passed in isolated Chrome and simulated Firefox at 320px. Actual composer and
  CSS render; outbound moderation callbacks are synthetic. Remote traffic is
  blocked. Screenshots and raw V8 coverage are in that directory.
- `node --check` on moderation.js, compose.js and both new pin test scripts;
  `git diff --check`: passed.
- `node tools/pack.js dist/pin-messages/packages --target all`: Chrome ZIP and
  unsigned Firefox XPI built, **68 files each**.
- `node tools/release.js verify-packages dist/pin-messages/packages 1.23.5`:
  **all good**. These are local validation artifacts, not a published release.

## Final diff review and limits

Reviewed exact message/channel routing, duration semantics, error handling,
explicit action allowlists, moderator checks, absence of Kick/YouTube API calls,
credential isolation, no new scopes or persistence, existing ban confirmation,
menu accessibility/width, tests and compatibility. No actionable findings remain.
Earlier changes have separate validation documents linked by this task's history.

Live Twitch pin permissions/API success and native Firefox interactions were not
verified; no real messages were pinned/unpinned or moderated, no OAuth performed,
no production services changed. Native banner handling is existing behavior;
no new cross-platform banner synchronization is claimed. No signing, upload,
publication, commit or push occurred. Handoff remains ignored; no exclusion was
changed and nothing was force-added. Existing AGENTS.md and screenshots preserved.
