import { z } from 'zod';

export const createCabinetDeviceRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128).optional(),
    platform: z.string().trim().min(1).max(32).optional(),
  })
  .strict();

export const issuedCabinetDeviceSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().min(1).max(128).nullable(),
    platform: z.string().min(1).max(32).nullable(),
    status: z.literal('ACTIVE'),
    createdAt: z.string().datetime({ offset: true }),
    subscriptionUrl: z.string().url(),
  })
  .strict();

export type CreateCabinetDeviceRequest = z.infer<
  typeof createCabinetDeviceRequestSchema
>;
export type IssuedCabinetDevice = z.infer<typeof issuedCabinetDeviceSchema>;
