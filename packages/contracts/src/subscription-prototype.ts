import { z } from 'zod';

export const localSubscriptionFixture =
  '# VPNPlatform local subscription prototype\n';

export const localSubscriptionFeedSchema = z.string().min(1).max(16_384);

export type LocalSubscriptionFeed = z.infer<typeof localSubscriptionFeedSchema>;
