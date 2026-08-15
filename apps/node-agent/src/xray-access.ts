import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';

import type { XrayServableClient } from './xray-runtime';

export function selectServableXrayClients(
  snapshot: NodeAgentConfigurationSnapshot,
  now: Date,
): XrayServableClient[] {
  const nowMs = now.getTime();
  return snapshot.grants
    .flatMap((grant) => {
      if (grant.status !== 'ACTIVE') return [];
      if (grant.revokedAt !== null) return [];
      if (grant.dataPlaneCredential === null) return [];
      const expiresAt = Date.parse(grant.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return [];
      return [
        {
          grantId: grant.id,
          credential: grant.dataPlaneCredential,
        },
      ];
    })
    .sort((left, right) => left.grantId.localeCompare(right.grantId));
}
