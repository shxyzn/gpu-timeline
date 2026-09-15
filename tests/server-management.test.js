import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {installedVersion, compareVersions, maintenanceState, updateCommand} from '../dist/server-management.js';

const baseline = {installed_version_baseline: '1.0.0'};
const build = {version: '1.1.3', revision: 'a'.repeat(40), dirty: false};
const now = Date.parse('2026-09-15T00:00:00Z');
const snapshot = {server_id: 'server-a', updated_at: new Date(now).toISOString(), collector_ok: true};

test('explicit legacy baseline is replaced by a reported full version, never assigned to unknown servers', () => {
  assert.deepEqual(installedVersion(snapshot, baseline), {version: '1.0.0', label: 'v1.0.0', source: 'baseline',
    note: '관리자 지정 기준 · 다음 설치 후 수집기 보고값 사용'});
  const upgraded = installedVersion({...snapshot, agent_version: {...build, deployment_version: '1.1'}}, baseline);
  assert.equal(upgraded.label, 'v1.1.3+aaaaaaa');
  assert.equal(upgraded.source, 'reported');
  assert.equal(installedVersion(snapshot).version, null);
  assert.equal(installedVersion({...snapshot, agent_version: {version: 'invalid'}}, baseline).version, null);
});

test('server action guidance follows installed features, not every dashboard patch, and keeps connection state separate', () => {
  const releases = [{version: '1.1.0', features: ['Shared IDs']}, {version: '1.2.0', features: ['Future']}];
  const legacy = maintenanceState(snapshot, baseline, build, releases, now);
  assert.deepEqual(legacy.pending, [releases[0]]);
  const patched = maintenanceState({...snapshot, agent_version: {version: '1.1.1'}}, baseline, build, releases, now);
  assert.equal(patched.pending.length, 0);
  assert.equal(maintenanceState(snapshot, baseline, null, releases, now).pending.length, 0);
  assert.equal(maintenanceState({...snapshot, fetch_error: true}, baseline, build, releases, now).connection.ok, false);
  assert.equal(maintenanceState(snapshot, baseline, build, releases, now + 3600000).connection.ok, false);
  assert.equal(compareVersions('1.10.0', '1.2.0'), 1);
  assert.equal(compareVersions('1.1.3', '1.1.3'), 0);
  assert.equal(compareVersions('1.1', '1.1.3'), null);
});

test('update commands pin the build and validate existing identity without modifying checkout or server ID', () => {
  for (const serverID of ['server-a', 'server-b', 'server-c']) {
    const command = updateCommand(serverID, build);
    assert.equal(spawnSync('bash', ['-n'], {input: command, encoding: 'utf8'}).status, 0);
    assert.ok(command.includes("'" + serverID + "'"));
    assert.ok(command.includes("fetch --depth 1 origin '" + build.revision + "'"));
    assert.ok(command.includes('GPU_TIMELINE_PYTHON="$gputl_python"'));
    assert.ok(command.indexOf('/etc/gpu-timeline/config.json') < command.indexOf('mktemp'));
    assert.equal(command.includes('--server-id'), false);
    assert.equal(command.includes('git pull'), false);
    assert.equal(command.includes('agent.env'), false);
  }
  assert.equal(updateCommand('server-a', null), null);
  assert.equal(updateCommand('server-a', {...build, revision: 'unknown'}), null);
  assert.equal(updateCommand('server-a', {...build, dirty: true}), null);
  for (const injection of ["server-a'; touch /tmp/unsafe", '$(whoami)', 'server-a\nexit']) {
    assert.equal(updateCommand(injection, build), null);
  }
});

test('copied update script stops before installing on identity/version mismatch and preserves the service interpreter', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gputl-command-fixture-'));
  try {
    for (const scenario of ['account-mismatch', 'server-mismatch', 'version-mismatch', 'success']) {
      const log = path.join(directory, scenario);
      // Stub ALL external effects including absolute-path commands. Only the
      // generated temporary checkout and a marker file are written in this test.
      const fixture = `
export GPUTL_FIXTURE_LOG='${log}'
function systemctl() {
  case "$*" in
    *--property=User*) echo '${scenario === 'account-mismatch' ? 'someone-else' : 'cvml'}' ;;
    *--property=ExecStart*) echo '{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -s /opt/gpu-timeline/shared_daemon.py ; }' ;;
    *) return 97 ;;
  esac
}
function id() { echo cvml; }
function /usr/bin/python3() { ${scenario === 'server-mismatch' ? 'return 1' : 'test "$3" = server-a'}; }
function /usr/local/bin/gputl() { echo "$*" >> "$GPUTL_FIXTURE_LOG"; }
function git() {
  case "$3" in
    init|remote|fetch) return 0 ;;
    checkout)
      mkdir -p "$2/agent"
      echo '${scenario === 'version-mismatch' ? '1.1.2' : build.version}' > "$2/VERSION"
      echo 'echo "install:$GPU_TIMELINE_PYTHON" >> "$GPUTL_FIXTURE_LOG"' > "$2/agent/install-shared.sh" ;;
    rev-parse) echo '${build.revision}' ;;
    *) return 98 ;;
  esac
}
`;
      const result = spawnSync('bash', ['-c', fixture + updateCommand('server-a', build)], {encoding: 'utf8'});
      if (scenario === 'success') {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(log, 'utf8'), 'install:/usr/bin/python3\nsync\nstatus\n');
      } else {
        assert.notEqual(result.status, 0, scenario);
        assert.equal(existsSync(log), false, scenario + ' must not install or sync');
      }
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
