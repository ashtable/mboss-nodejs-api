import { defineConfig } from 'vitest/config';

import { aliases } from './vitest.aliases.js';

/**
 * The local-only suite. It needs a real Postgres because what it proves — one transaction, a
 * rollback, a unique constraint, a conditional UPDATE under concurrency — is not a claim an
 * in-memory double can make. Never run in CI.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.integration.test.ts'],
    // Real Postgres, shared tables — one file at a time, no parallel truncation races.
    fileParallelism: false,
  },
  resolve: { alias: aliases },
});
