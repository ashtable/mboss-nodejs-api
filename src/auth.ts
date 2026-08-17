import { timingSafeEqual } from 'node:crypto';

import type { onRequestAsyncHookHandler } from 'fastify';

const BEARER = 'Bearer ';

/**
 * The two service tokens are long-lived shared
 * secrets, so the comparison is constant-time.
 * The length guard is not an optimization —
 * `timingSafeEqual` throws on buffers of unequal
 * length — and a differing length is not a secret
 * worth protecting anyway.
 */
function matches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Guards a plugin scope with one bearer token.
 * Every rejection looks the same from outside:
 * the caller is another service holding a fixed
 * secret, so there is nothing useful to tell it
 * apart from a caller holding nothing.
 */
export function requireBearer(expected: string): onRequestAsyncHookHandler {
  return async (request, reply) => {
    const header = request.headers.authorization;

    if (
      header === undefined ||
      !header.startsWith(BEARER) ||
      !matches(header.slice(BEARER.length), expected)
    ) {
      await reply.code(401).send({ error: 'Unauthorized', statusCode: 401 });
    }
  };
}
