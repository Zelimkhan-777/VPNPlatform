import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const template = join(root, 'infra', 'xray-production', 'config.template.json');
const runtimeDirectory = join(root, 'var', 'vpn-fi-01');
const runtimeConfig = join(runtimeDirectory, 'xray-config.json');

await mkdir(runtimeDirectory, { recursive: true });
try {
  await access(runtimeConfig);
} catch {
  await copyFile(template, runtimeConfig);
}
