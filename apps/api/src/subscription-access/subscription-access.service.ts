import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';

const subscriptionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

@Injectable()
export class SubscriptionAccessService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async resolveAuthorizedDevice(
    token: string,
  ): Promise<{ deviceId: string; userId: string } | null> {
    const pepper = this.environment.SUBSCRIPTION_TOKEN_PEPPER;
    if (!pepper || !subscriptionTokenSchema.safeParse(token).success) {
      return null;
    }

    const devices = await this.prisma.$queryRaw<
      { deviceId: string; userId: string }[]
    >`
      SELECT device."id" AS "deviceId", device."userId" AS "userId"
      FROM "Device" device INNER JOIN "Subscription" subscription ON subscription."userId" = device."userId"
      WHERE device."subscriptionTokenHash" = ${this.hashToken(token, pepper)}
        AND device."status" = CAST('ACTIVE' AS "DeviceStatus")
        AND subscription."status" = CAST('ACTIVE' AS "SubscriptionStatus")
        AND subscription."expiresAt" > clock_timestamp()
      ORDER BY subscription."expiresAt" DESC LIMIT 1
    `;
    return devices[0] ?? null;
  }

  async resolveDeviceId(token: string): Promise<string | null> {
    return (await this.resolveAuthorizedDevice(token))?.deviceId ?? null;
  }

  hashToken(token: string, pepper: string): string {
    return createHmac('sha256', pepper).update(token).digest('hex');
  }
}
