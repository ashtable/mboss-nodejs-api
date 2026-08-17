import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  BroadcastCompleteResponseSchema,
  ConfirmationSentResponseSchema,
  DeliveryFlipRequestSchema,
  DeliveryFlipResponseSchema,
  EmailEventsRequestSchema,
  EmailEventsResponseSchema,
  EmptyBodySchema,
  InternalBroadcastResponseSchema,
  InternalRecipientsQuerySchema,
  InternalRecipientsResponseSchema,
  InternalSubscriberResponseSchema,
} from '@mboss/zod';

import { completeStatus } from '../broadcast-status.js';
import { decodeIdCursor, encodeIdCursor } from '../cursor.js';
import { badRequest, notFound } from '../errors.js';
import type { RouteDeps } from './deps.js';

/**
 * How many pending deliveries one page carries. It is a constant rather than a query parameter
 * because the worker has no reason to want a different number, and a page size the caller picks is
 * a page size that eventually gets picked badly.
 */
export const RECIPIENTS_PAGE_SIZE = 100;

const IdParamsSchema = z.object({ id: z.string().min(1) });

export function internalRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (scope) => {
    const app = scope.withTypeProvider<ZodTypeProvider>();

    app.route({
      method: 'GET',
      url: '/internal/v1/subscribers/:id',
      schema: { params: IdParamsSchema, response: { 200: InternalSubscriberResponseSchema } },
      handler: async (request, reply) => {
        const subscriber = await deps.store.findSubscriberById(request.params.id);
        if (!subscriber) return notFound(reply);

        return {
          id: subscriber.id,
          email: subscriber.email,
          status: subscriber.status,
          tokenVersion: subscriber.tokenVersion,
          confirmationEmailSentAt: subscriber.confirmationEmailSentAt?.toISOString() ?? null,
          createdAt: subscriber.createdAt.toISOString(),
        };
      },
    });

    app.route({
      method: 'POST',
      url: '/internal/v1/subscribers/:id/confirmation-sent',
      schema: {
        params: IdParamsSchema,
        body: EmptyBodySchema,
        response: { 200: ConfirmationSentResponseSchema },
      },
      handler: async (request, reply) => {
        // Moving this timestamp forward is also what moves the next resend onto a fresh sendKey.
        const at = await deps.store.recordConfirmationSent(request.params.id, deps.now());
        if (at === null) return notFound(reply);

        return { confirmationEmailSentAt: at.toISOString() };
      },
    });

    app.route({
      method: 'GET',
      url: '/internal/v1/broadcasts/:id',
      schema: { params: IdParamsSchema, response: { 200: InternalBroadcastResponseSchema } },
      handler: async (request, reply) => {
        const broadcast = await deps.store.findBroadcastById(request.params.id);
        if (!broadcast) return notFound(reply);

        return {
          id: broadcast.id,
          subject: broadcast.subject,
          bodyMarkdown: broadcast.bodyMarkdown,
          audience: broadcast.audience,
          teaserImageUrl: broadcast.teaserImageUrl,
          status: broadcast.status,
          recipientCount: broadcast.recipientCount,
          createdAt: broadcast.createdAt.toISOString(),
        };
      },
    });

    app.route({
      method: 'GET',
      url: '/internal/v1/broadcasts/:id/recipients',
      schema: {
        params: IdParamsSchema,
        querystring: InternalRecipientsQuerySchema,
        response: { 200: InternalRecipientsResponseSchema },
      },
      handler: async (request, reply) => {
        const { cursor } = request.query;
        const after = cursor === undefined ? undefined : decodeIdCursor(cursor);
        if (after === null) return badRequest(reply, 'cursor is not a cursor this API minted');

        const page = await deps.store.listPendingRecipients(
          request.params.id,
          after,
          RECIPIENTS_PAGE_SIZE,
        );

        const rows = page.rows.map((row) => ({
          subscriberId: row.subscriberId,
          email: row.email,
          tokenVersion: row.tokenVersion,
          currentStatus: row.currentStatus,
        }));

        const last = page.rows.at(-1);
        if (!page.hasMore || last === undefined) return { rows };
        return { rows, nextCursor: encodeIdCursor(last.deliveryId) };
      },
    });

    app.route({
      method: 'POST',
      url: '/internal/v1/broadcasts/:id/deliveries',
      schema: {
        params: IdParamsSchema,
        body: DeliveryFlipRequestSchema,
        response: { 200: DeliveryFlipResponseSchema },
      },
      handler: async (request, reply) => {
        // The flip is conditional on the row still being pending, so a replayed send step is a
        // no-op rather than a double count, and a late failure never overwrites a recorded send.
        // The status returned is the row's own, which is what makes that observable to the worker.
        const status = await deps.store.flipDelivery(
          request.params.id,
          request.body.subscriberId,
          request.body.status,
          request.body.error,
        );
        if (status === null) return notFound(reply);

        return { status };
      },
    });

    app.route({
      method: 'POST',
      url: '/internal/v1/broadcasts/:id/complete',
      schema: {
        params: IdParamsSchema,
        body: EmptyBodySchema,
        response: { 200: BroadcastCompleteResponseSchema },
      },
      handler: async (request, reply) => {
        const counts = await deps.store.countDeliveries(request.params.id);
        const status = await deps.store.markBroadcastComplete(
          request.params.id,
          completeStatus(counts),
          deps.now(),
        );
        if (status === null) return notFound(reply);

        return {
          status,
          sentCount: counts.sent,
          failedCount: counts.failed,
          skippedCount: counts.skipped,
        };
      },
    });

    app.route({
      method: 'POST',
      url: '/internal/v1/email-events',
      schema: { body: EmailEventsRequestSchema, response: { 200: EmailEventsResponseSchema } },
      handler: async (request) => {
        let bounced = 0;

        for (const event of request.body) {
          // The provider's timestamp is epoch seconds. An address we do not have is not an error:
          // failing the webhook would only make the provider retry a batch we can never act on.
          const flipped = await deps.store.markBounced(
            event.email,
            new Date(event.timestamp * 1000),
          );
          if (flipped) bounced += 1;
        }

        return { processed: request.body.length, bounced };
      },
    });
  };
}
