import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { createSafePinoHttpOptions } from '@vpn-platform/safe-logger';

import {
  API_LOG_DESTINATION,
  ApiConfigModule,
  DEFAULT_API_LOG_DESTINATION,
  type ApiLogDestination,
} from './config/config.module';
import { API_ENVIRONMENT, type ApiEnvironment } from './config/environment';
import { AuthModule } from './auth/auth.module';
import { CabinetModule } from './cabinet/cabinet.module';
import { HealthModule } from './health/health.module';
import { OrchestrationModule } from './orchestration/orchestration.module';
import { NodeAgentModule } from './node-agent/node-agent.module';
import { SubscriptionPrototypeModule } from './subscription-prototype/subscription-prototype.module';
import { SubscriptionAccessModule } from './subscription-access/subscription-access.module';
import { TrialsModule } from './trials/trials.module';

export const createApiPinoHttpOptions = createSafePinoHttpOptions;

@Module({
  imports: [
    ApiConfigModule,
    LoggerModule.forRootAsync({
      imports: [ApiConfigModule],
      inject: [API_ENVIRONMENT, API_LOG_DESTINATION],
      useFactory: (
        environment: ApiEnvironment,
        destination: ApiLogDestination,
      ) => {
        const options = createApiPinoHttpOptions(
          environment.LOG_LEVEL,
          destination === DEFAULT_API_LOG_DESTINATION ? undefined : destination,
        );
        return {
          pinoHttp: options,
        };
      },
    }),
    HealthModule,
    AuthModule,
    CabinetModule,
    OrchestrationModule,
    NodeAgentModule,
    SubscriptionPrototypeModule,
    SubscriptionAccessModule,
    TrialsModule,
  ],
})
export class AppModule {}
