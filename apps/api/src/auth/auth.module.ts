import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { AuthController } from './auth.controller';
import { AuthIssuerRateLimiterService } from './auth-issuer-rate-limiter.service';
import { BotAuthChallengeService } from './bot-auth-challenge.service';
import { BotAuthController } from './bot-auth.controller';
import { AuthSessionService } from './auth-session.service';
import { BotRequestAuthenticationGuard } from './bot-request-authentication.guard';
import { BotRequestAuthenticationService } from './bot-request-authentication.service';
import { BotRequestExecutionService } from './bot-request-execution.service';
import { PendingLoginService } from './pending-login.service';
import { TrustedOriginGuard } from './trusted-origin.guard';

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [AuthController, BotAuthController],
  providers: [
    AuthSessionService,
    AuthIssuerRateLimiterService,
    BotAuthChallengeService,
    BotRequestAuthenticationGuard,
    BotRequestAuthenticationService,
    BotRequestExecutionService,
    PendingLoginService,
    TrustedOriginGuard,
  ],
  exports: [
    AuthSessionService,
    BotRequestAuthenticationGuard,
    BotRequestAuthenticationService,
    BotRequestExecutionService,
    TrustedOriginGuard,
  ],
})
export class AuthModule {}
