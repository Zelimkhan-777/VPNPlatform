export function requireHttpOrigin(value, name = 'WEB_API_PROXY_TARGET') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `${name} is required at build time and must be an HTTP(S) origin`,
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) origin`);
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      `${name} must be an HTTP(S) origin without credentials, path, query, or fragment`,
    );
  }

  return parsed.origin;
}
