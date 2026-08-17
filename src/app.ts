import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import type { LinkKeyRing } from '@mboss/core/signed-links';

import { healthRoutes } from './routes/health.js';

export interface AppDeps {
  keyRing: LinkKeyRing;
  webServiceToken: string;
  internalApiToken: string;
}

/**
 * Builds the server from dependencies it is handed. It opens no connections and constructs no
 * clients, which is what lets the whole route surface be tested against in-memory doubles with no
 * database and no network anywhere in CI.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  void deps;
  app.register(healthRoutes);

  return app;
}
