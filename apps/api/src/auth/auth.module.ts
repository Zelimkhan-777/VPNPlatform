import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { AuthController } from './auth.controller';
import { AuthSessionService } from './auth-session.service';
import { TrustedPrelaunchService } from './trusted-prelaunch.service';

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [AuthController],
  providers: [AuthSessionService, TrustedPrelaunchService],
  exports: [AuthSessionService, TrustedPrelaunchService],
})
export class AuthModule {}
