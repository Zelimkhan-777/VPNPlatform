import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function fail(code) {
  throw new Error(code);
}

export async function readValidatedBotSigningKek(path, rootOwnedGroupId) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) fail('invalid-bot-kek-type');
  if (process.platform !== 'win32') {
    if (rootOwnedGroupId === undefined) {
      if (stats.uid !== process.getuid()) fail('invalid-bot-kek-owner');
      if ((stats.mode & 0o077) !== 0) fail('insecure-bot-kek-mode');
    } else if (
      stats.uid !== 0 ||
      stats.gid !== rootOwnedGroupId ||
      (stats.mode & 0o777) !== 0o440
    ) {
      fail('invalid-bot-kek-group-access');
    }
  }
  const content = await readFile(path, 'utf8');
  if (!/^[A-Za-z0-9_-]{43}\n$/.test(content)) fail('invalid-bot-kek-value');
  return content.slice(0, -1);
}

export async function validateInstalledBotCredential(path, rootOwnedGroupId) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink())
    fail('invalid-bot-credential-type');
  if (process.platform !== 'win32') {
    if (rootOwnedGroupId === undefined) {
      if (stats.uid !== process.getuid()) fail('invalid-bot-credential-owner');
      if ((stats.mode & 0o077) !== 0) fail('insecure-bot-credential-mode');
    } else if (
      stats.uid !== 0 ||
      stats.gid !== rootOwnedGroupId ||
      (stats.mode & 0o777) !== 0o440
    ) {
      fail('invalid-bot-credential-group-access');
    }
  }
  const content = await readFile(path, 'utf8');
  if (!content.endsWith('\n') || content.slice(0, -1).includes('\n'))
    fail('invalid-bot-credential-value');
  let parsed;
  try {
    parsed = JSON.parse(content.slice(0, -1));
  } catch {
    fail('invalid-bot-credential-value');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !==
      'credentialId,formatVersion,signingKey' ||
    parsed.formatVersion !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      parsed.credentialId,
    ) ||
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.signingKey)
  ) {
    fail('invalid-bot-credential-value');
  }
  return true;
}

export async function createBotSigningKek(path, rootOwnedGroupId) {
  try {
    await lstat(path);
    fail('bot-kek-already-exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const directory = dirname(path);
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    fail('invalid-platform-secret-directory-type');
  }
  if (process.platform !== 'win32') {
    if (directoryStats.uid !== process.getuid())
      fail('invalid-platform-secret-directory-owner');
    if ((directoryStats.mode & 0o077) !== 0)
      fail('insecure-platform-secret-directory-mode');
  }

  const temporaryPath = join(
    directory,
    `.bot-signing-kek.${process.pid}.${randomUUID()}.tmp`,
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
      await handle.writeFile(`${randomBytes(32).toString('base64url')}\n`);
      if (rootOwnedGroupId !== undefined) {
        await handle.chown(0, rootOwnedGroupId);
        await handle.chmod(0o440);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, path);
    await unlink(temporaryPath);
    temporaryCreated = false;
    const directoryHandle = await open(directory, constants.O_RDONLY);
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
    await readValidatedBotSigningKek(path, rootOwnedGroupId);
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
  }
}
