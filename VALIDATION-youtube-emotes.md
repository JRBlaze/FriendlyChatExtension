# YouTube emote rendering — local implementation

September 28, 2026; Windows, Node v24.19.0.
Branch `codex/issues-67-68`, base `e2581ab19108d5d7368a4c6585a691f78174ab56`.
Earlier local issue fixes and mention replies are preserved; their reports remain
historical records. No commit, push or release was performed.

## Behavior

The reader previously reduced every image to its alt text. It now retains up to
32 native message emotes as validated image URLs with UTF-16 text positions.
Normal YouTube emoji and channel emote images can render inline in the merged
feed. Mixed text, Unicode, repeated images and emote-only messages are supported.
Hover previews use the captured YouTube image, even when Twitch/Kick have the
same emote name. The existing emote layout bounds apply.

Only `img.emoji` inside a captured message is eligible. Author avatars and badge
images are not promoted. Accepted URLs use HTTPS on `yt3.ggpht.com`,
`yt3.googleusercontent.com`, or the static `www.youtube.com/s/gaming/emoji/`
directory. Credentials, custom ports, queries, fragments, arbitrary hosts and
unsafe schemes are refused. URLs are capped at 2,048 characters and emote alt
text at 100 characters. Text/node/batch budgets remain bounded. The reader,
background relay, host and renderer validate the metadata; extra HTML and fields
never become markup. Older text-only messages remain supported.

Unsupported, malformed or excess image metadata leaves readable text. Failed
image downloads are replaced with text nodes without retrying. Rendered images
and hover previews use `no-referrer`. Image requests may use normal browser
network/cookie/cache policies, documented in PRIVACY.md. Metadata remains in
memory with the feed; no extension storage, sync or backup changes were added.

This change renders received emotes. It adds no YouTube emote picker, membership
entitlement lookup, emote sending, badge rendering or Super Sticker support.

## Validation

Tests ran after every file update. Baseline full suite: 3,365 passed, zero failed.
An intermediate full run found the old issue #64 test fixture did not load the
shared YouTube parser; the fixture now follows the production script dependency.
Final full suite: **3,365 passed, zero failed**, including registered standalone
suites whose internal assertions are not individually included in that count.

| Command | Result |
| --- | --- |
| `node tests/run.js` | Passed full suite |
| `node tests/youtube-reader.test.js` | Passed URL validation, normalization, bounds, Unicode offsets, emote-only/mixed/repeated images, unsafe/malformed metadata and parser/reader regressions |
| `node tests/youtube-transport.test.js` | Passed real parser/reader/relay/host metadata delivery and existing lifecycle/send regressions |
| `node tests/youtube-view.test.js` | Passed image rendering, escaping, failed-image text fallback and mention/moderation boundaries |
| `node tests/youtube-controls.test.js` | Passed metadata forwarding and source lifecycle |
| `node tests/youtube-sending-ui.test.js` | Passed hover provider isolation/referrer policy and existing reply/send regressions |
| `node tests/issue-64.test.js` | Passed Gigantify regression with production shared-parser dependency |
| `node tests/youtube-permission.test.js` | Passed help/product/privacy regressions |
| `node tests/run.js repo` | 14 passed, zero failed |
| `node tests/youtube-browser.js dist/youtube-emotes/view-browser` | Passed both host layouts and Chrome/simulated Firefox modes; inline images, bounds, text fallback, hover source, themes and existing merge flows |
| `node tests/youtube-send-browser.js dist/youtube-emotes/send-browser` | Passed four host/mode combinations, recent emotes and mention replies |
| `node tests/youtube-options-browser.js dist/youtube-emotes/options-browser` | Passed both modes, settings, links, backups and narrow layout |
| `git diff --check` | Passed |

Browser tests used the existing Playwright installation through
`FCM_PLAYWRIGHT_PATH` and installed Chrome headlessly. All external network traffic
was blocked. The designated synthetic YouTube image URLs were fulfilled locally
with the repository's icon; no remote image was downloaded. Screenshots therefore
verify layout and rendering, not the appearance of a real channel's emotes.
The dark screenshot was visually inspected. No dependency was installed.

Exact-source coverage command:

```powershell
node tests/release-coverage.js --changed-only dist/youtube-emotes/node-coverage.json dist/youtube-emotes/send-browser/browser-coverage.json dist/youtube-emotes/view-browser/browser-coverage.json dist/youtube-emotes/options-browser/browser-coverage.json
```

| Runtime file | Changed executable lines | Functions | V8 ranges |
| --- | ---: | ---: | ---: |
| `src/content/compose.js` | 93/93 | 20/20 | 93/93 |
| `src/content/overlay.js` | 44/44 | 3/3 | 61/61 |
| `src/content/render.js` | 20/20 | 2/2 | 20/20 |
| `src/content/youtube-controls.js` | 3/3 | 0/0 | 0/0 |
| `src/options/options.js` | 1/1 | 0/0 | 0/0 |
| `src/shared/constants.js` | 3/3 | 0/0 | 0/0 |
| `src/shared/youtube.js` | 43/43 | 4/4 | 64/64 |
| `src/youtube/permission.js` | 1/1 | 0/0 | 1/1 |
| **Combined working diff** | **208/208** | **29/29** | **239/239** |

This is 100% changed-JavaScript coverage, including earlier #67/#68 and mention
reply changes, not repository-wide coverage. Current exact-source browser captures
were regenerated. No coverage exclusions or gate weakening were added.

## Files changed in this follow-up

| File | Change |
| --- | --- |
| `src/shared/youtube.js` | Image URL/range validation, bounded extraction and transport sanitation |
| `src/content/youtube-controls.js` | Forward image metadata into the feed |
| `src/content/render.js` | Escaped image rendering and error-to-text fallback |
| `src/content/overlay.js` | YouTube-specific hover source and referrer policy |
| `tests/youtube-reader.test.js` | Parser/validator edge cases |
| `tests/youtube-transport.test.js` | End-to-end synthetic transport of image metadata |
| `tests/youtube-view.test.js` | Rendering, fallback and escaping assertions |
| `tests/youtube-controls.test.js` | Metadata forwarding assertion |
| `tests/youtube-sending-ui.test.js` | Hover image/provider isolation assertions |
| `tests/youtube-browser.js` | Synthetic image fixtures and browser assertions/screenshots |
| `tests/issue-64.test.js` | Load shared parser in the renderer fixture |
| `README.md` | Rendering support and limitations |
| `PRIVACY.md` | Image requests and in-memory metadata |
| `VALIDATION-youtube-emotes.md` | This evidence/review record |
| `docs/handoff/30_YOUTUBE_MENTION_REPLIES.md` | Pointer to the new rendering contract; locally ignored |
| `docs/handoff/31_YOUTUBE_EMOTE_RENDERING.md` | Current rendering handoff; locally ignored |

## Review and limits

Final diff review covered bounds, text positions, sanitization, compatibility,
failed downloads, source isolation, routing, permissions and data handling. No
remaining actionable defect was identified. Existing identity, manifests,
permissions, storage keys, backup format, worker routes, credentials and release
versions were preserved. Pre-existing `AGENTS.md` and store screenshots were
untouched. Handoffs remain ignored; no exclusion or force-add change was made.

Live YouTube DOM/CDN loading and native Firefox were not tested. Current platform
DOM changes, unrecognized image hosts and host-page network policies can cause
text fallback. Public source examples informed the native `img.emoji` format,
but are not current live-browser evidence. No authenticated page, live message,
purchase, moderation, account change or production service was exercised.
External CI, Firefox lint, signing, publication and store submission were not run.
Artifacts and logs are in the ignored `dist/youtube-emotes/` directory.
