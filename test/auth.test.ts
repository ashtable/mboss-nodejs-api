import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { requireBearer } from '../src/auth.js';
import {
  buildTestApp,
  TEST_INTERNAL_API_TOKEN,
  TEST_WEB_SERVICE_TOKEN,
  type Seed,
} from './helpers/build-test-app.js';

const TOKEN = 'the-right-token';

function appGuardedBy(token: string): FastifyInstance {
  const app = Fastify();
  app.addHook('onRequest', requireBearer(token));
  app.get('/guarded', async () => ({ reached: true }));
  return app;
}

describe('requireBearer', () => {
  it('rejects a request with no Authorization header', async () => {
    const response = await appGuardedBy(TOKEN).inject({
      method: 'GET',
      url: '/guarded',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized', statusCode: 401 });
  });

  it('rejects the wrong token', async () => {
    const response = await appGuardedBy(TOKEN).inject({
      method: 'GET',
      url: '/guarded',
      headers: { authorization: 'Bearer not-the-right-token' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a token of the right value under the wrong scheme', async () => {
    const response = await appGuardedBy(TOKEN).inject({
      method: 'GET',
      url: '/guarded',
      headers: { authorization: `Basic ${TOKEN}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a token that merely starts with the right value', async () => {
    // The length guard exists so
    // `timingSafeEqual` never throws;
    // this pins that it also rejects.
    const response = await appGuardedBy(TOKEN).inject({
      method: 'GET',
      url: '/guarded',
      headers: { authorization: `Bearer ${TOKEN}-and-more` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('admits the right token', async () => {
    const response = await appGuardedBy(TOKEN).inject({
      method: 'GET',
      url: '/guarded',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reached: true });
  });
});

describe('the two token scopes', () => {
  const web = `Bearer ${TEST_WEB_SERVICE_TOKEN}`;
  const internal = `Bearer ${TEST_INTERNAL_API_TOKEN}`;
  const seedOne: Seed = (s) =>
    void s.seedSubscriber({ email: 'a@example.com' });

  function reach(authorization: string | undefined, url: string) {
    const { app } = buildTestApp({ seed: seedOne });
    return app.inject({
      method: 'GET',
      url,
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    });
  }

  it.each([
    ['no token', undefined, '/v1/admin/waitlist', 401],
    ['the web token', web, '/v1/admin/waitlist', 200],
    ['the internal token', internal, '/v1/admin/waitlist', 401],
    ['no token', undefined, '/internal/v1/subscribers/sub_1', 401],
    ['the internal token', internal, '/internal/v1/subscribers/sub_1', 200],
    ['the web token', web, '/internal/v1/subscribers/sub_1', 401],
  ])('%s on %s gives %i', async (_label, authorization, url, expected) => {
    expect((await reach(authorization, url)).statusCode).toBe(expected);
  });

  it('treats a missing x-admin-actor as a bad request, not an authentication failure', async () => {
    // Authentication is the bearer token;
    // the header is an audit value
    // mboss-web supplies.
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/broadcasts',
      headers: { authorization: web },
      payload: {
        subject: 'Hi',
        bodyMarkdown: 'There',
        audience: ['subscribed'],
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
