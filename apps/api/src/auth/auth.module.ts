import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { AuthController } from './auth.controller';
import { AuthSessionService } from './auth-session.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [AuthSessionService],
  exports: [AuthSessionService],
})
export class AuthModule {}
