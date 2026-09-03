import { z } from 'zod';

export const orderStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'CANCELLED']);

export const paymentStatusSchema = z.enum([
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'REFUNDED',
]);

export const orderSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    planId: z.string().uuid(),
    amountMinor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: orderStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const paymentSchema = z
  .object({
    id: z.string().uuid(),
    orderId: z.string().uuid(),
    providerPaymentId: z.string().min(1).max(128).nullable(),
    amountMinor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: paymentStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type OrderStatus = z.infer<typeof orderStatusSchema>;
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export type Order = z.infer<typeof orderSchema>;
export type Payment = z.infer<typeof paymentSchema>;
