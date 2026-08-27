import { describe, expect, it } from 'vitest';

import {
  effectiveSubscriptionStatus,
  hasEntitlement,
  isGrantConverged,
  isRouteReady,
  type SubscriptionLifecycleStatus,
} from '../src/access-policy';

const databaseTime = new Date('2026-08-26T12:00:00.000Z');

describe('access policy', () => {
  it.each([
    ['ACTIVE', '2026-08-26T12:00:00.001Z', 'ACTIVE'],
    ['ACTIVE', '2026-08-26T12:00:00.000Z', 'EXPIRED'],
    ['ACTIVE', '2026-08-26T11:59:59.999Z', 'EXPIRED'],
    ['ACTIVE', null, 'EXPIRED'],
    ['PENDING', '2099-01-01T00:00:00.000Z', 'PENDING'],
    ['EXPIRED', '2099-01-01T00:00:00.000Z', 'EXPIRED'],
    ['CANCELLED', '2099-01-01T00:00:00.000Z', 'CANCELLED'],
  ] as const)('maps %s with expiry %s to %s', (status, expiresAt, expected) => {
    expect(
      effectiveSubscriptionStatus(
        {
          status,
          expiresAt: expiresAt === null ? null : new Date(expiresAt),
        },
        databaseTime,
      ),
    ).toBe(expected);
  });

  it.each([
    ['ACTIVE', 'ACTIVE', '2026-08-26T12:00:00.001Z', true],
    ['REVOKED', 'ACTIVE', '2099-01-01T00:00:00.000Z', false],
    ['ACTIVE', 'ACTIVE', '2026-08-26T12:00:00.000Z', false],
    ['ACTIVE', 'EXPIRED', '2099-01-01T00:00:00.000Z', false],
    ['ACTIVE', 'CANCELLED', '2099-01-01T00:00:00.000Z', false],
  ] as const)(
    'evaluates device=%s subscription=%s expiry=%s as entitlement=%s',
    (deviceStatus, status, expiresAt, expected) => {
      expect(
        hasEntitlement(
          {
            deviceStatus,
            subscription: {
              status: status as SubscriptionLifecycleStatus,
              expiresAt: new Date(expiresAt),
            },
          },
          databaseTime,
        ),
      ).toBe(expected);
    },
  );

  it('keeps entitlement, convergence, and route readiness independent', () => {
    const grantConverged = isGrantConverged({
      status: 'ACTIVE',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      desiredVersion: 4,
      appliedVersion: 4,
      databaseTime,
    });
    expect(grantConverged).toBe(true);
    expect(
      isRouteReady({
        hasEntitlement: true,
        grantConverged,
        nodeStatus: 'HEALTHY',
        routeActive: true,
        routeActivationVersion: 5,
        nodeAppliedVersion: 4,
      }),
    ).toBe(false);
    expect(
      isRouteReady({
        hasEntitlement: true,
        grantConverged,
        nodeStatus: 'HEALTHY',
        routeActive: true,
        routeActivationVersion: 4,
        nodeAppliedVersion: 4,
      }),
    ).toBe(true);
  });
});
