import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { AuthController } from './auth.controller';
import { AuthSessionService } from './auth-session.service';
import { TrustedPrelaunchService } from './trusted-prelaunch.service';
import { TrustedOriginGuard } from './trusted-origin.guard';

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [AuthController],
  providers: [AuthSessionService, TrustedPrelaunchService, TrustedOriginGuard],
  exports: [AuthSessionService, TrustedPrelaunchService, TrustedOriginGuard],
})
export class AuthModule {}
