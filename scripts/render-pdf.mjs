// Render PDF pages to PNG so sealed output can be looked at (visual check of stamps, footer, certificate).
// Usage: node scripts/render-pdf.mjs <file.pdf> <outDir> [scale=1.5]
// Uses pdf.js (the same engine as the in-browser viewer) with its optional Node canvas.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [file, outDir, scaleArg] = process.argv.slice(2);
if (!file || !outDir) {
  console.error('Usage: node scripts/render-pdf.mjs <file.pdf> <outDir> [scale]');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const asUrl = (p) => pathToFileURL(path.join(root, 'node_modules', 'pdfjs-dist', p)).href + '/';

const task = pdfjs.getDocument({
  data: new Uint8Array(readFileSync(file)),
  standardFontDataUrl: asUrl('standard_fonts'),
  cMapUrl: asUrl('cmaps'),
  cMapPacked: true,
  verbosity: 0,
});
const doc = await task.promise;
mkdirSync(outDir, { recursive: true });
const base = path.basename(file, '.pdf');
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const viewport = page.getViewport({ scale: Number(scaleArg ?? 1.5) });
  const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const out = path.join(outDir, `${base}-p${i}.png`);
  writeFileSync(out, canvas.toBuffer('image/png'));
  console.log(`${out}  ${Math.ceil(viewport.width)}x${Math.ceil(viewport.height)}`);
}
await task.destroy();
