import { createCipheriv, createDecipheriv } from 'node:crypto';

const algorithm = 'aes-256-gcm';
const keyByteLength = 32;
const nonceByteLength = 12;
const authenticationTagByteLength = 16;

export interface BotSigningKeyEnvelopeContext {
  credentialId: string;
  principalId: string;
  keyVersion: number;
}

export interface EncryptedBotSigningKey {
  keyCiphertext: string;
  nonce: string;
}

export function encryptBotSigningKey(
  signingKey: Buffer,
  encodedKek: string,
  context: BotSigningKeyEnvelopeContext,
  nonce: Buffer,
): EncryptedBotSigningKey {
  if (signingKey.length !== keyByteLength || nonce.length !== nonceByteLength) {
    throw new Error('Bot signing key material is invalid');
  }
  const kek = decodeKey(encodedKek);
  try {
    const cipher = createCipheriv(algorithm, kek, nonce, {
      authTagLength: authenticationTagByteLength,
    });
    cipher.setAAD(envelopeAad(context));
    const ciphertext = Buffer.concat([
      cipher.update(signingKey),
      cipher.final(),
    ]);
    return {
      keyCiphertext: `${ciphertext.toString('base64url')}.${cipher
        .getAuthTag()
        .toString('base64url')}`,
      nonce: nonce.toString('base64url'),
    };
  } finally {
    kek.fill(0);
  }
}

export function decryptBotSigningKey(
  encrypted: EncryptedBotSigningKey,
  encodedKek: string,
  context: BotSigningKeyEnvelopeContext,
): Buffer {
  const kek = decodeKey(encodedKek);
  try {
    const nonce = decodeBase64Url(encrypted.nonce, nonceByteLength);
    const [ciphertextValue, authenticationTagValue, extra] =
      encrypted.keyCiphertext.split('.');
    if (!ciphertextValue || !authenticationTagValue || extra !== undefined) {
      throw new Error('Bot signing key envelope is invalid');
    }
    const ciphertext = decodeBase64Url(ciphertextValue, keyByteLength);
    const authenticationTag = decodeBase64Url(
      authenticationTagValue,
      authenticationTagByteLength,
    );
    const decipher = createDecipheriv(algorithm, kek, nonce, {
      authTagLength: authenticationTagByteLength,
    });
    decipher.setAAD(envelopeAad(context));
    decipher.setAuthTag(authenticationTag);
    const signingKey = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (signingKey.length !== keyByteLength) {
      signingKey.fill(0);
      throw new Error('Bot signing key plaintext is invalid');
    }
    return signingKey;
  } finally {
    kek.fill(0);
  }
}

function decodeKey(value: string): Buffer {
  return decodeBase64Url(value, keyByteLength);
}

function decodeBase64Url(value: string, expectedLength: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Encoded bot signing key material is invalid');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.length !== expectedLength ||
    decoded.toString('base64url') !== value
  ) {
    decoded.fill(0);
    throw new Error('Encoded bot signing key material is invalid');
  }
  return decoded;
}

function envelopeAad(context: BotSigningKeyEnvelopeContext): Buffer {
  return Buffer.from(
    [
      'bot-signing-key-envelope-v1',
      context.credentialId,
      context.principalId,
      String(context.keyVersion),
    ].join('\0'),
    'utf8',
  );
}
