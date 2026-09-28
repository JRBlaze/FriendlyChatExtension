# YouTube badge image validation - September 28, 2026

Local work on `codex/issues-67-68`, HEAD
`e2581ab19108d5d7368a4c6585a691f78174ab56`. The owner requested actual YouTube badge
images where possible, otherwise no badge, replacing the earlier text labels.
All prior issue, reply, emote, parity and Copy message changes are retained.

## Result

Native badge renderer img src values are captured, bounded and validated using
the existing image allowlist. Recognized roles with supported image URLs render
as 16px images. Captions are accessible labels and hover titles only. Missing,
unsupported, text-only or failed badges are omitted. No MEMBER/MOD/OWNER/VERIFIED
text replacement, generic YouTube role chip or invented stock icon is rendered.
Failed images remove themselves and their empty badge wrapper. Working siblings
remain. Emote errors still preserve their text alternatives.

The existing Badges toggle applies. Copy message remains body-only. No badge
data grants moderation, membership or sending rights. The reader does not clone
YouTube SVG/HTML; non-image native markup is omitted under the owner's requested
fallback. Availability depends on the captured markup and supported image URL.

Up to four recognized distinct role images are transported as optional
`youtubeBadges: [{ type, label, url }]`, with 100-character captions and the existing
2048-character URL cap. Old text-only metadata is discarded without losing the
message. Images use no-referrer. No new hosts, permissions, storage keys, backup
fields, credentials, worker routes or release versions were added.

## Validation

Baseline and final `node tests/run.js`: **3,365 passed, 0 failed**, exit 0.
Logs are temporary `fcm-youtube-badges-baseline.log` and
`fcm-youtube-badges-full.log`.

| Command | Result |
| --- | --- |
| `node tests/youtube-reader.test.js` | Parser/validator assertions passed |
| `node tests/youtube-view.test.js` | Rendering, fallback removal, copy and shared menu regressions passed |
| `node tests/youtube-transport.test.js` | Actual-source synthetic reader/relay/host assertions passed |
| `node tests/youtube-controls.test.js` | Forwarding and controls assertions passed |
| `node tests/run.js render` | 190 passed, zero failed |
| `node tests/run.js theme` | 14 passed, zero failed |
| `node tests/run.js repo` | 14 passed, zero failed after each documentation update |
| `node --check` on the seven changed JavaScript files below | Passed |
| `git diff --check` | Clean |
| `node tests/youtube-browser.js dist/youtube-badges/view-browser` | Chrome and simulated Firefox branches passed on Twitch and Kick layouts |
| `node tests/youtube-send-browser.js dist/youtube-badges/send-browser` | All four mode/host combinations passed |
| `node tests/youtube-options-browser.js dist/youtube-badges/options-browser` | Both modes passed |

Browser scripts use the existing bundled Playwright via `FCM_PLAYWRIGHT_PATH`.
They execute installed Chrome with isolated local fixtures, block external
requests and fulfill synthetic image URLs with a local fixture image. They check
loaded badge images, exact dimensions, blank visible text, no-referrer, accessible
captions, unsupported/missing/failed-image omission, working sibling retention,
empty-wrapper removal, existing badge visibility and body-only clipboard copying.
The generated compact-feed screenshot was inspected; its image is a fixture,
not a shipped replacement badge. No system clipboard or real chat was changed.

Coverage command:

```text
node tests/release-coverage.js --changed-only dist/youtube-badges/node-coverage.json dist/youtube-badges/send-browser/browser-coverage.json dist/youtube-badges/view-browser/browser-coverage.json dist/youtube-badges/options-browser/browser-coverage.json
```

Passed: **350/350 executable lines, 43/43 functions, 388/388 V8 ranges** across
the complete current JavaScript diff. Render contributes 54/54 lines, 7/7
functions, 59/59 ranges; shared YouTube contributes 82/82, 8/8 and 119/119. Other
files retain the Copy message report's counts. This is **100% changed-JavaScript
coverage**, not whole-repository coverage. Inherited working changes are included;
no gate exclusions or weakening were introduced. Browser captures match current
runtime source. CSS is checked with unit/browser assertions, not V8 instrumentation.

## Changed files in this follow-up

| File | Change |
| --- | --- |
| `src/shared/youtube.js` | Capture img src and require a validated image URL in badge metadata |
| `src/content/render.js` | Image-only badges, omit role text fallback, remove failed badge images |
| `src/content/overlay.css` | Remove obsolete YouTube text-badge styling |
| `tests/youtube-reader.test.js` | Real-image metadata, missing/invalid images, duplicate roles and transport-compatible validation |
| `tests/youtube-view.test.js` | Image markup, escaping, all supported roles, no text fallback, failed-image/wrapper cleanup |
| `tests/youtube-transport.test.js` | Badge URL survives synthetic reader/relay/host sanitation |
| `tests/youtube-controls.test.js` | Image URL forwarding assertion |
| `tests/youtube-browser.js` | Loaded/failed/text-only badge fixtures, dimensions, visibility and copy regression |
| `README.md` | Image-only support and omit-on-failure behavior |
| `PRIVACY.md` | Badge image requests, bounds and no text fallback |
| `VALIDATION-youtube-badges.md` | This evidence record |
| `docs/handoff/32_YOUTUBE_CHAT_PARITY.md` | Superseding behavior pointer; locally ignored |
| `docs/handoff/34_YOUTUBE_BADGE_IMAGES.md` | Current badge contract; locally ignored |

Earlier reports enumerate the inherited working changes. Pre-existing AGENTS.md
and store screenshots are untouched. Handoffs and artifacts remain ignored;
exclusions were not changed and nothing was force-added.

## Review and limits

Final review covered image URL/metadata boundaries, text removal, failure cleanup,
accessibility captions, existing Twitch/Kick behavior, privacy and test evidence.
No remaining actionable defect was identified. This local change is not published.
Native Firefox and live YouTube DOM/CDN behavior remain unverified. Some badges
may be omitted because YouTube does not expose a supported image. No live
messages, account changes, moderation, purchases, installs, external CI, Firefox
lint, signing, deployment, release, store submission, commit or push occurred.
The full suite includes local package/startup checks, which are not deployment.
