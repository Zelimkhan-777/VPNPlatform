import { z } from 'zod';

const subscriptionStatusSchema = z.enum([
  'PENDING',
  'ACTIVE',
  'EXPIRED',
  'CANCELLED',
]);

const deviceStatusSchema = z.enum(['ACTIVE', 'REVOKED']);

export const cabinetSubscriptionSchema = z
  .object({
    status: subscriptionStatusSchema,
    planName: z.string().min(1).max(128),
    deviceLimit: z.number().int().positive(),
    startsAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const cabinetDeviceSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().min(1).max(128).nullable(),
    platform: z.string().min(1).max(32).nullable(),
    status: deviceStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const cabinetOverviewSchema = z
  .object({
    subscription: cabinetSubscriptionSchema.nullable(),
    devices: z.array(cabinetDeviceSchema),
  })
  .strict();

export type CabinetSubscription = z.infer<typeof cabinetSubscriptionSchema>;
export type CabinetDevice = z.infer<typeof cabinetDeviceSchema>;
export type CabinetOverview = z.infer<typeof cabinetOverviewSchema>;
