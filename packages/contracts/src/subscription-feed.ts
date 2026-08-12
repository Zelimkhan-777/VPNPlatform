import { z } from 'zod';

/** UTF-8 plain-text subscription response; VPN configurations are added later. */
export const subscriptionFeedSchema = z.string().max(16_384);

export type SubscriptionFeed = z.infer<typeof subscriptionFeedSchema>;
