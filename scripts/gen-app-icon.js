/**
 * Generates public/app-icon.png — the amber Trigr logo at 256×256 and 16×16.
 * Matches the SVG in TitleBar.js using accent colour #e8a020.
 * Run: node scripts/gen-app-icon.js
 */
'use strict';
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// --- CRC32 ---------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// --- PNG builder ---------------------------------------------------------
function buildPNG(width, height, getPixel) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y);
      const off = y * (rowBytes + 1) + 1 + x * 4;
      raw[off]     = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  function chunk(type, data) {
    const len  = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeB = Buffer.from(type, 'ascii');
    const crcB  = Buffer.alloc(4);
    crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
    return Buffer.concat([len, typeB, data, crcB]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]), // PNG sig
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Logo renderer -------------------------------------------------------
// Matches TitleBar.js SVG: viewBox 0 0 20 20, accent = #e8a020
const ACCENT = [232, 160, 32]; // #e8a020

const RECTS = [
  { x: 2,  y: 5,  w: 6,  h: 4, rx: 1.5, op: 0.9 },
  { x: 10, y: 5,  w: 4,  h: 4, rx: 1.5, op: 0.6 },
  { x: 16, y: 5,  w: 2,  h: 4, rx: 1.0, op: 0.4 },
  { x: 2,  y: 11, w: 4,  h: 4, rx: 1.5, op: 0.5 },
  { x: 8,  y: 11, w: 10, h: 4, rx: 1.5, op: 0.8 },
];

// Sub-pixel coverage: sample a grid of NxN points per pixel
const SAMPLES = 4;

function coverage(px, py, scale) {
  // Returns 0..1 — fraction of sub-samples inside any rect
  let hits = 0;
  const step = 1 / SAMPLES;
  const half = step / 2;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const fx = px + half + sx * step;
      const fy = py + half + sy * step;
      for (const r of RECTS) {
        if (insideRRect(fx, fy, r.x * scale, r.y * scale, r.w * scale, r.h * scale, r.rx * scale)) {
          hits++;
          break; // only count once per sample point
        }
      }
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

function opacityAt(px, py, scale) {
  // Max opacity among all rects that contain the point centre
  let maxOp = 0;
  for (const r of RECTS) {
    if (insideRRect(px + 0.5, py + 0.5, r.x * scale, r.y * scale, r.w * scale, r.h * scale, r.rx * scale)) {
      if (r.op > maxOp) maxOp = r.op;
    }
  }
  return maxOp;
}

function insideRRect(fx, fy, rx, ry, rw, rh, radius) {
  if (fx < rx || fx > rx + rw || fy < ry || fy > ry + rh) return false;
  const dx = Math.max(rx + radius - fx, 0, fx - (rx + rw - radius));
  const dy = Math.max(ry + radius - fy, 0, fy - (ry + rh - radius));
  return dx * dx + dy * dy <= radius * radius;
}

function makePixel(px, py, size) {
  const scale = size / 20;
  const cov   = coverage(px, py, scale);
  if (cov === 0) return [0, 0, 0, 0];
  const op  = opacityAt(px, py, scale);
  const alpha = Math.round(cov * op * 255);
  return [ACCENT[0], ACCENT[1], ACCENT[2], alpha];
}

// --- Generate & save -----------------------------------------------------
const outDir = path.join(__dirname, '..', 'public');

for (const size of [256, 64, 32, 16]) {
  const png = buildPNG(size, size, (x, y) => makePixel(x, y, size));
  const file = path.join(outDir, size === 256 ? 'app-icon.png' : `app-icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`Generated ${file} (${png.length} bytes)`);
}
