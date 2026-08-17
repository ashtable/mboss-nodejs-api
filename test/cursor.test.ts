import { describe, expect, it } from 'vitest';

import {
  decodeIdCursor,
  decodeSubscriberCursor,
  encodeIdCursor,
  encodeSubscriberCursor,
} from '../src/cursor.js';

describe('subscriber cursor', () => {
  const position = { createdAt: new Date('2026-08-16T12:34:56.789Z'), id: 'sub_1' };

  it('round-trips a keyset position', () => {
    expect(decodeSubscriberCursor(encodeSubscriberCursor(position))).toEqual(position);
  });

  it('is opaque — the position is not readable from the cursor', () => {
    expect(encodeSubscriberCursor(position)).not.toContain('sub_1');
  });

  it.each([
    ['not base64url at all', 'not a cursor!!'],
    ['base64url of something with no separator', Buffer.from('nope').toString('base64url')],
    ['base64url of an unparseable date', Buffer.from('never|sub_1').toString('base64url')],
    ['base64url with an empty id', Buffer.from('2026-08-16T00:00:00.000Z|').toString('base64url')],
  ])('rejects %s', (_label, raw) => {
    expect(decodeSubscriberCursor(raw)).toBeNull();
  });
});

describe('id cursor', () => {
  it('round-trips an id', () => {
    expect(decodeIdCursor(encodeIdCursor('del_0007'))).toBe('del_0007');
  });

  it('rejects a malformed cursor', () => {
    expect(decodeIdCursor('not a cursor!!')).toBeNull();
  });
});
