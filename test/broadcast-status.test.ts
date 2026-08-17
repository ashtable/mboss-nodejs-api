import { describe, expect, it } from 'vitest';

import type { DeliveryCounts } from '@mboss/zod';

import { completeStatus, effectiveAudience } from '../src/broadcast-status.js';

describe('effectiveAudience', () => {
  it('keeps the two statuses a broadcast may reach', () => {
    expect(effectiveAudience(['subscribed', 'paused'])).toEqual(['subscribed', 'paused']);
  });

  it('drops unsubscribed and bounced', () => {
    expect(effectiveAudience(['subscribed', 'unsubscribed', 'bounced'])).toEqual(['subscribed']);
  });

  it('is empty when nothing requested may be reached', () => {
    expect(effectiveAudience(['unsubscribed', 'bounced'])).toEqual([]);
  });

  it('is canonically ordered and deduplicated, whatever the request looked like', () => {
    expect(effectiveAudience(['paused', 'subscribed', 'paused'])).toEqual(['subscribed', 'paused']);
  });
});

describe('completeStatus', () => {
  const counts = (over: Partial<DeliveryCounts> = {}): DeliveryCounts => ({
    pending: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    ...over,
  });

  it.each([
    ['every delivery sent', counts({ sent: 3 }), 'sent'],
    ['every delivery failed', counts({ failed: 3 }), 'failed'],
    ['a mix of sent and failed', counts({ sent: 2, failed: 1 }), 'sent'],
    ['failures alongside skips', counts({ failed: 1, skipped: 2 }), 'sent'],
    ['every delivery skipped', counts({ skipped: 3 }), 'sent'],
    ['no deliveries at all', counts(), 'sent'],
  ])('%s resolves to %s', (_label, given, expected) => {
    expect(completeStatus(given)).toBe(expected);
  });
});
