import type { INestApplication } from '@nestjs/common';
import {
  PrismaHealthActionStore,
  PrismaHealthEvidenceStore,
} from '@vpn-platform/orchestration-store';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { createInfrastructureTestApp } from './fixture';

describe('infrastructure health-actions', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createInfrastructureTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const createDecision = async (failureCycles: 1 | 3) => {
    const prisma = app.get(PrismaService);
    const evidence = new PrismaHealthEvidenceStore(prisma);
    const scope = { kind: 'ENDPOINT' as const, id: `endpoint:${randomUUID()}` };
    const sources = await Promise.all(
      ['a', 'b'].map((suffix) =>
        prisma.probeSource.create({
          data: {
            code: `health-action-${suffix}-${randomUUID()}`,
            independenceKey: `health-action-domain-${suffix}-${randomUUID()}`,
          },
        }),
      ),
    );
    const baseTime = Date.now() - 30_000;
    let decisionId = '';
    for (let cycle = 0; cycle < failureCycles; cycle += 1) {
      const cycleStartedAt = new Date(baseTime + cycle * 10_000);
      const signals = await Promise.all(
        sources.map((source) =>
          evidence.recordProbeResult({
            probeSourceId: source.id,
            sourceResultId: `health-action-result-${randomUUID()}`,
            affectedScope: scope,
            cycleStartedAt,
            routeVersion: 4,
            outcome: 'FAILURE',
            failureClass: 'TCP_TLS',
            controlHealthy: true,
          }),
        ),
      );
      const applied = await evidence.evaluateAndApplyDecision(
        {
          affectedScope: scope,
          routeVersion: 4,
          cycleStartedAt,
          probeResultIds: signals.map((item) => item.signal.id),
          lastHeartbeatAt: cycleStartedAt,
          recoveryGates: {
            clockTrusted: true,
            servingCheckPassed: true,
            desiredVersion: 4,
            appliedVersion: 4,
          },
        },
        BigInt(cycle),
      );
      decisionId = applied.decisionId;
    }
    return { decisionId, scope };
  };

  it('atomically materializes one incident and policy-bound promotion intent', async () => {
    const prisma = app.get(PrismaService);
    const store = new PrismaHealthActionStore(prisma, {
      ORCHESTRATION_LEASE_DURATION_MS: 30_000,
      ORCHESTRATION_MAX_ATTEMPTS: 5,
    });
    const { decisionId, scope } = await createDecision(3);
    const input = {
      availabilityDecisionId: decisionId,
      servicePrincipal: 'health-orchestrator',
    };
    const [first, replay] = await Promise.all([
      store.materializeDecisionActions(input),
      store.materializeDecisionActions(input),
    ]);
    const created = first.replayed ? replay : first;
    const repeated = first.replayed ? first : replay;

    expect(created).toMatchObject({ replayed: false });
    expect(repeated).toEqual({ ...created, replayed: true });
    const incident = await prisma.incident.findUniqueOrThrow({
      where: { id: created.incidentId! },
      include: {
        operations: true,
        timelineEvents: { orderBy: { id: 'asc' } },
      },
    });
    expect(incident).toMatchObject({
      availabilityDecisionId: decisionId,
      scopeKind: scope.kind,
      scopeKey: scope.id,
      status: 'OPEN',
    });
    expect(incident.operations).toHaveLength(1);
    expect(incident.operations[0]).toMatchObject({
      id: created.operationId,
      availabilityDecisionId: decisionId,
      type: 'PROMOTE_STANDBY',
      status: 'PENDING',
      initiatorKind: 'SERVICE_PRINCIPAL',
      servicePrincipal: 'health-orchestrator',
      attempts: 0,
      maxAttempts: 5,
    });
    expect(incident.timelineEvents.map((event) => event.kind)).toEqual([
      'OPENED',
      'OPERATION_CREATED',
    ]);
    await expect(
      prisma.auditEvent.count({
        where: {
          entityId: { in: [created.incidentId!, created.operationId!] },
        },
      }),
    ).resolves.toBe(2);
  });

  it('does not create actions for a decision below the incident threshold', async () => {
    const prisma = app.get(PrismaService);
    const store = new PrismaHealthActionStore(prisma, {
      ORCHESTRATION_LEASE_DURATION_MS: 30_000,
      ORCHESTRATION_MAX_ATTEMPTS: 5,
    });
    const { decisionId } = await createDecision(1);

    await expect(
      store.materializeDecisionActions({
        availabilityDecisionId: decisionId,
        servicePrincipal: 'health-orchestrator',
      }),
    ).resolves.toEqual({
      incidentId: null,
      operationId: null,
      replayed: false,
    });
    await expect(
      prisma.incident.count({ where: { availabilityDecisionId: decisionId } }),
    ).resolves.toBe(0);
  });

  it('enforces decision binding, terminal operations and append-only timeline in PostgreSQL', async () => {
    const prisma = app.get(PrismaService);
    const store = new PrismaHealthActionStore(prisma, {
      ORCHESTRATION_LEASE_DURATION_MS: 30_000,
      ORCHESTRATION_MAX_ATTEMPTS: 3,
    });
    const { decisionId } = await createDecision(3);
    const materialized = await store.materializeDecisionActions({
      availabilityDecisionId: decisionId,
      servicePrincipal: 'health-orchestrator',
    });
    const operation = await prisma.nodeOperation.findUniqueOrThrow({
      where: { id: materialized.operationId! },
    });
    const startedAt = new Date(operation.createdAt.getTime() + 1_000);
    const completedAt = new Date(startedAt.getTime() + 1_000);

    await expect(
      prisma.incident.create({
        data: {
          availabilityDecisionId: decisionId,
          scopeKind: 'NODE',
          scopeKey: `wrong:${randomUUID()}`,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.nodeOperation.update({
        where: { id: operation.id },
        data: { status: 'SUCCEEDED' },
      }),
    ).rejects.toThrow();
    await expect(
      store.resolveIncident({
        incidentId: materialized.incidentId!,
        servicePrincipal: 'health-orchestrator',
        reason: 'Replacement has not reached a terminal state',
      }),
    ).rejects.toThrow('Health incident has non-terminal operations');
    await prisma.nodeOperation.update({
      where: { id: operation.id },
      data: { status: 'RUNNING', attempts: 1, startedAt },
    });
    await prisma.nodeOperation.update({
      where: { id: operation.id },
      data: { status: 'SUCCEEDED', completedAt, safeResult: { ready: true } },
    });
    await expect(
      prisma.nodeOperation.update({
        where: { id: operation.id },
        data: { safeResult: { changed: true } },
      }),
    ).rejects.toThrow(/terminal state is immutable/);

    const resolution = await store.resolveIncident({
      incidentId: materialized.incidentId!,
      servicePrincipal: 'health-orchestrator',
      reason: 'Replacement operation completed successfully',
    });
    await expect(
      store.resolveIncident({
        incidentId: materialized.incidentId!,
        servicePrincipal: 'health-orchestrator',
        reason: 'Replacement operation completed successfully',
      }),
    ).resolves.toEqual({ ...resolution, replayed: true });
    await expect(
      prisma.incident.findUniqueOrThrow({
        where: { id: materialized.incidentId! },
      }),
    ).resolves.toMatchObject({
      status: 'RESOLVED',
      resolvedAt: resolution.resolvedAt,
    });
    await expect(
      prisma.nodeOperation.create({
        data: {
          incidentId: materialized.incidentId!,
          availabilityDecisionId: decisionId,
          healthPolicyVersionId: operation.healthPolicyVersionId,
          idempotencyKey: 'a'.repeat(64),
          type: 'DRAIN',
          scopeKind: operation.scopeKind,
          scopeKey: operation.scopeKey,
          initiatorKind: 'SERVICE_PRINCIPAL',
          servicePrincipal: 'health-orchestrator',
          reason: 'Must not be created after incident resolution',
          maxAttempts: 3,
        },
      }),
    ).rejects.toThrow(/requires an open incident/);

    const openedEvent = await prisma.incidentTimelineEvent.findFirstOrThrow({
      where: { incidentId: materialized.incidentId!, kind: 'OPENED' },
    });
    await expect(
      prisma.incidentTimelineEvent.update({
        where: { id: openedEvent.id },
        data: { safeMetadata: { changed: true } },
      }),
    ).rejects.toThrow(/append-only/);
  });
});
