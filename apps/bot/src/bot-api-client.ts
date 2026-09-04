import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  BOT_AUTH_HEADER_NAMES,
  botCredentialIdSchema,
  botRequestIdempotencyKeySchema,
  botRequestMethodSchema,
  botRequestNonceSchema,
  botRequestPathSchema,
  botTelegramUserIdSchema,
  createBotRequestCanonicalString,
  parseBotCredentialFile,
  type BotCredentialFile,
} from '@vpn-platform/contracts';

export interface BotSignedRequest {
  body: Buffer;
  headers: Record<string, string>;
}

export interface BotRequestSignerOptions {
  now?: () => number;
  nonce?: () => string;
}

export class BotRequestSigner {
  private destroyed = false;
  private readonly signingKey: Buffer;
  private readonly now: () => number;
  private readonly nonce: () => string;

  constructor(
    private readonly credentialId: string,
    encodedSigningKey: string,
    options: BotRequestSignerOptions = {},
  ) {
    this.credentialId = botCredentialIdSchema.parse(credentialId);
    this.signingKey = Buffer.from(encodedSigningKey, 'base64url');
    if (
      this.signingKey.length !== 32 ||
      this.signingKey.toString('base64url') !== encodedSigningKey
    ) {
      this.signingKey.fill(0);
      throw new Error('Bot signing configuration is invalid');
    }
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(24).toString('base64url'));
  }

  sign(input: {
    method: string;
    path: string;
    telegramUserId: string;
    idempotencyKey: string;
    body: Buffer;
  }): BotSignedRequest {
    if (this.destroyed) throw new Error('Bot request signer is destroyed');
    const method = botRequestMethodSchema.parse(input.method);
    const path = botRequestPathSchema.parse(input.path);
    const telegramUserId = botTelegramUserIdSchema.parse(input.telegramUserId);
    const idempotencyKey = botRequestIdempotencyKeySchema.parse(
      input.idempotencyKey,
    );
    const timestamp = String(Math.floor(this.now() / 1_000));
    const nonce = botRequestNonceSchema.parse(this.nonce());
    const rawBodySha256 = createHash('sha256').update(input.body).digest('hex');
    const signature = createHmac('sha256', this.signingKey)
      .update(
        createBotRequestCanonicalString({
          credentialId: this.credentialId,
          method,
          path,
          timestamp,
          nonce,
          telegramUserId,
          idempotencyKey,
          rawBodySha256,
        }),
      )
      .digest('hex');

    return {
      body: input.body,
      headers: {
        [BOT_AUTH_HEADER_NAMES.credentialId]: this.credentialId,
        [BOT_AUTH_HEADER_NAMES.idempotencyKey]: idempotencyKey,
        [BOT_AUTH_HEADER_NAMES.nonce]: nonce,
        [BOT_AUTH_HEADER_NAMES.signature]: signature,
        [BOT_AUTH_HEADER_NAMES.timestamp]: timestamp,
      },
    };
  }

  destroy(): void {
    this.signingKey.fill(0);
    this.destroyed = true;
  }
}

export function readBotCredentialFile(
  path: string,
  rootOwnedGroupId?: number,
): BotCredentialFile {
  if (!isAbsolute(path))
    throw new Error('Bot credential path must be absolute');
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Bot credential file type is invalid');
  }
  if (process.platform !== 'win32') {
    const currentUid = process.getuid?.();
    if (rootOwnedGroupId === undefined) {
      if (currentUid === undefined || stats.uid !== currentUid) {
        throw new Error('Bot credential file owner is invalid');
      }
      if ((stats.mode & 0o077) !== 0) {
        throw new Error('Bot credential file permissions are invalid');
      }
    } else {
      const groups = process.getgroups?.() ?? [];
      if (
        stats.uid !== 0 ||
        stats.gid !== rootOwnedGroupId ||
        (stats.mode & 0o777) !== 0o440 ||
        !groups.includes(rootOwnedGroupId)
      ) {
        throw new Error('Bot credential root-owned group access is invalid');
      }
    }
  }
  return parseBotCredentialFile(readFileSync(path, 'utf8'));
}

export function createBotRequestSignerFromFile(
  path: string,
  rootOwnedGroupId?: number,
  options?: BotRequestSignerOptions,
): BotRequestSigner {
  const credential = readBotCredentialFile(path, rootOwnedGroupId);
  return new BotRequestSigner(
    credential.credentialId,
    credential.signingKey,
    options,
  );
}
