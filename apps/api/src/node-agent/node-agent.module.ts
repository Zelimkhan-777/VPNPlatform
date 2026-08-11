import { Module } from '@nestjs/common';

import { OrchestrationModule } from '../orchestration/orchestration.module';
import { NodeAgentController } from './node-agent.controller';

@Module({
  imports: [OrchestrationModule],
  controllers: [NodeAgentController],
})
export class NodeAgentModule {}
