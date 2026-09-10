import { describe, expect, it, vi } from 'vitest';

import {
  ensureVpnNodeLocationPoolMembership,
  promoteVpnNodePoolMembershipToServing,
} from './vpn-node-location-pool';

const polandPool = {
  code: 'poland',
  publicLabel: 'Poland',
  candidateLimit: 2,
  role: 'STANDBY' as const,
};

describe('vpn-node location pool', () => {
  it('creates a new Poland pool membership as STANDBY', async () => {
    const prisma = {
      locationPoolMembership: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'membership-1' }),
      },
      locationPool: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'pool-1' }),
      },
      healthPolicyActivation: {
        findFirstOrThrow: vi
          .fn()
          .mockResolvedValue({ policyVersionId: 'health-1' }),
      },
      capacityPolicyActivation: {
        findFirstOrThrow: vi
          .fn()
          .mockResolvedValue({ policyVersionId: 'capacity-1' }),
      },
    };

    await expect(
      ensureVpnNodeLocationPoolMembership(
        prisma as never,
        'node-1',
        'vpn-pl-1',
        polandPool,
      ),
    ).resolves.toEqual({
      poolCode: 'poland',
      role: 'STANDBY',
      created: true,
    });
    expect(prisma.locationPoolMembership.create).toHaveBeenCalledWith({
      data: {
        locationPoolId: 'pool-1',
        nodeId: 'node-1',
        role: 'STANDBY',
      },
    });
  });

  it('keeps an existing matching membership and refuses a different pool', async () => {
    const matching = {
      locationPoolMembership: {
        findUnique: vi.fn().mockResolvedValue({
          role: 'STANDBY',
          locationPool: { code: 'poland' },
        }),
        create: vi.fn(),
      },
    };
    await expect(
      ensureVpnNodeLocationPoolMembership(
        matching as never,
        'node-1',
        'vpn-pl-1',
        polandPool,
      ),
    ).resolves.toEqual({
      poolCode: 'poland',
      role: 'STANDBY',
      created: false,
    });
    expect(matching.locationPoolMembership.create).not.toHaveBeenCalled();

    const conflicting = {
      locationPoolMembership: {
        findUnique: vi.fn().mockResolvedValue({
          role: 'SERVING',
          locationPool: { code: 'legacy-finland' },
        }),
        create: vi.fn(),
      },
    };
    await expect(
      ensureVpnNodeLocationPoolMembership(
        conflicting as never,
        'node-1',
        'vpn-fi-1',
        polandPool,
      ),
    ).rejects.toThrow(/different location pool/);
    expect(conflicting.locationPoolMembership.create).not.toHaveBeenCalled();
  });

  it('promotes a converged STANDBY node and is idempotent for SERVING', async () => {
    const serving = {
      node: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'node-1',
          name: 'vpn-pl-1',
          status: 'HEALTHY',
          desiredConfigVersion: 2,
          appliedConfigVersion: 2,
          lastHeartbeatAt: new Date('2026-09-11T00:00:00.000Z'),
          locationPoolMembership: {
            id: 'membership-1',
            role: 'SERVING',
            locationPool: {
              code: 'poland',
              healthPolicyVersion: {
                config: { staleHeartbeatSeconds: 90 },
              },
            },
          },
        }),
      },
    };
    await expect(
      promoteVpnNodePoolMembershipToServing(
        serving as never,
        'vpn-pl-1',
        new Date('2026-09-11T00:00:30.000Z'),
      ),
    ).resolves.toEqual({
      nodeName: 'vpn-pl-1',
      poolCode: 'poland',
      role: 'SERVING',
    });

    const transaction = {
      locationPoolMembership: { update: vi.fn() },
      auditEvent: { create: vi.fn() },
    };
    const standby = {
      node: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'node-1',
          name: 'vpn-pl-1',
          status: 'HEALTHY',
          desiredConfigVersion: 2,
          appliedConfigVersion: 2,
          lastHeartbeatAt: new Date('2026-09-11T00:00:00.000Z'),
          locationPoolMembership: {
            id: 'membership-1',
            role: 'STANDBY',
            locationPool: {
              code: 'poland',
              healthPolicyVersion: {
                config: {
                  heartbeatIntervalSeconds: 30,
                  probeIntervalSeconds: 60,
                  probeTimeoutSeconds: 10,
                  probeSourceQuorum: 2,
                  degradedFailureCycles: 2,
                  excludeFailureCycles: 4,
                  recoverySuccessCycles: 2,
                  recoveryMinimumSeconds: 60,
                  cooldownSeconds: 60,
                  staleHeartbeatSeconds: 90,
                  resultFreshnessSeconds: 90,
                  mixedUnknownDegradedCycles: 3,
                  additionalProbeDelaySeconds: 5,
                  partialBlockedFailureCycles: 3,
                  blockedTargetNetworkQuorum: 2,
                  routeFailureClasses: [
                    'DNS',
                    'TCP_TLS',
                    'VPN_HANDSHAKE',
                    'TEST_TRAFFIC',
                  ],
                },
              },
            },
          },
        }),
      },
      $transaction: vi.fn(
        async (callback: (client: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };

    await expect(
      promoteVpnNodePoolMembershipToServing(
        standby as never,
        'vpn-pl-1',
        new Date('2026-09-11T00:00:30.000Z'),
      ),
    ).resolves.toEqual({
      nodeName: 'vpn-pl-1',
      poolCode: 'poland',
      role: 'SERVING',
    });
    expect(transaction.locationPoolMembership.update).toHaveBeenCalledWith({
      where: { id: 'membership-1' },
      data: { role: 'SERVING' },
    });
  });

  it('refuses promotion when heartbeat is stale or versions have not converged', async () => {
    const prisma = {
      node: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'node-1',
          name: 'vpn-pl-1',
          status: 'HEALTHY',
          desiredConfigVersion: 3,
          appliedConfigVersion: 2,
          lastHeartbeatAt: new Date('2026-09-11T00:00:00.000Z'),
          locationPoolMembership: {
            id: 'membership-1',
            role: 'STANDBY',
            locationPool: {
              code: 'poland',
              healthPolicyVersion: {
                config: { staleHeartbeatSeconds: 90 },
              },
            },
          },
        }),
      },
    };

    await expect(
      promoteVpnNodePoolMembershipToServing(prisma as never, 'vpn-pl-1'),
    ).rejects.toThrow(/has not converged/);
  });
});
