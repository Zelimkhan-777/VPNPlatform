import { describe, expect, it } from 'vitest';

import { parseOrchestrationStoreEnvironment } from '../src/environment';

describe('orchestration store environment', () => {
  it('keeps the shared lease and attempt defaults', () => {
    expect(parseOrchestrationStoreEnvironment({})).toEqual({
      ORCHESTRATION_LEASE_DURATION_MS: 30_000,
      ORCHESTRATION_MAX_ATTEMPTS: 5,
    });
  });

  it.each([
    {
      leaseDuration: '1000',
      maxAttempts: '1',
      expectedLeaseDuration: 1_000,
      expectedMaxAttempts: 1,
    },
    {
      leaseDuration: '300000',
      maxAttempts: '100',
      expectedLeaseDuration: 300_000,
      expectedMaxAttempts: 100,
    },
  ])(
    'accepts inclusive policy boundaries',
    ({
      leaseDuration,
      maxAttempts,
      expectedLeaseDuration,
      expectedMaxAttempts,
    }) => {
      expect(
        parseOrchestrationStoreEnvironment({
          ORCHESTRATION_LEASE_DURATION_MS: leaseDuration,
          ORCHESTRATION_MAX_ATTEMPTS: maxAttempts,
        }),
      ).toEqual({
        ORCHESTRATION_LEASE_DURATION_MS: expectedLeaseDuration,
        ORCHESTRATION_MAX_ATTEMPTS: expectedMaxAttempts,
      });
    },
  );

  it.each([
    ['lease below minimum', { ORCHESTRATION_LEASE_DURATION_MS: '999' }],
    ['lease above maximum', { ORCHESTRATION_LEASE_DURATION_MS: '300001' }],
    ['fractional lease', { ORCHESTRATION_LEASE_DURATION_MS: '1000.5' }],
    ['attempts below minimum', { ORCHESTRATION_MAX_ATTEMPTS: '0' }],
    ['attempts above maximum', { ORCHESTRATION_MAX_ATTEMPTS: '101' }],
    ['fractional attempts', { ORCHESTRATION_MAX_ATTEMPTS: '1.5' }],
  ])('rejects %s', (_name, environment) => {
    expect(() => parseOrchestrationStoreEnvironment(environment)).toThrow();
  });
});
