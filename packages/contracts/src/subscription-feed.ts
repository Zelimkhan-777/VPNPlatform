import { z } from 'zod';

/** UTF-8 plain-text feed: canonical URIs, one per line, or an empty string. */
export const subscriptionFeedSchema = z.string().max(16_384);

export type SubscriptionFeed = z.infer<typeof subscriptionFeedSchema>;
