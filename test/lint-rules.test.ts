import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * A lint rule nobody has watched fire is a comment. These lint real source text through the
 * repo's own flat config, so the assertion is about behaviour rather than about the config object.
 */
const eslint = new ESLint();

async function restrictedImportRules(source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: 'src/probe.ts' });
  return (result?.messages ?? [])
    .map((message) => message.ruleId)
    .filter((ruleId): ruleId is string => ruleId === 'no-restricted-imports');
}

describe('@mboss/core import restriction', () => {
  it('blocks the barrel', async () => {
    expect(await restrictedImportRules("import { mintLink } from '@mboss/core';\n")).toContain(
      'no-restricted-imports',
    );
  });

  it('blocks a subpath that is not signed-links', async () => {
    expect(await restrictedImportRules("import { layout } from '@mboss/core/layout';\n")).toContain(
      'no-restricted-imports',
    );
  });

  it('allows @mboss/core/signed-links', async () => {
    expect(
      await restrictedImportRules("import { mintLink } from '@mboss/core/signed-links';\n"),
    ).toHaveLength(0);
  });
});
