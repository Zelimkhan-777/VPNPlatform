import { z } from 'zod';

import { botTelegramUserIdSchema } from './bot-auth';

export const telegramLoginRequestSchema = z
  .object({
    initData: z.string().min(1).max(8_192),
  })
  .strict();

export const pendingTelegramLoginSchema = z
  .object({
    confirmationCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const confirmTelegramLoginRequestSchema = z
  .object({
    telegramUserId: botTelegramUserIdSchema,
    confirmationCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/),
  })
  .strict();

export const confirmedTelegramLoginSchema = z
  .object({ status: z.literal('BOT_CONFIRMED') })
  .strict();

export const issueTelegramAuthChallengeRequestSchema = z
  .object({ telegramUserId: botTelegramUserIdSchema })
  .strict();

export const issuedTelegramAuthChallengeSchema = z
  .object({
    launchId: z
      .string()
      .length(43)
      .regex(/^[A-Za-z0-9_-]+$/),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const authenticatedUserSchema = z
  .object({
    id: z.string().uuid(),
    role: z.literal('CUSTOMER'),
  })
  .strict();

export const adminRoleSchema = z.enum([
  'OWNER',
  'OPERATOR',
  'SUPPORT',
  'FINANCE',
  'AUDITOR',
]);

export const authenticatedSessionSchema = z
  .object({
    user: authenticatedUserSchema,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type TelegramLoginRequest = z.infer<typeof telegramLoginRequestSchema>;
export type PendingTelegramLogin = z.infer<typeof pendingTelegramLoginSchema>;
export type ConfirmTelegramLoginRequest = z.infer<
  typeof confirmTelegramLoginRequestSchema
>;
export type ConfirmedTelegramLogin = z.infer<
  typeof confirmedTelegramLoginSchema
>;
export type IssueTelegramAuthChallengeRequest = z.infer<
  typeof issueTelegramAuthChallengeRequestSchema
>;
export type IssuedTelegramAuthChallenge = z.infer<
  typeof issuedTelegramAuthChallengeSchema
>;
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;
export type AuthenticatedSession = z.infer<typeof authenticatedSessionSchema>;
export type AdminRole = z.infer<typeof adminRoleSchema>;
