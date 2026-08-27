import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import {
  DATA_PLANE_CREDENTIAL_DERIVATION_VERSION,
  deriveDataPlaneCredential,
  hashDataPlaneCredential,
} from './data-plane-credential';

type LockedSubscription = {
  id: string;
  userId: string;
  expiresAt: Date;
};

type LockedNode = {
  id: string;
  status: 'HEALTHY' | 'DRAINING' | 'DISABLED';
};

type ExpectedDevice = {
  deviceId: string;
  expiresAt: Date;
};

type ExistingGrant = {
  id: string;
  deviceId: string;
  status: 'PENDING' | 'ACTIVE' | 'REVOKED';
  expiresAt: Date;
  desiredVersion: number;
  appliedVersion: number;
};

export type AccessMaintenanceBatchResult = {
  processed: number;
  failed: number;
};

/**
 * Materializes time-derived subscription state and repairs per-node desired
 * access. PostgreSQL remains the only authority; this store only derives new
 * desired versions from the current locked snapshot.
 */
export class PrismaSubscriptionAccessStore {
  private expiryCursor: string | null = null;
  private reconciliationCursor: string | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentialPepper: string,
  ) {
    if (!credentialPepper) {
      throw new Error('Data-plane credential pepper is not configured');
    }
  }

  async materializeExpiredSubscriptions(
    limit: number,
  ): Promise<AccessMaintenanceBatchResult> {
    const candidates = await this.findExpiredSubscriptionCandidates(limit);
    let processed = 0;
    let failed = 0;
    for (const candidate of candidates) {
      let changed = false;
      try {
        const nodeIds = await this.findPendingExpiryNodes(candidate.id);
        for (const nodeId of nodeIds) {
          try {
            const scheduled = await this.prisma.$transaction((transaction) =>
              this.scheduleExpiredSubscriptionOnNode(
                transaction,
                candidate.id,
                candidate.userId,
                nodeId,
              ),
            );
            changed ||= scheduled;
          } catch {
            failed += 1;
          }
        }
        const materialized = await this.prisma.$transaction((transaction) =>
          this.materializeExpiredSubscriptionStatus(
            transaction,
            candidate.id,
            candidate.userId,
          ),
        );
        changed ||= materialized;
      } catch {
        failed += 1;
      }
      if (changed) processed += 1;
    }
    return { processed, failed };
  }

  async reconcileAccess(limit: number): Promise<AccessMaintenanceBatchResult> {
    const candidates = await this.findReconciliationCandidates(limit);
    let repaired = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        const changed = await this.prisma.$transaction((transaction) =>
          this.reconcileOneNode(transaction, candidate.id),
        );
        if (changed) repaired += 1;
      } catch {
        failed += 1;
      }
    }
    return { processed: repaired, failed };
  }

  async reconcileNodeBeforeHealthy(nodeId: string): Promise<boolean> {
    return this.prisma.$transaction((transaction) =>
      this.reconcileOneNode(transaction, nodeId, true),
    );
  }

  private async scheduleExpiredSubscriptionOnNode(
    transaction: Prisma.TransactionClient,
    subscriptionId: string,
    userId: string,
    nodeId: string,
  ): Promise<boolean> {
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`cabinet-device:${userId}`}))
    `;
    const subscriptions = await transaction.$queryRaw<LockedSubscription[]>`
      SELECT "id", "userId", "expiresAt"
      FROM "Subscription"
      WHERE "id" = CAST(${subscriptionId} AS uuid)
        AND "status" IN (
          CAST('ACTIVE' AS "SubscriptionStatus"),
          CAST('EXPIRED' AS "SubscriptionStatus")
        )
        AND "expiresAt" IS NOT NULL
      FOR UPDATE
    `;
    const subscription = subscriptions[0];
    if (!subscription) return false;

    const nodes = await transaction.$queryRaw<LockedNode[]>`
      SELECT "id", "status"::text AS "status"
      FROM "Node"
      WHERE "id" = CAST(${nodeId} AS uuid)
        AND "status" IN (
          CAST('HEALTHY' AS "NodeStatus"),
          CAST('DRAINING' AS "NodeStatus"),
          CAST('DISABLED' AS "NodeStatus")
        )
      FOR UPDATE
    `;
    if (!nodes[0]) return false;

    const databaseTime = await transaction.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = databaseTime[0]?.now;
    if (!now) throw new Error('PostgreSQL clock is unavailable');
    if (subscription.expiresAt.getTime() > now.getTime()) return false;

    const replacementExpiry = await this.findEffectiveExpiry(
      transaction,
      subscription.userId,
      now,
    );
    const desiredExpiry = replacementExpiry ?? subscription.expiresAt;

    const grants = await transaction.$queryRaw<ExistingGrant[]>`
      SELECT access_grant."id",
             access_grant."deviceId",
             access_grant."status"::text AS "status",
             access_grant."expiresAt",
             access_grant."desiredVersion",
             access_grant."appliedVersion"
      FROM "NodeAccessGrant" AS access_grant
      INNER JOIN "Device" AS device
        ON device."id" = access_grant."deviceId"
      WHERE access_grant."nodeId" = CAST(${nodeId} AS uuid)
        AND device."userId" = CAST(${subscription.userId} AS uuid)
        AND access_grant."status" <> CAST('REVOKED' AS "NodeAccessGrantStatus")
      ORDER BY access_grant."id"
      FOR UPDATE OF access_grant
    `;
    if (grants.length === 0) return false;

    const syncJobIdempotencyKey = `subscription-expiry:${subscription.id}:${nodeId}`;
    const outboxEventIdempotencyKey = `subscription-expiry-outbox:${subscription.id}:${nodeId}`;
    if (
      await this.hasMatchingNodeSyncOperation(transaction, {
        nodeId,
        leadGrantId: grants[0]!.id,
        syncJobIdempotencyKey,
        outboxEventIdempotencyKey,
      })
    ) {
      return false;
    }

    const targetVersion = await this.incrementNodeVersion(transaction, nodeId);
    await transaction.nodeAccessGrant.updateMany({
      where: { id: { in: grants.map((grant) => grant.id) } },
      data: { expiresAt: desiredExpiry, desiredVersion: targetVersion },
    });
    await this.createNodeSyncOperation(transaction, {
      nodeId,
      leadGrantId: grants[0]!.id,
      targetVersion,
      syncJobIdempotencyKey,
      outboxEventIdempotencyKey,
    });
    await transaction.auditEvent.create({
      data: {
        action: 'subscription-expiry.access-scheduled',
        entityType: 'Subscription',
        entityId: subscription.id,
        metadata: { nodeId, targetVersion, grantCount: grants.length },
      },
    });
    return true;
  }

  private async materializeExpiredSubscriptionStatus(
    transaction: Prisma.TransactionClient,
    subscriptionId: string,
    userId: string,
  ): Promise<boolean> {
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`cabinet-device:${userId}`}))
    `;
    const subscriptions = await transaction.$queryRaw<LockedSubscription[]>`
      SELECT "id", "userId", "expiresAt"
      FROM "Subscription"
      WHERE "id" = CAST(${subscriptionId} AS uuid)
        AND "status" = CAST('ACTIVE' AS "SubscriptionStatus")
        AND "expiresAt" IS NOT NULL
      FOR UPDATE
    `;
    const subscription = subscriptions[0];
    if (!subscription) return false;
    const databaseTime = await transaction.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = databaseTime[0]?.now;
    if (!now) throw new Error('PostgreSQL clock is unavailable');
    if (subscription.expiresAt.getTime() > now.getTime()) return false;

    await transaction.subscription.update({
      where: { id: subscription.id },
      data: { status: 'EXPIRED' },
    });
    await transaction.auditEvent.create({
      data: {
        action: 'subscription.expired',
        entityType: 'Subscription',
        entityId: subscription.id,
        metadata: { expiredAt: now.toISOString() },
      },
    });
    return true;
  }

  private async reconcileOneNode(
    transaction: Prisma.TransactionClient,
    nodeId: string,
    includeMissingGrants = false,
  ): Promise<boolean> {
    const nodes = await transaction.$queryRaw<LockedNode[]>`
      SELECT node."id", node."status"::text AS "status"
      FROM "Node" AS node
      WHERE node."id" = CAST(${nodeId} AS uuid)
        AND node."status" IN (
          CAST('HEALTHY' AS "NodeStatus"),
          CAST('DRAINING' AS "NodeStatus"),
          CAST('DISABLED' AS "NodeStatus")
        )
      FOR UPDATE OF node
    `;
    const node = nodes[0];
    if (!node) return false;

    const databaseTime = await transaction.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = databaseTime[0]?.now;
    if (!now) throw new Error('PostgreSQL clock is unavailable');

    const expectedDevices = await transaction.$queryRaw<ExpectedDevice[]>`
      SELECT device."id" AS "deviceId", entitlement."expiresAt"
      FROM "Device" AS device
      INNER JOIN LATERAL (
        SELECT subscription."expiresAt"
        FROM "Subscription" AS subscription
        WHERE subscription."userId" = device."userId"
          AND subscription."status" = CAST('ACTIVE' AS "SubscriptionStatus")
          AND subscription."expiresAt" > ${now}
        ORDER BY subscription."expiresAt" DESC, subscription."id"
        LIMIT 1
      ) AS entitlement ON TRUE
      WHERE device."status" = CAST('ACTIVE' AS "DeviceStatus")
      ORDER BY device."id"
    `;
    const cancelledDevices = await transaction.$queryRaw<
      { deviceId: string }[]
    >`
      SELECT device."id" AS "deviceId"
      FROM "Device" AS device
      WHERE device."status" = CAST('ACTIVE' AS "DeviceStatus")
        AND EXISTS (
          SELECT 1
          FROM "Subscription" AS subscription
          WHERE subscription."userId" = device."userId"
            AND subscription."status" = CAST('CANCELLED' AS "SubscriptionStatus")
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "Subscription" AS subscription
          WHERE subscription."userId" = device."userId"
            AND subscription."status" = CAST('ACTIVE' AS "SubscriptionStatus")
            AND subscription."expiresAt" > ${now}
        )
      ORDER BY device."id"
    `;
    const existingGrants = await transaction.$queryRaw<ExistingGrant[]>`
      SELECT "id",
             "deviceId",
             "status"::text AS "status",
             "expiresAt",
             "desiredVersion",
             "appliedVersion"
      FROM "NodeAccessGrant"
      WHERE "nodeId" = CAST(${node.id} AS uuid)
      ORDER BY "deviceId", "id"
      FOR UPDATE
    `;
    const liveDeliveries = await transaction.$queryRaw<
      { targetVersion: number }[]
    >`
      SELECT DISTINCT sync_job."targetVersion"
      FROM "NodeSyncJob" AS sync_job
      WHERE sync_job."nodeId" = CAST(${node.id} AS uuid)
        AND (
          (
            sync_job."status" = CAST('SUCCEEDED' AS "NodeSyncJobStatus")
            AND NOT EXISTS (
              SELECT 1
              FROM "NodeConfigAcknowledgement" AS acknowledgement
              WHERE acknowledgement."nodeSyncJobId" = sync_job."id"
            )
          )
          OR (
            sync_job."status" IN (
              CAST('PENDING' AS "NodeSyncJobStatus"),
              CAST('PROCESSING' AS "NodeSyncJobStatus")
            )
            AND EXISTS (
              SELECT 1
              FROM "OutboxEvent" AS outbox_event
              WHERE outbox_event."topic" = 'node-sync.requested'
                AND outbox_event."payload" ->> 'nodeSyncJobId' = sync_job."id"::text
                AND outbox_event."status" <> CAST('FAILED' AS "OutboxEventStatus")
            )
          )
        )
    `;
    const existingByDevice = new Map(
      existingGrants.map((grant) => [grant.deviceId, grant]),
    );
    const cancelledDeviceIds = new Set(
      cancelledDevices.map((device) => device.deviceId),
    );
    const liveDeliveryVersions = new Set(
      liveDeliveries.map((delivery) => delivery.targetVersion),
    );
    const networkChanges = new Map<
      string,
      | { kind: 'create'; expected: ExpectedDevice }
      | { kind: 'update'; grant: ExistingGrant; expiresAt: Date }
      | { kind: 'revoke'; grant: ExistingGrant }
    >();
    const localActivations = new Map<string, ExistingGrant>();
    const mayCreateMissing = node.status === 'HEALTHY' || includeMissingGrants;

    for (const expected of expectedDevices) {
      const grant = existingByDevice.get(expected.deviceId);
      if (!grant) {
        if (mayCreateMissing) {
          networkChanges.set(expected.deviceId, { kind: 'create', expected });
        }
        continue;
      }
      if (grant.status === 'REVOKED') continue;
      if (
        grant.status === 'PENDING' &&
        grant.appliedVersion >= grant.desiredVersion
      ) {
        localActivations.set(grant.id, grant);
      }
      const expiryChanged =
        grant.expiresAt.getTime() !== expected.expiresAt.getTime();
      const deliveryLost =
        grant.appliedVersion < grant.desiredVersion &&
        !liveDeliveryVersions.has(grant.desiredVersion);
      if (expiryChanged || deliveryLost) {
        networkChanges.set(expected.deviceId, {
          kind: 'update',
          grant,
          expiresAt: expected.expiresAt,
        });
      }
    }

    for (const grant of existingGrants) {
      if (
        grant.status !== 'REVOKED' &&
        cancelledDeviceIds.has(grant.deviceId)
      ) {
        networkChanges.set(grant.deviceId, { kind: 'revoke', grant });
        localActivations.delete(grant.id);
      }
    }

    if (networkChanges.size === 0 && localActivations.size === 0) return false;

    for (const grant of localActivations.values()) {
      await transaction.nodeAccessGrant.update({
        where: { id: grant.id },
        data: { status: 'ACTIVE' },
      });
    }

    if (networkChanges.size === 0) {
      await transaction.auditEvent.create({
        data: {
          action: 'node-access.reconciled',
          entityType: 'Node',
          entityId: node.id,
          metadata: {
            targetVersion: null,
            repairedGrantCount: localActivations.size,
            localActivationCount: localActivations.size,
          },
        },
      });
      return true;
    }

    const targetVersion = await this.incrementNodeVersion(transaction, node.id);
    const changedGrantIds: string[] = [];
    let revokedGrantCount = 0;
    for (const change of networkChanges.values()) {
      if (change.kind === 'revoke') {
        await transaction.nodeAccessGrant.update({
          where: { id: change.grant.id },
          data: {
            status: 'REVOKED',
            revokedAt: now,
            desiredVersion: targetVersion,
          },
        });
        changedGrantIds.push(change.grant.id);
        revokedGrantCount += 1;
        continue;
      }
      if (change.kind === 'update') {
        await transaction.nodeAccessGrant.update({
          where: { id: change.grant.id },
          data: {
            ...(change.grant.status === 'PENDING' &&
            change.grant.appliedVersion >= change.grant.desiredVersion
              ? { status: 'ACTIVE' as const }
              : {}),
            expiresAt: change.expiresAt,
            desiredVersion: targetVersion,
          },
        });
        changedGrantIds.push(change.grant.id);
        continue;
      }

      const grantId = randomUUID();
      const credential = deriveDataPlaneCredential(this.credentialPepper, {
        grantId,
        deviceId: change.expected.deviceId,
        nodeId: node.id,
      });
      const grant = await transaction.nodeAccessGrant.create({
        data: {
          id: grantId,
          nodeId: node.id,
          deviceId: change.expected.deviceId,
          status: 'PENDING',
          dataPlaneCredentialHash: hashDataPlaneCredential(
            this.credentialPepper,
            credential,
          ),
          dataPlaneCredentialDerivationVersion:
            DATA_PLANE_CREDENTIAL_DERIVATION_VERSION,
          expiresAt: change.expected.expiresAt,
          desiredVersion: targetVersion,
        },
      });
      changedGrantIds.push(grant.id);
    }

    await this.createNodeSyncOperation(transaction, {
      nodeId: node.id,
      leadGrantId: changedGrantIds[0]!,
      targetVersion,
      syncJobIdempotencyKey: `reconcile:${node.id}:${targetVersion}`,
      outboxEventIdempotencyKey: `reconcile-outbox:${node.id}:${targetVersion}`,
    });
    await transaction.auditEvent.create({
      data: {
        action: 'node-access.reconciled',
        entityType: 'Node',
        entityId: node.id,
        metadata: {
          targetVersion,
          repairedGrantCount: networkChanges.size + localActivations.size,
          revokedGrantCount,
          localActivationCount: localActivations.size,
        },
      },
    });
    return true;
  }

  private async findReconciliationCandidates(
    limit: number,
  ): Promise<{ id: string }[]> {
    const candidates = await this.queryReconciliationCandidates(
      limit,
      this.reconciliationCursor,
    );
    if (candidates.length < limit && this.reconciliationCursor) {
      candidates.push(
        ...(await this.queryReconciliationCandidates(
          limit - candidates.length,
          null,
          this.reconciliationCursor,
        )),
      );
    }
    if (candidates.length > 0) {
      this.reconciliationCursor = candidates[candidates.length - 1]!.id;
    }
    return candidates;
  }

  private queryReconciliationCandidates(
    limit: number,
    afterId: string | null,
    throughId: string | null = null,
  ): Promise<{ id: string }[]> {
    const lowerBound = afterId
      ? Prisma.sql`AND node."id" > CAST(${afterId} AS uuid)`
      : Prisma.empty;
    const upperBound = throughId
      ? Prisma.sql`AND node."id" <= CAST(${throughId} AS uuid)`
      : Prisma.empty;
    return this.prisma.$queryRaw<{ id: string }[]>`
      SELECT node."id"
      FROM "Node" AS node
      WHERE node."status" IN (
          CAST('HEALTHY' AS "NodeStatus"),
          CAST('DRAINING' AS "NodeStatus"),
          CAST('DISABLED' AS "NodeStatus")
        )
        AND (
        EXISTS (
          SELECT 1
          FROM "Device" AS device
          INNER JOIN LATERAL (
            SELECT subscription."expiresAt"
            FROM "Subscription" AS subscription
            WHERE subscription."userId" = device."userId"
              AND subscription."status" = CAST('ACTIVE' AS "SubscriptionStatus")
              AND subscription."expiresAt" > clock_timestamp()
            ORDER BY subscription."expiresAt" DESC, subscription."id"
            LIMIT 1
          ) AS entitlement ON TRUE
          LEFT JOIN "NodeAccessGrant" AS access_grant
            ON access_grant."nodeId" = node."id"
           AND access_grant."deviceId" = device."id"
          WHERE device."status" = CAST('ACTIVE' AS "DeviceStatus")
            AND (
              (node."status" = CAST('HEALTHY' AS "NodeStatus") AND access_grant."id" IS NULL)
              OR (
                access_grant."status" <> CAST('REVOKED' AS "NodeAccessGrantStatus")
                AND (
                  access_grant."expiresAt" <> entitlement."expiresAt"
                  OR (
                    access_grant."status" = CAST('PENDING' AS "NodeAccessGrantStatus")
                    AND access_grant."appliedVersion" >= access_grant."desiredVersion"
                  )
                  OR (
                    access_grant."appliedVersion" < access_grant."desiredVersion"
                    AND NOT EXISTS (
                      SELECT 1
                      FROM "NodeSyncJob" AS sync_job
                      WHERE sync_job."nodeId" = node."id"
                        AND sync_job."targetVersion" = access_grant."desiredVersion"
                        AND (
                          (
                            sync_job."status" = CAST('SUCCEEDED' AS "NodeSyncJobStatus")
                            AND NOT EXISTS (
                              SELECT 1
                              FROM "NodeConfigAcknowledgement" AS acknowledgement
                              WHERE acknowledgement."nodeSyncJobId" = sync_job."id"
                            )
                          )
                          OR (
                            sync_job."status" IN (
                              CAST('PENDING' AS "NodeSyncJobStatus"),
                              CAST('PROCESSING' AS "NodeSyncJobStatus")
                            )
                            AND EXISTS (
                              SELECT 1
                              FROM "OutboxEvent" AS outbox_event
                              WHERE outbox_event."topic" = 'node-sync.requested'
                                AND outbox_event."payload" ->> 'nodeSyncJobId' = sync_job."id"::text
                                AND outbox_event."status" <> CAST('FAILED' AS "OutboxEventStatus")
                            )
                          )
                        )
                    )
                  )
                )
              )
            )
        )
        OR EXISTS (
          SELECT 1
          FROM "NodeAccessGrant" AS access_grant
          INNER JOIN "Device" AS device
            ON device."id" = access_grant."deviceId"
          WHERE access_grant."nodeId" = node."id"
            AND access_grant."status" <> CAST('REVOKED' AS "NodeAccessGrantStatus")
            AND device."status" = CAST('ACTIVE' AS "DeviceStatus")
            AND EXISTS (
              SELECT 1
              FROM "Subscription" AS subscription
              WHERE subscription."userId" = device."userId"
                AND subscription."status" = CAST('CANCELLED' AS "SubscriptionStatus")
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "Subscription" AS subscription
              WHERE subscription."userId" = device."userId"
                AND subscription."status" = CAST('ACTIVE' AS "SubscriptionStatus")
                AND subscription."expiresAt" > clock_timestamp()
            )
        )
      )
      ${lowerBound}
      ${upperBound}
      ORDER BY node."id"
      LIMIT ${limit}
    `;
  }

  private async findExpiredSubscriptionCandidates(
    limit: number,
  ): Promise<{ id: string; userId: string }[]> {
    const candidates = await this.queryExpiredSubscriptionCandidates(
      limit,
      this.expiryCursor,
    );
    if (candidates.length < limit && this.expiryCursor) {
      candidates.push(
        ...(await this.queryExpiredSubscriptionCandidates(
          limit - candidates.length,
          null,
          this.expiryCursor,
        )),
      );
    }
    if (candidates.length > 0) {
      this.expiryCursor = candidates[candidates.length - 1]!.id;
    }
    return candidates;
  }

  private queryExpiredSubscriptionCandidates(
    limit: number,
    afterId: string | null,
    throughId: string | null = null,
  ): Promise<{ id: string; userId: string }[]> {
    const lowerBound = afterId
      ? Prisma.sql`AND subscription."id" > CAST(${afterId} AS uuid)`
      : Prisma.empty;
    const upperBound = throughId
      ? Prisma.sql`AND subscription."id" <= CAST(${throughId} AS uuid)`
      : Prisma.empty;
    return this.prisma.$queryRaw<{ id: string; userId: string }[]>`
      SELECT subscription."id", subscription."userId"
      FROM "Subscription" AS subscription
      WHERE subscription."expiresAt" IS NOT NULL
        AND subscription."expiresAt" <= clock_timestamp()
        AND (
          subscription."status" = CAST('ACTIVE' AS "SubscriptionStatus")
          OR (
            subscription."status" = CAST('EXPIRED' AS "SubscriptionStatus")
            AND EXISTS (
              SELECT 1
              FROM "NodeAccessGrant" AS access_grant
              INNER JOIN "Device" AS device
                ON device."id" = access_grant."deviceId"
              INNER JOIN "Node" AS node
                ON node."id" = access_grant."nodeId"
              WHERE device."userId" = subscription."userId"
                AND access_grant."status" <> CAST('REVOKED' AS "NodeAccessGrantStatus")
                AND node."status" IN (
                  CAST('HEALTHY' AS "NodeStatus"),
                  CAST('DRAINING' AS "NodeStatus"),
                  CAST('DISABLED' AS "NodeStatus")
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM "NodeSyncJob" AS sync_job
                  WHERE sync_job."idempotencyKey" =
                    'subscription-expiry:' || subscription."id"::text || ':' || node."id"::text
                )
            )
          )
        )
        ${lowerBound}
        ${upperBound}
      ORDER BY subscription."id"
      LIMIT ${limit}
    `;
  }

  private findPendingExpiryNodes(subscriptionId: string): Promise<string[]> {
    return this.prisma.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT node."id"
        FROM "Subscription" AS subscription
        INNER JOIN "Device" AS device
          ON device."userId" = subscription."userId"
        INNER JOIN "NodeAccessGrant" AS access_grant
          ON access_grant."deviceId" = device."id"
        INNER JOIN "Node" AS node
          ON node."id" = access_grant."nodeId"
        WHERE subscription."id" = CAST(${subscriptionId} AS uuid)
          AND subscription."expiresAt" IS NOT NULL
          AND subscription."expiresAt" <= clock_timestamp()
          AND access_grant."status" <> CAST('REVOKED' AS "NodeAccessGrantStatus")
          AND node."status" IN (
            CAST('HEALTHY' AS "NodeStatus"),
            CAST('DRAINING' AS "NodeStatus"),
            CAST('DISABLED' AS "NodeStatus")
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "NodeSyncJob" AS sync_job
            WHERE sync_job."idempotencyKey" =
              'subscription-expiry:' || subscription."id"::text || ':' || node."id"::text
          )
        ORDER BY node."id"
      `.then((nodes) => nodes.map((node) => node.id));
  }

  private async findEffectiveExpiry(
    transaction: Prisma.TransactionClient,
    userId: string,
    now: Date,
  ): Promise<Date | null> {
    const rows = await transaction.$queryRaw<{ expiresAt: Date }[]>`
      SELECT "expiresAt"
      FROM "Subscription"
      WHERE "userId" = CAST(${userId} AS uuid)
        AND "status" = CAST('ACTIVE' AS "SubscriptionStatus")
        AND "expiresAt" > ${now}
      ORDER BY "expiresAt" DESC, "id"
      LIMIT 1
    `;
    return rows[0]?.expiresAt ?? null;
  }

  private async incrementNodeVersion(
    transaction: Prisma.TransactionClient,
    nodeId: string,
  ): Promise<number> {
    const node = await transaction.node.update({
      where: { id: nodeId },
      data: { desiredConfigVersion: { increment: 1 } },
      select: { desiredConfigVersion: true },
    });
    return node.desiredConfigVersion;
  }

  private async createNodeSyncOperation(
    transaction: Prisma.TransactionClient,
    input: {
      nodeId: string;
      leadGrantId: string;
      targetVersion: number;
      syncJobIdempotencyKey: string;
      outboxEventIdempotencyKey: string;
    },
  ): Promise<void> {
    const syncJob = await transaction.nodeSyncJob.create({
      data: {
        nodeId: input.nodeId,
        nodeAccessGrantId: input.leadGrantId,
        targetVersion: input.targetVersion,
        idempotencyKey: input.syncJobIdempotencyKey,
      },
    });
    await transaction.outboxEvent.create({
      data: {
        topic: 'node-sync.requested',
        aggregateType: 'NodeAccessGrant',
        aggregateId: input.leadGrantId,
        payload: {
          nodeAccessGrantId: input.leadGrantId,
          nodeSyncJobId: syncJob.id,
          targetVersion: input.targetVersion,
        },
        idempotencyKey: input.outboxEventIdempotencyKey,
      },
    });
  }

  private async hasMatchingNodeSyncOperation(
    transaction: Prisma.TransactionClient,
    input: {
      nodeId: string;
      leadGrantId: string;
      syncJobIdempotencyKey: string;
      outboxEventIdempotencyKey: string;
    },
  ): Promise<boolean> {
    const [syncJob, outboxEvent] = await Promise.all([
      transaction.nodeSyncJob.findUnique({
        where: { idempotencyKey: input.syncJobIdempotencyKey },
      }),
      transaction.outboxEvent.findUnique({
        where: { idempotencyKey: input.outboxEventIdempotencyKey },
      }),
    ]);
    if (!syncJob && !outboxEvent) return false;
    if (
      !syncJob ||
      syncJob.nodeId !== input.nodeId ||
      syncJob.nodeAccessGrantId !== input.leadGrantId ||
      !outboxEvent ||
      outboxEvent.aggregateId !== input.leadGrantId
    ) {
      throw new Error('Expiry delivery operation is inconsistent');
    }
    return true;
  }
}
