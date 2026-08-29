import { describe, expect, it, vi } from 'vitest';

import {
  isolatedWorkerDatabaseUrl,
  withIsolatedWorkerIntegrationEnvironment,
} from './integration-environment';
import {
  workerIntegrationScenarioCount,
  workerIntegrationSuites,
} from './integration-suite-manifest';

const databaseUrl =
  'postgresql://vpn_platform:test@127.0.0.1:5432/vpn_platform?schema=public';
const schemaName = 'worker_integration_11111111111141118111111111111111';
const namespace = 'worker-integration-11111111111141118111111111111111';

describe('worker integration environment isolation', () => {
  it('keeps every integration scenario in an independently runnable suite', () => {
    expect(workerIntegrationScenarioCount).toBe(21);
    expect(workerIntegrationSuites).toEqual([
      {
        name: 'outbox-publisher',
        file: 'src/outbox-publisher.integration.test.ts',
        scenarioCount: 3,
      },
      {
        name: 'node-sync-processor',
        file: 'src/node-sync-processor.integration.test.ts',
        scenarioCount: 7,
      },
      {
        name: 'subscription-access-maintenance',
        file: 'src/subscription-access-maintenance.integration.test.ts',
        scenarioCount: 11,
      },
    ]);
  });

  it('changes only the PostgreSQL schema', () => {
    const isolated = new URL(
      isolatedWorkerDatabaseUrl(databaseUrl, schemaName),
    );
    expect(isolated.searchParams.get('schema')).toBe(schemaName);
    expect(isolated.pathname).toBe('/vpn_platform');
  });

  it('cleans Redis and drops the schema after an intentionally failing suite', async () => {
    const execute = vi.fn().mockResolvedValue(0);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const cleanupRedis = vi.fn().mockResolvedValue(undefined);
    const failure = new Error('intentional suite failure');

    await expect(
      withIsolatedWorkerIntegrationEnvironment(
        databaseUrl,
        'redis://127.0.0.1:6379',
        () => Promise.reject(failure),
        schemaName,
        namespace,
        () =>
          ({ $executeRawUnsafe: execute, $disconnect: disconnect }) as never,
        cleanupRedis,
      ),
    ).rejects.toBe(failure);

    expect(cleanupRedis).toHaveBeenCalledWith(
      'redis://127.0.0.1:6379',
      namespace,
    );
    expect(execute.mock.calls).toEqual([
      [`CREATE SCHEMA "${schemaName}"`],
      [`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`],
    ]);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
