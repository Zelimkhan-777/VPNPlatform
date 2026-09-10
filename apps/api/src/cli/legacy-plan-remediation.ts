import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

type LegacyPlanRow = {
  id: string;
  code: string;
  name: string;
  subscriptionCount: bigint;
};

export type LegacyPlanRemediationInput = {
  keepPlanCode: string;
  deletePlanCodes: readonly string[];
  reason: string;
};

function normalizeCode(value: string, label: string): string {
  const code = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(code)) {
    throw new Error(`${label} must be a valid plan code`);
  }
  return code;
}

export async function remediateLegacyPlans(
  prisma: PrismaClient,
  input: LegacyPlanRemediationInput,
): Promise<number> {
  const keepPlanCode = normalizeCode(input.keepPlanCode, 'Keep plan code');
  const deletePlanCodes = input.deletePlanCodes.map((code) =>
    normalizeCode(code, 'Delete plan code'),
  );
  const reason = input.reason.trim();

  if (deletePlanCodes.length === 0) {
    throw new Error('At least one delete plan code is required');
  }
  if (new Set(deletePlanCodes).size !== deletePlanCodes.length) {
    throw new Error('Delete plan codes must be unique');
  }
  if (deletePlanCodes.includes(keepPlanCode)) {
    throw new Error('The kept plan cannot also be deleted');
  }
  if (reason.length < 10 || reason.length > 500) {
    throw new Error('Reason must contain between 10 and 500 characters');
  }

  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended('legacy-plan:remediate', 0))`,
    );
    await transaction.$executeRawUnsafe(`LOCK TABLE "Plan" IN EXCLUSIVE MODE`);

    const plans = await transaction.$queryRawUnsafe<LegacyPlanRow[]>(
      `SELECT plan."id"::text AS "id",
              plan."code",
              plan."name",
              count(subscription."id")::bigint AS "subscriptionCount"
       FROM "Plan" AS plan
       LEFT JOIN "Subscription" AS subscription
         ON subscription."planId" = plan."id"
       GROUP BY plan."id", plan."code", plan."name"
       ORDER BY plan."code"`,
    );

    const expectedCodes = [keepPlanCode, ...deletePlanCodes].sort();
    const actualCodes = plans.map((plan) => plan.code).sort();
    if (
      expectedCodes.length !== actualCodes.length ||
      expectedCodes.some((code, index) => code !== actualCodes[index])
    ) {
      throw new Error(
        'Plan inventory changed; remediation requires an exact reviewed plan set',
      );
    }

    const keptPlan = plans.find((plan) => plan.code === keepPlanCode);
    if (!keptPlan) throw new Error('The kept plan does not exist');

    const targets = plans.filter((plan) => deletePlanCodes.includes(plan.code));
    const referenced = targets.find((plan) => plan.subscriptionCount !== 0n);
    if (referenced) {
      throw new Error(
        `Plan ${referenced.code} has subscriptions and cannot be remediated`,
      );
    }

    const placeholders = targets.map((_, index) => `$${index + 1}::uuid`);
    const deleted = await transaction.$executeRawUnsafe(
      `DELETE FROM "Plan" WHERE "id" IN (${placeholders.join(', ')})`,
      ...targets.map((plan) => plan.id),
    );
    if (deleted !== targets.length) {
      throw new Error('Legacy plan set changed during remediation');
    }

    const audit = await transaction.auditEvent.createMany({
      data: targets.map((plan) => ({
        id: randomUUID(),
        actorUserId: null,
        action: 'legacy-plan-removed',
        entityType: 'Plan',
        entityId: plan.id,
        metadata: {
          planCode: plan.code,
          planName: plan.name,
          keptPlanCode: keepPlanCode,
          reason,
          source: 'admin:remediate-legacy-plans',
        },
      })),
    });
    if (audit.count !== targets.length) {
      throw new Error('Legacy plan audit set is incomplete');
    }

    return deleted;
  });
}
