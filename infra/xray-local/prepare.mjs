import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const template = join(root, 'infra', 'xray-local', 'config.template.json');
const instances = ['a', 'b'];

for (const instance of instances) {
  const runtimeDirectory = join(root, 'var', 'xray-local', instance);
  const runtimeConfig = join(runtimeDirectory, 'config.json');
  await mkdir(runtimeDirectory, { recursive: true });
  try {
    await access(runtimeConfig);
  } catch {
    await copyFile(template, runtimeConfig);
  }
}
