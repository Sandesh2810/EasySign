// AlterMe token contrast check (WCAG 2.x relative-luminance contrast).
// Run from cmd:  node app\design\contrast-check.mjs
// Reads colour values from alterme-tokens.json next to this file.
// ALLOWED pairs are the foreground/background combinations EasySign may use: any failure exits 1.
// FORBIDDEN pairs are listed only to document why a combination is banned; they never affect the exit code.
// Import { ratio, blend } from this file without side effects (the table prints only when run directly).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

const rgb = (h) => {
  let s = h.replace('#', '');
  if (s.length === 3) s = [...s].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const alpha = (h) => {
  const s = h.replace('#', '');
  return s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
};
const toHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
// Composite a (possibly translucent) colour over an opaque background.
export const blend = (fg, bg) => {
  const a = alpha(fg);
  const f = rgb(fg);
  const b = rgb(bg);
  return toHex(f.map((v, i) => v * a + b[i] * (1 - a)));
};
const lum = (h) => {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (fg, bg) => {
  const [hi, lo] = [lum(blend(fg, bg)), lum(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function main() {
  const t = JSON.parse(readFileSync(path.join(here, 'alterme-tokens.json'), 'utf8'));
  const acc = t.color.accent;
  const add = t.easysign.added;
  const L = { ...acc, ...t.color.light, controlBorder: add['control-border-light'].value };
  const D = { ...acc, ...t.color.light, ...t.color.dark, controlBorder: add['control-border-dark'].value };
  const washL = (bg) => blend(L['periwinkle-wash'], bg);
  const washD = (bg) => blend(D['periwinkle-wash'], bg);

  // [label, fg, bg, threshold]  — 4.5 normal text, 3 large text / UI components
  const allowed = [
    ['L ink on surface', L.ink, L.surface, 4.5],
    ['L ink on sand', L.ink, L['surface-sand'], 4.5],
    ['L ink on linen', L.ink, L['surface-linen'], 4.5],
    ['L body on surface', L['ink-body'], L.surface, 4.5],
    ['L body on sand', L['ink-body'], L['surface-sand'], 4.5],
    ['L body on linen', L['ink-body'], L['surface-linen'], 4.5],
    ['L muted on surface', L['ink-muted'], L.surface, 4.5],
    ['L muted on sand', L['ink-muted'], L['surface-sand'], 4.5],
    ['L muted on linen', L['ink-muted'], L['surface-linen'], 4.5],
    ['L muted on lavender', L['ink-muted'], L['surface-lavender'], 4.5],
    ['L periwinkle-ink on surface (links)', L['periwinkle-ink'], L.surface, 4.5],
    ['L periwinkle-ink on sand', L['periwinkle-ink'], L['surface-sand'], 4.5],
    ['L periwinkle-ink on lavender', L['periwinkle-ink'], L['surface-lavender'], 4.5],
    ['L chip: periwinkle-ink on wash over surface', L['periwinkle-ink'], washL(L.surface), 4.5],
    ['L chip: periwinkle-ink on wash over sand', L['periwinkle-ink'], washL(L['surface-sand']), 4.5],
    ['L periwinkle as UI/large on surface', L.periwinkle, L.surface, 3],
    ['L ink on periwinkle (button label)', L['on-periwinkle'], L.periwinkle, 4.5],
    ['L white on periwinkle-ink (solid button)', '#ffffff', L['periwinkle-ink'], 4.5],
    ['L cream on ink (primary button)', L.cream, L.ink, 4.5],
    ['L ink on cream (primary button on dark band)', L.ink, L.cream, 4.5],
    ['L cream on night', L.cream, L.night, 4.5],
    ['L cream-muted on night', L['cream-muted'], L.night, 4.5],
    ['L cream on indigo-deep', L.cream, L['indigo-deep'], 4.5],
    ['L focus ring on surface', L.focus, L.surface, 3],
    ['L focus ring on sand', L.focus, L['surface-sand'], 3],
    ['L focus ring on linen', L.focus, L['surface-linen'], 3],
    ['L success text on surface', L['trait-typical'], L.surface, 4.5],
    ['L warning text on surface', L['trait-above'], L.surface, 4.5],
    ['L danger text on surface', L['trait-high'], L.surface, 4.5],
    ['L danger text on sand', L['trait-high'], L['surface-sand'], 4.5],
    ['L white on danger (destructive button)', '#ffffff', L['trait-high'], 4.5],
    ['L ink on sage (status chip)', L.ink, L.sage, 4.5],
    ['L ink on mint (status chip)', L.ink, L.mint, 4.5],
    ['L ink on amber (status chip)', L.ink, L.amber, 4.5],
    ['L control-border on surface (ADDED)', L.controlBorder, L.surface, 3],
    ['L control-border on sand (ADDED)', L.controlBorder, L['surface-sand'], 3],
    ['D ink on surface', D.ink, D.surface, 4.5],
    ['D ink on raised', D.ink, D['surface-raised'], 4.5],
    ['D body on surface', D['ink-body'], D.surface, 4.5],
    ['D body on raised', D['ink-body'], D['surface-raised'], 4.5],
    ['D body on linen', D['ink-body'], D['surface-linen'], 4.5],
    ['D muted on surface', D['ink-muted'], D.surface, 4.5],
    ['D muted on sand', D['ink-muted'], D['surface-sand'], 4.5],
    ['D muted on raised', D['ink-muted'], D['surface-raised'], 4.5],
    ['D muted on linen', D['ink-muted'], D['surface-linen'], 4.5],
    ['D periwinkle-ink on surface (links)', D['periwinkle-ink'], D.surface, 4.5],
    ['D periwinkle-ink on lavender', D['periwinkle-ink'], D['surface-lavender'], 4.5],
    ['D chip: periwinkle-ink on wash over surface', D['periwinkle-ink'], washD(D.surface), 4.5],
    ['D chip: periwinkle-ink on wash over raised', D['periwinkle-ink'], washD(D['surface-raised']), 4.5],
    ['D periwinkle as UI on surface', D.periwinkle, D.surface, 3],
    ['D dark ink on periwinkle (button label)', L.ink, D.periwinkle, 4.5],
    ['D focus ring on surface', D.focus, D.surface, 3],
    ['D focus ring on raised', D.focus, D['surface-raised'], 3],
    ['D success text on surface', D['trait-typical'], D.surface, 4.5],
    ['D warning text on surface', D['trait-above'], D.surface, 4.5],
    ['D danger text on surface', D['trait-high'], D.surface, 4.5],
    ['D danger text on raised', D['trait-high'], D['surface-raised'], 4.5],
    ['D control-border on surface (ADDED)', D.controlBorder, D.surface, 3],
    ['D control-border on raised (ADDED)', D.controlBorder, D['surface-raised'], 3],
  ];

  // Documented bans: these are expected to be below threshold.
  const forbidden = [
    ['L periwinkle as normal text on surface', L.periwinkle, L.surface, 4.5],
    ['L white on periwinkle fill', '#ffffff', L.periwinkle, 4.5],
    ['L periwinkle-ink on periwinkle-soft', L['periwinkle-ink'], L['periwinkle-soft'], 4.5],
    ['D periwinkle-ink on periwinkle-soft', D['periwinkle-ink'], D['periwinkle-soft'], 4.5],
    ['L hairline as control border on surface', L.hairline, L.surface, 3],
    ['L hairline as control border on sand', L.hairline, L['surface-sand'], 3],
    ['D hairline as control border on surface', D.hairline, D.surface, 3],
    ['L control-border on linen (use ink-muted there)', L.controlBorder, L['surface-linen'], 3],
    ['L rust as text on surface', L.rust, L.surface, 4.5],
    ['L white on rust', '#ffffff', L.rust, 4.5],
    ['L amber as text on surface', L.amber, L.surface, 4.5],
  ];

  let fails = 0;
  const row = (label, r, need, verdict) => console.log(label.padEnd(50) + r.toFixed(2).padEnd(8) + String(need).padEnd(6) + verdict);
  console.log('ALLOWED PAIRS'.padEnd(50) + 'RATIO'.padEnd(8) + 'NEED'.padEnd(6) + 'RESULT');
  for (const [label, fg, bg, need] of allowed) {
    const r = ratio(fg, bg);
    if (r < need) fails++;
    row(label, r, need, r >= need ? 'PASS' : 'FAIL');
  }
  console.log('\nFORBIDDEN PAIRS (documented bans; not counted)');
  for (const [label, fg, bg, need] of forbidden) {
    const r = ratio(fg, bg);
    row(label, r, need, r >= need ? 'passes - ban could be lifted' : 'below threshold - banned');
  }
  console.log(`\n${allowed.length} allowed pairs checked, ${fails} failing. ${forbidden.length} banned pairs listed.`);
  process.exitCode = fails ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
