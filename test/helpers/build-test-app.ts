import type { FastifyInstance } from 'fastify';

import { parseKeyRing, type LinkKeyRing } from '@mboss/core/signed-links';

import { buildApp } from '../../src/app.js';
import { FakeEnqueuer } from '../fakes/fake-enqueuer.js';
import { FakeStore } from '../fakes/fake-store.js';

/**
 * A fixed ring so a test can mint a
 * token the app under test will accept.
 */
export const TEST_LINK_KEYS = `k1:${'11'.repeat(32)}`;
export const TEST_WEB_SERVICE_TOKEN = 'test-web-service-token';
export const TEST_INTERNAL_API_TOKEN = 'test-internal-api-token';

/**
 * The built app, plus the doubles and
 * key ring a test needs to drive it.
 */
export interface TestApp {
  app: FastifyInstance;
  store: FakeStore;
  enqueuer: FakeEnqueuer;
  keyRing: LinkKeyRing;
}

/**
 * Seeds a `FakeStore` before the
 * app is built from it.
 */
export type Seed = (store: FakeStore) => void;

/** Options for building a test app. */
export interface TestAppOptions {
  /** Seeds fixtures before the app is built. */
  seed?: Seed;
  /**
   * A fixed instant, for the routes
   * whose behaviour depends on how
   * long ago something happened.
   */
  now?: Date;
}

/**
 * Builds a Fastify app wired to fake
 * doubles, ready for a test to inject
 * requests into.
 */
export function buildTestApp(options: TestAppOptions = {}): TestApp {
  const store = new FakeStore();
  const enqueuer = new FakeEnqueuer();
  const keyRing = parseKeyRing(TEST_LINK_KEYS);

  options.seed?.(store);

  const fixedNow = options.now;
  const app = buildApp({
    store,
    enqueuer,
    keyRing,
    webServiceToken: TEST_WEB_SERVICE_TOKEN,
    internalApiToken: TEST_INTERNAL_API_TOKEN,
    ...(fixedNow ? { now: () => fixedNow } : {}),
  });

  return { app, store, enqueuer, keyRing };
}
