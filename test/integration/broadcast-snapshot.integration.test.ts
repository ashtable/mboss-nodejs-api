import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { SubscriberStatus } from '@mboss/zod';

import {
  buildIntegrationApp,
  createPrisma,
  databaseUrl,
  reset,
  webAuth,
} from './helpers/db.js';

/**
 * A client whose delivery insert fails
 * once the transaction is already open.
 * Wrapping the transaction client from
 * outside keeps the production interface
 * free of a test-only seam, and it also
 * means the test notices if the snapshot
 * ever stops being one transaction:
 * without `$transaction` the
 * substitution never happens and
 * nothing throws.
 */
function failingDeliveryInsert(prisma: PrismaClient): PrismaClient {
  const transaction = (
    callback: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> =>
    prisma.$transaction((tx) =>
      callback(
        new Proxy(tx, {
          get: (target, property) =>
            property === 'broadcastDelivery'
              ? {
                  createMany: () =>
                    Promise.reject(new Error('delivery insert failed')),
                }
              : Reflect.get(target, property),
        }),
      ),
    );

  return new Proxy(prisma, {
    get: (target, property) =>
      property === '$transaction' ? transaction : Reflect.get(target, property),
  });
}

describe.skipIf(!databaseUrl)('broadcast snapshot (real Postgres)', () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma ??= createPrisma();
    await reset(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function seedSubscribers(
    counts: Partial<Record<SubscriberStatus, number>>,
  ): Promise<void> {
    const data = Object.entries(counts).flatMap(([status, count]) =>
      Array.from({ length: count }, (_unused, index) => ({
        email: `${status}-${index}@example.com`,
        status: status as SubscriberStatus,
      })),
    );
    await prisma.subscriber.createMany({ data });
  }

  function createBroadcast(
    app: ReturnType<typeof buildIntegrationApp>['app'],
    audience: string[],
  ) {
    return app.inject({
      method: 'POST',
      url: '/v1/admin/broadcasts',
      headers: webAuth,
      payload: {
        subject: 'Release notes',
        bodyMarkdown: 'What changed.',
        audience,
      },
    });
  }

  it('inserts exactly one pending delivery per audience member', async () => {
    await seedSubscribers({ subscribed: 3, paused: 2 });
    const { app } = buildIntegrationApp(prisma);

    const response = await createBroadcast(app, ['subscribed', 'paused']);

    expect(response.statusCode).toBe(200);
    const deliveries = await prisma.broadcastDelivery.findMany();
    expect(deliveries).toHaveLength(5);
    expect(deliveries.every((row) => row.status === 'pending')).toBe(true);
  });

  it('sets recipientCount to the number of rows actually inserted', async () => {
    await seedSubscribers({ subscribed: 3, paused: 2 });
    const { app } = buildIntegrationApp(prisma);

    const { id } = (
      await createBroadcast(app, ['subscribed', 'paused'])
    ).json();

    const broadcast = await prisma.broadcast.findUniqueOrThrow({
      where: { id },
    });
    expect(broadcast.recipientCount).toBe(
      await prisma.broadcastDelivery.count({ where: { broadcastId: id } }),
    );
    expect(broadcast.recipientCount).toBe(5);
  });

  it('writes the broadcast as sending with startedAt set, in the creating transaction', async () => {
    await seedSubscribers({ subscribed: 1 });
    const { app } = buildIntegrationApp(prisma);

    const response = await createBroadcast(app, ['subscribed']);

    expect(response.json()).toMatchObject({ status: 'sending' });
    const broadcast = await prisma.broadcast.findUniqueOrThrow({
      where: { id: response.json().id },
    });
    expect(broadcast.status).toBe('sending');
    expect(broadcast.startedAt).not.toBeNull();
  });

  it('excludes unsubscribed and bounced members even when they are in the table', async () => {
    await seedSubscribers({
      subscribed: 2,
      paused: 1,
      unsubscribed: 4,
      bounced: 3,
    });
    const { app } = buildIntegrationApp(prisma);

    const { id } = (
      await createBroadcast(app, ['subscribed', 'paused'])
    ).json();

    const deliveries = await prisma.broadcastDelivery.findMany({
      where: { broadcastId: id },
      include: { subscriber: true },
    });
    expect(deliveries).toHaveLength(3);
    expect(deliveries.map((row) => row.subscriber.status).sort()).toEqual([
      'paused',
      'subscribed',
      'subscribed',
    ]);
  });

  it('rolls back the broadcast entirely when a delivery insert fails', async () => {
    await seedSubscribers({ subscribed: 2 });
    const { store } = buildIntegrationApp(failingDeliveryInsert(prisma));

    await expect(
      store.createBroadcastWithSnapshot({
        subject: 'Doomed',
        bodyMarkdown: 'Never sent.',
        audience: ['subscribed'],
        teaserImageUrl: null,
        createdBy: 'admin@example.com',
      }),
    ).rejects.toThrow('delivery insert failed');

    // The broadcast row is written before
    // the deliveries, so its absence is
    // the rollback.
    expect(await prisma.broadcast.count()).toBe(0);
    expect(await prisma.broadcastDelivery.count()).toBe(0);
  });

  it('rejects a duplicate delivery for the same recipient', async () => {
    await seedSubscribers({ subscribed: 1 });
    const subscriber = await prisma.subscriber.findFirstOrThrow();
    const broadcast = await prisma.broadcast.create({
      data: {
        subject: 'Release notes',
        bodyMarkdown: 'What changed.',
        audience: ['subscribed'],
        createdBy: 'admin@example.com',
      },
    });
    await prisma.broadcastDelivery.create({
      data: { broadcastId: broadcast.id, subscriberId: subscriber.id },
    });

    await expect(
      prisma.broadcastDelivery.create({
        data: { broadcastId: broadcast.id, subscriberId: subscriber.id },
      }),
    ).rejects.toThrow();
  });
});
