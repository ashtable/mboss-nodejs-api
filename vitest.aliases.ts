import { fileURLToPath } from 'node:url';

/**
 * Vitest resolves neither tsconfig `paths` nor a package `main` field, so the two submodule
 * aliases are restated here. Keep in lockstep with tsconfig.json's `paths`.
 */
export const aliases = {
  '@mboss/zod': fileURLToPath(new URL('./mboss-zod/src/index.ts', import.meta.url)),
  '@mboss/core/signed-links': fileURLToPath(
    new URL('./mboss-core/src/signed-links/index.ts', import.meta.url),
  ),
};
