import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

import {
  apiRedisNamespaceKeys,
  withIsolatedApiIntegrationEnvironment,
} from './integration-schema';
import { apiIntegrationSuites } from './integration-suite-manifest';

type CommandRunner = (
  executable: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  stdio?: 'inherit' | 'ignore',
) => Promise<void>;

const runCommand: CommandRunner = (
  executable,
  arguments_,
  environment,
  stdio = 'inherit',
) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `Integration command failed (${signal ?? String(code ?? 'unknown')})`,
        ),
      );
    });
  });

async function migrate(
  isolatedUrl: string,
  prismaCli: string,
  prismaSchema: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await runCommand(
    process.execPath,
    [prismaCli, 'migrate', 'deploy', '--schema', prismaSchema],
    { ...environment, DATABASE_URL: isolatedUrl },
  );
}

async function publicCounts(prisma: PrismaClient): Promise<readonly number[]> {
  return Promise.all([
    prisma.auditEvent.count(),
    prisma.nodeSyncJob.count(),
    prisma.outboxEvent.count(),
    prisma.nodeConfigAcknowledgement.count(),
  ]);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for integration tests');
  }
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required for integration tests');
  }
  const prismaCli = resolve(
    process.cwd(),
    '../../node_modules/prisma/build/index.js',
  );
  const vitestCli = resolve(process.cwd(), 'node_modules/vitest/vitest.mjs');
  const prismaSchema = resolve(process.cwd(), '../../prisma/schema.prisma');
  const publicPrisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redis.on('error', () => undefined);
  const foreignKey = `api-integration-foreign-${randomUUID()}`;
  const baseline = await publicCounts(publicPrisma);

  try {
    await redis.connect();
    await redis.set(foreignKey, 'preserve-me');

    for (const suite of apiIntegrationSuites) {
      let suiteNamespace = '';
      await withIsolatedApiIntegrationEnvironment(
        databaseUrl,
        redisUrl,
        async (isolatedUrl, namespace) => {
          suiteNamespace = namespace;
          const environment = {
            ...process.env,
            DATABASE_URL: isolatedUrl,
            API_REDIS_KEY_NAMESPACE: namespace,
            DATA_PLANE_CREDENTIAL_PEPPER:
              'integration-tests-data-plane-credential-pepper-0001',
          };
          await migrate(isolatedUrl, prismaCli, prismaSchema, environment);
          await runCommand(
            process.execPath,
            [vitestCli, 'run', suite.file],
            environment,
          );
        },
      );
      assert.equal(await redis.get(foreignKey), 'preserve-me');
      assert.deepEqual(
        await apiRedisNamespaceKeys(redisUrl, suiteNamespace),
        [],
      );
      process.stdout.write(
        `API integration suite: name=${suite.name}, isolated=true\n`,
      );
    }

    let failureNamespace = '';
    await assert.rejects(
      withIsolatedApiIntegrationEnvironment(
        databaseUrl,
        redisUrl,
        async (isolatedUrl, namespace) => {
          failureNamespace = namespace;
          const environment = {
            ...process.env,
            DATABASE_URL: isolatedUrl,
            API_REDIS_KEY_NAMESPACE: namespace,
            API_INTEGRATION_EXPECT_FAILURE: 'true',
          };
          await migrate(isolatedUrl, prismaCli, prismaSchema, environment);
          await runCommand(
            process.execPath,
            [vitestCli, 'run', 'scripts/integration-cleanup-probe.test.ts'],
            environment,
            'ignore',
          );
        },
      ),
      /Integration command failed/,
    );
    assert.equal(await redis.get(foreignKey), 'preserve-me');
    assert.deepEqual(
      await apiRedisNamespaceKeys(redisUrl, failureNamespace),
      [],
    );
    assert.deepEqual(await publicCounts(publicPrisma), baseline);

    const leaks = await publicPrisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count
       FROM information_schema.schemata
       WHERE schema_name LIKE 'api_integration_%'`,
    );
    const leakCount = Number(leaks[0]?.count ?? 0);
    assert.equal(leakCount, 0);
    process.stdout.write(`API integration leakage: leaks=false, count=0\n`);
  } finally {
    await redis.del(foreignKey).catch(() => undefined);
    redis.disconnect();
    await publicPrisma.$disconnect();
  }
}

void main();
