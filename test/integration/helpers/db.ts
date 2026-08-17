import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { parseKeyRing } from '@mboss/core/signed-links';

import { buildApp } from '../../../src/app.js';
import { PrismaStore } from '../../../src/store/prisma-store.js';
import { FakeEnqueuer } from '../../fakes/fake-enqueuer.js';
import {
  TEST_INTERNAL_API_TOKEN,
  TEST_LINK_KEYS,
  TEST_WEB_SERVICE_TOKEN,
} from '../../helpers/build-test-app.js';

/**
 * Absent without a `DATABASE_URL`, which
 * is how every file in this directory
 * skips cleanly rather than failing.
 * These tests are a developer's local
 * command; CI never reaches a database.
 */
export const databaseUrl = process.env['DATABASE_URL'];

/**
 * A Postgres-backed client for the
 * real schema.
 */
export function createPrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
}

/**
 * Deliveries first — they reference
 * both other tables.
 */
export async function reset(prisma: PrismaClient): Promise<void> {
  await prisma.broadcastDelivery.deleteMany();
  await prisma.broadcast.deleteMany();
  await prisma.subscriber.deleteMany();
}

/**
 * The app plus the real store and
 * doubles that built it.
 */
export interface IntegrationApp {
  app: FastifyInstance;
  store: PrismaStore;
  enqueuer: FakeEnqueuer;
}

/**
 * The real store behind the real
 * handlers. Going through the routes
 * rather than calling store methods
 * directly is what makes a divergence
 * between the in-memory double and
 * Postgres show up here as a
 * route-level failure instead of hiding
 * until production.
 */
export function buildIntegrationApp(
  prisma: PrismaClient,
  now?: Date,
): IntegrationApp {
  const store = new PrismaStore(prisma);
  const enqueuer = new FakeEnqueuer();

  const app = buildApp({
    store,
    enqueuer,
    keyRing: parseKeyRing(TEST_LINK_KEYS),
    webServiceToken: TEST_WEB_SERVICE_TOKEN,
    internalApiToken: TEST_INTERNAL_API_TOKEN,
    ...(now ? { now: () => now } : {}),
  });

  return { app, store, enqueuer };
}

export const webAuth = {
  authorization: `Bearer ${TEST_WEB_SERVICE_TOKEN}`,
  'x-admin-actor': 'admin@example.com',
};

export const internalAuth = {
  authorization: `Bearer ${TEST_INTERNAL_API_TOKEN}`,
};
