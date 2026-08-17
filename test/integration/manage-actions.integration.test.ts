import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { mintLink, parseKeyRing } from '@mboss/core/signed-links';

import { TEST_LINK_KEYS } from '../helpers/build-test-app.js';
import { buildIntegrationApp, createPrisma, databaseUrl, reset, webAuth } from './helpers/db.js';

/** `iat` must be a whole number of seconds or `mintLink` throws, by design. */
const IAT = Math.floor(Date.UTC(2026, 7, 16) / 1000);

/**
 * The manage actions are the one write path whose whole effect at the database level is the
 * `pausedAt` / `unsubscribedAt` columns, and those columns never reach the wire — so no response
 * body and no in-memory double can show what they hold. Only a real row can.
 */
describe.skipIf(!databaseUrl)('manage actions (real Postgres)', () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma ??= createPrisma();
    await reset(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('leaves exactly one timestamp set — the one naming the state the subscriber is now in', async () => {
    const subscriber = await prisma.subscriber.create({ data: { email: 'member@example.com' } });
    const { app } = buildIntegrationApp(prisma);
    const token = mintLink(parseKeyRing(TEST_LINK_KEYS), {
      t: 'wl.manage',
      sub: subscriber.id,
      tv: subscriber.tokenVersion,
      iat: IAT,
    });

    const act = (action: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/waitlist/manage/${token}/${action}`,
        headers: webAuth,
      });
    const row = () => prisma.subscriber.findUniqueOrThrow({ where: { id: subscriber.id } });

    expect((await act('pause')).json()).toEqual({ status: 'paused' });
    const paused = await row();
    expect(paused.status).toBe('paused');
    expect(paused.pausedAt).not.toBeNull();
    expect(paused.unsubscribedAt).toBeNull();

    // Unsubscribing takes the pause timestamp with it: these columns say where the subscriber is
    // now, not everywhere they have been.
    expect((await act('unsubscribe')).json()).toEqual({ status: 'unsubscribed' });
    const unsubscribed = await row();
    expect(unsubscribed.status).toBe('unsubscribed');
    expect(unsubscribed.unsubscribedAt).not.toBeNull();
    expect(unsubscribed.pausedAt).toBeNull();

    expect((await act('resume')).json()).toEqual({ status: 'subscribed' });
    const resumed = await row();
    expect(resumed.status).toBe('subscribed');
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.unsubscribedAt).toBeNull();

    // Three status writes and the manage link still works: only a bounce revokes links.
    expect(resumed.tokenVersion).toBe(subscriber.tokenVersion);
  });
});
