import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { createInfrastructureTestApp } from './fixture';

const migrationsRoot = resolve(process.cwd(), '../../prisma/migrations');
const poolMigrationName = '20260909020000_add_location_pool_foundation';
const poolMigrationPath = resolve(
  migrationsRoot,
  poolMigrationName,
  'migration.sql',
);

async function withIsolatedSchema(
  databaseUrl: string,
  run: (isolatedUrl: string) => Promise<void>,
): Promise<void> {
  const schemaName = `api_integration_${randomUUID().replaceAll('-', '')}`;
  const administrator = new PrismaClient({ datasourceUrl: databaseUrl });
  let created = false;
  try {
    await administrator.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    const isolated = new URL(databaseUrl);
    isolated.searchParams.set('schema', schemaName);
    await run(isolated.toString());
  } finally {
    try {
      if (created) {
        await administrator.$executeRawUnsafe(
          `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
        );
      }
    } finally {
      await administrator.$disconnect();
    }
  }
}

async function deployMigrationsBeforePool(databaseUrl: string): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'vpn-location-pool-'));
  try {
    const temporaryPrisma = join(temporaryRoot, 'prisma');
    const temporaryMigrations = join(temporaryPrisma, 'migrations');
    await mkdir(temporaryMigrations, { recursive: true });
    await cp(
      resolve(process.cwd(), '../../prisma/schema.prisma'),
      join(temporaryPrisma, 'schema.prisma'),
    );
    await cp(
      resolve(migrationsRoot, 'migration_lock.toml'),
      join(temporaryMigrations, 'migration_lock.toml'),
    );
    const entries = await readdir(migrationsRoot, { withFileTypes: true });
    const migrationNames = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.localeCompare(poolMigrationName) < 0,
      )
      .map((entry) => entry.name)
      .sort();
    for (const migrationName of migrationNames) {
      await cp(
        resolve(migrationsRoot, migrationName),
        join(temporaryMigrations, migrationName),
        { recursive: true },
      );
    }

    const prismaCli = resolve(
      process.cwd(),
      '../../node_modules/prisma/build/index.js',
    );
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        [
          prismaCli,
          'migrate',
          'deploy',
          '--schema',
          join(temporaryPrisma, 'schema.prisma'),
        ],
        {
          env: { ...process.env, DATABASE_URL: databaseUrl },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) return resolvePromise();
        reject(
          new Error(
            `Prisma migration failed (${signal ?? String(code ?? 'unknown')}): ${output}`,
          ),
        );
      });
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function applyPoolMigration(databaseUrl: string): Promise<void> {
  const prismaCli = resolve(
    process.cwd(),
    '../../node_modules/prisma/build/index.js',
  );
  const prismaSchema = resolve(process.cwd(), '../../prisma/schema.prisma');
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        prismaCli,
        'db',
        'execute',
        '--file',
        poolMigrationPath,
        '--schema',
        prismaSchema,
      ],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolvePromise();
      reject(
        new Error(
          `Location pool migration failed (${signal ?? String(code ?? 'unknown')}): ${output}`,
        ),
      );
    });
  });
}

describe('infrastructure location-pools', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createInfrastructureTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('backfills legacy locations and preserves provisioning as standby', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');

    await withIsolatedSchema(databaseUrl, async (isolatedUrl) => {
      await deployMigrationsBeforePool(isolatedUrl);
      const prisma = new PrismaClient({ datasourceUrl: isolatedUrl });
      try {
        const suffix = randomUUID();
        const [serving, standby, other] = await Promise.all([
          prisma.node.create({
            data: {
              name: `legacy-serving-${suffix}`,
              provider: 'provider-a',
              locationLabel: 'Legacy Finland',
              status: 'HEALTHY',
            },
          }),
          prisma.node.create({
            data: {
              name: `legacy-standby-${suffix}`,
              provider: 'provider-b',
              locationLabel: 'Legacy Finland',
              status: 'PROVISIONING',
            },
          }),
          prisma.node.create({
            data: {
              name: `legacy-other-${suffix}`,
              provider: 'provider-c',
              locationLabel: 'Legacy Netherlands',
              status: 'DRAINING',
            },
          }),
        ]);
        await applyPoolMigration(isolatedUrl);

        const pools = await prisma.$queryRaw<
          { publicLabel: string; memberCount: bigint }[]
        >`
          SELECT pool."publicLabel", count(membership.id)::bigint AS "memberCount"
          FROM "LocationPool" AS pool
          INNER JOIN "LocationPoolMembership" AS membership
            ON membership."locationPoolId" = pool.id
          GROUP BY pool.id
          ORDER BY pool."publicLabel"
          `;
        expect(pools).toEqual([
          { publicLabel: 'Legacy Finland', memberCount: 2n },
          { publicLabel: 'Legacy Netherlands', memberCount: 1n },
        ]);
        const memberships = await prisma.$queryRaw<
          { nodeId: string; role: string }[]
        >`
          SELECT "nodeId"::text AS "nodeId", role::text
          FROM "LocationPoolMembership"
          ORDER BY "nodeId"
          `;
        expect(
          new Map(memberships.map((item) => [item.nodeId, item.role])),
        ).toEqual(
          new Map([
            [serving.id, 'SERVING'],
            [standby.id, 'STANDBY'],
            [other.id, 'SERVING'],
          ]),
        );
      } finally {
        await prisma.$disconnect();
      }
    });
  }, 15_000);

  it('enforces one current pool membership per node and immutable identities', async () => {
    const prisma = app.get(PrismaService);
    const [healthActivation, capacityActivation] = await Promise.all([
      prisma.healthPolicyActivation.findFirstOrThrow({
        orderBy: { sequence: 'desc' },
      }),
      prisma.capacityPolicyActivation.findFirstOrThrow({
        orderBy: { sequence: 'desc' },
      }),
    ]);
    const suffix = randomUUID();
    const createPool = (code: string, publicLabel: string) =>
      prisma.locationPool.create({
        data: {
          code,
          publicLabel,
          candidateLimit: 2,
          healthPolicyVersionId: healthActivation.policyVersionId,
          capacityPolicyVersionId: capacityActivation.policyVersionId,
        },
      });
    const [firstPool, secondPool, node] = await Promise.all([
      createPool(`pool-a-${suffix}`, 'Finland'),
      createPool(`pool-b-${suffix}`, 'Netherlands'),
      prisma.node.create({
        data: {
          name: `pool-node-${suffix}`,
          provider: 'provider-a',
          locationLabel: 'Finland',
          status: 'HEALTHY',
        },
      }),
    ]);
    const membership = await prisma.locationPoolMembership.create({
      data: {
        locationPoolId: firstPool.id,
        nodeId: node.id,
        role: 'STANDBY',
      },
    });
    await expect(
      prisma.locationPoolMembership.update({
        where: { id: membership.id },
        data: { role: 'SERVING' },
      }),
    ).resolves.toMatchObject({ role: 'SERVING' });
    await expect(
      prisma.locationPoolMembership.create({
        data: {
          locationPoolId: secondPool.id,
          nodeId: node.id,
          role: 'STANDBY',
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.locationPool.update({
        where: { id: firstPool.id },
        data: { code: `changed-${suffix}` },
      }),
    ).rejects.toThrow(/identity is immutable/);
    await expect(
      prisma.locationPoolMembership.delete({
        where: { id: membership.id },
      }),
    ).rejects.toThrow(/append-preserved/);
    await expect(
      prisma.locationPool.create({
        data: {
          code: `invalid-${suffix}`,
          publicLabel: 'Invalid',
          candidateLimit: 0,
          healthPolicyVersionId: healthActivation.policyVersionId,
          capacityPolicyVersionId: capacityActivation.policyVersionId,
        },
      }),
    ).rejects.toThrow();
    const draftHealthPolicy = await prisma.healthPolicyVersion.create({
      data: {
        code: `draft-health-${suffix}`,
        config: {},
      },
    });
    await expect(
      prisma.locationPool.create({
        data: {
          code: `draft-policy-${suffix}`,
          publicLabel: 'Draft policy must not be assigned',
          candidateLimit: 2,
          healthPolicyVersionId: draftHealthPolicy.id,
          capacityPolicyVersionId: capacityActivation.policyVersionId,
        },
      }),
    ).rejects.toThrow(/requires activated health and capacity policies/);
  });
});
