#!/usr/bin/env node
// steam-bg-to-widecover.js
//
// Finds your Steam installation and, for every game in your library, takes that
// game's Background (hero) image and writes it into the Wide Cover (landscape
// capsule) custom-art slot. In short: "replace the wide cover with the background".
//
// Dry-run by default (prints what it would do, changes nothing).
// Pass --apply to actually write the files (existing wide covers are backed up).
//
// The logic lives in src/core.js and is shared with the Electron app (npm start).
//
// Usage:
//   node steam-bg-to-widecover.js                 # dry-run, auto-detect Steam
//   node steam-bg-to-widecover.js --apply         # actually do it
//   node steam-bg-to-widecover.js --steam <path>  # override Steam root
//   node steam-bg-to-widecover.js --account <id>  # pick a userdata account
//   node steam-bg-to-widecover.js --all-accounts  # apply to every account
//   node steam-bg-to-widecover.js --game <appid>  # limit to one game
//   node steam-bg-to-widecover.js --skip-existing # never overwrite an existing wide cover
//   node steam-bg-to-widecover.js --covers <dir>  # use a folder of wide backgrounds
//   node steam-bg-to-widecover.js --list-backups  # show restorable backups
//   node steam-bg-to-widecover.js --restore <name> --apply   # undo a previous run

import {
  UserError,
  findSteamRoot,
  listAccounts,
  listBackups,
  resolveAccounts,
  restoreBackup,
  run,
} from "./src/core.js";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = {
  "--steam": "steam",
  "--account": "account",
  "--game": "game",
  "--covers": "coversDir",
  "--restore": "restore",
};

function parseArgs(argv) {
  const opts = {
    apply: false,
    steam: null,
    account: null,
    allAccounts: false,
    game: null,
    skipExisting: false,
    coversDir: null,
    restore: null,
    listBackups: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in VALUE_FLAGS) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new UserError(`${a} requires a value.`);
      }
      opts[VALUE_FLAGS[a]] = value;
      continue;
    }
    switch (a) {
      case "--apply": opts.apply = true; break;
      case "--all-accounts": opts.allAccounts = true; break;
      case "--skip-existing": opts.skipExisting = true; break;
      case "--list-backups": opts.listBackups = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        throw new UserError(`Unknown argument: ${a}\nRun with --help to see the available options.`);
    }
  }
  return opts;
}

const HELP = `steam-bg-to-widecover — set each game's Background (hero) as its Wide Cover.

Usage:
  node steam-bg-to-widecover.js [options]

Options:
  --apply           Perform the changes (default is a dry-run preview).
  --steam <path>    Override the Steam install root (auto-detected otherwise).
  --account <id>    Use a specific userdata account id.
  --all-accounts    Apply to every userdata account found.
  --game <appid>    Limit the operation to a single game (appid).
  --skip-existing   Don't overwrite a wide cover that already exists.
  --covers <path>   Folder of wide-background images; the appid must appear
                    somewhere in each filename. A match here overrides the
                    hero art and becomes the wide cover.
  --list-backups    List the restorable backups for the selected account(s).
  --restore <name>  Undo a previous run by restoring that backup folder
                    (preview only unless --apply is also given).
  -h, --help        Show this help.

Existing wide covers are moved into grid/_widecover_backup_<timestamp>/ before
being overwritten, so changes can be undone.

For a graphical version of all of this, run:  npm start`;

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

function requireSteamRoot(opts) {
  const steamRoot = findSteamRoot(opts.steam);
  if (!steamRoot) throw new UserError("Could not find a Steam installation. Pass it explicitly with --steam <path>.");
  return steamRoot;
}

function cmdListBackups(opts) {
  const steamRoot = requireSteamRoot(opts);
  const accounts = opts.account || opts.allAccounts ? resolveAccounts(steamRoot, opts) : listAccounts(steamRoot);
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
  else console.log(`\nRestore one with:  node steam-bg-to-widecover.js --restore <name> --apply`);
  return 0;
}

function cmdRestore(opts) {
  const steamRoot = requireSteamRoot(opts);
  const accounts = resolveAccounts(steamRoot, opts);
  let total = 0;

  for (const accountId of accounts) {
    if (!listBackups(steamRoot, accountId).some((b) => b.name === opts.restore)) continue;
    const res = restoreBackup(steamRoot, accountId, opts.restore, { apply: opts.apply });
    console.log(`\nAccount ${accountId}  restoring ${opts.restore}`);
    for (const item of res.items) {
      const replaces = item.replaces.length ? ` (removes ${item.replaces.join(", ")})` : "";
      console.log(`  appid ${item.appid.padEnd(8)} ${item.file}${replaces}`);
    }
    total += res.items.length;
    for (const e of res.errors) console.error(`  FAILED  ${e}`);
    if (opts.apply) console.log(`  -> restored ${res.restored} file(s), removed ${res.removed} replacement(s)`);
  }

  if (total === 0) throw new UserError(`Backup "${opts.restore}" was not found. Use --list-backups to see what's available.`);
  if (opts.apply) console.log("\nFully restart Steam to see the restored covers.");
  else console.log("\nPreview only. Re-run with --apply to restore.");
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.listBackups) return cmdListBackups(opts);
  if (opts.restore) return cmdRestore(opts);

  const result = run(opts, {
    onLog: (message, level) => {
      if (level === "error") console.error(message);
      else console.log(message);
    },
  });
  return result.errors.length > 0 ? 1 : 0;
}

try {
  process.exit(main());
} catch (err) {
  if (err instanceof UserError) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
