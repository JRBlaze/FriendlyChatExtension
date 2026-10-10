# Issue #77: subscription emote availability

Local implementation on `codex/issue-77-emote-availability`, based on
`a4af0587c2c062151feec8f1984cb53396b8254f` (version 1.23.5), October 9, 2026.
GitHub had one open issue: [#77](https://github.com/JRBlaze/FriendlyChatExtension/issues/77).
The owner confirmed the report affects both Twitch and Kick.

## Problem and resulting behavior

Native emote stores previously only grew. Cached Twitch entitlements survived a
fresh smaller response, IRC emote-set snapshots only added IDs, and channel
catalogs and emotes received from other viewers were offered as usable emotes.
The recent bar and favorites both consumed those stores, so they retained entries
after access expired.

Fresh native snapshots now replace selection availability while preserving
pictures for reading chat. Cached native entries are disabled until a fresh
response arrives, and a late cache cannot overwrite a fresh native list. Smaller
Twitch responses replace the cache. Rejoins revoke the prior selection state
before loading; leaving clears the account's IRC set IDs. Empty IRC emote-set
tags revoke sets, while absent tags do not change them.

A completed Twitch user-emote response is authoritative over channel catalogs
and stale IRC sets. Current IRC sets remain a fallback when the user endpoint
cannot complete. This follows the distinction in the
[Twitch API reference](https://dev.twitch.tv/docs/api/reference/#get-user-emotes)
and [IRC migration guide](https://dev.twitch.tv/docs/chat/irc-migration/).

Kick parsing retains the existing `subscribers_only` flag. Watched-channel paid
emotes require an explicit boolean `is_subscribed` or `is_broadcaster` from the
same session's `/api/v2/channels/<channel>/me` response. A moderator flag grants
no paid-emote access. The background uses its existing Kick session headers for
merged Kick on Twitch; Kick pages use their own tab session, retaining Firefox
container isolation. The additional standing request occurs only for a signed
list containing watched-channel subscriber-only emotes. Redirects are refused.
Unknown, failed, or non-boolean standing leaves those emotes hidden; free emotes
and reading remain available. Kick documents active subscription access in its
[emote guide](https://help.kick.com/en/articles/7113467-how-to-add-or-edit-kick-emotes).
The current live response schema was not newly verified.

Favorites, recent names, their order, and all existing storage keys remain intact.
Renewed access makes saved names visible again. Same-name available alternatives
on the other platform or in third-party sets remain selectable. Open picker and
autocomplete views refresh, and stale picker/recent buttons recheck eligibility.
Received Kick emotes marked `learned` remain available for reading but never
grant picker access.

## Changed files

| File | Change |
| --- | --- |
| `src/background/emotes.js` | Separate catalog pictures from Twitch user/IRC availability; completed user response wins. |
| `src/background/service-worker.js` | Add optional native snapshot metadata; replace IRC sets; disable cached availability; keep newest smaller cache; revoke state on joins/leaves. |
| `src/background/twitch-source.js` | Process explicitly empty emote-set tags. |
| `src/background/discovery.js` | Check Kick watched-channel subscriber availability with the same signed session. |
| `src/shared/emote-parsers.js` | Retain subscriber-only metadata and apply narrow subscription/broadcaster checks. |
| `src/content/boot.js` | Forward snapshot metadata and apply Kick access using the tab's own session. |
| `src/content/render.js` | Reconcile selection state while retaining render images and updating the emote index version. |
| `src/content/compose.js` | Filter unavailable/learned emotes, recheck stale selections, refresh open picker/autocomplete. |
| `src/content/overlay.js` | Forward snapshots and refresh both controls. |
| `tests/emote-availability.test.js` | Actual-source unit and Chrome/Firefox background-load, content, picker, recent-bar, and overlay regressions. |
| `tests/emote-availability-coverage.js` | Exact-source V8 collector and current Git-diff coverage gate, reusing the existing tested coverage implementation. |
| `tests/run.js` | Register regressions and revise old tests that intentionally offered other viewers' learned emotes. |
| `tests/youtube-sending-ui.test.js` | Expose existing isolated overlay fixture and observe snapshot/picker-refresh calls. |
| `README.md` | Document availability, preserved saved names, refresh timing, and failure behavior. |
| `PRIVACY.md` | Describe the current availability check and credential boundary. |
| `docs/issue-77-validation.md` | This review and validation record. |
| `docs/handoff/46_ISSUE_77_EMOTE_AVAILABILITY.md` | Local handoff update, ignored by the existing repository exclusion. |

## Validation

- Baseline `node tests/run.js`: **3370 passed, 0 failed**.
- The initial new regression failed against the old merge-only behavior, proving
  that a missing expired emote remained selectable.
- `node tests/run.js emoteavailability`: passed; includes coverage-gate self-tests,
  stale cache/cell checks, renewal, malformed records, empty IRC snapshots,
  smaller cache replacement, account/channel isolation, Kick free/subscribed/
  broadcaster/moderator/unknown cases, and HTTP/JSON/network/storage failures.
- Relevant targeted suites passed after file updates: `compose` (74), `kick`
  (49), `twitchEmotes` (21), `discovery` (59), `fallbacks` (30), `navigation` (40),
  `background` (64), `emoterace` (5), `reload` (13), `recentemotes`, `youtube`,
  and `repo` (14). Legacy counts omit assertions inside separately required suites.
- Full `node tests/run.js`: **3372 passed, 0 failed**. A prior development run
  failed because the new socket fixture lacked a `status` callback; that fixture
  was corrected and its regression rerun successfully.
- Coverage collection:
  `FCM_EMOTE_COVERAGE=<absolute-output.json> node -r ./tests/emote-availability-coverage.js tests/run.js`.
  The same command with `emoteavailability` collects focused regressions.
  `node tests/emote-availability-coverage.js <coverage.json>` checks exact full VM
  sources against every changed executable runtime line and selected V8
  function/range. Stale or padded scopes cannot provide coverage credit. The earlier combined run
  partitioned the same covered code into 101 V8 ranges; the final single run
  has 100 ranges, all covered.
- Final full-suite current-source coverage: **84/84 executable lines, 20/20 functions,
  100/100 V8 ranges (100%)**. This is changed runtime coverage; repository-wide
  coverage is not claimed. The final full-suite coverage artifact is
  `dist/issue-77/final-node-coverage.json`; full output is
  `dist/issue-77/final-tests.log`.
- `node --check <file>` passed for every changed/new JavaScript file.
- `git diff --check`: passed.
- `node tools/pack.js dist/issue-77/packages --target all`: both local packages
  built (62 files each).
- `node tools/release.js verify-packages dist/issue-77/packages 1.23.5`: **all good**.

## Final review and boundaries

Reviewed the complete runtime/test/documentation diff for account/channel
isolation, permissions, storage/backups, API failure behavior, stale controls,
native-send retries, and Chrome/Firefox compatibility. No new host permissions,
OAuth scopes, dependencies, worker routes, account rights, storage keys, or
manifest identity/version changes are introduced. The optional `replace` field
is additive; older content scripts ignore it. No credentials are put in emote
payloads or logs. Existing favorites and recent histories are preserved.

Live Twitch/Kick browser and API tests, native Firefox UI verification,
Firefox web-ext lint, signing, publication, store submission, and deployment
were not run. Browser-mode fixtures are not native Firefox or live-site proof.
Kick is an undocumented integration: unexpected standing fields fail closed,
and may hide otherwise entitled watched-channel paid emotes until a supported
response is available. There is no new continuous entitlement poll; changes are
applied on the existing join/reconnect/load triggers or a page reload. Cancelled
renewal is not expiry while the platform still grants access.

`docs/handoff/` remains locally ignored; no exclusion was changed or file
force-added. The pre-existing untracked `AGENTS.md` and screenshot directory were
preserved. No commit, push, PR, issue closure, release, or production change was
performed. The local packages retain 1.23.5 and are validation artifacts; a
future release must use a higher version before signing/publication.
