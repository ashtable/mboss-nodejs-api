import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { parseKeyRing } from '@mboss/core/signed-links';

import { buildApp } from './app.js';
import { DbosEnqueuer } from './enqueue/dbos-enqueuer.js';
import { readEnv } from './env.js';
import { PrismaStore } from './store/prisma-store.js';

/**
 * Everything the service needs is constructed
 * here and handed to `buildApp`, which constructs
 * nothing itself. Anything that can fail — a
 * malformed key ring, a missing token, an
 * unreachable database — fails before the first
 * request is served rather than during one.
 */
const env = readEnv(process.env);
const keyRing = parseKeyRing(env.LINK_KEYS);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const dbos = await DBOSClient.create({
  systemDatabaseUrl: env.DBOS_SYSTEM_DATABASE_URL,
});

const app = buildApp({
  store: new PrismaStore(prisma),
  enqueuer: new DbosEnqueuer(dbos),
  keyRing,
  webServiceToken: env.WEB_SERVICE_TOKEN,
  internalApiToken: env.INTERNAL_API_TOKEN,
});

app.addHook('onClose', async () => {
  await dbos.destroy();
  await prisma.$disconnect();
});

// The container runtime stops the service with
// SIGTERM; closing the server lets in-flight
// requests finish and runs the hook above, so
// neither pool is left dangling.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
