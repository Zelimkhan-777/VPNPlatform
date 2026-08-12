import { randomBytes } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  CreateCabinetDeviceRequest,
  IssuedCabinetDevice,
} from '@vpn-platform/contracts';
import { SubscriptionStatus } from '@prisma/client';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { SubscriptionAccessService } from '../subscription-access/subscription-access.service';

@Injectable()
export class CabinetDeviceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SubscriptionAccessService)
    private readonly access: SubscriptionAccessService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async issue(
    userId: string,
    origin: string | undefined,
    input: CreateCabinetDeviceRequest,
    now = new Date(),
  ): Promise<IssuedCabinetDevice> {
    this.assertTrustedOrigin(origin);
    const tokenPepper = this.environment.SUBSCRIPTION_TOKEN_PEPPER;
    const feedBaseUrl = this.environment.SUBSCRIPTION_FEED_BASE_URL;
    if (!tokenPepper || !feedBaseUrl) {
      throw new ServiceUnavailableException('Device issuance is unavailable');
    }

    const token = randomBytes(32).toString('base64url');
    const device = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`cabinet-device:${userId}`}))
      `;
      const subscription = await transaction.subscription.findFirst({
        where: {
          userId,
          status: SubscriptionStatus.ACTIVE,
          expiresAt: { gt: now },
        },
        select: { plan: { select: { deviceLimit: true } } },
      });
      if (!subscription) {
        throw new ConflictException('An active subscription is required');
      }

      const activeDevices = await transaction.device.count({
        where: { userId, status: 'ACTIVE' },
      });
      if (activeDevices >= subscription.plan.deviceLimit) {
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
}
