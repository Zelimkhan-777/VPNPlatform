import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

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
