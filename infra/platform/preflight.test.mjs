import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = await readFile(
  new URL('./preflight.sh', import.meta.url),
  'utf8',
);

test('platform preflight is read-only and requires an explicit public IPv4', () => {
  assert.match(script, /set -Eeuo pipefail/);
  assert.match(script, /--expected-public-ip/);
  assert.match(script, /is_ipv4 "\$expected_public_ip"/);
  assert.match(script, /\[\[ "\$\(id -u\)" == '0' \]\]/);
  assert.doesNotMatch(
    script,
    /docker compose[\s\\]+(?:[^\n]*\n)*?\s+(?:up|down|pull|push|restart)\b/,
  );
  assert.doesNotMatch(
    script,
    /\bufw\s+(?:allow|delete|enable|disable|reset)\b/,
  );
  assert.doesNotMatch(
    script,
    /\bsystemctl\s+(?:start|stop|restart|enable|disable)\b/,
  );
});

test('platform preflight preserves the hardened host baseline', () => {
  for (const setting of [
    'permitrootlogin no',
    'passwordauthentication no',
    'pubkeyauthentication yes',
  ]) {
    assert.match(script, new RegExp(setting));
  }
  assert.match(script, /ufw-ssh-not-limited/);
  assert.match(script, /unexpected-timezone/);
  assert.match(script, /ntp-not-synchronized/);
  assert.match(script, /public-http-firewall-already-open/);
  assert.match(script, /unexpected-public-listener/);
  assert.match(script, /existing-containers/);
  assert.match(script, /xray-binary-present/);
  assert.match(script, /xray-systemd-unit-present/);
});

test('platform preflight validates checkout, secrets, compose and every public origin', () => {
  assert.match(script, /status --porcelain --untracked-files=all/);
  assert.match(script, /safe\.directory="\$REPOSITORY_ROOT"/);
  assert.match(script, /secrets\/validate\.sh/);
  assert.match(script, /docker compose/);
  assert.match(script, /config --quiet/);
  assert.match(script, /ROOT_DOMAIN APP_DOMAIN API_DOMAIN SUB_DOMAIN/);
  assert.match(script, /getent ahostsv4/);
  assert.match(script, /dns-mismatch-/);
  assert.match(script, /PLATFORM_PREFLIGHT_READY/);
});
