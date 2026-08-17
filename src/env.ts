import { z } from 'zod';

/**
 * The five secrets and URLs the service cannot
 * run without, plus two operational knobs that
 * have sensible defaults. Railway injects `PORT`.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DBOS_SYSTEM_DATABASE_URL: z.string().min(1),
  WEB_SERVICE_TOKEN: z.string().min(1),
  INTERNAL_API_TOKEN: z.string().min(1),
  LINK_KEYS: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().min(1).default('0.0.0.0'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Throws with every missing or malformed variable
 * named at once. A service that boots without its
 * bearer tokens would answer unauthenticated
 * requests, so this failure has to be loud and
 * total rather than per-variable and lazy.
 */
export function readEnv(source: NodeJS.ProcessEnv): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`invalid environment: ${problems}`);
}
