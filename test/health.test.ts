import { describe, expect, it } from 'vitest';

import { buildTestApp } from './helpers/build-test-app.js';

describe('GET /healthz', () => {
  it('returns { ok: true }', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('requires no authorization', async () => {
    // Railway's healthcheck hits this from
    // inside the private network and carries
    // no bearer token.
    const { app } = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
  });
});
