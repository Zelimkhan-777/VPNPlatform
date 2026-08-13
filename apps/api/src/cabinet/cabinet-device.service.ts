import { createHmac } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  CreateCabinetDeviceRequest,
  IssuedCabinetDevice,
} from '@vpn-platform/contracts';
import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
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
  ) {}

  async revoke(
    userId: string,
    origin: string | undefined,
    deviceId: string,
  ): Promise<void> {
    this.assertTrustedOrigin(origin);
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
    origin: string | undefined,
    idempotencyKey: string,
    input: CreateCabinetDeviceRequest,
  ): Promise<IssuedCabinetDevice> {
    this.assertTrustedOrigin(origin);
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
        { deviceLimit: number }[]
      >`
        SELECT plan."deviceLimit"
        FROM "Subscription" AS subscription
        INNER JOIN "Plan" AS plan ON plan."id" = subscription."planId"
        WHERE subscription."userId" = CAST(${userId} AS uuid)
          AND subscription."status" = CAST('ACTIVE' AS "SubscriptionStatus")
          AND subscription."expiresAt" > clock_timestamp()
      `;
      const subscription = subscriptions[0];
      if (!subscription) {
        throw new ConflictException('An active subscription is required');
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

  private assertTrustedOrigin(origin: string | undefined): void {
    if (
      !this.environment.CABINET_ORIGIN ||
      origin !== this.environment.CABINET_ORIGIN
    ) {
      throw new ForbiddenException('Cabinet origin is invalid');
    }
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
