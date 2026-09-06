import {
  issueTelegramAuthChallengeRequestSchema,
  issuedTelegramAuthChallengeSchema,
} from '@vpn-platform/contracts';

import type { BotRequestSigner } from './bot-api-client';

const CHALLENGE_PATH = '/auth/telegram/challenge';
const LAUNCH_COMMAND = /^\/(?:start|cabinet)(?:@[a-z0-9_]+)?$/i;

export type TelegramLoginLaunchResult =
  | { kind: 'issued'; launchId: string; expiresAt: string }
  | { kind: 'rejected' }
  | { kind: 'unavailable' };

export type TelegramLoginLaunchReply = {
  text: string;
  miniAppUrl?: string;
};

export class TelegramLoginLaunchClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly signer: BotRequestSigner,
    private readonly request: typeof fetch = fetch,
  ) {}

  async issue(input: {
    telegramUserId: string;
    updateId: number;
  }): Promise<TelegramLoginLaunchResult> {
    const body = Buffer.from(
      JSON.stringify(
        issueTelegramAuthChallengeRequestSchema.parse({
          telegramUserId: input.telegramUserId,
        }),
      ),
    );
    const signed = this.signer.sign({
      method: 'POST',
      path: CHALLENGE_PATH,
      telegramUserId: input.telegramUserId,
      idempotencyKey: `telegram-challenge-${input.updateId}`,
      body,
    });

    let response: Response;
    try {
      response = await this.request(`${this.apiBaseUrl}${CHALLENGE_PATH}`, {
        method: 'POST',
        headers: { ...signed.headers, 'content-type': 'application/json' },
        body: signed.body,
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return { kind: 'unavailable' };
    }

    if (response.status === 201) {
      try {
        const challenge = issuedTelegramAuthChallengeSchema.parse(
          await response.json(),
        );
        return { kind: 'issued', ...challenge };
      } catch {
        return { kind: 'unavailable' };
      }
    }
    if ([400, 401, 409].includes(response.status)) {
      return { kind: 'rejected' };
    }
    return { kind: 'unavailable' };
  }
}

export async function handleLoginLaunchMessage(
  input: { text: string; telegramUserId: string; updateId: number },
  client: Pick<TelegramLoginLaunchClient, 'issue'>,
  miniAppBaseUrl: string,
): Promise<TelegramLoginLaunchReply | null> {
  if (!LAUNCH_COMMAND.test(input.text.trim())) return null;

  const result = await client.issue({
    telegramUserId: input.telegramUserId,
    updateId: input.updateId,
  });
  if (result.kind === 'rejected') {
    return { text: 'Кабинет пока недоступен.' };
  }
  if (result.kind === 'unavailable') {
    return { text: 'Сервис временно недоступен. Попробуйте позже.' };
  }

  const url = new URL(miniAppBaseUrl);
  url.searchParams.set('startapp', result.launchId);
  return {
    text: 'Откройте кабинет. После появления кода отправьте его сюда.',
    miniAppUrl: url.toString(),
  };
}
