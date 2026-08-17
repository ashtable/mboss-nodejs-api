import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { installErrorHandler } from '../src/errors.js';

function probeApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  installErrorHandler(app);

  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: 'POST',
    url: '/probe/body',
    schema: {
      body: z.object({ n: z.number() }),
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
    handler: async () => ({ ok: true }) as const,
  });

  typed.route({
    method: 'GET',
    url: '/probe/response',
    schema: { response: { 200: z.object({ n: z.number() }) } },
    // Deliberately violates its own
    // response schema.
    handler: async () => ({ n: 'not a number' }) as unknown as { n: number },
  });

  return app;
}

describe('error handler', () => {
  it('turns a request-schema violation into a 400', async () => {
    const response = await probeApp().inject({
      method: 'POST',
      url: '/probe/body',
      payload: { n: 'not a number' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'Validation Error',
      statusCode: 400,
    });
  });

  it('turns a response-schema violation into a 500', async () => {
    const response = await probeApp().inject({
      method: 'GET',
      url: '/probe/response',
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: 'Internal Server Error',
      statusCode: 500,
    });
  });
});
