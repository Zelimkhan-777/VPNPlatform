import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  constants,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

const fullCommitPattern = /^[0-9a-f]{40}$/;

function fail(code) {
  process.stderr.write(`RELEASE_BUNDLE_ERROR code=${code}\n`);
  process.exitCode = 1;
  throw new Error(code);
}

function runGit(repository, arguments_, options = {}) {
  const result = spawnSync('git', ['-C', repository, ...arguments_], {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    if (options.allowFailure) return null;
    fail(options.code ?? 'git-command-failed');
  }
  return result.stdout.trim();
}

function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!value || value.startsWith('-')) fail('invalid-arguments');
    if (option === '--commit') values.commit = value;
    else if (option === '--output-directory') values.outputDirectory = value;
    else if (option === '--repository') values.repository = value;
    else fail('invalid-arguments');
  }
  if (!values.commit || !values.outputDirectory) fail('invalid-arguments');
  return values;
}

async function mustNotExist(path, code) {
  try {
    await access(path, constants.F_OK);
    fail(code);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function publishNoReplace(temporaryPath, finalPath) {
  await link(temporaryPath, finalPath);
  await unlink(temporaryPath);
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  if (!fullCommitPattern.test(input.commit)) fail('invalid-commit');
  if (!isAbsolute(input.outputDirectory)) fail('invalid-output-directory');

  const repository = await realpath(resolve(input.repository ?? process.cwd()));
  const outputDirectory = resolve(input.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const canonicalOutput = await realpath(outputDirectory);
  const outputRelative = relative(repository, canonicalOutput);
  if (
    outputRelative === '' ||
    (!outputRelative.startsWith('..') && !isAbsolute(outputRelative))
  ) {
    fail('output-inside-repository');
  }

  const repositoryRoot = runGit(repository, ['rev-parse', '--show-toplevel'], {
    capture: true,
    code: 'not-a-git-repository',
  });
  if ((await realpath(repositoryRoot)) !== repository)
    fail('unexpected-repository-root');
  if (
    runGit(repository, ['diff', '--quiet'], { allowFailure: true }) === null
  ) {
    fail('dirty-tracked-checkout');
  }
  if (
    runGit(repository, ['diff', '--cached', '--quiet'], {
      allowFailure: true,
    }) === null
  ) {
    fail('dirty-tracked-checkout');
  }

  const head = runGit(repository, ['rev-parse', '--verify', 'HEAD^{commit}'], {
    capture: true,
    code: 'invalid-head',
  });
  if (head !== input.commit) fail('commit-is-not-head');
  const verifiedCommit = runGit(
    repository,
    ['rev-parse', '--verify', `${input.commit}^{commit}`],
    { capture: true, code: 'commit-not-found' },
  );
  if (verifiedCommit !== input.commit) fail('commit-mismatch');
  if (
    runGit(
      repository,
      ['merge-base', '--is-ancestor', input.commit, 'refs/heads/main'],
      {
        allowFailure: true,
      },
    ) === null
  ) {
    fail('commit-not-in-main');
  }

  const forbiddenTrackedPath = runGit(
    repository,
    ['ls-tree', '-r', '--name-only', input.commit],
    { capture: true },
  )
    .split('\n')
    .find((path) =>
      path
        .split('/')
        .some((part) =>
          ['.env', 'node_modules', 'coverage', '.next'].includes(part),
        ),
    );
  if (forbiddenTrackedPath) fail('forbidden-tracked-artifact');

  const bundleName = `${input.commit}.bundle`;
  const manifestName = `${input.commit}.manifest.json`;
  const finalBundle = join(canonicalOutput, bundleName);
  const finalManifest = join(canonicalOutput, manifestName);
  await mustNotExist(finalBundle, 'bundle-already-exists');
  await mustNotExist(finalManifest, 'manifest-already-exists');

  const workRoot = await mkdtemp(join(tmpdir(), 'meteora-release-bundle-'));
  const temporaryBundle = join(
    canonicalOutput,
    `.${bundleName}.${randomUUID()}.tmp`,
  );
  const temporaryManifest = join(
    canonicalOutput,
    `.${manifestName}.${randomUUID()}.tmp`,
  );
  let bundlePublished = false;
  try {
    const bareRepository = join(workRoot, 'repository.git');
    const clone = spawnSync(
      'git',
      ['clone', '--bare', '--no-local', '--quiet', repository, bareRepository],
      { encoding: 'utf8' },
    );
    if (clone.status !== 0) fail('temporary-clone-failed');
    runGit(bareRepository, [
      'update-ref',
      `refs/heads/release-${input.commit}`,
      input.commit,
    ]);
    const bundle = spawnSync(
      'git',
      [
        '-C',
        bareRepository,
        'bundle',
        'create',
        temporaryBundle,
        `refs/heads/release-${input.commit}`,
      ],
      { encoding: 'utf8' },
    );
    if (bundle.status !== 0) fail('bundle-creation-failed');
    runGit(bareRepository, ['bundle', 'verify', temporaryBundle], {
      code: 'bundle-verification-failed',
    });

    const bundleBytes = await readFile(temporaryBundle);
    const bundleSha256 = createHash('sha256').update(bundleBytes).digest('hex');
    const manifest = {
      schemaVersion: 1,
      commit: input.commit,
      bundle: bundleName,
      bundleSha256,
    };
    await writeFile(
      temporaryManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o644,
      },
    );
    await publishNoReplace(temporaryBundle, finalBundle);
    bundlePublished = true;
    await publishNoReplace(temporaryManifest, finalManifest);
  } catch (error) {
    await rm(temporaryBundle, { force: true });
    await rm(temporaryManifest, { force: true });
    if (bundlePublished) await rm(finalBundle, { force: true });
    if (error?.message && fullCommitPattern.test(error.message)) throw error;
    if (process.exitCode) return;
    fail(
      error?.code === 'EEXIST'
        ? 'release-artifact-already-exists'
        : 'creation-failed',
    );
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }

  process.stdout.write(
    `RELEASE_BUNDLE_CREATED commit=${input.commit} bundle=${basename(finalBundle)} manifest=${basename(finalManifest)}\n`,
  );
}

await main().catch(() => {
  if (!process.exitCode) process.exitCode = 1;
});
