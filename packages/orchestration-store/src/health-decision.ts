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

export const PROBE_SIGNAL_REJECTION_REASONS = [
  'POLICY_UNAVAILABLE',
  'ALREADY_CONSUMED',
  'UNAUTHENTICATED',
  'CONTROL_UNHEALTHY',
  'ROUTE_VERSION_MISMATCH',
  'CYCLE_MISMATCH',
  'OUTSIDE_FRESHNESS_WINDOW',
  'DUPLICATE_SOURCE',
  'DUPLICATE_INDEPENDENCE_KEY',
] as const;
export type ProbeSignalRejectionReason =
  (typeof PROBE_SIGNAL_REJECTION_REASONS)[number];

export type ProbeSignalEvaluation = {
  signalId: string;
  disposition: 'ACCEPTED' | 'REJECTED';
  rejectionReason: ProbeSignalRejectionReason | null;
};

export type ProbeCycleResult = {
  cycleStartedAt: Date;
  decision: ProbeCycleDecision;
  failureClass: RouteFailureClass | null;
  signalIds: string[];
  rejectedSignalIds: string[];
  signalEvaluations: ProbeSignalEvaluation[];
  additionalProbeDueAt: Date | null;
};

export type HealthStatus =
  | 'UNKNOWN'
  | 'HEALTHY'
  | 'DEGRADED'
  | 'PARTIALLY_BLOCKED'
  | 'QUARANTINED'
  | 'BLOCKED'
  | 'OFFLINE'
  | 'DISABLED';

export type HealthDecisionState = {
  status: HealthStatus;
  excludedFromCandidates: boolean;
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

const signalRejectionReason = (
  policy: HealthPolicyConfig,
  signal: ProbeSignal,
  cycleStartedAt: Date,
  routeVersion: number,
  consumedSignalIds: ReadonlySet<string>,
): ProbeSignalRejectionReason | null => {
  const receivedAt = signal.receivedAt.getTime();
  const cycleStart = cycleStartedAt.getTime();
  if (consumedSignalIds.has(signal.id)) return 'ALREADY_CONSUMED';
  if (!signal.authenticated) return 'UNAUTHENTICATED';
  if (!signal.controlHealthy) return 'CONTROL_UNHEALTHY';
  if (signal.routeVersion !== routeVersion) return 'ROUTE_VERSION_MISMATCH';
  if (!sameInstant(signal.cycleStartedAt, cycleStartedAt))
    return 'CYCLE_MISMATCH';
  if (
    receivedAt < cycleStart ||
    receivedAt > cycleStart + milliseconds(policy.resultFreshnessSeconds)
  )
    return 'OUTSIDE_FRESHNESS_WINDOW';
  return null;
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
  const signalEvaluations = new Map<string, ProbeSignalEvaluation>();

  const orderedSignals = [...input.signals].sort(
    (left, right) =>
      left.receivedAt.getTime() - right.receivedAt.getTime() ||
      left.id.localeCompare(right.id),
  );
  for (const signal of orderedSignals) {
    if (seenSignalIds.has(signal.id)) {
      rejectedSignalIds.add(signal.id);
      continue;
    }
    seenSignalIds.add(signal.id);

    const rejectionReason = signalRejectionReason(
      policy,
      signal,
      input.cycleStartedAt,
      input.routeVersion,
      consumedSignalIds,
    );
    if (rejectionReason) {
      rejectedSignalIds.add(signal.id);
      signalEvaluations.set(signal.id, {
        signalId: signal.id,
        disposition: 'REJECTED',
        rejectionReason,
      });
      continue;
    }

    if (seenSourceIds.has(signal.sourceId)) {
      rejectedSignalIds.add(signal.id);
      signalEvaluations.set(signal.id, {
        signalId: signal.id,
        disposition: 'REJECTED',
        rejectionReason: 'DUPLICATE_SOURCE',
      });
      continue;
    }
    if (votes.has(signal.independenceKey)) {
      rejectedSignalIds.add(signal.id);
      signalEvaluations.set(signal.id, {
        signalId: signal.id,
        disposition: 'REJECTED',
        rejectionReason: 'DUPLICATE_INDEPENDENCE_KEY',
      });
      continue;
    }
    seenSourceIds.add(signal.sourceId);
    votes.set(signal.independenceKey, signal);
    signalEvaluations.set(signal.id, {
      signalId: signal.id,
      disposition: 'ACCEPTED',
      rejectionReason: null,
    });
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
  const evaluations = [...signalEvaluations.values()].sort((left, right) =>
    left.signalId.localeCompare(right.signalId),
  );

  if (successes.length > 0 && failures.length > 0) {
    return {
      cycleStartedAt: input.cycleStartedAt,
      decision: 'MIXED',
      failureClass: null,
      signalIds,
      rejectedSignalIds: [...rejectedSignalIds].sort(),
      signalEvaluations: evaluations,
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
    return {
      cycleStartedAt: input.cycleStartedAt,
      decision: 'FAILED',
      failureClass: confirmedFailureClass,
      signalIds,
      rejectedSignalIds: [...rejectedSignalIds].sort(),
      signalEvaluations: evaluations,
      additionalProbeDueAt: null,
    };
  }

  if (successes.length >= policy.probeSourceQuorum) {
    return {
      cycleStartedAt: input.cycleStartedAt,
      decision: 'SUCCESS',
      failureClass: null,
      signalIds,
      rejectedSignalIds: [...rejectedSignalIds].sort(),
      signalEvaluations: evaluations,
      additionalProbeDueAt: null,
    };
  }

  return {
    cycleStartedAt: input.cycleStartedAt,
    decision: 'UNKNOWN',
    failureClass: null,
    signalIds,
    rejectedSignalIds: [...rejectedSignalIds].sort(),
    signalEvaluations: evaluations,
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

const atLeastDegraded = (current: HealthStatus): HealthStatus =>
  current === 'HEALTHY' || current === 'UNKNOWN' ? 'DEGRADED' : current;

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
    allowNewAssignments:
      state.status === 'HEALTHY' && !state.excludedFromCandidates,
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
    state.excludedFromCandidates = true;
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
    state.status = atLeastDegraded(state.status);
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
      state.status = atLeastDegraded(state.status);
      state.excludedFromCandidates = true;
      reason = 'EXCLUSION_THRESHOLD_REACHED';
    } else if (state.consecutiveFailureCycles >= policy.degradedFailureCycles) {
      state.status = atLeastDegraded(state.status);
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
        state.status !== 'DISABLED' &&
        state.consecutiveRecoverySuccesses >= policy.recoverySuccessCycles &&
        recoveryWindowComplete &&
        gatesPass
      ) {
        state.status = 'HEALTHY';
        state.excludedFromCandidates = false;
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
      state.status = atLeastDegraded(state.status);
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
