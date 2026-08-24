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

function getActiveGrantExpiry(grant: NodeAgentGrant): number {
  if (grant.status !== 'ACTIVE') return Number.NaN;
  if (grant.revokedAt !== null) return Number.NaN;
  if (grant.dataPlaneCredential === null) return Number.NaN;
  return Date.parse(grant.expiresAt);
}
