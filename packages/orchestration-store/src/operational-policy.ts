import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

const positiveDatabaseInteger = z.number().int().positive().max(2_147_483_647);
const percent = z.number().int().min(0).max(100);

export const healthPolicyConfigSchema = z
  .object({
    heartbeatIntervalSeconds: positiveDatabaseInteger,
    probeIntervalSeconds: positiveDatabaseInteger,
    probeTimeoutSeconds: positiveDatabaseInteger,
    probeSourceQuorum: positiveDatabaseInteger,
    degradedFailureCycles: positiveDatabaseInteger,
    excludeFailureCycles: positiveDatabaseInteger,
    recoverySuccessCycles: positiveDatabaseInteger,
    recoveryMinimumSeconds: positiveDatabaseInteger,
    cooldownSeconds: positiveDatabaseInteger,
    staleHeartbeatSeconds: positiveDatabaseInteger,
    resultFreshnessSeconds: positiveDatabaseInteger,
    mixedUnknownDegradedCycles: positiveDatabaseInteger,
    additionalProbeDelaySeconds: positiveDatabaseInteger,
    partialBlockedFailureCycles: positiveDatabaseInteger,
    blockedTargetNetworkQuorum: positiveDatabaseInteger,
    routeFailureClasses: z
      .array(z.enum(['DNS', 'TCP_TLS', 'VPN_HANDSHAKE', 'TEST_TRAFFIC']))
      .length(4)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.degradedFailureCycles >= policy.excludeFailureCycles) {
      context.addIssue({
        code: 'custom',
        path: ['degradedFailureCycles'],
        message: 'degraded threshold must precede exclusion threshold',
      });
    }
    if (policy.probeTimeoutSeconds >= policy.probeIntervalSeconds) {
      context.addIssue({
        code: 'custom',
        path: ['probeTimeoutSeconds'],
        message: 'probe timeout must be shorter than the probe interval',
      });
    }
  });

export const capacityPolicyConfigSchema = z
  .object({
    runtimeFreshnessSeconds: positiveDatabaseInteger,
    warningUtilizationPercent: percent,
    warningSustainSeconds: positiveDatabaseInteger,
    stopAssignmentUtilizationPercent: percent,
    stopAssignmentSustainSeconds: positiveDatabaseInteger,
    criticalUtilizationPercent: percent,
    criticalSustainSeconds: positiveDatabaseInteger,
    recoveryBelowUtilizationPercent: percent,
    recoverySustainSeconds: positiveDatabaseInteger,
    diskWarningFreePercent: percent,
    diskStopFreePercent: percent,
    trafficSnapshotFreshnessSeconds: positiveDatabaseInteger,
    trafficForecastMinimumElapsedSeconds: positiveDatabaseInteger,
    trafficWarningForecastPercent: percent,
    trafficStopActualPercent: percent,
    trafficStopForecastPercent: z.number().int().min(0),
    overageOverrideMaximumSeconds: positiveDatabaseInteger,
    plannedDrainDefaultSeconds: positiveDatabaseInteger,
    plannedDrainMinimumSeconds: positiveDatabaseInteger,
    plannedDrainMaximumSeconds: positiveDatabaseInteger,
    promotionTargetSeconds: positiveDatabaseInteger,
    promotionHardTimeoutSeconds: positiveDatabaseInteger,
    reserveAggregateLoadPercent: percent,
    reserveLargestNodeMultiplierPercent: z.number().int().min(100),
    reserveRequiresIndependentFailureDomain: z.literal(true),
  })
  .strict()
  .superRefine((policy, context) => {
    if (!(
      policy.recoveryBelowUtilizationPercent <
        policy.warningUtilizationPercent &&
      policy.warningUtilizationPercent <
        policy.stopAssignmentUtilizationPercent &&
      policy.stopAssignmentUtilizationPercent <
        policy.criticalUtilizationPercent
    )) {
      context.addIssue({
        code: 'custom',
        path: ['warningUtilizationPercent'],
        message: 'capacity thresholds must preserve recovery hysteresis',
      });
    }
    if (policy.diskStopFreePercent >= policy.diskWarningFreePercent) {
      context.addIssue({
        code: 'custom',
        path: ['diskStopFreePercent'],
        message: 'disk stop threshold must be below its warning threshold',
      });
    }
    if (
      policy.plannedDrainMinimumSeconds > policy.plannedDrainDefaultSeconds ||
      policy.plannedDrainDefaultSeconds > policy.plannedDrainMaximumSeconds
    ) {
      context.addIssue({
        code: 'custom',
        path: ['plannedDrainDefaultSeconds'],
        message: 'planned drain default must be within its allowed range',
      });
    }
    if (policy.promotionTargetSeconds >= policy.promotionHardTimeoutSeconds) {
      context.addIssue({
        code: 'custom',
        path: ['promotionTargetSeconds'],
        message: 'promotion target must precede its hard timeout',
      });
    }
  });

export type HealthPolicyConfig = z.infer<typeof healthPolicyConfigSchema>;
export type CapacityPolicyConfig = z.infer<typeof capacityPolicyConfigSchema>;

export type ActiveOperationalPolicies = {
  health: { id: string; code: string; config: HealthPolicyConfig };
  capacity: { id: string; code: string; config: CapacityPolicyConfig };
};

type PolicyRow = {
  kind: 'HEALTH' | 'CAPACITY';
  id: string;
  code: string;
  config: Prisma.JsonValue;
};

export class PrismaOperationalPolicyStore {
  constructor(private readonly prisma: PrismaClient) {}

  async loadActive(): Promise<ActiveOperationalPolicies> {
    const rows = await this.prisma.$queryRaw<PolicyRow[]>`
      WITH latest_health AS (
        SELECT version.id, version.code, version.config
        FROM "HealthPolicyActivation" AS activation
        INNER JOIN "HealthPolicyVersion" AS version
          ON version.id = activation."policyVersionId"
        ORDER BY activation.sequence DESC
        LIMIT 1
      ), latest_capacity AS (
        SELECT version.id, version.code, version.config
        FROM "CapacityPolicyActivation" AS activation
        INNER JOIN "CapacityPolicyVersion" AS version
          ON version.id = activation."policyVersionId"
        ORDER BY activation.sequence DESC
        LIMIT 1
      )
      SELECT 'HEALTH' AS kind, id::text, code, config FROM latest_health
      UNION ALL
      SELECT 'CAPACITY' AS kind, id::text, code, config FROM latest_capacity
    `;
    const health = rows.find((row) => row.kind === 'HEALTH');
    const capacity = rows.find((row) => row.kind === 'CAPACITY');
    if (!health || !capacity) {
      throw new Error('Active operational policies are unavailable');
    }

    return {
      health: {
        id: health.id,
        code: health.code,
        config: healthPolicyConfigSchema.parse(health.config),
      },
      capacity: {
        id: capacity.id,
        code: capacity.code,
        config: capacityPolicyConfigSchema.parse(capacity.config),
      },
    };
  }
}
