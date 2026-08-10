import { Module } from '@nestjs/common';

import { SubscriptionPrototypeController } from './subscription-prototype.controller';
import { SubscriptionPrototypeService } from './subscription-prototype.service';

@Module({
  controllers: [SubscriptionPrototypeController],
  providers: [SubscriptionPrototypeService],
})
export class SubscriptionPrototypeModule {}
