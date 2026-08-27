import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { DataPlaneCredentialService } from './data-plane-credential.service';
import { DeviceAccessRevoker } from './device-access-revoker.service';
import { NodeAccessGrantScheduler } from './node-access-grant-scheduler.service';
import { NodeAccessReconciler } from './node-access-reconciler.service';
import { NodeAgentCredentialService } from './node-agent-credential.service';
import { NodeLifecycleManager } from './node-lifecycle-manager.service';
import { OrchestrationService } from './orchestration.service';

@Module({
  imports: [DatabaseModule],
  providers: [
    OrchestrationService,
    NodeAccessGrantScheduler,
    NodeAccessReconciler,
    NodeLifecycleManager,
    DeviceAccessRevoker,
    NodeAgentCredentialService,
    DataPlaneCredentialService,
  ],
  exports: [
    OrchestrationService,
    NodeAccessGrantScheduler,
    NodeAgentCredentialService,
    DataPlaneCredentialService,
  ],
})
export class OrchestrationModule {}
