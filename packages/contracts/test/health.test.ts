import { describe, expect, it } from 'vitest';

import { livenessResponseSchema, readinessResponseSchema } from '../src/health';

describe('health contracts', () => {
  it('accepts the liveness response', () => {
    expect(livenessResponseSchema.parse({ status: 'ok' })).toEqual({
      status: 'ok',
    });
  });

  it('rejects an incomplete readiness response', () => {
    expect(() =>
      readinessResponseSchema.parse({
        status: 'ready',
        dependencies: { postgres: 'up' },
      }),
    ).toThrow();
  });
});
