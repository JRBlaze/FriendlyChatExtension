# First-install quick-start guide

Local implementation, October 9, 2026, on the existing
`codex/issue-77-emote-availability` branch. The preceding issue #77 changes and
the user's untracked files were preserved. No commit, push or release was made.

## User experience

A fresh installation opens one focused, bundled guide with three steps:

1. Introduce Friendly Chat: merged Twitch/Kick/YouTube reading, adding other chats,
   choosing send destinations, and refreshing stream tabs opened before install.
2. Offer **Connect Twitch** and **Connect Kick**, with connected account names,
   existing OAuth flows, retry messages, and optional **Continue**. An adjacent
   **Allow YouTube access** card offers the existing optional browser permission.
   None of these three choices is required to finish. Existing connections are preserved. Website sign-in
   and extension account connection are explained as separate choices.
3. Offer **Open All Settings** or **Skip and finish**. Both lead to a completion
   message explaining how to start on a stream page. Defaults remain intact.

The popup and All Settings have permanent guide links. The guide opens once on
installation, using the existing `fcm_youtube_onboarding_v1` introduction marker
and value `1.23.0`. Reloads, restarts and ordinary updates do not reopen it.
Eligible existing-user updates still show the separate YouTube introduction;
the guide offers optional YouTube access on Step 2 and through Settings. No new
state key or setup-completion history is stored.

## Implementation and review

The background accepts `quickStartAccounts` and `quickStartConnect` only from the
bundled guide's exact extension URL, same extension ID, and top-level frame when
a frame ID is present. Query/fragment suffixes are supported. Only Twitch/Kick
are allowed. Responses contain bounded connected-account names and flags, never
tokens, raw OAuth errors, or provider details. The guide uses `textContent`.

Connect requires an explicit trusted button action. The background serializes
guide sign-ins to avoid overlapping dialogs, releases its lock after errors,
and uses `FCM.auth.connect` and existing settings. A successful new connection
updates open stream sessions with their ordinary sanitized account summary and
rejoins that platform so account-dependent capabilities refresh. Existing popup
message routes retain their behavior.

The page prevents duplicate actions while connecting, supports cancelled/failed
connections, updates after focus/auth-storage changes, ignores stale asynchronous
results, and stops state updates/listeners after leaving. Settings-open failures
leave retry and skip available. No automatic permission request, account disconnect,
preference reset, message send, or website-session mutation is added.

Reviewed the complete diff for both browser load paths, sender boundaries,
account isolation, credentials, settings/backups, stale state, packaging,
first-install/update separation, accessibility and unintended changes. The
single-quoted worker import contract, Chrome/Firefox IDs, update URLs, permissions,
OAuth scopes, worker source, manifest version and dependencies are unchanged.

## Files changed for this request

| File | Purpose |
| --- | --- |
| `src/setup/quick-start.html` | Three accessible steps, connection controls and completion screen. |
| `src/setup/quick-start.css` | Responsive three-platform cards, visible keyboard focus and reliable hidden states. |
| `src/setup/quick-start.js` | Navigation, optional connections, permission-control integration, state refresh, error handling and settings/skip completion. |
| `src/setup/youtube-access.js` | Optional YouTube permission checks and trusted-button request with denial/error/race handling. |
| `src/background/quick-start.js` | Narrow account-summary/connect handler, existing OAuth integration and connection lock. |
| `src/background/service-worker.js` | Import the handler and dispatch guide requests; refresh existing stream sessions after connection. |
| `src/background/youtube-onboarding.js` | Route first installations to the guide while preserving eligible update introductions. |
| `src/popup/popup.html` | Permanent Quick start link. |
| `src/options/options.html` | Permanent Getting started link. |
| `tests/quick-start.test.js` | UI, lifecycle integration, route security, optional YouTube control, account preservation and failure/race regressions. |
| `tests/quick-start-youtube.test.js` | Grant/deny/error, existing access, revocation, duplicate requests, queued/stale reads, and closed-page regressions. |
| `tests/quick-start-browser.js` | Shipped page in isolated browser contexts with fake extension APIs and all external traffic blocked. |
| `tests/youtube-onboarding.test.js` | Expected first-install page changed; repeat/update/storage/tab-failure checks retained. |
| `tests/run.js` | Register the quickstart suite. |
| `tests/emote-availability-coverage.js` | Include new untracked runtime files and require full coverage for them. |
| `README.md` | First-time setup instructions and updated YouTube introduction behavior. |
| `PRIVACY.md` | Local guide/account-summary behavior and unchanged marker/credential boundaries. |
| `docs/quick-start-validation.md` | This validation and file inventory. |
| `docs/handoff/47_QUICK_START_GUIDE.md` | Local handoff update; ignored under the existing exclusions. |

## Validation evidence

- Baseline `node tests/run.js`: **3372 passed, 0 failed**.
- `node tests/run.js quickstart`: passed. Exercises both real Chrome worker and
  Firefox event-page load paths, exact sender checks, unsupported platforms,
  optional/skipped logins, existing accounts, redacted responses, simultaneous
  sign-ins, failed reads/settings/OAuth, unconfirmed connection responses,
  stale reads, closed pages, storage changes, keyboard focus and completion.
- `node tests/youtube-onboarding.test.js --coverage`: **24/24 lines, 5/5 functions,
  27/27 V8 ranges**, including install/update/reload and API/storage/tab failures.
- Targeted `popup`, `options`, `firefox`, `emoteavailability`, and `repo` suites
  passed after their affected files were updated. Unit tests initially failed
  on the absent guide route/files and old install destination, then passed as
  the implementation was completed.
- Full `node tests/run.js`: **3378 passed, 0 failed**. Assertion counts from
  separately required suites are not included in the legacy runner count.
- `FCM_EMOTE_COVERAGE=<absolute-path> node -r ./tests/emote-availability-coverage.js tests/run.js`
  collects exact full VM source coverage. The same command with `quickstart`
  collects focused regression coverage; raw compatible runs can be concatenated.
  `node tests/emote-availability-coverage.js <coverage.json>` gates every
  changed executable runtime line and selected function/range, plus the entirety
  of new runtime JavaScript. Padded scopes and stale source cannot provide credit.
- The three new guide scripts individually passed **181/181 executable lines,
  31/31 functions and 216/216 V8 ranges (100%)**. Final full-suite current-source evidence
  for this guide and the preserved issue #77 fixes passed **279/279 executable
  lines, 55/55 functions and 326/326 V8 ranges (100%)**. This is new/changed runtime
  coverage, not repository-wide coverage. Final results are saved in
  `dist/quick-start/youtube-full-tests.log` and `dist/quick-start/youtube-full-coverage.json`.
- `FCM_PLAYWRIGHT_PATH=<bundled-playwright-path> node tests/quick-start-browser.js dist/quick-start/browser`:
  passed Chrome and simulated Firefox at 1120px and 360px, trusted button/keyboard
  gestures, cancelled/retried Kick flow, YouTube deny/error/grant and no prompt
  on open/skip, connected names as text, settings/skip,
  completion and review. No horizontal overflow, page errors, or external requests.
  Screenshots of welcome, accounts, narrow settings and completion were visually
  inspected; screenshots and raw browser coverage are saved in that directory.
- `node --check <file>`: passed for all changed/new JavaScript.
- `git diff --check`: passed.
- `node tools/pack.js dist/quick-start/packages --target all`: built both local
  packages with **67 files each**.
- `node tools/release.js verify-packages dist/quick-start/packages 1.23.5`:
  **all good**. These are local validation artifacts, not a published version.

## Limits and external state

Actual OAuth sign-ins and live Twitch/Kick APIs were not invoked. The guide uses
the already established sign-in implementation; new route and page tests mock
those operations. Firefox's native UI/OAuth behavior was not newly tested;
Firefox-mode browser fixtures run in installed Chrome. No new dependency install,
web-ext lint/signing, store submission, release, deployment, or production action
was performed. The existing issue #77 live-schema limitation is unchanged.

The handoff directory remains locally ignored; no exclusions were changed and
nothing was force-added. Existing untracked AGENTS.md and screenshots remain
untouched. A future release must bump the version before signing/publication.

## Welcome-page copy revision

The welcome paragraph and first-page items 02 and 03 now use the owner's exact
requested wording, including Twitch, Kick, and Youtube. The visible item 03
label reads "Sent to" as requested; this copy edit does not rename the actual
composer control or alter routing. Unit assertions cover all three exact
sentences. The isolated browser fixtures and welcome screenshots were refreshed.
No runtime JavaScript behavior changed; the existing current-source coverage
measurement remains applicable.

## Step 2 YouTube access

Step 2 now prompts for optional YouTube access alongside the Twitch/Kick
connect buttons. It checks the existing permission, shows already granted
access, and requests only https://www.youtube.com/* directly in the trusted
Allow YouTube access button event, before any await. No YouTube OAuth account
route is added. The Twitch/Kick background allowlist remains unchanged.

Grant, denial, errors and revocation update this card. Opening the guide,
entering Accounts, and skipping never request permission. Prompt and account
locks prevent overlapping actions; navigation re-enables after denial/error.
Permission events during a request queue a status recheck without requesting
again. Stale/closed-page results are ignored and listeners are removed.
Browser-managed permission state is not stored as a new extension preference.
The standalone prior YouTube access page remains available and unchanged.

Baseline for this refinement: 3377 passed, 0 failed. Updated suite: 3378 passed,
0 failed. The new permission control has 54/54 lines, 8/8 functions and 56/56
V8 ranges, all covered. Raw report: dist/quick-start/youtube-coverage-report.log.
Browser permission APIs are synthetic in tests; no actual permission grant,
OAuth sign-in, extension reload, external configuration or publication was
performed. The desktop and 360px account screenshots were visually reviewed.
