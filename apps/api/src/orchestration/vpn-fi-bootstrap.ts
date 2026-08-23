import {
  VPN_FI_BOOTSTRAP_DEFINITION,
  assertVpnNodeBootstrapAllowed,
  readVpnNodeBootstrapInput,
  runVpnNodeBootstrap,
  vpnNodeBootstrapRoot,
  type VpnNodeBootstrapInput,
  type VpnNodeBootstrapLogger,
} from './vpn-node-bootstrap';

export const VPN_FI_NODE_NAME = VPN_FI_BOOTSTRAP_DEFINITION.nodeName;
export const VPN_FI_ARTIFACT_DIRECTORY =
  VPN_FI_BOOTSTRAP_DEFINITION.artifactDirectory;

export type VpnFiBootstrapLogger = VpnNodeBootstrapLogger;
export type VpnFiBootstrapInput = VpnNodeBootstrapInput;

export function assertVpnFiBootstrapAllowed(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  assertVpnNodeBootstrapAllowed(VPN_FI_BOOTSTRAP_DEFINITION, environment);
}

export function vpnFiBootstrapRoot(fromDirectory?: string): string {
  return vpnNodeBootstrapRoot(fromDirectory);
}

export function readVpnFiBootstrapInput(
  environment: NodeJS.ProcessEnv = process.env,
): VpnFiBootstrapInput {
  return readVpnNodeBootstrapInput(VPN_FI_BOOTSTRAP_DEFINITION, environment);
}

export async function runVpnFiBootstrap(
  input: VpnFiBootstrapInput,
  environment: NodeJS.ProcessEnv = process.env,
  logger?: VpnFiBootstrapLogger,
): Promise<void> {
  await runVpnNodeBootstrap(
    VPN_FI_BOOTSTRAP_DEFINITION,
    input,
    environment,
    logger,
  );
}
