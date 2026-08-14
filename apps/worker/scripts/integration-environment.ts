import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { RedisConnection, type ConnectionOptions } from 'bullmq';

type SchemaAdministrator = Pick<
  PrismaClient,
  '$executeRawUnsafe' | '$disconnect'
>;

export function isolatedWorkerDatabaseUrl(
  databaseUrl: string,
  schemaName: string,
): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schemaName);
  return url.toString();
}

export async function removeRedisNamespace(
  redisUrl: string,
  namespace: string,
): Promise<void> {
  if (!/^worker-integration-[a-f0-9]{32}$/.test(namespace)) {
    throw new Error('Worker integration Redis namespace is invalid');
  }
  const connection = new RedisConnection(redisOptions(redisUrl));
  connection.on('error', () => undefined);
  try {
    const redis = (await connection.client) as unknown as {
      scan(
        cursor: string,
        ...arguments_: string[]
      ): Promise<[string, string[]]>;
      unlink(...keys: string[]): Promise<number>;
    };
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        `bull:${namespace}-*`,
        'COUNT',
        '100',
      );
      cursor = nextCursor;
      if (keys.length > 0) await redis.unlink(...keys);
    } while (cursor !== '0');
  } finally {
    await connection.close();
  }
}

function redisOptions(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use the redis or rediss protocol');
  }
  const database = url.pathname === '/' ? '' : url.pathname.slice(1);
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(database ? { db: Number.parseInt(database, 10) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export async function withIsolatedWorkerIntegrationEnvironment(
  databaseUrl: string,
  redisUrl: string,
  runSuite: (
    isolatedDatabaseUrl: string,
    redisNamespace: string,
  ) => Promise<void>,
  schemaName = `worker_integration_${randomUUID().replaceAll('-', '')}`,
  redisNamespace = `worker-integration-${randomUUID().replaceAll('-', '')}`,
  createAdministrator: (databaseUrl: string) => SchemaAdministrator = (url) =>
    new PrismaClient({ datasources: { db: { url } }, log: [] }),
  cleanupRedis: (
    redisUrl: string,
    namespace: string,
  ) => Promise<void> = removeRedisNamespace,
): Promise<void> {
  if (!/^worker_integration_[a-f0-9]{32}$/.test(schemaName)) {
    throw new Error('Worker integration schema name is invalid');
  }
  if (!/^worker-integration-[a-f0-9]{32}$/.test(redisNamespace)) {
    throw new Error('Worker integration Redis namespace is invalid');
  }
  const administrator = createAdministrator(databaseUrl);
  let schemaCreated = false;
  try {
    await administrator.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;
    await runSuite(
      isolatedWorkerDatabaseUrl(databaseUrl, schemaName),
      redisNamespace,
    );
  } finally {
    try {
      await cleanupRedis(redisUrl, redisNamespace);
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
}
