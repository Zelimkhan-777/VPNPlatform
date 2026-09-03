import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import {
  assertNoLegacyAdmins,
  demoteLegacyAdmins,
} from '../../src/cli/legacy-admin';
import { createInfrastructureTestApp } from './fixture';

const migrationPath = resolve(
  process.cwd(),
  '../../prisma/migrations/20260829120000_drop_legacy_node_endpoint/migration.sql',
);
const migrationsRoot = resolve(process.cwd(), '../../prisma/migrations');
const stageBMigrationName = '20260903010000_add_application_stage_b_schema';
const stageBMigrationPath = resolve(
  migrationsRoot,
  stageBMigrationName,
  'migration.sql',
);

async function withPreStageBSchema(
  run: (prisma: PrismaClient, databaseUrl: string) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const schemaName = `api_integration_${randomUUID().replaceAll('-', '')}`;
  const administrator = new PrismaClient({ datasourceUrl: databaseUrl });
  let schemaCreated = false;
  try {
    await administrator.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;
    const isolated = new URL(databaseUrl);
    isolated.searchParams.set('schema', schemaName);
    const isolatedUrl = isolated.toString();
    await runMigrateDeploy(isolatedUrl, false);
    const prisma = new PrismaClient({ datasourceUrl: isolatedUrl });
    try {
      await run(prisma, isolatedUrl);
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    try {
      if (schemaCreated) {
        await administrator.$executeRawUnsafe(
          `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
        );
      }
    } finally {
      await administrator.$disconnect();
    }
  }
}

async function runMigrateDeploy(
  databaseUrl: string,
  includeStageB: boolean,
): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'vpn-stage-b-migration-'));
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
          (includeStageB || entry.name.localeCompare(stageBMigrationName) < 0),
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
        if (code === 0) {
          resolvePromise();
          return;
        }
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

async function stageBObjects(prisma: PrismaClient) {
  return prisma.$queryRawUnsafe<
    { durationColumn: boolean; adminMembershipTable: boolean }[]
  >(
    `SELECT
       to_regclass(format('%I.%I', current_schema(), 'AdminMembership')) IS NOT NULL AS "adminMembershipTable",
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'Plan'
           AND column_name = 'durationDays'
       ) AS "durationColumn"`,
  );
}

async function stageBResidue(prisma: PrismaClient) {
  return prisma.$queryRawUnsafe<
    {
      durationColumn: boolean;
      adminMembershipTable: boolean;
      orderTable: boolean;
      pendingLoginTable: boolean;
      botPrincipalTable: boolean;
      adminRoleType: boolean;
    }[]
  >(
    `SELECT
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'Plan'
           AND column_name = 'durationDays'
       ) AS "durationColumn",
       to_regclass(format('%I.%I', current_schema(), 'AdminMembership')) IS NOT NULL AS "adminMembershipTable",
       to_regclass(format('%I.%I', current_schema(), 'Order')) IS NOT NULL AS "orderTable",
       to_regclass(format('%I.%I', current_schema(), 'PendingLogin')) IS NOT NULL AS "pendingLoginTable",
       to_regclass(format('%I.%I', current_schema(), 'BotServicePrincipal')) IS NOT NULL AS "botPrincipalTable",
       EXISTS (
         SELECT 1
         FROM pg_type
         INNER JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
         WHERE pg_namespace.nspname = current_schema()
           AND pg_type.typname = 'AdminRole'
       ) AS "adminRoleType"`,
  );
}

async function userRoleLabels(prisma: PrismaClient) {
  return prisma.$queryRawUnsafe<{ value: string }[]>(
    `SELECT enumlabel AS value
     FROM pg_enum
     INNER JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
     INNER JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
     WHERE pg_namespace.nspname = current_schema()
       AND pg_type.typname = 'UserRole'
     ORDER BY enumsortorder`,
  );
}

function hexHash(namespace: string, value: string): string {
  return createHmac('sha256', namespace).update(value).digest('hex');
}

async function legacyEndpointColumns(prisma: PrismaService) {
  return prisma.$queryRaw<{ columnName: string }[]>`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Node'
      AND column_name = 'endpoint'
  `;
}

async function waitForPendingNodeTableLock(
  prisma: PrismaService,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const locks = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
      FROM pg_locks AS lock
      INNER JOIN pg_class AS relation
        ON relation.oid = lock.relation
      INNER JOIN pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND relation.relname = 'Node'
        AND lock.mode = 'AccessExclusiveLock'
        AND lock.granted = false
    `;
    if (Number(locks[0]?.count ?? 0) > 0) {
      return;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }

  throw new Error('Migration did not wait for the Node table lock');
}

describe('infrastructure migration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createInfrastructureTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('removes the deprecated Node.endpoint column', async () => {
    const prisma = app.get(PrismaService);

    await expect(legacyEndpointColumns(prisma)).resolves.toEqual([]);
  });

  it('refuses to discard an unexpected non-null legacy endpoint', async () => {
    const prisma = app.get(PrismaService);
    const migrationSql = await readFile(migrationPath, 'utf8');
    const nodeId = randomUUID();
    const nodeName = `legacy-endpoint-guard-${nodeId}`;

    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          'ALTER TABLE "Node" ADD COLUMN "endpoint" VARCHAR(255)',
        );
        await transaction.node.create({
          data: {
            id: nodeId,
            name: nodeName,
            provider: 'integration-test',
            locationLabel: 'integration-test',
          },
        });
        await transaction.$executeRaw`
          UPDATE "Node"
          SET "endpoint" = 'legacy.example.test'
          WHERE "id" = ${nodeId}::uuid
        `;
        await transaction.$executeRawUnsafe(migrationSql);
      }),
    ).rejects.toThrow(/Cannot drop Node\.endpoint/);

    await expect(
      prisma.node.findUnique({ where: { id: nodeId } }),
    ).resolves.toBeNull();
    await expect(legacyEndpointColumns(prisma)).resolves.toEqual([]);
  });

  it('observes a legacy endpoint committed while waiting for its table lock', async () => {
    const prisma = app.get(PrismaService);
    const migrationSql = await readFile(migrationPath, 'utf8');
    const nodeId = randomUUID();
    const nodeName = `legacy-endpoint-race-${nodeId}`;
    let releaseWriter: () => void = () => undefined;
    const writerMayCommit = new Promise<void>((resolvePromise) => {
      releaseWriter = resolvePromise;
    });
    let reportRowLock: () => void = () => undefined;
    const rowIsLocked = new Promise<void>((resolvePromise) => {
      reportRowLock = resolvePromise;
    });

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Node" ADD COLUMN "endpoint" VARCHAR(255)',
    );
    await prisma.node.create({
      data: {
        id: nodeId,
        name: nodeName,
        provider: 'integration-test',
        locationLabel: 'integration-test',
      },
    });

    const writer = prisma.$transaction(
      async (transaction) => {
        await transaction.$queryRaw`
          SELECT "id"
          FROM "Node"
          WHERE "id" = ${nodeId}::uuid
          FOR UPDATE
        `;
        reportRowLock();
        await writerMayCommit;
        await transaction.$executeRaw`
          UPDATE "Node"
          SET "endpoint" = 'committed-during-migration.example.test'
          WHERE "id" = ${nodeId}::uuid
        `;
      },
      { timeout: 15_000 },
    );

    try {
      await rowIsLocked;
      const migration = prisma.$executeRawUnsafe(migrationSql).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );

      await waitForPendingNodeTableLock(prisma);
      releaseWriter();
      await writer;

      const result = await migration;
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toMatch(
        /Cannot drop Node\.endpoint/,
      );
      await expect(
        prisma.$queryRaw<{ endpoint: string }[]>`
          SELECT "endpoint"
          FROM "Node"
          WHERE "id" = ${nodeId}::uuid
        `,
      ).resolves.toEqual([
        { endpoint: 'committed-during-migration.example.test' },
      ]);
      await expect(legacyEndpointColumns(prisma)).resolves.toEqual([
        { columnName: 'endpoint' },
      ]);
    } finally {
      releaseWriter();
      await writer.catch(() => undefined);
      await prisma.$executeRaw`DELETE FROM "Node" WHERE "id" = ${nodeId}::uuid`;
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "Node" DROP COLUMN IF EXISTS "endpoint"',
      );
    }
  });

  it('requires audited legacy ADMIN demotion before applying Stage B', async () => {
    await withPreStageBSchema(async (prisma, databaseUrl) => {
      const userId = randomUUID();
      const planId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "User" ("id", "telegramUserId", "role", "updatedAt")
        VALUES (${userId}::uuid, 'stage-b-legacy-admin', 'ADMIN', clock_timestamp())
      `;
      await prisma.$executeRaw`
        INSERT INTO "Plan" ("id", "code", "name", "priceMinor", "currency", "deviceLimit", "updatedAt")
        VALUES (${planId}::uuid, 'stage-b-startup', 'Startup', 1, 'RUB', 1, clock_timestamp())
      `;

      await expect(assertNoLegacyAdmins(prisma)).rejects.toThrow(/1 row\(s\)/);
      await expect(
        demoteLegacyAdmins(
          prisma,
          'Stage B integration remediation of obsolete ADMIN access',
        ),
      ).resolves.toBe(1);
      await expect(assertNoLegacyAdmins(prisma)).resolves.toBeUndefined();

      await expect(
        runMigrateDeploy(databaseUrl, true),
      ).resolves.toBeUndefined();
      await expect(stageBObjects(prisma)).resolves.toEqual([
        { durationColumn: true, adminMembershipTable: true },
      ]);
      await expect(
        prisma.plan.findUniqueOrThrow({ where: { id: planId } }),
      ).resolves.toMatchObject({ durationDays: 30 });
      await expect(prisma.adminMembership.count()).resolves.toBe(0);
      await expect(
        prisma.$queryRaw<{ role: string; auditCount: bigint }[]>`
          SELECT "User"."role"::text AS role,
                 count("AuditEvent"."id")::bigint AS "auditCount"
          FROM "User"
          LEFT JOIN "AuditEvent"
            ON "AuditEvent"."entityId" = "User"."id"
           AND "AuditEvent"."action" = 'legacy-admin-demoted'
          WHERE "User"."id" = ${userId}::uuid
          GROUP BY "User"."role"
        `,
      ).resolves.toEqual([{ role: 'CUSTOMER', auditCount: 1n }]);
    });
  }, 20_000);

  it('rolls back every Stage B object when Plan duration cannot be inferred', async () => {
    await withPreStageBSchema(async (prisma, databaseUrl) => {
      const firstPlanId = randomUUID();
      const secondPlanId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "Plan" ("id", "code", "name", "priceMinor", "currency", "deviceLimit", "updatedAt")
        VALUES
          (${firstPlanId}::uuid, 'stage-b-first', 'First', 1, 'RUB', 1, clock_timestamp()),
          (${secondPlanId}::uuid, 'stage-b-second', 'Second', 1, 'RUB', 1, clock_timestamp())
      `;
      const migrationSql = await readFile(stageBMigrationPath, 'utf8');
      const durationGuard = migrationSql.match(
        /DO \$\$\s*DECLARE\s+plan_count[\s\S]*?\$\$;/,
      )?.[0];
      expect(durationGuard).toBeDefined();
      await expect(
        prisma.$executeRawUnsafe(durationGuard as string),
      ).rejects.toThrow(
        /Cannot backfill Plan\.durationDays: expected zero or one startup plan/,
      );
      await expect(runMigrateDeploy(databaseUrl, true)).rejects.toThrow(
        /Prisma migration failed/,
      );
      await expect(stageBObjects(prisma)).resolves.toEqual([
        { durationColumn: false, adminMembershipTable: false },
      ]);
      await expect(userRoleLabels(prisma)).resolves.toEqual([
        { value: 'CUSTOMER' },
        { value: 'ADMIN' },
      ]);
    });
  }, 20_000);

  it('aborts Stage B migrate deploy while legacy ADMIN rows remain', async () => {
    await withPreStageBSchema(async (prisma, databaseUrl) => {
      const userId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "User" ("id", "telegramUserId", "role", "updatedAt")
        VALUES (${userId}::uuid, 'stage-b-admin-abort', 'ADMIN', clock_timestamp())
      `;

      await expect(runMigrateDeploy(databaseUrl, true)).rejects.toThrow(
        /Prisma migration failed/,
      );
      await expect(stageBResidue(prisma)).resolves.toEqual([
        {
          durationColumn: false,
          adminMembershipTable: false,
          orderTable: false,
          pendingLoginTable: false,
          botPrincipalTable: false,
          adminRoleType: false,
        },
      ]);
      await expect(userRoleLabels(prisma)).resolves.toEqual([
        { value: 'CUSTOMER' },
        { value: 'ADMIN' },
      ]);
      await expect(
        prisma.$queryRaw<{ role: string }[]>`
          SELECT "role"::text AS role
          FROM "User"
          WHERE "id" = ${userId}::uuid
        `,
      ).resolves.toEqual([{ role: 'ADMIN' }]);
    });
  }, 20_000);

  it('binds PendingLogin to the same user, Telegram identity and challenge owner', async () => {
    const prisma = app.get(PrismaService);
    const suffix = randomUUID().replaceAll('-', '');
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const expiresAt = new Date('2099-01-01T00:00:00.000Z');
    const firstTelegram = `pl1${suffix.slice(0, 26)}`;
    const secondTelegram = `pl2${suffix.slice(0, 26)}`;
    let firstUserId: string | undefined;
    let secondUserId: string | undefined;
    let ownedChallengeId: string | undefined;
    let unboundChallengeId: string | undefined;
    let pendingLoginId: string | undefined;

    try {
      const [firstUser, secondUser] = await prisma.$transaction([
        prisma.user.create({ data: { telegramUserId: firstTelegram } }),
        prisma.user.create({ data: { telegramUserId: secondTelegram } }),
      ]);
      firstUserId = firstUser.id;
      secondUserId = secondUser.id;

      const ownedChallenge = await prisma.authChallenge.create({
        data: {
          launchId: `owned-${suffix}`,
          tokenHash: hexHash('pending-login-challenge', `owned-${suffix}`),
          createdAt,
          expiresAt,
          userId: firstUser.id,
        },
      });
      ownedChallengeId = ownedChallenge.id;
      const unboundChallenge = await prisma.authChallenge.create({
        data: {
          launchId: `unbound-${suffix}`,
          tokenHash: hexHash('pending-login-challenge', `unbound-${suffix}`),
          createdAt,
          expiresAt,
        },
      });
      unboundChallengeId = unboundChallenge.id;

      await expect(
        prisma.pendingLogin.create({
          data: {
            challengeId: ownedChallenge.id,
            userId: firstUser.id,
            telegramUserId: secondUser.telegramUserId,
            pendingTokenHash: hexHash(
              'pending-login-token',
              `mismatch-tg-${suffix}`,
            ),
            confirmationCodeHash: hexHash(
              'pending-login-code',
              `mismatch-tg-${suffix}`,
            ),
            expiresAt,
          },
        }),
      ).rejects.toThrow(/PendingLogin_userId_telegramUserId_fkey|foreign key/i);

      await expect(
        prisma.pendingLogin.create({
          data: {
            challengeId: ownedChallenge.id,
            userId: secondUser.id,
            telegramUserId: secondUser.telegramUserId,
            pendingTokenHash: hexHash(
              'pending-login-token',
              `mismatch-challenge-${suffix}`,
            ),
            confirmationCodeHash: hexHash(
              'pending-login-code',
              `mismatch-challenge-${suffix}`,
            ),
            expiresAt,
          },
        }),
      ).rejects.toThrow(/PendingLogin_challengeId_userId_fkey|foreign key/i);

      await expect(
        prisma.pendingLogin.create({
          data: {
            challengeId: unboundChallenge.id,
            userId: firstUser.id,
            telegramUserId: firstUser.telegramUserId,
            pendingTokenHash: hexHash(
              'pending-login-token',
              `unbound-challenge-${suffix}`,
            ),
            confirmationCodeHash: hexHash(
              'pending-login-code',
              `unbound-challenge-${suffix}`,
            ),
            expiresAt,
          },
        }),
      ).rejects.toThrow(/PendingLogin_challengeId_userId_fkey|foreign key/i);

      const pendingLogin = await prisma.pendingLogin.create({
        data: {
          challengeId: ownedChallenge.id,
          userId: firstUser.id,
          telegramUserId: firstUser.telegramUserId,
          pendingTokenHash: hexHash('pending-login-token', `bound-${suffix}`),
          confirmationCodeHash: hexHash(
            'pending-login-code',
            `bound-${suffix}`,
          ),
          expiresAt,
        },
      });
      pendingLoginId = pendingLogin.id;
      expect(pendingLogin).toMatchObject({
        challengeId: ownedChallenge.id,
        userId: firstUser.id,
        telegramUserId: firstUser.telegramUserId,
      });
    } finally {
      if (pendingLoginId) {
        await prisma.pendingLogin.delete({ where: { id: pendingLoginId } });
      }
      if (ownedChallengeId) {
        await prisma.authChallenge.delete({ where: { id: ownedChallengeId } });
      }
      if (unboundChallengeId) {
        await prisma.authChallenge.delete({
          where: { id: unboundChallengeId },
        });
      }
      if (firstUserId) {
        await prisma.user.delete({ where: { id: firstUserId } });
      }
      if (secondUserId) {
        await prisma.user.delete({ where: { id: secondUserId } });
      }
    }
  });

  it('prevents deletion or demotion of the last OWNER at the database boundary', async () => {
    const prisma = app.get(PrismaService);

    for (const operation of ['delete', 'demote'] as const) {
      await expect(
        prisma.$transaction(async (transaction) => {
          const user = await transaction.user.create({
            data: { telegramUserId: randomUUID().replaceAll('-', '') },
          });
          const membership = await transaction.adminMembership.create({
            data: { userId: user.id, role: 'OWNER' },
          });
          if (operation === 'delete') {
            await transaction.adminMembership.delete({
              where: { id: membership.id },
            });
          } else {
            await transaction.adminMembership.update({
              where: { id: membership.id },
              data: { role: 'AUDITOR' },
            });
          }
        }),
      ).rejects.toThrow(/last OWNER/);
    }
  });

  it('refuses concurrent removal of both remaining OWNER memberships', async () => {
    await withPreStageBSchema(async (prisma, databaseUrl) => {
      await runMigrateDeploy(databaseUrl, true);
      const left = new PrismaClient({ datasourceUrl: databaseUrl });
      const right = new PrismaClient({ datasourceUrl: databaseUrl });
      try {
        const suffix = randomUUID().replaceAll('-', '');
        const [firstUser, secondUser] = await prisma.$transaction([
          prisma.user.create({
            data: { telegramUserId: `oc1${suffix.slice(0, 26)}` },
          }),
          prisma.user.create({
            data: { telegramUserId: `oc2${suffix.slice(0, 26)}` },
          }),
        ]);
        const [firstMembership, secondMembership] = await prisma.$transaction([
          prisma.adminMembership.create({
            data: { userId: firstUser.id, role: 'OWNER' },
          }),
          prisma.adminMembership.create({
            data: { userId: secondUser.id, role: 'OWNER' },
          }),
        ]);

        const results = await Promise.allSettled([
          left.$transaction(
            async (transaction) => {
              await transaction.adminMembership.delete({
                where: { id: firstMembership.id },
              });
            },
            { maxWait: 15_000, timeout: 15_000 },
          ),
          right.$transaction(
            async (transaction) => {
              await transaction.adminMembership.update({
                where: { id: secondMembership.id },
                data: { role: 'AUDITOR' },
              });
            },
            { maxWait: 15_000, timeout: 15_000 },
          ),
        ]);

        expect(
          results.filter((result) => result.status === 'fulfilled').length,
        ).toBeLessThan(2);
        await expect(
          prisma.adminMembership.count({ where: { role: 'OWNER' } }),
        ).resolves.toBeGreaterThanOrEqual(1);
      } finally {
        await left.$disconnect();
        await right.$disconnect();
      }
    });
  }, 30_000);

  it('keeps at least one OWNER when a second membership is created during last-owner removal', async () => {
    await withPreStageBSchema(async (prisma, databaseUrl) => {
      await runMigrateDeploy(databaseUrl, true);
      const left = new PrismaClient({ datasourceUrl: databaseUrl });
      const right = new PrismaClient({ datasourceUrl: databaseUrl });
      try {
        const suffix = randomUUID().replaceAll('-', '');
        const [existingUser, incomingUser] = await prisma.$transaction([
          prisma.user.create({
            data: { telegramUserId: `ol1${suffix.slice(0, 26)}` },
          }),
          prisma.user.create({
            data: { telegramUserId: `ol2${suffix.slice(0, 26)}` },
          }),
        ]);
        const existingMembership = await prisma.adminMembership.create({
          data: { userId: existingUser.id, role: 'OWNER' },
        });

        await Promise.allSettled([
          left.$transaction(
            async (transaction) => {
              await transaction.adminMembership.create({
                data: { userId: incomingUser.id, role: 'OWNER' },
              });
            },
            { maxWait: 15_000, timeout: 15_000 },
          ),
          right.$transaction(
            async (transaction) => {
              await transaction.adminMembership.delete({
                where: { id: existingMembership.id },
              });
            },
            { maxWait: 15_000, timeout: 15_000 },
          ),
        ]);

        await expect(
          prisma.adminMembership.count({ where: { role: 'OWNER' } }),
        ).resolves.toBeGreaterThanOrEqual(1);
      } finally {
        await left.$disconnect();
        await right.$disconnect();
      }
    });
  }, 30_000);
});
