import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { requireBearer } from '../src/auth.js';

const TOKEN = 'the-right-token';

function appGuardedBy(token: string): FastifyInstance {
  const app = Fastify();
  app.addHook('onRequest', requireBearer(token));
  app.get('/guarded', async () => ({ reached: true }));
  return app;
}

describe('requireBearer', () => {
  it('rejects a request with no Authorization header', async () => {
    const response = await appGuardedBy(TOKEN).inject({ method: 'GET', url: '/guarded' });

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
    // The length guard exists so `timingSafeEqual` never throws; this pins that it also rejects.
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
