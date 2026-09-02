import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildPlatformEnvironment,
  configKeys,
  createPlatformEnvironment,
  parseStrictEnvironment,
  platformEnvironmentKeys,
  readValidatedPlatformEnvironment,
  serializePlatformEnvironment,
  validatePlatformConfig,
  validatePlatformEnvironment,
} from './platform-environment.mjs';

const secretsRoot = fileURLToPath(new URL('.', import.meta.url));
const read = (name) => readFile(`${secretsRoot}/${name}`, 'utf8');

function digest(seed) {
  return `${seed}`.repeat(63).slice(0, 63) + '0';
}

function validConfig() {
  const unique = randomUUID().replaceAll('-', '').slice(0, 12);
  const root = `meteora-${unique}.com`;
  return {
    ROOT_DOMAIN: root,
    APP_DOMAIN: `app.${root}`,
    API_DOMAIN: `api.${root}`,
    SUB_DOMAIN: `sub.${root}`,
    ACME_EMAIL: `operator@${root}`,
    WEB_IMAGE: `ghcr.io/test-owner/web@sha256:${digest('1')}`,
    API_IMAGE: `ghcr.io/test-owner/api@sha256:${digest('2')}`,
    WORKER_IMAGE: `ghcr.io/test-owner/worker@sha256:${digest('3')}`,
    BOT_IMAGE: `ghcr.io/test-owner/bot@sha256:${digest('4')}`,
    POSTGRES_DB: 'meteora',
    POSTGRES_USER: 'meteora',
    API_REDIS_KEY_NAMESPACE: `meteora:production:${unique}`,
    SUBSCRIPTION_FEED_RENDERING_ENABLED: 'false',
    LOG_LEVEL: 'info',
  };
}

function serializeConfig(config) {
  return `${configKeys.map((key) => `${key}=${config[key]}`).join('\n')}\n`;
}

test('strict parser rejects missing, unknown and duplicate keys without evaluating input', () => {
  const config = validConfig();
  const serialized = serializeConfig(config);

  assert.deepEqual(parseStrictEnvironment(serialized, configKeys), config);
  assert.throws(
    () =>
      parseStrictEnvironment(
        `${serialized}ROOT_DOMAIN=duplicate.com\n`,
        configKeys,
      ),
    /duplicate-environment-key-ROOT_DOMAIN/,
  );
  assert.throws(
    () => parseStrictEnvironment(`${serialized}UNEXPECTED=value\n`, configKeys),
    /unknown-environment-key-UNEXPECTED/,
  );
  assert.throws(
    () =>
      parseStrictEnvironment(
        serialized.replace(/^LOG_LEVEL=.*$/m, ''),
        configKeys,
      ),
    /missing-environment-key-LOG_LEVEL/,
  );
});

test('generator creates independent secrets and exact service URL relationships', () => {
  const config = validatePlatformConfig(validConfig());
  const token = '123456:abcdefghijklmnopqrstuvwxyz_ABCDE';
  const values = buildPlatformEnvironment(config, token);

  validatePlatformEnvironment(values);
  assert.equal(values.TELEGRAM_WEB_APP_BOT_TOKEN, token);
  assert.equal(values.CABINET_ORIGIN, `https://${config.APP_DOMAIN}`);
  assert.equal(
    values.SUBSCRIPTION_FEED_BASE_URL,
    `https://${config.SUB_DOMAIN}`,
  );
  assert.equal(
    values.DATABASE_URL,
    `postgresql://${config.POSTGRES_USER}:${values.POSTGRES_PASSWORD}@postgres:5432/${config.POSTGRES_DB}?schema=public`,
  );
  const generated = [
    values.POSTGRES_PASSWORD,
    values.AUTH_SESSION_PEPPER,
    values.SUBSCRIPTION_TOKEN_PEPPER,
    values.NODE_AGENT_CREDENTIAL_PEPPER,
    values.DATA_PLANE_CREDENTIAL_PEPPER,
  ];
  assert.equal(new Set(generated).size, generated.length);
  assert.ok(generated.every((value) => /^[A-Za-z0-9_-]{43}$/.test(value)));
  assert.deepEqual(
    Object.keys(
      parseStrictEnvironment(
        serializePlatformEnvironment(values),
        platformEnvironmentKeys,
      ),
    ),
    platformEnvironmentKeys,
  );
});

test('initializer writes one private file and refuses overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meteora-secrets-test-'));
  const configPath = join(directory, 'platform-config.env');
  const tokenPath = join(directory, 'telegram-bot-token');
  const targetPath = join(directory, 'platform.env');
  try {
    await writeFile(configPath, serializeConfig(validConfig()), {
      mode: 0o600,
    });
    await writeFile(tokenPath, '123456:abcdefghijklmnopqrstuvwxyz_ABCDE\n', {
      mode: 0o600,
    });
    await createPlatformEnvironment({
      configPath,
      telegramTokenPath: tokenPath,
      targetPath,
    });
    const values = await readValidatedPlatformEnvironment(targetPath);
    assert.equal(values.POSTGRES_DB, 'meteora');
    if (process.platform !== 'win32') {
      assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
    }
    await assert.rejects(
      createPlatformEnvironment({
        configPath,
        telegramTokenPath: tokenPath,
        targetPath,
      }),
      /platform-environment-already-exists/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('production validation rejects fixtures and mismatched derived values', () => {
  const config = validConfig();
  assert.throws(
    () =>
      validatePlatformConfig({
        ...config,
        ROOT_DOMAIN: 'root.example.invalid',
        APP_DOMAIN: 'app.root.example.invalid',
        API_DOMAIN: 'api.root.example.invalid',
        SUB_DOMAIN: 'sub.root.example.invalid',
      }),
    /test-value-is-not-production/,
  );
  const values = buildPlatformEnvironment(
    config,
    '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
  );
  assert.throws(
    () =>
      validatePlatformEnvironment({
        ...values,
        CABINET_ORIGIN: 'https://wrong.example.com',
      }),
    /invalid-cabinet-origin-relation/,
  );
  assert.throws(
    () =>
      validatePlatformEnvironment({
        ...values,
        SUBSCRIPTION_TOKEN_PEPPER: values.AUTH_SESSION_PEPPER,
      }),
    /duplicate-generated-secret/,
  );
});

test('host wrappers use a pinned offline hardened container and never print values', async () => {
  const [initialize, validate, generator] = await Promise.all([
    read('initialize.sh'),
    read('validate.sh'),
    read('generate-platform-environment.mjs'),
  ]);
  for (const script of [initialize, validate]) {
    assert.match(script, /node@sha256:[0-9a-f]{64}/);
    assert.match(script, /--network none/);
    assert.match(script, /--read-only/);
    assert.match(script, /--cap-drop ALL/);
    assert.match(script, /no-new-privileges/);
  }
  assert.match(initialize, /platform-environment-already-exists/);
  assert.doesNotMatch(generator, /JSON\.stringify|console\.log/);
  assert.match(generator, /PLATFORM_ENV_CREATED path=/);
});

test('generated environment covers every production Compose input exactly', async () => {
  const compose = await read('../../docker-compose.production.yml');
  const referencedKeys = [
    ...new Set(
      [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]),
    ),
  ].sort();

  assert.deepEqual(referencedKeys, [...platformEnvironmentKeys].sort());
});
