function commandFailure(arguments_, result) {
  const details = (result.stderr || result.stdout || '').trim();
  return new Error(
    `docker ${arguments_.join(' ')} failed with status ${String(result.status)}` +
      (details ? `: ${details}` : ''),
  );
}

function isMissing(result, resourceType) {
  if (result.status === 0) return false;

  const details = `${result.stderr || ''}\n${result.stdout || ''}`;
  return resourceType === 'container'
    ? /No such container/i.test(details)
    : /network .* not found|No such network/i.test(details);
}

function cleanupResource(
  { removeArguments, inspectArguments, resourceType },
  run,
) {
  const errors = [];
  const removal = run(removeArguments);
  if (removal.status !== 0 && !isMissing(removal, resourceType)) {
    errors.push(commandFailure(removeArguments, removal));
  }

  const postCondition = run(inspectArguments);
  if (postCondition.status === 0) {
    errors.push(
      new Error(
        `${resourceType} still exists after cleanup: ${inspectArguments.at(-1)}`,
      ),
    );
  } else if (!isMissing(postCondition, resourceType)) {
    errors.push(commandFailure(inspectArguments, postCondition));
  }

  return errors;
}

export function runWithDockerCleanup(
  { run, containerNames, networkName },
  operation,
) {
  const trackedContainers = new Set();
  let networkTracked = false;
  const resources = {
    trackContainer(name) {
      if (!containerNames.includes(name)) {
        throw new Error(`Refusing to track an unexpected container: ${name}`);
      }
      trackedContainers.add(name);
    },
    trackNetwork(name) {
      if (name !== networkName) {
        throw new Error(`Refusing to track an unexpected network: ${name}`);
      }
      networkTracked = true;
    },
  };

  let result;
  let primaryError;
  try {
    result = operation(resources);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  for (const name of [...trackedContainers].reverse()) {
    cleanupErrors.push(
      ...cleanupResource(
        {
          removeArguments: ['rm', '--force', name],
          inspectArguments: ['container', 'inspect', name],
          resourceType: 'container',
        },
        run,
      ),
    );
  }
  if (networkTracked) {
    cleanupErrors.push(
      ...cleanupResource(
        {
          removeArguments: ['network', 'rm', networkName],
          inspectArguments: ['network', 'inspect', networkName],
          resourceType: 'network',
        },
        run,
      ),
    );
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'Container image smoke failed and cleanup also failed.',
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Container image cleanup failed.');
  }
  if (primaryError) throw primaryError;

  return result;
}
