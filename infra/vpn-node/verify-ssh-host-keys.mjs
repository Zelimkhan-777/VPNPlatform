import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_SSH_FINGERPRINT_RELATIVE_PATH,
  collectPresentedSshFingerprints,
  compareSshFingerprints,
  parseExpectedSshFingerprints,
} from './ssh-host-key-verify.mjs';

function repositoryRoot() {
  return fileURLToPath(new URL('../..', import.meta.url));
}

function readArguments(argv) {
  let stateDirectory;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') continue;
    if (flag === '--state-directory') {
      stateDirectory = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown SSH verify flag: ${flag}`);
  }
  if (!stateDirectory || !/^[a-z0-9][a-z0-9-]*$/.test(stateDirectory)) {
    throw new Error('SSH verify requires a leaf --state-directory');
  }
  return { stateDirectory };
}

function readHost(environment, bootstrap) {
  const fromEnv = environment.VPN_PL_ENDPOINT_HOST?.trim();
  if (fromEnv) return fromEnv;
  const host = bootstrap?.endpoint?.host;
  if (typeof host === 'string' && host.trim()) return host.trim();
  throw new Error('SSH verify host is missing from env or bootstrap.json');
}

function scanHostKeys(host) {
  const result = spawnSync(
    'ssh-keyscan',
    ['-T', '10', '-t', 'ed25519,rsa', host],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error('SSH host key scan failed');
  }
  return result.stdout;
}

async function main() {
  if (process.env.SSH_STRICT_HOST_KEY_CHECKING === 'no') {
    throw new Error('Refusing to run while StrictHostKeyChecking is disabled');
  }
  const args = readArguments(process.argv.slice(2));
  const root = repositoryRoot();
  const stateDirectory = join(root, 'var', args.stateDirectory);
  const expectedPath = join(
    stateDirectory,
    EXPECTED_SSH_FINGERPRINT_RELATIVE_PATH,
  );
  let expectedRaw;
  try {
    expectedRaw = await readFile(expectedPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(
        'Provider-console SSH fingerprints file is missing; paste ED25519 and RSA SHA256 fingerprints into the gitignored expected-ssh-fingerprints.json before connecting',
      );
    }
    throw error;
  }

  let bootstrap = null;
  try {
    bootstrap = JSON.parse(
      await readFile(join(stateDirectory, 'bootstrap.json'), 'utf8'),
    );
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  const host = readHost(process.env, bootstrap);
  if (isAbsolute(host) || host.includes('\\') || host.includes(' ')) {
    throw new Error('SSH verify host is invalid');
  }
  const expected = parseExpectedSshFingerprints(expectedRaw);
  const presented = collectPresentedSshFingerprints(scanHostKeys(host));
  const result = compareSshFingerprints(expected, presented);
  process.stdout.write(
    `SSH_HOST_KEY_MATCHED types=${result.matched.join(',')} accepted=${String(result.accepted)}\n`,
  );
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'SSH host key verify failed'}\n`,
  );
  process.exitCode = 1;
});
