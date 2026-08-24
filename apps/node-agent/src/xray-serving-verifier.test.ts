import { describe, expect, it, vi } from 'vitest';

import { DockerXrayServingVerifier } from './xray-serving-verifier';

const credential = '66666666-6666-4666-8666-666666666666';
const grantId = '55555555-5555-4555-8555-555555555555';
const otherCredential = '77777777-7777-4777-8777-777777777777';
const otherGrantId = '88888888-8888-4888-8888-888888888888';

describe('DockerXrayServingVerifier', () => {
  it('reads the active Xray users from the container-local API', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'xray-container\n' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          users: [
            {
              email: otherGrantId,
              account: {
                _TypedMessage_: 'xray.proxy.vless.Account',
                id: otherCredential,
              },
            },
            {
              email: grantId,
              account: {
                _TypedMessage_: 'xray.proxy.vless.Account',
                id: credential,
              },
            },
          ],
        }),
      });
    const verifier = new DockerXrayServingVerifier('vless-tcp-tls', {
      attempts: 1,
      executeCommand,
    });

    await expect(
      verifier.verifyClients([
        { grantId, credential },
        { grantId: otherGrantId, credential: otherCredential },
      ]),
    ).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenNthCalledWith(1, 'docker', [
      'ps',
      '--filter',
      'label=com.docker.compose.project=vpn-platform-vpn-node',
      '--filter',
      'label=com.docker.compose.service=xray',
      '--filter',
      'status=running',
      '--format',
      '{{.ID}}',
    ]);
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'docker', [
      'exec',
      'xray-container',
      'xray',
      'api',
      'inbounduser',
      '--server=127.0.0.1:10085',
      '--tag=vless-tcp-tls',
    ]);
  });

  it('retries an old serving state and succeeds only after it converges', async () => {
    const oldState = JSON.stringify({ users: [] });
    const expectedState = JSON.stringify({
      users: [
        {
          email: grantId,
          account: {
            _TypedMessage_: 'xray.proxy.vless.Account',
            id: credential,
          },
        },
      ],
    });
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'xray-container\n' })
      .mockResolvedValueOnce({ stdout: oldState })
      .mockResolvedValueOnce({ stdout: 'xray-container\n' })
      .mockResolvedValueOnce({ stdout: expectedState });
    const delay = vi.fn(async () => undefined);
    const verifier = new DockerXrayServingVerifier('vless-tcp-tls', {
      attempts: 2,
      retryDelayMs: 10,
      executeCommand,
      delay,
    });

    await expect(
      verifier.verifyClients([{ grantId, credential }]),
    ).resolves.toBeUndefined();
    expect(delay).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledWith(10);
  });

  it('accepts an omitted protobuf users field as an empty access list', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'xray-container\n' })
      .mockResolvedValueOnce({ stdout: '{}' });
    const verifier = new DockerXrayServingVerifier('vless-tcp-tls', {
      attempts: 1,
      executeCommand,
    });

    await expect(verifier.verifyClients([])).resolves.toBeUndefined();
  });

  it('rejects a persistent mismatch without exposing client identifiers', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'xray-container\n' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          users: [
            {
              email: otherGrantId,
              account: { id: otherCredential },
            },
          ],
        }),
      });
    const verifier = new DockerXrayServingVerifier('vless-tcp-tls', {
      attempts: 1,
      executeCommand,
    });

    const failure = await verifier
      .verifyClients([{ grantId, credential }])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      'serving state does not match',
    );
    expect((failure as Error).message).not.toContain(grantId);
    expect((failure as Error).message).not.toContain(credential);
    expect((failure as Error).message).not.toContain(otherGrantId);
    expect((failure as Error).message).not.toContain(otherCredential);
  });

  it('sanitizes failures returned by the command executor', async () => {
    const executeCommand = vi.fn(async () => {
      throw new Error(`command failed while handling ${credential}`);
    });
    const verifier = new DockerXrayServingVerifier('vless-tcp-tls', {
      attempts: 1,
      executeCommand,
    });

    const failure = await verifier
      .verifyClients([{ grantId, credential }])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('serving probe failed');
    expect((failure as Error).message).not.toContain(grantId);
    expect((failure as Error).message).not.toContain(credential);
  });
});
