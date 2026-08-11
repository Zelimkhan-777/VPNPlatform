import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { ApiConfigModule } from './config/config.module';
import { API_ENVIRONMENT, type ApiEnvironment } from './config/environment';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { OrchestrationModule } from './orchestration/orchestration.module';
import { NodeAgentModule } from './node-agent/node-agent.module';
import { SubscriptionPrototypeModule } from './subscription-prototype/subscription-prototype.module';

@Module({
  imports: [
    ApiConfigModule,
    LoggerModule.forRootAsync({
      imports: [ApiConfigModule],
      inject: [API_ENVIRONMENT],
      useFactory: (environment: ApiEnvironment) => ({
        pinoHttp: {
          level: environment.LOG_LEVEL,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers.set-cookie',
              'req.body.password',
              'req.body.token',
              'req.body.subscriptionUrl',
              'req.params.token',
              'req.url',
            ],
            censor: '[REDACTED]',
          },
        },
      }),
    }),
    HealthModule,
    AuthModule,
    OrchestrationModule,
    NodeAgentModule,
    SubscriptionPrototypeModule,
  ],
})
export class AppModule {}
