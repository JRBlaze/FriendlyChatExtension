// Publishes a release: the two packages tools/pack.js builds, the Firefox one
// once Mozilla has signed it, and the updates.json that points every signed
// Firefox install at it.
//
//   node tools/release.js verify-packages <distDir> <version>
//   node tools/release.js verify-xpi <file> <version>
//   node tools/release.js updates-json <version> <outFile>
//   node tools/release.js publish <tag> <distDir>
//
// .github/workflows/release.yml runs these when a `v*` tag is pushed, and does
// little else. What a release is allowed to do is decided here instead, in
// plain functions the test suite can run without a network, because the ways
// this goes wrong are not the kind a workflow file shows: they are all about
// order, and about what is left behind when something fails part-way.
//
// A release carries four files:
//
//   FriendlyChatExtension-v<version>.zip                    Chrome, for Load unpacked
//   FriendlyChatExtension-v<version>-firefox-unsigned.xpi   Firefox, unsigned, for about:debugging
//   FriendlyChatExtension-v<version>-firefox.xpi            the same package, signed by Mozilla
//   updates.json                                            where every signed install finds it
//
// Only the first of them ends in .zip, and a release holding any other .zip is
// refused. Every Chrome build from v1.11.0 to v1.20.1 takes the first .zip on
// the latest release as its update, in whatever order GitHub lists the files,
// and those builds are installed and cannot be changed (tools/pack.js,
// ASSET_SUFFIXES).
//
// Two facts decide the rest.
//
// Every signed Firefox install asks releases/latest/download/updates.json for
// its next version (UPDATE_URL, in tools/pack.js), and "latest" is whichever
// release was published last. A release published without updates.json
// answers every one of those checks with a 404 for as long as it stays latest.
// So a release is only ever built as a draft: every file is attached to the
// draft, the draft is read back to see that they are all there, and publishing
// it is the very last thing done — never reached when anything before it
// failed. A release that is already published is refused rather than filled in
// after the fact, since filling it in is exactly the window this avoids.
//
// And addons.mozilla.org signs a version once. Asked to sign a version it has
// already signed, it refuses, so a run that is repeated must not sign again:
// when the draft for the tag already holds the signed .xpi, that file is
// downloaded, checked and used, and Mozilla is not asked. For the same reason
// the draft is made before signing rather than after. Once Mozilla has said
// yes, the signed file exists only on the machine running this until it is
// uploaded, and a draft that already exists is one less thing that can fail in
// between.
//
// Signing is `web-ext sign --channel unlisted`: signed, and never listed on
// addons.mozilla.org, because this repository's releases are the only place
// the add-on is published. web-ext takes the credentials from WEB_EXT_API_KEY
// and WEB_EXT_API_SECRET in the environment, so they are never on a command
// line, in a log, or in what a test records.
//
// And only in that one command's environment. web-ext is fetched from npm with
// several hundred packages under it, none of them pinned, so everything run
// here is handed an environment of its own (commandEnv): the AMO credentials
// reach `web-ext sign` and nothing else, gh's token reaches gh and nothing
// else, and `web-ext lint` gets neither. For the same reason nothing web-ext
// could have touched is trusted afterwards: the packages are held by their
// hashes from the moment they are checked until they are uploaded, and the
// signed file has to hold exactly the files of the package it was signed from.
//
// Every command goes through one runner (runCommand), which the release suite
// swaps for one that records what would have run and answers the way gh and
// web-ext would. No dependencies, like the rest of the repository: the zip
// reader here is the part of the format a release needs, and no more.

'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const pack = require('./pack.js');

const ROOT = path.resolve(__dirname, '..');

// The one web-ext every release is linted and signed with, pinned exactly: its
// sign command was rewritten between majors and is not compatible across them,
// and nothing about how a release is signed should change without a commit
// saying so. release.yml fetches the same version before anything is created,
// and the release suite holds the two to each other.
//
// What follows was read out of that version's own source (lib/program.js,
// lib/cmd/sign.js, lib/util/submit-addon.js), not out of its documentation:
//
//   - `sign` needs --channel, and reads --api-key and --api-secret from
//     WEB_EXT_API_KEY and WEB_EXT_API_SECRET when they are not given.
//   - It waits up to five minutes for Mozilla's validation, and — with neither
//     --approval-timeout nor --timeout given — up to fifteen for approval,
//     which an unlisted version is given automatically.
//   - It saves the signed file into --artifacts-dir under whatever name
//     Mozilla's download link ends in, which is not a name of ours, so the one
//     file it leaves is renamed to the release's.
//   - It writes `.amo-upload-uuid` into --source-dir, remembering the upload.
//     So the source it signs is a folder of its own under the output
//     directory, never the repository.
//   - A config file it discovers in the home or working directory would set
//     option defaults, so discovery is switched off: what is signed, and how,
//     is what is written here.
const WEB_EXT = 'web-ext@8.10.0';

// What Mozilla's signing adds to a package: a hash of every file, a signature
// over those hashes, and the PKCS#7 signature itself. A file without all three
// was never signed, whatever it is called.
const SIGNATURE_FILES = Object.freeze(['META-INF/manifest.mf', 'META-INF/mozilla.sf', 'META-INF/mozilla.rsa']);

const UPDATES_JSON = 'updates.json';

// The AMO credentials, as web-ext reads them. They are handed to `web-ext sign`
// and to no other command. Every other WEB_EXT_ variable is kept from web-ext
// altogether, since each one sets an option — the address the credentials are
// sent to among them — and what is signed, and how, is what is written here.
// AMO_ is how the repository's secrets are named, in case one is ever put in
// the environment under its own name; nothing here reads those at all.
const AMO_VARIABLES = Object.freeze(['WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET']);

// What gh authenticates with, which is handed to gh and to no other command.
const GITHUB_TOKEN_VARIABLES = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']);

/**
 * The environment one command runs with: the one given, less every credential
 * the command has no use for.
 *
 * Everything else is passed on as it is — PATH, HOME, a proxy, what npx and gh
 * need to start on Windows — because a list of what to keep would be a list of
 * what every tool needs, and the first one it missed would stop a release. Names
 * are compared without regard to case, which is how Windows reads them.
 *
 * @param {object} base the environment the run was given
 * @param {'amo'|'github'|null} [grant] `amo` for `web-ext sign`, `github` for gh
 * @returns {object} a new object; `base` is left as it was
 */
function commandEnv(base, grant) {
  const out = {};
  Object.keys(base || {}).forEach((name) => {
    const upper = name.toUpperCase();
    if (AMO_VARIABLES.includes(upper)) {
      if (grant !== 'amo') return;
    } else if (upper.startsWith('WEB_EXT_') || upper.startsWith('AMO_')) {
      return;
    }
    if (GITHUB_TOKEN_VARIABLES.includes(upper) && grant !== 'github') return;
    out[name] = base[name];
  });
  return out;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ── Reading a zip ───────────────────────────────────────────────────────────
//
// Through the central directory, since that is the half of an archive an
// unzipper believes when the two halves disagree. Written against the format
// rather than borrowed from pack.js's writer, so a writer that is confidently
// wrong cannot pass its own check, and strict about it, since every archive
// this is handed is about to be published.

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/**
 * Every entry an archive's central directory lists, in order.
 * @param {Buffer} buf
 * @returns {Array<{name: string, flags: number, method: number, crc: number,
 *   compressedSize: number, size: number, offset: number}>}
 */
function readCentral(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip archive (too short to be one)');
  // The end record is the last 22 bytes, unless the archive has a comment after
  // it, and a comment is at most 65535 bytes long.
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  let end = -1;
  for (let at = buf.length - 22; at >= floor; at--) {
    if (buf.readUInt32LE(at) === END_OF_DIRECTORY) { end = at; break; }
  }
  if (end < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const count = buf.readUInt16LE(end + 10);
  const size = buf.readUInt32LE(end + 12);
  const start = buf.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
    throw new Error('a zip64 archive, which no package of this size should be');
  }
  if (start + size > end) throw new Error('the central directory runs past the end of the archive');

  const entries = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buf.readUInt32LE(at) !== DIRECTORY_HEADER) {
      throw new Error(`entry ${i + 1} of ${count} has no central directory header`);
    }
    const nameLength = buf.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    if (next > end) throw new Error(`entry ${i + 1} of ${count} runs past the central directory`);
    entries.push({
      name: buf.toString('utf8', at + 46, at + 46 + nameLength),
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      crc: buf.readUInt32LE(at + 16),
      compressedSize: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      offset: buf.readUInt32LE(at + 42),
    });
    at = next;
  }
  return entries;
}

/**
 * One entry's contents, uncompressed, and checked against the size and the
 * checksum the directory gives for it.
 * @returns {Buffer}
 */
function readEntry(buf, entry) {
  if (entry.flags & 1) throw new Error(`${entry.name} is encrypted`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`${entry.name} is compressed with method ${entry.method}, which is neither stored nor deflated`);
  }
  const at = entry.offset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL_HEADER) {
    throw new Error(`${entry.name} has no local header where the directory says it starts`);
  }
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const body = buf.subarray(start, start + entry.compressedSize);
  if (body.length !== entry.compressedSize) throw new Error(`${entry.name} is cut short`);
  const data = entry.method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body);
  if (data.length !== entry.size) throw new Error(`${entry.name} is not the size the directory says`);
  if (pack.crc32(data) !== entry.crc) throw new Error(`${entry.name} does not match its checksum`);
  return data;
}

// A path that would not land plainly inside the folder the archive is opened
// into: absolute, on a drive, backslashed, or climbing out with `..`.
function unsafeEntryName(name) {
  return name === '' || name.includes('\0') || name.includes('\\') || name.startsWith('/')
    || /^[A-Za-z]:/.test(name) || name.split('/').some((part) => part === '..' || part === '.');
}

/**
 * Unpacks an archive into a folder, which must be new or empty so that nothing
 * already in it can end up signed alongside the package.
 * @returns {string[]} the files written, as the archive names them
 */
function extractZip(buf, dir) {
  const entries = readCentral(buf);
  const out = path.resolve(dir);
  if (fs.existsSync(out) && fs.readdirSync(out).length) {
    throw new Error(`${out} is not empty; a package is only unpacked into a new folder, so nothing left in one is signed with it`);
  }
  const unsafe = entries.map((entry) => entry.name).filter(unsafeEntryName);
  if (unsafe.length) throw new Error(`refusing to unpack paths that would land outside the folder: ${unsafe.join(', ')}`);
  fs.mkdirSync(out, { recursive: true });
  const written = [];
  entries.forEach((entry) => {
    const to = path.join(out, ...entry.name.split('/'));
    if (entry.name.endsWith('/')) {
      fs.mkdirSync(to, { recursive: true });
      return;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, readEntry(buf, entry));
    written.push(entry.name);
  });
  return written;
}

// ── Checking what is about to be published ──────────────────────────────────

// A version as manifest.json writes it. The `v` belongs to the tag, and a
// version passed with it still on would name files that were never built.
function checkVersion(version) {
  const v = String(version === undefined || version === null ? '' : version);
  if (!/^\d+(\.\d+){0,3}$/.test(v)) {
    throw new Error(`"${v}" is not a version as manifest.json writes one: one to four numbers separated by dots, without the tag's v`);
  }
  return v;
}

/** The four files a release of this version carries, by name, in the order they are uploaded. */
function releaseFiles(version) {
  const v = checkVersion(version);
  return [
    pack.releaseAssetName(v, 'chrome'),
    pack.releaseAssetName(v, 'firefox'),
    pack.releaseAssetName(v, 'firefox-xpi'),
    UPDATES_JSON,
  ];
}

/**
 * What is wrong with a release holding these files, as far as the Chrome builds
 * already installed are concerned: nothing, when the only file ending in .zip
 * is Chrome's own.
 *
 * Every Chrome build from v1.11.0 to v1.20.1 checks for its update by asking
 * GitHub for the latest release and taking the first file whose name ends in
 * .zip. Which file is first is GitHub's to say, and it lists them by name, so
 * a second .zip would be offered to every one of those users as their update
 * whenever its name sorts in front — and nothing can be changed about builds
 * that are already installed. Asked of the names the release will carry before
 * anything is built on them, and of the draft before it is published.
 *
 * @param {string[]} names file names, as a release lists them
 * @param {string} version without the tag's v
 * @param {string} where what holds them, for the message
 * @returns {string[]}
 */
function zipProblems(names, version, where) {
  const chrome = pack.releaseAssetName(checkVersion(version), 'chrome');
  const zips = (names || []).map(String).filter((name) => /\.zip$/i.test(name));
  const others = zips.filter((name) => name !== chrome);
  if (!others.length) return [];
  return [`${where} holds ${others.join(', ')} beside ${chrome}; a release may carry no .zip but Chrome's, because every `
    + 'Chrome build from v1.11.0 to v1.20.1 takes the first .zip on the latest release as its update, whichever that is'];
}

// Opens one archive, saying what is wrong rather than throwing, so a check
// reports everything it finds in one go instead of one problem per run.
function openArchive(file, label, problems) {
  if (!fs.existsSync(file)) {
    problems.push(`${label} is not there (looked for ${file})`);
    return null;
  }
  const buf = fs.readFileSync(file);
  try {
    return { buf, entries: readCentral(buf) };
  } catch (e) {
    problems.push(`${label} cannot be read as a zip: ${e.message}`);
    return null;
  }
}

// Whether an archive opens onto the extension: `manifest.json` at its root,
// every path plainly relative, and none listed twice, since an archive that
// names a path twice means whichever copy the unzipper happens to keep.
function layoutProblems(label, entries) {
  const problems = [];
  const names = entries.map((entry) => entry.name);
  const unsafe = names.filter(unsafeEntryName);
  if (unsafe.length) problems.push(`${label} holds paths that are not plainly relative: ${unsafe.join(', ')}`);
  const repeated = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
  if (repeated.length) problems.push(`${label} lists the same path more than once: ${repeated.join(', ')}`);
  if (!names.includes('manifest.json')) {
    const nested = names.find((name) => /\/manifest\.json$/.test(name));
    problems.push(nested
      ? `${label} is wrapped in a folder: its manifest is at ${nested}, not at the root of the archive`
      : `${label} has no manifest.json at the root of the archive`);
  }
  return problems;
}

// The files a manifest names, which have to be at those paths in the archive.
// A manifest at the root with the rest of the extension a folder further down
// is still a package that does not load, and only this notices it.
function namedFiles(manifest) {
  const out = [];
  const bg = manifest.background || {};
  if (bg.service_worker) out.push(bg.service_worker);
  (Array.isArray(bg.scripts) ? bg.scripts : []).forEach((file) => out.push(file));
  (manifest.content_scripts || []).forEach((entry) => {
    (entry.js || []).forEach((file) => out.push(file));
    (entry.css || []).forEach((file) => out.push(file));
  });
  Object.values(manifest.icons || {}).forEach((file) => out.push(file));
  if ((manifest.action || {}).default_popup) out.push(manifest.action.default_popup);
  const options = manifest.options_page || (manifest.options_ui || {}).page;
  if (options) out.push(options);
  return [...new Set(out.map((file) => String(file).replace(/^\//, '')))];
}

// Everything the Firefox manifest has to say for Mozilla to sign it and for
// every install to find its updates, held to the constants in tools/pack.js
// rather than to copies of them.
function firefoxManifestProblems(label, manifest, version) {
  const problems = [];
  const bg = manifest.background || {};
  if ('service_worker' in bg) problems.push(`${label}: its manifest still names a background service worker, which Firefox does not run`);
  if (!Array.isArray(bg.scripts) || !bg.scripts.length) problems.push(`${label}: its manifest has no background.scripts`);
  const gecko = (manifest.browser_specific_settings || {}).gecko || {};
  if (gecko.id !== pack.GECKO_ID) {
    problems.push(`${label}: its gecko.id is ${JSON.stringify(gecko.id)}, not ${JSON.stringify(pack.GECKO_ID)}`);
  }
  if (gecko.strict_min_version !== pack.FIREFOX_MIN) {
    problems.push(`${label}: its strict_min_version is ${JSON.stringify(gecko.strict_min_version)}, not ${JSON.stringify(pack.FIREFOX_MIN)}`);
  }
  if (JSON.stringify(gecko.data_collection_permissions) !== JSON.stringify(pack.DATA_COLLECTION)) {
    problems.push(`${label}: its data_collection_permissions are ${JSON.stringify(gecko.data_collection_permissions)}, not ${JSON.stringify(pack.DATA_COLLECTION)}`);
  }
  if (gecko.update_url !== pack.UPDATE_URL) {
    problems.push(`${label}: its update_url is ${JSON.stringify(gecko.update_url)}, not ${JSON.stringify(pack.UPDATE_URL)}`);
  }
  if ('key' in manifest) problems.push(`${label}: its manifest still carries Chrome's key`);
  // Asked for at install and never used, by a package Firefox updates itself
  // (tools/pack.js, GITHUB_API_ORIGIN).
  if (Array.isArray(manifest.host_permissions) && manifest.host_permissions.includes(pack.GITHUB_API_ORIGIN)) {
    problems.push(`${label}: its manifest asks for ${pack.GITHUB_API_ORIGIN}, which only the update check Firefox replaces uses`);
  }
  if (manifest.version !== version) {
    problems.push(`${label}: its manifest is version ${JSON.stringify(manifest.version)}, not ${JSON.stringify(version)}`);
  }
  return problems;
}

/**
 * Checks the two packages tools/pack.js built, before anything is done with
 * them: both there under the release's names, each opening onto the
 * extension, Chrome's manifest the repository's own byte for byte, Firefox's
 * saying everything signing and updating depend on, and the two holding the
 * same files apart from the manifest.
 *
 * @param {string} distDir the folder pack.js wrote to
 * @param {string} version the version released, without the tag's v
 * @param {{root?: string}} [opts] the repository whose manifest.json Chrome's must equal
 * @returns {{problems: string[]}} nothing wrong when the list is empty
 */
function verifyPackages(distDir, version, opts) {
  const o = opts || {};
  const v = checkVersion(version);
  const dist = path.resolve(distDir);
  const problems = [...zipProblems(releaseFiles(v), v, 'the list of files a release carries')];
  const opened = {};

  ['chrome', 'firefox'].forEach((kind) => {
    const name = pack.releaseAssetName(v, kind);
    const archive = openArchive(path.join(dist, name), name, problems);
    if (!archive) return;
    problems.push(...layoutProblems(name, archive.entries));
    const entry = archive.entries.find((e) => e.name === 'manifest.json');
    if (!entry) return;
    let bytes;
    let manifest;
    try {
      bytes = readEntry(archive.buf, entry);
      manifest = JSON.parse(bytes.toString('utf8'));
    } catch (e) {
      problems.push(`${name}: its manifest.json cannot be read: ${e.message}`);
      return;
    }
    opened[kind] = archive;

    const names = archive.entries.map((e) => e.name);
    const absent = namedFiles(manifest).filter((file) => !names.includes(file));
    if (absent.length) problems.push(`${name}: its manifest names files the archive does not hold at those paths: ${absent.join(', ')}`);

    if (kind === 'chrome') {
      if (!bytes.equals(fs.readFileSync(path.join(o.root || ROOT, 'manifest.json')))) {
        problems.push(`${name}: its manifest.json is not the repository's manifest.json, byte for byte`);
      }
      if (manifest.version !== v) {
        problems.push(`${name}: its manifest is version ${JSON.stringify(manifest.version)}, not ${JSON.stringify(v)}`);
      }
    } else {
      problems.push(...firefoxManifestProblems(name, manifest, v));
    }
  });

  // Compared by the directory's checksum and size, which is enough to tell two
  // builds of different trees apart without unpacking either.
  if (opened.chrome && opened.firefox) {
    const differ = differentFiles(opened.chrome.entries, opened.firefox.entries)
      .filter((d) => d.name !== 'manifest.json')
      .map((d) => d.name);
    if (differ.length) {
      problems.push(`the two packages should differ only in manifest.json, but also differ in: ${differ.join(', ')}`);
    }
  }
  return { problems };
}

/**
 * The files two archives do not hold alike, by the central directory's
 * checksum and uncompressed size, sorted by name.
 *
 * Never by compressed size or position: the same file deflated by another
 * writer, or put in another order, is still the same file. Directory entries
 * are left out, and so, when `skip` says so, is any path it names.
 *
 * @param {Array<{name: string, crc: number, size: number}>} a
 * @param {Array<{name: string, crc: number, size: number}>} b
 * @param {(name: string) => boolean} [skip]
 * @returns {Array<{name: string, how: 'only-in-a'|'only-in-b'|'changed'}>}
 */
function differentFiles(a, b, skip) {
  const files = (entries) => new Map(entries
    .filter((e) => !e.name.endsWith('/') && !(skip && skip(e.name)))
    .map((e) => [e.name, e]));
  const left = files(a);
  const right = files(b);
  return [...new Set([...left.keys(), ...right.keys()])].sort().map((name) => {
    if (!right.has(name)) return { name, how: 'only-in-a' };
    if (!left.has(name)) return { name, how: 'only-in-b' };
    const x = left.get(name);
    const y = right.get(name);
    return x.crc !== y.crc || x.size !== y.size ? { name, how: 'changed' } : null;
  }).filter(Boolean);
}

/**
 * Checks a signed Firefox package: a zip that opens onto the extension, with
 * Mozilla's signature files in it, for this add-on and this version.
 *
 * Mozilla signs whatever version it is sent under whatever ID the manifest
 * gives, so a signed file for the wrong version, or a fork's, is still signed;
 * both are checked here because nothing downstream would notice either.
 *
 * And a signed file is not necessarily signed from the package being released.
 * One left on the draft by an earlier run from another commit of the same
 * version, one signed by hand from an older folder, and one that whatever
 * handed it back had changed all carry the right ID, the right version and
 * real signature files. Given `reference` — the Firefox package this release
 * checked — every file outside META-INF/ has to be in both, alike by checksum
 * and size, with nothing extra and nothing missing. META-INF/ is Mozilla's:
 * the three signature files, and the COSE pair it adds beside them when asked.
 * Mozilla's signer repacks the archive but leaves every file in it as it was,
 * so compression and order are not compared, and neither are directory
 * entries.
 *
 * @param {string} file
 * @param {string} version without the tag's v
 * @param {{id?: string, reference?: string|Buffer}} [opts] `id` in place of
 *   GECKO_ID; `reference` the unsigned package, as a path or its bytes
 * @returns {{problems: string[], differs: string[]}} `differs` names the files
 *   that do not match the reference, when one was given
 */
function verifyXpi(file, version, opts) {
  const o = opts || {};
  const v = checkVersion(version);
  const id = o.id || pack.GECKO_ID;
  const label = path.basename(String(file));
  const problems = [];
  const differs = [];
  const archive = openArchive(path.resolve(String(file)), label, problems);
  if (!archive) return { problems, differs };

  const names = archive.entries.map((e) => e.name);
  const unsigned = SIGNATURE_FILES.filter((sig) => !names.includes(sig));
  if (unsigned.length) problems.push(`${label} has no ${unsigned.join(', ')}, so it is not a package Mozilla signed`);
  archive.entries
    .filter((e) => SIGNATURE_FILES.includes(e.name) && e.size === 0)
    .forEach((e) => problems.push(`${label}: ${e.name} is empty`));
  problems.push(...layoutProblems(label, archive.entries));

  if (o.reference !== undefined && o.reference !== null) {
    let reference = null;
    if (Buffer.isBuffer(o.reference)) {
      try {
        reference = readCentral(o.reference);
      } catch (e) {
        problems.push(`the package ${label} is compared with cannot be read as a zip: ${e.message}`);
      }
    } else {
      const opened = openArchive(path.resolve(String(o.reference)), path.basename(String(o.reference)), problems);
      reference = opened && opened.entries;
    }
    if (reference) {
      const said = { 'only-in-a': 'not in the package', 'only-in-b': 'missing', changed: 'changed' };
      differentFiles(archive.entries, reference, (name) => name.startsWith('META-INF/')).forEach((d) => {
        differs.push(`${d.name} (${said[d.how]})`);
      });
      if (differs.length) {
        problems.push(`${label} does not hold the files of the package it should have been signed from: ${differs.join(', ')}`);
      }
    }
  }

  const entry = archive.entries.find((e) => e.name === 'manifest.json');
  if (!entry) return { problems, differs };
  let manifest;
  try {
    manifest = JSON.parse(readEntry(archive.buf, entry).toString('utf8'));
  } catch (e) {
    problems.push(`${label}: its manifest.json cannot be read: ${e.message}`);
    return { problems, differs };
  }
  const gecko = (manifest.browser_specific_settings || {}).gecko || {};
  if (gecko.id !== id) problems.push(`${label}: its gecko.id is ${JSON.stringify(gecko.id)}, not ${JSON.stringify(id)}`);
  if (manifest.version !== v) {
    problems.push(`${label}: its manifest is version ${JSON.stringify(manifest.version)}, not ${JSON.stringify(v)}`);
  }
  return { problems, differs, version: manifest.version };
}

/** updates.json as a release publishes it: pack.updatesManifest, two-space indented, ending in a newline. */
function updatesJsonText(version) {
  return `${JSON.stringify(pack.updatesManifest(checkVersion(version)), null, 2)}\n`;
}

/** Writes updates.json for a version, making the folder if need be. @returns {string} the text written */
function writeUpdatesJson(version, outFile) {
  const text = updatesJsonText(version);
  const to = path.resolve(String(outFile));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, text);
  return text;
}

// ── Deciding what a run does ────────────────────────────────────────────────

/**
 * What a release run should do, given what is already true.
 *
 * Decided in full before anything is done, so that every way a run can refuse
 * is a refusal with nothing yet created, and pure, so every branch can be
 * tested by handing it a state.
 *
 * - No AMO credentials: refused. A release cannot carry the signed add-on
 *   without them, and must not be published without it.
 * - A release for the tag that is already published: refused. Adding
 *   updates.json to it now is the window this whole order exists to avoid.
 * - A draft holding a .zip that is not Chrome's: refused, before anything is
 *   signed for it (zipProblems says why).
 * - A draft that already holds the signed .xpi: that file is used, and Mozilla
 *   is not asked again, since it signs each version once.
 * - Otherwise the Firefox package is unpacked and linted, a draft is made if
 *   there is none, and the package is signed.
 *
 * Every plan then checks the signed file, writes updates.json, uploads the
 * files, reads the draft back to see all four there, and publishes — always
 * last, and only ever reached when every step before it succeeded. A draft
 * that already held the signed file does not have it uploaded again: gh
 * replaces a file by deleting the one there first, and an upload that failed
 * after that would lose the one copy of a version Mozilla will not sign twice.
 *
 * The publish step's `latest` says whether the release may take "latest" at
 * all. A draft someone marked as a prerelease may not: it is published as one,
 * since GitHub never counts a prerelease as latest, which is what a prerelease
 * is for. Whether any other release does take it is only decided as it is
 * published, against whichever release is latest at that moment (takesLatest):
 * an older version published after a newer one must not take it back.
 *
 * @param {{credentials: boolean, version: string,
 *   release: null|{isDraft: boolean, isPrerelease?: boolean, assets: string[]}}} state
 *   `credentials` is whether both AMO credentials are set; `release` is the
 *   release already made for the tag, if any, with the names of the files it
 *   holds
 * @returns {{ok: true, reuse: boolean, steps: Array<{step: string, latest?: boolean}>}
 *   | {ok: false, reason: 'credentials'|'published'|'assets', message: string}}
 */
function planRelease(state) {
  const s = state || {};
  const version = checkVersion(s.version);
  const tag = `v${version}`;
  const xpi = pack.releaseAssetName(version, 'firefox-xpi');

  if (!s.credentials) {
    return {
      ok: false,
      reason: 'credentials',
      message: 'No AMO credentials: WEB_EXT_API_KEY and WEB_EXT_API_SECRET (the repository secrets AMO_JWT_ISSUER '
        + 'and AMO_JWT_SECRET) must both be set to sign the Firefox package. Nothing was created. A release is never '
        + `published without ${xpi} and ${UPDATES_JSON}, because as the latest release it would answer every Firefox `
        + 'install\'s update check with a 404. Set both secrets, then re-run the workflow.',
    };
  }

  const release = s.release || null;
  const assets = release && Array.isArray(release.assets) ? release.assets : [];
  if (release && !release.isDraft) {
    const complete = releaseFiles(version).every((name) => assets.includes(name));
    return {
      ok: false,
      reason: 'published',
      message: `The release ${tag} is already published, and nothing was changed. Files are only ever added to a draft: `
        + `a published release without ${UPDATES_JSON} answers every Firefox install's update check with a 404 for as long `
        + `as it is the latest. Delete the release, or turn it back into a draft (gh release edit ${tag} --draft=true), `
        + 'then re-run the workflow.'
        + (complete ? ' It already holds all four files, so if an earlier run published it there is nothing left to do.' : ''),
    };
  }

  const strayZips = zipProblems(assets, version, `The draft ${tag}`);
  if (strayZips.length) {
    return {
      ok: false,
      reason: 'assets',
      message: `${strayZips[0]}. Nothing was changed and nothing was sent to Mozilla. Delete the other .zip from the `
        + 'draft, then re-run the workflow.',
    };
  }

  const reuse = assets.includes(xpi);
  const steps = [];
  if (reuse) {
    steps.push({ step: 'download-xpi' });
  } else {
    steps.push({ step: 'extract' }, { step: 'lint' });
    if (!release) steps.push({ step: 'create-draft' });
    steps.push({ step: 'sign' });
  }
  steps.push(
    { step: 'verify-xpi' },
    { step: 'updates-json' },
    { step: 'upload' },
    { step: 'confirm-assets' },
    { step: 'publish', latest: !(release && release.isPrerelease) },
  );
  return { ok: true, reuse, steps };
}

// ── Running it ──────────────────────────────────────────────────────────────

/** A run that stopped, with what it was doing and what it had already done. */
class ReleaseError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ReleaseError';
    Object.assign(this, { reason: 'step', step: null, completed: [], hint: '' }, details || {});
  }
}

/**
 * Runs one command, the way every command here is run.
 *
 * Output is passed straight through, so a long signing shows its progress in
 * the workflow log as it goes, unless it is captured to be read. The command
 * runs with the environment it is handed, which is how the credentials reach
 * web-ext and the token reaches gh without either appearing in an argument —
 * and publish() hands each command one made for it by commandEnv, so neither
 * reaches anything else. Called without one, it passes on its own process's.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{capture?: boolean, cwd?: string, env?: object}} [options]
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runCommand(command, args, options) {
  const o = options || {};
  // npx is a .cmd script on Windows, which Node will only start through a
  // shell, and a shell splits arguments on spaces. The release workflow runs on
  // Linux; this is for running a step by hand.
  const viaShell = process.platform === 'win32' && command === 'npx';
  const argv = viaShell
    ? args.map((arg) => (/[\s"&|<>^]/.test(arg) ? `"${String(arg).replace(/"/g, '""')}"` : arg))
    : args;
  const result = childProcess.spawnSync(command, argv, {
    cwd: o.cwd || ROOT,
    env: o.env || process.env,
    encoding: 'utf8',
    shell: viaShell,
    stdio: o.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) return { status: 127, stdout: '', stderr: result.error.message };
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * The release already made for a tag, as gh reports it, or null when there is
 * none.
 *
 * Only gh's own "release not found" counts as none. Any other failure — a bad
 * token, GitHub not answering — is a failure, because taking it for "no
 * release" would go on to create one beside a release that may well exist.
 * A release whose draft state cannot be read counts as published, which is
 * refused.
 *
 * `env` is the environment gh runs with, which publish() has already stripped
 * of everything but gh's own token.
 */
function readRelease(run, tag, cwd, env) {
  const result = run('gh', ['release', 'view', tag, '--json', 'tagName,isDraft,isPrerelease,assets'], { capture: true, cwd, env }) || {};
  if (result.status === 0) {
    let data;
    try {
      data = JSON.parse(result.stdout);
    } catch (e) {
      throw new Error(`gh release view ${tag} did not answer with JSON: ${e.message}`);
    }
    if (!data || data.tagName !== tag) {
      throw new Error(`gh release view ${tag} answered about ${JSON.stringify(data && data.tagName)} instead`);
    }
    return {
      isDraft: data.isDraft === true,
      isPrerelease: data.isPrerelease === true,
      // An upload that broke off part-way leaves an asset that is listed but
      // not uploaded, and that is not a file the release has.
      assets: (Array.isArray(data.assets) ? data.assets : [])
        .filter((asset) => asset && (!asset.state || asset.state === 'uploaded'))
        .map((asset) => asset.name),
    };
  }
  const stderr = String(result.stderr || '').trim();
  if (/release not found/i.test(stderr)) return null;
  throw new Error(`could not read the release for ${tag}: gh exited with ${result.status}${stderr ? `: ${stderr}` : ''}`);
}

/**
 * The tag of the repository's latest release, as GitHub counts it, or null when
 * there is none.
 *
 * `gh release view` with no tag asks GitHub for exactly that, which is never a
 * draft or a prerelease. As with readRelease, only gh's own "release not
 * found" counts as none; anything else is a failure, since guessing here decides
 * which updates.json every signed install reads.
 */
function readLatest(run, cwd, env) {
  const result = run('gh', ['release', 'view', '--json', 'tagName'], { capture: true, cwd, env }) || {};
  if (result.status === 0) {
    let data;
    try {
      data = JSON.parse(result.stdout);
    } catch (e) {
      throw new Error(`gh release view did not answer with JSON when asked for the latest release: ${e.message}`);
    }
    if (!data || typeof data.tagName !== 'string' || !data.tagName) {
      throw new Error('gh release view named no tag when asked for the latest release');
    }
    return data.tagName;
  }
  const stderr = String(result.stderr || '').trim();
  if (/release not found/i.test(stderr)) return null;
  throw new Error(`could not read which release is the latest: gh exited with ${result.status}${stderr ? `: ${stderr}` : ''}`);
}

/**
 * Whether a release of `version`, published now, should take "latest" from
 * the release that has it.
 *
 * Only when it is newer. "Latest" is where every signed Firefox install reads
 * updates.json from, where the README's download link goes, and what Chrome's
 * own update check compares itself with; an older version taking it — a draft
 * left from a stopped run and re-run after the next version shipped, or two
 * tags whose signing finished in the wrong order — would send every one of
 * them back to that version, and Firefox, which never goes back a version,
 * would simply stop updating. GitHub makes a newly published release latest
 * unless it is told not to, so publishing without the flag is not enough.
 *
 * Compared number by number, so 1.10.0 is newer than 1.9.0. A version equal to
 * the latest is not newer. A latest release whose tag is not a version cannot
 * be compared with, and is a failure rather than a guess.
 *
 * @param {string} version this release's, without the tag's v
 * @param {string|null} latestTag the latest release's tag, or null for none
 * @returns {boolean}
 */
function takesLatest(version, latestTag) {
  const mine = checkVersion(version).split('.').map(Number);
  if (latestTag === null || latestTag === undefined) return true;
  const m = /^v?(\d+(?:\.\d+){0,3})$/.exec(String(latestTag));
  if (!m) {
    throw new Error(`the latest release is tagged ${JSON.stringify(latestTag)}, which is not a version ${version} can be compared with`);
  }
  const theirs = m[1].split('.').map(Number);
  for (let i = 0; i < Math.max(mine.length, theirs.length); i++) {
    const diff = (mine[i] || 0) - (theirs[i] || 0);
    if (diff) return diff > 0;
  }
  return false;
}

function releasePaths(distDir, version) {
  const dist = path.resolve(String(distDir));
  return {
    dist,
    chrome: path.join(dist, pack.releaseAssetName(version, 'chrome')),
    firefox: path.join(dist, pack.releaseAssetName(version, 'firefox')),
    xpi: path.join(dist, pack.releaseAssetName(version, 'firefox-xpi')),
    updates: path.join(dist, UPDATES_JSON),
    // web-ext writes .amo-upload-uuid into the folder it signs, and saves the
    // signed file into the other, which is expected to hold nothing else.
    source: path.join(dist, 'firefox-src'),
    signed: path.join(dist, 'firefox-signed'),
  };
}

function xpisIn(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /\.xpi$/i.test(name)).sort() : [];
}

// What each step does. Commands go through ctx.exec, which stops the run on
// anything but success and hands each command only the credentials it needs;
// everything else is done here, in this process.
const STEPS = {
  // From the bytes verify-packages checked, held since, rather than from the
  // file on disk, which is the same file only until something writes to it.
  extract(ctx) {
    const written = extractZip(ctx.packages.firefox.buf, ctx.paths.source);
    ctx.log(`Unpacked ${written.length} files from ${path.basename(ctx.paths.firefox)} into ${ctx.paths.source}`);
  },

  // --self-hosted, because the linter otherwise assumes a listing on
  // addons.mozilla.org, where an update_url is refused. Run with no credentials
  // of any kind, since linting needs none.
  lint(ctx) {
    ctx.exec('npx', ['--yes', WEB_EXT, 'lint', '--source-dir', ctx.paths.source, '--self-hosted', '--no-config-discovery']);
  },

  'create-draft'(ctx) {
    ctx.exec('gh', ['release', 'create', ctx.tag, '--draft', '--verify-tag', '--title', ctx.tag, '--generate-notes']);
  },

  sign(ctx) {
    const stale = xpisIn(ctx.paths.signed);
    if (stale.length) {
      throw new Error(`${ctx.paths.signed} already holds ${stale.join(', ')}; only a file this run signs may be renamed into the release`);
    }
    if (fs.existsSync(ctx.paths.xpi)) {
      throw new Error(`${ctx.paths.xpi} already exists; refusing to put a newly signed file over it`);
    }
    // The one command the AMO credentials are handed to.
    ctx.exec('npx', ['--yes', WEB_EXT, 'sign', '--channel', 'unlisted',
      '--source-dir', ctx.paths.source, '--artifacts-dir', ctx.paths.signed, '--no-config-discovery'], { grant: 'amo' });
    const signed = xpisIn(ctx.paths.signed);
    if (signed.length !== 1) {
      throw new Error(`web-ext sign finished but left ${signed.length} .xpi files in ${ctx.paths.signed}, not one${signed.length ? `: ${signed.join(', ')}` : ''}`);
    }
    fs.renameSync(path.join(ctx.paths.signed, signed[0]), ctx.paths.xpi);
    ctx.log(`Signed: ${signed[0]}, saved as ${path.basename(ctx.paths.xpi)}`);
  },

  'download-xpi'(ctx) {
    const name = path.basename(ctx.paths.xpi);
    ctx.exec('gh', ['release', 'download', ctx.tag, '--pattern', name, '--dir', ctx.paths.dist, '--clobber']);
    if (!fs.existsSync(ctx.paths.xpi)) throw new Error(`gh release download finished but ${ctx.paths.xpi} is not there`);
    ctx.log(`Using the ${name} already on the draft ${ctx.tag}; it is not signed again`);
  },

  // Checked against the package it should have been signed from — the bytes
  // verify-packages passed — as well as for its signature, ID and version, and
  // on either path a file that fails stops the run. Coming from the draft,
  // nothing is lost by that: the file stays where it is. Straight after
  // signing, a version Mozilla will not sign again is at stake, but a signed
  // file holding anything but the package this run checked is not one to
  // publish at any price; the workflow keeps it as an artifact, and the hint
  // says so.
  'verify-xpi'(ctx) {
    const { problems, differs, version } = verifyXpi(ctx.paths.xpi, ctx.version, { reference: ctx.packages.firefox.buf });
    ctx.xpi = { differs, version };
    if (problems.length) throw new Error(problems.join('; '));
    ctx.log(`Checked ${path.basename(ctx.paths.xpi)}: signed, ${pack.GECKO_ID}, version ${ctx.version}, `
      + `holding exactly the files of ${path.basename(ctx.paths.firefox)}`);
  },

  'updates-json'(ctx) {
    writeUpdatesJson(ctx.version, ctx.paths.updates);
    ctx.log(`Wrote ${ctx.paths.updates}`);
  },

  // Every file still there, and both packages still the bytes that were
  // checked: web-ext has run since, and could have written to either. The
  // signed .xpi goes up only when this run signed it. One that came from the
  // draft is on the draft already, and --clobber replaces a file by deleting
  // the one there before uploading its own, so a failure part-way through
  // re-uploading it would lose the only copy of a version Mozilla will not sign
  // again. confirm-assets still reads it back before anything is published.
  upload(ctx) {
    const all = [ctx.paths.chrome, ctx.paths.firefox, ctx.paths.xpi, ctx.paths.updates];
    const absent = all.filter((file) => !fs.existsSync(file));
    if (absent.length) throw new Error(`not uploading, since these are missing: ${absent.join(', ')}`);
    const changed = ['chrome', 'firefox']
      .filter((kind) => sha256(fs.readFileSync(ctx.paths[kind])) !== ctx.packages[kind].sha256);
    if (changed.length) {
      ctx.packagesChanged = true;
      throw new Error(`not uploading, since ${changed.map((kind) => path.basename(ctx.paths[kind])).join(' and ')} `
        + 'changed on disk after the packages were checked');
    }
    const files = ctx.reuse ? all.filter((file) => file !== ctx.paths.xpi) : all;
    ctx.exec('gh', ['release', 'upload', ctx.tag, ...files, '--clobber']);
  },

  // Read back rather than trusted: publishing is the one step that cannot be
  // taken back, so what it publishes is looked at first — all four files, and
  // no .zip but Chrome's.
  'confirm-assets'(ctx) {
    const release = readRelease(ctx.run, ctx.tag, ctx.cwd, commandEnv(ctx.env, 'github'));
    if (!release) throw new Error(`the release ${ctx.tag} is gone`);
    if (!release.isDraft) throw new Error(`the release ${ctx.tag} was published by something other than this run`);
    const absent = releaseFiles(ctx.version).filter((name) => !release.assets.includes(name));
    if (absent.length) throw new Error(`the draft ${ctx.tag} does not hold ${absent.join(', ')}`);
    const zips = zipProblems(release.assets, ctx.version, `the draft ${ctx.tag}`);
    if (zips.length) throw new Error(`${zips[0]}; delete the others from the draft`);
    ctx.log(`The draft ${ctx.tag} holds all four files, and no .zip but Chrome's`);
  },

  // "Latest" is decided here, as the last thing before publishing, against the
  // release that has it now rather than the one that had it when the run
  // started: signing alone can take a quarter of an hour, and another
  // version's run may have published in the meantime (takesLatest).
  publish(ctx, step) {
    let flags = [];
    if (step.latest) {
      const current = readLatest(ctx.run, ctx.cwd, commandEnv(ctx.env, 'github'));
      const newer = takesLatest(ctx.version, current);
      ctx.latest = { current, newer };
      flags = [newer ? '--latest' : '--latest=false'];
      ctx.log(newer
        ? `${ctx.tag} is newer than ${current || 'any release published so far'}, so it becomes the latest release`
        : `::notice::${current} is the latest release and ${ctx.tag} is not newer than it, so ${ctx.tag} is published `
          + `without becoming the latest: signed Firefox installs go on reading the ${UPDATES_JSON} of ${current}.`);
    }
    ctx.exec('gh', ['release', 'edit', ctx.tag, '--draft=false', ...flags]);
  },
};

// What to do about a run that stopped at a step, said for the person reading
// the log, who needs to know what exists now and whether re-running is safe.
function hintFor(step, ctx) {
  const xpi = path.basename(ctx.paths.xpi);
  const signedHere = ctx.completed.includes('sign');
  const draft = ctx.hadRelease || ctx.completed.includes('create-draft');
  const unpublished = draft ? `The draft ${ctx.tag} is left unpublished.` : 'Nothing was created on GitHub.';
  switch (step) {
    case 'extract':
    case 'lint':
      return `${unpublished} Nothing was sent to Mozilla. Once the package is fixed it has to be released from a `
        + 'commit that has the fix: move the tag to it, or release a new version.';
    case 'create-draft':
      return 'No draft was made and nothing was sent to Mozilla. Re-run the workflow once GitHub accepts the draft.';
    case 'sign':
      return `${unpublished} If Mozilla never signed ${ctx.version}, fix the cause and re-run. If it did (the add-on's `
        + `versions in the addons.mozilla.org Developer Hub say so), it will not sign ${ctx.version} again: download the `
        + 'signed file from there, or from the signed-firefox-xpi artifact of the run that signed it, attach it to the '
        + `draft as ${xpi}, and re-run. Only a file signed from this commit's package will do: the re-run compares it, `
        + 'file by file, with the package it builds, and a draft that holds such a file is published with it, not signed '
        + 'again. A file signed from anything else is not this release, which then goes out as the next version.';
    case 'download-xpi':
    case 'verify-xpi': {
      const differs = Boolean(ctx.xpi && ctx.xpi.differs.length);
      const thisVersion = Boolean(ctx.xpi && ctx.xpi.version === ctx.version);
      if (signedHere && differs) {
        return `Mozilla has signed ${ctx.version} and will not sign it again, but the file that came back does not hold `
          + 'the files of the package this run checked and sent. It was not uploaded, and must not be: it is kept at '
          + `${ctx.paths.xpi}, as this run's signed-firefox-xpi artifact, to find out what changed it. The draft `
          + `${ctx.tag} is left unpublished. Unless the difference turns out to be harmless, release the next version.`;
      }
      if (signedHere) {
        return `Mozilla has signed ${ctx.version} and will not sign it again, but the file it returned failed the check. It is `
          + `at ${ctx.paths.xpi}, kept as this run's signed-firefox-xpi artifact. Nothing was uploaded, and the draft `
          + `${ctx.tag} is left unpublished.`;
      }
      if (differs && thisVersion) {
        return `The ${xpi} on the draft ${ctx.tag} is ${ctx.version}, but it was signed from a different build than this `
          + 'commit\'s package, so publishing it would ship code this release never checked. The draft is left unpublished. '
          + `Mozilla will not sign ${ctx.version} again, so moving the tag cannot fix this. If the file Mozilla signed from `
          + 'this commit\'s package still exists (the signed-firefox-xpi artifact of the run that signed it), put it on the '
          + `draft in place of this one and re-run; otherwise delete ${xpi} from the draft and release the next version.`;
      }
      return `The ${xpi} on the draft ${ctx.tag} is not usable as this release's signed add-on. Replace it with the file `
        + `Mozilla signed for ${ctx.version} from this commit's package — from the addons.mozilla.org Developer Hub, or the `
        + 'signed-firefox-xpi artifact of the run that signed it — and re-run; if Mozilla never signed '
        + `${ctx.version}, delete it from the draft and re-run, and it is signed. The draft is left unpublished.`;
    }
    case 'updates-json':
      return `${unpublished} Nothing was uploaded.`;
    case 'upload':
    case 'confirm-assets':
      if (ctx.packagesChanged) {
        return `The draft ${ctx.tag} is left unpublished and nothing was uploaded. A package changed on disk between being `
          + 'checked and being uploaded, which nothing in a release does: find out what wrote to it before re-running'
          + (signedHere ? `, and keep ${xpi}, this run's signed-firefox-xpi artifact, since Mozilla will not sign ${ctx.version} again.` : '.');
      }
      if (ctx.reuse) {
        return `The draft ${ctx.tag} is left unpublished, so no Firefox install has seen a release without ${UPDATES_JSON}. `
          + `${xpi} was not part of this upload, so the copy already on the draft is untouched. Re-run the workflow, and it `
          + 'is used again rather than signed again.';
      }
      return `The draft ${ctx.tag} is left unpublished, so no Firefox install has seen a release without ${UPDATES_JSON}. `
        + `Re-run the workflow: if ${xpi} reached the draft it is used again rather than signed again`
        + (signedHere ? `; if it did not, attach it to the draft first (it is this run's signed-firefox-xpi artifact).` : '.');
    case 'publish':
      if (ctx.prerelease) {
        return `Every file is attached to the draft ${ctx.tag}; only publishing it failed. Re-run the workflow, or `
          + `publish it by hand as the prerelease it is: gh release edit ${ctx.tag} --draft=false`;
      }
      if (ctx.latest) {
        return `Every file is attached to the draft ${ctx.tag}; only publishing it failed. Re-run the workflow, or `
          + `publish it by hand: gh release edit ${ctx.tag} --draft=false ${ctx.latest.newer ? '--latest' : '--latest=false'}`
          + (ctx.latest.newer ? '' : ` (not --latest: ${ctx.latest.current} is newer, and has to stay the latest release)`);
      }
      return `Every file is attached to the draft ${ctx.tag}, and nothing was published: which release is the latest could `
        + `not be worked out. Re-run the workflow, or publish it by hand with gh release edit ${ctx.tag} --draft=false, `
        + `adding --latest only if ${ctx.version} is newer than the release \`gh release view --json tagName\` names and `
        + '--latest=false otherwise — GitHub makes a newly published release the latest unless it is told not to.';
    default:
      return unpublished;
  }
}

/**
 * The whole release, for a tag whose packages are already built.
 *
 * Checks the packages, reads what already exists for the tag, plans with
 * planRelease, and runs the plan one step at a time, stopping at the first
 * that fails. Publishing is the plan's last step, so it runs only when every
 * other step has.
 *
 * @param {{tag: string, distDir: string, env?: object, run?: Function,
 *   log?: Function, cwd?: string, root?: string}} opts
 *   `run` in place of runCommand; `env` in place of process.env, for the
 *   credentials check and as the environment every command's own is made from
 * @returns {{plan: object, completed: string[]}}
 * @throws {ReleaseError} with `reason`, and for a failed step `step`,
 *   `completed` and `hint`
 */
function publish(opts) {
  const o = opts || {};
  const tag = String(o.tag || '');
  let version;
  try {
    if (!tag.startsWith('v')) throw new Error(`"${tag}" is not a release tag: it should be v followed by the manifest's version`);
    version = checkVersion(tag.slice(1));
    pack.updatesManifest(version); // refuses a version Firefox cannot compare, before anything else
  } catch (e) {
    throw new ReleaseError(e.message, { reason: 'usage' });
  }
  const run = o.run || runCommand;
  const env = o.env || process.env;
  const log = o.log || ((line) => console.log(line));
  const cwd = o.cwd || ROOT;
  const paths = releasePaths(o.distDir, version);
  const nothingDone = 'Nothing was created on GitHub and nothing was sent to Mozilla.';

  const { problems } = verifyPackages(paths.dist, version, { root: o.root });
  if (problems.length) {
    throw new ReleaseError(`The packages in ${paths.dist} are not fit to release:\n  ${problems.join('\n  ')}`,
      { reason: 'packages', hint: nothingDone });
  }
  // The packages as they were checked, by their bytes and hashes. What is
  // unpacked for signing, what the signed file is compared with and what is
  // uploaded are all held to these, not to whatever the files hold later.
  const packages = {};
  ['chrome', 'firefox'].forEach((kind) => {
    const buf = fs.readFileSync(paths[kind]);
    packages[kind] = { buf, sha256: sha256(buf) };
  });

  // Asked before GitHub is, so a run with no credentials does nothing at all.
  const credentials = Boolean(env.WEB_EXT_API_KEY && env.WEB_EXT_API_SECRET);
  let release = null;
  if (credentials) {
    try {
      release = readRelease(run, tag, cwd, commandEnv(env, 'github'));
    } catch (e) {
      throw new ReleaseError(e.message, { reason: 'read-release', hint: nothingDone });
    }
  }
  const plan = planRelease({ credentials, version, release });
  if (!plan.ok) throw new ReleaseError(plan.message, { reason: plan.reason });
  log(`Release ${tag}: ${plan.steps.map((s) => s.step).join(', ')}`);

  const ctx = {
    tag,
    version,
    paths,
    cwd,
    run,
    log,
    env,
    packages,
    reuse: plan.reuse,
    prerelease: Boolean(release && release.isPrerelease),
    hadRelease: Boolean(release),
    completed: [],
    // gh gets gh's token; `grant: 'amo'` gets the AMO credentials, and only
    // `web-ext sign` asks for it; anything else gets neither.
    exec(command, args, options) {
      const opt = options || {};
      const grant = command === 'gh' ? 'github' : (opt.grant || null);
      log(`$ ${[command, ...args].join(' ')}`);
      const result = run(command, args, { capture: Boolean(opt.capture), cwd, env: commandEnv(env, grant) }) || {};
      if (result.status !== 0) {
        const said = String(result.stderr || '').trim();
        throw new Error(`${command} ${args.filter((a) => a !== '--yes').slice(0, 2).join(' ')} exited with ${result.status}${said ? `: ${said}` : ''}`);
      }
      return result;
    },
  };

  plan.steps.forEach((step, i) => {
    try {
      if (step.step === 'publish' && i !== plan.steps.length - 1) throw new Error('publishing has to be the last step');
      STEPS[step.step](ctx, step);
    } catch (e) {
      throw new ReleaseError(e.message, {
        step: step.step, completed: ctx.completed.slice(), hint: hintFor(step.step, ctx),
      });
    }
    ctx.completed.push(step.step);
  });
  log(`Published ${tag}`);
  return { plan, completed: ctx.completed.slice() };
}

// ── Command line ────────────────────────────────────────────────────────────

const USAGE = [
  'usage: node tools/release.js verify-packages <distDir> <version>',
  '       node tools/release.js verify-xpi <file> <version>',
  '       node tools/release.js updates-json <version> <outFile>',
  '       node tools/release.js publish <tag> <distDir>',
].join('\n');

/**
 * Runs one command line, returning the exit status rather than exiting, so the
 * suite can call it: 0 when all is well, 1 when something is wrong with what
 * was checked or done, 2 when the command line itself is.
 *
 * Problems are printed as GitHub annotations, which read as plain lines
 * anywhere else.
 */
function main(argv, io) {
  const i = io || {};
  const out = i.log || ((line) => console.log(line));
  const err = i.error || ((line) => console.error(line));
  const [command, ...rest] = argv;
  const expect = (count) => {
    if (rest.length !== count) throw Object.assign(new Error(`${command} takes ${count} arguments`), { usage: true });
  };
  const report = (what, problems) => {
    problems.forEach((problem) => err(`::error::${problem}`));
    if (problems.length) return 1;
    out(`${what}: all good`);
    return 0;
  };
  try {
    switch (command) {
      case 'verify-packages':
        expect(2);
        return report(`${path.resolve(rest[0])} for ${rest[1]}`, verifyPackages(rest[0], rest[1]).problems);
      case 'verify-xpi':
        expect(2);
        return report(`${path.resolve(rest[0])} for ${rest[1]}`, verifyXpi(rest[0], rest[1]).problems);
      case 'updates-json':
        expect(2);
        writeUpdatesJson(rest[0], rest[1]);
        out(path.resolve(rest[1]));
        return 0;
      case 'publish':
        expect(2);
        publish({ tag: rest[0], distDir: rest[1], run: i.run, env: i.env, log: out });
        return 0;
      default:
        err(USAGE);
        return 2;
    }
  } catch (e) {
    if (e.usage || (e instanceof ReleaseError && e.reason === 'usage')) {
      err(`${e.message}\n${USAGE}`);
      return 2;
    }
    const [first, ...more] = String(e.message).split('\n');
    err(`::error::${first}`);
    more.forEach((line) => err(line));
    if (e.step) err(`Stopped at: ${e.step}. Done before it: ${e.completed.length ? e.completed.join(', ') : 'nothing'}. Not published.`);
    if (e.hint) err(e.hint);
    return 1;
  }
}

module.exports = {
  readCentral, readEntry, extractZip, unsafeEntryName, differentFiles,
  verifyPackages, verifyXpi, updatesJsonText, writeUpdatesJson, releaseFiles, zipProblems,
  planRelease, readRelease, readLatest, takesLatest, publish, runCommand, commandEnv, main, ReleaseError,
  WEB_EXT, SIGNATURE_FILES, UPDATES_JSON, AMO_VARIABLES, GITHUB_TOKEN_VARIABLES,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
