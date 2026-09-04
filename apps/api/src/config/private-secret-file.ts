import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function readPrivateSecretFile(
  path: string,
  pattern: RegExp,
  label: string,
  rootOwnedGroupId?: number,
): string {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} file type is invalid`);
  }
  if (process.platform !== 'win32') {
    const currentUid = process.getuid?.();
    if (rootOwnedGroupId === undefined) {
      if (currentUid === undefined || stats.uid !== currentUid) {
        throw new Error(`${label} file owner is invalid`);
      }
      if ((stats.mode & 0o077) !== 0) {
        throw new Error(`${label} file permissions are invalid`);
      }
    } else {
      const groups = process.getgroups?.() ?? [];
      if (
        stats.uid !== 0 ||
        stats.gid !== rootOwnedGroupId ||
        (stats.mode & 0o777) !== 0o440 ||
        !groups.includes(rootOwnedGroupId)
      ) {
        throw new Error(`${label} root-owned group access is invalid`);
      }
    }
  }
  const content = readFileSync(path, 'utf8');
  if (!pattern.test(content)) throw new Error(`${label} value is invalid`);
  return content.endsWith('\n') ? content.slice(0, -1) : content;
}
