// Builds the app icon (a spiral pad under a night sky) as SVG files in assets/,
// then rasterises them with the installed Chrome. No npm dependencies.
//
//   node scripts/make-icons.mjs
//
// assets/icon.svg           the full art (rounded tile)         → 48, 128, 192, 512
// assets/icon-small.svg     fewer, bolder coils for tiny sizes  → 16, 32
// assets/icon-maskable.svg  art at 72 % on a solid square       → 512 maskable
// assets/icon-plain*.svg    the pad alone, transparent          → extension 16–128, favicon

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync);

// ---- the art ---------------------------------------------------------------

const PAGE = '#a8d9c3';
const STACK = ['#4f8f78', '#6fb092', '#8cc7ab'];
const HOLE = '#4f8f78';
const INK = '#1f5f4a';
const X = 30, W = 68, TOP = 33, BOTTOM = 103, R = 10;

// A deterministic star field, so every build is identical.
function starField(n = 42) {
  let seed = 7;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = 4 + rnd() * 120, y = 4 + rnd() * 120, r = 0.5 + rnd() * 1.1, o = 0.25 + rnd() * 0.5;
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="#fff" fill-opacity="${o.toFixed(2)}"/>`;
  }
  return out;
}

const page = (bottom, fill) =>
  `<path d="M${X} ${TOP} h${W} v${bottom - TOP - R} a${R} ${R} 0 0 1 -${R} ${R} h-${W - 2 * R} a${R} ${R} 0 0 1 -${R} -${R} z" fill="${fill}"/>`;

// Coils pass through the page: the loop is drawn behind it, then the page,
// then a punched hole and the front strand of wire coming down into it.
function coils(n, sw) {
  const rx = 4.6, ry = 8.5, tilt = -22;
  const step = W / n;
  let back = '', front = '';
  for (let i = 0; i < n; i++) {
    const x = X + step * (i + 0.5);
    back += `<ellipse cx="${x.toFixed(2)}" cy="${TOP}" rx="${rx}" ry="${ry}" transform="rotate(${tilt} ${x.toFixed(2)} ${TOP})" fill="none" stroke="url(#wire)" stroke-width="${sw}"/>`;
    const cx = x + rx * 0.9, cy = TOP - 2, hx = x + 1.2, hy = TOP + 7;
    front += `<circle cx="${hx.toFixed(2)}" cy="${hy}" r="2.6" fill="${HOLE}"/>`
      + `<path d="M${cx.toFixed(2)} ${cy} C ${(cx + 0.5).toFixed(2)} ${cy + 4}, ${(hx + 1.5).toFixed(2)} ${hy - 3}, ${hx.toFixed(2)} ${hy}" fill="none" stroke="url(#wire)" stroke-width="${sw}" stroke-linecap="round"/>`;
  }
  return { back, front };
}

const questionMark = (scale) =>
  `<g transform="translate(64 71) scale(${scale})"><path d="M-14 -10 a14 14 0 1 1 21 12 c-5.5 3 -7 6 -7 12" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/><circle cx="0" cy="26" r="5" fill="${INK}"/></g>`;

function pad({ coilCount, wire, qScale }) {
  const c = coils(coilCount, wire);
  return `<g transform="translate(0 -3)">${c.back}`
    + page(BOTTOM + 8, STACK[0]) + page(BOTTOM + 5.5, STACK[1]) + page(BOTTOM + 3, STACK[2]) + page(BOTTOM, PAGE)
    + `<rect x="${X}" y="${TOP}" width="${W}" height="10" fill="#000" opacity=".05"/>`
    + c.front + questionMark(qScale) + '</g>';
}

const defs = `<defs>
  <radialGradient id="night" cx="50%" cy="25%" r="85%"><stop offset="0" stop-color="#1d4038"/><stop offset=".5" stop-color="#0f211d"/><stop offset="1" stop-color="#060c0b"/></radialGradient>
  <linearGradient id="wire" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a9b74"/><stop offset="1" stop-color="#1f7a5c"/></linearGradient>
</defs>`;

// `tile`: 'rounded' (the app icon), 'square' (maskable), or 'none' (just the pad on
// transparent, for the toolbar and favicon where a starry sky is only noise).
function svg(body, { tile = 'rounded' } = {}) {
  const back = tile === 'rounded' ? `<rect width="128" height="128" rx="28" fill="url(#night)"/>${starField()}`
    : tile === 'square' ? `<rect width="128" height="128" fill="#0f211d"/>${starField()}` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${defs}${back}${body}</svg>\n`;
}

const full = pad({ coilCount: 7, wire: 2.4, qScale: 0.82 });
const small = pad({ coilCount: 4, wire: 3.2, qScale: 0.95 });
// The pad alone, scaled up to fill the frame.
const fill = (art) => `<g transform="translate(64 64) scale(1.34) translate(-64 -66)">${art}</g>`;
const icons = {
  'icon.svg': svg(full),
  'icon-small.svg': svg(small),
  // Maskable: launchers crop into circles/squircles, so keep the art inside the safe zone.
  'icon-maskable.svg': svg(`<g transform="translate(64 64) scale(0.72) translate(-64 -64)">${full}</g>`, { tile: 'square' }),
  'icon-plain.svg': svg(fill(full), { tile: 'none' }),
  'icon-plain-small.svg': svg(fill(small), { tile: 'none' }),
};

mkdirSync(join(root, 'assets'), { recursive: true });
for (const [name, text] of Object.entries(icons)) writeFileSync(join(root, 'assets', name), text);
console.log('assets:', Object.keys(icons).join(', '));

// ---- rasterise -------------------------------------------------------------

const targets = [
  ['icon-plain-small.svg', 16, 'extension/icons/16.png'],
  ['icon-plain-small.svg', 32, 'extension/icons/32.png'],
  ['icon-plain.svg', 48, 'extension/icons/48.png'],
  ['icon-plain.svg', 128, 'extension/icons/128.png'],
  ['icon-plain.svg', 64, 'web/icons/favicon.png'],
  ['icon.svg', 192, 'web/icons/192.png'],
  ['icon.svg', 512, 'web/icons/512.png'],
  ['icon-maskable.svg', 512, 'web/icons/512-maskable.png'],
];

if (!CHROME) {
  console.error('Chrome not found; SVGs written but PNGs not rasterised.');
  process.exit(1);
}

const work = join(tmpdir(), `cp-icons-${process.pid}`);
mkdirSync(work, { recursive: true });
for (const [src, size, out] of targets) {
  const html = join(work, `${size}-${src}.html`);
  writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">${readFileSync(join(root, 'assets', src), 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  const png = join(work, `${size}-${src}.png`);
  execFileSync(CHROME, [
    '--headless=new', '--hide-scrollbars', '--default-background-color=00000000', '--force-device-scale-factor=1',
    `--window-size=${size},${size}`, `--screenshot=${png}`, `file://${html}`,
  ], { stdio: 'ignore' });
  mkdirSync(join(root, dirname(out)), { recursive: true });
  writeFileSync(join(root, out), readFileSync(png));
  console.log(`${out} (${size}px from ${src})`);
}
rmSync(work, { recursive: true, force: true });
