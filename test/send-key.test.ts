import { describe, expect, it } from 'vitest';

import { deriveSendKey, shouldEnqueueConfirmation } from '../src/send-key.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('deriveSendKey', () => {
  it('is 0 for a subscriber who has never been sent a confirmation', () => {
    expect(deriveSendKey(null)).toBe(0);
  });

  it('is the epoch seconds of the existing timestamp, floored', () => {
    expect(deriveSendKey(new Date(1_700_000_000_999))).toBe(1_700_000_000);
  });
});

describe('shouldEnqueueConfirmation', () => {
  const now = new Date('2026-08-16T00:00:00.000Z');

  it('enqueues the first send', () => {
    expect(shouldEnqueueConfirmation(null, now)).toBe(true);
  });

  it('does not enqueue inside the window', () => {
    expect(shouldEnqueueConfirmation(new Date(now.getTime() - 60_000), now)).toBe(false);
  });

  it('does not enqueue at exactly 24h — the rule is more than 24h old', () => {
    expect(shouldEnqueueConfirmation(new Date(now.getTime() - DAY_MS), now)).toBe(false);
  });

  it('enqueues one millisecond past 24h', () => {
    expect(shouldEnqueueConfirmation(new Date(now.getTime() - DAY_MS - 1), now)).toBe(true);
  });
});
