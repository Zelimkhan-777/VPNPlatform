import { z } from 'zod';

export const promoCodeMetadataSchema = z
  .object({
    id: z.string().uuid(),
    planId: z.string().uuid(),
    campaignName: z.string().min(1).max(128),
    durationDays: z.number().int().min(1).max(366),
    maxUniqueUsers: z.number().int().positive(),
    startsAt: z.string().datetime({ offset: true }).nullable(),
    endsAt: z.string().datetime({ offset: true }).nullable(),
    isActive: z.boolean(),
    comment: z.string().max(512).nullable(),
    archivedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const promoRedemptionSchema = z
  .object({
    id: z.string().uuid(),
    promoCodeId: z.string().uuid(),
    userId: z.string().uuid(),
    redeemedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type PromoCodeMetadata = z.infer<typeof promoCodeMetadataSchema>;
export type PromoRedemption = z.infer<typeof promoRedemptionSchema>;
