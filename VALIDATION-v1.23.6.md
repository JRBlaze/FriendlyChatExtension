# v1.23.6 release preparation and validation

This release fixes stale Twitch/Kick emote availability (issue #77) and includes
first-install quick start, clearer mentions/custom highlights, an optional soft
mention chime, Twitch moderator pin/unpin controls, and compact overlay menus.
Kick pinning remains in native controls by explicit user choice.

## Local evidence

- Full suite on the prepared source: `node tests/run.js`, 3383 passed, 0 failed.
- Corresponding unit suites cover emoteavailability, quickstart, mentionhighlight,
  mentionsound, pinmessages, compactoverlay and release notes. Targeted repository,
  moderation, YouTube, defaults, options, feed and Firefox loading checks passed
  after affected file changes. New version/README/notes checks pass.
- Exact-source V8 coverage for all new/changed JavaScript runtime: 460/460
  executable lines, 97/97 functions, 533/533 ranges (100%). This measures changed
  runtime, not repository-wide coverage or every possible live platform state.
- All 34 changed compact-layout CSS rules were exercised; 76 synthetic geometry
  cases passed across Twitch/Kick, Chrome/simulated Firefox, both themes, widths
  240/280/340px, text sizes 10/14/22 and short laptop-height panels. Chat gains
  57–124px in these fixtures. Native disclosures retain keyboard operation,
  discovery notices, destinations, replies, draft input and one-row recent emotes.
- Quick-start/account/access, highlight contrast, local audio waveform/preview,
  stale emote availability and native pin request/error boundaries were verified
  using isolated fixtures with remote traffic blocked. Sound starts off and uses
  a five-second shared cooldown; initial history, duplicates and hidden rows stay
  silent. No credentials are exposed to the guide or content-script responses.
- Bundled release notes now include 1.23.6; unit checks and responsive 375/1100px
  light/dark screenshots passed with seven version sections.
- Syntax and `git diff --check`: passed.
- Local Chrome/unsigned Firefox packages: 68 files each;
  `node tools/release.js verify-packages <packages> 1.23.6`: all good.
- Chrome Web Store ZIP built separately; it is not a second public release asset.

Detailed local records: [emote availability](docs/issue-77-validation.md),
[quick start](docs/quick-start-validation.md),
[visual highlights](docs/mention-highlight-validation.md),
[sound](docs/mention-sound-validation.md),
[pins](docs/pin-messages-validation.md),
[compact layout](docs/compact-overlay-validation.md). Those records describe their
local validation phase; publication is a subsequent operation.

## Compatibility and review

Reviewed the full source/test/documentation diff for isolation, optional access,
permissions, credentials, storage/backup semantics, SPA cleanup, stale replies,
moderator standing, explicit action allowlists, audio cleanup/cooldown and package
ordering/identity. Existing data and account connections are preserved. No worker
service or deployment change, new host permission, OAuth scope or dependency.

Native Firefox UI and live Twitch/Kick API interactions were not newly tested.
Firefox lint and Mozilla signing are performed by the tag-driven release workflow.
Kick emote standing fields are an undocumented integration and fail closed when
unrecognized; availability refresh uses joins/reconnects/reloads rather than a new
continuous poll. Twitch enforces pin permission in addition to existing standing
checks. Pins are native channel-wide actions, not mirrored counterpart banners.

## Publication verification procedure

After merge and the v1.23.6 tag, wait for the release workflow to finish. Verify
exactly four public assets: Chrome ZIP, unsigned Firefox XPI, signed Firefox XPI,
and updates.json. Check downloaded SHA-256 values against GitHub metadata, Chrome
files against exact committed tag bytes, the signed XPI against its unsigned
reference, and the live latest update feed against the signed 1.23.6 link.
Close issue #77 only after these checks pass. Chrome Store submission is separate
from generating its package; report it only if actually performed.

This record is committed before publication. The final run, merge/tag identities,
public hash and signing results are retained in the local handoff and GitHub run.
Ignored handoffs, user AGENTS.md and existing screenshots are not force-added.
