import { isIP } from 'node:net';

import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

export type { Logger } from 'pino';

export const SAFE_LOG_CENSOR = '[REDACTED]';

export const SAFE_LOG_REDACTION_PATHS = [
  'req.headers',
  'req.body.password',
  'req.body.token',
  'req.body.subscriptionUrl',
  'req.body.initData',
  'req.params.token',
  'req.url',
  'req.remoteAddress',
  'req.remotePort',
  'res.headers',
] as const;

const SECRET_KEY_PARTS = [
  'authorization',
  'cookie',
  'password',
  'passphrase',
  'passwd',
  'token',
  'secret',
  'credential',
  'apikey',
  'privatekey',
  'accesskey',
  'signingkey',
  'signature',
  'ciphertext',
  'nonce',
  'kek',
  'vpnkey',
  'vpncredential',
  'initdata',
  'subscriptionurl',
  'redisurl',
  'databaseurl',
  'connectionstring',
  'remoteaddress',
  'remoteport',
  'clientip',
  'ipaddress',
  'forwardedfor',
] as const;

const UUID_PATTERN =
  /(?:^|[^0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:$|[^0-9a-f])/i;
const IPV4_PATTERN =
  /(?:^|[^\d])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:$|[^\d])/;
const URL_PATTERN = /\b[a-z][a-z\d+.-]{1,31}:\/\/\S+/i;
const JWT_PATTERN = /\beyJ[A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+\b/;
const PLATFORM_OPAQUE_SECRET_PATTERN =
  /(?:^|[^A-Za-z\d_-])[A-Za-z\d_-]{43}(?:$|[^A-Za-z\d_-])/;
const LABELED_SECRET_PATTERN =
  /\b(?:authorization|cookie|password|passphrase|token|secret|credential|api[-_ ]?key)\s*[:=]\s*\S+/i;
const SUBSCRIPTION_PATH_PATTERN = /\/(?:sub|subscription)\/[^\s?]+/i;
const HTTP_METHOD_TARGET_PATTERN =
  /(?:^|\s)(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)\s+\/(?!\/)\S+/i;
const RELATIVE_REQUEST_TARGET_PATTERN = /^\/(?!\/)[^\s]*$/;
const EMBEDDED_RELATIVE_TARGET_PATTERNS = [
  /\b(?:request\s+)?(?:route|url|uri|path|target)\s*(?:[:=]\s*|\s+)\/(?!\/)\S+/i,
  /\b(?:request|fetch|call)\b[^\r\n]{0,40}\b(?:at|to)\s+\/(?!\/)\S+/i,
] as const;
const BRACKETED_IPV6_CANDIDATE_PATTERN =
  /\[[0-9a-f:.]+(?:%[a-z\d_.-]+)?\](?::\d{1,5})?/gi;
const BARE_IPV6_CANDIDATE_PATTERN = /[0-9a-f:]*:[0-9a-f:]+(?:%[a-z\d_.-]+)?/gi;
const HTTP_REQUEST_MARKER_KEYS = [
  'url',
  'originalUrl',
  'headers',
  'query',
  'params',
  'body',
  'socket',
  'raw',
] as const;
const HTTP_RESPONSE_MARKER_KEYS = [
  'body',
  'headers',
  'raw',
  'socket',
  'statusMessage',
] as const;
const SENSITIVE_KEY_FAMILIES = [
  'authentication',
  'challenge',
  'prelaunch',
  'session',
  'bearer',
  'auth',
] as const;
const SENSITIVE_FAMILY_SUFFIXES = [
  'id',
  'key',
  'token',
  'secret',
  'credential',
  'cookie',
  'code',
  'verifier',
  'nonce',
  'proof',
  'fingerprint',
  'hash',
  'value',
  'material',
] as const;

function normalizeKey(key: string): string {
  return key.replaceAll(/[^a-z\d]/gi, '').toLowerCase();
}

function isIdentifierKey(key: string): boolean {
  return key === 'id' || /(?:Id|ID|[_-]id)$/.test(key);
}

function isSensitiveKeyFamily(normalized: string): boolean {
  return SENSITIVE_KEY_FAMILIES.some((family) => {
    if (normalized === family) return true;
    if (!normalized.startsWith(family)) return false;
    const suffix = normalized.slice(family.length);
    return SENSITIVE_FAMILY_SUFFIXES.some((candidate) =>
      suffix.startsWith(candidate),
    );
  });
}

function isSafeAggregate(normalized: string, value: unknown): boolean {
  return (
    typeof value === 'boolean' ||
    (normalized.endsWith('count') &&
      typeof value === 'number' &&
      Number.isFinite(value)) ||
    (normalized.endsWith('outcome') && typeof value === 'string')
  );
}

function isSecretKey(key: string, value: unknown): boolean {
  const normalized = normalizeKey(key);
  if (isSafeAggregate(normalized, value)) return false;

  return (
    SECRET_KEY_PARTS.some((part) => normalized.includes(part)) ||
    isSensitiveKeyFamily(normalized) ||
    normalized.endsWith('url') ||
    normalized.endsWith('uri') ||
    normalized === 'ip' ||
    normalized === 'headers' ||
    normalized === 'header' ||
    isIdentifierKey(key)
  );
}

function normalizeIpv6Candidate(candidate: string): string {
  let normalized = candidate;
  if (normalized.startsWith('[')) {
    const closingBracket = normalized.indexOf(']');
    if (closingBracket < 0) return '';
    normalized = normalized.slice(1, closingBracket);
  }

  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex >= 0) {
    normalized = normalized.slice(0, zoneIndex);
  }
  return normalized;
}

function containsIpv6(value: string): boolean {
  for (const pattern of [
    BRACKETED_IPV6_CANDIDATE_PATTERN,
    BARE_IPV6_CANDIDATE_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const candidate = match[0];
      if (
        candidate !== undefined &&
        isIP(normalizeIpv6Candidate(candidate)) === 6
      ) {
        return true;
      }
    }
  }
  return false;
}

function containsSensitiveString(value: string): boolean {
  const trimmed = value.trim();
  return (
    isIP(trimmed) !== 0 ||
    UUID_PATTERN.test(value) ||
    IPV4_PATTERN.test(value) ||
    containsIpv6(value) ||
    URL_PATTERN.test(value) ||
    JWT_PATTERN.test(value) ||
    PLATFORM_OPAQUE_SECRET_PATTERN.test(value) ||
    LABELED_SECRET_PATTERN.test(value) ||
    SUBSCRIPTION_PATH_PATTERN.test(value) ||
    HTTP_METHOD_TARGET_PATTERN.test(value) ||
    EMBEDDED_RELATIVE_TARGET_PATTERNS.some((pattern) => pattern.test(value)) ||
    RELATIVE_REQUEST_TARGET_PATTERN.test(trimmed)
  );
}

function sanitizeString(value: string): string {
  return containsSensitiveString(value) ? SAFE_LOG_CENSOR : value;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function projectRequest(value: unknown): Record<string, unknown> {
  const request = getRecord(value);
  const raw = getRecord(request?.raw);
  const method = request?.method ?? raw?.method;

  return typeof method === 'string' && /^[A-Z]{3,12}$/.test(method)
    ? { method }
    : {};
}

function safeRequest(value: unknown): Record<string, unknown> {
  try {
    return projectRequest(value);
  } catch {
    return {};
  }
}

function projectResponse(value: unknown): Record<string, unknown> {
  const response = getRecord(value);
  const raw = getRecord(response?.raw);
  const statusCode = response?.statusCode ?? raw?.statusCode;

  return typeof statusCode === 'number' && Number.isInteger(statusCode)
    ? { statusCode }
    : {};
}

function safeResponse(value: unknown): Record<string, unknown> {
  try {
    return projectResponse(value);
  } catch {
    return {};
  }
}

function projectError(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return { type: sanitizeString(value.constructor.name || 'Error') };
  }

  const error = getRecord(value);
  const type = error?.type ?? error?.name;
  return typeof type === 'string'
    ? { type: sanitizeString(type) }
    : { type: 'Error' };
}

function safeError(value: unknown): Record<string, unknown> {
  try {
    return projectError(value);
  } catch {
    return { type: 'Error' };
  }
}

function isHttpRequestLike(value: unknown): boolean {
  const request = getRecord(value);
  if (request === undefined) return false;

  const raw = getRecord(request.raw);
  const method = request.method ?? raw?.method;
  if (typeof method !== 'string' || !/^[A-Z]{3,12}$/.test(method)) {
    return false;
  }

  return HTTP_REQUEST_MARKER_KEYS.some((key) => key in request);
}

function isHttpResponseLike(value: unknown): boolean {
  const response = getRecord(value);
  if (response === undefined) return false;

  const raw = getRecord(response.raw);
  const statusCode = response.statusCode ?? raw?.statusCode;
  return (
    typeof statusCode === 'number' &&
    Number.isInteger(statusCode) &&
    (raw !== undefined ||
      HTTP_RESPONSE_MARKER_KEYS.some((key) => key in response))
  );
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (key === 'req' || key === 'request') {
    return projectRequest(value);
  }
  if (key === 'res' || key === 'response') {
    return projectResponse(value);
  }
  if (key === 'err' || key === 'error') {
    return projectError(value);
  }
  if (key !== undefined && isSecretKey(key, value)) {
    return SAFE_LOG_CENSOR;
  }
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value !== 'object' || depth >= 12) {
    return SAFE_LOG_CENSOR;
  }
  if (isHttpRequestLike(value)) {
    return projectRequest(value);
  }
  if (isHttpResponseLike(value)) {
    return projectResponse(value);
  }
  if (value instanceof Error) {
    return projectError(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return SAFE_LOG_CENSOR;
  }
  if (seen.has(value)) {
    return SAFE_LOG_CENSOR;
  }

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) =>
      sanitizeValue(entry, undefined, seen, depth + 1),
    );
  }

  const sanitized = Object.create(null) as Record<string, unknown>;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    sanitized[entryKey] = sanitizeValue(entryValue, entryKey, seen, depth + 1);
  }
  return sanitized;
}

function sanitizeLogArguments(args: readonly unknown[]): unknown[] {
  const seen = new WeakSet<object>();
  return args.map((argument, index) => {
    if (index === 0 && argument instanceof Error) {
      return { err: projectError(argument) };
    }
    return sanitizeValue(argument, undefined, seen, 0);
  });
}

function minimalSafeLogArguments(): unknown[] {
  return [{ sanitizationFailure: true }, SAFE_LOG_CENSOR];
}

type SanitizedBindings =
  | { ok: true; bindings: Record<string, unknown> }
  | { ok: false; bindings: Record<string, never> };

const UNSAFE_BINDING_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'hasOwnProperty',
]);

function toPinoBindings(
  sanitized: Record<string, unknown>,
): Record<string, unknown> {
  const bindings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (UNSAFE_BINDING_KEYS.has(key)) continue;
    Object.defineProperty(bindings, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return bindings;
}

function trySanitizeBindings(bindings: unknown): SanitizedBindings {
  try {
    const sanitized = sanitizeValue(bindings, undefined, new WeakSet(), 0);
    const record = getRecord(sanitized);
    return record === undefined
      ? { ok: false, bindings: {} }
      : { ok: true, bindings: toPinoBindings(record) };
  } catch {
    return { ok: false, bindings: {} };
  }
}

function sanitizeBindings(bindings: Record<string, unknown>): object {
  return trySanitizeBindings(bindings).bindings;
}

const SAFE_LOG_METHODS = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);

function wrapSafeLogger(logger: Logger, forceMinimalRecord = false): Logger {
  return new Proxy(logger, {
    get(target, property) {
      if (property === 'child') {
        return (...args: Parameters<Logger['child']>): Logger => {
          const [bindings, options] = args;
          const sanitized = trySanitizeBindings(bindings);
          const child = (
            options === undefined
              ? target.child(sanitized.bindings)
              : target.child(sanitized.bindings, options)
          ) as Logger;
          return wrapSafeLogger(child, forceMinimalRecord || !sanitized.ok);
        };
      }

      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (
        forceMinimalRecord &&
        typeof property === 'string' &&
        SAFE_LOG_METHODS.has(property)
      ) {
        return () =>
          value.apply(
            target,
            minimalSafeLogArguments() as [unknown, string?, ...unknown[]],
          );
      }
      return value.bind(target);
    },
  }) as Logger;
}

function createSafeLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: null,
    redact: {
      paths: [...SAFE_LOG_REDACTION_PATHS],
      censor: SAFE_LOG_CENSOR,
    },
    serializers: {
      req: safeRequest,
      request: safeRequest,
      res: safeResponse,
      response: safeResponse,
      err: safeError,
      error: safeError,
    },
    formatters: {
      bindings: sanitizeBindings,
    },
    hooks: {
      logMethod(args, method) {
        let sanitizedArguments: unknown[];
        try {
          sanitizedArguments = sanitizeLogArguments(args);
        } catch {
          sanitizedArguments = minimalSafeLogArguments();
        }
        method.apply(
          this,
          sanitizedArguments as [unknown, string?, ...unknown[]],
        );
      },
    },
  };
}

export function createSafeLogger(
  level: string,
  destination?: DestinationStream,
): Logger {
  const options = createSafeLoggerOptions(level);
  const logger =
    destination === undefined ? pino(options) : pino(options, destination);
  return wrapSafeLogger(logger);
}

export type SafePinoHttpOptions = LoggerOptions & { logger: Logger };

export function createSafePinoHttpOptions(
  level: string,
  destination?: DestinationStream,
): SafePinoHttpOptions {
  return {
    ...createSafeLoggerOptions(level),
    logger: createSafeLogger(level, destination),
  };
}
