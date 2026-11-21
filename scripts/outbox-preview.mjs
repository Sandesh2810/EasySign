// npm run outbox:preview -- <outbox row id> [--json] [--show-links]
// Shows what the worker would email for one queued or held outbox row (to, subject, text), built by the worker's own
// code from live data. Sends nothing, changes nothing, uses none of the daily email allowance (D-84).
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const id = process.argv[2];
const asJson = process.argv.includes('--json');
if (!/^[0-9a-f-]{36}$/i.test(id ?? '')) {
  console.error('Usage: npm run outbox:preview -- <outbox row id> [--json]');
  process.exit(2);
}
const src = path.join(root, 'src');
const out = path.join(root, 'dist', 'outbox-preview.mjs');
mkdirSync(path.dirname(out), { recursive: true });
const bundle = await rolldown({
  input: path.join(src, 'worker', 'preview.ts'),
  platform: 'node',
  resolve: { alias: { '@': src, 'server-only': path.join(root, 'scripts', 'empty-module.mjs') } },
  external: (x) => x !== 'server-only' && !x.startsWith('@/') && !x.startsWith('.') && !path.isAbsolute(x),
  logLevel: 'warn',
});
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { previewOutboxRow } = await import(pathToFileURL(out).href);
try {
  const raw = await previewOutboxRow(id);
  // a signing link works like a key: hidden unless asked for
  const hide = (s) => (process.argv.includes('--show-links') ? s : s.replace(/\/s#[A-Za-z0-9_-]+/g, '/s#[link hidden: add --show-links]'));
  const p = { ...raw, text: hide(raw.text) };
  if (asJson) console.log(JSON.stringify(p));
  else console.log(`To: ${p.to}\nSubject: ${p.subject}\n\n${p.text}`);
} catch (e) {
  console.error(`Preview failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
