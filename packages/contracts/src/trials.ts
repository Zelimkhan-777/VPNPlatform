import { z } from 'zod';

import { botTelegramUserIdSchema } from './bot-auth';

export const trialDurationDaysSchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(5),
]);

export const activateTrialRequestSchema = z
  .object({ telegramUserId: botTelegramUserIdSchema })
  .strict();

export const trialCampaignMetadataSchema = z
  .object({
    id: z.string().uuid(),
    planId: z.string().uuid(),
    durationDays: trialDurationDaysSchema,
    maxActivations: z.number().int().positive().nullable(),
    startsAt: z.string().datetime({ offset: true }).nullable(),
    endsAt: z.string().datetime({ offset: true }).nullable(),
    isActive: z.boolean(),
    comment: z.string().max(512).nullable(),
    archivedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const trialActivationSchema = z
  .object({
    id: z.string().uuid(),
    trialCampaignId: z.string().uuid(),
    subscriptionId: z.string().uuid(),
    planId: z.string().uuid(),
    startsAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    activatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ActivateTrialRequest = z.infer<typeof activateTrialRequestSchema>;
export type TrialActivation = z.infer<typeof trialActivationSchema>;
export type TrialCampaignMetadata = z.infer<typeof trialCampaignMetadataSchema>;
export type TrialDurationDays = z.infer<typeof trialDurationDaysSchema>;
