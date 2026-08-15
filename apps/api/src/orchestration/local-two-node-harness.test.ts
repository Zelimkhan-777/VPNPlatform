import { describe, expect, it } from 'vitest';

import {
  assertLocalHarnessAllowed,
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

  it('rejects production', () => {
    expect(() => assertLocalHarnessAllowed({ NODE_ENV: 'production' })).toThrow(
      /forbidden in production/,
    );
    expect(() =>
      assertLocalHarnessAllowed({ NODE_ENV: 'development' }),
    ).not.toThrow();
  });
});
