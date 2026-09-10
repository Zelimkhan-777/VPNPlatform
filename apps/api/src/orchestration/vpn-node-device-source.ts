import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { SubscriptionAccessService } from '../subscription-access/subscription-access.service';

export const CLOSED_TEST_SUBSCRIPTION_URL_RELATIVE_PATH =
  'var/vpn-nl-01/replacement-subscription-url.txt';
export const LOCAL_HARNESS_RELATIVE_PATH = 'var/xray-local/harness.json';

const SUBSCRIPTION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function resolveClosedTestSubscriptionUrlPath(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const override = environment.VPN_CLOSED_TEST_SUBSCRIPTION_URL_FILE?.trim();
  if (!override) {
    return join(root, CLOSED_TEST_SUBSCRIPTION_URL_RELATIVE_PATH);
  }
  return isAbsolute(override) ? override : join(root, override);
}

export async function readSubscriptionTokenFromUrlFile(
  path: string,
): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new Error('Closed-test subscription URL file was not found');
    }
    throw error;
  }

  const line = raw.trim();
  if (!line) {
    throw new Error('Closed-test subscription URL file is empty');
  }
  if (line.includes('\n') || line.includes('\r')) {
    throw new Error('Closed-test subscription URL file must contain one URL');
  }

  let url: URL;
  try {
    url = new URL(line);
  } catch {
    throw new Error('Closed-test subscription URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Closed-test subscription URL must be HTTP(S)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Closed-test subscription URL must not contain credentials, query, or fragment',
    );
  }

  const match = /^\/sub\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  const token = match?.[1];
  if (!token || !SUBSCRIPTION_TOKEN_PATTERN.test(token)) {
    throw new Error('Closed-test subscription URL does not contain a token');
  }
  return token;
}

export async function readLocalHarnessDeviceId(
  root: string,
): Promise<string | null> {
  const harnessPath = join(root, LOCAL_HARNESS_RELATIVE_PATH);
  try {
    const harness = JSON.parse(await readFile(harnessPath, 'utf8')) as {
      deviceId?: unknown;
    };
    if (typeof harness.deviceId === 'string' && harness.deviceId.length > 0) {
      return harness.deviceId;
    }
    return null;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

export async function resolveActiveDeviceFromSubscriptionUrlFile(input: {
  root: string;
  access: SubscriptionAccessService;
  environment?: NodeJS.ProcessEnv;
}): Promise<{ deviceId: string; userId: string }> {
  const path = resolveClosedTestSubscriptionUrlPath(
    input.root,
    input.environment,
  );
  const token = await readSubscriptionTokenFromUrlFile(path);
  const device = await input.access.resolveAuthorizedDevice(token);
  if (!device) {
    throw new Error(
      'Closed-test subscription does not resolve to an ACTIVE device',
    );
  }
  const harnessDeviceId = await readLocalHarnessDeviceId(input.root);
  if (harnessDeviceId && harnessDeviceId === device.deviceId) {
    throw new Error(
      'Closed-test attach refuses the revoked local harness device',
    );
  }
  return device;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
