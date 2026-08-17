import type { FastifyInstance } from 'fastify';

import { parseKeyRing } from '@mboss/core/signed-links';

import { buildApp } from '../../src/app.js';

/** A fixed ring so a test can mint a token the app under test will accept. */
export const TEST_LINK_KEYS = `k1:${'11'.repeat(32)}`;
export const TEST_WEB_SERVICE_TOKEN = 'test-web-service-token';
export const TEST_INTERNAL_API_TOKEN = 'test-internal-api-token';

export interface TestApp {
  app: FastifyInstance;
}

export function buildTestApp(): TestApp {
  const app = buildApp({
    keyRing: parseKeyRing(TEST_LINK_KEYS),
    webServiceToken: TEST_WEB_SERVICE_TOKEN,
    internalApiToken: TEST_INTERNAL_API_TOKEN,
  });

  return { app };
}
