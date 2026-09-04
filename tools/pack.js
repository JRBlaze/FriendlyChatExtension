// Builds the release zip.
//
//   node tools/pack.js            -> dist/FriendlyChatExtension-v<version>.zip
//   node tools/pack.js <outdir>
//
// The zip has NO wrapper directory. It opens straight onto `manifest.json`,
// next to `src` and `icons`, so extracting it gives one folder holding the
// extension rather than a folder holding a folder — which is what Chrome's
// "Load unpacked" wants, since it needs the folder with the manifest directly
// inside it.
//
// This exists because that had already gone wrong. Releases here are built and
// uploaded by hand, and v1.18.2 and v1.18.3 went out with everything wrapped in
// a `FriendlyChatExtension/` directory, putting the manifest a level deeper
// than anyone following the README would look. Nothing caught it, because
// nothing was checking: the zip was whatever the person making it happened to
// select. Now there is one way to build it, the test suite checks what it
// produces, and the release workflow is the only thing that uploads it.
//
// No dependencies, and nothing to install first — the same as the rest of this
// repository. Node cannot write a zip on its own, so the archive is assembled
// here from `zlib.deflateRawSync` and about eighty bytes of header per file.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');

// What Chrome loads, plus the two documents that have always shipped beside it.
// Everything else in the repository — the test suite, the Cloudflare worker, CI
// — is not part of the extension and has no business in a user's folder.
const ROOTS = ['icons', 'src'];
const LOOSE = ['LICENSE', 'README.md', 'manifest.json'];

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

/** The archive for the working tree, as a Buffer. */
function build(root) {
  const base = root || ROOT;
  return zip(collect(base).map((name) => ({
    name,                                       // no prefix: the zip root
    data: fs.readFileSync(path.join(base, name)),
  })));
}

function version(root) {
  const base = root || ROOT;
  return JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')).version;
}

function assetName(root) {
  return `FriendlyChatExtension-v${version(root)}.zip`;
}

module.exports = { collect, build, zip, crc32, version, assetName, ROOTS, LOOSE };

if (require.main === module) {
  const outDir = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
  fs.mkdirSync(outDir, { recursive: true });
  const names = collect();
  const out = path.join(outDir, assetName());
  fs.writeFileSync(out, build());
  console.log(`${out}`);
  console.log(`${names.length} files, ${fs.statSync(out).size} bytes`);
}
