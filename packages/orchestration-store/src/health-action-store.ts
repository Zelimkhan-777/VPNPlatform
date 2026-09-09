import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

import type { OrchestrationStoreEnvironment } from './environment';
import type { HealthScopeKind } from './health-decision';

const materializeSchema = z
  .object({
    availabilityDecisionId: z.uuid(),
    servicePrincipal: z
      .string()
      .trim()
      .min(3)
      .max(128)
      .regex(/^[a-z][a-z0-9._-]*$/),
  })
  .strict();
const resolveSchema = z
  .object({
    incidentId: z.uuid(),
    servicePrincipal: z
      .string()
      .trim()
      .min(3)
      .max(128)
      .regex(/^[a-z][a-z0-9._-]*$/),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

type DecisionRow = {
  id: string;
  healthPolicyVersionId: string | null;
  reason: string;
  triggerIncident: boolean;
  triggerReplacement: boolean;
  scopeKind: HealthScopeKind;
  scopeKey: string;
};

export type MaterializedHealthActions = {
  incidentId: string | null;
  operationId: string | null;
  replayed: boolean;
};

export type ResolvedHealthIncident = {
  incidentId: string;
  resolvedAt: Date;
  replayed: boolean;
};

const operationIdempotencyKey = (decisionId: string) =>
  createHash('sha256')
    .update('health-action:promote-standby:v1\0')
    .update(decisionId)
    .digest('hex');

export class PrismaHealthActionStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly environment: OrchestrationStoreEnvironment,
  ) {}

  async materializeDecisionActions(
    untrustedInput: z.input<typeof materializeSchema>,
  ): Promise<MaterializedHealthActions> {
    const input = materializeSchema.parse(untrustedInput);
    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`health-action:${input.availabilityDecisionId}`}, 0)
          )
        `;
        const decisions = await transaction.$queryRaw<DecisionRow[]>`
          SELECT
            decision.id::text,
            decision."healthPolicyVersionId"::text AS "healthPolicyVersionId",
            decision.reason::text,
            decision."triggerIncident",
            decision."triggerReplacement",
            state."scopeKind"::text AS "scopeKind",
            state."scopeKey"
          FROM "AvailabilityDecision" AS decision
          INNER JOIN "AvailabilityState" AS state
            ON state.id = decision."availabilityStateId"
          WHERE decision.id = CAST(${input.availabilityDecisionId} AS uuid)
          FOR UPDATE OF decision
        `;
        const decision = decisions[0];
        if (!decision) throw new Error('Availability decision was not found');
        if (!decision.triggerIncident) {
          return { incidentId: null, operationId: null, replayed: false };
        }

        const existing = await transaction.incident.findUnique({
          where: { availabilityDecisionId: decision.id },
          include: { operations: true },
        });
        if (existing) {
          const operation = existing.operations.find(
            (candidate) => candidate.type === 'PROMOTE_STANDBY',
          );
          const operationExpected =
            decision.triggerReplacement &&
            decision.healthPolicyVersionId !== null;
          if (
            operationExpected !== Boolean(operation) ||
            (operation &&
              (operation.servicePrincipal !== input.servicePrincipal ||
                operation.maxAttempts !==
                  this.environment.ORCHESTRATION_MAX_ATTEMPTS))
          ) {
            throw new Error('Health action materialization conflict');
          }
          return {
            incidentId: existing.id,
            operationId: operation?.id ?? null,
            replayed: true,
          };
        }

        const incidentId = randomUUID();
        await transaction.incident.create({
          data: {
            id: incidentId,
            availabilityDecisionId: decision.id,
            scopeKind: decision.scopeKind,
            scopeKey: decision.scopeKey,
          },
        });
        await transaction.incidentTimelineEvent.create({
          data: {
            incidentId,
            kind: 'OPENED',
            safeMetadata: { availabilityDecisionId: decision.id },
          },
        });
        await transaction.auditEvent.create({
          data: {
            action: 'health-incident.opened',
            entityType: 'Incident',
            entityId: incidentId,
            metadata: {
              availabilityDecisionId: decision.id,
              servicePrincipal: input.servicePrincipal,
            },
          },
        });

        if (!decision.triggerReplacement || !decision.healthPolicyVersionId) {
          return { incidentId, operationId: null, replayed: false };
        }

        const operationId = randomUUID();
        await transaction.nodeOperation.create({
          data: {
            id: operationId,
            incidentId,
            availabilityDecisionId: decision.id,
            healthPolicyVersionId: decision.healthPolicyVersionId,
            idempotencyKey: operationIdempotencyKey(decision.id),
            type: 'PROMOTE_STANDBY',
            scopeKind: decision.scopeKind,
            scopeKey: decision.scopeKey,
            initiatorKind: 'SERVICE_PRINCIPAL',
            servicePrincipal: input.servicePrincipal,
            reason: `Automatic health decision: ${decision.reason}`,
            maxAttempts: this.environment.ORCHESTRATION_MAX_ATTEMPTS,
          },
        });
        await transaction.incidentTimelineEvent.create({
          data: {
            incidentId,
            kind: 'OPERATION_CREATED',
            nodeOperationId: operationId,
            safeMetadata: { type: 'PROMOTE_STANDBY' },
          },
        });
        await transaction.auditEvent.create({
          data: {
            action: 'node-operation.created',
            entityType: 'NodeOperation',
            entityId: operationId,
            metadata: {
              availabilityDecisionId: decision.id,
              healthPolicyVersionId: decision.healthPolicyVersionId,
              initiatorKind: 'SERVICE_PRINCIPAL',
              servicePrincipal: input.servicePrincipal,
              type: 'PROMOTE_STANDBY',
            },
          },
        });
        return { incidentId, operationId, replayed: false };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async resolveIncident(
    untrustedInput: z.input<typeof resolveSchema>,
  ): Promise<ResolvedHealthIncident> {
    const input = resolveSchema.parse(untrustedInput);
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`health-incident:${input.incidentId}`}, 0)
        )
      `;
      const incident = await transaction.incident.findUnique({
        where: { id: input.incidentId },
        include: { operations: { select: { status: true } } },
      });
      if (!incident) throw new Error('Health incident was not found');
      if (incident.status === 'RESOLVED') {
        if (!incident.resolvedAt)
          throw new Error('Resolved health incident is inconsistent');
        return {
          incidentId: incident.id,
          resolvedAt: incident.resolvedAt,
          replayed: true,
        };
      }
      if (
        incident.operations.some(
          (operation) =>
            operation.status !== 'SUCCEEDED' && operation.status !== 'FAILED',
        )
      ) {
        throw new Error('Health incident has non-terminal operations');
      }
      const event = await transaction.incidentTimelineEvent.create({
        data: {
          incidentId: incident.id,
          kind: 'RESOLVED',
          safeMetadata: {
            reason: input.reason,
            servicePrincipal: input.servicePrincipal,
          },
        },
      });
      await transaction.auditEvent.create({
        data: {
          action: 'health-incident.resolved',
          entityType: 'Incident',
          entityId: incident.id,
          metadata: {
            reason: input.reason,
            servicePrincipal: input.servicePrincipal,
          },
        },
      });
      return {
        incidentId: incident.id,
        resolvedAt: event.createdAt,
        replayed: false,
      };
    });
  }
}
