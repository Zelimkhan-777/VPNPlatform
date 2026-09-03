import { z } from 'zod';

export const planSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    priceMinor: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    durationDays: z.number().int().min(1).max(366),
    deviceLimit: z.number().int().positive(),
    isActive: z.boolean(),
  })
  .strict();

export type Plan = z.infer<typeof planSchema>;
