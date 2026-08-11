import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { NodeAgentConfigurationService } from './node-agent-configuration.service';
import { NodeAgentController } from './node-agent.controller';

@Module({
  imports: [DatabaseModule, OrchestrationModule],
  controllers: [NodeAgentController],
  providers: [NodeAgentConfigurationService],
})
export class NodeAgentModule {}
