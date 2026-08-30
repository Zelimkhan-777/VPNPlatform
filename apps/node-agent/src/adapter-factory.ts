import type { NodeAgentDataPlaneAdapter } from './agent';
import { ChronyClockTrustProbe } from './clock-trust';
import type { NodeAgentEnvironment } from './environment';
import {
  LocalXrayAdapter,
  type LocalXrayAdapterLogger,
} from './local-xray-adapter';
import { StateFileSimulationAdapter } from './simulation-adapter';
import { FileXrayRuntime } from './xray-runtime';
import { DockerXrayServingVerifier } from './xray-serving-verifier';

export function createNodeAgentDataPlaneAdapter(
  config: NodeAgentEnvironment,
  logger?: LocalXrayAdapterLogger,
): NodeAgentDataPlaneAdapter {
  if (
    config.NODE_AGENT_MODE === 'local-xray' ||
    config.NODE_AGENT_MODE === 'xray'
  ) {
    const productionRuntimeController =
      config.NODE_AGENT_MODE === 'xray'
        ? new DockerXrayServingVerifier(config.NODE_AGENT_XRAY_INBOUND_TAG)
        : undefined;
    const runtimeOptions = {
      templatePath: config.NODE_AGENT_XRAY_TEMPLATE_PATH,
      runtimeConfigPath: config.NODE_AGENT_XRAY_RUNTIME_CONFIG,
      inboundTag: config.NODE_AGENT_XRAY_INBOUND_TAG,
      // Production Xray runs as UID/GID 65532. The deployment directory is
      // setgid to that group, so group-read is required without exposing the
      // credential-bearing runtime config to other users.
      runtimeConfigMode: config.NODE_AGENT_MODE === 'xray' ? 0o640 : 0o600,
      ...(productionRuntimeController
        ? {
            servingVerifier: productionRuntimeController,
            failClosedController: productionRuntimeController,
          }
        : {}),
      ...(config.NODE_AGENT_XRAY_RELOAD_COMMAND
        ? { reloadCommand: config.NODE_AGENT_XRAY_RELOAD_COMMAND }
        : {}),
    };
    const adapterOptions = {
      logComponent: config.NODE_AGENT_MODE === 'xray' ? 'xray' : 'local-xray',
      ...(logger ? { logger } : {}),
      ...(config.NODE_AGENT_MODE === 'xray'
        ? { clockTrust: new ChronyClockTrustProbe() }
        : {}),
    };
    return new LocalXrayAdapter(
      config.NODE_AGENT_STATE_FILE,
      new FileXrayRuntime(runtimeOptions),
      adapterOptions,
    );
  }
  return new StateFileSimulationAdapter(config.NODE_AGENT_STATE_FILE);
}
