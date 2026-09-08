import type { INestApplication } from '@nestjs/common';
import { PrismaHealthEvidenceStore } from '@vpn-platform/orchestration-store';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { createInfrastructureTestApp } from './fixture';

describe('infrastructure health-evidence', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createInfrastructureTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  const createSource = async (
    prisma: PrismaService,
    independenceKey: string,
    status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
  ) =>
    prisma.probeSource.create({
      data: {
        code: `probe-${randomUUID()}`,
        independenceKey,
        status,
      },
    });

  const cycleCommand = (
    affectedScope: { kind: 'PROFILE' | 'ENDPOINT' | 'NODE'; id: string },
    cycleStartedAt: Date,
    routeVersion: number,
    probeResultIds: string[],
  ) => ({
    affectedScope,
    cycleStartedAt,
    routeVersion,
    probeResultIds,
    lastHeartbeatAt: new Date(),
    recoveryGates: {
      clockTrusted: true,
      servingCheckPassed: true,
      desiredVersion: routeVersion,
      appliedVersion: routeVersion,
    },
  });

  it('records an exact retry once and rejects conflicting replay data', async () => {
    const prisma = app.get(PrismaService);
    const store = new PrismaHealthEvidenceStore(prisma);
    const source = await createSource(prisma, 'independent-a');
    const cycleStartedAt = new Date(Date.now() - 1_000);
    const command = {
      probeSourceId: source.id,
      sourceResultId: `result-${randomUUID()}`,
      affectedScope: {
        kind: 'PROFILE' as const,
        id: `profile:${randomUUID()}`,
      },
      cycleStartedAt,
      routeVersion: 7,
      outcome: 'SUCCESS' as const,
      controlHealthy: true,
    };

    const first = await store.recordProbeResult(command);
    const replay = await store.recordProbeResult(command);

    expect(first.replayed).toBe(false);
    expect(first.signal).toMatchObject({
      sourceId: source.id,
      independenceKey: 'independent-a',
      authenticated: true,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      store.recordProbeResult({ ...command, routeVersion: 8 }),
    ).rejects.toThrow('Probe result replay key conflicts with stored data');
    await expect(
      prisma.probeResult.count({
        where: {
          probeSourceId: source.id,
          sourceResultId: command.sourceResultId,
        },
      }),
    ).resolves.toBe(1);
  });

  it('rejects disabled sources and malformed failure evidence before persistence', async () => {
    const prisma = app.get(PrismaService);
    const store = new PrismaHealthEvidenceStore(prisma);
    const source = await createSource(
      prisma,
      'independent-disabled',
      'DISABLED',
    );
    const base = {
      probeSourceId: source.id,
      sourceResultId: `result-${randomUUID()}`,
      affectedScope: {
        kind: 'ENDPOINT' as const,
        id: `endpoint:${randomUUID()}`,
      },
      cycleStartedAt: new Date(Date.now() - 1_000),
      routeVersion: 1,
      controlHealthy: true,
    };

    await expect(
      store.recordProbeResult({ ...base, outcome: 'SUCCESS' }),
    ).rejects.toThrow('Active probe source is unavailable');
    await expect(
      store.recordProbeResult({ ...base, outcome: 'FAILURE' }),
    ).rejects.toThrow();
  });

  it('atomically persists a versioned decision, its state and exact evidence links', async () => {
    const prisma = app.get(PrismaService);
    const store = new PrismaHealthEvidenceStore(prisma);
    const scope = { kind: 'PROFILE' as const, id: `profile:${randomUUID()}` };
    const cycleStartedAt = new Date(Date.now() - 1_000);
    const [sourceA, sourceB] = await Promise.all([
      createSource(prisma, 'failure-domain-a'),
      createSource(prisma, 'failure-domain-b'),
    ]);
    const signals = await Promise.all(
      [sourceA, sourceB].map(
        async (source) =>
          (
            await store.recordProbeResult({
              probeSourceId: source.id,
              sourceResultId: `result-${randomUUID()}`,
              affectedScope: scope,
              cycleStartedAt,
              routeVersion: 3,
              outcome: 'FAILURE',
              failureClass: 'TCP_TLS',
              controlHealthy: true,
            })
          ).signal,
      ),
    );
    const rejectedSource = await createSource(prisma, 'failure-domain-wrong');
    const rejectedSignal = await store.recordProbeResult({
      probeSourceId: rejectedSource.id,
      sourceResultId: `result-${randomUUID()}`,
      affectedScope: scope,
      cycleStartedAt,
      routeVersion: 2,
      outcome: 'FAILURE',
      failureClass: 'TCP_TLS',
      controlHealthy: true,
    });
    const policy = await prisma.healthPolicyVersion.findUniqueOrThrow({
      where: { code: 'beta-v1' },
    });
    const command = cycleCommand(scope, cycleStartedAt, 3, [
      ...signals.map((signal) => signal.id),
      rejectedSignal.signal.id,
    ]);
    const applied = await store.evaluateAndApplyDecision(command, 0n);
    const replay = await store.evaluateAndApplyDecision(command, 0n);
    const persisted = await store.loadState(scope);

    expect(applied).toMatchObject({ stateVersion: 1n, replayed: false });
    expect(replay).toEqual({ ...applied, replayed: true });
    await expect(store.evaluateAndApplyDecision(command, 1n)).rejects.toThrow(
      'Health cycle is not newer than current state',
    );
    expect(persisted).toMatchObject({
      state: {
        status: 'UNKNOWN',
        excludedFromCandidates: true,
        consecutiveFailureCycles: 1,
      },
      version: 1n,
    });
    await expect(
      prisma.availabilityDecisionSignal.count({
        where: { availabilityDecisionId: applied.decisionId },
      }),
    ).resolves.toBe(3);
    await expect(
      prisma.availabilityDecision.findUniqueOrThrow({
        where: { id: applied.decisionId },
      }),
    ).resolves.toMatchObject({
      healthPolicyVersionId: policy.id,
      stateVersion: 1n,
      cycleDecision: 'FAILED',
      failureClass: 'TCP_TLS',
      routeVersion: 3,
      inputProbeResultIds: [
        ...signals.map((signal) => signal.id),
        rejectedSignal.signal.id,
      ].sort(),
    });
    await expect(
      prisma.availabilityDecisionSignal.findMany({
        where: { availabilityDecisionId: applied.decisionId },
        orderBy: { probeResultId: 'asc' },
      }),
    ).resolves.toEqual(
      [
        ...signals.map((signal) => ({
          availabilityDecisionId: applied.decisionId,
          probeResultId: signal.id,
          disposition: 'ACCEPTED',
          rejectionReason: null,
        })),
        {
          availabilityDecisionId: applied.decisionId,
          probeResultId: rejectedSignal.signal.id,
          disposition: 'REJECTED',
          rejectionReason: 'ROUTE_VERSION_MISMATCH',
        },
      ].sort((left, right) =>
        left.probeResultId.localeCompare(right.probeResultId),
      ),
    );

    const lateSource = await createSource(prisma, 'failure-domain-c');
    const lateSignal = await store.recordProbeResult({
      probeSourceId: lateSource.id,
      sourceResultId: `result-${randomUUID()}`,
      affectedScope: scope,
      cycleStartedAt,
      routeVersion: 3,
      outcome: 'FAILURE',
      failureClass: 'TCP_TLS',
      controlHealthy: true,
    });
    await expect(
      prisma.availabilityDecisionSignal.create({
        data: {
          availabilityDecisionId: applied.decisionId,
          probeResultId: lateSignal.signal.id,
          disposition: 'ACCEPTED',
        },
      }),
    ).rejects.toThrow(/signal is not declared|signal set is already finalized/);
  });

  it('serializes competing state changes and enforces immutable matching evidence', async () => {
    const prisma = app.get(PrismaService);
    const store = new PrismaHealthEvidenceStore(prisma);
    const scope = { kind: 'NODE' as const, id: `node:${randomUUID()}` };
    const otherScope = { kind: 'NODE' as const, id: `node:${randomUUID()}` };
    const source = await createSource(prisma, 'node-domain');
    const cycleStartedAt = new Date(Date.now() - 1_000);
    const recorded = await store.recordProbeResult({
      probeSourceId: source.id,
      sourceResultId: `result-${randomUUID()}`,
      affectedScope: scope,
      cycleStartedAt,
      routeVersion: 1,
      outcome: 'SUCCESS',
      controlHealthy: true,
    });
    const baseCommand = cycleCommand(scope, cycleStartedAt, 1, [
      recorded.signal.id,
    ]);
    const competingCommand = {
      ...cycleCommand(scope, cycleStartedAt, 1, []),
      criticalTrustFailure: {
        signalId: `security-event:${randomUUID()}`,
        kind: 'UNSAFE_RUNTIME' as const,
      },
    };

    const settled = await Promise.allSettled([
      store.evaluateAndApplyDecision(baseCommand, 0n),
      store.evaluateAndApplyDecision(competingCommand, 0n),
    ]);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(
      1,
    );
    expect(
      settled.find((item) => item.status === 'rejected')?.reason,
    ).toMatchObject({ message: 'Availability state version conflict' });
    const currentState = await prisma.availabilityState.findUniqueOrThrow({
      where: {
        scopeKind_scopeKey: { scopeKind: scope.kind, scopeKey: scope.id },
      },
    });
    await expect(
      prisma.availabilityState.update({
        where: { id: currentState.id },
        data: { version: { increment: 1 } },
      }),
    ).rejects.toThrow(/matching decision/);
    await expect(
      prisma.availabilityState.create({
        data: {
          scopeKind: 'NODE',
          scopeKey: `unsafe:${randomUUID()}`,
          status: 'DEGRADED',
          excludedFromCandidates: true,
        },
      }),
    ).rejects.toThrow(/start fail-closed/);

    await expect(
      prisma.probeResult.update({
        where: { id: recorded.signal.id },
        data: { controlHealthy: false },
      }),
    ).rejects.toThrow(/append-only/);

    await expect(
      store.evaluateAndApplyDecision(
        cycleCommand(otherScope, cycleStartedAt, 1, [recorded.signal.id]),
        0n,
      ),
    ).rejects.toThrow(/scope does not match/);
    await expect(store.loadState(otherScope)).resolves.toMatchObject({
      version: 0n,
    });
  });

  it('derives the transition internally and cannot be forged into recovery', async () => {
    const prisma = app.get(PrismaService);
    const store = new PrismaHealthEvidenceStore(prisma);
    const scope = { kind: 'PROFILE' as const, id: `profile:${randomUUID()}` };
    const cycleStartedAt = new Date(Date.now() - 1_000);
    const source = await createSource(prisma, 'single-success-source');
    const recorded = await store.recordProbeResult({
      probeSourceId: source.id,
      sourceResultId: `result-${randomUUID()}`,
      affectedScope: scope,
      cycleStartedAt,
      routeVersion: 5,
      outcome: 'SUCCESS',
      controlHealthy: true,
    });
    const command = cycleCommand(scope, cycleStartedAt, 5, [
      recorded.signal.id,
    ]);

    await expect(
      store.evaluateAndApplyDecision(
        { ...command, decision: 'HEALTHY' } as never,
        0n,
      ),
    ).rejects.toThrow();
    const applied = await store.evaluateAndApplyDecision(command, 0n);
    await expect(store.loadState(scope)).resolves.toMatchObject({
      state: {
        status: 'UNKNOWN',
        excludedFromCandidates: true,
        consecutiveRecoverySuccesses: 0,
      },
      version: 1n,
    });
    await expect(
      prisma.availabilityDecision.findUniqueOrThrow({
        where: { id: applied.decisionId },
      }),
    ).resolves.toMatchObject({
      decision: 'UNKNOWN',
      cycleDecision: 'UNKNOWN',
      allowNewAssignments: false,
    });
  });

  it('persists critical-trust evidence references without pretending they are probe rows', async () => {
    const prisma = app.get(PrismaService);
    const store = new PrismaHealthEvidenceStore(prisma);
    const scope = { kind: 'NODE' as const, id: `node:${randomUUID()}` };
    const applied = await store.evaluateAndApplyDecision(
      {
        ...cycleCommand(scope, new Date(), 0, []),
        lastHeartbeatAt: null,
        recoveryGates: {
          clockTrusted: false,
          servingCheckPassed: false,
          desiredVersion: 0,
          appliedVersion: 0,
        },
        criticalTrustFailure: {
          signalId: 'security-event:unsafe-runtime',
          kind: 'UNSAFE_RUNTIME',
        },
      },
      0n,
    );
    const stored = await prisma.availabilityDecision.findUniqueOrThrow({
      where: { id: applied.decisionId },
    });
    expect(stored).toMatchObject({
      decision: 'QUARANTINED',
      reason: 'CRITICAL_TRUST_FAILURE',
      signalIds: ['security-event:unsafe-runtime'],
      inputProbeResultIds: [],
      routeVersion: null,
    });
    await expect(
      prisma.availabilityDecisionSignal.count({
        where: { availabilityDecisionId: applied.decisionId },
      }),
    ).resolves.toBe(0);
  });

  it('fails closed and records rejected inputs when the active policy is invalid', async () => {
    const prisma = app.get(PrismaService);
    const store = new PrismaHealthEvidenceStore(prisma);
    const scope = { kind: 'ENDPOINT' as const, id: `endpoint:${randomUUID()}` };
    const source = await createSource(prisma, 'invalid-policy-source');
    const cycleStartedAt = new Date(Date.now() - 1_000);
    const recorded = await store.recordProbeResult({
      probeSourceId: source.id,
      sourceResultId: `result-${randomUUID()}`,
      affectedScope: scope,
      cycleStartedAt,
      routeVersion: 1,
      outcome: 'SUCCESS',
      controlHealthy: true,
    });
    const draftPolicy = await prisma.healthPolicyVersion.create({
      data: {
        code: `draft-${randomUUID()}`,
        config: {},
      },
    });
    await prisma.healthPolicyActivation.create({
      data: {
        policyVersionId: draftPolicy.id,
        reason: 'integration invalid policy',
      },
    });

    const applied = await store.evaluateAndApplyDecision(
      cycleCommand(scope, cycleStartedAt, 1, [recorded.signal.id]),
      0n,
    );
    await expect(store.loadState(scope)).resolves.toMatchObject({
      state: { status: 'DEGRADED', excludedFromCandidates: true },
      version: 1n,
    });
    await expect(
      prisma.availabilityDecisionSignal.findUniqueOrThrow({
        where: {
          availabilityDecisionId_probeResultId: {
            availabilityDecisionId: applied.decisionId,
            probeResultId: recorded.signal.id,
          },
        },
      }),
    ).resolves.toMatchObject({
      disposition: 'REJECTED',
      rejectionReason: 'POLICY_UNAVAILABLE',
    });
  });
});
