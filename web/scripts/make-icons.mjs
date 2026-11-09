// Renders the PWA PNG icons (same design as public/icons/icon.svg): the Claude Control Mobile
// mark, a white phone outline with a red notification dot on a dark tile.
// No dependencies: a tiny rasterizer with 4x4 supersampling and a PNG encoder on node:zlib.
// Run: node web/scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../public/icons/", import.meta.url));

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const TILE = hex("#1D1B19");
const WHITE = [255, 255, 255];
const RED = hex("#E5484D");

// Shapes in a 512 grid (same numbers as icon.svg).
const PHONE = { x: 168, y: 96, w: 176, h: 320, r: 40, half: 15 };
const BAR = { x1: 226, x2: 286, y: 362, half: 13 };
const DOT = { cx: 336, cy: 128, r: 42, ring: 18 };

// Signed distance to a rounded rectangle outline (negative inside).
function roundRectDist(px, py, { x, y, w, h, r }) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function glyph(px, py) {
  const d = Math.hypot(px - DOT.cx, py - DOT.cy);
  if (d <= DOT.r) return RED;
  if (d <= DOT.r + DOT.ring) return TILE;
  if (Math.abs(roundRectDist(px, py, PHONE)) <= PHONE.half) return WHITE;
  const bx = Math.max(BAR.x1, Math.min(BAR.x2, px));
  if ((px - bx) ** 2 + (py - BAR.y) ** 2 <= BAR.half ** 2) return WHITE;
  return TILE;
}

function insideRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** @param size output px, @param maskable full bleed bg and content in the 80% safe zone */
function render(size, { maskable = false, rounded = true } = {}) {
  const px = new Uint8Array(size * size * 4);
  const ss = 4;
  const scale = 512 / size;
  // Content transform: maskable shrinks content to 70% around the center.
  const k = maskable ? 0.7 : 1;
  const off = (512 * (1 - k)) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, bl = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const gx = (x + (sx + 0.5) / ss) * scale;
          const gy = (y + (sy + 0.5) / ss) * scale;
          const bgHit = maskable || !rounded ? true : insideRoundRect(gx, gy, 0, 0, 512, 512, 112);
          if (!bgHit) continue;
          const cx = (gx - off) / k;
          const cy = (gy - off) / k;
          const c = glyph(cx, cy);
          r += c[0]; g += c[1]; bl += c[2]; a += 1;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      if (a) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(bl / a);
      }
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, size, px);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const files = {
  "icon-192.png": render(192),
  "icon-512.png": render(512),
  "maskable-512.png": render(512, { maskable: true }),
  "apple-touch-icon.png": render(180, { rounded: false }),
};
for (const [name, buf] of Object.entries(files)) {
  writeFileSync(out + name, buf);
  console.log(`${name} ${buf.length} bytes`);
}
