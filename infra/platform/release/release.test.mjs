import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const releaseDirectory = fileURLToPath(new URL('.', import.meta.url));
const creator = join(releaseDirectory, 'create-release-bundle.mjs');
const installer = join(releaseDirectory, 'install-release.sh');
const gitBash =
  process.platform === 'win32' ? 'Z:\\Git\\bin\\bash.exe' : 'bash';
const linuxOnly =
  process.platform === 'win32' ? { skip: 'requires POSIX symlinks' } : {};
const nonRootLinuxOnly =
  process.platform !== 'win32' && process.getuid?.() !== 0
    ? {}
    : { skip: 'requires a non-root Linux process' };

function run(executable, arguments_, options = {}) {
  return spawnSync(executable, arguments_, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
}

function git(repository, ...arguments_) {
  const result = run('git', ['-C', repository, ...arguments_]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'meteora-release-test-'));
  const repository = join(root, 'source');
  const output = join(root, 'artifacts');
  const installationRoot = join(root, 'install');
  await mkdir(repository);
  await mkdir(output);
  await mkdir(join(installationRoot, 'releases'), { recursive: true });
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.name', 'Release Test');
  git(repository, 'config', 'user.email', 'release-test@example.invalid');
  await writeFile(join(repository, 'tracked.txt'), 'tracked\n');
  git(repository, 'add', 'tracked.txt');
  git(repository, 'commit', '-m', 'fixture');
  const commit = git(repository, 'rev-parse', 'HEAD');
  return { root, repository, output, installationRoot, commit };
}

function createBundle(state, overrides = {}) {
  return run(
    process.execPath,
    [
      creator,
      '--repository',
      state.repository,
      '--commit',
      overrides.commit ?? state.commit,
      '--output-directory',
      state.output,
    ],
    { cwd: state.repository },
  );
}

function toShellPath(path) {
  if (process.platform !== 'win32') return path;
  const result = run('Z:\\Git\\usr\\bin\\cygpath.exe', ['-u', path]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function install(state, overrides = {}) {
  const bundle =
    overrides.bundle ?? join(state.output, `${state.commit}.bundle`);
  const bundlePath = overrides.rawBundlePath ?? toShellPath(bundle);
  const rootPath = toShellPath(state.installationRoot);
  const hash =
    overrides.hash ??
    createHash('sha256')
      .update(overrides.bundleBytes ?? '')
      .digest('hex');
  return run(
    gitBash,
    [
      toShellPath(installer),
      '--bundle',
      bundlePath,
      '--expected-commit',
      overrides.commit ?? state.commit,
      '--expected-sha256',
      hash,
    ],
    {
      env: {
        METEORA_RELEASE_TEST_MODE: '1',
        METEORA_RELEASE_TEST_ROOT: rootPath,
        ...overrides.env,
      },
    },
  );
}

async function createdFixture() {
  const state = await fixture();
  const result = createBundle(state);
  assert.equal(result.status, 0, result.stderr);
  const bundle = join(state.output, `${state.commit}.bundle`);
  const bytes = await readFile(bundle);
  return {
    ...state,
    bundle,
    bytes,
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
}

test('creator rejects dirty tracked checkout and malformed or shortened commits', async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  await writeFile(join(state.repository, 'tracked.txt'), 'dirty\n');
  assert.match(createBundle(state).stderr, /dirty-tracked-checkout/);
  git(state.repository, 'restore', 'tracked.txt');
  for (const commit of ['abc', 'g'.repeat(40)]) {
    assert.match(createBundle(state, { commit }).stderr, /invalid-commit/);
  }
});

test('creator excludes untracked files and writes an exact manifest', async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  await writeFile(join(state.repository, '.env'), 'SECRET=must-not-leak\n');
  const result = createBundle(state);
  assert.equal(result.status, 0, result.stderr);
  const bundle = join(state.output, `${state.commit}.bundle`);
  const bytes = await readFile(bundle);
  const manifest = JSON.parse(
    await readFile(join(state.output, `${state.commit}.manifest.json`), 'utf8'),
  );
  assert.equal(manifest.commit, state.commit);
  assert.equal(
    manifest.bundleSha256,
    createHash('sha256').update(bytes).digest('hex'),
  );
  const heads = run('git', ['bundle', 'list-heads', bundle]);
  assert.equal(heads.status, 0, heads.stderr);
  assert.match(heads.stdout, new RegExp(`^${state.commit} `));
  const clone = join(state.root, 'clone');
  assert.equal(run('git', ['clone', '--quiet', bundle, clone]).status, 0);
  await assert.rejects(readFile(join(clone, '.env')), /ENOENT/);
});

test('installer rejects invalid hashes, commits and bundle paths', async (t) => {
  const state = await createdFixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  assert.match(
    install(state, { hash: '0'.repeat(64) }).stderr,
    /bundle-sha256-mismatch/,
  );
  assert.match(
    install(state, { commit: 'abc', hash: state.hash }).stderr,
    /invalid-expected-commit/,
  );
  assert.match(
    install(state, { rawBundlePath: 'relative.bundle', hash: state.hash })
      .stderr,
    /invalid-bundle-path/,
  );
  const optionPath = run(gitBash, [
    toShellPath(installer),
    '--bundle',
    '--bad',
  ]);
  assert.match(optionPath.stderr, /missing-bundle/);
  const shellBundle = toShellPath(state.bundle);
  const traversal = shellBundle.replace(
    `/${state.commit}.bundle`,
    `/nested/../${state.commit}.bundle`,
  );
  await mkdir(join(state.output, 'nested'));
  assert.match(
    install(state, { rawBundlePath: traversal, hash: state.hash }).stderr,
    /non-canonical-bundle-path/,
  );
});

test('installer rejects a bundle without the expected commit', async (t) => {
  const state = await createdFixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const otherState = await fixture();
  t.after(() => rm(otherState.root, { recursive: true, force: true }));
  await writeFile(join(otherState.repository, 'tracked.txt'), 'unrelated\n');
  git(otherState.repository, 'add', 'tracked.txt');
  git(otherState.repository, 'commit', '--amend', '-m', 'unrelated fixture');
  otherState.commit = git(otherState.repository, 'rev-parse', 'HEAD');
  assert.equal(createBundle(otherState).status, 0);
  const otherBundle = join(otherState.output, `${otherState.commit}.bundle`);
  const otherBytes = await readFile(otherBundle);
  const result = install(state, {
    bundle: otherBundle,
    hash: createHash('sha256').update(otherBytes).digest('hex'),
  });
  assert.match(result.stderr, /expected-commit-not-in-bundle-heads/);
});

test(
  'installer materializes the exact checkout and atomically switches current',
  linuxOnly,
  async (t) => {
    const state = await createdFixture();
    t.after(() => rm(state.root, { recursive: true, force: true }));
    const result = install(state, { hash: state.hash });
    assert.equal(result.status, 0, result.stderr);
    const release = join(state.installationRoot, 'releases', state.commit);
    assert.equal(git(release, 'rev-parse', 'HEAD'), state.commit);
    assert.equal(
      await realpath(join(state.installationRoot, 'current')),
      await realpath(release),
    );
    assert.match(result.stdout, /RELEASE_INSTALL_COMPLETE/);
    assert.match(
      install(state, { hash: state.hash }).stderr,
      /release-already-exists/,
    );
  },
);

test(
  'pre-switch failure preserves current and leaves no partial directory',
  linuxOnly,
  async (t) => {
    const state = await createdFixture();
    t.after(() => rm(state.root, { recursive: true, force: true }));
    const previous = join(state.installationRoot, 'releases', 'previous');
    await mkdir(previous);
    await symlink(previous, join(state.installationRoot, 'current'), 'dir');
    const result = install(state, {
      hash: state.hash,
      env: { METEORA_RELEASE_TEST_FAIL_BEFORE_SWITCH: '1' },
    });
    assert.match(result.stderr, /injected-before-switch/);
    assert.equal(
      await realpath(join(state.installationRoot, 'current')),
      await realpath(previous),
    );
    const installed = join(state.installationRoot, 'releases', state.commit);
    assert.equal(git(installed, 'rev-parse', 'HEAD'), state.commit);
    const releaseEntries = await import('node:fs/promises').then(
      ({ readdir }) => readdir(join(state.installationRoot, 'releases')),
    );
    assert.equal(
      releaseEntries.some((entry) => entry.startsWith('.install-')),
      false,
    );
  },
);

test(
  'post-switch verification failure atomically restores previous current',
  linuxOnly,
  async (t) => {
    const state = await createdFixture();
    t.after(() => rm(state.root, { recursive: true, force: true }));
    const previous = join(state.installationRoot, 'releases', 'previous');
    await mkdir(previous);
    await symlink(previous, join(state.installationRoot, 'current'), 'dir');
    const result = install(state, {
      hash: state.hash,
      env: { METEORA_RELEASE_TEST_FAIL_AFTER_SWITCH: '1' },
    });
    assert.match(result.stderr, /injected-after-switch/);
    assert.equal(
      await realpath(join(state.installationRoot, 'current')),
      await realpath(previous),
    );
  },
);

test('installer refuses symlinked target paths', linuxOnly, async (t) => {
  const state = await createdFixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const outside = join(state.root, 'outside');
  await mkdir(outside);
  await rm(join(state.installationRoot, 'releases'), { recursive: true });
  await symlink(outside, join(state.installationRoot, 'releases'), 'dir');
  assert.match(
    install(state, { hash: state.hash }).stderr,
    /invalid-releases-directory/,
  );
});

test(
  'non-root execution is confined to the dedicated temporary test root',
  nonRootLinuxOnly,
  async (t) => {
    const state = await createdFixture();
    t.after(() => rm(state.root, { recursive: true, force: true }));

    const productionInvocation = run('bash', [installer], {
      env: {
        METEORA_RELEASE_TEST_MODE: '0',
        METEORA_RELEASE_TEST_ROOT: '',
      },
    });
    assert.match(productionInvocation.stderr, /installer-requires-root/);

    const escapedTestRoot = run(
      'bash',
      [
        installer,
        '--bundle',
        state.bundle,
        '--expected-commit',
        state.commit,
        '--expected-sha256',
        state.hash,
      ],
      {
        env: {
          METEORA_RELEASE_TEST_MODE: '1',
          METEORA_RELEASE_TEST_ROOT: state.root,
        },
      },
    );
    assert.match(escapedTestRoot.stderr, /unsafe-test-root/);
  },
);

test('installer has no deployment or destructive retention mutations', async () => {
  const script = await readFile(installer, 'utf8');
  assert.match(script, /\[\[ "\$\(id -u\)" == '0' \]\]/);
  assert.match(script, /\/tmp\/meteora-release-test-\*\/install/);
  assert.match(script, /invalid-test-root-owner/);
  assert.doesNotMatch(script, /docker|ufw|systemctl|curl|wget|nslookup|dig/);
  assert.doesNotMatch(script, /rm\s+-rf\s+--\s+"\$releases_directory"/);
  assert.match(script, /sync -f "\$staging_directory\/repository"/);
  assert.match(
    script,
    /mv -Tf -- "\$temporary_link" "\$release_root\/current"/,
  );
});
