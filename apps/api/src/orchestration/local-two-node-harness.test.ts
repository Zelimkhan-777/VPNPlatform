import { describe, expect, it } from 'vitest';

import { access } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertLocalHarnessAllowed,
  localTwoNodeHarnessRoot,
  parseHarnessCommand,
} from './local-two-node-harness';

describe('local two-node harness', () => {
  it('parses provision and disable without treating quarantine as disable', () => {
    expect(parseHarnessCommand([])).toEqual({ action: 'provision' });
    expect(parseHarnessCommand(['provision'])).toEqual({ action: 'provision' });
    expect(parseHarnessCommand(['disable', 'a'])).toEqual({
      action: 'disable',
      slot: 'a',
    });
    expect(parseHarnessCommand(['--', 'disable', 'b'])).toEqual({
      action: 'disable',
      slot: 'b',
    });
    expect(() => parseHarnessCommand(['disable'])).toThrow(/slot a or b/);
    expect(() => parseHarnessCommand(['quarantine', 'a'])).toThrow(
      /provision or disable/,
    );
  });

  it('resolves the repository root from the harness module', async () => {
    await expect(
      access(join(localTwoNodeHarnessRoot(), 'pnpm-workspace.yaml')),
    ).resolves.toBeUndefined();
  });

  it('rejects production', () => {
    expect(() => assertLocalHarnessAllowed({ NODE_ENV: 'production' })).toThrow(
      /forbidden in production/,
    );
    expect(() =>
      assertLocalHarnessAllowed({ NODE_ENV: 'development' }),
    ).not.toThrow();
  });
});
