// Build the Electron app: generate icons, bundle the main + preload processes with esbuild, and
// copy the renderer into dist-electron/. Run via `npm run electron:build`.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
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

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc(size * (1 + stride));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + stride)] = 0;
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeICO(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);
  return Buffer.concat([header, entry, png]);
}

function coverage(dist, halfWidth) {
  const edge = 0.65;
  if (dist >= halfWidth + edge) return 0;
  if (dist <= halfWidth - edge) return 1;
  return 1 - (dist - (halfWidth - edge)) / (2 * edge);
}

// Solid disc on a transparent field. Used for the tray glyph, where alpha comes from coverage so
// the macOS template image stays a clean silhouette.
function renderDisc(size, fill, radiusRatio = 0.36) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size * radiusRatio;
  const [fr, fg, fb] = fill;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(Math.hypot(x - c, y - c), r);
      if (a <= 0) continue;
      const i = (y * size + x) * 4;
      rgba[i] = fr;
      rgba[i + 1] = fg;
      rgba[i + 2] = fb;
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

// App icon: black disc composited over an opaque white square.
function renderAppIcon(size) {
  const rgba = renderDisc(size, [0, 0, 0], 0.32);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    rgba[i] = Math.round(rgba[i] * a + 255 * (1 - a));
    rgba[i + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
    rgba[i + 2] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
    rgba[i + 3] = 255;
  }
  return rgba;
}

async function generateIcons() {
  await mkdir(buildDir, { recursive: true });
  await mkdir(out, { recursive: true });

  const appIcon = (size) => encodePNG(size, renderAppIcon(size));
  const trayBlack = (size) => encodePNG(size, renderDisc(size, [0, 0, 0]));
  const trayWhite = (size) => encodePNG(size, renderDisc(size, [255, 255, 255]));

  const png512 = appIcon(512);
  const png256 = appIcon(256);
  await writeFile(path.join(buildDir, "icon.png"), png512);
  await writeFile(path.join(buildDir, "icon.ico"), encodeICO(png256, 256));
  await writeFile(path.join(out, "icon.png"), png256);
  await writeFile(path.join(out, "tray.png"), trayBlack(16));
  await writeFile(path.join(out, "tray@2x.png"), trayBlack(32));
  await writeFile(path.join(out, "tray-white.png"), trayWhite(16));
  await writeFile(path.join(out, "tray-white@1.5x.png"), trayWhite(24));
  await writeFile(path.join(out, "tray-white@2x.png"), trayWhite(32));
  await writeFile(path.join(out, "tray-white@3x.png"), trayWhite(48));
}

export async function buildMainPreloadAndIcons() {
  await generateIcons();
  await bundle("src/electron/main.ts", "main.cjs");
  await bundle("src/electron/preload.ts", "preload.cjs", { injectImportMeta: false });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildMainPreloadAndIcons();
  const { build: viteBuild } = await import("vite");
  await viteBuild({ configFile: path.join(root, "vite.renderer.config.ts") });
  console.log("Electron build complete → dist-electron/");
}
