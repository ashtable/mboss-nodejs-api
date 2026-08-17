import type { FastifyInstance } from 'fastify';

/**
 * The one route with no bearer check: it is the platform's healthcheck, reachable only from inside
 * the private network, and a healthcheck that needs a credential is a healthcheck that fails when
 * the credential rotates.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ ok: true }));
}
