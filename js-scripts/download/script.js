// Download hero (background) art from SteamGridDB for every game in your Steam
// library. Dry-run unless apply is true.
//
// outDir   REQUIRED. Where the images are written. Created if missing.
// apply    false = preview only. The API is still queried in a dry run — it is
//          the only way to show real filenames and resolutions.
// limit    How many heroes per game, best first (default 5).
//
// favoritesOnly
//          Download art only for games starred in the Steam library — the
//          built-in "Favorites" collection, read straight out of Steam's own
//          collection store, so the list matches what the library shows. Across
//          every account in play: a game starred in either one counts. Naming
//          appids in the game field bypasses this, as it bypasses every other
//          filter.
//
// apiKey   Leave as "env" to read STEAM_GRID_API_KEY from the environment, and
//          then from the file named by envFile (default .env, relative to the
//          working directory). Typing the key here instead works, but it is
//          stored in js-scripts.json, which is tracked in git.
//          Generate a key at https://www.steamgriddb.com/profile/preferences
//
// game     "all", or one appid, or a comma list. Named appids bypass the
//          library scan and the type filter entirely.
//
// Every game is looked up by appid first and, if SteamGridDB has never heard of
// that appid, by the name Steam holds for it. That second path is what covers
// non-Steam games: a shortcut you added yourself has a Steam-generated appid
// that exists nowhere on SteamGridDB, so the name is the only way in. Its art
// still files under that appid, which is the one Steam itself uses for the
// game's grid images, so the companion script applies it like any other.
//
// A name lookup only counts when it matches a SteamGridDB title exactly, once
// case, punctuation, accents, a leading "The", "&" against "and" and roman
// numerals against digits are folded away. Anything looser downloads the wrong
// game's art: searching "Baldurs Gate 3" turns up "Baldur\'s Gate 3 Toolkit" and
// plain "Baldur\'s Gate" above the game itself. A near-miss is reported with what
// SteamGridDB does have, so the name can be corrected in Steam.
// steam / account   "auto", or an explicit Steam folder / account id.
// styles   "any", or a comma list: alternate, blurred, material, white_logo.
// types    static, animated, or any.
// nsfw / humor      true, false, or any (these are tri-state, not booleans).
//
// Files are named:  [GAME NAME] [APPID] [RANK] [WIDTHxHEIGHT].[EXT]
// e.g. "Portal 2 620 1 3840x1240.png"
//
// The field order is deliberate. The companion "Steam BG to Wide Cover" script
// can consume this folder as its coversDir: it finds the appid by taking the
// longest run of digits in the filename, and a tie is won by the leftmost one.
// Keeping the appid ahead of the resolution is what makes 3-digit appids such
// as 620 or 440 still resolve correctly. Do not reorder the fields.
// That script will also report ranks 2..N as duplicates for the same appid and
// use rank 1 — correct, but noisy on a large folder.
//

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

function isTrue(value) {
  const v = String(value).trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function unset(value) {
  const v = String(value).trim();
  return v === "" ? null : v;
}

// Optional fields need a non-empty default or the app refuses to arm a cron for
// this script (every param must resolve non-empty). So they carry a sentinel
// word instead of "", and the sentinel means the same thing as blank.
function opt(value, sentinel) {
  const v = String(value).trim();
  return v === "" || v.toLowerCase() === sentinel ? null : v;
}

// A whole-number field with a fallback and hard bounds, so a typo cannot turn
// into 200 concurrent sockets or a zero-length download list.
function num(value, fallback, min, max) {
  const n = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// nsfw and humor are tri-state on the API side: true, false or any. Coercing
// them with isTrue would silently turn "any" into "false" and filter out art
// the user asked to see.
function triState(value, fallback) {
  const v = String(value).trim().toLowerCase();
  return v === "true" || v === "false" || v === "any" ? v : fallback;
}

function csv(value) {
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// The :kind after a name picks the control the Scripts tab renders for the
// field — a toggle, a dropdown, a checklist, a folder picker. Every one of them
// still hands this script a plain string, so the parsing below is unchanged.
const opts = {
  outDir: unset({{outDir:dir}}),
  apply: isTrue({{apply:bool=false}}),
  limit: num({{limit=5}}, 5, 1, 50),
  apiKey: opt({{apiKey=env}}, "env"),
  envFile: String({{envFile=.env}}).trim() || ".env",
  steam: opt({{steam:dir=auto}}, "auto"),
  account: opt({{account=auto}}, "auto"),
  allAccounts: isTrue({{allAccounts:bool=false}}),
  game: opt({{game=all}}, "all"),
  skipExisting: isTrue({{skipExisting:bool=true}}),
  // A checklist, so an empty selection is "no style filter" — what "any" meant.
  styles: unset({{styles:many(alternate|blurred|material|white_logo)}}),
  types: opt({{types:one(static|animated|any)=static}}, "any"),
  nsfw: triState({{nsfw:one(false|true|any)=false}}, "false"),
  humor: triState({{humor:one(any|true|false)=any}}, "any"),
  includeNonGames: isTrue({{includeNonGames:bool=false}}),
  favoritesOnly: isTrue({{favoritesOnly:bool=false}}),
  concurrency: num({{concurrency=4}}, 4, 1, 8),
  maxMB: num({{maxMB=25}}, 25, 1, 500),
};

class UserError extends Error {}

const API_BASE = "https://www.steamgriddb.com/api/v2";
const KEY_URL = "https://www.steamgriddb.com/profile/preferences";
const API_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;

// Extensions we are willing to write. image/jpeg maps to .jpg rather than
// .jpeg to match what the companion script will read back out of this folder.
const EXT_BY_MIME = {
  "image/png": ".png",
  "image/apng": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const ALLOWED_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

// Partial downloads live under this prefix until they are complete, so a killed
// run can never leave a truncated file that looks finished to skipExisting.
const TEMP_PREFIX = ".sgdb-part-";

// How many SteamGridDB titles to list when a name lookup finds no exact match.
// Enough to spot the spelling that would have worked.
const NEAR_MISS_CAP = 5;

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readdirSafe(dir, options) {
  try { return fs.readdirSync(dir, options); } catch { return []; }
}

// Steam's own folders are scanned best-effort: a missing librarycache is normal, so
// readdirSafe turning that into an empty list is right. The output folder is different —
// the user explicitly pointed at it, so failing to read it has to be reported rather than
// silently becoming "nothing downloaded yet". This matters most on macOS, where an app
// without Files-and-Folders access gets EPERM listing ~/Desktop, ~/Documents or
// ~/Downloads while statSync still succeeds: the folder looks present and scans empty.
function readdirOrThrow(dir, options) {
  try {
    return fs.readdirSync(dir, options);
  } catch (err) {
    const denied = err.code === "EPERM" || err.code === "EACCES";
    throw new UserError(
      `Could not read the output folder: ${dir}\n  ${err.code || "error"}: ${err.message}` +
      (denied
        ? "\n\nmacOS is blocking this folder. Either grant the app access in System Settings →" +
          "\nPrivacy & Security → Files and Folders (or Full Disk Access), or point outDir at" +
          "\nan unprotected folder such as ~/steam-heroes."
        : "")
    );
  }
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

// A minimal KEY=value reader. No dotenv package is reachable from the temp file
// this script runs as, so the handful of lines we need are parsed here.
function readEnvFile(file) {
  const out = new Map();
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // Only strip quotes that are actually paired, so a key containing a quote
    // survives intact.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out.set(m[1], value);
  }
  return out;
}

// apiKey field -> environment -> env file. Resolving in that order means the
// common case needs nothing stored in js-scripts.json, which is tracked in git.
function resolveApiKey(options, onWarn) {
  if (options.apiKey) {
    onWarn?.("apiKey is set directly on this script, so it is stored in js-scripts.json (tracked in git). Clear it and use .env instead.");
    return options.apiKey;
  }
  const fromEnv = String(process.env.STEAM_GRID_API_KEY || "").trim();
  if (fromEnv) return fromEnv;

  const file = path.resolve(expandHome(options.envFile));
  const fromFile = String(readEnvFile(file).get("STEAM_GRID_API_KEY") || "").trim();
  if (fromFile) return fromFile;

  throw new UserError(
    "No SteamGridDB API key found. Any one of these works:\n" +
    `  - put STEAM_GRID_API_KEY=... in ${file}\n` +
    "  - export STEAM_GRID_API_KEY in the environment this app was launched from\n" +
    "  - type the key into the apiKey field (it is then stored in js-scripts.json)\n\n" +
    `Generate a key at ${KEY_URL}`
  );
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

function resolveAccounts(steamRoot, options) {
  const all = listAccounts(steamRoot);
  // Unlike the wide-cover script, nothing here is written into userdata — the
  // accounts are only a source of appids, so having none is survivable.
  if (all.length === 0) return [];

  if (options.account) {
    const wanted = String(options.account);
    if (!all.includes(wanted)) {
      throw new UserError(`Account ${wanted} not found. Available accounts: ${all.join(", ")}`);
    }
    return [wanted];
  }
  if (options.allAccounts) return all;
  if (all.length === 1) return all;

  throw new UserError(
    `Multiple Steam accounts found: ${all.join(", ")}.\n` +
    `Pick one in the account field, or set allAccounts to true.`
  );
}

// ---------------------------------------------------------------------------
// VDF scanning
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

// Walk a text VDF, reporting every key together with the path of the block it
// sits in. A plain regex is not good enough for localconfig.vdf: numeric keys
// that look exactly like appids also appear under friends, depots and
// WebStorage, and only the enclosing path tells them apart.
//
// onKey(parentPathLowercased, key, opensObject) is called for each key. A key
// followed by "{" opens an object; a key followed by a string is a leaf pair.
function scanVdf(text, onKey) {
  const stack = [];
  let i = 0;
  const n = text.length;
  let pendingKey = null;

  const readQuoted = () => {
    let out = "";
    i++; // opening quote
    while (i < n) {
      const c = text[i];
      if (c === "\\") { out += text[i] + (text[i + 1] ?? ""); i += 2; continue; }
      if (c === '"') { i++; return unescapeVdf(out); }
      out += c;
      i++;
    }
    return unescapeVdf(out);
  };

  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "{") {
      // The key that opened this block is already on the stack via pendingKey.
      stack.push(pendingKey ?? "");
      pendingKey = null;
      i++;
      continue;
    }
    if (c === "}") {
      stack.pop();
      pendingKey = null;
      i++;
      continue;
    }
    if (c === '"') {
      const token = readQuoted();
      if (pendingKey === null) {
        pendingKey = token;
        // Look ahead past whitespace and comments to classify this key.
        let j = i;
        while (j < n) {
          if (text[j] === "/" && text[j + 1] === "/") { while (j < n && text[j] !== "\n") j++; continue; }
          if (!/\s/.test(text[j])) break;
          j++;
        }
        const opensObject = text[j] === "{";
        onKey(stack.join("/").toLowerCase(), token, opensObject);
        if (!opensObject) {
          // Leaf pair: consume the value token too.
          i = j;
          if (text[i] === '"') readQuoted();
          pendingKey = null;
        }
      }
      continue;
    }
    i++;
  }
}

// The casing of the UserLocalConfigStore/Software/Valve/Steam segments has
// changed across Steam builds, so match on the tail of the path rather than
// the whole of it. A bare "apps" key is not enough — WebStorage has one too.
function vdfAppidsUnder(text, pathSuffix) {
  const ids = new Set();
  scanVdf(text, (parent, key) => {
    if (parent.endsWith(pathSuffix) && /^\d+$/.test(key)) ids.add(key);
  });
  return ids;
}

// ---------------------------------------------------------------------------
// Library enumeration (appid discovery)
// ---------------------------------------------------------------------------

// Games Steam has drawn in the library UI. On a machine where nothing is
// installed this is by far the largest source, so it carries most runs.
function discoverLibraryCacheAppids(steamRoot) {
  const ids = new Set();
  const dir = path.join(steamRoot, "appcache", "librarycache");
  for (const entry of readdirSafe(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\d+$/.test(entry.name)) {
      ids.add(entry.name);           // current layout: librarycache/<appid>/
    } else if (entry.isFile()) {
      const m = entry.name.match(/^(\d+)_/);  // old layout: librarycache/<appid>_hero.jpg
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}

// Installed games. Empty on a machine with no local installs, but it is the
// only source that still works when appcache has been wiped.
function discoverManifestAppids(steamRoot) {
  const ids = new Set();
  for (const lib of listLibraryPaths(steamRoot)) {
    const dir = steamappsDir(lib);
    if (!dir) continue;
    for (const entry of readdirSafe(dir)) {
      const m = entry.match(/^appmanifest_(\d+)\.acf$/i);
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}

// The per-library "apps" block, whose entries are leaf pairs of appid -> bytes.
function discoverLibraryFolderAppids(steamRoot) {
  const ids = new Set();
  for (const vdf of [
    path.join(steamRoot, "steamapps", "libraryfolders.vdf"),
    path.join(steamRoot, "config", "libraryfolders.vdf"),
  ]) {
    if (!isFile(vdf)) continue;
    let text;
    try { text = fs.readFileSync(vdf, "utf8"); } catch { continue; }
    for (const id of vdfAppidsUnder(text, "/apps")) ids.add(id);
    break;
  }
  return ids;
}

// Per-account play state. Catches owned games that were never opened in the
// library UI, so it fills gaps librarycache leaves.
function discoverLocalConfigAppids(steamRoot, accountId) {
  const file = path.join(steamRoot, "userdata", accountId, "config", "localconfig.vdf");
  if (!isFile(file)) return new Set();
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return new Set(); }
  return vdfAppidsUnder(text, "software/valve/steam/apps");
}

// Non-Steam games the user added to Steam themselves. They live in a small
// binary VDF, not the text kind the rest of this file parses:
//
//   0x00 <key>\0 ...        nested map
//   0x01 <key>\0 <value>\0  string
//   0x02 <key>\0 <4 bytes>  int32, little-endian
//   0x08                    end of map
//
// Only two fields matter, and both can be read positionally without a full
// parser: the appid Steam generated for the shortcut, and its AppName. The
// appid is stored signed but Steam names the shortcut\'s grid files with the
// UNSIGNED form (3506241571.png, 3506241571_hero.png), so that is what this
// returns — it has to match, or the art lands under a name Steam never reads.
function readShortcuts(file) {
  const found = new Map();
  let buf;
  try { buf = fs.readFileSync(file); } catch { return found; }

  // Each shortcut is one entry in the top-level map, so walking appid markers in
  // order and taking the AppName that follows each keeps the two paired.
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
    // A shortcut with a blank name is one Steam itself cannot label; there is
    // nothing to search SteamGridDB for.
    if (name) found.set(appid, name);
    at = end === -1 ? buf.length : end + 1;
  }
  return found;
}

// appid -> name for every non-Steam shortcut, across the accounts in play.
function discoverShortcuts(steamRoot, accounts) {
  const shortcuts = new Map();
  for (const accountId of accounts) {
    const file = path.join(steamRoot, "userdata", accountId, "config", "shortcuts.vdf");
    if (!isFile(file)) continue;
    for (const [appid, name] of readShortcuts(file)) shortcuts.set(appid, name);
  }
  return shortcuts;
}

// Union every source, remembering where each appid came from. "0 games found"
// is the likeliest support question, and the per-source counts answer it.
function discoverLibrary(steamRoot, accounts) {
  const shortcuts = discoverShortcuts(steamRoot, accounts);
  const sources = {
    librarycache: discoverLibraryCacheAppids(steamRoot),
    appmanifest: discoverManifestAppids(steamRoot),
    libraryfolders: discoverLibraryFolderAppids(steamRoot),
    localconfig: new Set(),
    shortcuts: new Set(shortcuts.keys()),
  };
  for (const accountId of accounts) {
    for (const id of discoverLocalConfigAppids(steamRoot, accountId)) sources.localconfig.add(id);
  }
  const all = new Set();
  for (const set of Object.values(sources)) for (const id of set) all.add(id);
  return {
    appids: all,
    shortcuts,
    counts: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.size])),
  };
}

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

// The star in the Steam library is a built-in collection with the id "favorite",
// and Steam keeps each account's collections in one of two places:
//
//   config/cloudstorage/cloud-storage-namespace-1.json
//       the current one. A JSON array of [key, record] pairs; the record for
//       "user-collections.favorite" carries the collection as a JSON *string*.
//   config/localconfig.vdf
//       older builds, under WebStorage/user-collections — the same JSON, this
//       time as one escaped VDF string, and holding every collection at once.
//
// Unwrapped, both are the same shape: { added: [appid...], removed: [appid...] }.
// The fallback only runs when cloudstorage had nothing to say: on a machine that
// has both, the localconfig copy is years stale and would resurrect games that
// were unstarred long ago.

function favoriteAppid(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  // A non-Steam shortcut's appid is stored signed here in some builds, while
  // Steam files that shortcut's art under the unsigned form — which is the form
  // the rest of this script matches on, so normalize before comparing.
  return String(n < 0 ? n >>> 0 : n);
}

// added first, then removed: Steam leaves an unstarred game in `added` and
// records it in `removed`, so only applying them in that order gives the list
// the library is actually showing.
function collectFavorites(collection, into) {
  if (!collection || typeof collection !== "object") return;
  for (const id of Array.isArray(collection.added) ? collection.added : []) {
    const appid = favoriteAppid(id);
    if (appid) into.add(appid);
  }
  for (const id of Array.isArray(collection.removed) ? collection.removed : []) {
    const appid = favoriteAppid(id);
    if (appid) into.delete(appid);
  }
}

// Returns whether a favorite collection was found at all — not whether it held
// anything — so an account with zero stars is not mistaken for one whose
// collections simply live in the older file.
function favoritesFromCloudStorage(configDir, into) {
  const file = path.join(configDir, "cloudstorage", "cloud-storage-namespace-1.json");
  if (!isFile(file)) return false;
  let entries;
  try { entries = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
  if (!Array.isArray(entries)) return false;
  let found = false;
  for (const entry of entries) {
    // [key, record] pairs today; a bare record is tolerated in case that flattens.
    const [key, record] = Array.isArray(entry) ? entry : [entry?.key, entry];
    if (key !== "user-collections.favorite") continue;
    if (!record || record.is_deleted || !record.value) continue;
    try { collectFavorites(JSON.parse(record.value), into); found = true; } catch { /* keep looking */ }
  }
  return found;
}

function favoritesFromLocalConfig(configDir, into) {
  const file = path.join(configDir, "localconfig.vdf");
  if (!isFile(file)) return;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  const m = text.match(/"user-collections"\s+"((?:[^"\\]|\\.)*)"/i);
  if (!m) return;
  let collections;
  try { collections = JSON.parse(unescapeVdf(m[1])); } catch { return; }
  collectFavorites(collections?.favorite, into);
}

// Every appid starred in one account's library.
function discoverAccountFavorites(steamRoot, accountId) {
  const configDir = path.join(steamRoot, "userdata", accountId, "config");
  const ids = new Set();
  if (!favoritesFromCloudStorage(configDir, ids)) favoritesFromLocalConfig(configDir, ids);
  return ids;
}

// The union across the accounts in play. Star lists are per account, so a game
// starred in either of two accounts on one machine counts as a favorite.
function discoverFavorites(steamRoot, accounts) {
  const ids = new Set();
  for (const accountId of accounts) {
    for (const id of discoverAccountFavorites(steamRoot, accountId)) ids.add(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Names and types (appid -> display name, app type)
// ---------------------------------------------------------------------------

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

// Parse Steam's binary appcache/appinfo.vdf into appid -> { name, type } for the given
// appids. Unlike appmanifest_*.acf (installed games only), appinfo.vdf covers the
// user's ENTIRE owned library, so this fills in names for games that aren't installed,
// and its common.type is the only way to tell a game from a tool, demo or DLC.
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
function discoverAppInfo(steamRoot, wantedAppids, onWarn) {
  const info = new Map();
  if (!wantedAppids || wantedAppids.size === 0) return info;
  const file = path.join(steamRoot, "appcache", "appinfo.vdf");
  if (!isFile(file)) return info;

  let buf;
  try { buf = fs.readFileSync(file); } catch { return info; }

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
      return info;
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
          case 0x02: obj[key] = buf.readInt32LE(cur.p); cur.p += 4; break; // int32
          case 0x03: case 0x04: case 0x06: cur.p += 4; break;    // float/colour/pointer
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
            const parsed = parseObject();
            const common = parsed && parsed.common;
            if (common) {
              const name = typeof common.name === "string" && common.name ? common.name : null;
              const type = typeof common.type === "string" && common.type ? common.type : null;
              // Some entries carry a type but no name; those still need to be
              // classified, so the guard is name OR type rather than name alone.
              if (name || type) info.set(id, { name, type });
            }
          }
        } catch { /* skip this app, keep going */ }
      }

      cur.p = nextEntry;                      // resync regardless of parse outcome
    }
  } catch { /* return whatever we collected */ }

  return info;
}

// Steam writes common.type inconsistently — "Game" for Half-Life 2 but "game"
// for Portal, Portal 2 and Team Fortress 2 — so this has to be case-folded.
function isGameType(type) {
  return String(type || "").toLowerCase() === "game";
}

// Merge the two name sources and attach a type. Installed-game names win;
// appinfo.vdf fills the gaps and is the only source of a type.
function resolveLibraryGames(steamRoot, appids, shortcuts, onWarn) {
  const manifestNames = discoverGameNames(steamRoot);
  const appInfo = discoverAppInfo(steamRoot, appids, onWarn);
  const out = new Map();
  for (const id of appids) {
    const entry = appInfo.get(id);
    // A shortcut exists in neither the manifests nor appinfo.vdf, so its own
    // name is the only one there is — and it is a game by construction: the user
    // added it to their library by hand. Saying so keeps it out of the type
    // filter, which would otherwise drop it as "unknown".
    const shortcutName = shortcuts?.get(id);
    out.set(id, {
      appid: id,
      name: shortcutName || manifestNames.get(id) || entry?.name || null,
      type: shortcutName ? "game" : entry?.type || null,
      // Marks an appid Steam invented for this machine. It is not the game's
      // identity and must not end up in a filename — see resolveShortcut.
      shortcut: Boolean(shortcutName),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

// Cut to a code-point budget first, then shrink until the UTF-8 encoding fits.
// Array.from is deliberate: String.prototype.slice would cut a surrogate pair
// in half and leave a lone half-character in the filename.
function truncateForFilename(s, maxChars, maxBytes) {
  let chars = Array.from(s);
  if (chars.length > maxChars) chars = chars.slice(0, maxChars);
  let out = chars.join("");
  while (Buffer.byteLength(out, "utf8") > maxBytes && chars.length > 0) {
    chars.pop();
    out = chars.join("");
  }
  return out;
}

// Game names really do contain the trademark sign, colons, quotes, question
// marks and trailing spaces — "STAR WARS Jedi: Fallen Order(tm) " is in this
// library. Illegal characters become a space rather than an underscore: the
// filename format is space-delimited, and a space keeps the appid a standalone
// token for anything that reads these names back.
function sanitizeName(raw) {
  let s = String(raw ?? "").normalize("NFC");
  s = s.replace(/[™®©]/g, "");            // trademark, registered, copyright
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[. ]+$/, "");                           // Windows strips these silently
  s = truncateForFilename(s, 80, 150);
  s = s.replace(/[. ]+$/, "");                           // truncating can expose one again
  return s || "Unknown";
}

// [GAME NAME] [APPID] [RANK] [WIDTHxHEIGHT].[EXT]
// The stem always ends in digits, so it can never collide with a Windows
// reserved device name (CON, NUL, COM1...) and no check for those is needed.
function heroFileName(name, appid, rank, width, height, ext) {
  const size = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? `${width}x${height}`
    : "unknown";
  return `${sanitizeName(name)} ${appid} ${rank} ${size}${ext}`;
}

// Matches our own output positionally, anchored at the end. That is stricter
// and safer than guessing which run of digits in a filename is the appid.
const OUTPUT_RE = / (\d+) ([1-9]\d*) (\d+x\d+|unknown)\.[A-Za-z0-9]+$/;

// Index the output folder once. Doing this per game would be quadratic on a
// folder that grows to several hundred files.
function readOutDirIndex(outDir) {
  const byAppid = new Map();
  const names = new Set();
  if (!isDir(outDir)) return { byAppid, names };
  for (const entry of readdirOrThrow(outDir)) {
    if (entry.startsWith(TEMP_PREFIX)) continue;
    const m = entry.match(OUTPUT_RE);
    if (!m) continue;
    names.add(entry);
    const list = byAppid.get(m[1]);
    if (list) list.push(entry);
    else byAppid.set(m[1], [entry]);
  }
  return { byAppid, names };
}

// A previous run that was killed mid-download leaves temp files behind. They
// are never visible as results, but there is no reason to keep them.
function sweepStaleTemps(outDir, maxAgeMs = 3600_000) {
  if (!isDir(outDir)) return 0;
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of readdirSafe(outDir)) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(outDir, entry);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) { fs.rmSync(full, { force: true }); removed++; }
    } catch { /* gone already, or not ours to remove */ }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Every temp file currently being written, so a SIGTERM can clean up inside the
// five seconds it gets before SIGKILL.
const activeTemps = new Set();

// One shared pause, not one per worker. When the API says 429, three workers
// carrying on while the fourth backs off politely is what turns a rate limit
// into a ban.
const limiter = { pauseUntil: 0, rateLimited: 0, retried: 0, requests: 0 };

class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// Retry-After is either a whole number of seconds or an HTTP date; Number() on
// the date form gives NaN, so both have to be handled.
function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(String(header).trim());
  if (Number.isFinite(seconds)) return Math.min(120_000, Math.max(0, seconds * 1000));
  const when = Date.parse(String(header));
  if (Number.isFinite(when)) return Math.min(120_000, Math.max(0, when - Date.now()));
  return null;
}

async function respectPause() {
  const wait = limiter.pauseUntil - Date.now();
  if (wait > 0) await sleep(wait);
}

function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

function isRetriableError(err) {
  if (err instanceof HttpError) return isRetriableStatus(err.status);
  const code = err?.code || err?.cause?.code || "";
  return err?.name === "TimeoutError" || err?.name === "AbortError" ||
    ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(code);
}

// Retry 429s and transient network failures. A 404 is a signal, not a failure,
// and a 400 means the query itself is wrong for every game — neither is retried.
async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await respectPause();
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriableError(err) || attempt === MAX_RETRIES) throw err;
      limiter.retried++;
      let wait = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      if (err instanceof HttpError && err.status === 429) {
        limiter.rateLimited++;
        const after = parseRetryAfter(err.retryAfter);
        if (after !== null) wait = Math.max(wait, after);
        limiter.pauseUntil = Math.max(limiter.pauseUntil, Date.now() + wait);
      }
      await sleep(wait);
    }
  }
  throw lastErr;
}

// The API client. It is the only thing that knows the key — image downloads go
// through imageFetch, which cannot see it.
function makeApi(apiKey) {
  // envelope:true returns the whole response, which carries the page/total/limit
  // fields the hero pagination needs; everything else only wants data.
  return async function apiFetch(endpoint, query, { envelope = false } = {}) {
    const url = new URL(API_BASE + endpoint);
    if (query) {
      for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    }

    return withRetry(async () => {
      limiter.requests++;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      let payload = null;
      try { payload = await res.json(); } catch { /* non-JSON error page */ }
      if (!res.ok || payload?.success === false) {
        const detail = Array.isArray(payload?.errors) ? payload.errors.join(", ") : res.statusText;
        const err = new HttpError(res.status, detail || `HTTP ${res.status}`, payload);
        err.retryAfter = res.headers.get("retry-after");
        throw err;
      }
      return envelope ? payload : payload?.data ?? null;
    });
  };
}

// Image URLs live on a different origin (the SteamGridDB CDN). Sending the
// Authorization header there would hand the API key to a third party and make
// the CDN skip its cache, so this function never receives it.
function imageFetch(url) {
  return fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
}

// ---------------------------------------------------------------------------
// SteamGridDB queries
// ---------------------------------------------------------------------------

// Build the filter half of a heroes query. dimensions is deliberately NOT sent:
// it is a filter, not a sort, so it would not change the ordering or the number
// of requests, and it would silently drop every animated or odd-sized hero.
// "prefer the largest" is decided here, from the full list.
function heroQuery(options, page) {
  const query = {};
  if (options.styles) query.styles = csv(options.styles).join(",");
  if (options.types && options.types !== "any") query.types = csv(options.types).join(",");
  if (options.nsfw !== "false") query.nsfw = options.nsfw;
  if (options.humor !== "any") query.humor = options.humor;
  if (page > 0) query.page = String(page);
  return query;
}

function area(image) {
  const w = Number(image?.width);
  const h = Number(image?.height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w * h : -1;
}

// The rank ends up in the filename, so the sort has to be total: two runs over
// the same data must agree on which hero is number 1. Falling through to the
// image id guarantees that.
function rankHeroes(images, limit) {
  const seen = new Set();
  const unique = [];
  for (const image of images) {
    if (!image?.url || seen.has(image.url)) continue;
    seen.add(image.url);
    unique.push(image);
  }
  unique.sort((a, b) => {
    const areaDiff = area(b) - area(a);
    if (areaDiff !== 0) return areaDiff;
    const netA = (Number(a.upvotes) || 0) - (Number(a.downvotes) || 0);
    const netB = (Number(b.upvotes) || 0) - (Number(b.downvotes) || 0);
    if (netB !== netA) return netB - netA;
    const upDiff = (Number(b.upvotes) || 0) - (Number(a.upvotes) || 0);
    if (upDiff !== 0) return upDiff;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
  return unique.slice(0, limit);
}

// The largest hero SteamGridDB hosts. Once a page contains one, no later page
// can beat it, so there is nothing left to look for.
const BIGGEST_KNOWN_HERO = 3840 * 1240;
const MAX_PAGES = 4;

// One request is almost always enough: heroes come back newest-first and a
// full-size one is usually on the first page. Later pages are only fetched
// while the response says more exist AND nothing seen so far is already full
// size — otherwise a popular game costs four requests for no better result.
async function fetchHeroes(apiFetch, endpoint, options) {
  const images = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await apiFetch(endpoint, heroQuery(options, page), { envelope: true });
    const batch = Array.isArray(body?.data) ? body.data : [];
    images.push(...batch);
    const seen = (Number(body?.page) || page) * (Number(body?.limit) || batch.length) + batch.length;
    const total = Number(body?.total);
    const moreExist = batch.length > 0 && Number.isFinite(total) && seen < total;
    if (!moreExist) break;
    if (images.some((image) => area(image) >= BIGGEST_KNOWN_HERO)) break;
  }
  return images;
}

// Steam and SteamGridDB disagree on more than punctuation, and each way they
// disagree is a game that silently downloads nothing: "Pokemon" against
// "Pokémon", "Ori & the Blind Forest" against "Ori and the Blind Forest",
// "The Witcher 3" against "Witcher 3", "Space Marine II" against "Space Marine 2",
// and a spelled-out "(tm)" where the other side carries the glyph. Accents are
// folded rather than dropped: deleting them leaves "pokmon", which matches
// nothing at all.
//
// Single-letter numerals are deliberately missing from ROMAN. Folding them would
// make "Mega Man X" and "Mega Man 10" the same title, and those are two games.
const ROMAN = new Map(Object.entries({
  ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9", xi: "11",
  xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16", xvii: "17", xviii: "18",
  xix: "19", xx: "20",
}));

const normalizeTitle = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")     // é -> e, rather than losing the letter
    .replace(/\((?:tm|r|c)\)/gi, " ")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "")
    .split(" ")
    .map((word) => ROMAN.get(word) || word)
    .join("");

// Taking data[0] from autocomplete without checking maps "Half-Life 2 RTX" onto
// "Half-Life 2" and downloads art for the wrong game. Only an exact title wins:
// the equivalences above are folded, nothing else is. Everything looser
// that was tried here picked something wrong — "Baldurs Gate 3" matches
// "Baldur\'s Gate 3 Toolkit" on containment and plain "Baldur\'s Gate" on length,
// and both download art for a different product than the one asked for.
function exactMatch(wanted, candidates) {
  const target = normalizeTitle(wanted);
  if (!target) return null;
  for (const candidate of candidates) {
    if (normalizeTitle(candidate?.name) === target) return candidate;
  }
  return null;
}

// The Steam appid SteamGridDB records for one of its games. The plain
// /games/id/ response does not carry it; ?platformdata=steam is what adds the
// external_platform_data block. Null when the game genuinely is not on Steam.
async function steamAppidFor(apiFetch, sgdbId) {
  const body = await apiFetch(`/games/id/${sgdbId}`, { platformdata: "steam" });
  const entries = body?.external_platform_data?.steam;
  const id = Array.isArray(entries) && entries.length ? String(entries[0]?.id ?? "") : "";
  return /^\d+$/.test(id) ? id : null;
}

// What SteamGridDB did return, for a name that matched nothing exactly. Printing
// them is the difference between "not found" and a one-word fix in Steam.
function nearMissNames(candidates) {
  return candidates
    .map((candidate) => candidate?.name)
    .filter(Boolean)
    .slice(0, NEAR_MISS_CAP);
}

async function searchGames(apiFetch, term) {
  const query = sanitizeName(term);
  if (!query) return [];
  const body = await apiFetch(`/search/autocomplete/${encodeURIComponent(query)}`);
  return Array.isArray(body) ? body : [];
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

// content-type first, then the URL, then whatever the API claimed. Each goes
// through the same allowlist: a file with a guessed extension that nothing can
// open is worse than no file at all.
function pickExtension(contentType, url, image) {
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];

  let fromUrl = "";
  try { fromUrl = path.extname(new URL(url).pathname).toLowerCase(); } catch { /* keep going */ }
  if (ALLOWED_EXTS.has(fromUrl)) return fromUrl === ".jpeg" ? ".jpg" : fromUrl;

  const claimed = String(image?.mime || "").toLowerCase();
  return EXT_BY_MIME[claimed] || null;
}

// Stream to a hidden temp beside the target, then rename. A download that is
// interrupted or comes back short therefore never becomes a visible file, which
// is what lets skipExisting trust whatever it finds in the folder.
async function downloadImage(url, image, outDir, nameFor, maxBytes) {
  const res = await withRetry(async () => {
    const r = await imageFetch(url);
    if (!r.ok) {
      const err = new HttpError(r.status, `HTTP ${r.status} ${r.statusText}`, null);
      err.retryAfter = r.headers.get("retry-after");
      throw err;
    }
    return r;
  });

  const contentType = res.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().startsWith("image/")) {
    res.body?.cancel?.();
    return { skipped: `server returned ${contentType.split(";")[0]}, not an image` };
  }

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.body?.cancel?.();
    return { skipped: `${formatBytes(declared)} exceeds the maxMB limit` };
  }

  const ext = pickExtension(contentType, url, image);
  if (!ext) {
    res.body?.cancel?.();
    return { skipped: `unrecognised image type (${contentType || "no content-type"})` };
  }

  const fileName = nameFor(ext);
  const dest = path.join(outDir, fileName);
  const temp = path.join(outDir, `${TEMP_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  activeTemps.add(temp);
  try {
    const sink = fs.createWriteStream(temp);
    await pipeline(Readable.fromWeb(res.body), sink);
    // A body can end cleanly and still be short. content-length is the only
    // thing that catches that, so check it when the server sent one.
    if (Number.isFinite(declared) && declared > 0 && sink.bytesWritten !== declared) {
      throw new Error(`truncated: got ${sink.bytesWritten} of ${declared} bytes`);
    }
    const bytes = sink.bytesWritten;
    fs.renameSync(temp, dest);
    return { fileName, bytes };
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  } finally {
    activeTemps.delete(temp);
  }
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

// N workers pulling from one cursor. The pool is at the game level only, never
// nested around the image downloads too: that keeps the open socket count at
// `size` instead of `size` squared, and it means a killed run leaves whole games
// finished rather than several games half-done.
async function pool(items, size, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Per-game work
// ---------------------------------------------------------------------------

// Long lists are printed one per line and capped — enough to diagnose a library
// that isn't matching, without burying the run in a few hundred lines.
const NAME_LIST_CAP = 15;

function nameListLines(heading, names, level) {
  if (names.length === 0) return [];
  const out = [[`  ${heading}`, level]];
  for (const name of names.slice(0, NAME_LIST_CAP)) out.push([`    ${name}`, level]);
  if (names.length > NAME_LIST_CAP) {
    out.push([`    … and ${names.length - NAME_LIST_CAP} more`, level]);
  }
  return out;
}

function label(game) {
  const name = game.name || "(unknown)";
  return `${game.appid.padEnd(8)} ${(name.length > 34 ? `${name.slice(0, 33)}…` : name).padEnd(34)}`;
}

// A hard stop that should abort the whole run rather than repeat itself once per
// remaining game: the key stopped working, the disk filled up, or the network
// went away entirely.
function fatalReason(err) {
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) {
      return `SteamGridDB rejected the API key mid-run (${err.status}: ${err.message}).`;
    }
    if (err.status === 400) {
      return `SteamGridDB rejected the query (400: ${err.message}). Check the styles and types fields.`;
    }
  }
  const code = err?.code || err?.cause?.code || "";
  if (["ENOSPC", "EDQUOT", "EROFS"].includes(code)) {
    return `Cannot write to the output folder (${code}): ${err.message}`;
  }
  return null;
}

// Resolve a game on SteamGridDB and return its hero list. The appid lookup
// covers essentially everything on Steam; the name search is the fallback for
// delisted or very new appids, and is unavailable for appids with no name.
// A non-Steam shortcut, resolved to the real game behind it. Steam assigns the
// shortcut an appid that is local to this machine — it changes if the shortcut
// is recreated, differs on another install, and names nothing on SteamGridDB —
// so the only usable identity is the name, and the only durable id is the Steam
// appid SteamGridDB reports for the game that name matches.
//
// Returns where to fetch heroes from, plus the appid and name the downloaded
// files should carry. Null when the name matches nothing exactly.
async function resolveShortcut(apiFetch, game, lines) {
  if (!game.name) {
    lines.push([`  ${label(game)} non-Steam shortcut with no name to search for`, "warn"]);
    return null;
  }
  const candidates = await searchGames(apiFetch, game.name);
  const match = exactMatch(game.name, candidates);
  if (!match) {
    lines.push([`  ${label(game)} no exact name match on SteamGridDB`, "warn"]);
    for (const name of nearMissNames(candidates)) {
      lines.push([`      SteamGridDB has: ${name}`, "item"]);
    }
    return null;
  }
  const steamAppid = await steamAppidFor(apiFetch, match.id);
  lines.push([
    `  ${label(game)} non-Steam shortcut -> "${match.name}"` +
      (steamAppid ? ` (Steam appid ${steamAppid})` : " (not on Steam — keeping the shortcut id)"),
    "info",
  ]);
  return {
    endpoint: `/heroes/game/${match.id}`,
    appid: steamAppid || game.appid,
    name: match.name,
  };
}

async function findHeroes(apiFetch, game, options, lines) {
  try {
    await apiFetch(`/games/steam/${game.appid}`);
    return await fetchHeroes(apiFetch, `/heroes/steam/${game.appid}`, options);
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 404) throw err;
  }

  // SteamGridDB has never seen this appid. For a non-Steam shortcut that is the
  // normal case rather than an error — Steam invented the appid locally — so the
  // name Steam holds for it is what gets looked up instead.
  if (!game.name) {
    lines.push([`  ${label(game)} not on SteamGridDB (and no local name to search for)`, "warn"]);
    return null;
  }

  const candidates = await searchGames(apiFetch, game.name);
  const match = exactMatch(game.name, candidates);
  if (!match) {
    const near = nearMissNames(candidates);
    lines.push([`  ${label(game)} no exact name match on SteamGridDB`, "warn"]);
    for (const name of near) lines.push([`      SteamGridDB has: ${name}`, "item"]);
    return null;
  }
  lines.push([`  ${label(game)} matched by name -> SteamGridDB "${match.name}" (id ${match.id})`, "info"]);
  return await fetchHeroes(apiFetch, `/heroes/game/${match.id}`, options);
}

// Everything one game needs. Log lines are collected rather than printed: with
// several workers running, interleaved output is unreadable, so each game's
// block is flushed as a unit when it finishes.
async function processGame(game, ctx) {
  const { apiFetch, options, outDir, index } = ctx;
  const lines = [];
  const stats = { downloaded: 0, skipped: 0, failed: 0, bytes: 0, noHeroes: 0, notFound: 0 };

  // A shortcut has to be resolved before anything else: its local appid matches
  // nothing in the output folder, so a skip-existing check against it would
  // re-download the same art on every run.
  const target = game.shortcut ? await resolveShortcut(apiFetch, game, lines) : null;
  if (game.shortcut && !target) {
    stats.notFound = 1;
    return { lines, stats };
  }
  const artAppid = target ? target.appid : game.appid;
  const artName = target ? target.name : game.name;
  const artLabel = label({ appid: artAppid, name: artName });

  const existing = index.byAppid.get(artAppid) || [];
  if (options.skipExisting && existing.length >= options.limit) {
    lines.push([`  ${artLabel} already has ${existing.length} file(s)`, "item"]);
    stats.skipped += existing.length;
    return { lines, stats };
  }

  const images = target
    ? await fetchHeroes(apiFetch, target.endpoint, options)
    : await findHeroes(apiFetch, game, options, lines);
  if (images === null) {
    stats.notFound = 1;
    return { lines, stats };
  }
  if (images.length === 0) {
    lines.push([`  ${artLabel} no heroes on SteamGridDB`, "warn"]);
    stats.noHeroes = 1;
    return { lines, stats };
  }

  const picked = rankHeroes(images, options.limit);
  lines.push([`  ${artLabel} ${picked.length} hero(es), ${images.length} available`, "info"]);

  for (let i = 0; i < picked.length; i++) {
    const image = picked[i];
    const rank = i + 1;
    const nameFor = (ext) => heroFileName(artName || artAppid, artAppid, rank, Number(image.width), Number(image.height), ext);
    const votes = `+${Number(image.upvotes) || 0}/-${Number(image.downvotes) || 0}`;
    const guess = nameFor(EXT_BY_MIME[String(image.mime || "").toLowerCase()] || ".png");

    if (options.skipExisting && index.names.has(guess)) {
      lines.push([`    skip-existing ${guess}`, "item"]);
      stats.skipped++;
      continue;
    }
    if (!options.apply) {
      lines.push([`    would write  ${guess}   (id ${image.id}, ${votes})`, "item"]);
      continue;
    }

    try {
      const result = await downloadImage(image.url, image, outDir, nameFor, options.maxMB * 1024 * 1024);
      if (result.skipped) {
        lines.push([`    skipped      ${guess} — ${result.skipped}`, "warn"]);
        stats.skipped++;
      } else {
        lines.push([`    wrote        ${result.fileName}   (${formatBytes(result.bytes)}, ${votes})`, "item"]);
        stats.downloaded++;
        stats.bytes += result.bytes;
        index.names.add(result.fileName);
      }
      ctx.state.consecutiveFailures = 0;
    } catch (err) {
      const fatal = fatalReason(err);
      if (fatal) throw new UserError(fatal);
      lines.push([`    FAILED       ${guess} — ${err.message}`, "error"]);
      stats.failed++;
      ctx.state.consecutiveFailures++;
      if (ctx.state.consecutiveFailures >= 10) {
        throw new UserError(
          "Ten downloads failed in a row, so the run was stopped rather than working through the rest of the library.\n" +
          "Check the network connection, then run again — finished games are skipped when skipExisting is on."
        );
      }
    }
  }

  return { lines, stats };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

// One API call and one real write, before anything else. Both failures are
// otherwise only discovered after a full library scan, and the write probe in
// particular catches the macOS case where the folder lists fine and every
// single write then fails.
async function preflight(apiFetch, outDir, apply) {
  try {
    await apiFetch("/games/steam/620");
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      const malformed = /invalid key format/i.test(err.message);
      throw new UserError(
        `SteamGridDB rejected the API key (${err.status}: ${err.message}).\n` +
        (malformed
          ? "The key looks malformed — check for stray whitespace or a partial paste."
          : "The key may have been revoked or regenerated.") +
        `\n\nGenerate a key at ${KEY_URL}`
      );
    }
    if (err instanceof HttpError) {
      throw new UserError(`SteamGridDB is not responding as expected (${err.status}: ${err.message}).`);
    }
    throw new UserError(`Could not reach SteamGridDB: ${err.message}`);
  }

  if (!apply) return;

  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err) {
    throw new UserError(`Could not create the output folder: ${outDir}\n  ${err.code || "error"}: ${err.message}`);
  }
  if (!isDir(outDir)) throw new UserError(`Output path exists but is not a directory: ${outDir}`);

  const probe = path.join(outDir, `${TEMP_PREFIX}probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
  } catch (err) {
    const denied = err.code === "EPERM" || err.code === "EACCES";
    throw new UserError(
      `Cannot write to the output folder: ${outDir}\n  ${err.code || "error"}: ${err.message}` +
      (denied
        ? "\n\nmacOS is blocking this folder. Either grant the app access in System Settings →" +
          "\nPrivacy & Security → Files and Folders (or Full Disk Access), or point outDir at" +
          "\nan unprotected folder such as ~/steam-heroes."
        : "")
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Run the whole operation. `onLog(message, level)` receives every human-readable
// line as it happens; the return value carries the totals for a UI.
async function run(options, hooks = {}) {
  const { onLog = () => {} } = hooks;
  const log = (m, level = "info") => onLog(m, level);

  if (!options.outDir) {
    throw new UserError("outDir is required. Set it to the folder the hero images should be written to.");
  }
  const outDir = path.resolve(expandHome(options.outDir));
  // Windows caps a full path at 260 characters; the longest name this script can
  // produce is 175 bytes, so a deep outDir has to be caught before file 173.
  if (process.platform === "win32" && outDir.length + 176 > 255) {
    throw new UserError(`The output folder path is too long for Windows: ${outDir}\nUse a shorter path.`);
  }

  const apiKey = resolveApiKey(options, (m) => log(m, "warn"));
  const apiFetch = makeApi(apiKey);
  await preflight(apiFetch, outDir, options.apply);

  const steamRoot = findSteamRoot(options.steam);
  if (!steamRoot) {
    throw new UserError(
      "Could not find a Steam installation in any of the usual locations:\n" +
      candidateSteamRoots().map((c) => `  - ${c}`).join("\n") +
      "\n\nIf Steam is installed elsewhere, set the steam field to that folder."
    );
  }
  log(`Steam found at: ${steamRoot}`);
  // Log the resolved path: a relative outDir is written from the app's working
  // directory, which is rarely what the field looks like it says.
  log(`Output folder:  ${outDir}`);

  const accounts = resolveAccounts(steamRoot, options);
  log(`Accounts: ${accounts.length ? accounts.join(", ") : "(none found — using machine-wide sources only)"}`);
  log(options.apply
    ? "Mode: APPLY (writing files)"
    : "Mode: dry-run (no files written — the API is still queried, so real filenames can be shown)",
    options.apply ? "warn" : "info");

  // An explicit appid list bypasses the library scan and the type filter: asking
  // for one appid should fetch it whether or not it is installed or classified.
  let games;
  if (options.game) {
    const ids = csv(options.game);
    const bad = ids.filter((id) => !/^\d+$/.test(id));
    if (bad.length) throw new UserError(`Not a valid appid: ${bad.join(", ")}. Use numeric Steam appids, or "all".`);
    // Shortcut names are pulled here too: an explicitly named shortcut appid is
    // otherwise nameless, and the name is the only thing SteamGridDB can match.
    const named = resolveLibraryGames(steamRoot, new Set(ids), discoverShortcuts(steamRoot, accounts), (m) => log(m, "warn"));
    games = ids.map((id) => named.get(id) || { appid: id, name: null, type: null });
    log(`Requested ${games.length} appid(s): ${games.map((g) => g.name || g.appid).join(", ")}`);
  } else {
    const { appids, counts, shortcuts } = discoverLibrary(steamRoot, accounts);
    log(`Library: ${appids.size} appid(s)  (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")})`);
    if (appids.size === 0) {
      throw new UserError(
        "No appids found in the local Steam data. Open Steam once so it populates its library cache,\n" +
        "or name the appids directly in the game field."
      );
    }
    const all = resolveLibraryGames(steamRoot, appids, shortcuts, (m) => log(m, "warn"));

    // Read before the loop, and checked before the type filter: a starred game is
    // one the user picked by hand, so what Steam calls it is beside the point.
    const favorites = options.favoritesOnly ? discoverFavorites(steamRoot, accounts) : null;
    if (favorites) {
      // Zero stars would otherwise plan nothing and read as an empty library
      // rather than as the filter doing exactly what it was asked to.
      if (favorites.size === 0) {
        throw new UserError(
          `favoritesOnly is on, but Steam lists no favorites for ${accounts.length ? `account(s) ${accounts.join(", ")}` : "any account"}.\n` +
          "Star some games in the Steam library (right-click a game -> Add to -> Favorites) and let\n" +
          "Steam save them, or turn favoritesOnly off."
        );
      }
      log(`Favorites only: ${favorites.size} starred game(s); everything else is skipped.`);
    }

    const kept = [];
    const filtered = [];
    let notFavorite = 0;
    let unknownType = 0;
    for (const game of all.values()) {
      if (favorites && !favorites.has(game.appid)) { notFavorite++; continue; }
      // An appid with no type at all is far more likely to be an owned game that
      // simply isn't in the local appinfo cache than it is to be a tool, so keep it.
      if (!game.type) { unknownType++; kept.push(game); continue; }
      if (options.includeNonGames || isGameType(game.type)) kept.push(game);
      else filtered.push(game);
    }
    kept.sort((a, b) => (a.name || a.appid).localeCompare(b.name || b.appid));
    log(`  -> ${kept.length} game(s), ` +
      (favorites ? `${notFavorite} not starred, ` : "") +
      `${filtered.length} filtered out by type, ${unknownType} with unknown type (kept)`,
      kept.length > 0 ? "info" : "warn");
    if (favorites && kept.length === 0) {
      log("  Every starred game was filtered out. A star on something Steam classes as a tool or\n" +
        "  demo needs includeNonGames to come through.", "warn");
    }
    if (shortcuts.size > 0) {
      log(`  -> ${shortcuts.size} non-Steam shortcut(s) included; these are matched by name: ${[...shortcuts.values()].join(", ")}`);
    }
    games = kept;
  }

  const swept = sweepStaleTemps(outDir);
  if (swept > 0) log(`Cleaned up ${swept} leftover partial download(s) from an earlier run.`, "warn");

  const index = readOutDirIndex(outDir);
  if (index.names.size > 0) {
    log(`Output folder already holds ${index.names.size} hero(es) for ${index.byAppid.size} game(s).`);
  }
  log("");

  const totals = { downloaded: 0, skipped: 0, failed: 0, bytes: 0, noHeroes: 0, notFound: 0 };
  const ctx = { apiFetch, options, outDir, index, state: { consecutiveFailures: 0 } };
  const failedGames = [];

  const results = await pool(games, options.concurrency, async (game) => {
    try {
      return await processGame(game, ctx);
    } catch (err) {
      if (err instanceof UserError) throw err;
      const fatal = fatalReason(err);
      if (fatal) throw new UserError(fatal);
      failedGames.push(`${game.appid} ${game.name || ""}`.trim());
      ctx.state.consecutiveFailures++;
      return { lines: [[`  ${label(game)} FAILED — ${err.message}`, "error"]], stats: { downloaded: 0, skipped: 0, failed: 1, bytes: 0, noHeroes: 0, notFound: 0 } };
    }
  });

  for (const result of results) {
    if (!result) continue;
    for (const [line, level] of result.lines) log(line, level);
    for (const key of Object.keys(totals)) totals[key] += result.stats[key] || 0;
  }

  log("");
  log(`  -> ${games.length} game(s): ${totals.downloaded} downloaded, ${totals.skipped} skipped, ` +
    `${totals.noHeroes} without heroes, ${totals.notFound} not on SteamGridDB, ${totals.failed} failed`);
  if (options.apply) log(`  -> ${formatBytes(totals.bytes)} written to ${outDir}`);
  log(`  -> ${limiter.requests} API request(s), ${limiter.retried} retried, ${limiter.rateLimited} rate-limited`);
  for (const [line, level] of nameListLines("games that failed outright:", failedGames, "error")) log(line, level);

  if (options.apply) {
    log(`\nDone. Downloaded ${totals.downloaded} hero(es).`, totals.failed ? "warn" : "success");
    if (totals.failed) log(`${totals.failed} download(s) failed. Run again to retry just those.`, "error");
  } else {
    log("\nDry-run complete. Set apply to true to download these images.", "info");
  }

  return { steamRoot, outDir, games: games.length, totals };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// The app kills a stopped script with SIGTERM and follows up with SIGKILL five
// seconds later, so this has to be quick. Temp files are cleaned up here purely
// so the folder stays tidy — write-then-rename already guarantees that no
// truncated file is ever visible.
let stopping = false;
function onSignal() {
  if (stopping) return;
  stopping = true;
  for (const temp of activeTemps) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
  console.error("\nStopped. Run again to resume — finished games are skipped when skipExisting is on.");
  process.exit(1);
}
process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);

try {
  const result = await run(opts, {
    onLog: (message, level) => {
      if (level === "error") console.error(message);
      else console.log(message);
    },
  });
  if (result.totals.failed > 0) process.exitCode = 1;
} catch (err) {
  if (err instanceof UserError) {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
