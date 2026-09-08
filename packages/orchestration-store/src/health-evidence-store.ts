import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

import {
  HEALTH_SCOPE_KINDS,
  ROUTE_FAILURE_CLASSES,
  evaluateHealthCycle,
  type HealthDecisionState,
  type HealthScopeKind,
  type ProbeSignal,
  type ProbeSignalEvaluation,
} from './health-decision';

const scopeSchema = z.object({
  kind: z.enum(HEALTH_SCOPE_KINDS),
  id: z.string().trim().min(1).max(128),
});
const databaseInteger = z.number().int().nonnegative().max(2_147_483_647);
const recordProbeResultSchema = z
  .object({
    probeSourceId: z.uuid(),
    sourceResultId: z.string().trim().min(1).max(128),
    affectedScope: scopeSchema,
    cycleStartedAt: z.date(),
    routeVersion: databaseInteger,
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

const applyHealthCycleSchema = z
  .object({
    affectedScope: scopeSchema,
    routeVersion: databaseInteger,
    cycleStartedAt: z.date(),
    probeResultIds: z.array(z.uuid()).max(32),
    lastHeartbeatAt: z.date().nullable(),
    recoveryGates: z
      .object({
        clockTrusted: z.boolean(),
        servingCheckPassed: z.boolean(),
        desiredVersion: databaseInteger,
        appliedVersion: databaseInteger,
      })
      .strict(),
    criticalTrustFailure: z
      .object({
        signalId: z.string().trim().min(1).max(128),
        kind: z.enum([
          'UNTRUSTED_CLOCK',
          'CREDENTIAL_COMPROMISE',
          'UNSAFE_RUNTIME',
        ]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.probeResultIds).size !== value.probeResultIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['probeResultIds'],
        message: 'probeResultIds must be unique',
      });
    }
    if (value.criticalTrustFailure && value.probeResultIds.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['probeResultIds'],
        message: 'critical trust decisions cannot mix probe evidence',
      });
    }
  });

export type RecordProbeResultInput = z.infer<typeof recordProbeResultSchema>;
export type ApplyHealthCycleInput = z.infer<typeof applyHealthCycleSchema>;

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

type PolicyRow = {
  id: string;
  code: string;
  config: Prisma.JsonValue;
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

const cycleIdempotencyKey = (
  expectedVersion: bigint,
  input: ApplyHealthCycleInput,
) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        expectedVersion: expectedVersion.toString(),
        affectedScope: input.affectedScope,
        routeVersion: input.routeVersion,
        cycleStartedAt: input.cycleStartedAt.toISOString(),
        probeResultIds: [...input.probeResultIds].sort(),
        lastHeartbeatAt: input.lastHeartbeatAt?.toISOString() ?? null,
        recoveryGates: input.recoveryGates,
        criticalTrustFailure: input.criticalTrustFailure ?? null,
      }),
    )
    .digest('hex');

const isSerializationFailure = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.code === 'P2034' || candidate.meta?.code === '40001';
};

const probeSelection = Prisma.sql`
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
`;

const idList = (ids: string[]) =>
  Prisma.join(ids.map((id) => Prisma.sql`CAST(${id} AS uuid)`));

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

  async evaluateAndApplyDecision(
    untrustedInput: ApplyHealthCycleInput,
    expectedVersion: bigint,
  ): Promise<AppliedHealthDecision> {
    const input = applyHealthCycleSchema.parse(untrustedInput);
    const scope = input.affectedScope;
    if (expectedVersion < 0n)
      throw new Error('Expected state version is invalid');
    const idempotencyKey = cycleIdempotencyKey(expectedVersion, input);

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

          const clockRows = await transaction.$queryRaw<
            { evaluatedAt: Date }[]
          >`SELECT clock_timestamp() AS "evaluatedAt"`;
          const evaluatedAt = clockRows[0]?.evaluatedAt;
          if (!evaluatedAt) throw new Error('Database clock is unavailable');
          if (input.cycleStartedAt.getTime() > evaluatedAt.getTime())
            throw new Error('Health cycle cannot start in the future');
          if (
            input.lastHeartbeatAt &&
            input.lastHeartbeatAt.getTime() > evaluatedAt.getTime()
          )
            throw new Error('Heartbeat cannot be in the future');

          if (!input.criticalTrustFailure) {
            const previousCycles = await transaction.$queryRaw<
              { cycleStartedAt: Date }[]
            >`
              SELECT "cycleStartedAt"
              FROM "AvailabilityDecision"
              WHERE "availabilityStateId" = CAST(${current.id} AS uuid)
                AND "cycleStartedAt" IS NOT NULL
              ORDER BY "stateVersion" DESC
              LIMIT 1
            `;
            if (
              previousCycles[0] &&
              input.cycleStartedAt.getTime() <=
                previousCycles[0].cycleStartedAt.getTime()
            )
              throw new Error('Health cycle is not newer than current state');
          }

          const activePolicies = await transaction.$queryRaw<PolicyRow[]>`
            SELECT version.id::text, version.code, version.config
            FROM "HealthPolicyActivation" AS activation
            INNER JOIN "HealthPolicyVersion" AS version
              ON version.id = activation."policyVersionId"
            ORDER BY activation.sequence DESC
            LIMIT 1
          `;
          const probeRows =
            input.probeResultIds.length === 0
              ? []
              : await transaction.$queryRaw<ProbeResultRow[]>(Prisma.sql`
                  ${probeSelection}
                  WHERE result.id IN (${idList(input.probeResultIds)})
                  ORDER BY result."receivedAt", result.id
                `);
          if (probeRows.length !== input.probeResultIds.length)
            throw new Error('One or more probe results are unavailable');
          if (
            probeRows.some(
              (row) =>
                row.scopeKind !== scope.kind || row.scopeKey !== scope.id,
            )
          )
            throw new Error('Probe result scope does not match health cycle');

          const consumedRows =
            input.probeResultIds.length === 0
              ? []
              : await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
                  SELECT DISTINCT "probeResultId"::text AS id
                  FROM "AvailabilityDecisionSignal"
                  WHERE "probeResultId" IN (${idList(input.probeResultIds)})
                    AND disposition = 'ACCEPTED'
                `);
          const decision = evaluateHealthCycle({
            policy: activePolicies[0] ?? null,
            affectedScope: scope,
            routeVersion: input.routeVersion,
            cycleStartedAt: input.cycleStartedAt,
            evaluatedAt,
            signals: probeRows.map(probeRowToSignal),
            consumedSignalIds: new Set(consumedRows.map((row) => row.id)),
            previousState: rowToState(current).state,
            lastHeartbeatAt: input.lastHeartbeatAt,
            recoveryGates: input.recoveryGates,
            ...(input.criticalTrustFailure
              ? { criticalTrustFailure: input.criticalTrustFailure }
              : {}),
          });
          const signalEvaluations: ProbeSignalEvaluation[] =
            decision.cycle?.signalEvaluations ??
            [...input.probeResultIds].sort().map((signalId) => ({
              signalId,
              disposition: 'REJECTED',
              rejectionReason: 'POLICY_UNAVAILABLE',
            }));

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
            "inputProbeResultIds",
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
            "routeVersion",
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
            CAST(${JSON.stringify([...input.probeResultIds].sort())} AS jsonb),
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
            ${decision.cycle ? input.routeVersion : null},
            CAST(${decision.cycle?.decision ?? null} AS "AvailabilityCycleDecision"),
            CAST(${decision.cycle?.failureClass ?? null} AS "ProbeFailureClass"),
            ${decision.cycle?.additionalProbeDueAt ?? null}
          )
        `;
          for (const evaluation of signalEvaluations) {
            await transaction.$executeRaw`
            INSERT INTO "AvailabilityDecisionSignal" (
              "availabilityDecisionId",
              "probeResultId",
              disposition,
              "rejectionReason"
            ) VALUES (
              CAST(${decisionId} AS uuid),
              CAST(${evaluation.signalId} AS uuid),
              CAST(${evaluation.disposition} AS "ProbeSignalDisposition"),
              CAST(${evaluation.rejectionReason} AS "ProbeSignalRejectionReason")
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
