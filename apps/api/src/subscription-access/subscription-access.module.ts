import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { SubscriptionAccessService } from './subscription-access.service';
import { SubscriptionFeedController } from './subscription-feed.controller';
import { SubscriptionFeedRateLimiterService } from './subscription-feed-rate-limiter.service';
import { SubscriptionFeedService } from './subscription-feed.service';

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [SubscriptionFeedController],
  providers: [
    SubscriptionAccessService,
    SubscriptionFeedService,
    SubscriptionFeedRateLimiterService,
  ],
  exports: [SubscriptionAccessService],
})
export class SubscriptionAccessModule {}
