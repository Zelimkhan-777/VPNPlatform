import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  TelegramInitDataValidationError,
  verifyTelegramInitData,
} from './telegram-init-data';

const botToken = '123456:telegram-auth-test-token';
const now = new Date('2026-08-10T12:00:00.000Z');

function signedInitData(values: Record<string, string>): string {
  const parameters = new URLSearchParams(values);
  const dataCheckString = [...parameters.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const hash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  parameters.set('hash', hash);
  return parameters.toString();
}

describe('verifyTelegramInitData', () => {
  it('verifies signed init data and returns a canonical replay key', () => {
    const initData = signedInitData({
      auth_date: '1786363200',
      query_id: 'test-query',
      start_param: 'a'.repeat(43),
      user: JSON.stringify({ id: 123456789, username: 'ignored' }),
    });

    expect(verifyTelegramInitData(initData, botToken, 300, now)).toEqual(
      expect.objectContaining({ id: '123456789' }),
    );
    expect(verifyTelegramInitData(initData, botToken, 300, now).replayKey).toBe(
      'auth_date=1786363200\nquery_id=test-query\nuser={"id":123456789,"username":"ignored"}',
    );
  });

  it('rejects a tampered signature', () => {
    const initData = signedInitData({
      auth_date: '1786363200',
      user: JSON.stringify({ id: 123456789 }),
      start_param: 'a'.repeat(43),
    }).replace('hash=', 'hash=0');

    expect(() => verifyTelegramInitData(initData, botToken, 300, now)).toThrow(
      TelegramInitDataValidationError,
    );
  });

  it('rejects expired init data', () => {
    const initData = signedInitData({
      auth_date: '1786362800',
      user: JSON.stringify({ id: 123456789 }),
      start_param: 'a'.repeat(43),
    });

    expect(() => verifyTelegramInitData(initData, botToken, 300, now)).toThrow(
      'Telegram init data has expired',
    );
  });

  it('rejects duplicate security parameters', () => {
    const initData = `${signedInitData({
      auth_date: '1786363200',
      user: JSON.stringify({ id: 123456789 }),
      start_param: 'a'.repeat(43),
    })}&auth_date=1786363200`;

    expect(() => verifyTelegramInitData(initData, botToken, 300, now)).toThrow(
      'Telegram init data is malformed',
    );
  });
});
