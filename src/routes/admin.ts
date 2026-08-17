import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  AdminWaitlistQuerySchema,
  AdminWaitlistResponseSchema,
  BroadcastDetailResponseSchema,
  BroadcastListResponseSchema,
  BroadcastResponseSchema,
  CreateBroadcastRequestSchema,
  emailSchema,
  TestSendRequestSchema,
  TestSendResponseSchema,
  WaitlistStatsResponseSchema,
} from '@mboss/zod';

import { effectiveAudience } from '../broadcast-status.js';
import { decodeSubscriberCursor, encodeSubscriberCursor } from '../cursor.js';
import { badRequest, notFound } from '../errors.js';
import { EMAIL_QUEUE } from './waitlist.js';
import type { RouteDeps } from './deps.js';

/**
 * The admin's email from the session `mboss-web` already enforced. It is an audit value, never a
 * credential — authentication is the bearer token, and only `mboss-web` holds that. Validating it
 * as an address here means a missing header fails loudly instead of writing a placeholder into
 * `Broadcast.createdBy`, which the wire declares to be an email.
 *
 * The shared rule rather than a local one, because it also normalizes: `Admin@Example.com` and
 * `admin@example.com` are one admin, and an audit trail that stores them as two cannot be grouped.
 */
const AdminActorSchema = z.object({ 'x-admin-actor': emailSchema });

const BroadcastParamsSchema = z.object({ id: z.string().min(1) });

export function adminRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (scope) => {
    const app = scope.withTypeProvider<ZodTypeProvider>();

    app.route({
      method: 'GET',
      url: '/v1/admin/waitlist',
      schema: {
        querystring: AdminWaitlistQuerySchema,
        response: { 200: AdminWaitlistResponseSchema },
      },
      handler: async (request, reply) => {
        const { status, q, cursor, limit } = request.query;

        const after = cursor === undefined ? undefined : decodeSubscriberCursor(cursor);
        if (after === null) return badRequest(reply, 'cursor is not a cursor this API minted');

        const page = await deps.store.listSubscribers({ status, q, after, limit });
        // One grouped count for the whole page rather than one query per row.
        const sentCounts = await deps.store.countSentDeliveriesFor(page.rows.map((row) => row.id));

        const rows = page.rows.map((row) => ({
          id: row.id,
          email: row.email,
          source: row.source,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          sentCount: sentCounts.get(row.id) ?? 0,
        }));

        const last = page.rows.at(-1);
        if (!page.hasMore || last === undefined) return { rows };
        return { rows, nextCursor: encodeSubscriberCursor(last) };
      },
    });

    app.route({
      method: 'GET',
      url: '/v1/admin/waitlist/stats',
      schema: { response: { 200: WaitlistStatsResponseSchema } },
      handler: async () => {
        const counts = await deps.store.countSubscribersByStatus();
        const all = Object.values(counts).reduce((total, count) => total + count, 0);
        return { all, ...counts };
      },
    });

    app.route({
      method: 'POST',
      url: '/v1/admin/broadcasts',
      schema: {
        body: CreateBroadcastRequestSchema,
        headers: AdminActorSchema,
        response: { 200: BroadcastResponseSchema },
      },
      handler: async (request, reply) => {
        const audience = effectiveAudience(request.body.audience);
        if (audience.length === 0) {
          // A broadcast to nobody is never what an admin meant, so it fails rather than quietly
          // creating an empty send.
          return badRequest(reply, 'audience reaches no one a broadcast may be sent to');
        }

        const broadcast = await deps.store.createBroadcastWithSnapshot({
          subject: request.body.subject,
          bodyMarkdown: request.body.bodyMarkdown,
          // The effective audience is stored, not the requested one: the worker re-checks each
          // recipient's current status against this column, and the requested list would make
          // that check wrong.
          audience,
          teaserImageUrl: request.body.teaserImageUrl ?? null,
          createdBy: request.headers['x-admin-actor'],
        });

        // Enqueued only once the snapshot has committed. A durable job pointing at a broadcast
        // whose transaction rolled back would never find its rows.
        await deps.enqueuer.enqueue({
          workflowName: 'broadcastSend',
          queueName: EMAIL_QUEUE,
          workflowID: `broadcast:${broadcast.id}`,
          args: { broadcastId: broadcast.id },
        });

        return { id: broadcast.id, status: broadcast.status };
      },
    });

    app.route({
      method: 'POST',
      url: '/v1/admin/broadcasts/test',
      schema: { body: TestSendRequestSchema, response: { 200: TestSendResponseSchema } },
      handler: async (request) => {
        // No workflow id: a test send is deliberately repeatable. An admin who asks for a second
        // one wants a second email, so idempotency here would be a bug rather than a feature.
        await deps.enqueuer.enqueue({
          workflowName: 'broadcastTestSend',
          queueName: EMAIL_QUEUE,
          args: {
            subject: request.body.subject,
            bodyMarkdown: request.body.bodyMarkdown,
            teaserImageUrl: request.body.teaserImageUrl,
            to: request.body.to,
          },
        });

        return { enqueued: true } as const;
      },
    });

    app.route({
      method: 'GET',
      url: '/v1/admin/broadcasts',
      schema: { response: { 200: BroadcastListResponseSchema } },
      handler: async () => {
        const rows = await deps.store.listBroadcasts();
        return {
          rows: rows.map(({ broadcast, sentCount, failedCount }) => ({
            id: broadcast.id,
            subject: broadcast.subject,
            status: broadcast.status,
            recipientCount: broadcast.recipientCount,
            sentCount,
            failedCount,
            createdAt: broadcast.createdAt.toISOString(),
            createdBy: broadcast.createdBy,
          })),
        };
      },
    });

    app.route({
      method: 'GET',
      url: '/v1/admin/broadcasts/:id',
      schema: {
        params: BroadcastParamsSchema,
        response: { 200: BroadcastDetailResponseSchema },
      },
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
          createdBy: broadcast.createdBy,
          recipientCount: broadcast.recipientCount,
          createdAt: broadcast.createdAt.toISOString(),
          startedAt: broadcast.startedAt?.toISOString() ?? null,
          completedAt: broadcast.completedAt?.toISOString() ?? null,
          deliveryCounts: await deps.store.countDeliveries(broadcast.id),
        };
      },
    });
  };
}
