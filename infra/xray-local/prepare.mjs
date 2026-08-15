import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeDirectory = join(root, 'var', 'xray-local');
const runtimeConfig = join(runtimeDirectory, 'config.json');
const template = join(root, 'infra', 'xray-local', 'config.template.json');

await mkdir(runtimeDirectory, { recursive: true });
try {
  await access(runtimeConfig);
} catch {
  await copyFile(template, runtimeConfig);
}
