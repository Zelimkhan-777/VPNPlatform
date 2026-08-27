import { Inject, Injectable } from '@nestjs/common';
import type {
  CabinetOverview,
  CabinetSubscription,
} from '@vpn-platform/contracts';
import type { SubscriptionStatus } from '@prisma/client';
import { effectiveSubscriptionStatus } from '@vpn-platform/orchestration-store';

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
    const [subscriptions, devices, databaseTime] = await Promise.all([
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
      this.prisma.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS "now"
      `,
    ]);
    const now = databaseTime[0]?.now;
    if (!now) throw new Error('PostgreSQL clock is unavailable');
    const subscription = subscriptions.sort(
      (left, right) =>
        subscriptionPriority[left.status] - subscriptionPriority[right.status],
    )[0];

    return {
      subscription: subscription
        ? serializeSubscription(subscription, now)
        : null,
      devices: devices.map((device) => ({
        ...device,
        createdAt: device.createdAt.toISOString(),
      })),
    };
  }
}

function serializeSubscription(
  subscription: {
    status: SubscriptionStatus;
    startsAt: Date | null;
    expiresAt: Date | null;
    plan: { name: string; deviceLimit: number };
  },
  databaseTime: Date,
): CabinetSubscription {
  return {
    status: effectiveSubscriptionStatus(
      {
        status: subscription.status,
        expiresAt: subscription.expiresAt,
      },
      databaseTime,
    ),
    planName: subscription.plan.name,
    deviceLimit: subscription.plan.deviceLimit,
    startsAt: subscription.startsAt?.toISOString() ?? null,
    expiresAt: subscription.expiresAt?.toISOString() ?? null,
  };
}
