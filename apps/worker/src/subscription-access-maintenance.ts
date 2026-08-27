import { setTimeout as delay } from 'node:timers/promises';

import type { Logger } from '@vpn-platform/safe-logger';
import type { AccessMaintenanceBatchResult } from '@vpn-platform/orchestration-store';

export interface SubscriptionAccessMaintenanceStore {
  materializeExpiredSubscriptions(
    limit: number,
  ): Promise<AccessMaintenanceBatchResult>;
  reconcileAccess(limit: number): Promise<AccessMaintenanceBatchResult>;
}

export class SubscriptionAccessMaintenance {
  constructor(
    private readonly store: SubscriptionAccessMaintenanceStore,
    private readonly batchSize: number,
    private readonly logger: Pick<Logger, 'info'>,
  ) {}

  async runOnce(): Promise<{
    expiredSubscriptions: number;
    reconciliationRepairs: number;
    failures: number;
  }> {
    const expiry = await this.store.materializeExpiredSubscriptions(
      this.batchSize,
    );
    const reconciliation = await this.store.reconcileAccess(this.batchSize);
    const expiredSubscriptions = expiry.processed;
    const reconciliationRepairs = reconciliation.processed;
    const failures = expiry.failed + reconciliation.failed;
    if (expiredSubscriptions > 0 || reconciliationRepairs > 0 || failures > 0) {
      this.logger.info(
        {
          component: 'subscription-access-maintenance',
          expiredSubscriptions,
          reconciliationRepairs,
          failures,
        },
        'Subscription access maintenance batch completed',
      );
    }
    return { expiredSubscriptions, reconciliationRepairs, failures };
  }
}

export async function runSubscriptionAccessMaintenance(
  maintenance: SubscriptionAccessMaintenance,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await maintenance.runOnce();
    await delay(intervalMs, undefined, { signal }).catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
  }
}
