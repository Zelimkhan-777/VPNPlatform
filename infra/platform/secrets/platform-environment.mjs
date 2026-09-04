import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const configKeys = [
  'ROOT_DOMAIN',
  'APP_DOMAIN',
  'API_DOMAIN',
  'SUB_DOMAIN',
  'ACME_EMAIL',
  'WEB_IMAGE',
  'API_IMAGE',
  'WORKER_IMAGE',
  'BOT_IMAGE',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'API_REDIS_KEY_NAMESPACE',
  'TRIAL_ACTIVATION_RATE_LIMIT_MAX',
  'TRIAL_ACTIVATION_RATE_LIMIT_WINDOW_MS',
  'SUBSCRIPTION_FEED_RENDERING_ENABLED',
  'LOG_LEVEL',
];

export const platformEnvironmentKeys = [
  'ROOT_DOMAIN',
  'APP_DOMAIN',
  'API_DOMAIN',
  'SUB_DOMAIN',
  'ACME_EMAIL',
  'WEB_IMAGE',
  'API_IMAGE',
  'WORKER_IMAGE',
  'BOT_IMAGE',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'DATABASE_URL',
  'REDIS_URL',
  'API_REDIS_KEY_NAMESPACE',
  'TRIAL_ACTIVATION_RATE_LIMIT_MAX',
  'TRIAL_ACTIVATION_RATE_LIMIT_WINDOW_MS',
  'TELEGRAM_WEB_APP_BOT_TOKEN',
  'AUTH_SESSION_PEPPER',
  'SUBSCRIPTION_TOKEN_PEPPER',
  'NODE_AGENT_CREDENTIAL_PEPPER',
  'DATA_PLANE_CREDENTIAL_PEPPER',
  'SUBSCRIPTION_FEED_BASE_URL',
  'CABINET_ORIGIN',
  'SUBSCRIPTION_FEED_RENDERING_ENABLED',
  'LOG_LEVEL',
];

const domainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const imagePattern =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const identifierPattern = /^[a-z_][a-z0-9_]{0,62}$/;
const namespacePattern = /^[A-Za-z0-9:_-]{1,128}$/;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const telegramTokenPattern = /^[0-9]{5,}:[A-Za-z0-9_-]{20,}$/;

function fail(code) {
  throw new Error(code);
}

export function parseStrictEnvironment(content, expectedKeys) {
  const expected = new Set(expectedKeys);
  const values = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith('#')) continue;
    if (line.trim() !== line) fail('invalid-environment-whitespace');
    const separator = line.indexOf('=');
    if (separator <= 0) fail('invalid-environment-line');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail('invalid-environment-key');
    if (!expected.has(key)) fail(`unknown-environment-key-${key}`);
    if (Object.hasOwn(values, key)) fail(`duplicate-environment-key-${key}`);
    if (!value || /[\r\n\0]/.test(value))
      fail(`invalid-environment-value-${key}`);
    values[key] = value;
  }

  for (const key of expectedKeys) {
    if (!Object.hasOwn(values, key)) fail(`missing-environment-key-${key}`);
  }
  return values;
}

function validateDomainSet(values) {
  for (const key of ['ROOT_DOMAIN', 'APP_DOMAIN', 'API_DOMAIN', 'SUB_DOMAIN']) {
    if (!domainPattern.test(values[key])) fail(`invalid-${key.toLowerCase()}`);
  }
  if (values.APP_DOMAIN !== `app.${values.ROOT_DOMAIN}`)
    fail('invalid-app-domain-relation');
  if (values.API_DOMAIN !== `api.${values.ROOT_DOMAIN}`)
    fail('invalid-api-domain-relation');
  if (values.SUB_DOMAIN !== `sub.${values.ROOT_DOMAIN}`)
    fail('invalid-sub-domain-relation');
}

function validateCommonValues(values) {
  validateDomainSet(values);
  if (!emailPattern.test(values.ACME_EMAIL)) fail('invalid-acme-email');
  for (const key of ['WEB_IMAGE', 'API_IMAGE', 'WORKER_IMAGE', 'BOT_IMAGE']) {
    if (!imagePattern.test(values[key])) fail(`invalid-${key.toLowerCase()}`);
  }
  if (!identifierPattern.test(values.POSTGRES_DB)) fail('invalid-postgres-db');
  if (!identifierPattern.test(values.POSTGRES_USER))
    fail('invalid-postgres-user');
  if (!namespacePattern.test(values.API_REDIS_KEY_NAMESPACE))
    fail('invalid-redis-namespace');
  validateBoundedInteger(
    values.TRIAL_ACTIVATION_RATE_LIMIT_MAX,
    1,
    1_000,
    'trial-activation-rate-limit-max',
  );
  validateBoundedInteger(
    values.TRIAL_ACTIVATION_RATE_LIMIT_WINDOW_MS,
    1_000,
    3_600_000,
    'trial-activation-rate-limit-window-ms',
  );
  if (!['true', 'false'].includes(values.SUBSCRIPTION_FEED_RENDERING_ENABLED))
    fail('invalid-feed-rendering-flag');
  if (
    !['fatal', 'error', 'warn', 'info', 'debug', 'trace'].includes(
      values.LOG_LEVEL,
    )
  )
    fail('invalid-log-level');
}

function validateBoundedInteger(value, minimum, maximum, label) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail(`invalid-${label}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    fail(`invalid-${label}`);
}

export function validatePlatformConfig(
  values,
  { allowTestValues = false } = {},
) {
  validateCommonValues(values);
  if (!allowTestValues) rejectTestValues(values);
  return values;
}

export function validatePlatformEnvironment(
  values,
  { allowTestValues = false } = {},
) {
  validateCommonValues(values);
  if (!allowTestValues) rejectTestValues(values);
  if (!secretPattern.test(values.POSTGRES_PASSWORD))
    fail('invalid-postgres-password');
  if (!telegramTokenPattern.test(values.TELEGRAM_WEB_APP_BOT_TOKEN))
    fail('invalid-telegram-token');

  const secretKeys = [
    'AUTH_SESSION_PEPPER',
    'SUBSCRIPTION_TOKEN_PEPPER',
    'NODE_AGENT_CREDENTIAL_PEPPER',
    'DATA_PLANE_CREDENTIAL_PEPPER',
  ];
  for (const key of secretKeys) {
    if (!secretPattern.test(values[key])) fail(`invalid-${key.toLowerCase()}`);
  }
  const uniqueSecrets = new Set([
    values.POSTGRES_PASSWORD,
    ...secretKeys.map((key) => values[key]),
  ]);
  if (uniqueSecrets.size !== secretKeys.length + 1)
    fail('duplicate-generated-secret');

  const expectedDatabaseUrl = `postgresql://${values.POSTGRES_USER}:${values.POSTGRES_PASSWORD}@postgres:5432/${values.POSTGRES_DB}?schema=public`;
  if (values.DATABASE_URL !== expectedDatabaseUrl)
    fail('invalid-database-url-relation');
  if (values.REDIS_URL !== 'redis://redis:6379/0') fail('invalid-redis-url');
  if (values.SUBSCRIPTION_FEED_BASE_URL !== `https://${values.SUB_DOMAIN}`)
    fail('invalid-feed-url-relation');
  if (values.CABINET_ORIGIN !== `https://${values.APP_DOMAIN}`)
    fail('invalid-cabinet-origin-relation');
  return values;
}

function rejectTestValues(values) {
  for (const value of Object.values(values)) {
    const normalized = value.toLowerCase();
    if (
      normalized.includes('test_only') ||
      normalized.includes('example.invalid') ||
      /@sha256:([0-9a-f])\1{63}$/.test(normalized)
    )
      fail('test-value-is-not-production');
  }
}

function createSecret() {
  return randomBytes(32).toString('base64url');
}

export function buildPlatformEnvironment(config, telegramToken) {
  validatePlatformConfig(config);
  if (!telegramTokenPattern.test(telegramToken)) fail('invalid-telegram-token');
  const postgresPassword = createSecret();
  const values = {
    ROOT_DOMAIN: config.ROOT_DOMAIN,
    APP_DOMAIN: config.APP_DOMAIN,
    API_DOMAIN: config.API_DOMAIN,
    SUB_DOMAIN: config.SUB_DOMAIN,
    ACME_EMAIL: config.ACME_EMAIL,
    WEB_IMAGE: config.WEB_IMAGE,
    API_IMAGE: config.API_IMAGE,
    WORKER_IMAGE: config.WORKER_IMAGE,
    BOT_IMAGE: config.BOT_IMAGE,
    POSTGRES_DB: config.POSTGRES_DB,
    POSTGRES_USER: config.POSTGRES_USER,
    POSTGRES_PASSWORD: postgresPassword,
    DATABASE_URL: `postgresql://${config.POSTGRES_USER}:${postgresPassword}@postgres:5432/${config.POSTGRES_DB}?schema=public`,
    REDIS_URL: 'redis://redis:6379/0',
    API_REDIS_KEY_NAMESPACE: config.API_REDIS_KEY_NAMESPACE,
    TRIAL_ACTIVATION_RATE_LIMIT_MAX: config.TRIAL_ACTIVATION_RATE_LIMIT_MAX,
    TRIAL_ACTIVATION_RATE_LIMIT_WINDOW_MS:
      config.TRIAL_ACTIVATION_RATE_LIMIT_WINDOW_MS,
    TELEGRAM_WEB_APP_BOT_TOKEN: telegramToken,
    AUTH_SESSION_PEPPER: createSecret(),
    SUBSCRIPTION_TOKEN_PEPPER: createSecret(),
    NODE_AGENT_CREDENTIAL_PEPPER: createSecret(),
    DATA_PLANE_CREDENTIAL_PEPPER: createSecret(),
    SUBSCRIPTION_FEED_BASE_URL: `https://${config.SUB_DOMAIN}`,
    CABINET_ORIGIN: `https://${config.APP_DOMAIN}`,
    SUBSCRIPTION_FEED_RENDERING_ENABLED:
      config.SUBSCRIPTION_FEED_RENDERING_ENABLED,
    LOG_LEVEL: config.LOG_LEVEL,
  };
  validatePlatformEnvironment(values);
  return values;
}

export function serializePlatformEnvironment(values) {
  validatePlatformEnvironment(values);
  return `${platformEnvironmentKeys.map((key) => `${key}=${values[key]}`).join('\n')}\n`;
}

export async function assertPrivateFile(path, label) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`invalid-${label}-type`);
  if (process.platform !== 'win32') {
    if (stats.uid !== process.getuid()) fail(`invalid-${label}-owner`);
    if ((stats.mode & 0o077) !== 0) fail(`insecure-${label}-mode`);
  }
}

export async function readValidatedPlatformEnvironment(path) {
  await assertPrivateFile(path, 'platform-environment');
  const values = parseStrictEnvironment(
    await readFile(path, 'utf8'),
    platformEnvironmentKeys,
  );
  return validatePlatformEnvironment(values);
}

export async function createPlatformEnvironment({
  configPath,
  telegramTokenPath,
  targetPath,
}) {
  await assertPrivateFile(configPath, 'platform-config');
  await assertPrivateFile(telegramTokenPath, 'telegram-token');
  try {
    await lstat(targetPath);
    fail('platform-environment-already-exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const config = validatePlatformConfig(
    parseStrictEnvironment(await readFile(configPath, 'utf8'), configKeys),
  );
  const telegramToken = (await readFile(telegramTokenPath, 'utf8')).trim();
  if (/\s/.test(telegramToken)) fail('invalid-telegram-token');
  const serialized = serializePlatformEnvironment(
    buildPlatformEnvironment(config, telegramToken),
  );

  const targetDirectory = dirname(targetPath);
  const temporaryPath = join(
    targetDirectory,
    `.platform.env.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryCreated = true;
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, targetPath);
    await unlink(temporaryPath);
    temporaryCreated = false;
    const directoryHandle = await open(targetDirectory, constants.O_RDONLY);
    try {
      try {
        await directoryHandle.sync();
      } catch (error) {
        if (process.platform !== 'win32' || error?.code !== 'EPERM')
          throw error;
      }
    } finally {
      await directoryHandle.close();
    }
    await readValidatedPlatformEnvironment(targetPath);
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
  }
}
