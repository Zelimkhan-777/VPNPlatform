import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const dockerExecutable = process.platform === 'win32' ? 'docker.exe' : 'docker';
const shellCheckImage =
  'koalaman/shellcheck-alpine@sha256:9955be09ea7f0dbf7ae942ac1f2094355bb30d96fffba0ec09f5432207544002';

const scripts = globSync('infra/**/*.sh', {
  cwd: repositoryRoot,
}).sort();

assert.ok(scripts.length > 0, 'No infrastructure shell scripts were found.');

const result = spawnSync(
  dockerExecutable,
  [
    'run',
    '--rm',
    '--entrypoint',
    'shellcheck',
    '--volume',
    `${repositoryRoot}:/mnt:ro`,
    shellCheckImage,
    ...scripts.map((script) => `/mnt/${script.replaceAll('\\', '/')}`),
  ],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
  },
);

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}

assert.equal(
  result.status,
  0,
  `ShellCheck failed for ${scripts.length} infrastructure scripts.`,
);
process.stdout.write(
  `SHELLCHECK_OK image=${shellCheckImage} scripts=${scripts.length}\n`,
);
