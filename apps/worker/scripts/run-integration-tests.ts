import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';

import { redisConnection } from '../src/main';
import { withIsolatedWorkerIntegrationEnvironment } from './integration-environment';

function runCommand(
  executable: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  stdio: 'inherit' | 'ignore' = 'inherit',
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `Integration command failed (${signal ?? String(code ?? 'unknown')})`,
          ),
        );
    });
  });
}

async function migrate(
  isolatedUrl: string,
  prismaCli: string,
  prismaSchema: string,
): Promise<void> {
  await runCommand(
    process.execPath,
    [prismaCli, 'migrate', 'deploy', '--schema', prismaSchema],
    { ...process.env, DATABASE_URL: isolatedUrl },
  );
}

async function publicCounts(prisma: PrismaClient): Promise<readonly number[]> {
  return Promise.all([
    prisma.outboxEvent.count(),
    prisma.nodeSyncJob.count(),
    prisma.auditEvent.count(),
    prisma.nodeConfigAcknowledgement.count(),
  ]);
}

async function assertSchemaRemoved(
  prisma: PrismaClient,
  schemaName: string,
): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ schema_name: string }[]>(
    'SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1',
    schemaName,
  );
  assert.equal(
    rows.length,
    0,
    `temporary schema ${schemaName} was not removed`,
  );
}

async function main(): Promise<void> {
  const { DATABASE_URL: databaseUrl, REDIS_URL: redisUrl } = process.env;
  if (!databaseUrl)
    throw new Error('DATABASE_URL is required for integration tests');
  if (!redisUrl) throw new Error('REDIS_URL is required for integration tests');
  const prismaCli = resolve(
    process.cwd(),
    '../../node_modules/prisma/build/index.js',
  );
  const vitestCli = resolve(process.cwd(), 'node_modules/vitest/vitest.mjs');
  const prismaSchema = resolve(process.cwd(), '../../prisma/schema.prisma');
  const publicPrisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const foreignQueue = new Queue(`worker-integration-foreign-${randomUUID()}`, {
    connection: redisConnection(redisUrl),
  });
  const foreignJobId = randomUUID();
  const baseline = await publicCounts(publicPrisma);

  try {
    await foreignQueue.add(
      'foreign.sentinel',
      { sentinel: true },
      {
        jobId: foreignJobId,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    const failureId = randomUUID().replaceAll('-', '');
    const failureSchema = `worker_integration_${failureId}`;
    const failureNamespace = `worker-integration-${failureId}`;
    const intentionalFailure = new Error(
      'intentional isolated worker suite failure',
    );
    await assert.rejects(
      withIsolatedWorkerIntegrationEnvironment(
        databaseUrl,
        redisUrl,
        async (isolatedUrl, namespace) => {
          await migrate(isolatedUrl, prismaCli, prismaSchema);
          const isolatedPrisma = new PrismaClient({
            datasourceUrl: isolatedUrl,
          });
          const isolatedQueue = new Queue(`${namespace}-failure`, {
            connection: redisConnection(redisUrl),
          });
          try {
            await isolatedPrisma.auditEvent.create({
              data: {
                action: 'worker.integration.intentional-failure',
                entityType: 'IntegrationSuite',
                entityId: randomUUID(),
              },
            });
            await isolatedQueue.add('test.failure', { isolated: true });
          } finally {
            await Promise.all([
              isolatedQueue.close(),
              isolatedPrisma.$disconnect(),
            ]);
          }
          throw intentionalFailure;
        },
        failureSchema,
        failureNamespace,
      ),
      intentionalFailure,
    );
    assert.deepEqual(await publicCounts(publicPrisma), baseline);
    await assertSchemaRemoved(publicPrisma, failureSchema);
    assert.ok(await foreignQueue.getJob(foreignJobId));

    const successId = randomUUID().replaceAll('-', '');
    const successSchema = `worker_integration_${successId}`;
    const successNamespace = `worker-integration-${successId}`;
    await withIsolatedWorkerIntegrationEnvironment(
      databaseUrl,
      redisUrl,
      async (isolatedUrl, namespace) => {
        await migrate(isolatedUrl, prismaCli, prismaSchema);
        await runCommand(
          process.execPath,
          [
            vitestCli,
            'run',
            'src/outbox-publisher.integration.test.ts',
            'src/node-sync-processor.integration.test.ts',
          ],
          {
            ...process.env,
            DATABASE_URL: isolatedUrl,
            WORKER_TEST_REDIS_NAMESPACE: namespace,
          },
        );
      },
      successSchema,
      successNamespace,
    );
    assert.deepEqual(await publicCounts(publicPrisma), baseline);
    await assertSchemaRemoved(publicPrisma, successSchema);
    assert.ok(await foreignQueue.getJob(foreignJobId));
  } finally {
    await foreignQueue.obliterate({ force: true }).catch(() => undefined);
    await Promise.all([foreignQueue.close(), publicPrisma.$disconnect()]);
  }
}

void main();
