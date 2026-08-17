import { configDefaults, defineConfig } from 'vitest/config';

import { aliases } from './vitest.aliases.js';

/**
 * The default suite is hermetic: it reaches neither a database nor the network, so CI can run it
 * with nothing but a checkout. The integration suite has its own config and its own command.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
  resolve: { alias: aliases },
});
