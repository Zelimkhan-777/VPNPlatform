import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { DeviceStatus, SubscriptionStatus } from '@prisma/client';
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

  async resolveDeviceId(
    token: string,
    now = new Date(),
  ): Promise<string | null> {
    const pepper = this.environment.SUBSCRIPTION_TOKEN_PEPPER;
    if (!pepper || !subscriptionTokenSchema.safeParse(token).success) {
      return null;
    }

    const device = await this.prisma.device.findFirst({
      where: {
        subscriptionTokenHash: this.hashToken(token, pepper),
        status: DeviceStatus.ACTIVE,
        user: {
          subscriptions: {
            some: {
              status: SubscriptionStatus.ACTIVE,
              expiresAt: { gt: now },
            },
          },
        },
      },
      select: { id: true },
    });

    return device?.id ?? null;
  }

  hashToken(token: string, pepper: string): string {
    return createHmac('sha256', pepper).update(token).digest('hex');
  }
}
