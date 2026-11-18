import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Tests that talk to the RUNNING app over HTTP (and to the development database). Kept out of
// "npm test": they need the app started first and the Supabase secret key. Run with: npm run test:api
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['tests/api/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
