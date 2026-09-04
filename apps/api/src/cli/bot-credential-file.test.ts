import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertBotCredentialTarget,
  installBotCredential,
  readInstalledBotCredential,
} from './bot-credential-file';

describe('bot credential file installer', () => {
  it('creates and atomically replaces a strict private credential file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bot-credential-file-'));
    const path = join(directory, 'bot-credential');
    const first = {
      formatVersion: 1 as const,
      credentialId: '550e8400-e29b-41d4-a716-446655440000',
      signingKey: 'A'.repeat(43),
    };
    const second = {
      ...first,
      credentialId: '8a7cb6d5-a9b0-4f32-a327-e342a2a57819',
      signingKey: 'B'.repeat(43),
    };
    try {
      await installBotCredential(path, first, false);
      await expect(assertBotCredentialTarget(path, false)).rejects.toThrow(
        /already exists/,
      );
      expect(await readInstalledBotCredential(path)).toEqual(first);

      await installBotCredential(path, second, true);
      expect(await readInstalledBotCredential(path)).toEqual(second);
      expect(await readFile(path, 'utf8')).not.toContain(first.signingKey);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed existing material instead of replacing it blindly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bot-credential-file-'));
    const path = join(directory, 'bot-credential');
    try {
      await writeFile(path, 'malformed\n', { mode: 0o600 });
      await expect(readInstalledBotCredential(path)).rejects.toThrow(/invalid/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
