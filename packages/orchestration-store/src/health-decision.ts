import {
  healthPolicyConfigSchema,
  type HealthPolicyConfig,
} from './operational-policy';

export const HEALTH_SCOPE_KINDS = [
  'PROFILE',
  'ENDPOINT',
  'NODE',
  'PROVIDER_ASN',
] as const;
export type HealthScopeKind = (typeof HEALTH_SCOPE_KINDS)[number];

export const ROUTE_FAILURE_CLASSES = [
  'DNS',
  'TCP_TLS',
  'VPN_HANDSHAKE',
  'TEST_TRAFFIC',
] as const;
export type RouteFailureClass = (typeof ROUTE_FAILURE_CLASSES)[number];

export type ProbeSignal = {
  id: string;
  sourceId: string;
  independenceKey: string;
  cycleStartedAt: Date;
  receivedAt: Date;
  authenticated: boolean;
  controlHealthy: boolean;
  routeVersion: number;
  outcome: 'SUCCESS' | 'FAILURE' | 'PROBE_SOURCE_FAILURE';
  failureClass?: RouteFailureClass;
};

export type ProbeCycleDecision = 'SUCCESS' | 'FAILED' | 'MIXED' | 'UNKNOWN';

export type ProbeCycleResult = {
  decision: ProbeCycleDecision;
  failureClass: RouteFailureClass | null;
  signalIds: string[];
  rejectedSignalIds: string[];
  additionalProbeDueAt: Date | null;
};

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'EXCLUDED' | 'QUARANTINED';

export type HealthDecisionState = {
  status: HealthStatus;
  consecutiveFailureCycles: number;
  consecutiveRecoverySuccesses: number;
  recoveryWindowStartedAt: Date | null;
  consecutiveUncertainCycles: number;
  cooldownUntil: Date | null;
};

export type HealthDecisionReason =
  | 'POLICY_UNAVAILABLE'
  | 'CRITICAL_TRUST_FAILURE'
  | 'STALE_HEARTBEAT'
  | 'FAILED_CYCLE_OBSERVED'
  | 'FAILURE_THRESHOLD_REACHED'
  | 'EXCLUSION_THRESHOLD_REACHED'
  | 'SUCCESS_CONFIRMED'
  | 'RECOVERY_PENDING'
  | 'RECOVERY_CONFIRMED'
  | 'MIXED_CYCLE'
  | 'UNKNOWN_CYCLE'
  | 'UNCERTAINTY_THRESHOLD_REACHED';

export type HealthDecision = {
  decision: HealthStatus;
  reason: HealthDecisionReason;
  affectedScope: { kind: HealthScopeKind; id: string };
  policyVersion: { id: string; code: string } | null;
  signalIds: string[];
  cycle: ProbeCycleResult | null;
  state: HealthDecisionState;
  allowNewAssignments: boolean;
  triggerReplacement: boolean;
  triggerIncident: boolean;
};

export type CriticalTrustFailure = {
  signalId: string;
  kind: 'UNTRUSTED_CLOCK' | 'CREDENTIAL_COMPROMISE' | 'UNSAFE_RUNTIME';
};

export type EvaluateHealthCycleInput = {
  policy: { id: string; code: string; config: unknown } | null;
  affectedScope: { kind: HealthScopeKind; id: string };
  routeVersion: number;
  cycleStartedAt: Date;
  evaluatedAt: Date;
  signals: ProbeSignal[];
  consumedSignalIds?: ReadonlySet<string>;
  previousState: HealthDecisionState;
  lastHeartbeatAt: Date | null;
  recoveryGates: {
    clockTrusted: boolean;
    servingCheckPassed: boolean;
    desiredVersion: number;
    appliedVersion: number;
  };
  criticalTrustFailure?: CriticalTrustFailure;
};

const milliseconds = (seconds: number) => seconds * 1_000;

const sameInstant = (left: Date, right: Date) =>
  left.getTime() === right.getTime();

const isEligibleSignal = (
  policy: HealthPolicyConfig,
  signal: ProbeSignal,
  cycleStartedAt: Date,
  routeVersion: number,
  consumedSignalIds: ReadonlySet<string>,
) => {
  const receivedAt = signal.receivedAt.getTime();
  const cycleStart = cycleStartedAt.getTime();
  return (
    !consumedSignalIds.has(signal.id) &&
    signal.authenticated &&
    signal.controlHealthy &&
    signal.routeVersion === routeVersion &&
    sameInstant(signal.cycleStartedAt, cycleStartedAt) &&
    receivedAt >= cycleStart &&
    receivedAt <= cycleStart + milliseconds(policy.resultFreshnessSeconds)
  );
};

export function aggregateHealthProbeCycle(
  policy: HealthPolicyConfig,
  input: Pick<
    EvaluateHealthCycleInput,
    'cycleStartedAt' | 'routeVersion' | 'signals'
  > & { consumedSignalIds?: ReadonlySet<string> },
): ProbeCycleResult {
  const consumedSignalIds = input.consumedSignalIds ?? new Set<string>();
  const rejectedSignalIds = new Set<string>();
  const seenSignalIds = new Set<string>();
  const seenSourceIds = new Set<string>();
  const votes = new Map<string, ProbeSignal>();

  const orderedSignals = [...input.signals].sort(
    (left, right) =>
      left.receivedAt.getTime() - right.receivedAt.getTime() ||
      left.id.localeCompare(right.id),
  );
  for (const signal of orderedSignals) {
    if (
      seenSignalIds.has(signal.id) ||
      !isEligibleSignal(
        policy,
        signal,
        input.cycleStartedAt,
        input.routeVersion,
        consumedSignalIds,
      )
    ) {
      rejectedSignalIds.add(signal.id);
      continue;
    }
    seenSignalIds.add(signal.id);

    if (
      seenSourceIds.has(signal.sourceId) ||
      votes.has(signal.independenceKey)
    ) {
      rejectedSignalIds.add(signal.id);
      continue;
    }
    seenSourceIds.add(signal.sourceId);
    votes.set(signal.independenceKey, signal);
  }

  const routeVotes = [...votes.values()].filter(
    (signal) => signal.outcome !== 'PROBE_SOURCE_FAILURE',
  );
  const successes = routeVotes.filter((signal) => signal.outcome === 'SUCCESS');
  const failures = routeVotes.filter(
    (signal): signal is ProbeSignal & { failureClass: RouteFailureClass } =>
      signal.outcome === 'FAILURE' &&
      signal.failureClass !== undefined &&
      policy.routeFailureClasses.includes(signal.failureClass),
  );
  const signalIds = routeVotes.map((signal) => signal.id).sort();

  if (successes.length > 0 && failures.length > 0) {
    return {
      decision: 'MIXED',
      failureClass: null,
      signalIds,
      rejectedSignalIds: [...rejectedSignalIds].sort(),
      additionalProbeDueAt: new Date(
        input.cycleStartedAt.getTime() +
          milliseconds(policy.additionalProbeDelaySeconds),
      ),
    };
  }

  const failuresByClass = new Map<RouteFailureClass, ProbeSignal[]>();
  for (const signal of failures) {
    const matching = failuresByClass.get(signal.failureClass) ?? [];
    matching.push(signal);
    failuresByClass.set(signal.failureClass, matching);
  }
  const confirmedFailureClass = policy.routeFailureClasses.find(
    (failureClass) =>
      (failuresByClass.get(failureClass)?.length ?? 0) >=
      policy.probeSourceQuorum,
  );
  if (confirmedFailureClass) {
    const matchingFailures = failuresByClass.get(confirmedFailureClass) ?? [];
    return {
      decision: 'FAILED',
      failureClass: confirmedFailureClass,
      signalIds: matchingFailures.map((signal) => signal.id).sort(),
      rejectedSignalIds: [...rejectedSignalIds].sort(),
      additionalProbeDueAt: null,
    };
  }

  if (successes.length >= policy.probeSourceQuorum) {
    return {
      decision: 'SUCCESS',
      failureClass: null,
      signalIds: successes.map((signal) => signal.id).sort(),
      rejectedSignalIds: [...rejectedSignalIds].sort(),
      additionalProbeDueAt: null,
    };
  }

  return {
    decision: 'UNKNOWN',
    failureClass: null,
    signalIds,
    rejectedSignalIds: [...rejectedSignalIds].sort(),
    additionalProbeDueAt: null,
  };
}

const copyState = (state: HealthDecisionState): HealthDecisionState => ({
  ...state,
  recoveryWindowStartedAt: state.recoveryWindowStartedAt
    ? new Date(state.recoveryWindowStartedAt)
    : null,
  cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil) : null,
});

const elevatedStatus = (
  current: HealthStatus,
  minimum: 'DEGRADED' | 'EXCLUDED',
): HealthStatus => {
  const severity: Record<HealthStatus, number> = {
    HEALTHY: 0,
    DEGRADED: 1,
    EXCLUDED: 2,
    QUARANTINED: 3,
  };
  return severity[current] >= severity[minimum] ? current : minimum;
};

const finishDecision = (
  input: EvaluateHealthCycleInput,
  state: HealthDecisionState,
  reason: HealthDecisionReason,
  cycle: ProbeCycleResult | null,
  policyVersion: { id: string; code: string } | null,
): HealthDecision => {
  const cooldownActive =
    state.cooldownUntil !== null &&
    state.cooldownUntil.getTime() > input.evaluatedAt.getTime();
  return {
    decision: state.status,
    reason,
    affectedScope: input.affectedScope,
    policyVersion,
    signalIds:
      cycle?.signalIds ??
      (input.criticalTrustFailure ? [input.criticalTrustFailure.signalId] : []),
    cycle,
    state,
    allowNewAssignments: state.status === 'HEALTHY',
    triggerReplacement:
      reason === 'CRITICAL_TRUST_FAILURE' ||
      (reason === 'EXCLUSION_THRESHOLD_REACHED' && !cooldownActive),
    triggerIncident:
      reason === 'EXCLUSION_THRESHOLD_REACHED' ||
      reason === 'CRITICAL_TRUST_FAILURE',
  };
};

export function evaluateHealthCycle(
  input: EvaluateHealthCycleInput,
): HealthDecision {
  const parsedPolicy = healthPolicyConfigSchema.safeParse(input.policy?.config);
  if (input.criticalTrustFailure) {
    const state = copyState(input.previousState);
    state.status = 'QUARANTINED';
    state.consecutiveRecoverySuccesses = 0;
    state.recoveryWindowStartedAt = null;
    return finishDecision(
      input,
      state,
      'CRITICAL_TRUST_FAILURE',
      null,
      input.policy && parsedPolicy.success
        ? { id: input.policy.id, code: input.policy.code }
        : null,
    );
  }
  if (!input.policy || !parsedPolicy.success) {
    const state = copyState(input.previousState);
    state.status = elevatedStatus(state.status, 'DEGRADED');
    return finishDecision(input, state, 'POLICY_UNAVAILABLE', null, null);
  }

  const policy = parsedPolicy.data;
  const policyVersion = { id: input.policy.id, code: input.policy.code };

  const cycle = aggregateHealthProbeCycle(policy, input);
  const state = copyState(input.previousState);
  let reason: HealthDecisionReason;

  if (cycle.decision === 'FAILED') {
    state.consecutiveFailureCycles += 1;
    state.consecutiveRecoverySuccesses = 0;
    state.recoveryWindowStartedAt = null;
    state.consecutiveUncertainCycles = 0;
    if (state.consecutiveFailureCycles >= policy.excludeFailureCycles) {
      state.status = elevatedStatus(state.status, 'EXCLUDED');
      reason = 'EXCLUSION_THRESHOLD_REACHED';
    } else if (state.consecutiveFailureCycles >= policy.degradedFailureCycles) {
      state.status = elevatedStatus(state.status, 'DEGRADED');
      reason = 'FAILURE_THRESHOLD_REACHED';
    } else {
      reason = 'FAILED_CYCLE_OBSERVED';
    }
  } else if (cycle.decision === 'SUCCESS') {
    state.consecutiveFailureCycles = 0;
    state.consecutiveUncertainCycles = 0;
    if (state.status === 'HEALTHY') {
      state.consecutiveRecoverySuccesses = 0;
      state.recoveryWindowStartedAt = null;
      reason = 'SUCCESS_CONFIRMED';
    } else {
      state.consecutiveRecoverySuccesses += 1;
      state.recoveryWindowStartedAt ??= input.cycleStartedAt;
      const heartbeatFresh =
        input.lastHeartbeatAt !== null &&
        input.evaluatedAt.getTime() - input.lastHeartbeatAt.getTime() <=
          milliseconds(policy.staleHeartbeatSeconds);
      const recoveryWindowComplete =
        input.evaluatedAt.getTime() - state.recoveryWindowStartedAt.getTime() >=
        milliseconds(policy.recoveryMinimumSeconds);
      const gatesPass =
        heartbeatFresh &&
        input.recoveryGates.clockTrusted &&
        input.recoveryGates.servingCheckPassed &&
        input.recoveryGates.desiredVersion ===
          input.recoveryGates.appliedVersion;
      if (
        state.status !== 'QUARANTINED' &&
        state.consecutiveRecoverySuccesses >= policy.recoverySuccessCycles &&
        recoveryWindowComplete &&
        gatesPass
      ) {
        state.status = 'HEALTHY';
        state.consecutiveRecoverySuccesses = 0;
        state.recoveryWindowStartedAt = null;
        state.cooldownUntil = new Date(
          input.evaluatedAt.getTime() + milliseconds(policy.cooldownSeconds),
        );
        reason = 'RECOVERY_CONFIRMED';
      } else {
        reason = 'RECOVERY_PENDING';
      }
    }
  } else {
    state.consecutiveUncertainCycles += 1;
    state.consecutiveRecoverySuccesses = 0;
    state.recoveryWindowStartedAt = null;
    if (state.consecutiveUncertainCycles >= policy.mixedUnknownDegradedCycles) {
      state.status = elevatedStatus(state.status, 'DEGRADED');
      reason = 'UNCERTAINTY_THRESHOLD_REACHED';
    } else {
      reason = cycle.decision === 'MIXED' ? 'MIXED_CYCLE' : 'UNKNOWN_CYCLE';
    }
  }

  const heartbeatStale =
    input.lastHeartbeatAt === null ||
    input.evaluatedAt.getTime() - input.lastHeartbeatAt.getTime() >
      milliseconds(policy.staleHeartbeatSeconds);
  if (heartbeatStale && state.status === 'HEALTHY') {
    state.status = 'DEGRADED';
    reason = 'STALE_HEARTBEAT';
  }

  return finishDecision(input, state, reason, cycle, policyVersion);
}
