# Optional mention and highlight sound

Local implementation, October 9, 2026, on the existing development branch.
Prior fixes, the quick-start guide and stronger highlight styles are preserved.

## Result

**Mention and highlight sound** is a new checkbox in All Settings and the stream
panel's Settings. It defaults to **false**. Both surfaces have **Preview sound**,
which works without enabling alerts or changing preferences.

The generated chime uses quiet C5/E5 sine notes (523.25 and 659.25 Hz), gently
ramped gain, and about 0.26 seconds of sound. Peak note gains are 0.045 and 0.032.
There is no downloaded/licensed sound file or added dependency. An offline-rendered
sample is `dist/mention-sound/browser/soft-chime.wav`.

Accepted live rows with the existing `fcm-mentioned` class can alert. Duplicate
IDs, history, hidden platform rows, deleted rows and the existing own-post
exemption remain silent. Twitch/Kick batch replays are explicitly marked history.
YouTube's initial scan marks its captured rows as history until the reader is
ready; the existing bounded sanitizer/controls preserve only a true optional
history flag. Later rows can alert, including the first live row after an empty
initial ready snapshot. The flag is transient and does not change visible chat.

The background permits at most one alert per five seconds across registered
top-level chat tabs. It verifies the extension ID, frame and host session, checks
the persisted opt-in, and retains only an in-memory timestamp. Requests contain
only a command, never message text, usernames or configured words. It generates
no audio itself, does not persist alert history, and creates no scheduled job.

Playback remains on the chat page. No audio context is allocated while off,
except an explicit Preview. After enabling/reloading or moving to a pop-out,
a trusted click/key interaction arms that document's audio. Suspended/unavailable
audio is skipped without a delayed queue or automatic retry. This respects
[Chromium's user-activation policy](https://www.chromium.org/audio-video/autoplay/).
Gain envelopes use Web Audio ramp methods to avoid abrupt changes, following
the [GainNode guidance](https://developer.mozilla.org/en-US/docs/Web/API/GainNode).
Disabling closes the context; destruction removes listeners; window adoption
rebinds to the current document. Browser/device mute settings still apply.

The boolean follows normal settings sync and version-1 backup/import semantics.
No storage key, identity, permission, OAuth scope, worker endpoint or release
version changed. The manifest adds only the local shared controller to the
existing ordered content-script list.

## Files changed for this request

| File | Change |
| --- | --- |
| `src/shared/mention-sound.js` | Local chime synthesis, gesture-controlled audio, lifecycle and alert eligibility. |
| `src/shared/constants.js` | Add the off-by-default `mentionSound` boolean. |
| `manifest.json` | Load the local shared controller in content scripts. |
| `src/content/feed.js` | Optional accepted-message callback after deduplication; notification errors cannot interrupt chat. |
| `src/content/overlay.js` | Controller integration, settings toggle/Preview, rebind/cleanup and silent history batches. |
| `src/background/service-worker.js` | Validated cross-tab five-second alert gate. |
| `src/content/youtube-reader.js` | Identify initial captured history. |
| `src/shared/youtube.js` | Preserve the optional true history flag through the existing sanitizer. |
| `src/content/youtube-controls.js` | Forward that flag to the merged feed. |
| `src/options/options.html` | Toggle, Preview/status and shared controller script. |
| `src/options/options.js` | Bind the preference, preview and cleanup. |
| `tests/mention-sound.test.js` | Controller, graph, eligibility, lifecycle, feed/gate, backup and overlay regressions. |
| `tests/mention-sound-browser.js` | Browser UI/preview/persistence/quietness checks and native offline waveform. |
| `tests/mention-highlight.test.js` | Load the actual backup-related shared schema in its reusable fixture. |
| `tests/youtube-reader.test.js` | Expose its existing synthetic row builder for initial/live-history regressions. |
| `tests/youtube-controls.test.js` | Verify history metadata reaches the feed. |
| `tests/youtube-sending-ui.test.js` | Observe incoming messages and mock the audio controller in the existing overlay fixture. |
| `tests/issue-fixes.js` | Supply the new optional refresh collaborator to extracted pop-out scopes. |
| `tests/harness.html` | Load the shared controller in the isolated overlay harness. |
| `tests/run.js` | Register the mentionsound suite. |
| `README.md`, `PRIVACY.md` | Explain opt-in playback, history/cooldown, gesture requirements and data boundaries. |
| `docs/mention-sound-validation.md` | This review/evidence record. |
| `docs/handoff/49_OPTIONAL_MENTION_SOUND.md` | Locally ignored handoff supplement. |

## Validation

- Baseline full suite: **3379 passed, 0 failed**.
- `node tests/run.js mentionsound`: passed. Covers opt-out, explicit preview,
  untrusted actions, silent arming, history/filter/deletion exclusions, denied
  gate, failed requests, missing/failed audio APIs, soft gain/duration, node
  cleanup, disabled/destroyed/moved documents, coalescing, persisted settings,
  feed deduplication, YouTube initial/live history and both background load paths.
- Appropriate targeted suites passed after file updates: `defaults`, `feed`,
  `options`, `updatedisplay`, `issuefixes`, `repo`, `firefox`, YouTube reader/
  controls, and the overlay UI fixture. Development fixture failures (missing
  backup schema/clip helper/new refresh collaborator and a harness-ready race)
  were corrected and the checks rerun.
- Full `node tests/run.js`: **3381 passed, 0 failed**. Separately required suite
  assertions are not included in the legacy runner count.
- Exact-source coverage collected by
  `FCM_EMOTE_COVERAGE=<absolute-path> node -r ./tests/emote-availability-coverage.js tests/run.js`
  and the same command with `mentionsound`, combined with current browser raw
  coverage. `node tests/emote-availability-coverage.js dist/mention-sound/combined-coverage.json`
  passes **421/421 executable lines, 92/92 functions and 487/487 V8 ranges (100%)**
  for all current new/changed runtime including earlier retained work. The new
  audio module itself has **68/68 lines, 16/16 functions, 80/80 V8 ranges**.
  This is not repository-wide or HTML/CSS coverage. Reports and raw runs are in
  `dist/mention-sound/`.
- `FCM_PLAYWRIGHT_PATH=<bundled-path> node tests/mention-sound-browser.js dist/mention-sound/browser`:
  Chrome and simulated Firefox pass both settings surfaces, off-by-default,
  Preview without enabling, sync persistence, trusted/untrusted gestures,
  unsupported audio, disabled/history/duplicate/hidden/self rows and burst
  coalescing. Speaker output is mocked. The same shipped tone scheduler was
  additionally rendered using native OfflineAudioContext into the WAV sample,
  with nonzero samples and peak magnitude below 0.06. All remote traffic was
  blocked; the legacy overlay harness's sample remote images were not fetched.
- `node --check <file>` and `git diff --check`: passed.
- `node tools/pack.js dist/mention-sound/packages --target all`: both local
  packages built with **68 files each**.
- `node tools/release.js verify-packages dist/mention-sound/packages 1.23.5`:
  **all good**. These retain the source version and are local validation artifacts.

## Final review and boundaries

Reviewed opt-in persistence, context/oscillator cleanup, autoplay guards,
deduplication, history propagation, filters/own posts, cross-tab coalescing,
race/error handling, pop-out rebinding, schema compatibility, script ordering,
Chrome/Firefox loading, permissions, credentials and unintended changes.
The additive YouTube flag is optional; older batches without it remain valid.
Existing paid-send/no-retry and moderation rules are unchanged.

Live platform accounts/chats and native Firefox audio were not newly tested.
Browser UI uses isolated Chrome contexts with synthetic audio output and APIs;
offline rendering verifies the actual waveform without sending sound to speakers.
No real messages, sign-in, permissions, moderation, extension reload, signing,
publication, store submission, worker deployment, commit or push was performed.
The handoff remains ignored; no exclusion was changed or file force-added.
