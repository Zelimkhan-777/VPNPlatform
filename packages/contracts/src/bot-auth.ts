import { z } from 'zod';

export const BOT_AUTH_HEADER_NAMES = {
  credentialId: 'x-bot-credential-id',
  idempotencyKey: 'idempotency-key',
  nonce: 'x-bot-nonce',
  signature: 'x-bot-signature',
  timestamp: 'x-bot-timestamp',
} as const;

export const botCredentialIdSchema = z.string().uuid();
export const botRequestTimestampSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,10})$/);
export const botRequestNonceSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const botRequestSignatureSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const botRequestIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/);
export const botTelegramUserIdSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[1-9]\d*$/);
export const botRequestMethodSchema = z
  .string()
  .min(3)
  .max(12)
  .regex(/^[A-Z]+$/);
export const botRequestPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\/[^?#\r\n]*$/);
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const botSigningKeySchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

export const botCredentialFileSchema = z
  .object({
    formatVersion: z.literal(1),
    credentialId: botCredentialIdSchema,
    signingKey: botSigningKeySchema,
  })
  .strict();

export const botSignedRequestHeadersSchema = z
  .object({
    credentialId: botCredentialIdSchema,
    idempotencyKey: botRequestIdempotencyKeySchema,
    nonce: botRequestNonceSchema,
    signature: botRequestSignatureSchema,
    timestamp: botRequestTimestampSchema,
  })
  .strict();

export const botTelegramIdentitySchema = z
  .object({ telegramUserId: botTelegramUserIdSchema })
  .passthrough();

export interface BotRequestCanonicalInput {
  credentialId: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  telegramUserId: string;
  idempotencyKey: string;
  rawBodySha256: string;
}

export function createBotRequestCanonicalString(
  input: BotRequestCanonicalInput,
): string {
  return [
    input.credentialId,
    input.method,
    input.path,
    input.timestamp,
    input.nonce,
    input.telegramUserId,
    input.idempotencyKey,
    input.rawBodySha256,
  ].join('\n');
}

export type BotSignedRequestHeaders = z.infer<
  typeof botSignedRequestHeadersSchema
>;

export type BotCredentialFile = z.infer<typeof botCredentialFileSchema>;

export function serializeBotCredentialFile(
  credential: BotCredentialFile,
): string {
  return `${JSON.stringify(botCredentialFileSchema.parse(credential))}\n`;
}

export function parseBotCredentialFile(content: string): BotCredentialFile {
  if (!content.endsWith('\n') || content.slice(0, -1).includes('\n')) {
    throw new Error('Bot credential file must contain one JSON line');
  }
  try {
    return botCredentialFileSchema.parse(JSON.parse(content.slice(0, -1)));
  } catch {
    throw new Error('Bot credential file is invalid');
  }
}
