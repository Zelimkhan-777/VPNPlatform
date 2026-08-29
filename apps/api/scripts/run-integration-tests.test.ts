import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  isolatedIntegrationDatabaseUrl,
  withIsolatedApiIntegrationEnvironment,
  withIsolatedIntegrationSchema,
} from './integration-schema';
import {
  apiIntegrationScenarioCount,
  apiIntegrationSuites,
} from './integration-suite-manifest';

const databaseUrl =
  'postgresql://vpn_platform:test@127.0.0.1:5432/vpn_platform?schema=public';
const schemaName = 'api_integration_11111111111141118111111111111111';

describe('API integration database isolation', () => {
  it('keeps every infrastructure scenario in an independently runnable suite', async () => {
    expect(apiIntegrationScenarioCount).toBe(46);
    expect(apiIntegrationSuites.map((suite) => suite.name)).toEqual([
      'auth',
      'orchestration',
      'cabinet',
      'feed',
      'migration',
    ]);

    for (const suite of apiIntegrationSuites) {
      const source = await readFile(resolve(process.cwd(), suite.file), 'utf8');
      const scenarioCount = source.match(/^\s*it\(/gm)?.length ?? 0;
      expect(scenarioCount, suite.name).toBe(suite.scenarioCount);
      expect(source).toContain('createInfrastructureTestApp');
      expect(source).toContain(`describe('infrastructure ${suite.name}'`);
    }
  });

  it('replaces only the PostgreSQL schema in the test URL', () => {
    const isolated = new URL(
      isolatedIntegrationDatabaseUrl(databaseUrl, schemaName),
    );
    expect(isolated.searchParams.get('schema')).toBe(schemaName);
    expect(isolated.pathname).toBe('/vpn_platform');
  });

  it('drops the disposable schema and disconnects even when the suite fails', async () => {
    const execute = vi.fn().mockResolvedValue(0);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const failure = new Error('suite failed');

    await expect(
      withIsolatedIntegrationSchema(
        databaseUrl,
        () => Promise.reject(failure),
        schemaName,
        () =>
          ({
            $executeRawUnsafe: execute,
            $disconnect: disconnect,
          }) as never,
      ),
    ).rejects.toBe(failure);

    expect(execute.mock.calls).toEqual([
      [`CREATE SCHEMA "${schemaName}"`],
      [`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`],
    ]);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('cleans only the selected Redis namespace after a failed suite', async () => {
    const execute = vi.fn().mockResolvedValue(0);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const cleanupRedis = vi.fn().mockResolvedValue(undefined);
    const failure = new Error('suite failed');
    const namespace = 'api-integration-11111111111141118111111111111111';

    await expect(
      withIsolatedApiIntegrationEnvironment(
        databaseUrl,
        'redis://127.0.0.1:6379',
        () => Promise.reject(failure),
        schemaName,
        namespace,
        () =>
          ({
            $executeRawUnsafe: execute,
            $disconnect: disconnect,
          }) as never,
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
  });

  it('generates a different PostgreSQL schema and Redis namespace per suite', async () => {
    const schemas: string[] = [];
    const namespaces: string[] = [];
    const cleanupRedis = vi.fn().mockResolvedValue(undefined);
    const createAdministrator = () =>
      ({
        $executeRawUnsafe: vi.fn(async (statement: string) => {
          const match = statement.match(/^CREATE SCHEMA "([^"]+)"$/);
          if (match?.[1]) schemas.push(match[1]);
          return 0;
        }),
        $disconnect: vi.fn().mockResolvedValue(undefined),
      }) as never;

    for (let index = 0; index < 2; index += 1) {
      await withIsolatedApiIntegrationEnvironment(
        databaseUrl,
        'redis://127.0.0.1:6379',
        (_isolatedUrl, namespace) => {
          namespaces.push(namespace);
          return Promise.resolve();
        },
        undefined,
        undefined,
        createAdministrator,
        cleanupRedis,
      );
    }

    expect(schemas).toHaveLength(2);
    expect(new Set(schemas).size).toBe(2);
    expect(schemas).toEqual([
      expect.stringMatching(/^api_integration_[a-f0-9]{32}$/),
      expect.stringMatching(/^api_integration_[a-f0-9]{32}$/),
    ]);
    expect(namespaces).toHaveLength(2);
    expect(new Set(namespaces).size).toBe(2);
    expect(namespaces).toEqual([
      expect.stringMatching(/^api-integration-[a-f0-9]{32}$/),
      expect.stringMatching(/^api-integration-[a-f0-9]{32}$/),
    ]);
    expect(cleanupRedis).toHaveBeenCalledTimes(2);
  });
});
