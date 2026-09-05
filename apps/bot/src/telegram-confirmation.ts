import {
  confirmedTelegramLoginSchema,
  confirmTelegramLoginRequestSchema,
} from '@vpn-platform/contracts';

import type { BotRequestSigner } from './bot-api-client';

const CONFIRM_PATH = '/auth/telegram/confirm';
const CROCKFORD_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export type ConfirmationResult = 'confirmed' | 'rejected' | 'unavailable';

const USER_REPLIES = {
  confirmed: 'Вход подтверждён. Вернитесь в кабинет.',
  rejected: 'Не удалось подтвердить код. Проверьте код или запросите новый.',
  unavailable: 'Сервис временно недоступен. Попробуйте позже.',
} as const satisfies Record<ConfirmationResult, string>;

export function parseConfirmationCode(text: string): string | null {
  const normalized = text.trim();
  const command = /^\/confirm(?:@[a-z0-9_]+)?\s+(.+)$/i.exec(normalized);
  const candidate = (command?.[1] ?? normalized)
    .trim()
    .toUpperCase()
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replaceAll('O', '0');
  return CROCKFORD_CODE.test(candidate) ? candidate : null;
}

export class TelegramConfirmationClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly signer: BotRequestSigner,
    private readonly request: typeof fetch = fetch,
  ) {}

  async confirm(input: {
    telegramUserId: string;
    confirmationCode: string;
    updateId: number;
  }): Promise<ConfirmationResult> {
    const body = Buffer.from(
      JSON.stringify(
        confirmTelegramLoginRequestSchema.parse({
          telegramUserId: input.telegramUserId,
          confirmationCode: input.confirmationCode,
        }),
      ),
    );
    const signed = this.signer.sign({
      method: 'POST',
      path: CONFIRM_PATH,
      telegramUserId: input.telegramUserId,
      idempotencyKey: `telegram-update-${input.updateId}`,
      body,
    });

    let response: Response;
    try {
      response = await this.request(`${this.apiBaseUrl}${CONFIRM_PATH}`, {
        method: 'POST',
        headers: { ...signed.headers, 'content-type': 'application/json' },
        body: signed.body,
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return 'unavailable';
    }
    if (response.status === 200) {
      try {
        confirmedTelegramLoginSchema.parse(await response.json());
        return 'confirmed';
      } catch {
        return 'unavailable';
      }
    }
    if ([400, 401, 404].includes(response.status)) return 'rejected';
    return 'unavailable';
  }
}

export async function handleConfirmationMessage(
  input: { text: string; telegramUserId: string; updateId: number },
  client: Pick<TelegramConfirmationClient, 'confirm'>,
): Promise<string | null> {
  const confirmationCode = parseConfirmationCode(input.text);
  if (!confirmationCode) return null;
  const result = await client.confirm({
    telegramUserId: input.telegramUserId,
    confirmationCode,
    updateId: input.updateId,
  });
  return USER_REPLIES[result];
}
