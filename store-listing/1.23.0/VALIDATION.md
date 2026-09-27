# Documentation and store-asset validation

Scope: README, privacy explanation, copy-ready store listing fields and five screenshot assets for Friendly Chat 1.23.0. GitHub About description, topics and homepage were updated separately through the repository API.

- `node tests/run.js repo`: 14 passed, 0 failed after each documentation update.
- `git diff --check`: passed.
- No changes to `src/`, `manifest.json`, `tools/`, `tests/`, dependencies, storage or the released extension packages. Runtime coverage remains the release's recorded evidence; documentation/image checks do not establish new behavioral coverage.
- Permission copy was checked against the verified workflow Chrome Web Store ZIP: five API permissions, twelve required host entries, and one optional YouTube host. The store build excludes GitHub's API and narrows the Cloudflare helper host.
- Short description: 111 characters. Detailed description: 3,175 characters. Single purpose: 174 characters. Individual permission, host and remote-code explanations are below 1,000 characters.
- Privacy categories are explicitly identified as a conservative interpretation of current code/data flows and Google's published definitions. No claim of no user-data handling or guaranteed store approval is made.
- Capture runs used installed Chrome and local production-UI harnesses with all external requests blocked. Sample accounts, chats and balances were synthetic. No live messages or account/storage changes occurred.
- Five PNGs were read back and checked: each 1280×800, 8-bit RGB (PNG color type 2), no alpha. All five were visually inspected. YouTube rows, selected sending, and saved-link state were asserted in the fixture. Capture notes and results accompany the images.
- README source/feature descriptions were reviewed for Twitch/Kick-only statements that incorrectly excluded YouTube. API sending and saved send choices remain explicitly Twitch/Kick-specific; YouTube's temporary native send selection is described separately.
- Unrelated untracked AGENTS.md and the older screenshot folder remain untouched. Ignored local handoffs and delivery ZIPs were not force-added.

The requested GitHub documentation update is published through a documentation-only PR. This work does not upload, change, or submit the Chrome Web Store listing, and does not create another extension release. The owner can copy the supplied text and upload the screenshots in the Developer Dashboard.
