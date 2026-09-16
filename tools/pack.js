// Builds the release packages: one for Chrome, one for Firefox.
//
//   node tools/pack.js            -> dist/FriendlyChatExtension-v<version>.zip
//                                    dist/FriendlyChatExtension-v<version>-firefox-unsigned.xpi
//   node tools/pack.js <outdir>
//   node tools/pack.js <outdir> --target chrome|firefox|all
//   node tools/pack.js --unpacked <dir> [--target firefox|chrome]
//   node tools/pack.js <outdir> --target chrome-store
//                                 -> <outdir>/FriendlyChatExtension-v<version>-chrome-web-store.zip
//
// Neither zip has a wrapper directory. Each opens straight onto `manifest.json`,
// next to `src` and `icons`, so extracting it gives one folder holding the
// extension rather than a folder holding a folder — which is what Chrome's
// "Load unpacked" wants, since it needs the folder with the manifest directly
// inside it, and what Firefox and addons.mozilla.org want of a package as well.
//
// This exists because that had already gone wrong. Releases here used to be
// built and uploaded by hand, and v1.18.2 and v1.18.3 went out with everything
// wrapped in a `FriendlyChatExtension/` directory, putting the manifest a level
// deeper than anyone following the README would look. Nothing caught it,
// because nothing was checking: the zip was whatever the person making it
// happened to select. Now nobody uploads a release at all. Pushing a `v*` tag
// runs .github/workflows/release.yml, which runs the suite, builds every
// package with this file, reads each one back (`tools/release.js
// verify-packages`), and hands the rest to `tools/release.js publish`: signing
// the Firefox package, attaching the files to a draft, and publishing it last.
// This file is the one way a package is built, the test suite checks what it
// produces, and tools/release.js is the only thing that uploads it.
//
// The two packages hold the same files, byte for byte, except the manifest.
// `manifest.json` in the repository is Chrome's and stays exactly as Chrome
// needs it, and the Chrome zip ships it untouched. The Firefox zip ships one
// generated from it here, by firefoxManifest(), because the two browsers want
// things that one file cannot say to both of them at once:
//
//   - Firefox runs no extension service workers. Its background is an event
//     page whose files are listed in `background.scripts`, and Chrome before
//     121 refuses an MV3 manifest carrying that key — so sharing one manifest
//     would push the Chrome floor from 116, where it is for a reason, to 121.
//   - Firefox reads no port in a host permission. `http://localhost:8080/*` is
//     accepted there and matches nothing at all, while `http://localhost/*`,
//     which is what Firefox needs, would widen Chrome's grant to every port.
//   - Firefox takes the add-on's ID from `browser_specific_settings.gecko`
//     rather than from `key`, and will not sign an MV3 add-on without one.
//
// `--unpacked` writes the same files to a folder instead of a zip. The
// repository cannot be loaded in Firefox as it is, since its manifest names
// only a service worker, so that folder is what about:debugging's "Load
// Temporary Add-on" is pointed at while developing.
//
// The Firefox archive build() makes is not what a Firefox user installs.
// Mozilla signs it, and the signed file comes back as an .xpi, which the
// release carries beside the two archives (releaseAssetName says what each file
// is called, and ASSET_SUFFIXES why only Chrome's may end in .zip). The release also
// carries `updates.json`, the file every signed install asks for newer versions
// of itself, and updatesManifest() here is what writes it, so the name of the
// signed file, the add-on's ID and the oldest Firefox it runs on are said once,
// in this file, for the manifest and the update file alike.
//
// No dependencies, and nothing to install first — the same as the rest of this
// repository. Node cannot write a zip on its own, so the archive is assembled
// here from `zlib.deflateRawSync` and about eighty bytes of header per file.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');

// What the browser loads, plus the two documents that have always shipped
// beside it. Everything else in the repository — the test suite, the Cloudflare
// worker, CI — is not part of the extension and has no business in a user's
// folder.
const ROOTS = ['icons', 'src'];
const LOOSE = ['LICENSE', 'README.md', 'manifest.json'];

// Every package this can build. Chrome's is the default wherever one target is
// meant, because it is the one that existed first and the one every caller
// written before Firefox was asking for.
const TARGETS = ['chrome', 'firefox'];

// The package uploaded to the Chrome Web Store by hand, which is not one of a
// release's files and so is not in TARGETS or built by `--target all`. It ends
// in .zip, because that is what the store takes, and so must never be attached
// to a release (see ASSET_SUFFIXES): the release workflow keeps it as a run
// artifact instead, and STORE_ZIP_SUFFIX is deliberately not in ASSET_SUFFIXES.
const STORE_TARGET = 'chrome-store';
const STORE_ZIP_SUFFIX = '-chrome-web-store.zip';

// The Kick sign-in helper every install uses unless its settings name another
// (FCM.DEFAULT_KICK_PROXY_URL). The store build asks for this one host in place
// of every *.workers.dev address. A proxy of someone's own on another address
// still works there, since the worker answers with CORS headers for any
// extension, and a fetch that is allowed by CORS needs no host permission.
const DEFAULT_PROXY_ORIGIN = 'https://friendly-chat-kick-proxy.jrblaze.workers.dev/*';
const WORKERS_DEV_ORIGIN = 'https://*.workers.dev/*';

// ── What the Firefox manifest says about the add-on ─────────────────────────

// The add-on's ID, for good. Firefox derives the sign-in redirect URL from it
// (see firefoxRedirectUrl), addons.mozilla.org ties every signed version to it,
// and storage.sync files a user's settings under it — so changing it would mean
// registering a new redirect with Twitch, and every user losing what had synced.
const GECKO_ID = 'friendly-chat-extension@jrblaze.org';

// The oldest Firefox the add-on installs on. 140 is the first with Firefox's
// own data-collection consent at install, so DATA_COLLECTION below is the whole
// of that story rather than a screen of our own; it is also ESR 140, which is
// still supported, and new enough for everything else the extension leans on
// (host permissions granted at install from 127, `:has` from 121,
// `content-visibility` from 125).
const FIREFOX_MIN = '140.0';

// What leaves the browser, in Firefox's own categories, shown to the user at
// install. These three are the owner's decision, made for the first signed
// release: authenticationInfo, because Kick sign-in codes and refresh tokens
// go to the proxy worker; personalCommunications, because the messages the
// user types go to Twitch and Kick; browsingActivity, because the channel being
// watched goes to the emote and history services. Mozilla's documentation does
// not settle how an OAuth proxy, or chat sent to the very site you are on,
// ought to be counted, so declaring all three says more rather than less. All
// three are required rather than optional, since none of it can be switched
// off and the extension still work. "none" can never be combined with anything
// else, and `has_previous_consent` is not ours to set.
const DATA_COLLECTION = Object.freeze({
  required: Object.freeze(['authenticationInfo', 'personalCommunications', 'browsingActivity']),
});

// Where every signed Firefox install asks for newer versions of itself.
//
// Baked into each install for good. Firefox asks the address the installed
// version's manifest names and no other, so a version that named a different
// one could only ever be reached by the installs that already had it: moving
// this would leave everyone on the old address stuck on whatever they last
// updated to, with nothing to tell them. It must never change.
//
// `releases/latest/download/` because that is an address GitHub keeps pointing
// at the newest release's file of that name, so one fixed URL is always the
// current updates.json, and nothing has to be hosted anywhere but the releases
// this repository already publishes. Firefox follows GitHub's redirect from it
// to the file, and does the same for the download each entry names. The price
// is that "latest" is whichever release was published last: one published
// without `updates.json` answers every install's check with a 404 until the
// next one ships — no harm done, Firefox simply asks again later, but no
// update gets through either. So every release attaches `updates.json` and the
// signed .xpi while it is still a draft, and is only published once both are
// there; anything that must not become "latest" goes out as a prerelease.
//
// It has to be https as well. Firefox disables an add-on whose update_url is
// not, and Mozilla refuses to sign one.
//
// Anything that lints the Firefox package has to say it is self-hosted
// (`web-ext lint --self-hosted`). Without that the linter assumes a listing on
// addons.mozilla.org, where an update_url is not allowed, and fails the
// package for carrying one.
const UPDATE_URL = 'https://github.com/JRBlaze/FriendlyChatExtension/releases/latest/download/updates.json';

// Where a given release's files are downloaded from, by tag:
// `<RELEASE_DOWNLOADS>/v<version>/<file>`. What updates.json points each
// version at. Unlike UPDATE_URL this is not stored in any install, so it is
// free to change — but it has to name the same repository, or updates.json
// would announce files it cannot deliver.
const RELEASE_DOWNLOADS = 'https://github.com/JRBlaze/FriendlyChatExtension/releases/download';

// The host the extension's own update check asks for the latest release
// (src/background/updates.js), and nothing else. A Firefox package that names
// an update_url never makes that check — Firefox updates it, and
// FCM.updatedByBrowser switches the check off — so firefoxManifest leaves this
// host out of such a package: it would be asked for at install and never used,
// and a person who took it back would be told, wrongly, that emotes or history
// had gone missing with it. A Firefox package built without an update_url
// still checks GitHub itself, so it keeps the host.
//
// Should a Firefox build without an update_url ever be shipped as an update to
// installs that have one, this host would come back in that update, and Firefox
// does not grant a host an update adds (bug 1893232): the check would fail
// quietly until the host is allowed under Site access.
const GITHUB_API_ORIGIN = 'https://api.github.com/*';

// Every file a release carries, by kind, as the ending that follows
// `FriendlyChatExtension-v<version>`. `chrome` and `firefox` are the two
// archives build() makes; `firefox-xpi` is the Firefox archive once Mozilla has
// signed it, which is not built here but has to be named here all the same,
// since updates.json links to it and the extension's own update check looks
// for it by name (src/background/updates.js, FCM.releaseAssetName).
//
// Chrome's is the only one that may end in `.zip`, ever. Every Chrome build
// from v1.11.0 to v1.20.1 finds its update by asking GitHub for the latest
// release and taking the first file whose name ends in `.zip` — whichever one
// GitHub happens to list first, and GitHub lists a release's files by name,
// where `-firefox.zip` comes before `.zip`. Those builds are installed and
// cannot be changed; the update notice they show is how their users reach every
// later version. So a second `.zip` on any release would hand them the Firefox
// package, which Chrome cannot run, as their update. The unsigned Firefox
// archive is a zip all the same, and about:debugging loads it under any name,
// so it goes out as `.xpi`, with `unsigned` in the name to keep it apart from
// the signed file beside it — which is also what release Firefox would refuse
// if someone opened this one expecting it to install. tools/release.js refuses
// a release holding more than the one `.zip`, whatever this list says.
const ASSET_SUFFIXES = Object.freeze({
  chrome: '.zip',
  firefox: '-firefox-unsigned.xpi',
  'firefox-xpi': '-firefox.xpi',
});

/** Every path that goes in the zip, relative to the repo, sorted, `/`-separated. */
function collect(root) {
  const base = root || ROOT;
  const out = LOOSE.slice();
  const walk = (rel) => {
    const entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    entries.forEach((e) => {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else out.push(child);
    });
  };
  ROOTS.forEach(walk);
  out.sort();
  return out;
}

// ── Just enough of the zip format ───────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// The zip epoch, for every entry. A build depends on the source and on nothing
// else, so the same commit always produces the same bytes and two archives can
// be compared directly.
const DOS_TIME = 0;
const DOS_DATE = 33; // 1980-01-01

/**
 * @param {Array<{name: string, data: Buffer}>} files
 * @returns {Buffer} the archive
 */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  files.forEach((file) => {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    // Store rather than deflate when deflating does not help, which is what
    // every zip writer does and what keeps already-compressed PNGs from growing.
    const deflated = zlib.deflateRawSync(file.data, { level: 9 });
    const stored = deflated.length >= file.data.length;
    const body = stored ? file.data : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // no extra field
    locals.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory header
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0, 8);              // flags
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(file.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);             // extra
    dir.writeUInt16LE(0, 32);             // comment
    dir.writeUInt16LE(0, 34);             // disk
    dir.writeUInt16LE(0, 36);             // internal attributes
    // A plain readable file. Shifted back to unsigned: `<<` works on signed
    // 32-bit integers and this pattern is past the sign bit.
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += 30 + name.length + body.length;
  });

  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);                // this disk
  end.writeUInt16LE(0, 6);                // disk the directory starts on
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // no archive comment

  return Buffer.concat([...locals, dirBuf, end]);
}

// ── The manifest each browser gets ──────────────────────────────────────────

/**
 * The files service-worker.js imports, in order, read out of its
 * `importScripts` call and returned relative to the extension's root.
 *
 * Read rather than repeated, so the Firefox event page and the Chrome worker
 * cannot drift into loading different files, or the same files in a different
 * order. The guard in front of the call, `typeof importScripts === 'function'`,
 * has no bracket after the name and so is not mistaken for the call itself.
 * Anything in the list other than single-quoted paths is refused rather than
 * skipped: a path someone wrote in double quotes would otherwise be left out of
 * the Firefox build without a word, and only Firefox would notice.
 *
 * @param {string} swSource the text of service-worker.js
 * @returns {string[]}
 */
function backgroundScripts(swSource) {
  const call = /importScripts\(([\s\S]*?)\);/.exec(String(swSource)); // tolerates CRLF
  if (!call) throw new Error('service-worker.js has no importScripts list');
  const rest = call[1].replace(/'[^']*'/g, '').replace(/\/\/[^\n]*/g, '').replace(/[\s,]/g, '');
  if (rest) throw new Error(`the importScripts list holds something other than single-quoted paths: ${rest}`);
  const list = Array.from(call[1].matchAll(/'\/?([^']+)'/g), (m) => m[1]);
  if (!list.length) throw new Error('importScripts list is empty');
  return list;
}

/**
 * Firefox's manifest, made from Chrome's.
 *
 * Pure: it reads nothing from disk and leaves the manifest it is given exactly
 * as it was, so the tests can hand it whatever shape they like and the Chrome
 * manifest a caller is still holding stays Chrome's.
 *
 * Every key it does not mention is copied as it is — content scripts, the
 * popup, the options page, icons and web-accessible resources mean the same in
 * both browsers.
 *
 * One rule belongs with this rather than anywhere else, because this is where a
 * host permission is handed on to Firefox. Firefox grants host permissions when
 * the add-on is installed, and an update that adds one is installed without it:
 * nobody who already has the add-on is asked, and nothing tells them. Anyone
 * can also take any host back, at any time. So a host added to manifest.json
 * has to work through the runtime request the add-on already makes, never on
 * the assumption that being listed got it granted. FCM.hostAccess(), in
 * src/shared/util.js, finds what is not granted; the popup's card and the
 * options page's Site access section ask for it, from a click; the background
 * names a missing service in the feed and puts a missing site on the toolbar
 * badge. Whatever depends on the new host has to hold up, or at least say so,
 * until that request is answered — just as it must when a host is revoked.
 *
 * @param {object} manifest the Chrome manifest, as parsed from manifest.json
 * @param {string} swSource the text of the service worker that manifest names
 * @param {{id?: string, strictMinVersion?: string, dataCollection?: object,
 *   updateUrl?: string|null}} [opts] in place of the constants above
 * @returns {object}
 */
function firefoxManifest(manifest, swSource, opts) {
  const o = opts || {};
  const m = JSON.parse(JSON.stringify(manifest));

  // Chrome's alone. `key` pins the Chrome extension's ID and means nothing to
  // Firefox, whose ID is set below; `minimum_chrome_version` is accepted there
  // and then ignored, so it only gets in the way of reading the file.
  delete m.key;
  delete m.minimum_chrome_version;

  // An event page in place of the worker: every file the worker imports, then
  // the worker itself, last, because it expects all of them to have run.
  const worker = m.background && m.background.service_worker;
  if (!worker) throw new Error('the manifest names no background service worker to convert');
  m.background = { scripts: [...backgroundScripts(swSource), worker] };

  // A port pins nothing in Firefox: the pattern is accepted and matches no
  // address at all. Without one it matches every port, which is how Firefox
  // gets to see the Kick sign-in tab arrive at localhost:8080. Two patterns
  // that differed only by port are the same pattern afterwards, and listed once.
  const updateUrl = 'updateUrl' in o ? o.updateUrl : UPDATE_URL;
  if (Array.isArray(m.host_permissions)) {
    const portless = m.host_permissions.map((p) => p.replace(/^([^:]+:\/\/[^/:]+):\d+(\/.*)$/, '$1$2'));
    m.host_permissions = [...new Set(portless)]
      // GitHub's API is for the update check, which a package Firefox updates
      // never makes (see GITHUB_API_ORIGIN).
      .filter((p) => typeof updateUrl !== 'string' || p !== GITHUB_API_ORIGIN);
  }

  const gecko = {
    id: o.id || GECKO_ID,
    strict_min_version: o.strictMinVersion || FIREFOX_MIN,
    // A copy, so nothing done to the result can reach the constant.
    data_collection_permissions: JSON.parse(JSON.stringify(o.dataCollection || DATA_COLLECTION)),
  };
  if (typeof updateUrl === 'string') gecko.update_url = updateUrl;
  // Never `browser_style`: Firefox took it out of Manifest V3 in 118.
  m.browser_specific_settings = { gecko };
  return m;
}

/**
 * The Chrome Web Store's manifest, made from Chrome's.
 *
 * Pure, like firefoxManifest. Three things differ from the zip loaded unpacked:
 *
 *   - No `key`. The store refuses a manifest carrying one and gives the item an
 *     ID of its own, so this package's redirect URL is that ID's, not the
 *     unpacked build's.
 *   - No GitHub API host. The store updates the extension itself, and Chrome
 *     gives a store install an update_url, which is how FCM.updatedByBrowser
 *     knows to make no check of its own — so the host would be asked for and
 *     never used.
 *   - Only the default Kick proxy's host, not every *.workers.dev address
 *     (see DEFAULT_PROXY_ORIGIN), because a narrower request is a shorter review.
 *
 * @param {object} manifest the Chrome manifest, as parsed from manifest.json
 * @returns {object}
 */
function storeManifest(manifest) {
  const m = JSON.parse(JSON.stringify(manifest));
  delete m.key;
  if (Array.isArray(m.host_permissions)) {
    const hosts = m.host_permissions
      .filter((p) => p !== GITHUB_API_ORIGIN)
      .map((p) => (p === WORKERS_DEV_ORIGIN ? DEFAULT_PROXY_ORIGIN : p));
    m.host_permissions = [...new Set(hosts)];
  }
  return m;
}

function targetOf(target) {
  const t = target || 'chrome';
  if (t === STORE_TARGET) return t;
  if (!TARGETS.includes(t)) throw new Error(`unknown target "${t}" (expected ${TARGETS.join(' or ')})`);
  return t;
}

/**
 * The bytes that go into a target's package as `manifest.json`.
 *
 * Chrome's are the file on disk, untouched. Not parsed and written back out,
 * which would change its whitespace and with it every Chrome archive this has
 * ever built from the same commit.
 */
function manifestBytes(root, target) {
  const base = root || ROOT;
  const t = targetOf(target);
  if (t === 'chrome') return fs.readFileSync(path.join(base, 'manifest.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
  if (t === STORE_TARGET) return Buffer.from(`${JSON.stringify(storeManifest(manifest), null, 2)}
`, 'utf8');
  const worker = (manifest.background || {}).service_worker;
  const swSource = worker ? fs.readFileSync(path.join(base, worker), 'utf8') : '';
  return Buffer.from(`${JSON.stringify(firefoxManifest(manifest, swSource), null, 2)}\n`, 'utf8');
}

/**
 * A package for the working tree, as a Buffer.
 * @param {string} [root]
 * @param {{target?: 'chrome'|'firefox'}} [opts] Chrome's, unless told otherwise
 */
function build(root, opts) {
  const base = root || ROOT;
  const manifest = manifestBytes(base, opts && opts.target);
  return zip(collect(base).map((name) => ({
    name,                                       // no prefix: the zip root
    data: name === 'manifest.json' ? manifest : fs.readFileSync(path.join(base, name)),
  })));
}

function version(root) {
  const base = root || ROOT;
  return JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')).version;
}

/**
 * What a release's file of one kind is called, for a given version: the one
 * place those names are made. The extension's update check asks for the same
 * names (FCM.releaseAssetName, in src/background/updates.js), and the test
 * suite holds the two to each other.
 *
 * Every name starts with `FriendlyChatExtension-v<version>`, so the repo
 * suite's check that the README names only this version catches a stale
 * Firefox link too, while only Chrome's ends in `.zip` at all — which is the
 * one download link that check counts, and the one file every Chrome build
 * already installed will take for its update (see ASSET_SUFFIXES).
 *
 * @param {string} ver the version, without a leading v
 * @param {'chrome'|'firefox'|'firefox-xpi'} [kind] Chrome's zip, unless told otherwise
 */
function releaseAssetName(ver, kind) {
  const k = kind || 'chrome';
  if (!Object.prototype.hasOwnProperty.call(ASSET_SUFFIXES, k)) {
    throw new Error(`unknown release file "${k}" (expected ${Object.keys(ASSET_SUFFIXES).join(', ')})`);
  }
  return `FriendlyChatExtension-v${ver}${ASSET_SUFFIXES[k]}`;
}

/** The name of a release file of one kind, for the version in the working tree's manifest. */
function assetName(root, kind) {
  if (kind === STORE_TARGET) return `FriendlyChatExtension-v${version(root)}${STORE_ZIP_SUFFIX}`;
  return releaseAssetName(version(root), kind);
}

// The versions a Manifest V3 add-on may have in Firefox: one to four numbers
// separated by dots, each at most nine digits, none starting with a zero unless
// it is zero. Checked before a version goes into updates.json, because a file
// announcing a version no signed package can carry — a tag's `v` left on, a
// suffix — would be published to every install without anything having
// failed, and the only sign would be that nobody's add-on moved.
const FIREFOX_VERSION = /^(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){0,3}$/;

/**
 * The `updates.json` a release publishes, announcing that release to every
 * signed Firefox install (see UPDATE_URL for how they find it).
 *
 * Only the version being released is listed. Firefox installs the newest
 * version it is offered that it can run, so older entries would change nothing
 * for anyone, and a file that names one version cannot fall out of step with a
 * list of them.
 *
 * No `update_hash`. Mozilla's signature already tells Firefox whether the file
 * is the one that was signed, and a hash would pin the exact bytes, so an .xpi
 * ever re-uploaded under the same name would be refused by every install.
 *
 * Pure, like firefoxManifest: nothing is read from disk or written to it, and a
 * fresh object comes back each time.
 *
 * @param {string} ver the version released, as the manifest says it, without the tag's v
 * @param {{id?: string, strictMinVersion?: string}} [opts] in place of GECKO_ID
 *   and FIREFOX_MIN, the same options firefoxManifest takes, so a build made
 *   under other values gets an update file that agrees with its manifest
 * @returns {object}
 */
function updatesManifest(ver, opts) {
  const o = opts || {};
  const v = String(ver === undefined || ver === null ? '' : ver);
  if (!FIREFOX_VERSION.test(v)) {
    throw new Error(`"${v}" is not a version Firefox can compare: one to four numbers separated by dots, with no v`);
  }
  return {
    addons: {
      [o.id || GECKO_ID]: {
        updates: [{
          version: v,
          update_link: `${RELEASE_DOWNLOADS}/v${v}/${releaseAssetName(v, 'firefox-xpi')}`,
          applications: { gecko: { strict_min_version: o.strictMinVersion || FIREFOX_MIN } },
        }],
      },
    },
  };
}

/**
 * The address Firefox's `identity.getRedirectURL()` gives this add-on, and so
 * the one the Twitch app has to list before a Firefox sign-in can finish.
 *
 * Firefox works it out from the ID alone — the lowercase hex SHA-1 of it, under
 * extensions.allizom.org — so it is the same on every machine and every
 * install, temporary ones included, and can be known here without a browser.
 */
function firefoxRedirectUrl(id) {
  const hash = crypto.createHash('sha1').update(String(id || GECKO_ID), 'utf8').digest('hex');
  return `https://${hash}.extensions.allizom.org/`;
}

/**
 * Writes a target's files to a folder rather than a zip, for loading straight
 * from disk: about:debugging for Firefox, Load unpacked for Chrome.
 *
 * Nothing already in the folder is deleted, so pointing this at the wrong one
 * cannot lose anything; a file a later build no longer ships is simply left
 * there, with no manifest naming it. The repository itself is refused, because
 * writing Firefox's manifest over Chrome's is the one way this could.
 *
 * @returns {string[]} the paths written, relative to the folder
 */
function writeUnpacked(root, dir, target) {
  const base = path.resolve(root || ROOT);
  const out = path.resolve(dir);
  const same = process.platform === 'win32'
    ? out.toLowerCase() === base.toLowerCase()
    : out === base;
  if (same) throw new Error('refusing to write a build over the repository it is built from');
  const manifest = manifestBytes(base, target);
  const names = collect(base);
  names.forEach((name) => {
    const to = path.join(out, name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, name === 'manifest.json' ? manifest : fs.readFileSync(path.join(base, name)));
  });
  return names;
}

const USAGE = 'usage: node tools/pack.js [outdir] [--target chrome|firefox|all] [--unpacked <dir>]';

/**
 * Reads the command line.
 *
 * Every package is built when nothing says otherwise, so `node tools/pack.js
 * dist` — what the release workflow runs — builds all of them. `--unpacked`
 * writes a folder, and a folder can hold only one manifest, so it builds one
 * target: Firefox unless told otherwise, since the repository already loads in
 * Chrome as it stands and Firefox is the browser that needs the folder.
 *
 * @param {string[]} argv the arguments after the script's own name
 * @returns {{outDir: string|null, target: string, unpacked: string|null}}
 */
function parseArgs(argv) {
  const args = { outDir: null, target: null, unpacked: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    const at = arg.indexOf('=');
    const flag = arg.startsWith('--') && at > 0 ? arg.slice(0, at) : arg;
    if (flag === '--target' || flag === '--unpacked') {
      const value = flag === arg ? argv[++i] : arg.slice(at + 1);
      if (!value || String(value).startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--target') args.target = String(value);
      else args.unpacked = String(value);
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else if (args.outDir === null) {
      args.outDir = arg;
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }
  if (args.unpacked !== null) {
    if (args.outDir !== null) {
      throw new Error('--unpacked writes a folder rather than archives, so it takes no output directory');
    }
    args.target = args.target || 'firefox';
    if (!TARGETS.includes(args.target)) {
      throw new Error(`--unpacked builds one target, chrome or firefox, not "${args.target}"`);
    }
  } else {
    args.target = args.target || 'all';
    if (args.target !== 'all' && args.target !== STORE_TARGET && !TARGETS.includes(args.target)) {
      throw new Error(`unknown target "${args.target}"`);
    }
  }
  return args;
}

module.exports = {
  collect, build, zip, crc32, version, assetName, releaseAssetName, manifestBytes,
  firefoxManifest, storeManifest, backgroundScripts, firefoxRedirectUrl, updatesManifest, writeUnpacked, parseArgs,
  GECKO_ID, FIREFOX_MIN, DATA_COLLECTION, UPDATE_URL, RELEASE_DOWNLOADS, GITHUB_API_ORIGIN, ASSET_SUFFIXES,
  TARGETS, STORE_TARGET, STORE_ZIP_SUFFIX, DEFAULT_PROXY_ORIGIN, ROOTS, LOOSE,
};

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }

  // Said wherever a Firefox build is made, since that is the moment someone
  // needs to know what to paste into the Twitch app.
  const sayRedirect = () => console.log(
    `Firefox redirect URL, for the Twitch app's OAuth redirect URLs: ${firefoxRedirectUrl()}`
  );

  try {
    if (args.unpacked !== null) {
      const dir = path.resolve(args.unpacked);
      const names = writeUnpacked(ROOT, dir, args.target);
      console.log(`${dir}`);
      console.log(`${names.length} files, ${args.target} manifest`);
      if (args.target === 'firefox') sayRedirect();
    } else {
      const outDir = path.resolve(args.outDir || path.join(ROOT, 'dist'));
      fs.mkdirSync(outDir, { recursive: true });
      const names = collect();
      const targets = args.target === 'all' ? TARGETS : [args.target];
      targets.forEach((target) => {
        const out = path.join(outDir, assetName(ROOT, target));
        fs.writeFileSync(out, build(ROOT, { target }));
        console.log(`${out}`);
        console.log(`${names.length} files, ${fs.statSync(out).size} bytes`);
      });
      if (targets.includes('firefox')) sayRedirect();
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
