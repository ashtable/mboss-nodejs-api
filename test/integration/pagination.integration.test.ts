import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { RECIPIENTS_PAGE_SIZE } from '../../src/routes/internal.js';
import {
  buildIntegrationApp,
  createPrisma,
  databaseUrl,
  internalAuth,
  reset,
  webAuth,
} from './helpers/db.js';

describe.skipIf(!databaseUrl)('keyset pagination (real Postgres)', () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma ??= createPrisma();
    await reset(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('covers every pending recipient exactly once', async () => {
    const total = RECIPIENTS_PAGE_SIZE + 25;
    const broadcast = await prisma.broadcast.create({
      data: {
        subject: 'Release notes',
        bodyMarkdown: 'What changed.',
        audience: ['subscribed'],
        createdBy: 'admin@example.com',
        status: 'sending',
      },
    });
    for (let index = 0; index < total; index += 1) {
      const subscriber = await prisma.subscriber.create({
        data: { email: `member-${index}@example.com` },
      });
      await prisma.broadcastDelivery.create({
        data: { broadcastId: broadcast.id, subscriberId: subscriber.id },
      });
    }

    const { app } = buildIntegrationApp(prisma);
    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const url = `/internal/v1/broadcasts/${broadcast.id}/recipients${
        cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
      }`;
      const body = (
        await app.inject({ method: 'GET', url, headers: internalAuth })
      ).json();
      seen.push(
        ...body.rows.map((row: { subscriberId: string }) => row.subscriberId),
      );
      cursor = body.nextCursor;
    } while (cursor !== undefined);

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('matches the search term case-insensitively, as the in-memory double claims', async () => {
    // Postgres compares case-sensitively by
    // default. The double lowercases both sides,
    // so this is where the two are checked to
    // agree rather than merely to both pass
    // their own suites.
    await prisma.subscriber.createMany({
      data: [
        { email: 'someone@example.com' },
        { email: 'nobody@elsewhere.test', status: 'paused' },
      ],
    });
    const { app } = buildIntegrationApp(prisma);

    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/admin/waitlist?q=SOMEONE%40EXAMPLE',
        headers: webAuth,
      })
    ).json();

    expect(body.rows.map((row: { email: string }) => row.email)).toEqual([
      'someone@example.com',
    ]);
  });

  it('does not skip subscribers that share a createdAt', async () => {
    // createdAt alone is not a total order,
    // which is why the cursor carries the id
    // as well.
    const createdAt = new Date('2026-08-16T00:00:00.000Z');
    const total = 10;
    await prisma.subscriber.createMany({
      data: Array.from({ length: total }, (_unused, index) => ({
        email: `member-${index}@example.com`,
        createdAt,
      })),
    });

    const { app } = buildIntegrationApp(prisma);
    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const url = `/v1/admin/waitlist?limit=3${
        cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`
      }`;
      const body = (
        await app.inject({ method: 'GET', url, headers: webAuth })
      ).json();
      seen.push(...body.rows.map((row: { id: string }) => row.id));
      cursor = body.nextCursor;
    } while (cursor !== undefined);

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });
});
