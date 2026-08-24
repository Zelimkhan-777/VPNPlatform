export const ACCESS_CONTROL_ENFORCEMENT_SLA_MS = 5 * 60_000;
export const LOCAL_SECURITY_RETRY_DELAY_MS = 10_000;
export const LOCAL_STATE_INTEGRITY_CHECK_INTERVAL_MS = 10_000;

export const XRAY_RELOAD_COMMAND_TIMEOUT_MS = 30_000;
export const XRAY_DOCKER_COMMAND_TIMEOUT_MS = 2_000;
export const XRAY_SERVING_VERIFY_ATTEMPTS = 10;
export const XRAY_SERVING_VERIFY_RETRY_DELAY_MS = 1_000;

export const XRAY_SERVING_VERIFY_MAX_DURATION_MS =
  XRAY_SERVING_VERIFY_ATTEMPTS * 2 * XRAY_DOCKER_COMMAND_TIMEOUT_MS +
  (XRAY_SERVING_VERIFY_ATTEMPTS - 1) * XRAY_SERVING_VERIFY_RETRY_DELAY_MS;
export const XRAY_APPLY_MAX_DURATION_MS =
  XRAY_RELOAD_COMMAND_TIMEOUT_MS + XRAY_SERVING_VERIFY_MAX_DURATION_MS;
export const XRAY_FAIL_CLOSED_MAX_DURATION_MS =
  3 * XRAY_DOCKER_COMMAND_TIMEOUT_MS;

// Leaves margin for the worst-case apply, fail-closed post-condition probe,
// event-loop delay and command scheduling before the five-minute deadline.
export const LOCAL_FAIL_CLOSED_RESERVE_MS = 120_000;

// A production cycle may spend up to two request timeouts on heartbeat and
// configuration before the bounded Xray apply starts. Sixty seconds preserves
// enough of the five-minute revoke budget for apply, retry and forced stop.
export const PRODUCTION_XRAY_MAX_POLL_INTERVAL_MS = 60_000;

export function effectiveControlPlanePollInterval(
  mode: 'simulation' | 'local-xray' | 'xray',
  configuredIntervalMs: number,
): number {
  return mode === 'xray'
    ? Math.min(configuredIntervalMs, PRODUCTION_XRAY_MAX_POLL_INTERVAL_MS)
    : configuredIntervalMs;
}

export function effectiveControlPlaneRetryInterval(
  mode: 'simulation' | 'local-xray' | 'xray',
  pollIntervalMs: number,
): number {
  return mode === 'xray'
    ? Math.min(pollIntervalMs, LOCAL_SECURITY_RETRY_DELAY_MS)
    : pollIntervalMs;
}

export function successfulControlPlaneCycleDelay(
  outcome: 'synchronized' | 'waiting-for-command' | 'acknowledged',
  pollIntervalMs: number,
  retryIntervalMs: number,
): number {
  return outcome === 'waiting-for-command' ? retryIntervalMs : pollIntervalMs;
}
