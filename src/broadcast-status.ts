import type { SubscriberStatus } from '@mboss/zod';

/**
 * The only two statuses a broadcast may reach. An unsubscribed address asked not to be written to
 * and a bounced one cannot be, so neither belongs in a recipient snapshot.
 */
const SENDABLE: SubscriberStatus[] = ['subscribed', 'paused'];

/**
 * Narrows a requested audience to what may actually be sent to. The wire schema deliberately does
 * not forbid the suppressed statuses — it describes the shape of a request, not the policy — so
 * the policy lives here, where it can be tested on its own.
 *
 * Filtering the allowlist rather than the request makes the result canonically ordered and
 * duplicate-free, so the stored `audience` column does not vary with how the request was written.
 */
export function effectiveAudience(requested: SubscriberStatus[]): SubscriberStatus[] {
  return SENDABLE.filter((status) => requested.includes(status));
}
