import { Inject, Injectable } from '@nestjs/common';
import type {
  CabinetOverview,
  CabinetSubscription,
} from '@vpn-platform/contracts';
import type { SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../database/prisma.service';

const subscriptionPriority: Record<SubscriptionStatus, number> = {
  ACTIVE: 0,
  PENDING: 1,
  EXPIRED: 2,
  CANCELLED: 3,
};

@Injectable()
export class CabinetService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async overview(userId: string): Promise<CabinetOverview> {
    const [subscriptions, devices] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        select: {
          status: true,
          startsAt: true,
          expiresAt: true,
          updatedAt: true,
          plan: { select: { name: true, deviceLimit: true } },
        },
      }),
      this.prisma.device.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          displayName: true,
          platform: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);
    const subscription = subscriptions.sort(
      (left, right) =>
        subscriptionPriority[left.status] - subscriptionPriority[right.status],
    )[0];

    return {
      subscription: subscription ? serializeSubscription(subscription) : null,
      devices: devices.map((device) => ({
        ...device,
        createdAt: device.createdAt.toISOString(),
      })),
    };
  }
}

function serializeSubscription(subscription: {
  status: SubscriptionStatus;
  startsAt: Date | null;
  expiresAt: Date | null;
  plan: { name: string; deviceLimit: number };
}): CabinetSubscription {
  return {
    status: subscription.status,
    planName: subscription.plan.name,
    deviceLimit: subscription.plan.deviceLimit,
    startsAt: subscription.startsAt?.toISOString() ?? null,
    expiresAt: subscription.expiresAt?.toISOString() ?? null,
  };
}
