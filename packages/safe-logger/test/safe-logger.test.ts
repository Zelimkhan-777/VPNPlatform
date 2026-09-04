import { describe, expect, it } from 'vitest';

import { createSafeLogger, SAFE_LOG_CENSOR } from '../src/index';

function captureLine(
  writeLog: (logger: ReturnType<typeof createSafeLogger>) => void,
): { line: string; record: Record<string, unknown> } {
  const records: string[] = [];
  const logger = createSafeLogger('info', {
    write(record) {
      records.push(record);
    },
  });

  writeLog(logger);

  expect(records).toHaveLength(1);
  const line = records[0] ?? '';
  return {
    line,
    record: JSON.parse(line) as Record<string, unknown>,
  };
}

function captureRecord(
  writeLog: (logger: ReturnType<typeof createSafeLogger>) => void,
): Record<string, unknown> {
  return captureLine(writeLog).record;
}

describe('safe logger', () => {
  it('retains permitted aggregates while removing the secret and network matrix', () => {
    const sensitiveValues = [
      'body-token-secret',
      'redis://worker:redis-password@10.20.30.40:6379/0',
      '1d9a845f-0c85-44af-a79a-3f909221b512',
      'https://sub.example.test/sub/subscription-secret',
      '203.0.113.42',
    ];

    const record = captureRecord((logger) => {
      logger.info(
        {
          component: 'worker',
          active: true,
          processedCount: 3,
          sessionCount: 4,
          challengeAttemptCount: 2,
          sessionActive: false,
          authOutcome: 'rejected',
          outcome: 'completed',
          token: sensitiveValues[0],
          redisUrl: sensitiveValues[1],
          consumerId: sensitiveValues[2],
          subscriptionUrl: sensitiveValues[3],
          clientIp: sensitiveValues[4],
        },
        'Safe aggregate record',
      );
    });

    const serialized = JSON.stringify(record);
    for (const sensitiveValue of sensitiveValues) {
      expect(serialized).not.toContain(sensitiveValue);
    }
    expect(record).toMatchObject({
      component: 'worker',
      active: true,
      processedCount: 3,
      sessionCount: 4,
      challengeAttemptCount: 2,
      sessionActive: false,
      authOutcome: 'rejected',
      outcome: 'completed',
      token: SAFE_LOG_CENSOR,
      redisUrl: SAFE_LOG_CENSOR,
      consumerId: SAFE_LOG_CENSOR,
      subscriptionUrl: SAFE_LOG_CENSOR,
      clientIp: SAFE_LOG_CENSOR,
    });
  });

  it('redacts normalized auth, session and private key field families at every depth', () => {
    const secretFields = {
      session: 'session-secret',
      sessionKey: 'session-key-secret',
      SESSION_ID: 'session-id-secret',
      auth: 'auth-secret',
      'auth-token': 'auth-token-secret',
      bearer: 'bearer-secret',
      bearer_token: 'bearer-token-secret',
      privateKey: 'private-key-secret',
      PRIVATE_KEY_PEM: 'private-key-pem-secret',
      accessKey: 'access-key-secret',
      'signing-key': 'signing-key-secret',
      vpnKey: 'vpn-key-secret',
      VPN_CREDENTIAL: 'vpn-credential-secret',
      challengeVerifier: 'challenge-verifier-secret',
      challengeNonce: 'challenge-nonce-secret',
      prelaunchNonce: 'prelaunch-nonce-secret',
      sessionFingerprint: 'session-fingerprint-secret',
      sessionHash: 'session-hash-secret',
      authProof: 'auth-proof-secret',
      bearerValue: 'bearer-value-secret',
      authenticationMaterial: 'authentication-material-secret',
    };

    const record = captureRecord((logger) => {
      logger
        .child({
          session_key: 'child-session-secret',
          bearerToken: 'child-bearer-secret',
          private_key_pem: 'child-private-key-secret',
        })
        .info({
          component: 'worker',
          nested: { secrets: secretFields },
          list: [{ private_key_pem: 'array-private-key-secret' }],
        });
    });

    const serialized = JSON.stringify(record);
    for (const value of [
      ...Object.values(secretFields),
      'child-session-secret',
      'child-bearer-secret',
      'child-private-key-secret',
      'array-private-key-secret',
    ]) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).toContain(SAFE_LOG_CENSOR);
    expect(record).toMatchObject({ component: 'worker' });
  });

  it('redacts bot HMAC and AEAD material under direct operational field names', () => {
    const records: string[] = [];
    const logger = createSafeLogger('info', {
      write: (record) => records.push(record),
    });

    logger.warn({
      signature: 'bot-signature-secret',
      nonce: 'bot-nonce-secret',
      keyCiphertext: 'bot-ciphertext-secret',
      botSigningKek: 'bot-kek-secret',
    });

    const output = records.join('');
    expect(output).not.toContain('bot-signature-secret');
    expect(output).not.toContain('bot-nonce-secret');
    expect(output).not.toContain('bot-ciphertext-secret');
    expect(output).not.toContain('bot-kek-secret');
  });

  it('redacts real 32-byte base64url platform secrets under neutral and auth keys', () => {
    const opaqueSecret = 'AbCdEf0123456789_-AbCdEf0123456789_-AbCdEf0';
    expect(opaqueSecret).toHaveLength(43);

    const record = captureRecord((logger) => {
      logger.info(
        {
          component: 'auth',
          challenge: opaqueSecret,
          value: opaqueSecret,
          nested: {
            prelaunchKey: opaqueSecret,
            neutral: `credential ${opaqueSecret} rejected`,
          },
        },
        `authentication failed for ${opaqueSecret}`,
      );
    });

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(opaqueSecret);
    expect(record).toMatchObject({
      component: 'auth',
      challenge: SAFE_LOG_CENSOR,
      value: SAFE_LOG_CENSOR,
      nested: {
        prelaunchKey: SAFE_LOG_CENSOR,
        neutral: SAFE_LOG_CENSOR,
      },
      msg: SAFE_LOG_CENSOR,
    });
  });

  it.each([
    '2001:db8::7',
    '[2001:db8::7]:443',
    'fe80::1%eth0',
    '::1',
    'Connection from [2001:db8::7]:443 was rejected',
    'Interface address is fe80::1%eth0 during retry',
  ])('redacts IPv6 in arbitrary strings: %s', (address) => {
    const record = captureRecord((logger) => {
      logger.info({ component: 'node-agent', detail: address });
    });

    expect(record).toMatchObject({
      component: 'node-agent',
      detail: SAFE_LOG_CENSOR,
    });
    expect(JSON.stringify(record)).not.toContain(address);
  });

  it.each([
    '/auth/logout?session=relative-secret',
    '/api/devices/token-value',
    'GET /auth/logout?token=message-secret',
    'request failed at /auth/logout?next=cabinet',
    'route=/api/devices/123 failed',
  ])('redacts relative HTTP request targets: %s', (target) => {
    const record = captureRecord((logger) => {
      logger.info({ component: 'api', detail: target });
    });

    expect(record).toMatchObject({
      component: 'api',
      detail: SAFE_LOG_CENSOR,
    });
  });

  it('does not treat ordinary prose containing a slash as a request target', () => {
    const detail = 'Read docs/security before the release';
    const record = captureRecord((logger) => {
      logger.info({ component: 'api', detail });
    });

    expect(record).toMatchObject({ component: 'api', detail });
  });

  it('serializes requests and responses without URL, headers, IP or port', () => {
    const record = captureRecord((logger) => {
      logger.info({
        req: {
          method: 'POST',
          url: '/sub/request-token',
          remoteAddress: '2001:db8::7',
          remotePort: 41234,
          headers: { authorization: 'Bearer request-secret' },
        },
        res: {
          statusCode: 403,
          headers: { 'set-cookie': 'session=response-secret' },
        },
        responseTime: 17,
      });
    });

    expect(record).toMatchObject({
      req: { method: 'POST' },
      res: { statusCode: 403 },
      responseTime: 17,
    });
    expect(JSON.stringify(record)).not.toMatch(
      /request-token|2001:db8::7|41234|request-secret|response-secret/,
    );
  });

  it.each(['info', 'error'] as const)(
    'sanitizes a request-like object passed directly to logger.%s',
    (level) => {
      const record = captureRecord((logger) => {
        logger[level](
          {
            method: 'PATCH',
            url: '/subscription/direct-request-secret',
            headers: { cookie: 'session=direct-cookie-secret' },
            remoteAddress: '198.51.100.9',
            remotePort: 43123,
            body: { token: 'direct-body-token' },
          },
          'Direct request failed',
        );
      });

      expect(record).toMatchObject({ method: 'PATCH' });
      for (const requestField of [
        'url',
        'headers',
        'remoteAddress',
        'remotePort',
        'body',
        'query',
        'params',
      ]) {
        expect(record).not.toHaveProperty(requestField);
      }
      expect(JSON.stringify(record)).not.toMatch(
        /direct-request-secret|direct-cookie-secret|198\.51\.100\.9|43123|direct-body-token/,
      );
    },
  );

  it('reduces nested and array-contained HTTP requests to method only', () => {
    const record = captureRecord((logger) => {
      logger.info({
        component: 'api',
        outcome: 'rejected',
        active: true,
        rejectedCount: 2,
        nested: {
          request: {
            method: 'GET',
            url: '/auth/logout?session=nested-secret',
            query: { session: 'nested-query-secret' },
            params: { token: 'nested-param-secret' },
            body: { authToken: 'nested-body-secret' },
          },
        },
        attempts: [
          {
            method: 'DELETE',
            originalUrl: '/api/devices/array-token',
            headers: { authorization: 'Bearer array-secret' },
            socket: { remoteAddress: '2001:db8::7', remotePort: 443 },
          },
        ],
      });
    });

    expect(record).toMatchObject({
      component: 'api',
      outcome: 'rejected',
      active: true,
      rejectedCount: 2,
      nested: { request: { method: 'GET' } },
      attempts: [{ method: 'DELETE' }],
    });
    expect(JSON.stringify(record)).not.toMatch(
      /nested-secret|nested-query-secret|nested-param-secret|nested-body-secret|array-token|array-secret|2001:db8::7/,
    );
  });

  it.each(['info', 'error'] as const)(
    'sanitizes a response-like object passed directly to logger.%s',
    (level) => {
      const record = captureRecord((logger) => {
        logger[level](
          {
            statusCode: 200,
            headers: { 'set-cookie': 'response-cookie-secret' },
            body: { email: 'victim@example.test' },
            raw: {
              socket: { remoteAddress: '2001:db8::7', remotePort: 443 },
            },
          },
          'Direct response completed',
        );
      });

      expect(record).toMatchObject({ statusCode: 200 });
      for (const responseField of ['headers', 'body', 'raw', 'socket']) {
        expect(record).not.toHaveProperty(responseField);
      }
      expect(JSON.stringify(record)).not.toMatch(
        /response-cookie-secret|victim@example\.test|2001:db8::7/,
      );
    },
  );

  it('reduces nested and array-contained HTTP responses to status code only', () => {
    const record = captureRecord((logger) => {
      logger.info({
        component: 'api',
        outcome: 'completed',
        responseCount: 2,
        nested: {
          reply: {
            statusCode: 201,
            body: { email: 'nested-victim@example.test' },
          },
        },
        attempts: [
          {
            statusCode: 503,
            headers: { server: 'array-response-secret' },
            body: { reason: 'internal-response-secret' },
          },
        ],
      });
    });

    expect(record).toMatchObject({
      component: 'api',
      outcome: 'completed',
      responseCount: 2,
      nested: { reply: { statusCode: 201 } },
      attempts: [{ statusCode: 503 }],
    });
    expect(JSON.stringify(record)).not.toMatch(
      /nested-victim|array-response-secret|internal-response-secret/,
    );
  });

  it('retains an operational record when statusCode has no response markers', () => {
    const record = captureRecord((logger) => {
      logger.info({
        component: 'api',
        outcome: 'failed',
        active: false,
        retryCount: 3,
        statusCode: 503,
      });
    });

    expect(record).toMatchObject({
      component: 'api',
      outcome: 'failed',
      active: false,
      retryCount: 3,
      statusCode: 503,
    });
  });

  it('reduces raw errors and sensitive messages to non-secret metadata', () => {
    const record = captureRecord((logger) => {
      logger.error(
        new Error('Redis failed at redis://user:password@192.0.2.10:6379'),
        'Request from 192.0.2.11 failed',
      );
    });

    expect(record).toMatchObject({
      err: { type: 'Error' },
      msg: SAFE_LOG_CENSOR,
    });
    expect(JSON.stringify(record)).not.toMatch(
      /password|192\.0\.2\.10|192\.0\.2\.11|redis:\/\//,
    );
  });

  it.each(['request', 'response', 'error'] as const)(
    'emits one minimal line when the %s serializer encounters a throwing getter',
    (field) => {
      const dangerous = Object.create(null) as Record<string, unknown>;
      const property =
        field === 'request'
          ? 'method'
          : field === 'response'
            ? 'statusCode'
            : 'type';
      Object.defineProperty(dangerous, property, {
        enumerable: true,
        get() {
          throw new Error(
            'getter-secret redis://user:password@192.0.2.20:6379',
          );
        },
      });

      const { line, record } = captureLine((logger) => {
        expect(() => logger.info({ [field]: dangerous })).not.toThrow();
      });

      expect(line.endsWith('\n')).toBe(true);
      expect(line.trimEnd().split('\n')).toHaveLength(1);
      expect(record).toMatchObject({
        sanitizationFailure: true,
        msg: SAFE_LOG_CENSOR,
      });
      expect(line).not.toMatch(
        /getter-secret|password|192\.0\.2\.20|redis:\/\//,
      );
    },
  );

  it('emits one minimal valid JSON line for a throwing Proxy', () => {
    const dangerous = new Proxy(
      Object.create(null) as Record<string, unknown>,
      {
        ownKeys() {
          throw new Error(
            'proxy-secret https://sub.example.test/sub/proxy-token at ::1',
          );
        },
      },
    );

    const { line, record } = captureLine((logger) => {
      expect(() => logger.warn({ nested: { dangerous } })).not.toThrow();
    });

    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().split('\n')).toHaveLength(1);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(record).toMatchObject({
      sanitizationFailure: true,
      msg: SAFE_LOG_CENSOR,
    });
    expect(line).not.toMatch(/proxy-secret|sub\.example|proxy-token|::1/);
  });

  it('emits one minimal line when child bindings are a throwing Proxy', () => {
    const dangerousBindings = new Proxy(
      Object.create(null) as Record<string, unknown>,
      {
        ownKeys() {
          throw new Error(
            'child-proxy-secret redis://user:password@192.0.2.31:6379',
          );
        },
      },
    );

    const { line, record } = captureLine((logger) => {
      expect(() =>
        logger
          .child(dangerousBindings)
          .info(
            { component: 'must-not-survive' },
            'caller message must not survive',
          ),
      ).not.toThrow();
    });

    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().split('\n')).toHaveLength(1);
    expect(record).toMatchObject({
      sanitizationFailure: true,
      msg: SAFE_LOG_CENSOR,
    });
    expect(line.match(/"sanitizationFailure"/g) ?? []).toHaveLength(1);
    expect(line.match(/"msg"/g) ?? []).toHaveLength(1);
    expect(line).not.toMatch(
      /child-proxy-secret|password|192\.0\.2\.31|redis:\/\/|must-not-survive|caller message/,
    );
  });

  it('sanitizes child bindings at the final output boundary', () => {
    const record = captureRecord((logger) => {
      logger
        .child({
          component: 'node-agent',
          nodeId: 'dfda0318-8f9a-49a5-9072-58acc6d23be6',
        })
        .info({ outcome: 'already-applied' }, 'Cycle completed');
    });

    expect(record).toMatchObject({
      component: 'node-agent',
      nodeId: SAFE_LOG_CENSOR,
      outcome: 'already-applied',
    });
    expect(JSON.stringify(record)).not.toContain(
      'dfda0318-8f9a-49a5-9072-58acc6d23be6',
    );
  });
});
