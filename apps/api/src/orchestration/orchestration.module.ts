import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { NodeAgentCredentialService } from './node-agent-credential.service';
import { OrchestrationService } from './orchestration.service';

@Module({
  imports: [DatabaseModule],
  providers: [OrchestrationService, NodeAgentCredentialService],
  exports: [OrchestrationService, NodeAgentCredentialService],
})
export class OrchestrationModule {}
