import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { verifyLink } from '@mboss/core/signed-links';
import {
  ManageActionResponseSchema,
  ManageStateResponseSchema,
  WaitlistSignupRequestSchema,
  WaitlistSignupResponseSchema,
} from '@mboss/zod';

import { notFound } from '../errors.js';
import { deriveSendKey, shouldEnqueueConfirmation } from '../send-key.js';
import type { ManageStatus, SubscriberRow } from '../store/types.js';
import type { RouteDeps } from './deps.js';

export const EMAIL_QUEUE = 'email';

const ManageParamsSchema = z.object({ token: z.string().min(1) });

/** What each manage action leaves the subscriber in. */
const ACTIONS: Array<{ path: string; status: ManageStatus }> = [
  { path: 'pause', status: 'paused' },
  { path: 'resume', status: 'subscribed' },
  { path: 'unsubscribe', status: 'unsubscribed' },
];

export function waitlistRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (scope) => {
    const app = scope.withTypeProvider<ZodTypeProvider>();

    app.route({
      method: 'POST',
      url: '/v1/waitlist/signups',
      schema: {
        body: WaitlistSignupRequestSchema,
        response: { 200: WaitlistSignupResponseSchema },
      },
      handler: async (request) => {
        const { email } = request.body;
        const { subscriber } = await deps.store.findOrCreateSubscriber(email);

        // Only `unsubscribed` re-subscribes. A paused subscriber asked to be sent less, not
        // nothing, and signing up again does not undo a bounce — a suppressed address stays
        // suppressed until the provider says otherwise.
        const current =
          subscriber.status === 'unsubscribed'
            ? await deps.store.setSubscriberStatus(subscriber.id, 'subscribed')
            : subscriber;

        await enqueueConfirmationIfDue(deps, current);

        return {
          email: current.email,
          status: current.status,
          subscribedAt: current.createdAt.toISOString(),
        };
      },
    });

    app.route({
      method: 'GET',
      url: '/v1/waitlist/manage/:token',
      schema: { params: ManageParamsSchema, response: { 200: ManageStateResponseSchema } },
      handler: async (request, reply) => {
        const subscriber = await resolveManageToken(deps, request.params.token);
        if (!subscriber) return notFound(reply);

        return {
          email: subscriber.email,
          status: subscriber.status,
          subscribedAt: subscriber.createdAt.toISOString(),
        };
      },
    });

    for (const { path, status } of ACTIONS) {
      app.route({
        method: 'POST',
        url: `/v1/waitlist/manage/:token/${path}`,
        schema: { params: ManageParamsSchema, response: { 200: ManageActionResponseSchema } },
        handler: async (request, reply) => {
          const subscriber = await resolveManageToken(deps, request.params.token);
          if (!subscriber) return notFound(reply);

          const updated = await deps.store.setSubscriberStatus(subscriber.id, status);
          return { status: updated.status };
        },
      });
    }
  };
}

/**
 * Returns the subscriber a manage link names, or null for every reason a link might not be
 * honoured — forged, signed by a retired key, the wrong link type, pointing at nobody, or minted
 * before a bounce revoked it. The callers turn all of them into the same 404, so a link pasted out
 * of an email never reveals which.
 *
 * The token version check lives here rather than in the signed-links module: that module has no
 * database, so it can prove a token is authentic but not whether it is still current.
 */
async function resolveManageToken(deps: RouteDeps, token: string): Promise<SubscriberRow | null> {
  const result = verifyLink(deps.keyRing, token, 'wl.manage');
  if (!result.ok) return null;

  const { payload } = result;
  // verifyLink already matched the type; this narrows the payload union for the compiler.
  if (payload.t !== 'wl.manage') return null;

  const subscriber = await deps.store.findSubscriberById(payload.sub);
  if (!subscriber || subscriber.tokenVersion !== payload.tv) return null;

  return subscriber;
}

async function enqueueConfirmationIfDue(deps: RouteDeps, subscriber: SubscriberRow): Promise<void> {
  // A bounced address is never mailed again. That status is only ever set from a provider bounce
  // or spam report, and setting it already revoked this subscriber's live links, so sending to it
  // again is exactly the reputational damage the status exists to prevent. The check belongs here
  // rather than in the worker: the worker is decision-free by design, so resend eligibility is
  // decided in one place, and this route is it.
  if (subscriber.status === 'bounced') return;

  if (!shouldEnqueueConfirmation(subscriber.confirmationEmailSentAt, deps.now())) return;

  const sendKey = deriveSendKey(subscriber.confirmationEmailSentAt);
  await deps.enqueuer.enqueue({
    workflowName: 'confirmationEmail',
    queueName: EMAIL_QUEUE,
    workflowID: `confirm:${subscriber.id}:${sendKey}`,
    args: { subscriberId: subscriber.id },
  });
}
