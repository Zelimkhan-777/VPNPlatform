import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { RedisModule } from '../redis/redis.module';
import { TrialActivationRateLimiterService } from './trial-activation-rate-limiter.service';
import { TrialActivationService } from './trial-activation.service';
import { TrialController } from './trial.controller';

@Module({
  imports: [AuthModule, DatabaseModule, OrchestrationModule, RedisModule],
  controllers: [TrialController],
  providers: [TrialActivationRateLimiterService, TrialActivationService],
})
export class TrialsModule {}
