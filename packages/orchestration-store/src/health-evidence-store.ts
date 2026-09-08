import { createHash, randomUUID } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

import {
  HEALTH_SCOPE_KINDS,
  ROUTE_FAILURE_CLASSES,
  type HealthDecision,
  type HealthDecisionState,
  type HealthScopeKind,
  type ProbeSignal,
} from './health-decision';

const scopeSchema = z.object({
  kind: z.enum(HEALTH_SCOPE_KINDS),
  id: z.string().trim().min(1).max(128),
});
const recordProbeResultSchema = z
  .object({
    probeSourceId: z.uuid(),
    sourceResultId: z.string().trim().min(1).max(128),
    affectedScope: scopeSchema,
    cycleStartedAt: z.date(),
    routeVersion: z.number().int().nonnegative(),
    outcome: z.enum(['SUCCESS', 'FAILURE', 'PROBE_SOURCE_FAILURE']),
    failureClass: z.enum(ROUTE_FAILURE_CLASSES).optional(),
    controlHealthy: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.outcome === 'FAILURE') !== (value.failureClass !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['failureClass'],
        message: 'failureClass must be present only for route failures',
      });
    }
  });

export type RecordProbeResultInput = z.infer<typeof recordProbeResultSchema>;

export type RecordedProbeResult = {
  signal: ProbeSignal;
  replayed: boolean;
};

export type PersistedHealthState = {
  state: HealthDecisionState;
  version: bigint;
};

export type AppliedHealthDecision = {
  decisionId: string;
  idempotencyKey: string;
  stateVersion: bigint;
  replayed: boolean;
};

type ProbeResultRow = {
  id: string;
  probeSourceId: string;
  sourceResultId: string;
  sourceIndependenceKey: string;
  scopeKind: HealthScopeKind;
  scopeKey: string;
  cycleStartedAt: Date;
  routeVersion: number;
  outcome: ProbeSignal['outcome'];
  failureClass: ProbeSignal['failureClass'] | null;
  controlHealthy: boolean;
  receivedAt: Date;
};

type StateRow = {
  id: string;
  status: HealthDecisionState['status'];
  excludedFromCandidates: boolean;
  consecutiveFailureCycles: number;
  consecutiveRecoverySuccesses: number;
  recoveryWindowStartedAt: Date | null;
  consecutiveUncertainCycles: number;
  cooldownUntil: Date | null;
  version: bigint;
};

const probeRowToSignal = (row: ProbeResultRow): ProbeSignal => ({
  id: row.id,
  sourceId: row.probeSourceId,
  independenceKey: row.sourceIndependenceKey,
  cycleStartedAt: row.cycleStartedAt,
  receivedAt: row.receivedAt,
  authenticated: true,
  controlHealthy: row.controlHealthy,
  routeVersion: row.routeVersion,
  outcome: row.outcome,
  ...(row.failureClass ? { failureClass: row.failureClass } : {}),
});

const rowToState = (row: StateRow): PersistedHealthState => ({
  state: {
    status: row.status,
    excludedFromCandidates: row.excludedFromCandidates,
    consecutiveFailureCycles: row.consecutiveFailureCycles,
    consecutiveRecoverySuccesses: row.consecutiveRecoverySuccesses,
    recoveryWindowStartedAt: row.recoveryWindowStartedAt,
    consecutiveUncertainCycles: row.consecutiveUncertainCycles,
    cooldownUntil: row.cooldownUntil,
  },
  version: row.version,
});

const decisionIdempotencyKey = (
  expectedVersion: bigint,
  decision: HealthDecision,
) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        expectedVersion: expectedVersion.toString(),
        decision: decision.decision,
        reason: decision.reason,
        affectedScope: decision.affectedScope,
        policyVersion: decision.policyVersion,
        signalIds: [...decision.signalIds].sort(),
        cycle: decision.cycle
          ? {
              cycleStartedAt: decision.cycle.cycleStartedAt.toISOString(),
              decision: decision.cycle.decision,
              failureClass: decision.cycle.failureClass,
              signalIds: [...decision.cycle.signalIds].sort(),
              rejectedSignalIds: [...decision.cycle.rejectedSignalIds].sort(),
              additionalProbeDueAt:
                decision.cycle.additionalProbeDueAt?.toISOString() ?? null,
            }
          : null,
        state: {
          ...decision.state,
          recoveryWindowStartedAt:
            decision.state.recoveryWindowStartedAt?.toISOString() ?? null,
          cooldownUntil: decision.state.cooldownUntil?.toISOString() ?? null,
        },
        allowNewAssignments: decision.allowNewAssignments,
        triggerReplacement: decision.triggerReplacement,
        triggerIncident: decision.triggerIncident,
      }),
    )
    .digest('hex');

const isSerializationFailure = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.code === 'P2034' || candidate.meta?.code === '40001';
};

export class PrismaHealthEvidenceStore {
  constructor(private readonly prisma: PrismaClient) {}

  async recordProbeResult(
    untrustedInput: RecordProbeResultInput,
  ): Promise<RecordedProbeResult> {
    const input = recordProbeResultSchema.parse(untrustedInput);
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${`${input.probeSourceId}:${input.sourceResultId}`},
            0
          )
        )
      `;
      const existing = await transaction.$queryRaw<ProbeResultRow[]>`
        SELECT
          result.id::text,
          result."probeSourceId"::text,
          result."sourceResultId",
          result."sourceIndependenceKey",
          result."scopeKind"::text AS "scopeKind",
          result."scopeKey",
          result."cycleStartedAt",
          result."routeVersion",
          result.outcome::text,
          result."failureClass"::text AS "failureClass",
          result."controlHealthy",
          result."receivedAt"
        FROM "ProbeResult" AS result
        WHERE result."probeSourceId" = CAST(${input.probeSourceId} AS uuid)
          AND result."sourceResultId" = ${input.sourceResultId}
      `;
      if (existing[0]) {
        const row = existing[0];
        const exactRetry =
          row.scopeKind === input.affectedScope.kind &&
          row.scopeKey === input.affectedScope.id &&
          row.cycleStartedAt.getTime() === input.cycleStartedAt.getTime() &&
          row.routeVersion === input.routeVersion &&
          row.outcome === input.outcome &&
          (row.failureClass ?? undefined) === input.failureClass &&
          row.controlHealthy === input.controlHealthy;
        if (!exactRetry) {
          throw new Error('Probe result replay key conflicts with stored data');
        }
        return { signal: probeRowToSignal(row), replayed: true };
      }

      const rows = await transaction.$queryRaw<ProbeResultRow[]>`
        INSERT INTO "ProbeResult" (
          id,
          "probeSourceId",
          "sourceResultId",
          "sourceIndependenceKey",
          "scopeKind",
          "scopeKey",
          "cycleStartedAt",
          "routeVersion",
          outcome,
          "failureClass",
          "controlHealthy",
          "receivedAt"
        )
        SELECT
          CAST(${randomUUID()} AS uuid),
          source.id,
          ${input.sourceResultId},
          source."independenceKey",
          CAST(${input.affectedScope.kind} AS "HealthScopeKind"),
          ${input.affectedScope.id},
          ${input.cycleStartedAt},
          ${input.routeVersion},
          CAST(${input.outcome} AS "ProbeResultOutcome"),
          CAST(${input.failureClass ?? null} AS "ProbeFailureClass"),
          ${input.controlHealthy},
          clock_timestamp()
        FROM "ProbeSource" AS source
        WHERE source.id = CAST(${input.probeSourceId} AS uuid)
          AND source.status = 'ACTIVE'
        RETURNING
          id::text,
          "probeSourceId"::text,
          "sourceResultId",
          "sourceIndependenceKey",
          "scopeKind"::text AS "scopeKind",
          "scopeKey",
          "cycleStartedAt",
          "routeVersion",
          outcome::text,
          "failureClass"::text AS "failureClass",
          "controlHealthy",
          "receivedAt"
      `;
      if (!rows[0]) {
        throw new Error('Active probe source is unavailable');
      }
      return { signal: probeRowToSignal(rows[0]), replayed: false };
    });
  }

  async loadState(affectedScope: {
    kind: HealthScopeKind;
    id: string;
  }): Promise<PersistedHealthState> {
    const scope = scopeSchema.parse(affectedScope);
    const rows = await this.prisma.$queryRaw<StateRow[]>`
      SELECT
        id::text,
        status::text,
        "excludedFromCandidates",
        "consecutiveFailureCycles",
        "consecutiveRecoverySuccesses",
        "recoveryWindowStartedAt",
        "consecutiveUncertainCycles",
        "cooldownUntil",
        version
      FROM "AvailabilityState"
      WHERE "scopeKind" = CAST(${scope.kind} AS "HealthScopeKind")
        AND "scopeKey" = ${scope.id}
    `;
    if (rows[0]) return rowToState(rows[0]);
    return {
      state: {
        status: 'UNKNOWN',
        excludedFromCandidates: true,
        consecutiveFailureCycles: 0,
        consecutiveRecoverySuccesses: 0,
        recoveryWindowStartedAt: null,
        consecutiveUncertainCycles: 0,
        cooldownUntil: null,
      },
      version: 0n,
    };
  }

  async applyDecision(
    decision: HealthDecision,
    expectedVersion: bigint,
  ): Promise<AppliedHealthDecision> {
    const scope = scopeSchema.parse(decision.affectedScope);
    if (expectedVersion < 0n)
      throw new Error('Expected state version is invalid');
    z.array(z.string().trim().min(1).max(128))
      .max(32)
      .parse(decision.signalIds);
    const cycleSignalIds = decision.cycle?.signalIds ?? [];
    z.array(z.uuid()).parse(cycleSignalIds);
    if (
      decision.cycle &&
      JSON.stringify([...decision.signalIds].sort()) !==
        JSON.stringify([...cycleSignalIds].sort())
    ) {
      throw new Error('Decision signal IDs do not match its probe cycle');
    }
    if (decision.decision !== decision.state.status) {
      throw new Error('Decision status does not match resulting state');
    }
    if (decision.policyVersion) z.uuid().parse(decision.policyVersion.id);
    const idempotencyKey = decisionIdempotencyKey(expectedVersion, decision);

    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${scope.kind}:${scope.id}`}, 0)
          )
        `;
          const replay = await transaction.$queryRaw<
            { id: string; stateVersion: bigint }[]
          >`
          SELECT id::text, "stateVersion"
          FROM "AvailabilityDecision"
          WHERE "idempotencyKey" = ${idempotencyKey}
        `;
          if (replay[0]) {
            return {
              decisionId: replay[0].id,
              idempotencyKey,
              stateVersion: replay[0].stateVersion,
              replayed: true,
            };
          }

          await transaction.$executeRaw`
          INSERT INTO "AvailabilityState" (
            id, "scopeKind", "scopeKey", "updatedAt"
          ) VALUES (
            CAST(${randomUUID()} AS uuid),
            CAST(${scope.kind} AS "HealthScopeKind"),
            ${scope.id},
            clock_timestamp()
          )
          ON CONFLICT ("scopeKind", "scopeKey") DO NOTHING
        `;
          const states = await transaction.$queryRaw<StateRow[]>`
          SELECT
            id::text,
            status::text,
            "excludedFromCandidates",
            "consecutiveFailureCycles",
            "consecutiveRecoverySuccesses",
            "recoveryWindowStartedAt",
            "consecutiveUncertainCycles",
            "cooldownUntil",
            version
          FROM "AvailabilityState"
          WHERE "scopeKind" = CAST(${scope.kind} AS "HealthScopeKind")
            AND "scopeKey" = ${scope.id}
          FOR UPDATE
        `;
          const current = states[0];
          if (!current || current.version !== expectedVersion) {
            throw new Error('Availability state version conflict');
          }

          if (decision.policyVersion) {
            const activePolicies = await transaction.$queryRaw<
              { id: string; code: string }[]
            >`
            SELECT version.id::text, version.code
            FROM "HealthPolicyActivation" AS activation
            INNER JOIN "HealthPolicyVersion" AS version
              ON version.id = activation."policyVersionId"
            ORDER BY activation.sequence DESC
            LIMIT 1
          `;
            if (
              activePolicies[0]?.id !== decision.policyVersion.id ||
              activePolicies[0]?.code !== decision.policyVersion.code
            ) {
              throw new Error('Selected health policy is no longer active');
            }
          }

          const stateVersion = expectedVersion + 1n;
          const decisionId = randomUUID();
          await transaction.$executeRaw`
          INSERT INTO "AvailabilityDecision" (
            id,
            "idempotencyKey",
            "availabilityStateId",
            "stateVersion",
            "healthPolicyVersionId",
            "signalIds",
            decision,
            reason,
            "excludedFromCandidates",
            "consecutiveFailureCycles",
            "consecutiveRecoverySuccesses",
            "recoveryWindowStartedAt",
            "consecutiveUncertainCycles",
            "cooldownUntil",
            "allowNewAssignments",
            "triggerReplacement",
            "triggerIncident",
            "cycleStartedAt",
            "cycleDecision",
            "failureClass",
            "additionalProbeDueAt"
          ) VALUES (
            CAST(${decisionId} AS uuid),
            ${idempotencyKey},
            CAST(${current.id} AS uuid),
            ${stateVersion},
            CAST(${decision.policyVersion?.id ?? null} AS uuid),
            CAST(${JSON.stringify(decision.signalIds)} AS jsonb),
            CAST(${decision.decision} AS "AvailabilityHealthStatus"),
            CAST(${decision.reason} AS "AvailabilityDecisionReason"),
            ${decision.state.excludedFromCandidates},
            ${decision.state.consecutiveFailureCycles},
            ${decision.state.consecutiveRecoverySuccesses},
            ${decision.state.recoveryWindowStartedAt},
            ${decision.state.consecutiveUncertainCycles},
            ${decision.state.cooldownUntil},
            ${decision.allowNewAssignments},
            ${decision.triggerReplacement},
            ${decision.triggerIncident},
            ${decision.cycle?.cycleStartedAt ?? null},
            CAST(${decision.cycle?.decision ?? null} AS "AvailabilityCycleDecision"),
            CAST(${decision.cycle?.failureClass ?? null} AS "ProbeFailureClass"),
            ${decision.cycle?.additionalProbeDueAt ?? null}
          )
        `;
          for (const signalId of [...new Set(cycleSignalIds)].sort()) {
            await transaction.$executeRaw`
            INSERT INTO "AvailabilityDecisionSignal" (
              "availabilityDecisionId", "probeResultId"
            ) VALUES (
              CAST(${decisionId} AS uuid), CAST(${signalId} AS uuid)
            )
          `;
          }
          const updated = await transaction.$executeRaw`
          UPDATE "AvailabilityState"
          SET
            status = CAST(${decision.state.status} AS "AvailabilityHealthStatus"),
            "excludedFromCandidates" = ${decision.state.excludedFromCandidates},
            "consecutiveFailureCycles" = ${decision.state.consecutiveFailureCycles},
            "consecutiveRecoverySuccesses" = ${decision.state.consecutiveRecoverySuccesses},
            "recoveryWindowStartedAt" = ${decision.state.recoveryWindowStartedAt},
            "consecutiveUncertainCycles" = ${decision.state.consecutiveUncertainCycles},
            "cooldownUntil" = ${decision.state.cooldownUntil},
            version = ${stateVersion},
            "updatedAt" = clock_timestamp()
          WHERE id = CAST(${current.id} AS uuid)
            AND version = ${expectedVersion}
        `;
          if (updated !== 1)
            throw new Error('Availability state version conflict');
          return {
            decisionId,
            idempotencyKey,
            stateVersion,
            replayed: false,
          };
        },
        { isolationLevel: 'Serializable' as Prisma.TransactionIsolationLevel },
      );
    } catch (error) {
      if (isSerializationFailure(error)) {
        throw new Error('Availability state version conflict');
      }
      throw error;
    }
  }
}
