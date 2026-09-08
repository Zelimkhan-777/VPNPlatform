import { describe, expect, it } from 'vitest';

import {
  aggregateHealthProbeCycle,
  evaluateHealthCycle,
  type EvaluateHealthCycleInput,
  type HealthDecisionState,
  type ProbeSignal,
} from '../src/health-decision';
import type { HealthPolicyConfig } from '../src/operational-policy';

const policy: HealthPolicyConfig = {
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

const cycleStartedAt = new Date('2026-09-08T10:00:00.000Z');
const healthyState = (): HealthDecisionState => ({
  status: 'HEALTHY',
  excludedFromCandidates: false,
  consecutiveFailureCycles: 0,
  consecutiveRecoverySuccesses: 0,
  recoveryWindowStartedAt: null,
  consecutiveUncertainCycles: 0,
  cooldownUntil: null,
});

const signal = (
  id: string,
  outcome: ProbeSignal['outcome'],
  overrides: Partial<ProbeSignal> = {},
): ProbeSignal => ({
  id,
  sourceId: `source-${id}`,
  independenceKey: `domain-${id}`,
  cycleStartedAt,
  receivedAt: new Date('2026-09-08T10:00:05.000Z'),
  authenticated: true,
  controlHealthy: true,
  routeVersion: 7,
  outcome,
  ...(outcome === 'FAILURE' ? { failureClass: 'TCP_TLS' as const } : {}),
  ...overrides,
});

const input = (
  signals: ProbeSignal[],
  overrides: Partial<EvaluateHealthCycleInput> = {},
): EvaluateHealthCycleInput => ({
  policy: { id: 'health-policy-id', code: 'beta-v1', config: policy },
  affectedScope: { kind: 'PROFILE', id: 'profile-id' },
  routeVersion: 7,
  cycleStartedAt,
  evaluatedAt: new Date('2026-09-08T10:00:10.000Z'),
  signals,
  previousState: healthyState(),
  lastHeartbeatAt: new Date('2026-09-08T10:00:00.000Z'),
  recoveryGates: {
    clockTrusted: true,
    servingCheckPassed: true,
    desiredVersion: 7,
    appliedVersion: 7,
  },
  ...overrides,
});

const failedSignals = () => [
  signal('failure-a', 'FAILURE'),
  signal('failure-b', 'FAILURE'),
];
const successSignals = () => [
  signal('success-a', 'SUCCESS'),
  signal('success-b', 'SUCCESS'),
];

describe('health probe aggregation', () => {
  it('requires matching failures from the configured independent-source quorum', () => {
    expect(
      aggregateHealthProbeCycle(policy, {
        cycleStartedAt,
        routeVersion: 7,
        signals: failedSignals(),
      }),
    ).toMatchObject({
      decision: 'FAILED',
      failureClass: 'TCP_TLS',
      signalIds: ['failure-a', 'failure-b'],
    });

    expect(
      aggregateHealthProbeCycle(policy, {
        cycleStartedAt,
        routeVersion: 7,
        signals: [
          signal('failure-a', 'FAILURE'),
          signal('failure-b', 'FAILURE', { failureClass: 'DNS' }),
        ],
      }).decision,
    ).toBe('UNKNOWN');
  });

  it('does not let duplicate independence domains satisfy quorum', () => {
    const result = aggregateHealthProbeCycle(policy, {
      cycleStartedAt,
      routeVersion: 7,
      signals: [
        signal('failure-a', 'FAILURE', { independenceKey: 'same-domain' }),
        signal('failure-b', 'FAILURE', { independenceKey: 'same-domain' }),
      ],
    });

    expect(result.decision).toBe('UNKNOWN');
    expect(result.rejectedSignalIds).toEqual(['failure-b']);
  });

  it('does not let one source vote twice under different independence labels', () => {
    const result = aggregateHealthProbeCycle(policy, {
      cycleStartedAt,
      routeVersion: 7,
      signals: [
        signal('failure-a', 'FAILURE', { sourceId: 'same-source' }),
        signal('failure-b', 'FAILURE', { sourceId: 'same-source' }),
      ],
    });

    expect(result.decision).toBe('UNKNOWN');
    expect(result.rejectedSignalIds).toEqual(['failure-b']);
  });

  it('returns success for the configured quorum', () => {
    expect(
      aggregateHealthProbeCycle(policy, {
        cycleStartedAt,
        routeVersion: 7,
        signals: successSignals(),
      }).decision,
    ).toBe('SUCCESS');
  });

  it('takes quorum from the selected policy version', () => {
    const threeSourcePolicy = { ...policy, probeSourceQuorum: 3 };
    const twoVotes = failedSignals();
    const threeVotes = [...twoVotes, signal('failure-c', 'FAILURE')];

    expect(
      aggregateHealthProbeCycle(threeSourcePolicy, {
        cycleStartedAt,
        routeVersion: 7,
        signals: twoVotes,
      }).decision,
    ).toBe('UNKNOWN');
    expect(
      aggregateHealthProbeCycle(threeSourcePolicy, {
        cycleStartedAt,
        routeVersion: 7,
        signals: threeVotes,
      }).decision,
    ).toBe('FAILED');
  });

  it('uses policy failure-class order instead of input order for simultaneous quorums', () => {
    const signals = [
      signal('tls-b', 'FAILURE'),
      signal('dns-b', 'FAILURE', { failureClass: 'DNS' }),
      signal('tls-a', 'FAILURE'),
      signal('dns-a', 'FAILURE', { failureClass: 'DNS' }),
    ];

    expect(
      aggregateHealthProbeCycle(policy, {
        cycleStartedAt,
        routeVersion: 7,
        signals,
      }),
    ).toMatchObject({
      decision: 'FAILED',
      failureClass: 'DNS',
      signalIds: ['dns-a', 'dns-b', 'tls-a', 'tls-b'],
    });
  });

  it('returns mixed for conflicting votes and schedules the extra probe from policy', () => {
    const result = aggregateHealthProbeCycle(policy, {
      cycleStartedAt,
      routeVersion: 7,
      signals: [signal('success-a', 'SUCCESS'), signal('failure-a', 'FAILURE')],
    });

    expect(result.decision).toBe('MIXED');
    expect(result.additionalProbeDueAt).toEqual(
      new Date('2026-09-08T10:00:15.000Z'),
    );
  });

  it('treats missing and probe-source failure votes as unknown', () => {
    expect(
      aggregateHealthProbeCycle(policy, {
        cycleStartedAt,
        routeVersion: 7,
        signals: [signal('source-failed', 'PROBE_SOURCE_FAILURE')],
      }),
    ).toMatchObject({ decision: 'UNKNOWN', signalIds: [] });
  });

  it('rejects unauthenticated, stale, out-of-order, wrong-version and replayed signals', () => {
    const stale = signal('stale', 'SUCCESS', {
      receivedAt: new Date('2026-09-08T10:01:30.001Z'),
    });
    const result = aggregateHealthProbeCycle(policy, {
      cycleStartedAt,
      routeVersion: 7,
      consumedSignalIds: new Set(['replayed']),
      signals: [
        signal('unauthenticated', 'SUCCESS', { authenticated: false }),
        stale,
        signal('old-cycle', 'SUCCESS', {
          cycleStartedAt: new Date('2026-09-08T09:59:00.000Z'),
        }),
        signal('wrong-version', 'SUCCESS', { routeVersion: 6 }),
        signal('replayed', 'SUCCESS'),
      ],
    });

    expect(result.decision).toBe('UNKNOWN');
    expect(result.rejectedSignalIds).toEqual([
      'old-cycle',
      'replayed',
      'stale',
      'unauthenticated',
      'wrong-version',
    ]);
    expect(result.signalEvaluations).toEqual([
      {
        signalId: 'old-cycle',
        disposition: 'REJECTED',
        rejectionReason: 'CYCLE_MISMATCH',
      },
      {
        signalId: 'replayed',
        disposition: 'REJECTED',
        rejectionReason: 'ALREADY_CONSUMED',
      },
      {
        signalId: 'stale',
        disposition: 'REJECTED',
        rejectionReason: 'OUTSIDE_FRESHNESS_WINDOW',
      },
      {
        signalId: 'unauthenticated',
        disposition: 'REJECTED',
        rejectionReason: 'UNAUTHENTICATED',
      },
      {
        signalId: 'wrong-version',
        disposition: 'REJECTED',
        rejectionReason: 'ROUTE_VERSION_MISMATCH',
      },
    ]);
  });
});

describe('health decision transitions', () => {
  it('keeps feed eligibility after one failed cycle, degrades after two, and excludes after three', () => {
    const first = evaluateHealthCycle(input(failedSignals()));
    expect(first).toMatchObject({
      decision: 'HEALTHY',
      reason: 'FAILED_CYCLE_OBSERVED',
      allowNewAssignments: true,
      triggerReplacement: false,
      state: { consecutiveFailureCycles: 1 },
    });

    const second = evaluateHealthCycle(
      input(failedSignals(), { previousState: first.state }),
    );
    expect(second).toMatchObject({
      decision: 'DEGRADED',
      reason: 'FAILURE_THRESHOLD_REACHED',
      allowNewAssignments: false,
      triggerReplacement: false,
      state: { consecutiveFailureCycles: 2 },
    });

    const third = evaluateHealthCycle(
      input(failedSignals(), { previousState: second.state }),
    );
    expect(third).toMatchObject({
      decision: 'DEGRADED',
      reason: 'EXCLUSION_THRESHOLD_REACHED',
      triggerReplacement: true,
      triggerIncident: true,
      state: {
        consecutiveFailureCycles: 3,
        excludedFromCandidates: true,
      },
    });
  });

  it('takes transition thresholds from the selected policy version', () => {
    const customPolicy = {
      ...policy,
      degradedFailureCycles: 3,
      excludeFailureCycles: 4,
    };
    const result = evaluateHealthCycle(
      input(failedSignals(), {
        policy: { id: 'custom-id', code: 'custom', config: customPolicy },
        previousState: {
          ...healthyState(),
          consecutiveFailureCycles: 1,
        },
      }),
    );

    expect(result).toMatchObject({
      decision: 'HEALTHY',
      reason: 'FAILED_CYCLE_OBSERVED',
      state: { consecutiveFailureCycles: 2 },
    });
  });

  it('degrades after two mixed/unknown cycles without excluding or replacing', () => {
    const mixed = evaluateHealthCycle(
      input([signal('success-a', 'SUCCESS'), signal('failure-a', 'FAILURE')]),
    );
    const uncertain = evaluateHealthCycle(
      input([], { previousState: mixed.state }),
    );

    expect(mixed).toMatchObject({
      decision: 'HEALTHY',
      reason: 'MIXED_CYCLE',
      state: { consecutiveFailureCycles: 0, consecutiveUncertainCycles: 1 },
    });
    expect(uncertain).toMatchObject({
      decision: 'DEGRADED',
      reason: 'UNCERTAINTY_THRESHOLD_REACHED',
      triggerReplacement: false,
      triggerIncident: false,
      state: { consecutiveFailureCycles: 0, consecutiveUncertainCycles: 2 },
    });
  });

  it('resets uncertainty on quorum success', () => {
    const result = evaluateHealthCycle(
      input(successSignals(), {
        previousState: { ...healthyState(), consecutiveUncertainCycles: 1 },
      }),
    );

    expect(result.state.consecutiveUncertainCycles).toBe(0);
  });

  it('uses stale heartbeat only to degrade and not as tunnel-failure evidence', () => {
    const boundary = evaluateHealthCycle(
      input(successSignals(), {
        evaluatedAt: new Date('2026-09-08T10:01:30.000Z'),
        lastHeartbeatAt: cycleStartedAt,
      }),
    );
    const stale = evaluateHealthCycle(
      input(successSignals(), {
        evaluatedAt: new Date('2026-09-08T10:01:30.001Z'),
        lastHeartbeatAt: cycleStartedAt,
      }),
    );

    expect(boundary.decision).toBe('HEALTHY');
    expect(stale).toMatchObject({
      decision: 'DEGRADED',
      reason: 'STALE_HEARTBEAT',
      triggerReplacement: false,
      state: { consecutiveFailureCycles: 0 },
    });
  });

  it('recovers only after the configured successes, minimum window and readiness gates', () => {
    let state: HealthDecisionState = {
      ...healthyState(),
      status: 'DEGRADED',
      excludedFromCandidates: true,
      consecutiveFailureCycles: 3,
    };
    for (let index = 0; index < 4; index += 1) {
      const startedAt = new Date(cycleStartedAt.getTime() + index * 60_000);
      const result = evaluateHealthCycle(
        input(
          successSignals().map((item) => ({
            ...item,
            cycleStartedAt: startedAt,
            receivedAt: new Date(startedAt.getTime() + 5_000),
          })),
          {
            cycleStartedAt: startedAt,
            evaluatedAt: new Date(startedAt.getTime() + 10_000),
            lastHeartbeatAt: startedAt,
            previousState: state,
          },
        ),
      );
      state = result.state;
      expect(result.decision).toBe('DEGRADED');
    }

    const fifthStartedAt = new Date(cycleStartedAt.getTime() + 240_000);
    const beforeMinimumWindow = evaluateHealthCycle(
      input(
        successSignals().map((item) => ({
          ...item,
          cycleStartedAt: fifthStartedAt,
          receivedAt: new Date(fifthStartedAt.getTime() + 5_000),
        })),
        {
          cycleStartedAt: fifthStartedAt,
          evaluatedAt: new Date(cycleStartedAt.getTime() + 299_999),
          lastHeartbeatAt: fifthStartedAt,
          previousState: state,
        },
      ),
    );
    expect(beforeMinimumWindow).toMatchObject({
      decision: 'DEGRADED',
      reason: 'RECOVERY_PENDING',
      state: { consecutiveRecoverySuccesses: 5 },
    });

    const recovered = evaluateHealthCycle(
      input(
        successSignals().map((item) => ({
          ...item,
          cycleStartedAt: fifthStartedAt,
          receivedAt: new Date(fifthStartedAt.getTime() + 5_000),
        })),
        {
          cycleStartedAt: fifthStartedAt,
          evaluatedAt: new Date(cycleStartedAt.getTime() + 300_000),
          lastHeartbeatAt: new Date(cycleStartedAt.getTime() + 300_000),
          previousState: {
            ...beforeMinimumWindow.state,
            consecutiveRecoverySuccesses: 4,
          },
        },
      ),
    );
    expect(recovered).toMatchObject({
      decision: 'HEALTHY',
      reason: 'RECOVERY_CONFIRMED',
      state: {
        consecutiveRecoverySuccesses: 0,
        excludedFromCandidates: false,
      },
    });
    expect(recovered.state.cooldownUntil).toEqual(
      new Date(cycleStartedAt.getTime() + 900_000),
    );
  });

  it('keeps recovery pending when convergence or another readiness gate fails', () => {
    const result = evaluateHealthCycle(
      input(successSignals(), {
        evaluatedAt: new Date('2026-09-08T10:05:00.000Z'),
        lastHeartbeatAt: new Date('2026-09-08T10:05:00.000Z'),
        previousState: {
          ...healthyState(),
          status: 'DEGRADED',
          consecutiveRecoverySuccesses: 4,
          recoveryWindowStartedAt: cycleStartedAt,
        },
        recoveryGates: {
          clockTrusted: true,
          servingCheckPassed: true,
          desiredVersion: 8,
          appliedVersion: 7,
        },
      }),
    );

    expect(result).toMatchObject({
      decision: 'DEGRADED',
      reason: 'RECOVERY_PENDING',
    });
  });

  it('quarantines immediately for a critical trust failure', () => {
    expect(
      evaluateHealthCycle(
        input([], {
          criticalTrustFailure: {
            signalId: 'trust-signal',
            kind: 'CREDENTIAL_COMPROMISE',
          },
        }),
      ),
    ).toMatchObject({
      decision: 'QUARANTINED',
      reason: 'CRITICAL_TRUST_FAILURE',
      signalIds: ['trust-signal'],
      triggerReplacement: true,
      triggerIncident: true,
    });
  });

  it('suppresses automatic replacement during cooldown but still raises an incident', () => {
    const result = evaluateHealthCycle(
      input(failedSignals(), {
        previousState: {
          ...healthyState(),
          consecutiveFailureCycles: 2,
          cooldownUntil: new Date('2026-09-08T10:10:00.000Z'),
        },
      }),
    );

    expect(result).toMatchObject({
      decision: 'DEGRADED',
      reason: 'EXCLUSION_THRESHOLD_REACHED',
      state: { excludedFromCandidates: true },
      triggerReplacement: false,
      triggerIncident: true,
    });
  });

  it('allows replacement again at the cooldown boundary', () => {
    const result = evaluateHealthCycle(
      input(failedSignals(), {
        previousState: {
          ...healthyState(),
          consecutiveFailureCycles: 2,
          cooldownUntil: new Date('2026-09-08T10:00:10.000Z'),
        },
      }),
    );

    expect(result).toMatchObject({
      decision: 'DEGRADED',
      state: { excludedFromCandidates: true },
      triggerReplacement: true,
      triggerIncident: true,
    });
  });

  it('does not let cooldown delay a critical trust quarantine', () => {
    const result = evaluateHealthCycle(
      input([], {
        policy: null,
        previousState: {
          ...healthyState(),
          cooldownUntil: new Date('2026-09-08T10:10:00.000Z'),
        },
        criticalTrustFailure: {
          signalId: 'unsafe-runtime',
          kind: 'UNSAFE_RUNTIME',
        },
      }),
    );

    expect(result).toMatchObject({
      decision: 'QUARANTINED',
      reason: 'CRITICAL_TRUST_FAILURE',
      policyVersion: null,
      triggerReplacement: true,
    });
  });

  it('fails closed for missing or invalid policy without excluding the resource', () => {
    for (const unavailablePolicy of [
      null,
      { id: 'bad', code: 'bad', config: {} },
    ]) {
      expect(
        evaluateHealthCycle(
          input(failedSignals(), { policy: unavailablePolicy }),
        ),
      ).toMatchObject({
        decision: 'DEGRADED',
        reason: 'POLICY_UNAVAILABLE',
        policyVersion: null,
        triggerReplacement: false,
        triggerIncident: false,
      });
    }
  });

  it('returns the affected scope, policy version and contributing signal ids', () => {
    expect(
      evaluateHealthCycle(
        input(failedSignals(), {
          affectedScope: { kind: 'PROVIDER_ASN', id: 'asn-64500' },
        }),
      ),
    ).toMatchObject({
      affectedScope: { kind: 'PROVIDER_ASN', id: 'asn-64500' },
      policyVersion: { id: 'health-policy-id', code: 'beta-v1' },
      signalIds: ['failure-a', 'failure-b'],
    });
  });
});
