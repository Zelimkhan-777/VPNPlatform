import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { NodeAgentConfigurationService } from './node-agent-configuration.service';
import { NodeAgentController } from './node-agent.controller';
import { NodeAgentHeartbeatService } from './node-agent-heartbeat.service';

@Module({
  imports: [DatabaseModule, OrchestrationModule],
  controllers: [NodeAgentController],
  providers: [NodeAgentConfigurationService, NodeAgentHeartbeatService],
})
export class NodeAgentModule {}
