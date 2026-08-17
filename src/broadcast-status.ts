import type { DeliveryCounts, SubscriberStatus } from '@mboss/zod';

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

/**
 * A broadcast is `failed` only when every last delivery failed; anything short of that is `sent`.
 *
 * Two boundaries follow from that rule and are deliberate. A broadcast whose every recipient was
 * skipped resolves to `sent` — nobody was written to, but nothing went wrong either. So does one
 * with no deliveries at all. `sending` is never an outcome: it is the transient state a broadcast
 * passes through, not a state an admin has to act on.
 */
export function completeStatus(counts: DeliveryCounts): 'sent' | 'failed' {
  const total = counts.pending + counts.sent + counts.failed + counts.skipped;
  return total > 0 && counts.failed === total ? 'failed' : 'sent';
}
