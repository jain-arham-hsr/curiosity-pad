// Draws the toolbar icon (a half-filled trail marker, ◐) as PNGs with no
// dependencies. Run: node scripts/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const COLOR = [0x2f, 0x6f, 0x5e];
const SAMPLES = 4;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// `maskable`: a full-bleed background with the mark in the safe zone, for
// Android launchers that crop icons into circles or squircles.
function icon(size, { maskable = false } = {}) {
  const c = size / 2;
  const scale = maskable ? 0.6 : 1;
  const outer = size * 0.44 * scale;
  const stroke = Math.max(1.25, size * 0.1 * scale);
  const inner = outer - stroke;
  const mark = (x, y) => {
    const d = Math.hypot(x - c, y - c);
    return (d <= outer && d >= inner) || (d < inner && x < c);
  };
  const BG = [0x16, 0x16, 0x17];
  const FG = maskable ? [0x6f, 0xbf, 0xa6] : COLOR;
  const covered = (x, y) => mark(x, y);

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          if (covered(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES)) hits++;
        }
      }
      const i = row + 1 + x * 4;
      const a = hits / (SAMPLES * SAMPLES);
      if (maskable) {
        for (let k = 0; k < 3; k++) raw[i + k] = Math.round(BG[k] + (FG[k] - BG[k]) * a);
        raw[i + 3] = 255;
      } else {
        raw[i] = FG[0];
        raw[i + 1] = FG[1];
        raw[i + 2] = FG[2];
        raw[i + 3] = Math.round(255 * a);
      }
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(new URL(`../extension/icons/${size}.png`, import.meta.url), icon(size));
}
for (const size of [192, 512]) {
  writeFileSync(new URL(`../web/icons/${size}.png`, import.meta.url), icon(size));
}
writeFileSync(new URL('../web/icons/512-maskable.png', import.meta.url), icon(512, { maskable: true }));
console.log('icons written to extension/icons/ and web/icons/');
