import { describe, expect, it } from 'vitest';

import {
  buildTestApp,
  TEST_WEB_SERVICE_TOKEN,
  type Seed,
  type TestApp,
} from './helpers/build-test-app.js';

const auth = { authorization: `Bearer ${TEST_WEB_SERVICE_TOKEN}` };
const adminAuth = { ...auth, 'x-admin-actor': 'admin@example.com' };

function get({ app }: TestApp, url: string) {
  return app.inject({ method: 'GET', url, headers: auth });
}

describe('GET /v1/admin/waitlist', () => {
  const fourSubscribers: Seed = (s) => {
    s.seedSubscriber({ email: 'a@example.com' });
    s.seedSubscriber({ email: 'b@example.com', status: 'paused' });
    s.seedSubscriber({ email: 'c@example.com', status: 'unsubscribed' });
    s.seedSubscriber({ email: 'd@example.com' });
  };

  it('returns every subscriber newest first', async () => {
    const response = await get(
      buildTestApp({ seed: fourSubscribers }),
      '/v1/admin/waitlist',
    );

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rows.map((row: { email: string }) => row.email)).toEqual([
      'd@example.com',
      'c@example.com',
      'b@example.com',
      'a@example.com',
    ]);
    expect(body.nextCursor).toBeUndefined();
  });

  it('returns the full row shape', async () => {
    const test = buildTestApp({
      seed: (s) => void s.seedSubscriber({ email: 'a@example.com' }),
    });

    const body = (await get(test, '/v1/admin/waitlist')).json();

    expect(body.rows[0]).toEqual({
      id: 'sub_1',
      email: 'a@example.com',
      source: 'email',
      status: 'subscribed',
      createdAt: test.store.subscribers[0]?.createdAt.toISOString(),
      sentCount: 0,
    });
  });

  it('filters by status', async () => {
    const body = (
      await get(
        buildTestApp({ seed: fourSubscribers }),
        '/v1/admin/waitlist?status=paused',
      )
    ).json();

    expect(body.rows.map((row: { email: string }) => row.email)).toEqual([
      'b@example.com',
    ]);
  });

  it('matches the search term against the email, case-insensitively', async () => {
    const body = (
      await get(
        buildTestApp({ seed: fourSubscribers }),
        '/v1/admin/waitlist?q=B%40EXAMPLE',
      )
    ).json();

    expect(body.rows.map((row: { email: string }) => row.email)).toEqual([
      'b@example.com',
    ]);
  });

  it('treats a whitespace-only search term as no filter', async () => {
    const body = (
      await get(
        buildTestApp({ seed: fourSubscribers }),
        '/v1/admin/waitlist?q=%20%20',
      )
    ).json();

    expect(body.rows).toHaveLength(4);
  });

  it('pages with a cursor, with no overlap and no gap', async () => {
    const test = buildTestApp({ seed: fourSubscribers });

    const first = (await get(test, '/v1/admin/waitlist?limit=2')).json();
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = (
      await get(
        test,
        `/v1/admin/waitlist?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      )
    ).json();

    expect(second.rows).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    const seen = [...first.rows, ...second.rows].map(
      (row: { email: string }) => row.email,
    );
    expect(new Set(seen).size).toBe(4);
  });

  it('reports sentCount from the subscriber delivery rows', async () => {
    const test = buildTestApp({
      seed: (s) => {
        s.seedSubscriber({ email: 'a@example.com' });
        const broadcast = s.seedBroadcast();
        s.seedDelivery(broadcast.id, 'sub_1', 'sent');
        s.seedDelivery(`${broadcast.id}-other`, 'sub_1', 'sent');
        s.seedDelivery(`${broadcast.id}-third`, 'sub_1', 'failed');
        s.seedDelivery(`${broadcast.id}-fourth`, 'sub_1', 'pending');
      },
    });

    const body = (await get(test, '/v1/admin/waitlist')).json();

    expect(body.rows[0].sentCount).toBe(2);
  });

  it('rejects a malformed cursor with 400', async () => {
    const response = await get(
      buildTestApp(),
      '/v1/admin/waitlist?cursor=not-a-cursor!!',
    );

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /v1/admin/waitlist/stats', () => {
  it('counts by status', async () => {
    const test = buildTestApp({
      seed: (s) => {
        for (const email of ['a', 'b', 'c'])
          s.seedSubscriber({ email: `${email}@example.com` });
        for (const email of ['d', 'e'])
          s.seedSubscriber({ email: `${email}@example.com`, status: 'paused' });
        s.seedSubscriber({ email: 'f@example.com', status: 'unsubscribed' });
        s.seedSubscriber({ email: 'g@example.com', status: 'bounced' });
      },
    });

    const response = await get(test, '/v1/admin/waitlist/stats');

    expect(response.json()).toEqual({
      all: 7,
      subscribed: 3,
      paused: 2,
      unsubscribed: 1,
      bounced: 1,
    });
  });

  it('reports zeros for an empty list', async () => {
    // A grouped count returns no row for an
    // absent status, so the zeros have to be
    // filled in.
    const response = await get(buildTestApp(), '/v1/admin/waitlist/stats');

    expect(response.json()).toEqual({
      all: 0,
      subscribed: 0,
      paused: 0,
      unsubscribed: 0,
      bounced: 0,
    });
  });
});

describe('POST /v1/admin/broadcasts', () => {
  const audienceOfFive: Seed = (s) => {
    for (const email of ['a', 'b', 'c'])
      s.seedSubscriber({ email: `${email}@example.com` });
    for (const email of ['d', 'e'])
      s.seedSubscriber({ email: `${email}@example.com`, status: 'paused' });
    s.seedSubscriber({ email: 'f@example.com', status: 'unsubscribed' });
    s.seedSubscriber({ email: 'g@example.com', status: 'bounced' });
  };

  function create(
    test: TestApp,
    body: Record<string, unknown>,
    headers: Record<string, string> = adminAuth,
  ) {
    return test.app.inject({
      method: 'POST',
      url: '/v1/admin/broadcasts',
      headers,
      payload: body,
    });
  }

  const validBody = {
    subject: 'Release notes',
    bodyMarkdown: 'Here is what changed.',
    audience: ['subscribed', 'paused'],
  };

  it('creates the broadcast already sending', async () => {
    // The same request enqueues the send, so
    // a broadcast is never at rest as a draft.
    const test = buildTestApp({ seed: audienceOfFive });

    const response = await create(test, validBody);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: 'bc_1', status: 'sending' });
    expect(test.store.broadcasts[0]?.status).toBe('sending');
  });

  it('stamps startedAt when it creates the broadcast', async () => {
    const test = buildTestApp({ seed: audienceOfFive });

    await create(test, validBody);

    expect(test.store.broadcasts[0]?.startedAt).toBeInstanceOf(Date);
  });

  it('stamps createdBy from the x-admin-actor header', async () => {
    const test = buildTestApp({ seed: audienceOfFive });

    await create(test, validBody);

    expect(test.store.broadcasts[0]?.createdBy).toBe('admin@example.com');
  });

  it('normalises the actor address before stamping createdBy', async () => {
    // One admin has to be one string, or the
    // audit trail cannot be grouped by who
    // sent what.
    const test = buildTestApp({ seed: audienceOfFive });

    await create(test, validBody, {
      ...auth,
      'x-admin-actor': 'Admin@Example.COM',
    });

    expect(test.store.broadcasts[0]?.createdBy).toBe('admin@example.com');
  });

  it('rejects a request with no x-admin-actor', async () => {
    // There is no legal placeholder: the
    // audit trail's createdBy is an email
    // address.
    const test = buildTestApp({ seed: audienceOfFive });

    const response = await create(test, validBody, auth);

    expect(response.statusCode).toBe(400);
    expect(test.store.broadcasts).toHaveLength(0);
  });

  it('creates one pending delivery per audience member', async () => {
    const test = buildTestApp({ seed: audienceOfFive });

    await create(test, validBody);

    expect(test.store.deliveries).toHaveLength(5);
    expect(test.store.deliveries.every((row) => row.status === 'pending')).toBe(
      true,
    );
    expect(test.store.broadcasts[0]?.recipientCount).toBe(5);
  });

  it('filters suppressed statuses out of the audience it stores and snapshots', async () => {
    const test = buildTestApp({ seed: audienceOfFive });

    await create(test, {
      ...validBody,
      audience: ['subscribed', 'unsubscribed', 'bounced'],
    });

    expect(test.store.broadcasts[0]?.audience).toEqual(['subscribed']);
    expect(test.store.deliveries).toHaveLength(3);
  });

  it('400s when the effective audience is empty, and enqueues nothing', async () => {
    const test = buildTestApp({ seed: audienceOfFive });

    const response = await create(test, {
      ...validBody,
      audience: ['unsubscribed', 'bounced'],
    });

    expect(response.statusCode).toBe(400);
    expect(test.store.broadcasts).toHaveLength(0);
    expect(test.enqueuer.calls).toHaveLength(0);
  });

  it('enqueues broadcastSend on queue email with workflowID broadcast:<id>', async () => {
    const test = buildTestApp({ seed: audienceOfFive });

    await create(test, validBody);

    expect(test.enqueuer.calls).toEqual([
      {
        workflowName: 'broadcastSend',
        queueName: 'email',
        workflowID: 'broadcast:bc_1',
        args: { broadcastId: 'bc_1' },
      },
    ]);
  });

  it('enqueues only after the snapshot is persisted', async () => {
    // A durable job pointing at a broadcast
    // that then rolled back would never find
    // its rows.
    const test = buildTestApp({ seed: audienceOfFive });
    const order: string[] = [];
    const realEnqueue = test.enqueuer.enqueue.bind(test.enqueuer);
    test.enqueuer.enqueue = async (request) => {
      order.push(`enqueue:${test.store.writes.length}`);
      return realEnqueue(request);
    };

    await create(test, validBody);

    expect(test.store.writes).toEqual(['broadcast:bc_1']);
    expect(order).toEqual(['enqueue:1']);
  });
});

describe('POST /v1/admin/broadcasts/test', () => {
  const body = {
    subject: 'Release notes',
    bodyMarkdown: 'Here is what changed.',
    to: 'admin@example.com',
  };

  function testSend(test: TestApp, payload: Record<string, unknown>) {
    return test.app.inject({
      method: 'POST',
      url: '/v1/admin/broadcasts/test',
      headers: adminAuth,
      payload,
    });
  }

  it('enqueues broadcastTestSend and returns { enqueued: true }', async () => {
    const test = buildTestApp();

    const response = await testSend(test, {
      ...body,
      teaserImageUrl: 'https://example.com/x.png',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enqueued: true });
    expect(test.enqueuer.calls).toEqual([
      {
        workflowName: 'broadcastTestSend',
        queueName: 'email',
        args: {
          subject: 'Release notes',
          bodyMarkdown: 'Here is what changed.',
          teaserImageUrl: 'https://example.com/x.png',
          to: 'admin@example.com',
        },
      },
    ]);
    expect(test.enqueuer.calls[0]?.workflowID).toBeUndefined();
  });

  it('enqueues again on a second identical call', async () => {
    // An admin who clicks "send me a test"
    // twice wants two emails; idempotency
    // here would be a bug.
    const test = buildTestApp();

    await testSend(test, body);
    await testSend(test, body);

    expect(test.enqueuer.calls).toHaveLength(2);
  });

  it('creates no broadcast and no delivery rows', async () => {
    const test = buildTestApp();

    await testSend(test, body);

    expect(test.store.broadcasts).toHaveLength(0);
    expect(test.store.deliveries).toHaveLength(0);
  });

  it('rejects a malformed recipient with 400', async () => {
    const test = buildTestApp();

    const response = await testSend(test, { ...body, to: 'not-an-email' });

    expect(response.statusCode).toBe(400);
    expect(test.enqueuer.calls).toHaveLength(0);
  });
});

describe('the broadcast list and detail', () => {
  const seedSentBroadcast: Seed = (s) => {
    s.seedSubscriber({ email: 'a@example.com' });
    s.seedSubscriber({ email: 'b@example.com' });
    s.seedSubscriber({ email: 'c@example.com' });
    const broadcast = s.seedBroadcast({ status: 'sent', recipientCount: 3 });
    s.seedDelivery(broadcast.id, 'sub_1', 'sent');
    s.seedDelivery(broadcast.id, 'sub_2', 'failed');
    s.seedDelivery(broadcast.id, 'sub_3', 'skipped');
  };

  it('wraps the list in { rows } with counts derived from the delivery rows', async () => {
    const test = buildTestApp({ seed: seedSentBroadcast });

    const body = (await get(test, '/v1/admin/broadcasts')).json();

    expect(body).toEqual({
      rows: [
        {
          id: 'bc_1',
          subject: 'Subject',
          status: 'sent',
          recipientCount: 3,
          sentCount: 1,
          failedCount: 1,
          createdAt: test.store.broadcasts[0]?.createdAt.toISOString(),
          createdBy: 'admin@example.com',
        },
      ],
    });
  });

  it('returns the detail with all four delivery counts present', async () => {
    const test = buildTestApp({ seed: seedSentBroadcast });

    const body = (await get(test, '/v1/admin/broadcasts/bc_1')).json();

    expect(body).toMatchObject({
      id: 'bc_1',
      subject: 'Subject',
      bodyMarkdown: 'Body',
      audience: ['subscribed'],
      teaserImageUrl: null,
      status: 'sent',
      createdBy: 'admin@example.com',
      recipientCount: 3,
      startedAt: null,
      completedAt: null,
      deliveryCounts: { pending: 0, sent: 1, failed: 1, skipped: 1 },
    });
  });

  it('404s for an unknown broadcast', async () => {
    const response = await get(buildTestApp(), '/v1/admin/broadcasts/bc_404');

    expect(response.statusCode).toBe(404);
  });
});
