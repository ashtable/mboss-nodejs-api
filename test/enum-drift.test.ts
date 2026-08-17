import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { $Enums } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  BroadcastStatusSchema,
  DeliveryStatusSchema,
  SubscriberSourceSchema,
  SubscriberStatusSchema,
} from '@mboss/zod';

/**
 * `mboss-zod` mirrors the Prisma enums
 * by hand — it is the wire and must not
 * depend on the database — and this repo
 * is the only one where both live. So
 * this is where the mirrors are checked
 * mechanically.
 *
 * The Prisma side is read from the schema
 * text rather than from the generated
 * client: the client reflects whatever
 * the last `prisma generate` produced,
 * and a drift test that can pass against
 * a stale artifact is not a drift test.
 * The generated client is checked too,
 * against the same text, which is what
 * catches a stale `node_modules`.
 */
const schemaPath = fileURLToPath(
  new URL('../mboss-database/prisma/schema.prisma', import.meta.url),
);
const source = readFileSync(schemaPath, 'utf8');

/**
 * Members of `enum <name> { ... }` in
 * declaration order, comments stripped.
 */
function prismaEnumMembers(name: string): string[] {
  const body = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(source)?.[1];
  if (body === undefined)
    throw new Error(`enum ${name} not found in schema.prisma`);
  return body
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0);
}

const pairs = [
  [
    'SubscriberStatus',
    SubscriberStatusSchema.options,
    Object.values($Enums.SubscriberStatus),
  ],
  [
    'SubscriberSource',
    SubscriberSourceSchema.options,
    Object.values($Enums.SubscriberSource),
  ],
  [
    'BroadcastStatus',
    BroadcastStatusSchema.options,
    Object.values($Enums.BroadcastStatus),
  ],
  [
    'DeliveryStatus',
    DeliveryStatusSchema.options,
    Object.values($Enums.DeliveryStatus),
  ],
] as const;

describe.each(pairs)('%s', (name, mirror, generated) => {
  it('the @mboss/zod mirror matches the nested Prisma schema, member for member and in order', () => {
    expect(mirror).toEqual(prismaEnumMembers(name));
  });

  it('the generated client is not stale relative to the schema', () => {
    expect(generated).toEqual(prismaEnumMembers(name));
  });
});
