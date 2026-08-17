import { describe, expect, it } from 'vitest';

import { RECIPIENTS_PAGE_SIZE } from '../src/routes/internal.js';
import {
  buildTestApp,
  TEST_INTERNAL_API_TOKEN,
  TEST_WEB_SERVICE_TOKEN,
  type Seed,
  type TestApp,
} from './helpers/build-test-app.js';

const auth = { authorization: `Bearer ${TEST_INTERNAL_API_TOKEN}` };

function get({ app }: TestApp, url: string) {
  return app.inject({ method: 'GET', url, headers: auth });
}

function post({ app }: TestApp, url: string, payload: object = {}) {
  return app.inject({ method: 'POST', url, headers: auth, payload });
}

describe('GET /internal/v1/subscribers/:id', () => {
  it('returns the internal subscriber shape', async () => {
    const test = buildTestApp({ seed: (s) => void s.seedSubscriber({ email: 'a@example.com' }) });

    const response = await get(test, '/internal/v1/subscribers/sub_1');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: 'sub_1',
      email: 'a@example.com',
      status: 'subscribed',
      tokenVersion: 1,
      confirmationEmailSentAt: null,
      createdAt: test.store.subscribers[0]?.createdAt.toISOString(),
    });
  });

  it('404s for an unknown id', async () => {
    expect((await get(buildTestApp(), '/internal/v1/subscribers/sub_404')).statusCode).toBe(404);
  });

  it('rejects the web service token — the two tokens are not interchangeable', async () => {
    const { app } = buildTestApp({
      seed: (s) => void s.seedSubscriber({ email: 'a@example.com' }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/internal/v1/subscribers/sub_1',
      headers: { authorization: `Bearer ${TEST_WEB_SERVICE_TOKEN}` },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /internal/v1/subscribers/:id/confirmation-sent', () => {
  const seedOne: Seed = (s) => void s.seedSubscriber({ email: 'a@example.com' });

  it('records the timestamp and reports it back', async () => {
    const now = new Date('2026-08-16T10:00:00.000Z');
    const test = buildTestApp({ seed: seedOne, now });

    const response = await post(test, '/internal/v1/subscribers/sub_1/confirmation-sent');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ confirmationEmailSentAt: now.toISOString() });

    const refetched = await get(test, '/internal/v1/subscribers/sub_1');
    expect(refetched.json().confirmationEmailSentAt).toBe(now.toISOString());
  });

  it('strips unknown body keys rather than rejecting them', async () => {
    const test = buildTestApp({ seed: seedOne });

    const response = await post(test, '/internal/v1/subscribers/sub_1/confirmation-sent', {
      unexpected: true,
    });

    expect(response.statusCode).toBe(200);
  });

  it('404s for an unknown id', async () => {
    const response = await post(
      buildTestApp(),
      '/internal/v1/subscribers/sub_404/confirmation-sent',
    );

    expect(response.statusCode).toBe(404);
  });

  it('moves the next resend onto a fresh sendKey', async () => {
    // Recording a send is what makes the following signup a resend rather than a repeat.
    const sentAt = new Date('2026-08-01T00:00:00.000Z');
    const test = buildTestApp({ seed: seedOne, now: sentAt });

    await post(test, '/internal/v1/subscribers/sub_1/confirmation-sent');

    const later = buildTestApp({
      now: new Date('2026-08-16T00:00:00.000Z'),
      seed: (s) =>
        void s.seedSubscriber({ email: 'a@example.com', confirmationEmailSentAt: sentAt }),
    });
    await later.app.inject({
      method: 'POST',
      url: '/v1/waitlist/signups',
      headers: { authorization: `Bearer ${TEST_WEB_SERVICE_TOKEN}` },
      payload: { email: 'a@example.com' },
    });

    expect(later.enqueuer.calls[0]?.workflowID).toBe('confirm:sub_1:1785542400');
  });
});

describe('GET /internal/v1/broadcasts/:id', () => {
  it('returns the internal broadcast shape', async () => {
    const test = buildTestApp({
      seed: (s) => void s.seedBroadcast({ status: 'sending', recipientCount: 4 }),
    });

    const response = await get(test, '/internal/v1/broadcasts/bc_1');

    expect(response.json()).toEqual({
      id: 'bc_1',
      subject: 'Subject',
      bodyMarkdown: 'Body',
      audience: ['subscribed'],
      teaserImageUrl: null,
      status: 'sending',
      recipientCount: 4,
      createdAt: test.store.broadcasts[0]?.createdAt.toISOString(),
    });
  });

  it('404s for an unknown id', async () => {
    expect((await get(buildTestApp(), '/internal/v1/broadcasts/bc_404')).statusCode).toBe(404);
  });
});

describe('GET /internal/v1/broadcasts/:id/recipients', () => {
  const mixedDeliveries: Seed = (s) => {
    s.seedSubscriber({ email: 'a@example.com' });
    s.seedSubscriber({ email: 'b@example.com', status: 'unsubscribed' });
    s.seedSubscriber({ email: 'c@example.com' });
    s.seedSubscriber({ email: 'd@example.com' });
    const broadcast = s.seedBroadcast();
    s.seedDelivery(broadcast.id, 'sub_1', 'pending');
    s.seedDelivery(broadcast.id, 'sub_2', 'pending');
    s.seedDelivery(broadcast.id, 'sub_3', 'sent');
    s.seedDelivery(broadcast.id, 'sub_4', 'failed');
  };

  it('pages only the pending deliveries', async () => {
    const body = (
      await get(buildTestApp({ seed: mixedDeliveries }), '/internal/v1/broadcasts/bc_1/recipients')
    ).json();

    expect(body.rows.map((row: { subscriberId: string }) => row.subscriberId)).toEqual([
      'sub_1',
      'sub_2',
    ]);
    expect(body.nextCursor).toBeUndefined();
  });

  it("reports the subscriber's live status, not the audience it was snapshotted into", async () => {
    // This is what lets the worker skip someone who left the audience part-way through.
    const body = (
      await get(buildTestApp({ seed: mixedDeliveries }), '/internal/v1/broadcasts/bc_1/recipients')
    ).json();

    expect(body.rows[1]).toEqual({
      subscriberId: 'sub_2',
      email: 'b@example.com',
      tokenVersion: 1,
      currentStatus: 'unsubscribed',
    });
  });

  it('pages by delivery id with no overlap and no gap', async () => {
    const total = RECIPIENTS_PAGE_SIZE + 2;
    const test = buildTestApp({
      seed: (s) => {
        const broadcast = s.seedBroadcast();
        for (let i = 1; i <= total; i += 1) {
          const subscriber = s.seedSubscriber({ email: `s${i}@example.com` });
          s.seedDelivery(broadcast.id, subscriber.id, 'pending');
        }
      },
    });

    const first = (await get(test, '/internal/v1/broadcasts/bc_1/recipients')).json();
    expect(first.rows).toHaveLength(RECIPIENTS_PAGE_SIZE);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = (
      await get(
        test,
        `/internal/v1/broadcasts/bc_1/recipients?cursor=${encodeURIComponent(first.nextCursor)}`,
      )
    ).json();

    expect(second.rows).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    const seen = [...first.rows, ...second.rows].map(
      (row: { subscriberId: string }) => row.subscriberId,
    );
    expect(new Set(seen).size).toBe(total);
  });

  it('ignores a limit query parameter — the page size is not a knob the worker turns', async () => {
    const body = (
      await get(
        buildTestApp({ seed: mixedDeliveries }),
        '/internal/v1/broadcasts/bc_1/recipients?limit=1',
      )
    ).json();

    expect(body.rows).toHaveLength(2);
  });

  it('rejects a malformed cursor with 400', async () => {
    const response = await get(
      buildTestApp({ seed: mixedDeliveries }),
      '/internal/v1/broadcasts/bc_1/recipients?cursor=not-a-cursor!!',
    );

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /internal/v1/broadcasts/:id/deliveries', () => {
  const onePending: Seed = (s) => {
    s.seedSubscriber({ email: 'a@example.com' });
    s.seedDelivery(s.seedBroadcast().id, 'sub_1', 'pending');
  };

  function flip(test: TestApp, body: Record<string, unknown>) {
    return post(test, '/internal/v1/broadcasts/bc_1/deliveries', body);
  }

  it('flips a pending row to sent', async () => {
    const test = buildTestApp({ seed: onePending });

    const response = await flip(test, { subscriberId: 'sub_1', status: 'sent' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'sent' });
    expect(test.store.deliveries[0]?.status).toBe('sent');
  });

  it('a second identical flip reports the same terminal status', async () => {
    const test = buildTestApp({ seed: onePending });

    await flip(test, { subscriberId: 'sub_1', status: 'sent' });
    const second = await flip(test, { subscriberId: 'sub_1', status: 'sent' });

    expect(second.json()).toEqual({ status: 'sent' });
    expect(test.store.deliveries.filter((row) => row.status === 'sent')).toHaveLength(1);
  });

  it('a conflicting second flip reports the status the row already had', async () => {
    const test = buildTestApp({ seed: onePending });

    await flip(test, { subscriberId: 'sub_1', status: 'sent' });
    const second = await flip(test, { subscriberId: 'sub_1', status: 'failed', error: 'too late' });

    expect(second.json()).toEqual({ status: 'sent' });
    expect(test.store.deliveries[0]?.status).toBe('sent');
  });

  it('persists the error on a failed flip', async () => {
    const test = buildTestApp({ seed: onePending });

    await flip(test, { subscriberId: 'sub_1', status: 'failed', error: '550 mailbox unavailable' });

    expect(test.store.deliveries[0]?.error).toBe('550 mailbox unavailable');
  });

  it('rejects a request asking to move a row back to pending', async () => {
    const test = buildTestApp({ seed: onePending });

    const response = await flip(test, { subscriberId: 'sub_1', status: 'pending' });

    expect(response.statusCode).toBe(400);
  });

  it('404s when the broadcast has no delivery for that subscriber', async () => {
    const test = buildTestApp({ seed: onePending });

    const response = await flip(test, { subscriberId: 'sub_404', status: 'sent' });

    expect(response.statusCode).toBe(404);
  });
});

describe('POST /internal/v1/broadcasts/:id/complete', () => {
  function seedWith(statuses: Array<'sent' | 'failed' | 'skipped'>): Seed {
    return (s) => {
      const broadcast = s.seedBroadcast({ status: 'sending' });
      statuses.forEach((status, index) => {
        const subscriber = s.seedSubscriber({ email: `s${index}@example.com` });
        s.seedDelivery(broadcast.id, subscriber.id, status);
      });
    };
  }

  it('marks a broadcast sent and reports the counts', async () => {
    const test = buildTestApp({ seed: seedWith(['sent', 'sent', 'failed', 'skipped']) });

    const response = await post(test, '/internal/v1/broadcasts/bc_1/complete');

    expect(response.json()).toEqual({
      status: 'sent',
      sentCount: 2,
      failedCount: 1,
      skippedCount: 1,
    });
    expect(test.store.broadcasts[0]?.status).toBe('sent');
    expect(test.store.broadcasts[0]?.completedAt).not.toBeNull();
  });

  it('marks a broadcast failed only when every delivery failed', async () => {
    const test = buildTestApp({ seed: seedWith(['failed', 'failed']) });

    expect((await post(test, '/internal/v1/broadcasts/bc_1/complete')).json()).toEqual({
      status: 'failed',
      sentCount: 0,
      failedCount: 2,
      skippedCount: 0,
    });
  });

  it('is safe to call twice — the first completion stands', async () => {
    const test = buildTestApp({ seed: seedWith(['sent']) });

    const first = await post(test, '/internal/v1/broadcasts/bc_1/complete');
    const completedAt = test.store.broadcasts[0]?.completedAt;
    const second = await post(test, '/internal/v1/broadcasts/bc_1/complete');

    expect(second.json()).toEqual(first.json());
    expect(test.store.broadcasts[0]?.completedAt).toBe(completedAt);
  });

  it('404s for an unknown broadcast', async () => {
    expect((await post(buildTestApp(), '/internal/v1/broadcasts/bc_404/complete')).statusCode).toBe(
      404,
    );
  });
});

describe('POST /internal/v1/email-events', () => {
  const seedOne: Seed = (s) => void s.seedSubscriber({ email: 'a@example.com' });
  const at = 1_785_542_400;

  function send(test: TestApp, events: object) {
    return post(test, '/internal/v1/email-events', events);
  }

  it.each(['bounce', 'spamreport'])(
    'a %s suppresses the address and revokes its links',
    async (event) => {
      const test = buildTestApp({ seed: seedOne });

      const response = await send(test, [{ email: 'a@example.com', event, timestamp: at }]);

      expect(response.json()).toEqual({ processed: 1, bounced: 1 });
      expect(test.store.subscribers[0]?.status).toBe('bounced');
      expect(test.store.subscribers[0]?.tokenVersion).toBe(2);
      expect(test.store.bouncedAt.get('sub_1')).toEqual(new Date(at * 1000));
    },
  );

  it('replaying a batch does not bump tokenVersion again', async () => {
    // Providers retry webhooks; an unconditional update would revoke the manage links every time.
    const test = buildTestApp({ seed: seedOne });
    const batch = [{ email: 'a@example.com', event: 'bounce', timestamp: at }];

    await send(test, batch);
    const replay = await send(test, batch);

    expect(replay.json()).toEqual({ processed: 1, bounced: 0 });
    expect(test.store.subscribers[0]?.tokenVersion).toBe(2);
  });

  it('accepts an event for an address we do not have', async () => {
    const test = buildTestApp({ seed: seedOne });

    const response = await send(test, [
      { email: 'nobody@example.com', event: 'bounce', timestamp: at },
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ processed: 1, bounced: 0 });
  });

  it('rejects an empty batch', async () => {
    expect((await send(buildTestApp({ seed: seedOne }), [])).statusCode).toBe(400);
  });

  it('rejects an event type it does not recognise', async () => {
    const test = buildTestApp({ seed: seedOne });

    const response = await send(test, [{ email: 'a@example.com', event: 'open', timestamp: at }]);

    expect(response.statusCode).toBe(400);
    expect(test.store.subscribers[0]?.status).toBe('subscribed');
  });

  it('is the only route that bumps tokenVersion', async () => {
    const test = buildTestApp({ seed: seedOne });

    await test.app.inject({
      method: 'POST',
      url: '/internal/v1/broadcasts/bc_1/complete',
      headers: auth,
      payload: {},
    });
    expect(test.store.subscribers[0]?.tokenVersion).toBe(1);

    await send(test, [{ email: 'a@example.com', event: 'bounce', timestamp: at }]);
    expect(test.store.subscribers[0]?.tokenVersion).toBe(2);
  });
});
