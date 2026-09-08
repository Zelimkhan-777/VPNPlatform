import type { INestApplication } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  evaluateHealthCycle,
  PrismaHealthEvidenceStore,
} from '@vpn-platform/orchestration-store';
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
    const initial = await store.loadState(scope);
    const policy = await prisma.healthPolicyVersion.findUniqueOrThrow({
      where: { code: 'beta-v1' },
    });
    const decision = evaluateHealthCycle({
      policy,
      affectedScope: scope,
      routeVersion: 3,
      cycleStartedAt,
      evaluatedAt: new Date(),
      signals,
      previousState: initial.state,
      lastHeartbeatAt: new Date(),
      recoveryGates: {
        clockTrusted: true,
        servingCheckPassed: true,
        desiredVersion: 3,
        appliedVersion: 3,
      },
    });

    const applied = await store.applyDecision(decision, initial.version);
    const replay = await store.applyDecision(decision, initial.version);
    const persisted = await store.loadState(scope);

    expect(applied).toMatchObject({ stateVersion: 1n, replayed: false });
    expect(replay).toEqual({ ...applied, replayed: true });
    expect(persisted).toEqual({ state: decision.state, version: 1n });
    await expect(
      prisma.availabilityDecisionSignal.count({
        where: { availabilityDecisionId: applied.decisionId },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.availabilityDecision.findUniqueOrThrow({
        where: { id: applied.decisionId },
      }),
    ).resolves.toMatchObject({
      healthPolicyVersionId: policy.id,
      stateVersion: 1n,
      cycleDecision: 'FAILED',
      failureClass: 'TCP_TLS',
    });

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
    const initial = await store.loadState(scope);
    const baseDecision = {
      decision: 'DEGRADED' as const,
      reason: 'POLICY_UNAVAILABLE' as const,
      affectedScope: scope,
      policyVersion: null,
      signalIds: [] as string[],
      cycle: null,
      state: {
        ...initial.state,
        status: 'DEGRADED' as const,
      },
      allowNewAssignments: false,
      triggerReplacement: false,
      triggerIncident: false,
    };
    const competingDecision = {
      ...baseDecision,
      decision: 'QUARANTINED' as const,
      reason: 'CRITICAL_TRUST_FAILURE' as const,
      state: {
        ...baseDecision.state,
        status: 'QUARANTINED' as const,
        excludedFromCandidates: true,
      },
      triggerReplacement: true,
      triggerIncident: true,
    };

    const settled = await Promise.allSettled([
      store.applyDecision(baseDecision, 0n),
      store.applyDecision(competingDecision, 0n),
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

    const mismatchedDecision = evaluateHealthCycle({
      policy: {
        id: '00000000-0000-4000-8000-000000000101',
        code: 'beta-v1',
        config: {
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
          routeFailureClasses: [
            'DNS',
            'TCP_TLS',
            'VPN_HANDSHAKE',
            'TEST_TRAFFIC',
          ],
        },
      },
      affectedScope: otherScope,
      routeVersion: 1,
      cycleStartedAt,
      evaluatedAt: new Date(),
      signals: [recorded.signal],
      previousState: (await store.loadState(otherScope)).state,
      lastHeartbeatAt: new Date(),
      recoveryGates: {
        clockTrusted: true,
        servingCheckPassed: true,
        desiredVersion: 1,
        appliedVersion: 1,
      },
    });
    mismatchedDecision.signalIds = [recorded.signal.id];
    if (!mismatchedDecision.cycle) throw new Error('Expected a probe cycle');
    mismatchedDecision.cycle.signalIds = [recorded.signal.id];
    await expect(store.applyDecision(mismatchedDecision, 0n)).rejects.toThrow(
      /signal scope or cycle mismatch/,
    );
    await expect(store.loadState(otherScope)).resolves.toMatchObject({
      version: 0n,
    });
  });

  it('persists critical-trust evidence references without pretending they are probe rows', async () => {
    const prisma = app.get(PrismaService);
    const store = new PrismaHealthEvidenceStore(prisma);
    const scope = { kind: 'NODE' as const, id: `node:${randomUUID()}` };
    const initial = await store.loadState(scope);
    const decision = evaluateHealthCycle({
      policy: null,
      affectedScope: scope,
      routeVersion: 0,
      cycleStartedAt: new Date(),
      evaluatedAt: new Date(),
      signals: [],
      previousState: initial.state,
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
    });

    const applied = await store.applyDecision(decision, 0n);
    const stored = await prisma.availabilityDecision.findUniqueOrThrow({
      where: { id: applied.decisionId },
    });
    expect(stored).toMatchObject({
      decision: 'QUARANTINED',
      reason: 'CRITICAL_TRUST_FAILURE',
      healthPolicyVersionId: null,
      signalIds: ['security-event:unsafe-runtime'],
    });
    await expect(
      prisma.availabilityDecisionSignal.count({
        where: { availabilityDecisionId: applied.decisionId },
      }),
    ).resolves.toBe(0);
  });

  it('rejects a decision bound to a draft policy version', async () => {
    const prisma = app.get(PrismaService);
    const store = new PrismaHealthEvidenceStore(prisma);
    const scope = { kind: 'ENDPOINT' as const, id: `endpoint:${randomUUID()}` };
    const activePolicy = await prisma.healthPolicyVersion.findUniqueOrThrow({
      where: { code: 'beta-v1' },
    });
    const draftPolicy = await prisma.healthPolicyVersion.create({
      data: {
        code: `draft-${randomUUID()}`,
        config: activePolicy.config as Prisma.InputJsonValue,
      },
    });
    const initial = await store.loadState(scope);
    const decision = evaluateHealthCycle({
      policy: draftPolicy,
      affectedScope: scope,
      routeVersion: 1,
      cycleStartedAt: new Date(),
      evaluatedAt: new Date(),
      signals: [],
      previousState: initial.state,
      lastHeartbeatAt: new Date(),
      recoveryGates: {
        clockTrusted: true,
        servingCheckPassed: true,
        desiredVersion: 1,
        appliedVersion: 1,
      },
    });

    await expect(store.applyDecision(decision, 0n)).rejects.toThrow(
      'Selected health policy is no longer active',
    );
    await expect(store.loadState(scope)).resolves.toMatchObject({
      version: 0n,
    });
  });
});
