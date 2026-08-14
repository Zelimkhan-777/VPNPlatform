import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { DataPlaneCredentialService } from './data-plane-credential.service';
import { NodeAgentCredentialService } from './node-agent-credential.service';
import { OrchestrationService } from './orchestration.service';

@Module({
  imports: [DatabaseModule],
  providers: [
    OrchestrationService,
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
