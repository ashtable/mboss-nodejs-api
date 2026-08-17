# mboss-nodejs-api

mboss: Design Durable Apps with DBOS — Fastify API.

The private service tier. It is not publicly routable: all public HTTP terminates at Next.js, and
this service answers only over the private network. `mboss-web` calls `/v1/*` with
`WEB_SERVICE_TOKEN`; the DBOS worker calls `/internal/v1/*` with `INTERNAL_API_TOKEN`.

## Prerequisites

Clone with submodules. `mboss-zod`, `mboss-database` and `mboss-core` are nested here, and
`npm install` runs `prisma generate` against `mboss-database`'s schema — a clone without them
fails install with a confusing Prisma error rather than a missing-directory one.

```bash
git clone --recurse-submodules https://github.com/ashtable/mboss-nodejs-api
# or, in an existing clone:
git submodule update --init --recursive
```

Node 24.18 (see `.nvmrc`) and a Postgres to point `DATABASE_URL` at.

## Running it

```bash
cp .env.example .env
npm install
npm run migrate:deploy   # applies mboss-database's migrations
npm run dev              # or: npm start
curl localhost:3001/healthz
```

There is no build step: `tsx` runs the TypeScript sources directly, and the tsconfig path aliases
that resolve `@mboss/zod` and `@mboss/core/signed-links` into the nested submodules work under
`tsx`, `tsc` and `vitest` alike. `npm start` reads its configuration from the process environment,
so export `.env` yourself (`set -a && . ./.env && set +a`) or let compose supply it.

### The `dbos` schema must exist before anything can be enqueued

`DBOSClient` is a consumer of the worker's system database, not its owner: it has no option to
create the schema. Until `mboss-nodejs-dbos` has run `DBOS.launch()` once against the same
Postgres, every route that enqueues a workflow answers 500 with `relation "dbos.workflow_status"
does not exist`. Reads and `/healthz` are unaffected. Signup is safely retryable when that
happens — the subscriber row is written, no confirmation is recorded, and the next signup derives
the same workflow id, so exactly one confirmation is ever sent.

## Environment

| Variable                   | Purpose                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `DATABASE_URL`             | Postgres, via `prisma.config.ts` and the `@prisma/adapter-pg` driver adapter |
| `DBOS_SYSTEM_DATABASE_URL` | The DBOS system database. The same database as above                         |
| `WEB_SERVICE_TOKEN`        | Bearer token `mboss-web` presents on `/v1/*`                                 |
| `INTERNAL_API_TOKEN`       | Bearer token the worker presents on `/internal/v1/*`                         |
| `LINK_KEYS`                | Signed-link key ring, `kid:64-hex[,kid:64-hex]`. Malformed values fail boot  |
| `PORT`                     | Defaults to 3001. Railway injects this                                       |
| `HOST`                     | Defaults to `0.0.0.0`                                                        |

## Tests

```bash
npm run lint              # tsc --noEmit && eslint . && prettier --check .
npm test                  # hermetic: no database, no network. This is what CI runs
npm run test:integration  # local only; needs DATABASE_URL, skips cleanly without it
```

The route handlers take a `Store` and a `WorkflowEnqueuer` rather than constructing a Prisma or
DBOS client, so the whole route surface — the sendKey arithmetic, the audience math, the manage
token checks, every auth path — is proven against in-memory doubles with nothing live in reach.
Only the claims that are irreducibly about Postgres live in the integration suite: that the
recipient snapshot is one transaction and rolls back, that the delivery flip and the bounce are
conditional updates under real concurrency, and that keyset paging covers every row exactly once.

## Contracts the DBOS worker must honour

| Contract     | Value                                                                              |
| ------------ | ---------------------------------------------------------------------------------- |
| Queue        | `email`                                                                            |
| Workflow     | `confirmationEmail`, args `{ subscriberId }`                                       |
| Workflow     | `broadcastSend`, args `{ broadcastId }`                                            |
| Workflow     | `broadcastTestSend`, args `{ subject, bodyMarkdown, teaserImageUrl?, to }`         |
| Workflow ids | `confirm:<subscriberId>:<sendKey>`, `broadcast:<broadcastId>`, none for test sends |
| Registration | free functions via `DBOS.registerWorkflow` — **never** class static methods        |

The registration style is not a preference. This service enqueues without a `workflowClassName`,
which the SDK defaults to the empty string; a workflow registered as a class method throws
`DBOSConflictingWorkflowError` on the _second_ enqueue of the same id, which is exactly the repeat
signup the design relies on collapsing quietly.

Enqueue arguments are never compared on a colliding workflow id — the first call's arguments win —
so nothing time-varying may ever be added to them. Every argument above is derived from an id that
is already part of the workflow id.
