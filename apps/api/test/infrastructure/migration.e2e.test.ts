import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { createInfrastructureTestApp } from './fixture';

const migrationPath = resolve(
  process.cwd(),
  '../../prisma/migrations/20260829120000_drop_legacy_node_endpoint/migration.sql',
);

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
});
