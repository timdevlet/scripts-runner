// Build the Electron app: stage the runtime icons, bundle the main + preload processes with
// esbuild, and copy the renderer into dist-electron/. Run via `npm run electron:build`.

import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist-electron");
const buildDir = path.join(root, "build");

const tsResolve = {
  name: "ts-resolve",
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === "entry-point" || !args.path.startsWith(".")) return;
      const tsPath = path.resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      if (existsSync(tsPath)) return { path: tsPath };
    });
  },
};

async function bundle(entry, outfile, { injectImportMeta = true } = {}) {
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(out, outfile),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    sourcemap: true,
    external: ["electron"],
    plugins: [tsResolve],
    ...(injectImportMeta
      ? {
          banner: { js: "const import_meta_url = require('url').pathToFileURL(__filename).href;" },
          define: { "import.meta.url": "import_meta_url" },
        }
      : {}),
    logLevel: "info",
  });
}

// Runtime icons. The source-of-truth artwork lives in build/ (derived from the AppIcons pack);
// the packaged app only ships what it loads at runtime, so copy those into dist-electron/.
// electron-builder reads build/icon.png and build/icon.ico straight from buildResources.
const RUNTIME_ICONS = [
  ["icon-256.png", "icon.png"], // BrowserWindow icon
  ["tray/tray.png", "tray.png"], // macOS template glyph
  ["tray/tray@2x.png", "tray@2x.png"],
  ["tray/tray-white.png", "tray-white.png"], // Windows / Linux glyph
  ["tray/tray-white@1.5x.png", "tray-white@1.5x.png"],
  ["tray/tray-white@2x.png", "tray-white@2x.png"],
  ["tray/tray-white@3x.png", "tray-white@3x.png"],
];

async function copyIcons() {
  await mkdir(out, { recursive: true });
  await Promise.all(
    RUNTIME_ICONS.map(([from, to]) => copyFile(path.join(buildDir, from), path.join(out, to))),
  );
}

export async function buildMainPreloadAndIcons() {
  await copyIcons();
  await bundle("src/electron/main.ts", "main.cjs");
  await bundle("src/electron/preload.ts", "preload.cjs", { injectImportMeta: false });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildMainPreloadAndIcons();
  const { build: viteBuild } = await import("vite");
  await viteBuild({ configFile: path.join(root, "vite.renderer.config.ts") });
  console.log("Electron build complete → dist-electron/");
}
