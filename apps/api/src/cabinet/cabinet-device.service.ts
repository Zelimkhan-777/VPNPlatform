import { createHmac } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  CreateCabinetDeviceRequest,
  IssuedCabinetDevice,
} from '@vpn-platform/contracts';
import { hasEntitlement } from '@vpn-platform/orchestration-store';
import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { NodeAccessGrantScheduler } from '../orchestration/node-access-grant-scheduler.service';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { SubscriptionAccessService } from '../subscription-access/subscription-access.service';

@Injectable()
export class CabinetDeviceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SubscriptionAccessService)
    private readonly access: SubscriptionAccessService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
    @Inject(OrchestrationService)
    private readonly orchestration: OrchestrationService,
    @Inject(NodeAccessGrantScheduler)
    private readonly grantScheduler: NodeAccessGrantScheduler,
  ) {}

  async revoke(userId: string, deviceId: string): Promise<void> {
    const result = await this.orchestration.revokeDeviceAccess(
      userId,
      deviceId,
    );
    if (result === 'not-found') {
      throw new NotFoundException('Device was not found');
    }
  }

  async issue(
    userId: string,
    idempotencyKey: string,
    input: CreateCabinetDeviceRequest,
  ): Promise<IssuedCabinetDevice> {
    const tokenPepper = this.environment.SUBSCRIPTION_TOKEN_PEPPER;
    const feedBaseUrl = this.environment.SUBSCRIPTION_FEED_BASE_URL;
    if (!tokenPepper || !feedBaseUrl) {
      throw new ServiceUnavailableException('Device issuance is unavailable');
    }

    const issuanceIdempotencyKeyHash = this.hashIssuanceIdempotencyKey(
      userId,
      idempotencyKey,
      tokenPepper,
    );
    const token = this.deriveSubscriptionToken(
      userId,
      idempotencyKey,
      tokenPepper,
    );
    const device = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`cabinet-device:${userId}`}))
      `;
      const existing = await transaction.device.findUnique({
        where: { issuanceIdempotencyKeyHash },
        select: {
          id: true,
          userId: true,
          displayName: true,
          platform: true,
          status: true,
          createdAt: true,
        },
      });
      if (existing) {
        if (
          existing.userId !== userId ||
          existing.status !== 'ACTIVE' ||
          existing.displayName !== (input.displayName ?? null) ||
          existing.platform !== (input.platform ?? null)
        ) {
          throw new ConflictException('Device request does not match its key');
        }
        return existing;
      }
      await transaction.$queryRaw`
        SELECT subscription."id"
        FROM "Subscription" AS subscription
        INNER JOIN "Plan" AS plan ON plan."id" = subscription."planId"
        WHERE subscription."userId" = CAST(${userId} AS uuid)
        FOR UPDATE OF subscription, plan
      `;
      const subscriptions = await transaction.$queryRaw<
        {
          id: string;
          status: 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
          expiresAt: Date | null;
          deviceLimit: number;
        }[]
      >`
        SELECT subscription."id",
               subscription."status"::text AS "status",
               subscription."expiresAt",
               plan."deviceLimit"
        FROM "Subscription" AS subscription
        INNER JOIN "Plan" AS plan ON plan."id" = subscription."planId"
        WHERE subscription."userId" = CAST(${userId} AS uuid)
        ORDER BY subscription."updatedAt" DESC, subscription."id"
      `;
      const nodes = await transaction.$queryRaw<
        { id: string; status: string }[]
      >`
        SELECT "id", "status"::text AS "status"
        FROM "Node"
        WHERE "status" = CAST('HEALTHY' AS "NodeStatus")
        ORDER BY "id"
        FOR UPDATE
      `;
      const databaseTime = await transaction.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now"
      `;
      const now = databaseTime[0]?.now;
      if (!now) throw new Error('PostgreSQL clock is unavailable');
      const subscription = subscriptions.find((candidate) =>
        hasEntitlement(
          {
            deviceStatus: 'ACTIVE',
            subscription: {
              status: candidate.status,
              expiresAt: candidate.expiresAt,
            },
          },
          now,
        ),
      );
      if (!subscription) {
        throw new ConflictException('An active subscription is required');
      }
      if (nodes.length === 0) {
        throw new ServiceUnavailableException(
          'No VPN node is available for device issuance',
        );
      }

      const activeDevices = await transaction.device.count({
        where: { userId, status: 'ACTIVE' },
      });
      if (activeDevices >= subscription.deviceLimit) {
        throw new ConflictException('Device limit has been reached');
      }

      const created = await transaction.device.create({
        data: {
          userId,
          ...(input.displayName === undefined
            ? {}
            : { displayName: input.displayName }),
          ...(input.platform === undefined ? {} : { platform: input.platform }),
          subscriptionTokenHash: this.access.hashToken(token, tokenPepper),
          issuanceIdempotencyKeyHash,
        },
        select: {
          id: true,
          displayName: true,
          platform: true,
          status: true,
          createdAt: true,
        },
      });
      for (const node of nodes) {
        await this.grantScheduler.scheduleInTransaction(transaction, {
          nodeId: node.id,
          deviceId: created.id,
          expiresAt: subscription.expiresAt as Date,
          syncJobIdempotencyKey: `issue:${issuanceIdempotencyKeyHash.slice(0, 48)}:${node.id}`,
          outboxEventIdempotencyKey: `issue-o:${issuanceIdempotencyKeyHash.slice(0, 46)}:${node.id}`,
          actorUserId: userId,
        });
      }
      await transaction.auditEvent.create({
        data: {
          actorUserId: userId,
          action: 'device.issued',
          entityType: 'Device',
          entityId: created.id,
          metadata: { platform: created.platform },
        },
      });
      return created;
    });

    return {
      id: device.id,
      displayName: device.displayName,
      platform: device.platform,
      status: 'ACTIVE',
      createdAt: device.createdAt.toISOString(),
      subscriptionUrl: new URL(`/sub/${token}`, feedBaseUrl).toString(),
    };
  }

  private hashIssuanceIdempotencyKey(
    userId: string,
    idempotencyKey: string,
    pepper: string,
  ): string {
    return createHmac('sha256', pepper)
      .update(
        `cabinet-device-issuance-v1\u0000${userId}\u0000${idempotencyKey}`,
      )
      .digest('hex');
  }

  private deriveSubscriptionToken(
    userId: string,
    idempotencyKey: string,
    pepper: string,
  ): string {
    return createHmac('sha256', pepper)
      .update(`cabinet-device-token-v1\u0000${userId}\u0000${idempotencyKey}`)
      .digest('base64url');
  }
}
