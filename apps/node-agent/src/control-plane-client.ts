import {
  nodeAgentConfigurationSnapshotSchema,
  type NodeAgentAcknowledgement,
  type NodeAgentConfigurationSnapshot,
} from '@vpn-platform/contracts';

export interface NodeAgentControlPlane {
  heartbeat(): Promise<void>;
  configuration(): Promise<NodeAgentConfigurationSnapshot>;
  acknowledge(acknowledgement: NodeAgentAcknowledgement): Promise<void>;
}

export class HttpNodeAgentControlPlane implements NodeAgentControlPlane {
  constructor(
    private readonly baseUrl: string,
    private readonly credential: string,
    private readonly timeoutMs: number,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async heartbeat(): Promise<void> {
    const response = await this.request('heartbeats', { method: 'POST' });
    if (response.status !== 204)
      throw new ControlPlaneRequestError(response.status);
  }

  async configuration(): Promise<NodeAgentConfigurationSnapshot> {
    const response = await this.request('configuration', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (response.status !== 200)
      throw new ControlPlaneRequestError(response.status);
    return nodeAgentConfigurationSnapshotSchema.parse(await response.json());
  }

  async acknowledge(acknowledgement: NodeAgentAcknowledgement): Promise<void> {
    const response = await this.request('acknowledgements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(acknowledgement),
    });
    if (response.status !== 204)
      throw new ControlPlaneRequestError(response.status);
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.credential}`);
    return this.fetchImplementation(
      new URL(`/node-agent/v1/${path}`, this.baseUrl),
      {
        ...init,
        headers,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
  }
}

export class ControlPlaneRequestError extends Error {
  constructor(readonly status: number) {
    super('Node-agent control-plane request failed');
  }
}
