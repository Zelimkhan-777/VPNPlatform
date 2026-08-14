import type { NodeAgentConfigurationSnapshot } from '@vpn-platform/contracts';

import type { NodeAgentControlPlane } from './control-plane-client';

export interface NodeAgentDataPlaneAdapter {
  apply(
    snapshot: NodeAgentConfigurationSnapshot,
  ): Promise<'applied' | 'already-applied'>;
}

export class NodeAgentRunner {
  constructor(
    private readonly controlPlane: NodeAgentControlPlane,
    private readonly adapter: NodeAgentDataPlaneAdapter,
  ) {}

  async runCycle(): Promise<
    'synchronized' | 'waiting-for-command' | 'acknowledged'
  > {
    await this.controlPlane.heartbeat();
    const snapshot = await this.controlPlane.configuration();
    const acknowledgement = snapshot.pendingAcknowledgement;
    if (!acknowledgement) {
      return snapshot.desiredConfigVersion === snapshot.appliedConfigVersion
        ? 'synchronized'
        : 'waiting-for-command';
    }

    await this.adapter.apply(snapshot);
    await this.controlPlane.acknowledge(acknowledgement);
    return 'acknowledged';
  }
}
