import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  readLocalHarnessDeviceId,
  readSubscriptionTokenFromUrlFile,
  resolveActiveDeviceFromSubscriptionUrlFile,
  resolveClosedTestSubscriptionUrlPath,
} from './vpn-node-device-source';

const token = 'd'.repeat(43);

describe('vpn-node device source', () => {
  it('extracts the token from a single subscription URL file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vpn-device-source-'));
    const path = join(directory, 'subscription.url');
    await writeFile(
      path,
      `https://subscriptions.example.test/sub/${token}\n`,
      'utf8',
    );

    await expect(readSubscriptionTokenFromUrlFile(path)).resolves.toBe(token);
  });

  it('rejects credentials, query, fragment, and malformed URLs without echoing them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vpn-device-source-'));
    const path = join(directory, 'subscription.url');
    await writeFile(
      path,
      `https://user:secret@subscriptions.example.test/sub/${token}\n`,
      'utf8',
    );

    try {
      await readSubscriptionTokenFromUrlFile(path);
      throw new Error('expected the subscription URL file to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/must not contain credentials/);
      expect((error as Error).message).not.toMatch(/secret|user:/);
    }
  });

  it('refuses the local harness device even when the subscription token is valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vpn-device-source-root-'));
    await mkdir(join(root, 'var', 'vpn-nl-01'), { recursive: true });
    await mkdir(join(root, 'var', 'xray-local'), { recursive: true });
    await writeFile(
      join(root, 'var', 'vpn-nl-01', 'replacement-subscription-url.txt'),
      `https://subscriptions.example.test/sub/${token}\n`,
      'utf8',
    );
    await writeFile(
      join(root, 'var', 'xray-local', 'harness.json'),
      `${JSON.stringify({ deviceId: '11111111-1111-4111-8111-111111111111' })}\n`,
      'utf8',
    );
    const access = {
      resolveAuthorizedDevice: vi.fn().mockResolvedValue({
        deviceId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
      }),
    };

    await expect(
      resolveActiveDeviceFromSubscriptionUrlFile({
        root,
        access: access as never,
      }),
    ).rejects.toThrow(/refuses the revoked local harness device/);
    expect(access.resolveAuthorizedDevice).toHaveBeenCalledWith(token);
  });

  it('resolves an ACTIVE replacement device and ignores a different harness device', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vpn-device-source-root-'));
    await mkdir(join(root, 'var', 'vpn-nl-01'), { recursive: true });
    await mkdir(join(root, 'var', 'xray-local'), { recursive: true });
    await writeFile(
      join(root, 'var', 'vpn-nl-01', 'replacement-subscription-url.txt'),
      `https://subscriptions.example.test/sub/${token}\n`,
      'utf8',
    );
    await writeFile(
      join(root, 'var', 'xray-local', 'harness.json'),
      `${JSON.stringify({ deviceId: '11111111-1111-4111-8111-111111111111' })}\n`,
      'utf8',
    );
    const access = {
      resolveAuthorizedDevice: vi.fn().mockResolvedValue({
        deviceId: '33333333-3333-4333-8333-333333333333',
        userId: '44444444-4444-4444-8444-444444444444',
      }),
    };

    await expect(
      resolveActiveDeviceFromSubscriptionUrlFile({
        root,
        access: access as never,
      }),
    ).resolves.toEqual({
      deviceId: '33333333-3333-4333-8333-333333333333',
      userId: '44444444-4444-4444-8444-444444444444',
    });
    await expect(readLocalHarnessDeviceId(root)).resolves.toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(
      resolveClosedTestSubscriptionUrlPath(root, {
        VPN_CLOSED_TEST_SUBSCRIPTION_URL_FILE: 'custom.url',
      }),
    ).toBe(join(root, 'custom.url'));
  });
});
