export const NODE_ACCESS_CONTROL_STATUSES = [
  'HEALTHY',
  'DRAINING',
  'DISABLED',
] as const;

export const NODE_AGENT_AUTH_STATUSES = [
  ...NODE_ACCESS_CONTROL_STATUSES,
  'QUARANTINED',
] as const;

export const NODE_EMERGENCY_QUARANTINE_SOURCE_STATUSES = [
  'HEALTHY',
  'DRAINING',
  'DISABLED',
] as const;

export type NodeAccessControlStatus =
  (typeof NODE_ACCESS_CONTROL_STATUSES)[number];

export type NodeAgentAuthStatus = (typeof NODE_AGENT_AUTH_STATUSES)[number];

export function isNodeInAccessControlSync(
  status: string,
): status is NodeAccessControlStatus {
  return (NODE_ACCESS_CONTROL_STATUSES as readonly string[]).includes(status);
}

export function isNodeAgentAuthAllowed(
  status: string,
): status is NodeAgentAuthStatus {
  return (NODE_AGENT_AUTH_STATUSES as readonly string[]).includes(status);
}

export function isNodeEligibleForNewAssignment(status: string): boolean {
  return status === 'HEALTHY';
}

export function isNodeEligibleForEmergencyQuarantine(status: string): boolean {
  return (
    NODE_EMERGENCY_QUARANTINE_SOURCE_STATUSES as readonly string[]
  ).includes(status);
}
