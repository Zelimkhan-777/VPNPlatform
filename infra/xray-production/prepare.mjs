import { access, chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const template = join(root, 'infra', 'xray-production', 'config.template.json');
const stateDirectory =
  process.env.VPN_NODE_STATE_DIRECTORY?.trim() || 'vpn-fi-01';
if (!/^[a-z0-9][a-z0-9-]*$/.test(stateDirectory)) {
  throw new Error(
    'VPN_NODE_STATE_DIRECTORY must contain only lowercase letters, digits, and hyphens',
  );
}
const runtimeDirectory = join(root, 'var', stateDirectory);
const runtimeConfig = join(runtimeDirectory, 'xray-config.json');

await mkdir(runtimeDirectory, { recursive: true });
try {
  await access(runtimeConfig);
} catch {
  await copyFile(template, runtimeConfig);
}
await chmod(runtimeConfig, 0o640);
