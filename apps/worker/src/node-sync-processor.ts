import { setTimeout as delay } from 'node:timers/promises';

import { nodeSyncRequestedEventSchema } from '@vpn-platform/contracts';
import {
  type NodeSyncStore,
  PrismaNodeSyncStore,
} from '@vpn-platform/orchestration-store';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

export { PrismaNodeSyncStore };
export type { NodeSyncStore };

export async function runNodeSyncLeaseReclaimer(
  store: Pick<NodeSyncStore, 'reclaimExpiredLeases'>,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await store.reclaimExpiredLeases();
    await delay(intervalMs, undefined, { signal }).catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
  }
}

export class NodeSyncProcessor {
  constructor(
    private readonly store: NodeSyncStore,
    private readonly leaseOwner: string,
    private readonly logger: Logger,
  ) {}

  async process(job: Pick<Job, 'name' | 'data'>): Promise<void> {
    if (job.name !== 'node-sync.requested') {
      throw new Error('Unsupported node-sync job');
    }
    const parsed = nodeSyncRequestedEventSchema.safeParse(job.data);
    if (!parsed.success) throw new Error('Invalid node-sync job payload');
    const command = parsed.data;
    const claimed = await this.store.claim(command, this.leaseOwner);
    if (claimed === 'already-completed' || claimed === 'terminal') return;
    if (!claimed) throw new Error('Node-sync job is temporarily unavailable');

    try {
      const completed = await this.store.complete(
        claimed.id,
        this.leaseOwner,
        claimed.leaseToken,
      );
      if (!completed) {
        this.logger.warn(
          { component: 'node-sync-processor', nodeSyncJobId: claimed.id },
          'Node-sync completion was fenced',
        );
        throw new Error('Node-sync completion was fenced');
      }
    } catch (error) {
      const outcome = await this.store.retry(
        claimed.id,
        this.leaseOwner,
        claimed.leaseToken,
        'NODE_SYNC_PROCESSING_FAILED',
      );
      this.logger.warn(
        {
          component: 'node-sync-processor',
          nodeSyncJobId: claimed.id,
          outcome,
          errorType: error instanceof Error ? error.constructor.name : 'Error',
        },
        'Node-sync processing failed',
      );
      throw error;
    }
  }
}
