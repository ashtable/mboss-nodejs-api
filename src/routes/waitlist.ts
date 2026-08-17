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

/**
 * What each manage action leaves the subscriber
 * in.
 */
const ACTIONS: Array<{ path: string; status: ManageStatus }> = [
  { path: 'pause', status: 'paused' },
  { path: 'resume', status: 'subscribed' },
  { path: 'unsubscribe', status: 'unsubscribed' },
];

/**
 * The public waitlist plugin: signup, and the
 * token-gated manage actions a link in an email
 * can perform without a login.
 */
export function waitlistRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (scope) => {
    const app = scope.withTypeProvider<ZodTypeProvider>();

    /**
     * Creates the subscriber, or brings one who
     * left the list back to subscribed.
     */
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

        // Signing up again is a request to be on
        // the list, so both of the statuses that
        // mean "off the list" answer it the same
        // way. `bounced` is included
        // deliberately: a delivery failure is the
        // provider's verdict on one send, and
        // someone typing their address in again
        // is fresh evidence against it. `paused`
        // is left alone — that subscriber asked
        // to be sent less, not nothing, and is
        // already on the list.
        const current =
          subscriber.status === 'unsubscribed' ||
          subscriber.status === 'bounced'
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

    /**
     * Read-only: what a manage link's owner sees,
     * without changing anything.
     */
    app.route({
      method: 'GET',
      url: '/v1/waitlist/manage/:token',
      schema: {
        params: ManageParamsSchema,
        response: { 200: ManageStateResponseSchema },
      },
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

    /**
     * One route per entry in ACTIONS — pause,
     * resume, unsubscribe are the same token
     * check followed by a different status.
     */
    for (const { path, status } of ACTIONS) {
      app.route({
        method: 'POST',
        url: `/v1/waitlist/manage/:token/${path}`,
        schema: {
          params: ManageParamsSchema,
          response: { 200: ManageActionResponseSchema },
        },
        handler: async (request, reply) => {
          const subscriber = await resolveManageToken(
            deps,
            request.params.token,
          );
          if (!subscriber) return notFound(reply);

          const updated = await deps.store.setSubscriberStatus(
            subscriber.id,
            status,
          );
          return { status: updated.status };
        },
      });
    }
  };
}

/**
 * Returns the subscriber a manage link names, or
 * null for every reason a link might not be
 * honoured — forged, signed by a retired key, the
 * wrong link type, pointing at nobody, or minted
 * before a bounce revoked it. The callers turn
 * all of them into the same 404, so a link pasted
 * out of an email never reveals which.
 *
 * The token version check lives here rather than
 * in the signed-links module: that module has no
 * database, so it can prove a token is authentic
 * but not whether it is still current.
 */
async function resolveManageToken(
  deps: RouteDeps,
  token: string,
): Promise<SubscriberRow | null> {
  const result = verifyLink(deps.keyRing, token, 'wl.manage');
  if (!result.ok) return null;

  const { payload } = result;
  // verifyLink already matched the type; this
  // narrows the payload union for the compiler.
  if (payload.t !== 'wl.manage') return null;

  const subscriber = await deps.store.findSubscriberById(payload.sub);
  if (!subscriber || subscriber.tokenVersion !== payload.tv) return null;

  return subscriber;
}

async function enqueueConfirmationIfDue(
  deps: RouteDeps,
  subscriber: SubscriberRow,
): Promise<void> {
  // Eligibility is decided here rather than in
  // the worker, which is decision-free by design,
  // so the rule lives in exactly one place. The
  // only bar is the resend window: a subscriber
  // who was just mailed is not mailed again,
  // however many times the form is submitted.
  if (
    !shouldEnqueueConfirmation(subscriber.confirmationEmailSentAt, deps.now())
  )
    return;

  const sendKey = deriveSendKey(subscriber.confirmationEmailSentAt);
  await deps.enqueuer.enqueue({
    workflowName: 'confirmationEmail',
    queueName: EMAIL_QUEUE,
    workflowID: `confirm:${subscriber.id}:${sendKey}`,
    args: { subscriberId: subscriber.id },
  });
}
