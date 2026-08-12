import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { SubscriptionAccessService } from './subscription-access.service';

@Module({
  imports: [DatabaseModule],
  providers: [SubscriptionAccessService],
  exports: [SubscriptionAccessService],
})
export class SubscriptionAccessModule {}
