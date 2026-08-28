#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const templatePath = fileURLToPath(
  new URL(
    './systemd/vpn-platform-node-agent.service.template',
    import.meta.url,
  ),
);

const optionNames = new Set([
  'project-root',
  'state-directory',
  'node-binary',
  'service-user',
  'service-group',
  'docker-group',
  'output',
]);

const placeholders = {
  PROJECT_ROOT: 'projectRoot',
  STATE_DIRECTORY: 'stateDirectory',
  NODE_BINARY: 'nodeBinary',
  SERVICE_USER: 'serviceUser',
  SERVICE_GROUP: 'serviceGroup',
  DOCKER_GROUP: 'dockerGroup',
};

function fail(message) {
  throw new Error(message);
}

function validatePosixAbsolutePath(name, value) {
  if (!/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value)) {
    fail(
      `${name} must be an absolute POSIX path containing only letters, digits, dot, underscore, dash and slash`,
    );
  }

  if (value.split('/').some((part) => part === '.' || part === '..')) {
    fail(`${name} must not contain dot path segments`);
  }
}

function validateLinuxName(name, value) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value)) {
    fail(`${name} must be a valid lowercase Linux user or group name`);
  }
  if (value === 'root') {
    fail(`${name} must not be root`);
  }
}

export function validateNodeAgentSystemdOptions(options) {
  const required = [
    'projectRoot',
    'stateDirectory',
    'nodeBinary',
    'serviceUser',
    'serviceGroup',
    'dockerGroup',
  ];

  for (const name of required) {
    if (typeof options[name] !== 'string' || options[name].length === 0) {
      fail(`${name} is required`);
    }
  }

  validatePosixAbsolutePath('projectRoot', options.projectRoot);
  validatePosixAbsolutePath('nodeBinary', options.nodeBinary);

  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.stateDirectory)) {
    fail(
      'stateDirectory must be a single lowercase directory name containing only letters, digits, underscore and dash',
    );
  }

  validateLinuxName('serviceUser', options.serviceUser);
  validateLinuxName('serviceGroup', options.serviceGroup);
  validateLinuxName('dockerGroup', options.dockerGroup);
}

export function renderNodeAgentSystemdUnit(template, options) {
  validateNodeAgentSystemdOptions(options);

  let rendered = template;
  for (const [placeholder, optionName] of Object.entries(placeholders)) {
    const token = `__${placeholder}__`;
    const matches = rendered.match(new RegExp(token, 'g')) ?? [];
    if (matches.length === 0) {
      fail(`template is missing ${token}`);
    }
    rendered = rendered.replaceAll(token, options[optionName]);
  }

  const unknownPlaceholder = rendered.match(/__[A-Z0-9_]+__/);
  if (unknownPlaceholder) {
    fail(`template contains unknown placeholder ${unknownPlaceholder[0]}`);
  }

  return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}

function parseArguments(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      fail('all options must use --name value form');
    }

    const name = flag.slice(2);
    if (!optionNames.has(name)) {
      fail(`unknown option ${flag}`);
    }
    if (Object.hasOwn(parsed, name)) {
      fail(`duplicate option ${flag}`);
    }
    parsed[name] = value;
  }

  return {
    projectRoot: parsed['project-root'],
    stateDirectory: parsed['state-directory'],
    nodeBinary: parsed['node-binary'],
    serviceUser: parsed['service-user'],
    serviceGroup: parsed['service-group'],
    dockerGroup: parsed['docker-group'],
    output: parsed.output,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.output) {
    fail('output is required');
  }

  const template = await readFile(templatePath, 'utf8');
  const rendered = renderNodeAgentSystemdUnit(template, options);
  await writeFile(options.output, rendered, { encoding: 'utf8', mode: 0o600 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `Unable to render vpn-platform-node-agent.service: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
