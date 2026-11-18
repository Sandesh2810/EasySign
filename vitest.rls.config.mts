import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Security tests against the live development project. Kept out of "npm test" because they need
// the network and the Supabase secret key. Run with: npm run test:rls
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['tests/rls/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
