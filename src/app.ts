import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import type { LinkKeyRing } from '@mboss/core/signed-links';

import { requireBearer } from './auth.js';
import type { WorkflowEnqueuer } from './enqueue/types.js';
import { installErrorHandler } from './errors.js';
import type { RouteDeps } from './routes/deps.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { internalRoutes } from './routes/internal.js';
import { waitlistRoutes } from './routes/waitlist.js';
import type { Store } from './store/types.js';

export interface AppDeps {
  store: Store;
  enqueuer: WorkflowEnqueuer;
  keyRing: LinkKeyRing;
  webServiceToken: string;
  internalApiToken: string;
  /** Overridden only by tests, so the 24h resend rule can be exercised at a fixed instant. */
  now?: () => Date;
}

/**
 * Builds the server from dependencies it is handed. It opens no connections and constructs no
 * clients, which is what lets the whole route surface be tested against in-memory doubles with no
 * database and no network anywhere in CI.
 *
 * The two bearer tokens guard encapsulated plugin scopes rather than a global hook matching on
 * URL prefixes: a route is protected because of where it was registered, so a new route cannot be
 * added outside the guard by getting its path wrong.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  // A manage link's token is a path parameter of roughly 175 characters — a base64url payload plus
  // a base64url HMAC — and Fastify's default cap of 100 would answer every one of them with a 414.
  const app = Fastify({ maxParamLength: 512 });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  installErrorHandler(app);

  const routeDeps: RouteDeps = {
    store: deps.store,
    enqueuer: deps.enqueuer,
    keyRing: deps.keyRing,
    now: deps.now ?? (() => new Date()),
  };

  app.register(healthRoutes);

  app.register(async (scope) => {
    scope.addHook('onRequest', requireBearer(deps.webServiceToken));
    await scope.register(waitlistRoutes(routeDeps));
    await scope.register(adminRoutes(routeDeps));
  });

  app.register(async (scope) => {
    scope.addHook('onRequest', requireBearer(deps.internalApiToken));
    await scope.register(internalRoutes(routeDeps));
  });

  return app;
}
