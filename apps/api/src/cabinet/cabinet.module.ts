import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { SubscriptionAccessModule } from '../subscription-access/subscription-access.module';
import { CabinetDeviceService } from './cabinet-device.service';
import { CabinetController } from './cabinet.controller';
import { CabinetService } from './cabinet.service';

@Module({
  imports: [AuthModule, DatabaseModule, SubscriptionAccessModule],
  controllers: [CabinetController],
  providers: [CabinetService, CabinetDeviceService],
})
export class CabinetModule {}
