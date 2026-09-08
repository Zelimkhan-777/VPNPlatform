import { describe, expect, it, vi } from 'vitest';

import {
  capacityPolicyConfigSchema,
  healthPolicyConfigSchema,
  PrismaOperationalPolicyStore,
} from '../src/operational-policy';

const healthConfig = {
  heartbeatIntervalSeconds: 30,
  probeIntervalSeconds: 60,
  probeTimeoutSeconds: 10,
  probeSourceQuorum: 2,
  degradedFailureCycles: 2,
  excludeFailureCycles: 3,
  recoverySuccessCycles: 5,
  recoveryMinimumSeconds: 300,
  cooldownSeconds: 600,
  staleHeartbeatSeconds: 90,
  resultFreshnessSeconds: 90,
  mixedUnknownDegradedCycles: 2,
  additionalProbeDelaySeconds: 15,
  partialBlockedFailureCycles: 3,
  blockedTargetNetworkQuorum: 2,
  routeFailureClasses: ['DNS', 'TCP_TLS', 'VPN_HANDSHAKE', 'TEST_TRAFFIC'],
};

const capacityConfig = {
  runtimeFreshnessSeconds: 90,
  warningUtilizationPercent: 65,
  warningSustainSeconds: 600,
  stopAssignmentUtilizationPercent: 80,
  stopAssignmentSustainSeconds: 300,
  criticalUtilizationPercent: 90,
  criticalSustainSeconds: 300,
  recoveryBelowUtilizationPercent: 60,
  recoverySustainSeconds: 600,
  diskWarningFreePercent: 20,
  diskStopFreePercent: 10,
  trafficSnapshotFreshnessSeconds: 86_400,
  trafficForecastMinimumElapsedSeconds: 86_400,
  trafficWarningForecastPercent: 80,
  trafficStopActualPercent: 90,
  trafficStopForecastPercent: 100,
  overageOverrideMaximumSeconds: 86_400,
  plannedDrainDefaultSeconds: 86_400,
  plannedDrainMinimumSeconds: 3_600,
  plannedDrainMaximumSeconds: 259_200,
  promotionTargetSeconds: 120,
  promotionHardTimeoutSeconds: 300,
  reserveAggregateLoadPercent: 25,
  reserveLargestNodeMultiplierPercent: 125,
  reserveRequiresIndependentFailureDomain: true,
};

describe('operational policy store', () => {
  it('accepts the approved beta-v1 policy values', () => {
    expect(healthPolicyConfigSchema.parse(healthConfig)).toEqual(healthConfig);
    expect(capacityPolicyConfigSchema.parse(capacityConfig)).toEqual(
      capacityConfig,
    );
  });

  it.each([
    [
      'a health policy with unknown fields',
      healthPolicyConfigSchema,
      { ...healthConfig, arbitrary: 1 },
    ],
    [
      'reversed health thresholds',
      healthPolicyConfigSchema,
      { ...healthConfig, degradedFailureCycles: 3 },
    ],
    [
      'capacity policy without hysteresis',
      capacityPolicyConfigSchema,
      { ...capacityConfig, recoveryBelowUtilizationPercent: 65 },
    ],
    [
      'capacity policy with an invalid drain default',
      capacityPolicyConfigSchema,
      { ...capacityConfig, plannedDrainDefaultSeconds: 300_000 },
    ],
    [
      'capacity policy without failure-domain reserve',
      capacityPolicyConfigSchema,
      { ...capacityConfig, reserveRequiresIndependentFailureDomain: false },
    ],
  ])('rejects %s', (_name, schema, value) => {
    expect(() => schema.parse(value)).toThrow();
  });

  it('loads both active versions from one database snapshot', async () => {
    const query = vi.fn().mockResolvedValue([
      {
        kind: 'HEALTH',
        id: 'health-id',
        code: 'beta-v1',
        config: healthConfig,
      },
      {
        kind: 'CAPACITY',
        id: 'capacity-id',
        code: 'beta-v1',
        config: capacityConfig,
      },
    ]);
    const store = new PrismaOperationalPolicyStore({
      $queryRaw: query,
    } as never);

    await expect(store.loadActive()).resolves.toEqual({
      health: { id: 'health-id', code: 'beta-v1', config: healthConfig },
      capacity: { id: 'capacity-id', code: 'beta-v1', config: capacityConfig },
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it('fails closed when one active policy is missing', async () => {
    const store = new PrismaOperationalPolicyStore({
      $queryRaw: vi.fn().mockResolvedValue([
        {
          kind: 'HEALTH',
          id: 'health-id',
          code: 'beta-v1',
          config: healthConfig,
        },
      ]),
    } as never);

    await expect(store.loadActive()).rejects.toThrow(
      'Active operational policies are unavailable',
    );
  });

  it('fails closed when an active policy contains invalid data', async () => {
    const store = new PrismaOperationalPolicyStore({
      $queryRaw: vi.fn().mockResolvedValue([
        {
          kind: 'HEALTH',
          id: 'health-id',
          code: 'beta-v1',
          config: healthConfig,
        },
        {
          kind: 'CAPACITY',
          id: 'capacity-id',
          code: 'invalid-v1',
          config: { ...capacityConfig, warningUtilizationPercent: 95 },
        },
      ]),
    } as never);

    await expect(store.loadActive()).rejects.toThrow();
  });
});
