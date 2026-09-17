// Regenerate build/icon.ico from the ring mark, using Windows base-shape geometry.
//
// The macOS artwork (build/icon.png) is an opaque square: the ring sits on a white plate that
// fills the canvas, because macOS masks app icons itself. Windows does not mask, so that plate
// shows up as a white tile in the taskbar and Start menu. Here the circle *is* the base shape:
// a transparent canvas with a white disc, ringed in the mark's ink, sized to the Fluent geometry
// (192/256 of the canvas for a circle) and padded less at the small sizes, the way system icons
// are hand-tuned so the mark stays legible at 16px.
//
// Run manually after the artwork changes: node scripts/make-win-icon.mjs

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const INK = [0x22, 0x22, 0x21]; // ring colour, sampled from build/icon.png
const PLATE = [0xfd, 0xfd, 0xfd]; // disc fill, the white the ring sits on
const STROKE_RATIO = 69 / 824; // ring thickness / outer diameter, from the master artwork

// Circle diameter per canvas size. 0.75 is the Fluent circle (192 on a 256 grid); the small sizes
// are pinned to whole even pixel counts so the ring lands on pixel boundaries and keeps a pixel of
// breathing room at the canvas edge, the way hand-tuned system icons do.
const SMALL_DIAMETER = { 16: 14, 20: 18, 24: 22, 32: 28, 48: 40 };
const CIRCLE_RATIO = 0.75;

const SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
const SUBSAMPLES = 4; // per axis, for edge antialiasing

function diameter(size) {
  return SMALL_DIAMETER[size] ?? size * CIRCLE_RATIO;
}

// RGBA pixels, top-down. Coverage is estimated by supersampling each pixel.
function renderCircle(size) {
  const outer = diameter(size) / 2;
  const stroke = Math.max(outer * 2 * STROKE_RATIO, size <= 32 ? 1.5 : 2);
  const inner = Math.max(outer - stroke, 0);
  const centre = size / 2;
  const px = Buffer.alloc(size * size * 4);
  const step = 1 / SUBSAMPLES;
  const offset = step / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hitsOuter = 0;
      let hitsInner = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy++) {
        for (let sx = 0; sx < SUBSAMPLES; sx++) {
          const dx = x + sx * step + offset - centre;
          const dy = y + sy * step + offset - centre;
          const d = Math.hypot(dx, dy);
          if (d <= outer) hitsOuter++;
          if (d <= inner) hitsInner++;
        }
      }
      const total = SUBSAMPLES * SUBSAMPLES;
      const alpha = hitsOuter / total;
      if (alpha === 0) continue;
      // Within the covered area, the share that falls inside the inner edge is plate, the rest ink.
      const plateShare = hitsInner / hitsOuter;
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        px[o + c] = Math.round(INK[c] * (1 - plateShare) + PLATE[c] * plateShare);
      }
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// A 32-bit BGRA DIB, bottom-up, with the trailing (unused but mandatory) AND mask. NSIS reads the
// installer icon itself and does not handle PNG-compressed ICO entries, so every entry is a DIB.
function toDib(px, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height counts colour + mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const colour = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      colour[d] = px[s + 2];
      colour[d + 1] = px[s + 1];
      colour[d + 2] = px[s];
      colour[d + 3] = px[s + 3];
    }
  }
  const maskStride = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, colour, Buffer.alloc(maskStride * size)]);
}

function toIco(entries) {
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    dir.writeUInt8(size === 256 ? 0 : size, e);
    dir.writeUInt8(size === 256 ? 0 : size, e + 1);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

function toPng(px, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "ascii");
    body.copy(out, 8);
    const crcInput = out.subarray(4, 8 + body.length);
    let crc = ~0;
    for (const byte of crcInput) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    out.writeUInt32BE(~crc >>> 0, 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const rendered = SIZES.map((size) => ({ size, px: renderCircle(size) }));
await writeFile(
  path.join(root, "build/icon.ico"),
  toIco(rendered.map(({ size, px }) => ({ size, data: toDib(px, size) }))),
);
// Same artwork as a plain PNG, for the runtime BrowserWindow icon on Windows and Linux.
await writeFile(
  path.join(root, "build/icon-win-256.png"),
  toPng(rendered.find((r) => r.size === 256).px, 256),
);
console.log(`build/icon.ico (${SIZES.join(", ")}) and build/icon-win-256.png written`);
