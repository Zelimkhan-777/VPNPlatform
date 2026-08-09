import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { HEALTH_DEPENDENCY_CHECKER } from './health.types';
import { InfrastructureDependencyChecker } from './infrastructure-dependency-checker';

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: HEALTH_DEPENDENCY_CHECKER,
      useClass: InfrastructureDependencyChecker,
    },
  ],
})
export class HealthModule {}
