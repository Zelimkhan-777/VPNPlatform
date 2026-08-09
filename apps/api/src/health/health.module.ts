import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { HEALTH_DEPENDENCY_CHECKER } from './health.types';
import { TcpDependencyChecker } from './tcp-dependency-checker';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: HEALTH_DEPENDENCY_CHECKER,
      useClass: TcpDependencyChecker,
    },
  ],
})
export class HealthModule {}
