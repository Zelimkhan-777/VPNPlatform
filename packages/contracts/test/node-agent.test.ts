import { describe, expect, it } from 'vitest';

import {
  nodeAgentConfigurationSnapshotSchema,
  nodeSyncRequestedEventSchema,
} from '../src';

describe('nodeSyncRequestedEventSchema', () => {
  const payload = {
    nodeAccessGrantId: '11111111-1111-4111-8111-111111111111',
    nodeSyncJobId: '22222222-2222-4222-8222-222222222222',
    targetVersion: 1,
  };

  it('accepts only the minimal node sync payload', () => {
    expect(nodeSyncRequestedEventSchema.parse(payload)).toEqual(payload);
    expect(() =>
      nodeSyncRequestedEventSchema.parse({
        ...payload,
        secret: 'must-not-cross-the-outbox-boundary',
      }),
    ).toThrow();
  });

  it('accepts a strict route activation payload', () => {
    const routePayload = {
      routeEndpointId: '33333333-3333-4333-8333-333333333333',
      routeConnectionProfileId: '44444444-4444-4444-8444-444444444444',
      nodeSyncJobId: '22222222-2222-4222-8222-222222222222',
      targetVersion: 2,
    };
    expect(nodeSyncRequestedEventSchema.parse(routePayload)).toEqual(
      routePayload,
    );
    expect(() =>
      nodeSyncRequestedEventSchema.parse({
        ...routePayload,
        nodeAccessGrantId: payload.nodeAccessGrantId,
      }),
    ).toThrow();
  });
});

describe('nodeAgentConfigurationSnapshotSchema', () => {
  const snapshot = {
    desiredConfigVersion: 2,
    appliedConfigVersion: 1,
    pendingAcknowledgement: {
      nodeSyncJobId: '22222222-2222-4222-8222-222222222222',
      targetVersion: 2,
      snapshotHash: 'a'.repeat(64),
    },
    grants: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'ACTIVE' as const,
        expiresAt: '2099-01-01T00:00:00.000Z',
        desiredVersion: 2,
        appliedVersion: 1,
        revokedAt: null,
        dataPlaneCredential: '33333333-3333-4333-8333-333333333333',
      },
    ],
    routes: [],
  };

  it('carries only the exact acknowledgement handle for the desired version', () => {
    expect(nodeAgentConfigurationSnapshotSchema.parse(snapshot)).toEqual(
      snapshot,
    );
    expect(() =>
      nodeAgentConfigurationSnapshotSchema.parse({
        ...snapshot,
        pendingAcknowledgement: {
          ...snapshot.pendingAcknowledgement,
          secret: 'must-not-cross-the-node-agent-boundary',
        },
      }),
    ).toThrow();
  });
});
