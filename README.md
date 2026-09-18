<img src="build/icon.png" alt="" width="96" align="right" />

# Command Scheduler

An Electron tray app that runs shell commands on a cron schedule. Extracted from the Commands tab in [samsung-tv-control](https://github.com/timdevlet/samsung-tv-control).

Each command is a shell line (for example `node ~/scripts/backup.js`) that can run on a 5-field cron expression, or only when you press ▶. Runs go through your login shell, so your normal `PATH` applies. Closing the window hides it to the tray so schedules keep firing.

## Run

```bash
npm install
npm run electron:dev
```

Commands are stored in `scheduled-commands.json` (project root in development; the app data folder when packaged). Export / Import on the Commands tab uses the same file format.

## JS scripts

The Scripts tab runs JavaScript you write yourself, with `{{name}}` holes that become fields you fill in before running. Each script is a folder of its own:

```
js-scripts/
└── my-script/
    ├── script.js      the source — a plain .js file, editable in any editor
    └── script.json    name, parameter values, cron, working directory, timeout
```

The folder is named after the script, but the `id` in `script.json` is its identity, so renaming a script moves its folder without losing its run history. Settings → Scripts points the whole thing at any folder you like; blank means `js-scripts/` beside the other app data. An older `js-scripts.json` is moved into that layout the first time the app starts without one.

## Secrets

API keys and tokens live in their own file, so nothing you might commit, export or share has a key in it. Add them under Settings → Secrets, then refer to them by name:

```
Commands tab   curl -H "key: {{DB_API_KEY}}" https://api.example.com
Scripts tab    const res = await fetch(url, { headers: { key: {{apiKey}} } })
               …and type {{DB_API_KEY}} into the apiKey field
```

The value is never substituted into the command or the script. It is passed to the run through its environment — in a command `{{DB_API_KEY}}` expands the way `$DB_API_KEY` does (`%DB_API_KEY%` on Windows), and in a script's parameter value it compiles to `process.env.DB_API_KEY` — so keep a reference out of single quotes, where a shell would not expand it. A field holding a reference gets a key button beside it that shows what the reference currently stands for. A run only ever receives the secrets it names, run output has their values masked before it reaches the log, and a run whose secret is not set is refused by name rather than started with an empty value.

Secrets are stored in `secrets.json` next to the other app data, written so that only your account can read it, and Settings → Secrets shows and edits the values in place. That is the whole of the protection: it is a config file, like a `.netrc` or an `.env`, not an encrypted store — anything running as you can read it. What it buys you is that your scripts folder holds no keys, so it is safe to put in git.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run electron:dev` | Dev app with hot-reload |
| `npm test` | Unit tests (scheduler, cron, runner) |
| `npm run typecheck` | TypeScript |
| `npm run electron:build` | Bundle into `dist-electron/` |
| `npm run dist` | Packaged installer via electron-builder |
