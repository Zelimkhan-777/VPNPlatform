import { randomUUID } from 'node:crypto';

import { healthPolicyConfigSchema } from '@vpn-platform/orchestration-store';

import type { PrismaService } from '../database/prisma.service';
import type { VpnNodeLocationPoolBootstrap } from './vpn-node-bootstrap';

const LOCATION_POOL_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export async function ensureVpnNodeLocationPoolMembership(
  prisma: PrismaService,
  nodeId: string,
  nodeName: string,
  pool: VpnNodeLocationPoolBootstrap,
): Promise<{
  poolCode: string;
  role: 'SERVING' | 'STANDBY';
  created: boolean;
}> {
  assertLocationPoolBootstrap(pool);
  const existing = await prisma.locationPoolMembership.findUnique({
    where: { nodeId },
    select: {
      role: true,
      locationPool: { select: { code: true } },
    },
  });
  if (existing) {
    if (existing.locationPool.code !== pool.code) {
      throw new Error(
        `Node ${nodeName} already belongs to a different location pool`,
      );
    }
    return {
      poolCode: existing.locationPool.code,
      role: existing.role,
      created: false,
    };
  }

  const locationPool = await findOrCreateLocationPool(prisma, pool);
  await prisma.locationPoolMembership.create({
    data: {
      locationPoolId: locationPool.id,
      nodeId,
      role: pool.role,
    },
  });
  return { poolCode: pool.code, role: pool.role, created: true };
}

export async function promoteVpnNodePoolMembershipToServing(
  prisma: PrismaService,
  nodeName: string,
  now = new Date(),
): Promise<{ nodeName: string; poolCode: string; role: 'SERVING' }> {
  const node = await prisma.node.findUnique({
    where: { name: nodeName },
    select: {
      id: true,
      name: true,
      status: true,
      desiredConfigVersion: true,
      appliedConfigVersion: true,
      lastHeartbeatAt: true,
      locationPoolMembership: {
        select: {
          id: true,
          role: true,
          locationPool: {
            select: {
              code: true,
              healthPolicyVersion: { select: { config: true } },
            },
          },
        },
      },
    },
  });
  if (!node) {
    throw new Error(`Node ${nodeName} was not found`);
  }
  if (!node.locationPoolMembership) {
    throw new Error(`Node ${nodeName} has no location pool membership`);
  }
  if (node.locationPoolMembership.role === 'SERVING') {
    return {
      nodeName: node.name,
      poolCode: node.locationPoolMembership.locationPool.code,
      role: 'SERVING',
    };
  }
  if (node.locationPoolMembership.role !== 'STANDBY') {
    throw new Error(`Node ${nodeName} is not eligible for serving promotion`);
  }
  if (node.status !== 'HEALTHY') {
    throw new Error(
      `Node ${nodeName} must be HEALTHY before serving promotion`,
    );
  }
  if (
    node.desiredConfigVersion < 1 ||
    node.desiredConfigVersion !== node.appliedConfigVersion
  ) {
    throw new Error(
      `Node ${nodeName} has not converged desired and applied config`,
    );
  }
  const staleHeartbeatSeconds = healthPolicyConfigSchema.parse(
    node.locationPoolMembership.locationPool.healthPolicyVersion.config,
  ).staleHeartbeatSeconds;
  if (
    node.lastHeartbeatAt === null ||
    now.getTime() - node.lastHeartbeatAt.getTime() >
      staleHeartbeatSeconds * 1000
  ) {
    throw new Error(`Node ${nodeName} heartbeat is missing or stale`);
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.locationPoolMembership.update({
      where: { id: node.locationPoolMembership!.id },
      data: { role: 'SERVING' },
    });
    await transaction.auditEvent.create({
      data: {
        action: 'location-pool.promoted',
        entityType: 'Node',
        entityId: node.id,
        metadata: {
          nodeName: node.name,
          poolCode: node.locationPoolMembership!.locationPool.code,
          previousRole: 'STANDBY',
        },
      },
    });
  });

  return {
    nodeName: node.name,
    poolCode: node.locationPoolMembership.locationPool.code,
    role: 'SERVING',
  };
}

function assertLocationPoolBootstrap(pool: VpnNodeLocationPoolBootstrap): void {
  if (!LOCATION_POOL_CODE_PATTERN.test(pool.code)) {
    throw new Error('Location pool code is invalid');
  }
  if (pool.publicLabel.trim().length < 1 || pool.publicLabel.length > 128) {
    throw new Error('Location pool public label is invalid');
  }
  if (
    !Number.isInteger(pool.candidateLimit) ||
    pool.candidateLimit < 1 ||
    pool.candidateLimit > 100
  ) {
    throw new Error('Location pool candidate limit is invalid');
  }
}

async function findOrCreateLocationPool(
  prisma: PrismaService,
  pool: VpnNodeLocationPoolBootstrap,
): Promise<{ id: string }> {
  const existing = await prisma.locationPool.findUnique({
    where: { code: pool.code },
    select: { id: true, publicLabel: true },
  });
  if (existing) {
    if (existing.publicLabel !== pool.publicLabel) {
      throw new Error(
        `Location pool ${pool.code} public label does not match bootstrap`,
      );
    }
    return existing;
  }

  const [healthActivation, capacityActivation] = await Promise.all([
    prisma.healthPolicyActivation.findFirstOrThrow({
      orderBy: { sequence: 'desc' },
      select: { policyVersionId: true },
    }),
    prisma.capacityPolicyActivation.findFirstOrThrow({
      orderBy: { sequence: 'desc' },
      select: { policyVersionId: true },
    }),
  ]);

  return prisma.locationPool.create({
    data: {
      id: randomUUID(),
      code: pool.code,
      publicLabel: pool.publicLabel,
      candidateLimit: pool.candidateLimit,
      enabled: true,
      healthPolicyVersionId: healthActivation.policyVersionId,
      capacityPolicyVersionId: capacityActivation.policyVersionId,
    },
    select: { id: true },
  });
}
