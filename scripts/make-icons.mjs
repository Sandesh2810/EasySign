// npm run icons — makes the installable signer app's icons (D-96) from one drawing, in the AlterMe colours
// (design/alterme-tokens.json: ink #1a1818, cream #fffcf4, periwinkle #7b84dc). Output goes to public/icons and
// src/app/apple-icon.png; the files are committed, so this only needs running again if the drawing changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INK = '#1a1818';
const CREAM = '#fffcf4';
const PERI = '#7b84dc';

/** A signature stroke over a line, on a rounded square; `safe` shrinks it into the maskable safe zone (80%). */
const svg = (size, { rounded = true, safe = false } = {}) => {
  const s = safe ? 0.62 : 0.78;
  const o = (1 - s) / 2;
  const at = (x, y) => `${(o + x * s) * size},${(o + y * s) * size}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${rounded ? size * 0.22 : 0}" fill="${INK}"/>
  <path d="M ${at(0.06, 0.62)} C ${at(0.18, 0.18)} ${at(0.3, 0.1)} ${at(0.32, 0.4)} S ${at(0.26, 0.86)} ${at(0.42, 0.62)} S ${at(0.58, 0.24)} ${at(0.62, 0.46)} S ${at(0.72, 0.74)} ${at(0.94, 0.4)}"
        fill="none" stroke="${CREAM}" stroke-width="${size * 0.055}" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="${(o + 0.06 * s) * size}" y1="${(o + 0.84 * s) * size}" x2="${(o + 0.94 * s) * size}" y2="${(o + 0.84 * s) * size}" stroke="${PERI}" stroke-width="${size * 0.03}" stroke-linecap="round"/>
</svg>`;
};

mkdirSync(path.join(appDir, 'public', 'icons'), { recursive: true });
const out = [
  ['public/icons/icon-192.png', 192, {}],
  ['public/icons/icon-512.png', 512, {}],
  ['public/icons/icon-maskable-512.png', 512, { rounded: false, safe: true }],
  ['src/app/apple-icon.png', 180, { rounded: false }],
];
for (const [file, size, opts] of out) {
  writeFileSync(path.join(appDir, file), await sharp(Buffer.from(svg(size, opts))).png({ compressionLevel: 9 }).toBuffer());
  console.log(`  ${file} (${size} px)`);
}
console.log('Icons made.');
