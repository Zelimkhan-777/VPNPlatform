import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { DataPlaneCredentialService } from './data-plane-credential.service';
import { NodeAccessGrantScheduler } from './node-access-grant-scheduler.service';
import { NodeAgentCredentialService } from './node-agent-credential.service';
import { OrchestrationService } from './orchestration.service';

@Module({
  imports: [DatabaseModule],
  providers: [
    OrchestrationService,
    NodeAccessGrantScheduler,
    NodeAgentCredentialService,
    DataPlaneCredentialService,
  ],
  exports: [
    OrchestrationService,
    NodeAgentCredentialService,
    DataPlaneCredentialService,
  ],
})
export class OrchestrationModule {}
