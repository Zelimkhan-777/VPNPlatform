import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { CabinetController } from './cabinet.controller';
import { CabinetService } from './cabinet.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [CabinetController],
  providers: [CabinetService],
})
export class CabinetModule {}
