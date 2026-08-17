import type { SubscriberCursor } from './store/types.js';

const SEPARATOR = '|';

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * Node's base64url decoder drops invalid
 * characters rather than throwing, so decoding
 * alone proves nothing. Re-encoding and comparing
 * is the real check: only canonical base64url
 * survives it.
 */
function decode(raw: string): string | null {
  const bytes = Buffer.from(raw, 'base64url');
  return bytes.toString('base64url') === raw ? bytes.toString('utf8') : null;
}

/**
 * The admin list is ordered by `createdAt`
 * descending, and `createdAt` is not unique — two
 * people can sign up in the same millisecond.
 * Carrying the id alongside it gives the keyset a
 * total order, so a page boundary can never skip
 * or repeat a row.
 */
export function encodeSubscriberCursor(position: SubscriberCursor): string {
  return encode(
    `${position.createdAt.toISOString()}${SEPARATOR}${position.id}`,
  );
}

export function decodeSubscriberCursor(raw: string): SubscriberCursor | null {
  const decoded = decode(raw);
  if (decoded === null) return null;

  const separator = decoded.indexOf(SEPARATOR);
  if (separator === -1) return null;

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;

  return { createdAt, id };
}

/**
 * Deliveries page on their own id, which is
 * already a total order — no tiebreaker needed.
 */
export function encodeIdCursor(id: string): string {
  return encode(id);
}

export function decodeIdCursor(raw: string): string | null {
  const decoded = decode(raw);
  return decoded === null || decoded.length === 0 ? null : decoded;
}
