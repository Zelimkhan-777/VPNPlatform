import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  subscriptionFeedSchema,
  type SubscriptionFeed,
} from '@vpn-platform/contracts';

import { SubscriptionAccessService } from './subscription-access.service';
import { API_ENVIRONMENT, type ApiEnvironment } from '../config/environment';
import { ConnectionRouteSelectionService } from './connection-route-selection.service';
import {
  DATA_PLANE_CREDENTIAL_DERIVATION_VERSION,
  DataPlaneCredentialService,
} from '../orchestration/data-plane-credential.service';
import { renderVlessTcpTls } from './vless-tcp-tls.renderer';

const MAX_FEED_BYTES = 16_384;

@Injectable()
export class SubscriptionFeedService {
  constructor(
    @Inject(SubscriptionAccessService)
    private readonly access: SubscriptionAccessService,
    @Inject(ConnectionRouteSelectionService)
    private readonly routes: ConnectionRouteSelectionService,
    @Inject(DataPlaneCredentialService)
    private readonly credentials: DataPlaneCredentialService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async feed(token: string): Promise<SubscriptionFeed> {
    const context = await this.access.resolveAuthorizedDevice(token);
    if (!context) {
      throw new UnauthorizedException('Subscription token is invalid');
    }

    if (!this.environment.SUBSCRIPTION_FEED_RENDERING_ENABLED) {
      throw new ServiceUnavailableException('Subscription feed is unavailable');
    }
    const maximumRoutes = this.environment.SUBSCRIPTION_FEED_MAX_ROUTES;
    const routes = await this.routes.selectForAuthorizedDevice({
      ...context,
    });
    const rendered = new Set<string>();
    const renderedNodeIds = new Set<string>();
    const renderedByPool = new Map<string, number>();
    let feedBytes = 0;
    for (const route of routes) {
      if (renderedNodeIds.has(route.nodeId)) continue;
      if (
        route.protocolKind !== 'VLESS' ||
        route.transportKind !== 'TCP' ||
        route.securityKind !== 'TLS' ||
        route.clientCompatibility !== 'HAPP' ||
        !route.tlsServerName ||
        !route.displayName ||
        route.dataPlaneCredentialDerivationVersion !==
          DATA_PLANE_CREDENTIAL_DERIVATION_VERSION
      )
        continue;
      const credential = this.credentials.derive({
        grantId: route.grantId,
        deviceId: context.deviceId,
        nodeId: route.nodeId,
      });
      if (
        !this.credentials.verifyHash(credential, route.dataPlaneCredentialHash)
      )
        continue;
      const uri = renderVlessTcpTls({
        host: route.endpointHost,
        addressKind: route.endpointAddressKind,
        port: route.endpointPort,
        credential,
        tlsServerName: route.tlsServerName,
        displayName: route.displayName,
      });
      const poolRouteCount = renderedByPool.get(route.poolId) ?? 0;
      if (
        uri &&
        !rendered.has(uri) &&
        poolRouteCount < route.poolCandidateLimit
      ) {
        if (rendered.size >= maximumRoutes) {
          throw new ServiceUnavailableException(
            'Subscription feed is unavailable',
          );
        }
        const nextFeedBytes =
          feedBytes + (rendered.size === 0 ? 0 : 1) + Buffer.byteLength(uri);
        if (nextFeedBytes > MAX_FEED_BYTES) {
          throw new ServiceUnavailableException(
            'Subscription feed is unavailable',
          );
        }
        rendered.add(uri);
        renderedNodeIds.add(route.nodeId);
        renderedByPool.set(route.poolId, poolRouteCount + 1);
        feedBytes = nextFeedBytes;
      }
    }
    const feed = [...rendered].join('\n');
    if (rendered.size === 0) {
      throw new ServiceUnavailableException('Subscription feed is unavailable');
    }
    return subscriptionFeedSchema.parse(feed);
  }
}
