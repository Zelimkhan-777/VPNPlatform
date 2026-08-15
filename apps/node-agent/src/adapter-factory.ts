import type { NodeAgentDataPlaneAdapter } from './agent';
import type { NodeAgentEnvironment } from './environment';
import {
  LocalXrayAdapter,
  type LocalXrayAdapterLogger,
} from './local-xray-adapter';
import { StateFileSimulationAdapter } from './simulation-adapter';
import { FileXrayRuntime } from './xray-runtime';

export function createNodeAgentDataPlaneAdapter(
  config: NodeAgentEnvironment,
  logger?: LocalXrayAdapterLogger,
): NodeAgentDataPlaneAdapter {
  if (config.NODE_AGENT_MODE === 'local-xray') {
    return new LocalXrayAdapter(
      config.NODE_AGENT_STATE_FILE,
      new FileXrayRuntime({
        templatePath: config.NODE_AGENT_XRAY_TEMPLATE_PATH,
        runtimeConfigPath: config.NODE_AGENT_XRAY_RUNTIME_CONFIG,
        inboundTag: config.NODE_AGENT_XRAY_INBOUND_TAG,
      }),
      logger ? { logger } : {},
    );
  }
  return new StateFileSimulationAdapter(config.NODE_AGENT_STATE_FILE);
}
