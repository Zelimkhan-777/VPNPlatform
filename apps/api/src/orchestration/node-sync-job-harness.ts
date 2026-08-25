import type { NodeSyncRequestedEvent } from '@vpn-platform/contracts';
import {
  parseOrchestrationStoreEnvironment,
  PrismaNodeSyncStore,
} from '@vpn-platform/orchestration-store';

import type { PrismaService } from '../database/prisma.service';

export async function completeNodeSyncJobForHarness(
  prisma: PrismaService,
  nodeSyncJobId: string,
  leaseOwner: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const job = await readNodeSyncJobCommand(prisma, nodeSyncJobId);
  if (job.status === 'SUCCEEDED') return;

  const policy = parseOrchestrationStoreEnvironment(environment);
  const store = new PrismaNodeSyncStore(
    prisma,
    policy.ORCHESTRATION_LEASE_DURATION_MS,
    0,
    policy.ORCHESTRATION_MAX_ATTEMPTS,
  );
  const claimed = await store.claim(job.command, leaseOwner);
  if (claimed === 'already-completed') return;
  if (!claimed || claimed === 'terminal') {
    throw new Error('Harness could not claim a sync job');
  }
  if (!(await store.complete(claimed.id, leaseOwner, claimed.leaseToken))) {
    throw new Error('Harness could not complete a sync job');
  }
}

export async function readNodeSyncJobCommand(
  prisma: PrismaService,
  nodeSyncJobId: string,
): Promise<{ status: string; command: NodeSyncRequestedEvent }> {
  const job = await prisma.nodeSyncJob.findUniqueOrThrow({
    where: { id: nodeSyncJobId },
    select: {
      status: true,
      nodeAccessGrantId: true,
      routeEndpointId: true,
      routeConnectionProfileId: true,
      targetVersion: true,
    },
  });
  return {
    status: job.status,
    command: toNodeSyncCommand(nodeSyncJobId, job),
  };
}

function toNodeSyncCommand(
  nodeSyncJobId: string,
  job: {
    nodeAccessGrantId: string | null;
    routeEndpointId: string | null;
    routeConnectionProfileId: string | null;
    targetVersion: number;
  },
): NodeSyncRequestedEvent {
  if (
    job.nodeAccessGrantId &&
    !job.routeEndpointId &&
    !job.routeConnectionProfileId
  ) {
    return {
      nodeAccessGrantId: job.nodeAccessGrantId,
      nodeSyncJobId,
      targetVersion: job.targetVersion,
    };
  }
  if (
    !job.nodeAccessGrantId &&
    job.routeEndpointId &&
    job.routeConnectionProfileId
  ) {
    return {
      routeEndpointId: job.routeEndpointId,
      routeConnectionProfileId: job.routeConnectionProfileId,
      nodeSyncJobId,
      targetVersion: job.targetVersion,
    };
  }
  throw new Error('Harness found an invalid sync job resource binding');
}
