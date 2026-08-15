import { isIP } from 'node:net';

export type RenderableVlessTcpTlsRoute = {
  host: string;
  addressKind: 'HOSTNAME' | 'IPV4' | 'IPV6';
  port: number;
  credential: string;
  tlsServerName: string;
  displayName: string;
};

const asciiHostnamePattern =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function isValidTlsServerName(value: string): boolean {
  return (
    value.length >= 1 && value.length <= 253 && asciiHostnamePattern.test(value)
  );
}

export function isValidVlessDisplayName(value: string): boolean {
  const codePointLength = [...value].length;
  return (
    codePointLength >= 1 && codePointLength <= 128 && !/\p{Cc}/u.test(value)
  );
}

export function renderVlessTcpTls(
  route: RenderableVlessTcpTlsRoute,
): string | null {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      route.credential,
    )
  )
    return null;
  if (!Number.isInteger(route.port) || route.port < 1 || route.port > 65_535)
    return null;
  if (!isValidVlessDisplayName(route.displayName)) return null;
  if (!isValidTlsServerName(route.tlsServerName)) return null;
  if (route.addressKind === 'IPV6' && isIP(route.host) !== 6) return null;
  if (route.addressKind === 'IPV4' && isIP(route.host) !== 4) return null;
  if (route.addressKind === 'HOSTNAME' && !isValidTlsServerName(route.host))
    return null;
  const host = route.addressKind === 'IPV6' ? `[${route.host}]` : route.host;
  const query = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    type: 'tcp',
    sni: route.tlsServerName,
  });
  return `vless://${route.credential}@${host}:${route.port}?${query.toString()}#${encodeURIComponent(route.displayName)}`;
}
