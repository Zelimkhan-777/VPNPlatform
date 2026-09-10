import { readFile } from 'node:fs/promises';

import type { PrismaService } from '../database/prisma.service';
import type { SubscriptionAccessService } from '../subscription-access/subscription-access.service';
import { isValidVlessDisplayName } from '../subscription-access/vless-tcp-tls.renderer';
import type { OrchestrationService } from './orchestration.service';
import type { VpnNodeBootstrapDefinition } from './vpn-node-bootstrap';
import {
  resolveActiveDeviceFromSubscriptionUrlFile,
  resolveClosedTestSubscriptionUrlPath,
} from './vpn-node-device-source';

export type ClosedTestNodeInventory = {
  name: string;
  status: string;
  locationLabel: string;
  desiredConfigVersion: number;
  appliedConfigVersion: number;
  heartbeatAgeSeconds: number | null;
  poolCode: string | null;
  poolRole: string | null;
  activeGrantCount: number;
};

export type ClosedTestSubscriptionEvidence = {
  httpStatus: number;
  routeCount: number;
  displayLabels: string[];
};

export async function attachCurrentDeviceToVpnNode(input: {
  root: string;
  prisma: PrismaService;
  orchestration: OrchestrationService;
  access: SubscriptionAccessService;
  definition: VpnNodeBootstrapDefinition;
  environment?: NodeJS.ProcessEnv;
}): Promise<{
  nodeName: string;
  grantCreated: boolean;
  routePublished: boolean;
}> {
  const node = await input.prisma.node.findUnique({
    where: { name: input.definition.nodeName },
    select: {
      id: true,
      name: true,
      status: true,
      endpoints: {
        where: { status: 'ACTIVE' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      },
      connectionProfiles: {
        where: { status: 'ACTIVE' },
        select: { id: true, version: true },
        orderBy: { version: 'asc' },
      },
    },
  });
  if (!node) {
    throw new Error(`Node ${input.definition.nodeName} was not found`);
  }
  if (node.status !== 'HEALTHY') {
    throw new Error(
      `Node ${input.definition.nodeName} must be HEALTHY before device attach`,
    );
  }
  if (node.endpoints.length !== 1) {
    throw new Error(
      `Node ${input.definition.nodeName} must have exactly one ACTIVE endpoint`,
    );
  }
  if (node.connectionProfiles.length !== 1) {
    throw new Error(
      `Node ${input.definition.nodeName} must have exactly one ACTIVE profile`,
    );
  }

  const endpoint = node.endpoints[0];
  const profile = node.connectionProfiles[0];
  if (!endpoint || !profile) {
    throw new Error(
      `Node ${input.definition.nodeName} is missing an ACTIVE endpoint or profile`,
    );
  }

  const device = await resolveActiveDeviceFromSubscriptionUrlFile({
    root: input.root,
    access: input.access,
    ...(input.environment === undefined
      ? {}
      : { environment: input.environment }),
  });
  const grant = await input.orchestration.scheduleNodeAccessGrant({
    nodeId: node.id,
    deviceId: device.deviceId,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    syncJobIdempotencyKey: `${input.definition.idempotencyPrefix}:closed-test:grant:${device.deviceId}`,
    outboxEventIdempotencyKey: `${input.definition.idempotencyPrefix}:closed-test:grant-outbox:${device.deviceId}`,
  });
  const published = await input.orchestration.publishConnectionRoute({
    nodeId: node.id,
    endpointId: endpoint.id,
    connectionProfileId: profile.id,
    syncJobIdempotencyKey: `${input.definition.idempotencyPrefix}:closed-test:route:${device.deviceId}`,
    outboxEventIdempotencyKey: `${input.definition.idempotencyPrefix}:closed-test:route-outbox:${device.deviceId}`,
  });

  return {
    nodeName: node.name,
    grantCreated: Boolean(grant.nodeSyncJobId),
    routePublished: Boolean(published.nodeSyncJobId),
  };
}

export async function readClosedTestNodeInventory(
  prisma: PrismaService,
  now = new Date(),
): Promise<ClosedTestNodeInventory[]> {
  const nodes = await prisma.node.findMany({
    where: {
      name: {
        in: ['vpn-fi-1', 'vpn-eu-1', 'vpn-pl-1'],
      },
    },
    select: {
      name: true,
      status: true,
      locationLabel: true,
      desiredConfigVersion: true,
      appliedConfigVersion: true,
      lastHeartbeatAt: true,
      locationPoolMembership: {
        select: {
          role: true,
          locationPool: { select: { code: true } },
        },
      },
      nodeAccessGrants: {
        where: { status: 'ACTIVE' },
        select: { id: true },
      },
    },
    orderBy: { name: 'asc' },
  });

  return nodes.map((node) => ({
    name: node.name,
    status: node.status,
    locationLabel: node.locationLabel,
    desiredConfigVersion: node.desiredConfigVersion,
    appliedConfigVersion: node.appliedConfigVersion,
    heartbeatAgeSeconds:
      node.lastHeartbeatAt === null
        ? null
        : Math.max(
            0,
            Math.floor((now.getTime() - node.lastHeartbeatAt.getTime()) / 1000),
          ),
    poolCode: node.locationPoolMembership?.locationPool.code ?? null,
    poolRole: node.locationPoolMembership?.role ?? null,
    activeGrantCount: node.nodeAccessGrants.length,
  }));
}

export function extractSubscriptionFeedDisplayLabels(feed: string): string[] {
  const labels: string[] = [];
  for (const line of feed.split(/\r?\n/)) {
    if (!line) continue;
    const hash = line.lastIndexOf('#');
    if (hash < 0) {
      throw new Error('Subscription feed line is missing a display label');
    }
    let label: string;
    try {
      label = decodeURIComponent(line.slice(hash + 1));
    } catch {
      throw new Error('Subscription feed display label is invalid');
    }
    if (!isValidVlessDisplayName(label)) {
      throw new Error('Subscription feed display label is invalid');
    }
    labels.push(label);
  }
  return labels;
}

export async function inspectClosedTestSubscriptionFeed(input: {
  root: string;
  access: SubscriptionAccessService;
  fetchFeed?: (url: string) => Promise<{ status: number; body: string }>;
  environment?: NodeJS.ProcessEnv;
}): Promise<ClosedTestSubscriptionEvidence> {
  const path = resolveClosedTestSubscriptionUrlPath(
    input.root,
    input.environment,
  );
  const url = (await readFile(path, 'utf8')).trim();
  await resolveActiveDeviceFromSubscriptionUrlFile({
    root: input.root,
    access: input.access,
    ...(input.environment === undefined
      ? {}
      : { environment: input.environment }),
  });
  const response = input.fetchFeed
    ? await input.fetchFeed(url)
    : await fetchSubscriptionFeed(url);
  if (response.status !== 200) {
    return {
      httpStatus: response.status,
      routeCount: 0,
      displayLabels: [],
    };
  }
  const displayLabels = extractSubscriptionFeedDisplayLabels(response.body);
  return {
    httpStatus: response.status,
    routeCount: displayLabels.length,
    displayLabels,
  };
}

export async function requireClosedTestNodeId(
  prisma: PrismaService,
  nodeName: string,
): Promise<string> {
  const node = await prisma.node.findUnique({
    where: { name: nodeName },
    select: { id: true },
  });
  if (!node) {
    throw new Error(`Node ${nodeName} was not found`);
  }
  return node.id;
}

async function fetchSubscriptionFeed(
  url: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    redirect: 'error',
    headers: { accept: 'text/plain' },
  });
  return {
    status: response.status,
    body: await response.text(),
  };
}
