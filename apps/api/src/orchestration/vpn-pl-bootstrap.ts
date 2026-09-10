import {
  VPN_PL_BOOTSTRAP_DEFINITION,
  assertVpnNodeBootstrapAllowed,
  readVpnNodeBootstrapInput,
  runVpnNodeBootstrap,
  vpnNodeBootstrapRoot,
  type VpnNodeBootstrapInput,
  type VpnNodeBootstrapLogger,
} from './vpn-node-bootstrap';

export const VPN_PL_NODE_NAME = VPN_PL_BOOTSTRAP_DEFINITION.nodeName;
export const VPN_PL_ARTIFACT_DIRECTORY =
  VPN_PL_BOOTSTRAP_DEFINITION.artifactDirectory;

export type VpnPlBootstrapLogger = VpnNodeBootstrapLogger;
export type VpnPlBootstrapInput = VpnNodeBootstrapInput;

export function assertVpnPlBootstrapAllowed(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  assertVpnNodeBootstrapAllowed(VPN_PL_BOOTSTRAP_DEFINITION, environment);
}

export function vpnPlBootstrapRoot(fromDirectory?: string): string {
  return vpnNodeBootstrapRoot(fromDirectory);
}

export function readVpnPlBootstrapInput(
  environment: NodeJS.ProcessEnv = process.env,
): VpnPlBootstrapInput {
  return readVpnNodeBootstrapInput(VPN_PL_BOOTSTRAP_DEFINITION, environment);
}

export async function runVpnPlBootstrap(
  input: VpnPlBootstrapInput,
  environment: NodeJS.ProcessEnv = process.env,
  logger?: VpnPlBootstrapLogger,
): Promise<void> {
  await runVpnNodeBootstrap(
    VPN_PL_BOOTSTRAP_DEFINITION,
    input,
    environment,
    logger,
  );
}
