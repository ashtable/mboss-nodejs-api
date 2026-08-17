import { describe, expect, it } from 'vitest';

import { mintLink, parseKeyRing, type LinkKeyRing } from '@mboss/core/signed-links';

import { buildTestApp, TEST_WEB_SERVICE_TOKEN } from './helpers/build-test-app.js';

const auth = { authorization: `Bearer ${TEST_WEB_SERVICE_TOKEN}` };

/** `iat` must be a whole number of seconds or `mintLink` throws, by design. */
const IAT = Math.floor(Date.UTC(2026, 7, 16) / 1000);

function manageToken(ring: LinkKeyRing, sub: string, tv: number): string {
  return mintLink(ring, { t: 'wl.manage', sub, tv, iat: IAT });
}

function signup(app: ReturnType<typeof buildTestApp>['app'], email: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/waitlist/signups',
    headers: auth,
    payload: { email },
  });
}

describe('POST /v1/waitlist/signups', () => {
  it('creates a subscriber and returns the wire shape', async () => {
    const { app, store } = buildTestApp();

    const response = await signup(app, 'new@example.com');

    expect(response.statusCode).toBe(200);
    const subscriber = store.subscribers[0];
    expect(subscriber?.email).toBe('new@example.com');
    expect(response.json()).toEqual({
      email: 'new@example.com',
      status: 'subscribed',
      subscribedAt: subscriber?.createdAt.toISOString(),
    });
  });

  it('enqueues confirmationEmail with sendKey 0 on queue email', async () => {
    const { app, enqueuer } = buildTestApp();

    await signup(app, 'new@example.com');

    // toEqual fails on an extra key, which is what pins the absence of a deduplicationID.
    expect(enqueuer.calls).toEqual([
      {
        workflowName: 'confirmationEmail',
        queueName: 'email',
        workflowID: 'confirm:sub_1:0',
        args: { subscriberId: 'sub_1' },
      },
    ]);
  });

  it('normalises the email before storing it', async () => {
    const { app, store } = buildTestApp();

    const response = await signup(app, '  A@B.COM ');

    expect(response.json().email).toBe('a@b.com');
    expect(store.subscribers[0]?.email).toBe('a@b.com');
  });

  it('rejects a malformed email with 400', async () => {
    const { app, store, enqueuer } = buildTestApp();

    const response = await signup(app, 'not-an-email');

    expect(response.statusCode).toBe(400);
    expect(store.subscribers).toHaveLength(0);
    expect(enqueuer.calls).toHaveLength(0);
  });

  it('requires the web service bearer token', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/waitlist/signups',
      payload: { email: 'new@example.com' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /v1/waitlist/signups — a repeat signup', () => {
  it('returns 200 with the existing row rather than a conflict', async () => {
    const { app, store } = buildTestApp({
      seed: (s) => void s.seedSubscriber({ email: 'known@example.com' }),
    });
    const seeded = store.subscribers[0];

    const response = await signup(app, 'known@example.com');

    expect(response.statusCode).toBe(200);
    expect(store.subscribers).toHaveLength(1);
    expect(response.json()).toEqual({
      email: 'known@example.com',
      status: 'subscribed',
      subscribedAt: seeded?.createdAt.toISOString(),
    });
  });

  it('re-subscribes an unsubscribed email', async () => {
    const { app, store } = buildTestApp({
      seed: (s) => void s.seedSubscriber({ email: 'gone@example.com', status: 'unsubscribed' }),
    });

    const response = await signup(app, 'gone@example.com');

    expect(response.json().status).toBe('subscribed');
    expect(store.subscribers[0]?.status).toBe('subscribed');
  });

  it('does not bump tokenVersion when re-subscribing', async () => {
    const { app, store } = buildTestApp({
      seed: (s) => void s.seedSubscriber({ email: 'gone@example.com', status: 'unsubscribed' }),
    });

    await signup(app, 'gone@example.com');

    expect(store.subscribers[0]?.tokenVersion).toBe(1);
  });

  it('leaves a paused email paused', async () => {
    const { app, store } = buildTestApp({
      seed: (s) => void s.seedSubscriber({ email: 'quiet@example.com', status: 'paused' }),
    });

    const response = await signup(app, 'quiet@example.com');

    expect(response.json().status).toBe('paused');
    expect(store.subscribers[0]?.status).toBe('paused');
  });

  it('re-subscribes a bounced email', async () => {
    const { app, store } = buildTestApp({
      seed: (s) => void s.seedSubscriber({ email: 'bad@example.com', status: 'bounced' }),
    });

    const response = await signup(app, 'bad@example.com');

    expect(response.json().status).toBe('subscribed');
    expect(store.subscribers[0]?.status).toBe('subscribed');
  });

  it('enqueues a confirmation for a bounced email', async () => {
    const { app, enqueuer } = buildTestApp({
      seed: (s) => void s.seedSubscriber({ email: 'bad@example.com', status: 'bounced' }),
    });

    await signup(app, 'bad@example.com');

    expect(enqueuer.calls).toEqual([
      {
        workflowName: 'confirmationEmail',
        queueName: 'email',
        workflowID: 'confirm:sub_1:0',
        args: { subscriberId: 'sub_1' },
      },
    ]);
  });

  it('does not bump tokenVersion when a bounced email re-subscribes', async () => {
    // The bounce already bumped it, retiring the links minted before it. The confirmation this
    // signup enqueues mints a fresh link at the current version, so nothing needs retiring again.
    const { app, store } = buildTestApp({
      seed: (s) => void s.seedSubscriber({ email: 'bad@example.com', status: 'bounced' }),
    });

    await signup(app, 'bad@example.com');

    expect(store.subscribers[0]?.tokenVersion).toBe(1);
  });

  it('still enqueues a confirmation for a re-subscribing email', async () => {
    const { app, enqueuer } = buildTestApp({
      seed: (s) => void s.seedSubscriber({ email: 'gone@example.com', status: 'unsubscribed' }),
    });

    await signup(app, 'gone@example.com');

    expect(enqueuer.calls).toEqual([
      {
        workflowName: 'confirmationEmail',
        queueName: 'email',
        workflowID: 'confirm:sub_1:0',
        args: { subscriberId: 'sub_1' },
      },
    ]);
  });
});

describe('POST /v1/waitlist/signups — the 24h resend rule', () => {
  const now = new Date('2026-08-16T00:00:00.000Z');

  it('enqueues nothing for a repeat signup inside the window', async () => {
    const { app, enqueuer } = buildTestApp({
      now,
      seed: (s) =>
        void s.seedSubscriber({
          email: 'known@example.com',
          confirmationEmailSentAt: new Date('2026-08-15T23:00:00.000Z'),
        }),
    });

    const response = await signup(app, 'known@example.com');

    expect(response.statusCode).toBe(200);
    expect(enqueuer.calls).toHaveLength(0);
  });

  it('enqueues with the previous send epoch as the sendKey once the window has passed', async () => {
    const { app, enqueuer } = buildTestApp({
      now,
      seed: (s) =>
        void s.seedSubscriber({
          email: 'known@example.com',
          confirmationEmailSentAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
    });

    await signup(app, 'known@example.com');

    expect(enqueuer.calls).toEqual([
      {
        workflowName: 'confirmationEmail',
        queueName: 'email',
        workflowID: 'confirm:sub_1:1785542400',
        args: { subscriberId: 'sub_1' },
      },
    ]);
  });
});

describe('the manage routes', () => {
  function withSubscriber(status: 'subscribed' | 'paused' | 'unsubscribed' = 'subscribed') {
    return buildTestApp({
      seed: (s) => void s.seedSubscriber({ email: 'member@example.com', status }),
    });
  }

  it('reports the current state for a valid token', async () => {
    const { app, store, keyRing } = withSubscriber();
    const seeded = store.subscribers[0];

    const response = await app.inject({
      method: 'GET',
      url: `/v1/waitlist/manage/${manageToken(keyRing, 'sub_1', 1)}`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      email: 'member@example.com',
      status: 'subscribed',
      subscribedAt: seeded?.createdAt.toISOString(),
    });
  });

  it.each([
    ['pause', 'paused'],
    ['resume', 'subscribed'],
    ['unsubscribe', 'unsubscribed'],
  ])('POST /%s sets the subscriber to %s', async (action, expected) => {
    const { app, store, keyRing } = withSubscriber();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/waitlist/manage/${manageToken(keyRing, 'sub_1', 1)}/${action}`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: expected });
    expect(store.subscribers[0]?.status).toBe(expected);
  });

  it('leaves tokenVersion alone for all three actions — only a bounce revokes links', async () => {
    const { app, store, keyRing } = withSubscriber();
    const token = manageToken(keyRing, 'sub_1', 1);

    for (const action of ['pause', 'resume', 'unsubscribe']) {
      await app.inject({
        method: 'POST',
        url: `/v1/waitlist/manage/${token}/${action}`,
        headers: auth,
      });
    }

    expect(store.subscribers[0]?.tokenVersion).toBe(1);
  });
});

describe('manage token rejection', () => {
  const routes = [
    ['GET', ''],
    ['POST', '/pause'],
    ['POST', '/resume'],
    ['POST', '/unsubscribe'],
  ] as const;

  /**
   * Every rejection is the same 404. These URLs are pasted out of emails and get shared, so the
   * API never tells an outside observer whether a link is forged, revoked, or points at someone
   * who does not exist.
   */
  function rejectionCases(keyRing: LinkKeyRing): Array<[string, string]> {
    const otherRing = parseKeyRing(`k1:${'22'.repeat(32)}`);
    return [
      ['structurally malformed', 'not-a-token'],
      ['signed with a key outside the ring', manageToken(otherRing, 'sub_1', 1)],
      [
        'of the wrong link type',
        mintLink(keyRing, {
          t: 'app.form',
          run: 'r1',
          node: 'n1',
          sub: 'sub_1',
          iat: IAT,
          exp: IAT + 3600,
        }),
      ],
      ['naming a subscriber that does not exist', manageToken(keyRing, 'sub_404', 1)],
      ['carrying a token version the subscriber has moved past', manageToken(keyRing, 'sub_1', 1)],
    ];
  }

  it.each(routes)(
    '%s /v1/waitlist/manage/:token%s rejects every bad token with 404',
    async (method, suffix) => {
      for (const [label, token] of rejectionCases(parseKeyRing(`k1:${'11'.repeat(32)}`))) {
        const { app } = buildTestApp({
          // tokenVersion 2 makes the last case — a token minted at version 1 — stale.
          seed: (s) => void s.seedSubscriber({ email: 'member@example.com', tokenVersion: 2 }),
        });

        const response = await app.inject({
          method,
          url: `/v1/waitlist/manage/${token}${suffix}`,
          headers: auth,
        });

        expect(response.statusCode, `${label} should be rejected`).toBe(404);
      }
    },
  );

  it.each(routes)(
    '%s /v1/waitlist/manage/:token%s admits a matching token',
    async (method, suffix) => {
      const { app, keyRing } = buildTestApp({
        seed: (s) => void s.seedSubscriber({ email: 'member@example.com', tokenVersion: 2 }),
      });

      const response = await app.inject({
        method,
        url: `/v1/waitlist/manage/${manageToken(keyRing, 'sub_1', 2)}${suffix}`,
        headers: auth,
      });

      expect(response.statusCode).toBe(200);
    },
  );
});
