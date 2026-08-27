import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { SubscriptionFeedService } from './subscription-feed.service';

describe('SubscriptionFeedService', () => {
  const context = {
    userId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
  };
  const route = {
    endpointId: '33333333-3333-4333-8333-333333333333',
    endpointHost: 'route.example.test',
    endpointAddressKind: 'HOSTNAME' as const,
    endpointPort: 443,
    endpointPriority: 0,
    nodeId: '44444444-4444-4444-8444-444444444444',
    profileId: '55555555-5555-4555-8555-555555555555',
    profileKey: '66666666-6666-4666-8666-666666666666',
    profileVersion: 1,
    profilePriority: 0,
    protocolKind: 'VLESS' as const,
    transportKind: 'TCP' as const,
    securityKind: 'TLS' as const,
    clientCompatibility: 'HAPP' as const,
    tlsServerName: 'sni.example.test',
    displayName: 'Route',
    grantId: '77777777-7777-4777-8777-777777777777',
    dataPlaneCredentialHash: 'hash',
    dataPlaneCredentialDerivationVersion: 1,
  };
  const enabledEnvironment = {
    SUBSCRIPTION_FEED_RENDERING_ENABLED: true,
    SUBSCRIPTION_FEED_MAX_ROUTES: 1,
  };

  it('reports infrastructure unavailability after entitlement verification when rendering is disabled', async () => {
    const resolveAuthorizedDevice = vi
      .fn()
      .mockResolvedValue({ deviceId: 'device-id', userId: 'user-id' });
    const service = new SubscriptionFeedService(
      { resolveAuthorizedDevice } as never,
      {} as never,
      {} as never,
      { SUBSCRIPTION_FEED_RENDERING_ENABLED: false } as never,
    );

    await expect(service.feed('a'.repeat(43))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(resolveAuthorizedDevice).toHaveBeenCalledWith('a'.repeat(43));
  });

  it('reports infrastructure unavailability when entitlement has no ready route', async () => {
    const service = new SubscriptionFeedService(
      { resolveAuthorizedDevice: vi.fn().mockResolvedValue(context) } as never,
      { selectForAuthorizedDevice: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
      enabledEnvironment as never,
    );

    await expect(service.feed('a'.repeat(43))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rejects every denied token without returning a feed', async () => {
    const service = new SubscriptionFeedService(
      {
        resolveAuthorizedDevice: vi.fn().mockResolvedValue(null),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.feed('a'.repeat(43))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('renders two applied routes as separate URIs for the same token', async () => {
    const secondRoute = {
      ...route,
      endpointId: '88888888-8888-4888-8888-888888888888',
      nodeId: '99999999-9999-4999-8999-999999999999',
      grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      endpointHost: 'second.example.test',
      displayName: 'Second',
    };
    const service = new SubscriptionFeedService(
      { resolveAuthorizedDevice: vi.fn().mockResolvedValue(context) } as never,
      {
        selectForAuthorizedDevice: vi
          .fn()
          .mockResolvedValue([route, secondRoute]),
      } as never,
      {
        derive: vi
          .fn()
          .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
          .mockReturnValueOnce('22222222-2222-4222-8222-222222222222'),
        verifyHash: vi.fn().mockReturnValue(true),
      } as never,
      {
        SUBSCRIPTION_FEED_RENDERING_ENABLED: true,
        SUBSCRIPTION_FEED_MAX_ROUTES: 2,
      } as never,
    );

    await expect(service.feed('a'.repeat(43))).resolves.toBe(
      [
        'vless://11111111-1111-4111-8111-111111111111@route.example.test:443?encryption=none&security=tls&type=tcp&sni=sni.example.test#Route',
        'vless://22222222-2222-4222-8222-222222222222@second.example.test:443?encryption=none&security=tls&type=tcp&sni=sni.example.test#Second',
      ].join('\n'),
    );
  });

  it('rejects too many unique candidate mappings before credential derivation', async () => {
    const derive = vi.fn();
    const selectForAuthorizedDevice = vi
      .fn()
      .mockResolvedValue([
        route,
        { ...route, endpointId: '88888888-8888-4888-8888-888888888888' },
      ]);
    const service = new SubscriptionFeedService(
      { resolveAuthorizedDevice: vi.fn().mockResolvedValue(context) } as never,
      { selectForAuthorizedDevice } as never,
      { derive } as never,
      enabledEnvironment as never,
    );

    await expect(service.feed('a'.repeat(43))).rejects.toEqual(
      new ServiceUnavailableException('Subscription feed is unavailable'),
    );
    expect(selectForAuthorizedDevice).toHaveBeenCalledWith({
      ...context,
      limit: 1,
    });
    expect(derive).not.toHaveBeenCalled();
  });

  it('counts duplicate candidate mappings before URI deduplication', async () => {
    const derive = vi.fn();
    const service = new SubscriptionFeedService(
      { resolveAuthorizedDevice: vi.fn().mockResolvedValue(context) } as never,
      {
        selectForAuthorizedDevice: vi.fn().mockResolvedValue([route, route]),
      } as never,
      { derive } as never,
      enabledEnvironment as never,
    );

    await expect(service.feed('a'.repeat(43))).rejects.toMatchObject({
      message: 'Subscription feed is unavailable',
    });
    expect(derive).not.toHaveBeenCalled();
  });

  it('rejects an oversized body without returning a truncated URI', async () => {
    const credential = '99999999-9999-4999-8999-999999999999';
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      ...route,
      endpointId: `${String(index).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      endpointHost: `${String(index).padStart(3, '0')}.${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.test`,
      displayName: `${index}-${'Д'.repeat(120)}`.slice(0, 128),
    }));
    const service = new SubscriptionFeedService(
      { resolveAuthorizedDevice: vi.fn().mockResolvedValue(context) } as never,
      {
        selectForAuthorizedDevice: vi.fn().mockResolvedValue(candidates),
      } as never,
      {
        derive: vi.fn().mockReturnValue(credential),
        verifyHash: vi.fn().mockReturnValue(true),
      } as never,
      {
        SUBSCRIPTION_FEED_RENDERING_ENABLED: true,
        SUBSCRIPTION_FEED_MAX_ROUTES: 100,
      } as never,
    );

    await expect(service.feed('a'.repeat(43))).rejects.toMatchObject({
      message: 'Subscription feed is unavailable',
    });
  });
});
