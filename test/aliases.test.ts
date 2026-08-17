import { describe, expect, it } from 'vitest';

import { parseKeyRing } from '@mboss/core/signed-links';
import { SubscriberStatusSchema } from '@mboss/zod';

/**
 * This repo is the first to consume nested submodules through path aliases, so the aliases
 * themselves get a test: a broken alias otherwise surfaces as a confusing resolution error deep
 * inside an unrelated suite.
 */
describe('nested submodule aliases', () => {
  it('resolves @mboss/zod', () => {
    expect(SubscriberStatusSchema.options).toEqual([
      'subscribed',
      'paused',
      'unsubscribed',
      'bounced',
    ]);
  });

  it('resolves the @mboss/core/signed-links subpath', () => {
    expect(parseKeyRing(`k1:${'a'.repeat(64)}`).active.kid).toBe('k1');
  });
});
