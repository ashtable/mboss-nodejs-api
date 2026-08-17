const RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The variable part of a confirmation workflow's id. A fixed id per subscriber would make a
 * deliberate resend dead code, because workflow-id idempotency is permanent rather than
 * in-flight-only: the second enqueue would attach to the finished first workflow and send nothing.
 * Keying on the previous send's timestamp gives every resend a fresh workflow while collapsing
 * repeat submits within one window onto the same one.
 */
export function deriveSendKey(confirmationEmailSentAt: Date | null): number {
  return confirmationEmailSentAt === null
    ? 0
    : Math.floor(confirmationEmailSentAt.getTime() / 1000);
}

/**
 * Whether a signup should enqueue anything at all. Resend eligibility is decided here and nowhere
 * else — the worker receives only a subscriber id and never learns why it was asked to send — so a
 * repeat signup inside the window enqueues nothing rather than relying on the queue to absorb it.
 *
 * Strictly more than 24h: a signup at exactly the boundary is a repeat, not a resend.
 */
export function shouldEnqueueConfirmation(
  confirmationEmailSentAt: Date | null,
  now: Date,
): boolean {
  return (
    confirmationEmailSentAt === null ||
    now.getTime() - confirmationEmailSentAt.getTime() > RESEND_WINDOW_MS
  );
}
