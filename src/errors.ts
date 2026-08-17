import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

/**
 * Zod validation failures on the way in are the caller's fault; failures on the way out are ours.
 * Separating them is what keeps a handler bug from being reported to `mboss-web` as a bad request.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: 'Validation Error',
        statusCode: 400,
        details: { issues: error.validation },
      });
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response did not match its schema');
      return reply.code(500).send({
        error: 'Internal Server Error',
        statusCode: 500,
        details: { issues: error.cause.issues },
      });
    }

    // Anything else keeps Fastify's own status and serialization; overriding it here would only
    // re-derive what Fastify already knows about the error, and get it wrong for the ones it
    // raises itself.
    request.log.error({ err: error }, 'unhandled error');
    return reply.send(error);
  });
}

/**
 * The manage routes answer every rejection with this one status, so an outside observer cannot
 * tell a forged token from a revoked one, or a stale link from a subscriber who never existed.
 */
export function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'Not Found', statusCode: 404 });
}

export function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message });
}
