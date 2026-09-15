// Copy each Steam game's Background (hero) into its Wide Cover slot.
// Dry-run unless apply is true. Fully restart Steam to see changes.
//
// action: run | list-backups | restore
// apply / allAccounts / skipExisting / coversOnly: true or false
// steam / account / game / coversDir / restore: leave blank if unused
//
// coversDir: a folder of wide background images (the appid must appear in each
// filename). A match there replaces both the game's wide cover AND its
// background (hero) art, so the library page and the capsule agree.
//
// coversOnly: plan ONLY the games that folder matched, instead of also falling
// back to Steam's own hero art for everything else. Five images with an appid in
// the name means five games touched, and the rest of the library is left alone.
//
// pick: first | random. What to do when the covers folder holds several images
// for the same appid (which is exactly what the companion "Steam Heroes from
// SteamGridDB" script produces, one file per rank). "first" takes the
// alphabetically first name, so every run applies the same art; "random" draws a
// different one of them each run, so repeated runs rotate the library's art.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function isTrue(value) {
  const v = String(value).trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function unset(value) {
  const v = String(value).trim();
  return v === "" ? null : v;
}

// A word field with a fixed set of answers. Anything unrecognised falls back
// rather than throwing: a typo here should not stop a run that is otherwise fine.
function choice(value, allowed, fallback) {
  const v = String(value).trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

// The :kind after a name picks the control the Scripts tab renders for the
// field — a dropdown, a toggle, a folder picker. Each still hands this script a
// plain string, so the parsing above is unchanged.
const action = String({{action:one(run|list-backups|restore)=run}}).trim() || "run";
const opts = {
  apply: isTrue({{apply:bool=false}}),
  steam: unset({{steam:dir}}),
  account: unset({{account}}),
  allAccounts: isTrue({{allAccounts:bool=false}}),
  game: unset({{game}}),
  skipExisting: isTrue({{skipExisting:bool=false}}),
  coversDir: unset({{coversDir:dir}}),
  coversOnly: isTrue({{coversOnly:bool=false}}),
  pick: choice({{pick:one(first|random)=first}}, ["first", "random"], "first"),
  restore: unset({{restore}}),
};

class UserError extends Error {}

// Extensions we recognise when looking for a source background.
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".tga", ".bmp"];

// Extensions Steam actually loads from the grid folder. Copying anything else in
// produces a file Steam silently ignores, so those sources are skipped instead.
const STEAM_READABLE_EXTS = new Set([".png", ".jpg", ".jpeg"]);

const BACKUP_PREFIX = "_widecover_backup_";

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isImage(name) {
  return IMAGE_EXTS.includes(path.extname(name).toLowerCase());
}

function readdirSafe(dir, options) {
  try { return fs.readdirSync(dir, options); } catch { return []; }
}

// Steam's own folders are scanned best-effort: a missing librarycache or grid is normal, so
// readdirSafe turning that into an empty list is right. The covers folder is different — the
// user explicitly pointed at it, so failing to read it has to be reported rather than silently
// becoming "no images". This matters most on macOS, where an app without Files-and-Folders
// access gets EPERM listing ~/Desktop, ~/Documents or ~/Downloads while statSync still
// succeeds: the folder looks present and simply always scans empty.
function readdirOrThrow(dir, options) {
  try {
    return fs.readdirSync(dir, options);
  } catch (err) {
    const denied = err.code === "EPERM" || err.code === "EACCES";
    throw new UserError(
      `Could not read the covers folder: ${dir}\n  ${err.code || "error"}: ${err.message}` +
      (denied
        ? "\n\nmacOS is blocking this folder. Either grant the app access in System Settings →" +
          "\nPrivacy & Security → Files and Folders (or Full Disk Access), or move the images to" +
          "\nan unprotected folder such as ~/steam-covers and point the covers field there."
        : "")
    );
  }
}

// ---------------------------------------------------------------------------
// Steam discovery
// ---------------------------------------------------------------------------

function candidateSteamRoots() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "Steam")];
  }
  if (process.platform === "win32") {
    const roots = [];
    if (process.env["ProgramFiles(x86)"]) roots.push(path.join(process.env["ProgramFiles(x86)"], "Steam"));
    if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, "Steam"));
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "Steam"));
    roots.push("C:\\Program Files (x86)\\Steam");
    roots.push("C:\\Program Files\\Steam");
    return roots;
  }
  // linux & others
  return [
    path.join(home, ".steam", "steam"),
    path.join(home, ".local", "share", "Steam"),
    path.join(home, ".var", "app", "com.valvesoftware.Steam", "data", "Steam"),
  ];
}

function findSteamRoot(override) {
  if (override) {
    if (!isDir(override)) throw new UserError(`Steam path does not exist or is not a directory: ${override}`);
    return override;
  }
  for (const c of candidateSteamRoots()) {
    if (isDir(c)) return c;
  }
  return null;
}

function gridDirFor(steamRoot, accountId) {
  return path.join(steamRoot, "userdata", accountId, "config", "grid");
}

// ---------------------------------------------------------------------------
// Account discovery
// ---------------------------------------------------------------------------

// A real userdata account folder is a numeric Steam3 account id.
function listAccounts(steamRoot) {
  const userdata = path.join(steamRoot, "userdata");
  if (!isDir(userdata)) return [];
  return readdirSafe(userdata, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name) && e.name !== "0")
    .map((e) => e.name)
    .sort();
}

// Best-effort persona name for an account, read from its localconfig.vdf.
// Purely cosmetic — used to label the account picker in the GUI.
function accountLabel(steamRoot, accountId) {
  const cfg = path.join(steamRoot, "userdata", accountId, "config", "localconfig.vdf");
  if (!isFile(cfg)) return null;
  let text;
  try { text = fs.readFileSync(cfg, "utf8"); } catch { return null; }
  const m = text.match(/"PersonaName"\s+"((?:[^"\\]|\\.)*)"/i);
  return m ? unescapeVdf(m[1]) : null;
}

function resolveAccounts(steamRoot, opts) {
  const all = listAccounts(steamRoot);
  if (all.length === 0) throw new UserError(`No userdata accounts found under ${path.join(steamRoot, "userdata")}.`);

  if (opts.account) {
    const wanted = String(opts.account);
    if (!all.includes(wanted)) {
      throw new UserError(`Account ${wanted} not found. Available accounts: ${all.join(", ")}`);
    }
    return [wanted];
  }
  if (opts.allAccounts) return all;
  if (all.length === 1) return all;

  throw new UserError(
    `Multiple Steam accounts found: ${all.join(", ")}.\n` +
    `Pick one in the account field, or set allAccounts to true.`
  );
}

// ---------------------------------------------------------------------------
// Background-source discovery
// ---------------------------------------------------------------------------

// appcache/librarycache is account-independent and can hold thousands of entries,
// so it is scanned once per Steam root and reused for every account.
const cacheHeroCache = new Map();

function discoverCacheHeroes(steamRoot, { refresh = false } = {}) {
  if (!refresh && cacheHeroCache.has(steamRoot)) return cacheHeroCache.get(steamRoot);

  const heroes = new Map(); // appid -> file
  const cacheDir = path.join(steamRoot, "appcache", "librarycache");
  for (const entry of readdirSafe(cacheDir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\d+$/.test(entry.name)) {
      // Current layout: librarycache/<appid>/library_hero.jpg
      const appid = entry.name;
      if (heroes.has(appid)) continue;
      for (const name of readdirSafe(path.join(cacheDir, appid))) {
        if (path.basename(name, path.extname(name)).toLowerCase() === "library_hero" && isImage(name)) {
          heroes.set(appid, path.join(cacheDir, appid, name));
          break;
        }
      }
    } else if (entry.isFile()) {
      // Older layout: librarycache/<appid>_library_hero.jpg
      const m = entry.name.match(/^(\d+)_library_hero\.(png|jpg|jpeg|webp|tga|bmp)$/i);
      if (m && !heroes.has(m[1])) heroes.set(m[1], path.join(cacheDir, entry.name));
    }
  }

  cacheHeroCache.set(steamRoot, heroes);
  return heroes;
}

function clearCaches() {
  cacheHeroCache.clear();
}

// One pass over the grid folder, indexing both the custom heroes we can read from
// (<appid>_hero.<ext>) and the wide covers we would be replacing (<appid>.<ext>).
// Doing this once avoids re-reading the directory for every game in the library.
function readGridIndex(gridDir) {
  const heroes = new Map();       // appid -> file        (what we read a background from)
  const heroFiles = new Map();    // appid -> [file, ...] (every variant, for backup/removal)
  const covers = new Map();       // appid -> [file, ...]
  for (const entry of readdirSafe(gridDir, { withFileTypes: true })) {
    if (!entry.isFile() || !isImage(entry.name)) continue;
    const full = path.join(gridDir, entry.name);
    const hero = entry.name.match(/^(\d+)_hero\.(png|jpg|jpeg|webp|tga|bmp)$/i);
    if (hero) {
      if (!heroes.has(hero[1])) heroes.set(hero[1], full);
      if (!heroFiles.has(hero[1])) heroFiles.set(hero[1], []);
      heroFiles.get(hero[1]).push(full);
      continue;
    }
    const base = path.basename(entry.name, path.extname(entry.name));
    if (/^\d+$/.test(base)) {
      if (!covers.has(base)) covers.set(base, []);
      covers.get(base).push(full);
    }
  }
  return { heroes, heroFiles, covers };
}

// Build appid -> { file, kind } for every game with a background available.
// The official cached hero wins; a custom grid hero fills the gaps.
function discoverBackgrounds(steamRoot, gridDir, gridIndex) {
  const index = gridIndex || readGridIndex(gridDir);
  const sources = new Map();
  for (const [appid, file] of discoverCacheHeroes(steamRoot)) {
    sources.set(appid, { file, kind: "cache-hero" });
  }
  for (const [appid, file] of index.heroes) {
    if (!sources.has(appid)) sources.set(appid, { file, kind: "custom-hero" });
  }
  return sources;
}

// Scan a user-provided folder of wide backgrounds. A file is matched to a game in
// three steps, most reliable first:
//
//   1. the companion downloader's positional "[NAME] [APPID] [RANK] [WxH]" format,
//      whose appid field is exact;
//   2. for any other filename, the longest maximal digit group that is a known
//      appid (so "portal2-1222140" matches 1222140, not the stray "2");
//   3. the title, for a file whose appid names nothing here — which is the normal
//      case for a non-Steam shortcut, whose local appid only Steam knows.
//
// Returns one chosen cover per appid, plus
// enough accounting to explain every file that did NOT become a cover: images
// matching no game, images passed over because another file won that appid, and
// non-image files that were never candidates.
//
// pick decides which file wins an appid that several images claim. "first" keeps
// the alphabetically first name, which is stable across runs — with the companion
// heroes script's "[NAME] [APPID] [RANK] [WxH]" naming that is rank 1, the best
// art. "random" draws one of them per run instead, so running again rotates the
// art. The draw happens per account, so two accounts on one machine can land on
// different images for the same game — each account has its own grid folder.
function discoverFolderCovers(coversDir, known, pick = "first", names = null) {
  const candidates = new Map(); // appid -> [name, ...], name-sorted
  const unmatched = [];
  const matchedByTitle = new Map(); // appid -> the title that found it
  const titles = titleIndex(names);
  let scanned = 0;
  let nonImages = 0;
  for (const entry of readdirOrThrow(coversDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    if (!isImage(entry.name)) { nonImages++; continue; }
    scanned++;
    const base = path.basename(entry.name, path.extname(entry.name));
    const tail = base.match(OUTPUT_TAIL_RE);
    let appid = null;
    if (tail) {
      // The companion downloader's format is positional — "[NAME] [APPID] [RANK]
      // [WIDTHxHEIGHT]" — so the appid is a known field, not something to guess
      // at. Reading it from that position is also the only way to avoid picking
      // digits out of the resolution: "205790 205790 1 1920x620.png" contains a
      // "620", and 620 is Portal 2. Scavenging the other numbers when this appid
      // is unknown is exactly how that file ends up as Portal 2's cover, so an
      // unknown appid here falls through to the title instead.
      if (known.has(tail[1])) appid = tail[1];
    } else {
      const groups = (base.match(/\d+/g) || []).filter((g) => known.has(g));
      if (groups.length > 0) {
        groups.sort((a, b) => b.length - a.length); // prefer the longest known appid
        appid = groups[0];
      }
    }
    if (!appid) {
      // No number in the name is an appid this machine knows. For a non-Steam
      // shortcut that is the expected case, not a failure: the downloader names
      // files with the game's real Steam appid, while Steam files the shortcut's
      // art under the id it invented locally. The title is the only thing the two
      // have in common, so it is what gets matched — exactly, and only when it
      // names a single game.
      const found = titles.get(coverTitle(entry.name));
      if (found) {
        appid = found;
        matchedByTitle.set(appid, coverTitle(entry.name));
      }
    }
    if (!appid) { unmatched.push(entry.name); continue; }
    if (!candidates.has(appid)) candidates.set(appid, []);
    candidates.get(appid).push(entry.name);
  }

  const covers = new Map();  // appid -> { file, name }
  const passedOver = [];     // { name, appid, kept } — another file won this appid
  for (const [appid, names] of candidates) {
    const chosen = pick === "random" ? names[Math.floor(Math.random() * names.length)] : names[0];
    covers.set(appid, { file: path.join(coversDir, chosen), name: chosen });
    for (const name of names) {
      if (name !== chosen) passedOver.push({ name, appid, kept: chosen });
    }
  }
  return { covers, unmatched, passedOver, scanned, nonImages, matchedByTitle };
}

// Case, punctuation and spacing dropped, so "Resonance: A Plague Tale Legacy"
// and the sanitized "Resonance A Plague Tale Legacy" in a filename compare equal.
const normalizeTitle = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// The companion downloader writes "[NAME] [APPID] [RANK] [WIDTHxHEIGHT].[EXT]".
// Stripping that fixed tail leaves the title; anything else falls back to the
// whole stem, so a hand-named file still has something to match on.
const OUTPUT_TAIL_RE = / (\d+) ([1-9]\d*) (\d+x\d+|unknown)$/;

function coverTitle(fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  const stripped = base.replace(OUTPUT_TAIL_RE, "");
  return normalizeTitle(stripped || base);
}

// normalized title -> appid, for titles that name exactly one game. A title two
// games share is left out rather than guessed at.
function titleIndex(names) {
  const seen = new Map();
  for (const [appid, name] of names || []) {
    const key = normalizeTitle(name);
    if (!key) continue;
    const hit = seen.get(key);
    if (hit === undefined) seen.set(key, appid);
    else if (hit !== appid) seen.set(key, null); // ambiguous
  }
  return seen;
}

// Every digit group appearing in a covers folder's filenames — used to widen the
// set of appids we look names up for before we know which ones are real.
function coversFolderAppidCandidates(coversDir) {
  const out = new Set();
  for (const entry of readdirOrThrow(coversDir, { withFileTypes: true })) {
    if (!entry.isFile() || !isImage(entry.name)) continue;
    for (const g of path.basename(entry.name, path.extname(entry.name)).match(/\d+/g) || []) out.add(g);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Non-Steam shortcuts
// ---------------------------------------------------------------------------

// Games the user added to Steam by hand. They live in a small binary VDF:
//
//   0x01 <key>\0 <value>\0  string
//   0x02 <key>\0 <4 bytes>  int32, little-endian
//
// Only appid and AppName matter, and both can be read positionally. The appid is
// stored signed but Steam names the shortcut\'s grid files with the UNSIGNED form
// (3506241571.png, 3506241571_hero.png), which is what has to come back here —
// it is the filename this script writes.
//
// These names are the only ones Steam has for a shortcut: it appears in no
// appmanifest and in no appinfo.vdf.
function readShortcuts(file) {
  const found = new Map();
  let buf;
  try { buf = fs.readFileSync(file); } catch { return found; }
  const APPID_KEY = Buffer.from("\x02appid\x00", "binary");
  const NAME_KEY = Buffer.from("\x01AppName\x00", "binary");
  let at = 0;
  while (at < buf.length) {
    const appidAt = buf.indexOf(APPID_KEY, at);
    if (appidAt === -1) break;
    const valueAt = appidAt + APPID_KEY.length;
    if (valueAt + 4 > buf.length) break;
    const appid = String(buf.readUInt32LE(valueAt));
    const nameAt = buf.indexOf(NAME_KEY, valueAt + 4);
    if (nameAt === -1) break;
    const from = nameAt + NAME_KEY.length;
    const end = buf.indexOf(0, from);
    const name = buf.toString("utf8", from, end === -1 ? buf.length : end).trim();
    if (name) found.set(appid, name);
    at = end === -1 ? buf.length : end + 1;
  }
  return found;
}

function discoverShortcuts(steamRoot, accounts) {
  const shortcuts = new Map();
  for (const accountId of accounts) {
    const file = path.join(steamRoot, "userdata", accountId, "config", "shortcuts.vdf");
    if (!isFile(file)) continue;
    for (const [appid, name] of readShortcuts(file)) shortcuts.set(appid, name);
  }
  return shortcuts;
}

// ---------------------------------------------------------------------------
// Game-name discovery (appid -> display name)
// ---------------------------------------------------------------------------

// VDF/ACF strings escape backslash and double-quote with a backslash.
function unescapeVdf(s) {
  return s.replace(/\\(["\\])/g, "$1");
}

// Find the steamapps directory inside a Steam library path (case variants).
function steamappsDir(libraryPath) {
  for (const variant of ["steamapps", "SteamApps"]) {
    const p = path.join(libraryPath, variant);
    if (isDir(p)) return p;
  }
  return null;
}

// Read every Steam library path from libraryfolders.vdf (new + old layouts),
// always including the primary Steam root itself.
function listLibraryPaths(steamRoot) {
  const paths = new Set([steamRoot]);
  const candidates = [
    path.join(steamRoot, "steamapps", "libraryfolders.vdf"),
    path.join(steamRoot, "config", "libraryfolders.vdf"),
  ];
  for (const vdf of candidates) {
    if (!isFile(vdf)) continue;
    let text;
    try { text = fs.readFileSync(vdf, "utf8"); } catch { continue; }
    const re = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(text)) !== null) paths.add(unescapeVdf(m[1]));
    break; // first existing file wins
  }
  return [...paths];
}

// Build appid -> display name by parsing appmanifest_<appid>.acf across every
// library. ACF is a simple VDF: we pull the first "name" value out of each file.
function discoverGameNames(steamRoot) {
  const names = new Map();
  for (const lib of listLibraryPaths(steamRoot)) {
    const dir = steamappsDir(lib);
    if (!dir) continue;
    for (const entry of readdirSafe(dir)) {
      const m = entry.match(/^appmanifest_(\d+)\.acf$/i);
      if (!m || names.has(m[1])) continue;
      let text;
      try { text = fs.readFileSync(path.join(dir, entry), "utf8"); } catch { continue; }
      const nm = text.match(/"name"\s+"((?:[^"\\]|\\.)*)"/i);
      if (nm) names.set(m[1], unescapeVdf(nm[1]));
    }
  }
  return names;
}

// Parse Steam's binary appcache/appinfo.vdf into appid -> display name for the given
// appids. Unlike appmanifest_*.acf (installed games only), appinfo.vdf covers the
// user's ENTIRE owned library, so this fills in names for games that aren't installed.
// Fully defensive: any problem returns whatever was gathered so far (possibly empty)
// so the rest of the tool keeps working.
//
// Format (little-endian) — see SteamDatabase/SteamAppInfo:
//   header: magic uint32 (0x07564427 v39 / 0x07564428 v40 / 0x07564429 v41),
//           universe uint32, + int64 string-table offset when magic == v41.
//   v41 keys are uint32 indices into a string table at that offset; older versions
//   inline null-terminated key strings.
//   each app entry: appid uint32 (0 = EOF), size uint32 (bytes of the rest of the
//   entry), fixed fields, then a binary KeyValues blob whose root key is "appinfo".
function discoverAppInfoNames(steamRoot, wantedAppids, onWarn) {
  const names = new Map();
  if (!wantedAppids || wantedAppids.size === 0) return names;
  const file = path.join(steamRoot, "appcache", "appinfo.vdf");
  if (!isFile(file)) return names;

  let buf;
  try { buf = fs.readFileSync(file); } catch { return names; }

  const cur = { p: 0 };
  const u32 = () => { const v = buf.readUInt32LE(cur.p); cur.p += 4; return v; };
  const readCString = () => {
    let end = buf.indexOf(0, cur.p);
    if (end < 0) end = buf.length;
    const s = buf.toString("utf8", cur.p, end);
    cur.p = end + 1;
    return s;
  };

  try {
    const magic = u32();
    if (magic !== 0x07564427 && magic !== 0x07564428 && magic !== 0x07564429) {
      onWarn?.(`appinfo.vdf: unrecognized format 0x${magic.toString(16)}; skipping name lookup.`);
      return names;
    }
    u32(); // universe

    // v41 (0x07564429): keys are indices into a string table stored elsewhere in the file.
    let strings = null;
    if (magic === 0x07564429) {
      const tableOffset = Number(buf.readBigInt64LE(cur.p)); cur.p += 8;
      const save = cur.p;
      cur.p = tableOffset;
      const count = u32();
      strings = new Array(count);
      for (let i = 0; i < count; i++) strings[i] = readCString();
      cur.p = save;
    }
    const hasStringTable = strings !== null;
    const fixedHeader = magic >= 0x07564428 ? 60 : 40; // bytes between `size` and the KV blob
    const readKey = hasStringTable ? () => strings[u32()] : readCString;

    // Read the body of a binary KeyValues object: [type, key, value]* until the 0x08 marker.
    const parseObject = () => {
      const obj = {};
      for (;;) {
        const type = buf[cur.p++];
        if (type === 0x08) break;            // end of object
        const key = readKey();
        switch (type) {
          case 0x00: obj[key] = parseObject(); break;            // nested object
          case 0x01: obj[key] = readCString(); break;            // string
          case 0x02: case 0x03: case 0x04: case 0x06: cur.p += 4; break; // int32/float/color/ptr
          case 0x07: case 0x0a: cur.p += 8; break;               // uint64 / int64
          default: throw new Error(`unknown KV type 0x${type.toString(16)}`);
        }
      }
      return obj;
    };

    while (cur.p + 8 <= buf.length) {
      const appid = u32();
      if (appid === 0) break;                // EOF marker
      const size = u32();
      const nextEntry = cur.p + size;
      if (nextEntry < cur.p || nextEntry > buf.length) break; // corrupt
      const id = String(appid);

      if (wantedAppids.has(id)) {
        try {
          cur.p += fixedHeader;
          if (buf[cur.p++] === 0x00) {        // root node is the "appinfo" object
            readKey();                        // consume root key ("appinfo")
            const info = parseObject();
            const name = info && info.common && info.common.name;
            if (typeof name === "string" && name) names.set(id, name);
          }
        } catch { /* skip this app, keep going */ }
      }

      cur.p = nextEntry;                      // resync regardless of parse outcome
    }
  } catch { /* return whatever we collected */ }

  return names;
}

// Resolve display names for the appids we are about to touch. Installed-game names
// win; appinfo.vdf fills the gaps for games that aren't installed.
function resolveNames(steamRoot, wantedAppids, onWarn) {
  const names = discoverGameNames(steamRoot);
  for (const [id, nm] of discoverAppInfoNames(steamRoot, wantedAppids, onWarn)) {
    if (!names.has(id)) names.set(id, nm);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function timestamp(d = new Date()) {
  // Avoid Date formatting locale issues; produce YYYYMMDD-HHMMSS.
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const sameFile = (a, b) => path.resolve(a) === path.resolve(b);

// Decide what happens to one destination slot (the wide cover, or the background)
// for a single game, given the files already sitting in that slot.
function planTarget(srcFile, srcExt, dest, existing, opts) {
  let action;
  if (!STEAM_READABLE_EXTS.has(srcExt)) {
    // Steam would ignore the file, so writing it only litters the grid folder.
    action = "skip-format";
  } else if (existing.some((f) => sameFile(f, srcFile))) {
    // The source is already in this slot (e.g. a covers folder pointing at grid/).
    action = "skip-same";
  } else if (existing.length === 0) {
    action = "write";
  } else if (opts.skipExisting) {
    action = "skip-existing";
  } else {
    action = "overwrite";
  }
  return { dest, existing, action };
}

function planAccount(steamRoot, accountId, opts, names) {
  const gridDir = gridDirFor(steamRoot, accountId);
  const gridIndex = readGridIndex(gridDir);
  const sources = discoverBackgrounds(steamRoot, gridDir, gridIndex);

  // A folder of wide backgrounds (if given) is the highest-priority source: a match
  // there overrides any hero art, and can introduce a wide cover for a library game
  // that has no hero at all (the known set spans heroes + installed games).
  let unmatchedCovers = [];
  let coversStats = null;
  if (opts.coversDir) {
    const known = new Set([...sources.keys(), ...(names ? names.keys() : [])]);
    const { covers, unmatched, passedOver, scanned, nonImages, matchedByTitle } =
      discoverFolderCovers(opts.coversDir, known, opts.pick, names);
    for (const [appid, c] of covers) {
      sources.set(appid, { file: c.file, kind: "folder-cover" });
    }
    unmatchedCovers = unmatched;
    coversStats = {
      scanned, nonImages, passedOver, pick: opts.pick, matched: covers.size, matchedByTitle,
    };
  }

  let appids = [...sources.keys()].sort((a, b) => Number(a) - Number(b));
  // coversOnly narrows the run to the folder's own matches: every other game keeps whatever
  // art it has rather than picking up its Steam hero as a wide cover. run() has already
  // rejected the flag without a folder, so this can't quietly plan nothing.
  if (opts.coversOnly) {
    appids = appids.filter((id) => sources.get(id).kind === "folder-cover");
  }
  if (opts.game) {
    const wanted = String(opts.game).trim();
    appids = appids.filter((id) => id === wanted);
  }

  const items = [];
  for (const appid of appids) {
    const src = sources.get(appid);
    const srcExt = path.extname(src.file).toLowerCase();
    const cover = planTarget(src.file, srcExt, path.join(gridDir, `${appid}${srcExt}`), gridIndex.covers.get(appid) || [], opts);

    // An image from the covers folder is a wide background, so it replaces the
    // game's background (hero) as well as its wide cover. A hero taken from Steam's
    // own art already IS the background — writing it back would be a no-op.
    const hero = src.kind === "folder-cover"
      ? planTarget(src.file, srcExt, path.join(gridDir, `${appid}_hero${srcExt}`), gridIndex.heroFiles.get(appid) || [], opts)
      : null;

    items.push({
      appid,
      name: (names && names.get(appid)) || null,
      src,
      dest: cover.dest,
      existing: cover.existing,
      action: cover.action,
      hero,
    });
  }

  return { accountId, gridDir, items, unmatchedCovers, coversStats, coversOnly: !!opts.coversOnly };
}

const ACTIONS = ["write", "overwrite", "skip-existing", "skip-same", "skip-format"];

function countActions(items) {
  const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
  for (const it of items) counts[it.action]++;
  return counts;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

// Copy a file without leaving a half-written destination behind: write to a temp
// name in the same directory, then rename into place.
function copyAtomic(src, dest) {
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

const willWrite = (target) => !!target && (target.action === "write" || target.action === "overwrite");

// How a source reads in a log line: a covers-folder image is shown as
// "covers/<file>" so an applied run states plainly which folder it came from.
function sourceLabel(src) {
  const base = path.basename(src.file);
  return src.kind === "folder-cover" ? `covers/${base}` : `${src.kind}/${base}`;
}

function executeAccount(plan, opts, hooks = {}) {
  const { onProgress, onLog } = hooks;
  const result = { written: 0, heroWritten: 0, skipped: 0, backedUp: 0, backupDir: null, errors: [] };
  if (!opts.apply) return result;

  const backupDir = path.join(plan.gridDir, `${BACKUP_PREFIX}${timestamp()}`);
  const total = plan.items.length;
  let done = 0;

  // Fill one destination slot. Anything that fails is reported and skipped; one
  // unreadable file must not abort the whole run, and a failed write must not lose
  // the old art. Each slot is backed up and rolled back on its own, so a failed
  // background write can't disturb a wide cover that already landed.
  const writeTarget = (item, target) => {
    const moved = [];
    try {
      fs.mkdirSync(plan.gridDir, { recursive: true });

      // Back up the existing variants in this slot, then remove them so Steam
      // doesn't end up with two files for the same appid.
      if (target.existing.length > 0) {
        fs.mkdirSync(backupDir, { recursive: true });
        for (const f of target.existing) {
          const to = path.join(backupDir, path.basename(f));
          fs.renameSync(f, to);
          moved.push([f, to]);
          onLog?.(`    backed up  appid ${item.appid.padEnd(8)} ${path.basename(f)} -> ${path.basename(backupDir)}/`, "item");
        }
      }

      copyAtomic(item.src.file, target.dest);
      result.backedUp += moved.length;
      onLog?.(`    wrote      appid ${item.appid.padEnd(8)} ${sourceLabel(item.src)} -> ${path.basename(target.dest)}`, "item");
      return true;
    } catch (err) {
      for (const [from, to] of moved.reverse()) {
        try { fs.renameSync(to, from); } catch { /* leave it in the backup folder */ }
      }
      result.errors.push({ appid: item.appid, message: err.message });
      onLog?.(`  FAILED  appid ${item.appid}: ${err.message}`, "error");
      return false;
    }
  };

  if (plan.items.some((it) => willWrite(it) || willWrite(it.hero))) {
    onLog?.("  applying:", "info");
  }

  for (const item of plan.items) {
    done++;
    // The item carries the wide-cover slot inline (dest/existing/action); item.hero
    // is the background slot, present only for covers-folder matches.
    if (!willWrite(item) && !willWrite(item.hero)) {
      result.skipped++;
      onProgress?.({ done, total, appid: item.appid });
      continue;
    }

    if (willWrite(item) && writeTarget(item, item)) result.written++;
    if (willWrite(item.hero) && writeTarget(item, item.hero)) result.heroWritten++;

    onProgress?.({ done, total, appid: item.appid });
  }

  if (result.backedUp > 0) result.backupDir = backupDir;
  // An empty backup folder would confuse the restore list.
  else { try { fs.rmdirSync(backupDir); } catch { /* never created, or not empty */ } }

  return result;
}

// ---------------------------------------------------------------------------
// Backups & restore
// ---------------------------------------------------------------------------

// Every _widecover_backup_* folder for an account, newest first.
function listBackups(steamRoot, accountId) {
  const gridDir = gridDirFor(steamRoot, accountId);
  const out = [];
  for (const entry of readdirSafe(gridDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(BACKUP_PREFIX)) continue;
    const dir = path.join(gridDir, entry.name);
    const files = readdirSafe(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && isImage(e.name))
      .map((e) => e.name);
    out.push({
      name: entry.name,
      dir,
      fileCount: files.length,
      createdAt: entry.name.slice(BACKUP_PREFIX.length),
    });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

// Move a backup's files back into the grid folder, removing the art we wrote into
// those slots first (the replacement may use a different extension).
function restoreBackup(steamRoot, accountId, backupName, opts = {}) {
  if (!backupName || !backupName.startsWith(BACKUP_PREFIX) || backupName.includes("/") || backupName.includes("\\")) {
    throw new UserError(`Not a wide-cover backup folder name: ${backupName}`);
  }
  const gridDir = gridDirFor(steamRoot, accountId);
  const backupDir = path.join(gridDir, backupName);
  if (!isDir(backupDir)) throw new UserError(`Backup folder not found: ${backupDir}`);

  const files = readdirSafe(backupDir, { withFileTypes: true })
    .filter((e) => e.isFile() && isImage(e.name))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) throw new UserError(`Backup folder has no images: ${backupDir}`);

  const gridIndex = readGridIndex(gridDir);
  const result = { restored: 0, removed: 0, errors: [], items: [] };

  for (const name of files) {
    // A backup holds both slots: <appid>.<ext> is a wide cover, <appid>_hero.<ext>
    // a background. Each has to displace whatever now sits in that same slot.
    const base = path.basename(name, path.extname(name));
    const heroMatch = base.match(/^(\d+)_hero$/i);
    const appid = heroMatch ? heroMatch[1] : base;
    const slot = heroMatch ? gridIndex.heroFiles : gridIndex.covers;
    const current = (slot.get(appid) || []).filter((f) => !sameFile(f, path.join(backupDir, name)));
    result.items.push({ appid, file: name, replaces: current.map((f) => path.basename(f)) });
    if (!opts.apply) continue;
    try {
      for (const f of current) {
        fs.rmSync(f, { force: true });
        result.removed++;
      }
      fs.renameSync(path.join(backupDir, name), path.join(gridDir, name));
      result.restored++;
    } catch (err) {
      result.errors.push(`appid ${appid}: ${err.message}`);
    }
  }

  if (opts.apply && result.errors.length === 0) {
    try { fs.rmdirSync(backupDir); } catch { /* not empty — keep it */ }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const ACTION_LABEL = {
  write: "write",
  overwrite: "overwrite",
  "skip-existing": "skip-existing",
  "skip-same": "skip-same",
  "skip-format": "skip-format",
};

// Long file lists are printed one per line and capped — enough to diagnose a
// covers folder that isn't matching, without burying the plan in a huge library.
const NAME_LIST_CAP = 15;

function nameListLines(heading, names, level) {
  if (names.length === 0) return [];
  const out = [[`    ${heading}`, level]];
  for (const name of names.slice(0, NAME_LIST_CAP)) out.push([`      ${name}`, level]);
  if (names.length > NAME_LIST_CAP) {
    out.push([`      … and ${names.length - NAME_LIST_CAP} more`, level]);
  }
  return out;
}

function formatPlanLines(plan) {
  const lines = [];

  // Account for the covers folder first: it explains where the sources below came
  // from, and makes "matched nothing" loud instead of silent.
  const cs = plan.coversStats;
  if (cs) {
    lines.push([
      `  covers folder: ${cs.scanned} image(s) scanned, ${cs.matched} matched a game, ${plan.unmatchedCovers.length} matched nothing`,
      cs.matched > 0 ? "info" : "warn",
    ]);
    if (cs.nonImages > 0) {
      lines.push([`    ${cs.nonImages} non-image file(s) ignored`, "info"]);
    }
    // Worth calling out: these went to an appid that appears nowhere in the
    // filename, so the mapping is not obvious from the name alone.
    if (cs.matchedByTitle && cs.matchedByTitle.size > 0) {
      lines.push([`    ${cs.matchedByTitle.size} matched by title, not by appid:`, "info"]);
      for (const [appid, title] of cs.matchedByTitle) {
        lines.push([`      ${appid}  ${title}`, "item"]);
      }
    }
    lines.push(...nameListLines("matched no game in your library:", plan.unmatchedCovers, "warn"));
    // Which file won an appid is a choice the user made with the pick field, so say
    // which rule was applied — otherwise a random run reads like a mysterious one.
    lines.push(...nameListLines(
      cs.pick === "random"
        ? `${cs.passedOver.length} image(s) not drawn for their appid this run (pick: random):`
        : `${cs.passedOver.length} image(s) lost to an earlier file for the same appid (pick: first):`,
      cs.passedOver.map((d) => `${d.name} — appid ${d.appid} went to ${d.kept}`),
      "warn",
    ));
  }

  if (plan.items.length === 0) {
    lines.push([
      plan.coversOnly
        ? "  No image in the covers folder matched a game in this account, so there is nothing to do."
        : "  No games with a background (hero) image found.",
      "warn",
    ]);
  } else {
    for (const it of plan.items) {
      const tag = ACTION_LABEL[it.action].padEnd(13);
      const rawName = it.name || "(unknown)";
      const name = (rawName.length > 30 ? rawName.slice(0, 29) + "…" : rawName).padEnd(30);
      // For a folder cover, show the matched image filename; src.file points into the
      // covers folder, so its basename is exactly the image the user dropped in.
      const srcLabel = it.src.kind === "folder-cover"
        ? `folder: ${path.basename(it.src.file)}`
        : it.src.kind.padEnd(11);
      // A covers-folder image lands in two slots, so show the background too —
      // with its own tag when it isn't doing the same thing as the wide cover.
      const heroLabel = it.hero
        ? ` + ${path.basename(it.hero.dest)}${it.hero.action === it.action ? "" : ` (${ACTION_LABEL[it.hero.action]})`}`
        : "";
      lines.push([`  ${tag} appid ${it.appid.padEnd(8)} ${name} ${srcLabel} -> ${path.basename(it.dest)}${heroLabel}`, "item"]);
    }
    const c = countActions(plan.items);
    const skipped = c["skip-existing"] + c["skip-same"] + c["skip-format"];
    lines.push([
      `  -> ${plan.items.length} game(s): ${c.write} new, ${c.overwrite} overwrite, ${skipped} skipped`,
      "info",
    ]);
    const heroWrites = plan.items.filter((it) => willWrite(it.hero)).length;
    if (heroWrites > 0) {
      lines.push([`  -> ${heroWrites} background(s) also written from the covers folder`, "info"]);
    }
    // Where each planned game's image is coming from — the direct answer to
    // "is it actually using my covers folder, or falling back to Steam's art?".
    const bySource = new Map();
    for (const it of plan.items) bySource.set(it.src.kind, (bySource.get(it.src.kind) || 0) + 1);
    lines.push([
      `  -> sources: ${[...bySource].map(([kind, n]) => `${n} ${kind}`).join(", ")}`,
      "info",
    ]);
    if (c["skip-format"] > 0) {
      lines.push([`  (${c["skip-format"]} background(s) skipped: Steam only reads .png/.jpg wide covers)`, "warn"]);
    }
  }
  return lines;
}

// Run the whole operation. `onLog(message, level)` receives every human-readable
// line as it happens; the return value carries the structured plan for a UI.
//
// opts: { apply, steam, account, allAccounts, game, skipExisting, coversDir, coversOnly }
function run(opts, hooks = {}) {
  const { onLog = () => {}, onProgress } = hooks;
  const log = (m, level = "info") => onLog(m, level);

  // Caught before anything is scanned: coversOnly with no folder would plan zero games and
  // read as "nothing matched" rather than as the misconfiguration it is.
  if (opts.coversOnly && !opts.coversDir) {
    throw new UserError(
      "coversOnly is on but no covers folder was given.\n" +
      "Set coversDir to the folder of wide background images, or turn coversOnly off."
    );
  }

  const steamRoot = findSteamRoot(opts.steam);
  if (!steamRoot) {
    throw new UserError(
      "Could not find a Steam installation in any of the usual locations:\n" +
      candidateSteamRoots().map((c) => `  - ${c}`).join("\n") +
      "\n\nIf Steam is installed elsewhere, set the steam field to that folder."
    );
  }
  log(`Steam found at: ${steamRoot}`);

  if (opts.coversDir) {
    // Log the resolved path: a relative coversDir is read from the app's working
    // directory, which is rarely what the field looks like it says.
    if (!isDir(opts.coversDir)) throw new UserError(`Covers path does not exist or is not a directory: ${opts.coversDir}`);
    log(`Wide-background folder: ${path.resolve(opts.coversDir)}`);
    // Read it once up front: an unreadable folder should stop the run here, with the reason,
    // rather than quietly contributing nothing to a plan built from Steam's art instead.
    const present = readdirOrThrow(opts.coversDir).filter((name) => isImage(name)).length;
    log(`  ${present} image(s) in that folder`, present > 0 ? "info" : "warn");
    if (opts.coversOnly) {
      log("  covers-only: only the games those images match are touched; the rest are left alone.");
    }
    log(opts.pick === "random"
      ? "  pick: random — a game with several images in that folder gets a different one each run."
      : "  pick: first — a game with several images in that folder always gets the first by name.");
  }

  const accounts = resolveAccounts(steamRoot, opts);
  log(`Accounts: ${accounts.join(", ")}`);
  log(opts.apply ? "Mode: APPLY (writing files)" : "Mode: dry-run (no changes)", opts.apply ? "warn" : "info");

  // Resolve names only for the appids we actually reference — hero-art appids across
  // all accounts plus any appid named in the covers folder — so the lookup stays fast
  // and so appinfo validates which covers-folder numbers are real appids.
  const wanted = new Set(discoverCacheHeroes(steamRoot).keys());
  for (const accountId of accounts) {
    for (const appid of readGridIndex(gridDirFor(steamRoot, accountId)).heroes.keys()) wanted.add(appid);
  }
  if (opts.coversDir) {
    for (const g of coversFolderAppidCandidates(opts.coversDir)) wanted.add(g);
  }
  const names = resolveNames(steamRoot, wanted, (m) => log(m, "warn"));
  // Non-Steam shortcuts last, and unconditionally: their name appears in no
  // appmanifest and no appinfo.vdf, so shortcuts.vdf is the only source there is.
  // Without these a covers file can never be matched to a shortcut by title.
  const shortcuts = discoverShortcuts(steamRoot, accounts);
  for (const [appid, name] of shortcuts) names.set(appid, name);
  if (shortcuts.size > 0) {
    log(`Non-Steam shortcuts: ${[...shortcuts.values()].join(", ")}`);
  }

  const plans = [];
  const totals = { written: 0, heroWritten: 0, skipped: 0, backedUp: 0 };
  const backupDirs = [];
  const errors = [];

  for (const accountId of accounts) {
    const plan = planAccount(steamRoot, accountId, opts, names);
    log(`\nAccount ${accountId}  (grid: ${path.relative(steamRoot, plan.gridDir) || plan.gridDir})`);
    for (const [line, level] of formatPlanLines(plan)) log(line, level);

    if (opts.game && plan.items.length === 0) {
      log(`  appid ${opts.game} has no background available (cached hero, custom hero, or covers-folder match).`, "warn");
    }

    const res = executeAccount(plan, opts, { onProgress, onLog });
    totals.written += res.written;
    totals.heroWritten += res.heroWritten;
    totals.skipped += res.skipped;
    totals.backedUp += res.backedUp;
    if (res.backupDir) backupDirs.push(res.backupDir);
    errors.push(...res.errors);
    plans.push({ ...plan, result: res });
  }

  if (opts.apply) {
    const alsoHeroes = totals.heroWritten ? ` and ${totals.heroWritten} background(s)` : "";
    log(`\nDone. Wrote ${totals.written} wide cover(s)${alsoHeroes}, skipped ${totals.skipped}, backed up ${totals.backedUp} existing file(s).`,
      errors.length ? "warn" : "success");
    if (errors.length) log(`${errors.length} item(s) failed and were left unchanged.`, "error");
    if (backupDirs.length) {
      log("Backups saved to:");
      for (const d of backupDirs) log(`  ${d}`);
    }
    log("Fully restart Steam to see the new wide covers.", "success");
  } else {
    log("\nDry-run complete. Set apply to true to perform these changes.", "info");
  }

  return { steamRoot, accounts, plans, totals, backupDirs, errors };
}

function requireSteamRoot(options) {
  const steamRoot = findSteamRoot(options.steam);
  if (!steamRoot) {
    throw new UserError("Could not find a Steam installation. Set the steam field to the install folder.");
  }
  return steamRoot;
}

function cmdListBackups(options) {
  const steamRoot = requireSteamRoot(options);
  const accounts = options.account || options.allAccounts
    ? resolveAccounts(steamRoot, options)
    : listAccounts(steamRoot);
  let found = 0;
  for (const accountId of accounts) {
    const backups = listBackups(steamRoot, accountId);
    console.log(`\nAccount ${accountId}: ${backups.length} backup(s)`);
    for (const b of backups) {
      console.log(`  ${b.name}  (${b.fileCount} file(s))`);
      found++;
    }
  }
  if (found === 0) console.log("\nNothing to restore.");
  else {
    console.log("\nRestore one by setting action to restore, restore to the backup name, and apply to true.");
  }
}

function cmdRestore(options) {
  if (!options.restore) {
    throw new UserError("Set the restore field to a backup folder name. Use action=list-backups to see what's available.");
  }
  const steamRoot = requireSteamRoot(options);
  const accounts = resolveAccounts(steamRoot, options);
  let total = 0;

  for (const accountId of accounts) {
    if (!listBackups(steamRoot, accountId).some((b) => b.name === options.restore)) continue;
    const res = restoreBackup(steamRoot, accountId, options.restore, { apply: options.apply });
    console.log(`\nAccount ${accountId}  restoring ${options.restore}`);
    for (const item of res.items) {
      const replaces = item.replaces.length ? ` (removes ${item.replaces.join(", ")})` : "";
      console.log(`  appid ${item.appid.padEnd(8)} ${item.file}${replaces}`);
    }
    total += res.items.length;
    for (const e of res.errors) console.error(`  FAILED  ${e}`);
    if (options.apply) console.log(`  -> restored ${res.restored} file(s), removed ${res.removed} replacement(s)`);
  }

  if (total === 0) {
    throw new UserError(`Backup "${options.restore}" was not found. Set action to list-backups to see what's available.`);
  }
  if (options.apply) console.log("\nFully restart Steam to see the restored covers.");
  else console.log("\nPreview only. Set apply to true to restore.");
}

function main() {
  if (action === "list-backups") return cmdListBackups(opts);
  if (action === "restore") return cmdRestore(opts);
  if (action !== "run") {
    throw new UserError(`Unknown action "${action}". Use run, list-backups, or restore.`);
  }

  const result = run(opts, {
    onLog: (message, level) => {
      if (level === "error") console.error(message);
      else console.log(message);
    },
  });
  if (result.errors.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  if (err instanceof UserError) {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}