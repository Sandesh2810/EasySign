// Copies the pdf.js worker and its standard fonts into public/pdfjs so the browser loads them from
// this app (no third-party hosts). Runs automatically before "dev" and "build".
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'pdfjs-dist');
const dest = path.join(root, 'public', 'pdfjs');
if (!existsSync(src)) {
  console.error('pdfjs-dist is not installed. Run: npm install');
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(path.join(src, 'build', 'pdf.worker.min.mjs'), path.join(dest, 'pdf.worker.min.mjs'));
cpSync(path.join(src, 'standard_fonts'), path.join(dest, 'standard_fonts'), { recursive: true });
console.log('pdf.js assets copied to public/pdfjs');
