import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { NodeSyncRequestedEvent } from '@vpn-platform/contracts';

type ClaimedNodeSyncJob = {
  id: string;
  leaseToken: string;
};

export interface NodeSyncStore {
  reclaimExpiredLeases(): Promise<number>;
  claim(
    command: NodeSyncRequestedEvent,
    leaseOwner: string,
  ): Promise<ClaimedNodeSyncJob | 'already-completed' | 'terminal' | null>;
  complete(
    id: string,
    leaseOwner: string,
    leaseToken: string,
  ): Promise<boolean>;
  retry(
    id: string,
    leaseOwner: string,
    leaseToken: string,
    errorCode: string,
  ): Promise<'retried' | 'failed' | 'fenced'>;
}

export class PrismaNodeSyncStore implements NodeSyncStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly leaseDurationMs: number,
    private readonly retryDelayMs: number,
    private readonly maxAttempts: number,
  ) {}

  async reclaimExpiredLeases(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "NodeSyncJob"
      SET status = CASE WHEN attempts >= ${this.maxAttempts}
                        THEN 'FAILED'::"NodeSyncJobStatus"
                        ELSE 'PENDING'::"NodeSyncJobStatus" END,
          "completedAt" = CASE WHEN attempts >= ${this.maxAttempts}
                                THEN clock_timestamp()
                                ELSE NULL END,
          "nextAttemptAt" = CASE WHEN attempts >= ${this.maxAttempts}
                                  THEN NULL
                                  ELSE clock_timestamp() END,
          "lastErrorCode" = CASE WHEN attempts >= ${this.maxAttempts}
                                  THEN COALESCE("lastErrorCode", 'NODE_SYNC_LEASE_EXPIRED')
                                  ELSE "lastErrorCode" END,
          "leaseOwner" = NULL,
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE (status = 'PROCESSING' AND "leaseExpiresAt" <= clock_timestamp())
         OR (status = 'PENDING' AND attempts >= ${this.maxAttempts})
    `;
  }

  async claim(
    command: NodeSyncRequestedEvent,
    leaseOwner: string,
  ): Promise<ClaimedNodeSyncJob | 'already-completed' | 'terminal' | null> {
    const leaseToken = randomUUID();
    const grantCommand = 'nodeAccessGrantId' in command ? command : undefined;
    const routeCommand = 'routeEndpointId' in command ? command : undefined;
    if (grantCommand) {
      await this.prisma.$executeRaw`
        UPDATE "NodeSyncJob"
        SET status = CASE WHEN attempts >= ${this.maxAttempts}
                          THEN 'FAILED'::"NodeSyncJobStatus"
                          ELSE 'PENDING'::"NodeSyncJobStatus" END,
            "completedAt" = CASE WHEN attempts >= ${this.maxAttempts}
                                  THEN clock_timestamp()
                                  ELSE NULL END,
            "nextAttemptAt" = CASE WHEN attempts >= ${this.maxAttempts}
                                    THEN NULL
                                    ELSE clock_timestamp() END,
            "lastErrorCode" = CASE WHEN attempts >= ${this.maxAttempts}
                                    THEN COALESCE("lastErrorCode", 'NODE_SYNC_LEASE_EXPIRED')
                                    ELSE "lastErrorCode" END,
            "leaseOwner" = NULL,
            "leaseToken" = NULL,
            "leaseExpiresAt" = NULL,
            "updatedAt" = clock_timestamp()
        WHERE id = CAST(${grantCommand.nodeSyncJobId} AS uuid)
          AND "nodeAccessGrantId" =
            CAST(${grantCommand.nodeAccessGrantId} AS uuid)
          AND "targetVersion" = ${grantCommand.targetVersion}
          AND status = 'PROCESSING'
          AND "leaseExpiresAt" <= clock_timestamp()
      `;
    } else {
      await this.prisma.$executeRaw`
        UPDATE "NodeSyncJob"
        SET status = CASE WHEN attempts >= ${this.maxAttempts}
                          THEN 'FAILED'::"NodeSyncJobStatus"
                          ELSE 'PENDING'::"NodeSyncJobStatus" END,
            "completedAt" = CASE WHEN attempts >= ${this.maxAttempts}
                                  THEN clock_timestamp()
                                  ELSE NULL END,
            "nextAttemptAt" = CASE WHEN attempts >= ${this.maxAttempts}
                                    THEN NULL
                                    ELSE clock_timestamp() END,
            "lastErrorCode" = CASE WHEN attempts >= ${this.maxAttempts}
                                    THEN COALESCE("lastErrorCode", 'NODE_SYNC_LEASE_EXPIRED')
                                    ELSE "lastErrorCode" END,
            "leaseOwner" = NULL,
            "leaseToken" = NULL,
            "leaseExpiresAt" = NULL,
            "updatedAt" = clock_timestamp()
        WHERE id = CAST(${command.nodeSyncJobId} AS uuid)
          AND "routeEndpointId" = CAST(${routeCommand!.routeEndpointId} AS uuid)
          AND "routeConnectionProfileId" =
            CAST(${routeCommand!.routeConnectionProfileId} AS uuid)
          AND "targetVersion" = ${command.targetVersion}
          AND status = 'PROCESSING'
          AND "leaseExpiresAt" <= clock_timestamp()
      `;
    }
    const rows = grantCommand
      ? await this.prisma.$queryRaw<ClaimedNodeSyncJob[]>`
          WITH candidate AS (
            SELECT job.id
            FROM "NodeSyncJob" AS job
            INNER JOIN "NodeAccessGrant" AS access_grant
              ON access_grant.id = job."nodeAccessGrantId"
             AND access_grant."nodeId" = job."nodeId"
            INNER JOIN "Node" AS node ON node.id = job."nodeId"
            WHERE job.id = CAST(${grantCommand.nodeSyncJobId} AS uuid)
              AND job."nodeAccessGrantId" =
                CAST(${grantCommand.nodeAccessGrantId} AS uuid)
              AND job."targetVersion" = ${grantCommand.targetVersion}
              AND node."desiredConfigVersion" >= job."targetVersion"
              AND access_grant."desiredVersion" <= node."desiredConfigVersion"
              AND job.status = 'PENDING'
              AND job.attempts < ${this.maxAttempts}
              AND (
                job."nextAttemptAt" IS NULL
                OR job."nextAttemptAt" <= clock_timestamp()
              )
            FOR UPDATE OF job
          )
          UPDATE "NodeSyncJob" AS job
          SET status = 'PROCESSING',
              attempts = job.attempts + 1,
              "nextAttemptAt" = NULL,
              "leaseOwner" = ${leaseOwner},
              "leaseToken" = CAST(${leaseToken} AS uuid),
              "leaseExpiresAt" = clock_timestamp() + (${this.leaseDurationMs} * interval '1 millisecond'),
              "updatedAt" = clock_timestamp()
          FROM candidate
          WHERE job.id = candidate.id
          RETURNING job.id, job."leaseToken"::text AS "leaseToken"
        `
      : await this.prisma.$queryRaw<ClaimedNodeSyncJob[]>`
          WITH candidate AS (
            SELECT job.id
            FROM "NodeSyncJob" AS job
            INNER JOIN "EndpointConnectionProfile" AS route
              ON route."endpointId" = job."routeEndpointId"
             AND route."connectionProfileId" =
               job."routeConnectionProfileId"
             AND route."nodeId" = job."nodeId"
             AND route."activationVersion" = job."targetVersion"
            INNER JOIN "Node" AS node ON node.id = job."nodeId"
            WHERE job.id = CAST(${command.nodeSyncJobId} AS uuid)
              AND job."routeEndpointId" =
                CAST(${routeCommand!.routeEndpointId} AS uuid)
              AND job."routeConnectionProfileId" =
                CAST(${routeCommand!.routeConnectionProfileId} AS uuid)
              AND job."targetVersion" = ${command.targetVersion}
              AND node."desiredConfigVersion" >= job."targetVersion"
              AND job.status = 'PENDING'
              AND job.attempts < ${this.maxAttempts}
              AND (
                job."nextAttemptAt" IS NULL
                OR job."nextAttemptAt" <= clock_timestamp()
              )
            FOR UPDATE OF job
          )
          UPDATE "NodeSyncJob" AS job
          SET status = 'PROCESSING',
              attempts = job.attempts + 1,
              "nextAttemptAt" = NULL,
              "leaseOwner" = ${leaseOwner},
              "leaseToken" = CAST(${leaseToken} AS uuid),
              "leaseExpiresAt" = clock_timestamp() + (${this.leaseDurationMs} * interval '1 millisecond'),
              "updatedAt" = clock_timestamp()
          FROM candidate
          WHERE job.id = candidate.id
          RETURNING job.id, job."leaseToken"::text AS "leaseToken"
        `;
    if (rows[0]) return rows[0];

    if (routeCommand) {
      const closed = await this.prisma.$queryRaw<{ id: string }[]>`
        UPDATE "NodeSyncJob" AS job
        SET status = 'FAILED'::"NodeSyncJobStatus",
            "completedAt" = clock_timestamp(),
            "nextAttemptAt" = NULL,
            "lastErrorCode" = 'ROUTE_ACTIVATION_CLOSED',
            "leaseOwner" = NULL,
            "leaseToken" = NULL,
            "leaseExpiresAt" = NULL,
            "updatedAt" = clock_timestamp()
        FROM "EndpointConnectionProfile" AS route
        WHERE job.id = CAST(${routeCommand.nodeSyncJobId} AS uuid)
          AND job."nodeAccessGrantId" IS NULL
          AND job."routeEndpointId" =
            CAST(${routeCommand.routeEndpointId} AS uuid)
          AND job."routeConnectionProfileId" =
            CAST(${routeCommand.routeConnectionProfileId} AS uuid)
          AND job."targetVersion" = ${routeCommand.targetVersion}
          AND (
            job.status = 'PENDING'
            OR (
              job.status = 'PROCESSING'
              AND job."leaseExpiresAt" <= clock_timestamp()
            )
          )
          AND route."endpointId" = job."routeEndpointId"
          AND route."connectionProfileId" = job."routeConnectionProfileId"
          AND route."nodeId" = job."nodeId"
          AND route."activationVersion" IS DISTINCT FROM job."targetVersion"
          AND route."lastActivationVersion" >= job."targetVersion"
        RETURNING job.id
      `;
      if (closed[0]) return 'terminal';
    }

    const existing = await this.prisma.nodeSyncJob.findUnique({
      where: { id: command.nodeSyncJobId },
      select: {
        status: true,
        nodeAccessGrantId: true,
        routeEndpointId: true,
        routeConnectionProfileId: true,
        targetVersion: true,
      },
    });
    const resourceMismatch = grantCommand
      ? existing?.nodeAccessGrantId !== grantCommand.nodeAccessGrantId ||
        existing?.routeEndpointId !== null
      : existing?.nodeAccessGrantId !== null ||
        existing?.routeEndpointId !== routeCommand!.routeEndpointId ||
        existing?.routeConnectionProfileId !==
          routeCommand!.routeConnectionProfileId;
    if (
      existing &&
      (resourceMismatch || existing.targetVersion !== command.targetVersion)
    ) {
      return 'terminal';
    }
    if (existing?.status === 'SUCCEEDED') return 'already-completed';
    if (existing?.status === 'FAILED') return 'terminal';
    return null;
  }

  async complete(
    id: string,
    leaseOwner: string,
    leaseToken: string,
  ): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE "NodeSyncJob"
      SET status = 'SUCCEEDED',
          "completedAt" = clock_timestamp(),
          "leaseOwner" = NULL,
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE id = CAST(${id} AS uuid)
        AND status = 'PROCESSING'
        AND "leaseOwner" = ${leaseOwner}
        AND "leaseToken" = CAST(${leaseToken} AS uuid)
        AND "leaseExpiresAt" > clock_timestamp()
    `;
    return count === 1;
  }

  async retry(
    id: string,
    leaseOwner: string,
    leaseToken: string,
    errorCode: string,
  ): Promise<'retried' | 'failed' | 'fenced'> {
    const rows = await this.prisma.$queryRaw<
      { status: 'PENDING' | 'FAILED' }[]
    >`
      UPDATE "NodeSyncJob"
      SET status = CASE WHEN attempts >= ${this.maxAttempts}
                        THEN 'FAILED'::"NodeSyncJobStatus"
                        ELSE 'PENDING'::"NodeSyncJobStatus" END,
          "completedAt" = CASE WHEN attempts >= ${this.maxAttempts}
                                THEN clock_timestamp()
                                ELSE NULL END,
          "nextAttemptAt" = CASE WHEN attempts >= ${this.maxAttempts}
                                  THEN NULL
                                  ELSE clock_timestamp() + (${this.retryDelayMs} * interval '1 millisecond') END,
          "lastErrorCode" = ${errorCode},
          "leaseOwner" = NULL,
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE id = CAST(${id} AS uuid)
        AND status = 'PROCESSING'
        AND "leaseOwner" = ${leaseOwner}
        AND "leaseToken" = CAST(${leaseToken} AS uuid)
        AND "leaseExpiresAt" > clock_timestamp()
      RETURNING status
    `;
    if (rows[0]?.status === 'PENDING') return 'retried';
    if (rows[0]?.status === 'FAILED') return 'failed';
    return 'fenced';
  }
}
