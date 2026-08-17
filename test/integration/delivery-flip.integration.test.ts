import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildIntegrationApp,
  createPrisma,
  databaseUrl,
  internalAuth,
  reset,
} from './helpers/db.js';

describe.skipIf(!databaseUrl)(
  'delivery flips and bounces (real Postgres)',
  () => {
    let prisma: PrismaClient;

    beforeEach(async () => {
      prisma ??= createPrisma();
      await reset(prisma);
    });

    afterAll(async () => {
      await prisma?.$disconnect();
    });

    async function seedPendingDelivery(): Promise<{
      broadcastId: string;
      subscriberId: string;
    }> {
      const subscriber = await prisma.subscriber.create({
        data: { email: 'member@example.com', status: 'subscribed' },
      });
      const broadcast = await prisma.broadcast.create({
        data: {
          subject: 'Release notes',
          bodyMarkdown: 'What changed.',
          audience: ['subscribed'],
          createdBy: 'admin@example.com',
          status: 'sending',
        },
      });
      await prisma.broadcastDelivery.create({
        data: { broadcastId: broadcast.id, subscriberId: subscriber.id },
      });
      return { broadcastId: broadcast.id, subscriberId: subscriber.id };
    }

    it('leaves one terminal state when the same pending row is flipped concurrently', async () => {
      const { broadcastId, subscriberId } = await seedPendingDelivery();
      const { store } = buildIntegrationApp(prisma);

      const results = await Promise.all(
        Array.from({ length: 8 }, (_unused, index) =>
          store.flipDelivery(
            broadcastId,
            subscriberId,
            index % 2 === 0 ? 'sent' : 'failed',
            undefined,
          ),
        ),
      );

      // Every caller sees the same answer, and
      // it is whatever the one winning UPDATE
      // wrote.
      const row = await prisma.broadcastDelivery.findFirstOrThrow();
      expect(row.status).not.toBe('pending');
      expect(new Set(results)).toEqual(new Set([row.status]));
    });

    it('changes nothing when the row has already left pending', async () => {
      const { broadcastId, subscriberId } = await seedPendingDelivery();
      const { app } = buildIntegrationApp(prisma);

      const flip = (status: string, error?: string) =>
        app.inject({
          method: 'POST',
          url: `/internal/v1/broadcasts/${broadcastId}/deliveries`,
          headers: internalAuth,
          payload: {
            subscriberId,
            status,
            ...(error === undefined ? {} : { error }),
          },
        });

      expect((await flip('sent')).json()).toEqual({ status: 'sent' });
      expect((await flip('failed', 'too late')).json()).toEqual({
        status: 'sent',
      });

      const row = await prisma.broadcastDelivery.findFirstOrThrow();
      expect(row.status).toBe('sent');
      expect(row.error).toBeNull();
    });

    it('bumps tokenVersion exactly once across repeated bounce batches', async () => {
      await prisma.subscriber.create({ data: { email: 'member@example.com' } });
      const { app } = buildIntegrationApp(prisma);

      const batch = () =>
        app.inject({
          method: 'POST',
          url: '/internal/v1/email-events',
          headers: internalAuth,
          payload: [
            {
              email: 'member@example.com',
              event: 'bounce',
              timestamp: 1_785_542_400,
            },
          ],
        });

      expect((await batch()).json()).toEqual({ processed: 1, bounced: 1 });
      expect((await batch()).json()).toEqual({ processed: 1, bounced: 0 });
      expect((await batch()).json()).toEqual({ processed: 1, bounced: 0 });

      const subscriber = await prisma.subscriber.findFirstOrThrow();
      expect(subscriber.status).toBe('bounced');
      expect(subscriber.tokenVersion).toBe(2);
      expect(subscriber.bouncedAt).not.toBeNull();
    });

    it('returns the same subscriber to concurrent signups for one address', async () => {
      const { store } = buildIntegrationApp(prisma);

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          store.findOrCreateSubscriber('racy@example.com'),
        ),
      );

      expect(new Set(results.map((result) => result.subscriber.id)).size).toBe(
        1,
      );
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(await prisma.subscriber.count()).toBe(1);
    });
  },
);
