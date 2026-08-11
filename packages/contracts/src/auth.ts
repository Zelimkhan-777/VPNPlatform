import { z } from 'zod';

export const telegramLoginRequestSchema = z
  .object({
    initData: z.string().min(1).max(8_192),
  })
  .strict();

export const authenticatedUserSchema = z
  .object({
    id: z.string().uuid(),
    role: z.enum(['CUSTOMER', 'ADMIN']),
  })
  .strict();

export const authenticatedSessionSchema = z
  .object({
    user: authenticatedUserSchema,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type TelegramLoginRequest = z.infer<typeof telegramLoginRequestSchema>;
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;
export type AuthenticatedSession = z.infer<typeof authenticatedSessionSchema>;
