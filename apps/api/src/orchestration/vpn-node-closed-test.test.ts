import { describe, expect, it, vi } from 'vitest';

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VPN_PL_BOOTSTRAP_DEFINITION } from './vpn-node-bootstrap';
import {
  attachCurrentDeviceToVpnNode,
  extractSubscriptionFeedDisplayLabels,
  inspectClosedTestSubscriptionFeed,
} from './vpn-node-closed-test';

const token = 'e'.repeat(43);
const currentDeviceId = '33333333-3333-4333-8333-333333333333';

describe('vpn-node closed-test helpers', () => {
  it('extracts only display labels from a subscription feed', () => {
    const feed = [
      'vless://11111111-1111-4111-8111-111111111111@192.0.2.10:443?encryption=none&security=tls&type=tcp&sni=nl.example.test#Netherlands',
      'vless://22222222-2222-4222-8222-222222222222@192.0.2.20:443?encryption=none&security=tls&type=tcp&sni=pl.example.test#Poland',
    ].join('\n');

    expect(extractSubscriptionFeedDisplayLabels(feed)).toEqual([
      'Netherlands',
      'Poland',
    ]);
    expect(
      JSON.stringify(extractSubscriptionFeedDisplayLabels(feed)),
    ).not.toMatch(/192\.0\.2|11111111|vless:\/\//);
  });

  it('inspects a subscription feed without returning the URL or URIs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vpn-closed-test-'));
    await mkdir(join(root, 'var', 'vpn-nl-01'), { recursive: true });
    await writeFile(
      join(root, 'var', 'vpn-nl-01', 'replacement-subscription-url.txt'),
      `https://subscriptions.example.test/sub/${token}\n`,
      'utf8',
    );
    const access = {
      resolveAuthorizedDevice: vi.fn().mockResolvedValue({
        deviceId: currentDeviceId,
        userId: '44444444-4444-4444-8444-444444444444',
      }),
    };
    const evidence = await inspectClosedTestSubscriptionFeed({
      root,
      access: access as never,
      fetchFeed: async () => ({
        status: 200,
        body: 'vless://11111111-1111-4111-8111-111111111111@192.0.2.10:443?encryption=none&security=tls&type=tcp&sni=nl.example.test#Netherlands',
      }),
    });

    expect(evidence).toEqual({
      httpStatus: 200,
      routeCount: 1,
      displayLabels: ['Netherlands'],
    });
    expect(JSON.stringify(evidence)).not.toMatch(
      /subscriptions\.example|vless:\/\//,
    );
  });

  it('attaches the current device and does not complete sync jobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vpn-closed-test-'));
    await mkdir(join(root, 'var', 'vpn-nl-01'), { recursive: true });
    await writeFile(
      join(root, 'var', 'vpn-nl-01', 'replacement-subscription-url.txt'),
      `https://subscriptions.example.test/sub/${token}\n`,
      'utf8',
    );
    const prisma = {
      node: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'node-1',
          name: 'vpn-pl-1',
          status: 'HEALTHY',
          endpoints: [{ id: 'endpoint-1' }],
          connectionProfiles: [{ id: 'profile-1', version: 1 }],
        }),
      },
    };
    const orchestration = {
      scheduleNodeAccessGrant: vi.fn().mockResolvedValue({
        nodeSyncJobId: 'grant-job',
      }),
      publishConnectionRoute: vi.fn().mockResolvedValue({
        nodeSyncJobId: 'route-job',
      }),
    };
    const access = {
      resolveAuthorizedDevice: vi.fn().mockResolvedValue({
        deviceId: currentDeviceId,
        userId: '44444444-4444-4444-8444-444444444444',
      }),
    };

    await expect(
      attachCurrentDeviceToVpnNode({
        root,
        prisma: prisma as never,
        orchestration: orchestration as never,
        access: access as never,
        definition: VPN_PL_BOOTSTRAP_DEFINITION,
      }),
    ).resolves.toEqual({
      nodeName: 'vpn-pl-1',
      grantCreated: true,
      routePublished: true,
    });
    expect(orchestration.scheduleNodeAccessGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'node-1',
        deviceId: currentDeviceId,
      }),
    );
    expect(orchestration).not.toHaveProperty('acknowledgeNodeConfig');
  });

  it('refuses attach when the node is not HEALTHY', async () => {
    const prisma = {
      node: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'node-1',
          name: 'vpn-pl-1',
          status: 'DISABLED',
          endpoints: [{ id: 'endpoint-1' }],
          connectionProfiles: [{ id: 'profile-1', version: 1 }],
        }),
      },
    };

    await expect(
      attachCurrentDeviceToVpnNode({
        root: '/unused',
        prisma: prisma as never,
        orchestration: {} as never,
        access: {} as never,
        definition: VPN_PL_BOOTSTRAP_DEFINITION,
      }),
    ).rejects.toThrow(/must be HEALTHY/);
  });
});
