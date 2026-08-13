import { describe, expect, it, vi } from 'vitest';

import {
  isolatedIntegrationDatabaseUrl,
  withIsolatedIntegrationSchema,
} from './integration-schema';

const databaseUrl =
  'postgresql://vpn_platform:test@127.0.0.1:5432/vpn_platform?schema=public';
const schemaName = 'api_integration_11111111111141118111111111111111';

describe('API integration database isolation', () => {
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
});
