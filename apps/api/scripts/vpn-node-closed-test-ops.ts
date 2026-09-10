import { parseApiEnvironment } from '../src/config/environment';
import { PrismaService } from '../src/database/prisma.service';
import { DataPlaneCredentialService } from '../src/orchestration/data-plane-credential.service';
import { DeviceAccessRevoker } from '../src/orchestration/device-access-revoker.service';
import { NodeAccessGrantScheduler } from '../src/orchestration/node-access-grant-scheduler.service';
import { NodeAccessReconciler } from '../src/orchestration/node-access-reconciler.service';
import { NodeLifecycleManager } from '../src/orchestration/node-lifecycle-manager.service';
import { OrchestrationService } from '../src/orchestration/orchestration.service';
import { SubscriptionAccessService } from '../src/subscription-access/subscription-access.service';
import {
  attachCurrentDeviceToVpnNode,
  inspectClosedTestSubscriptionFeed,
  readClosedTestNodeInventory,
  requireClosedTestNodeId,
} from '../src/orchestration/vpn-node-closed-test';
import { promoteVpnNodePoolMembershipToServing } from '../src/orchestration/vpn-node-location-pool';
import {
  VPN_EU_BOOTSTRAP_DEFINITION,
  VPN_FI_BOOTSTRAP_DEFINITION,
  VPN_PL_BOOTSTRAP_DEFINITION,
  vpnNodeBootstrapRoot,
  type VpnNodeBootstrapDefinition,
} from '../src/orchestration/vpn-node-bootstrap';

type Command =
  | 'inspect-nodes'
  | 'inspect-subscription'
  | 'attach-current-device'
  | 'promote-serving'
  | 'drain'
  | 'disable'
  | 'restore-healthy';

const COMMANDS: readonly Command[] = [
  'inspect-nodes',
  'inspect-subscription',
  'attach-current-device',
  'promote-serving',
  'drain',
  'disable',
  'restore-healthy',
];

function readArguments(argv: readonly string[]): {
  command: Command;
  nodeName?: string;
} {
  let command: Command | undefined;
  let nodeName: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') {
      continue;
    }
    if (flag === '--command') {
      const value = argv[index + 1];
      index += 1;
      if (!value || !isCommand(value)) {
        throw new Error(`Unknown closed-test command: ${value ?? ''}`);
      }
      command = value;
      continue;
    }
    if (flag === '--node-name') {
      nodeName = argv[index + 1];
      index += 1;
      if (!nodeName) {
        throw new Error('--node-name requires a value');
      }
      continue;
    }
    throw new Error(`Unknown closed-test flag: ${flag}`);
  }
  if (!command) {
    throw new Error('Closed-test --command is required');
  }
  return { command, nodeName };
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function definitionForNodeName(nodeName: string): VpnNodeBootstrapDefinition {
  const definitions = [
    VPN_PL_BOOTSTRAP_DEFINITION,
    VPN_EU_BOOTSTRAP_DEFINITION,
    VPN_FI_BOOTSTRAP_DEFINITION,
  ];
  const definition = definitions.find((item) => item.nodeName === nodeName);
  if (!definition) {
    throw new Error(`Unsupported closed-test node ${nodeName}`);
  }
  return definition;
}

function requireNodeName(nodeName: string | undefined): string {
  if (!nodeName) {
    throw new Error('--node-name is required for this command');
  }
  return nodeName;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Closed-test node operations are forbidden in production');
  }
  const args = readArguments(process.argv.slice(2));
  const config = parseApiEnvironment(process.env);
  const prisma = new PrismaService(config);
  const dataPlaneCredentials = new DataPlaneCredentialService(config);
  const orchestration = new OrchestrationService(
    prisma,
    new NodeAccessGrantScheduler(prisma, dataPlaneCredentials),
    new NodeLifecycleManager(prisma),
    new DeviceAccessRevoker(prisma),
    new NodeAccessReconciler(prisma, config),
  );
  const access = new SubscriptionAccessService(prisma, config);
  const root = vpnNodeBootstrapRoot();

  try {
    if (args.command === 'inspect-nodes') {
      const inventory = await readClosedTestNodeInventory(prisma);
      process.stdout.write(`${JSON.stringify({ nodes: inventory })}\n`);
      return;
    }
    if (args.command === 'inspect-subscription') {
      const evidence = await inspectClosedTestSubscriptionFeed({
        root,
        access,
      });
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
      return;
    }

    const nodeName = requireNodeName(args.nodeName);
    if (args.command === 'attach-current-device') {
      const result = await attachCurrentDeviceToVpnNode({
        root,
        prisma,
        orchestration,
        access,
        definition: definitionForNodeName(nodeName),
      });
      process.stdout.write(
        `ATTACHED node=${result.nodeName} grant=${String(result.grantCreated)} route=${String(result.routePublished)}\n`,
      );
      return;
    }
    if (args.command === 'promote-serving') {
      const result = await promoteVpnNodePoolMembershipToServing(
        prisma,
        nodeName,
      );
      process.stdout.write(
        `PROMOTED node=${result.nodeName} pool=${result.poolCode} role=${result.role}\n`,
      );
      return;
    }

    const nodeId = await requireClosedTestNodeId(prisma, nodeName);
    if (args.command === 'drain') {
      const result = await orchestration.drainNode(nodeId);
      process.stdout.write(
        `DRAINED node=${nodeName} status=${result.status}\n`,
      );
      return;
    }
    if (args.command === 'disable') {
      const result = await orchestration.disableNode(nodeId);
      process.stdout.write(
        `DISABLED node=${nodeName} status=${result.status}\n`,
      );
      return;
    }
    const restored = await orchestration.restoreNodeToHealthy(nodeId);
    process.stdout.write(
      `RESTORED node=${nodeName} status=${restored.status}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Closed-test node operation failed'}\n`,
  );
  process.exitCode = 1;
});
