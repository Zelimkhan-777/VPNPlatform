import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

type SchemaAdministrator = Pick<
  PrismaClient,
  '$executeRawUnsafe' | '$disconnect'
>;

export function isolatedIntegrationDatabaseUrl(
  databaseUrl: string,
  schemaName: string,
): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schemaName);
  return url.toString();
}

export async function withIsolatedIntegrationSchema(
  databaseUrl: string,
  runTests: (isolatedDatabaseUrl: string) => Promise<void>,
  schemaName = `api_integration_${randomUUID().replaceAll('-', '')}`,
  createAdministrator: (databaseUrl: string) => SchemaAdministrator = (url) =>
    new PrismaClient({
      datasources: { db: { url } },
      log: [],
    }),
): Promise<void> {
  if (!/^api_integration_[a-f0-9]{32}$/.test(schemaName)) {
    throw new Error('Integration schema name is invalid');
  }
  const administrator = createAdministrator(databaseUrl);
  let schemaCreated = false;
  try {
    await administrator.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;
    await runTests(isolatedIntegrationDatabaseUrl(databaseUrl, schemaName));
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

export async function apiRedisNamespaceKeys(
  redisUrl: string,
  namespace: string,
): Promise<string[]> {
  assertApiRedisNamespace(namespace);
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redis.on('error', () => undefined);
  const found: string[] = [];
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${namespace}:*`,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      found.push(...keys);
    } while (cursor !== '0');
    return found;
  } finally {
    redis.disconnect();
  }
}

export async function removeApiRedisNamespace(
  redisUrl: string,
  namespace: string,
): Promise<void> {
  const keys = await apiRedisNamespaceKeys(redisUrl, namespace);
  if (keys.length === 0) return;
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    await redis.unlink(...keys);
  } finally {
    redis.disconnect();
  }
}

export async function withIsolatedApiIntegrationEnvironment(
  databaseUrl: string,
  redisUrl: string,
  runTests: (
    isolatedDatabaseUrl: string,
    redisNamespace: string,
  ) => Promise<void>,
  schemaName = `api_integration_${randomUUID().replaceAll('-', '')}`,
  redisNamespace = `api-integration-${randomUUID().replaceAll('-', '')}`,
  createAdministrator: (databaseUrl: string) => SchemaAdministrator = (url) =>
    new PrismaClient({
      datasources: { db: { url } },
      log: [],
    }),
  cleanupRedis: (
    redisUrl: string,
    namespace: string,
  ) => Promise<void> = removeApiRedisNamespace,
): Promise<void> {
  assertApiRedisNamespace(redisNamespace);
  try {
    await withIsolatedIntegrationSchema(
      databaseUrl,
      (isolatedUrl) => runTests(isolatedUrl, redisNamespace),
      schemaName,
      createAdministrator,
    );
  } finally {
    await cleanupRedis(redisUrl, redisNamespace);
  }
}

function assertApiRedisNamespace(namespace: string): void {
  if (!/^api-integration-[a-f0-9]{32}$/.test(namespace)) {
    throw new Error('API integration Redis namespace is invalid');
  }
}
