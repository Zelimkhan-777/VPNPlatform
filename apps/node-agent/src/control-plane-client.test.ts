import { describe, expect, it, vi } from 'vitest';

import { HttpNodeAgentControlPlane } from './control-plane-client';

describe('HttpNodeAgentControlPlane', () => {
  it('uses bearer auth and validates configuration before returning it', async () => {
    const snapshot = {
      desiredConfigVersion: 0,
      appliedConfigVersion: 0,
      pendingAcknowledgement: null,
      grants: [],
      routes: [],
    };
    const fetchImplementation = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const client = new HttpNodeAgentControlPlane(
      'http://127.0.0.1:3001',
      'a'.repeat(43),
      1_000,
      fetchImplementation,
    );

    await expect(client.configuration()).resolves.toEqual(snapshot);
    const [url, init] = fetchImplementation.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.toString()).toBe(
      'http://127.0.0.1:3001/node-agent/v1/configuration',
    );
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Bearer ${'a'.repeat(43)}`,
    );
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
  });

  it('posts the exact acknowledgement and rejects invalid snapshots', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ desiredConfigVersion: 1 }), {
          status: 200,
        }),
      );
    const client = new HttpNodeAgentControlPlane(
      'https://control.example.test',
      'b'.repeat(43),
      1_000,
      fetchImplementation,
    );
    const acknowledgement = {
      nodeSyncJobId: '22222222-2222-4222-8222-222222222222',
      targetVersion: 1,
      snapshotHash: 'a'.repeat(64),
    };

    await expect(client.acknowledge(acknowledgement)).resolves.toBeUndefined();
    const [, acknowledgementRequest] = fetchImplementation.mock.calls[0]!;
    expect(acknowledgementRequest?.body).toBe(JSON.stringify(acknowledgement));
    await expect(client.configuration()).rejects.toThrow();
  });
});
