import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptUrl = new URL('./preflight.sh', import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const script = await readFile(scriptUrl, 'utf8');
const bash = process.platform === 'win32' ? 'Z:\\Git\\bin\\bash.exe' : 'bash';
const shellScriptPath =
  process.platform === 'win32'
    ? spawnSync('Z:\\Git\\usr\\bin\\cygpath.exe', ['-u', scriptPath], {
        encoding: 'utf8',
      }).stdout.trim()
    : scriptPath;

function runSourced(command, environment = {}) {
  return spawnSync(
    bash,
    ['-c', `source "$1"; ${command}`, 'bash', shellScriptPath],
    {
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    },
  );
}

const validUfwStatus = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     LIMIT IN    Anywhere
22/tcp (v6)                LIMIT IN    Anywhere (v6)
`;

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
  assert.match(script, /unexpected-ufw-rule/);
  assert.match(script, /unexpected-timezone/);
  assert.match(script, /ntp-not-synchronized/);
  assert.match(script, /unexpected-public-listener/);
  assert.match(script, /ss -H -lntu/);
  assert.match(script, /tcp\\ \*:22/);
  assert.match(script, /udp\\ 127\.\*/);
  assert.match(script, /listener-scan-failed/);
  assert.match(script, /invalid-listener-scan-output/);
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
  assert.match(script, /getent --no-addrconfig ahosts/);
  assert.match(script, /dns-unexpected-aaaa-/);
  assert.match(script, /PLATFORM_PREFLIGHT_READY/);
});

test('UFW parser accepts only the canonical SSH rules and a deny or disabled routed default', () => {
  assert.equal(
    runSourced('assert_ufw_status "$FIXTURE"', {
      FIXTURE: validUfwStatus,
    }).status,
    0,
  );
  assert.equal(
    runSourced('assert_ufw_status "$FIXTURE"', {
      FIXTURE: validUfwStatus.replace('disabled (routed)', 'deny (routed)'),
    }).status,
    0,
  );

  for (const [fixture, expectedCode] of [
    [
      validUfwStatus.replace('disabled (routed)', 'allow (routed)'),
      'ufw-default-policy',
    ],
    [
      `${validUfwStatus}10.0.0.0/8 on eth1         ALLOW FWD  Anywhere on eth0\n`,
      'unexpected-ufw-rule',
    ],
    [
      `${validUfwStatus}443/tcp                    ALLOW IN    Anywhere\n`,
      'unexpected-ufw-rule',
    ],
    [
      `${validUfwStatus}53                         ALLOW OUT   Anywhere\n`,
      'unexpected-ufw-rule',
    ],
  ]) {
    const result = runSourced('assert_ufw_status "$FIXTURE"', {
      FIXTURE: fixture,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`code=${expectedCode}`));
  }
});

test('listener parser allows only loopback services and public TCP SSH', () => {
  const validListeners = `tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*
tcp LISTEN 0 4096 [::]:22 [::]:*
tcp LISTEN 0 4096 203.0.113.10:22 0.0.0.0:*
udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*
tcp LISTEN 0 4096 [::1]:631 [::]:*
`;
  const valid = runSourced(
    'ss() { printf "%s" "$FAKE_SS_OUTPUT"; }; assert_public_listeners',
    { FAKE_SS_OUTPUT: validListeners },
  );
  assert.equal(valid.status, 0, valid.stderr);

  for (const listener of [
    'udp UNCONN 0 0 0.0.0.0:22 0.0.0.0:*\n',
    'tcp LISTEN 0 4096 203.0.113.10:443 0.0.0.0:*\n',
    'tcp LISTEN 0 4096 [2001:db8::10]:80 [::]:*\n',
  ]) {
    const result = runSourced(
      'ss() { printf "%s" "$FAKE_SS_OUTPUT"; }; assert_public_listeners',
      { FAKE_SS_OUTPUT: listener },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /code=unexpected-public-listener/);
  }
});

test('listener scan fails closed on command failure and malformed output', () => {
  const failed = runSourced('ss() { return 1; }; assert_public_listeners');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /code=listener-scan-failed/);

  const malformed = runSourced(
    'ss() { printf "%s" "$FAKE_SS_OUTPUT"; }; assert_public_listeners',
    { FAKE_SS_OUTPUT: 'tcp LISTEN malformed\n' },
  );
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /code=invalid-listener-scan-output/);
});

test('DNS parser disables addrconfig and rejects native AAAA but not mapped IPv4', () => {
  const command = `
    getent() {
      if [[ "$1" == "ahostsv4" && "$2" == "app.example.com" ]]; then
        printf '%s' "$FAKE_IPV4_OUTPUT"
        return 0
      fi
      [[ "$1" == "--no-addrconfig" && "$2" == "ahosts" && "$3" == "app.example.com" ]] || return 97
      printf '%s' "$FAKE_ALL_OUTPUT"
    }
    assert_domain_dns app.example.com APP_DOMAIN 203.0.113.10
  `;
  const ipv4Output = '203.0.113.10 STREAM app.example.com\n';
  const valid = runSourced(command, {
    FAKE_IPV4_OUTPUT: ipv4Output,
    FAKE_ALL_OUTPUT:
      '203.0.113.10 STREAM app.example.com\n::ffff:203.0.113.10 STREAM app.example.com\n',
  });
  assert.equal(valid.status, 0, valid.stderr);

  const nativeIpv6 = runSourced(command, {
    FAKE_IPV4_OUTPUT: ipv4Output,
    FAKE_ALL_OUTPUT:
      '203.0.113.10 STREAM app.example.com\n2001:db8::10 STREAM app.example.com\n',
  });
  assert.notEqual(nativeIpv6.status, 0);
  assert.match(nativeIpv6.stderr, /code=dns-unexpected-aaaa-app_domain/);
});
