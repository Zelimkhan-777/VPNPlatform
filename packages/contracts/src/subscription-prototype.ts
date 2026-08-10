import { z } from 'zod';

export const localSubscriptionFixture =
  '# VPNPlatform local subscription prototype\n';

export const localSubscriptionFeedSchema = z.literal(localSubscriptionFixture);

export type LocalSubscriptionFeed = z.infer<typeof localSubscriptionFeedSchema>;
