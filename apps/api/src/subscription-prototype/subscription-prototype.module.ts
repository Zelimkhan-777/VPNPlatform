import { Module } from '@nestjs/common';

import { SubscriptionPrototypeController } from './subscription-prototype.controller';
import { SubscriptionPrototypeRateLimiterService } from './subscription-prototype-rate-limiter.service';
import { SubscriptionPrototypeService } from './subscription-prototype.service';

@Module({
  controllers: [SubscriptionPrototypeController],
  providers: [
    SubscriptionPrototypeRateLimiterService,
    SubscriptionPrototypeService,
  ],
})
export class SubscriptionPrototypeModule {}
