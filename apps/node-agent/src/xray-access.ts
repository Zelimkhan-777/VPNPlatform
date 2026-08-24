import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';

import type { XrayServableClient } from './xray-runtime';

type NodeAgentGrant = NodeAgentConfigurationSnapshot['grants'][number];

export function selectServableXrayClients(
  snapshot: NodeAgentConfigurationSnapshot,
  now: Date,
): XrayServableClient[] {
  const nowMs = now.getTime();
  return snapshot.grants
    .flatMap((grant) => {
      const expiresAt = getActiveGrantExpiry(grant);
      if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return [];
      const credential = grant.dataPlaneCredential;
      if (credential === null) return [];
      return [
        {
          grantId: grant.id,
          credential,
        },
      ];
    })
    .sort((left, right) => left.grantId.localeCompare(right.grantId));
}

export function findNextXrayClientExpiry(
  snapshot: NodeAgentConfigurationSnapshot,
  now: Date,
): number | null {
  const nowMs = now.getTime();
  let nextExpiryAt: number | null = null;
  for (const grant of snapshot.grants) {
    const expiresAt = getActiveGrantExpiry(grant);
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) continue;
    if (nextExpiryAt === null || expiresAt < nextExpiryAt) {
      nextExpiryAt = expiresAt;
    }
  }
  return nextExpiryAt;
}

export function findExpiredXrayClientEnforcementDeadline(
  snapshot: NodeAgentConfigurationSnapshot,
  now: Date,
  enforcementSlaMs: number,
): number | null {
  const nowMs = now.getTime();
  let earliestDeadlineAt: number | null = null;
  for (const grant of snapshot.grants) {
    const expiresAt = getActiveGrantExpiry(grant);
    if (!Number.isFinite(expiresAt) || expiresAt > nowMs) continue;
    const deadlineAt = expiresAt + enforcementSlaMs;
    if (earliestDeadlineAt === null || deadlineAt < earliestDeadlineAt) {
      earliestDeadlineAt = deadlineAt;
    }
  }
  return earliestDeadlineAt;
}

export function findRevokedXrayClientEnforcementDeadline(
  previousSnapshot: NodeAgentConfigurationSnapshot,
  nextSnapshot: NodeAgentConfigurationSnapshot,
  now: Date,
  enforcementSlaMs: number,
): number | null {
  const enforcements = findRevokedXrayClientEnforcements(
    previousSnapshot,
    nextSnapshot,
    now,
    enforcementSlaMs,
  );
  return enforcements.reduce<number | null>(
    (earliest, enforcement) =>
      earliest === null
        ? enforcement.deadlineAt
        : Math.min(earliest, enforcement.deadlineAt),
    null,
  );
}

export type XrayClientRevocationEnforcement = {
  grantId: string;
  deadlineAt: number;
};

export function findRevokedXrayClientEnforcements(
  previousSnapshot: NodeAgentConfigurationSnapshot,
  nextSnapshot: NodeAgentConfigurationSnapshot,
  now: Date,
  enforcementSlaMs: number,
): XrayClientRevocationEnforcement[] {
  const previousGrants = new Map(
    previousSnapshot.grants.map((grant) => [grant.id, grant]),
  );
  const nowMs = now.getTime();
  const enforcements: XrayClientRevocationEnforcement[] = [];
  for (const grant of nextSnapshot.grants) {
    const previousGrant = previousGrants.get(grant.id);
    if (grant.status !== 'REVOKED' || grant.revokedAt === null) {
      continue;
    }
    const revokedAt = Date.parse(grant.revokedAt);
    if (
      !previousGrant ||
      previousGrant.status !== 'ACTIVE' ||
      previousGrant.revokedAt !== null ||
      previousGrant.dataPlaneCredential === null ||
      Date.parse(previousGrant.expiresAt) <= revokedAt ||
      !Number.isFinite(revokedAt) ||
      revokedAt > nowMs
    ) {
      continue;
    }
    enforcements.push({
      grantId: grant.id,
      deadlineAt: revokedAt + enforcementSlaMs,
    });
  }
  return enforcements.sort((left, right) =>
    left.grantId.localeCompare(right.grantId),
  );
}

export function findSnapshotRevocationEnforcements(
  snapshot: NodeAgentConfigurationSnapshot,
  enforcementSlaMs: number,
): XrayClientRevocationEnforcement[] {
  return snapshot.grants
    .flatMap((grant) => {
      if (grant.status !== 'REVOKED' || grant.revokedAt === null) return [];
      return [
        {
          grantId: grant.id,
          deadlineAt: Date.parse(grant.revokedAt) + enforcementSlaMs,
        },
      ];
    })
    .sort((left, right) => left.grantId.localeCompare(right.grantId));
}

function getActiveGrantExpiry(grant: NodeAgentGrant): number {
  if (grant.status !== 'ACTIVE') return Number.NaN;
  if (grant.revokedAt !== null) return Number.NaN;
  if (grant.dataPlaneCredential === null) return Number.NaN;
  return Date.parse(grant.expiresAt);
}
