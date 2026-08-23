import {
  VPN_EU_BOOTSTRAP_DEFINITION,
  assertVpnNodeBootstrapAllowed,
  readVpnNodeBootstrapInput,
  runVpnNodeBootstrap,
  vpnNodeBootstrapRoot,
  type VpnNodeBootstrapInput,
  type VpnNodeBootstrapLogger,
} from './vpn-node-bootstrap';

export const VPN_EU_NODE_NAME = VPN_EU_BOOTSTRAP_DEFINITION.nodeName;
export const VPN_EU_ARTIFACT_DIRECTORY =
  VPN_EU_BOOTSTRAP_DEFINITION.artifactDirectory;

export type VpnEuBootstrapLogger = VpnNodeBootstrapLogger;
export type VpnEuBootstrapInput = VpnNodeBootstrapInput;

export function assertVpnEuBootstrapAllowed(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  assertVpnNodeBootstrapAllowed(VPN_EU_BOOTSTRAP_DEFINITION, environment);
}

export function vpnEuBootstrapRoot(fromDirectory?: string): string {
  return vpnNodeBootstrapRoot(fromDirectory);
}

export function readVpnEuBootstrapInput(
  environment: NodeJS.ProcessEnv = process.env,
): VpnEuBootstrapInput {
  return readVpnNodeBootstrapInput(VPN_EU_BOOTSTRAP_DEFINITION, environment);
}

export async function runVpnEuBootstrap(
  input: VpnEuBootstrapInput,
  environment: NodeJS.ProcessEnv = process.env,
  logger?: VpnEuBootstrapLogger,
): Promise<void> {
  await runVpnNodeBootstrap(
    VPN_EU_BOOTSTRAP_DEFINITION,
    input,
    environment,
    logger,
  );
}
