// Bundles src/worker/main.ts into dist/worker.mjs so the worker can run as its own Node process
// (it shares code with the web app: "@/..." imports and TypeScript). Packages from node_modules are
// left as imports and loaded at run time. "server-only" is a Next.js build-time guard with no meaning
// outside Next, so it is replaced with an empty module here.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');

let bundle;
try {
  bundle = await rolldown({
    input: path.join(src, 'worker', 'main.ts'),
    platform: 'node',
    resolve: { alias: { '@': src, 'server-only': path.join(root, 'scripts', 'empty-module.mjs') } },
    external: (id) => id !== 'server-only' && !id.startsWith('@/') && !id.startsWith('.') && !path.isAbsolute(id),
    logLevel: 'warn',
  });
  await bundle.write({ file: path.join(root, 'dist', 'worker.mjs'), format: 'esm' });
} catch (e) {
  console.error('Worker build failed:', e);
  process.exitCode = 1;
} finally {
  await bundle?.close();
}
