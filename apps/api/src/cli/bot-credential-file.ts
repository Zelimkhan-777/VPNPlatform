import { constants } from 'node:fs';
import { link, lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  parseBotCredentialFile,
  serializeBotCredentialFile,
  type BotCredentialFile,
} from '@vpn-platform/contracts';

export async function readInstalledBotCredential(
  path: string,
  rootOwnedGroupId?: number,
): Promise<BotCredentialFile> {
  await assertCredentialPath(path, true, rootOwnedGroupId);
  const handle = await open(path, constants.O_RDONLY);
  try {
    return parseBotCredentialFile(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

export async function installBotCredential(
  path: string,
  credential: BotCredentialFile,
  replace: boolean,
  rootOwnedGroupId?: number,
): Promise<void> {
  await assertCredentialPath(path, replace, rootOwnedGroupId);
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.bot-credential.${process.pid}.${randomUUID()}.tmp`,
  );
  const backupPath = join(
    directory,
    `.bot-credential.${process.pid}.${randomUUID()}.previous`,
  );
  let temporaryCreated = false;
  let backupCreated = false;
  let targetReplaced = false;
  try {
    if (replace) {
      await link(path, backupPath);
      backupCreated = true;
    }
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryCreated = true;
    try {
      await handle.writeFile(serializeBotCredentialFile(credential), 'utf8');
      if (rootOwnedGroupId !== undefined) {
        await handle.chown(0, rootOwnedGroupId);
        await handle.chmod(0o440);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    temporaryCreated = false;
    targetReplaced = true;
    await syncDirectory(directory);
    if (backupCreated) {
      await unlink(backupPath);
      backupCreated = false;
    }
  } catch (error) {
    if (targetReplaced && backupCreated) {
      await rename(backupPath, path);
      backupCreated = false;
      await syncDirectory(directory);
    } else if (targetReplaced && !replace) {
      await unlink(path).catch(() => undefined);
      await syncDirectory(directory).catch(() => undefined);
    }
    throw error;
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    if (backupCreated) await unlink(backupPath).catch(() => undefined);
  }
}

export async function assertBotCredentialTarget(
  path: string,
  mustExist: boolean,
  rootOwnedGroupId?: number,
): Promise<void> {
  await assertCredentialPath(path, mustExist, rootOwnedGroupId);
}

async function assertCredentialPath(
  path: string,
  mustExist: boolean,
  rootOwnedGroupId?: number,
) {
  if (!isAbsolute(path))
    throw new Error('Bot credential path must be absolute');
  const directoryStats = await lstat(dirname(path));
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error('Bot credential directory type is invalid');
  }
  const currentUid = process.getuid?.();
  if (process.platform !== 'win32') {
    if (rootOwnedGroupId === undefined) {
      if ((directoryStats.mode & 0o077) !== 0) {
        throw new Error('Bot credential directory permissions are invalid');
      }
      if (currentUid === undefined || directoryStats.uid !== currentUid) {
        throw new Error('Bot credential directory owner is invalid');
      }
    } else if (
      directoryStats.uid !== 0 ||
      directoryStats.gid !== rootOwnedGroupId ||
      (directoryStats.mode & 0o777) !== 0o750
    ) {
      throw new Error('Bot credential directory group access is invalid');
    }
  }
  try {
    const targetStats = await lstat(path);
    if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
      throw new Error('Bot credential file type is invalid');
    }
    if (process.platform !== 'win32') {
      if (rootOwnedGroupId === undefined) {
        if ((targetStats.mode & 0o077) !== 0) {
          throw new Error('Bot credential file permissions are invalid');
        }
        if (currentUid === undefined || targetStats.uid !== currentUid) {
          throw new Error('Bot credential file owner is invalid');
        }
      } else if (
        targetStats.uid !== 0 ||
        targetStats.gid !== rootOwnedGroupId ||
        (targetStats.mode & 0o777) !== 0o440
      ) {
        throw new Error('Bot credential file group access is invalid');
      }
    }
    if (!mustExist) throw new Error('Bot credential file already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (mustExist) throw new Error('Bot credential file does not exist');
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, constants.O_RDONLY);
  try {
    try {
      await directoryHandle.sync();
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        (error as NodeJS.ErrnoException).code !== 'EPERM'
      ) {
        throw error;
      }
    }
  } finally {
    await directoryHandle.close();
  }
}
