import { describe, expect, it } from 'vitest';

import { effectiveAudience } from '../src/broadcast-status.js';

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
