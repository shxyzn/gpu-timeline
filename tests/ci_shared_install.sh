#!/usr/bin/env bash
# Destructive fixture setup only on a fresh, disposable GitHub-hosted runner.
set -euo pipefail
if [ "${GITHUB_ACTIONS:-}" != true ] || [ "$(id -u)" -ne 0 ]; then
  echo 'This installation check only runs as root on disposable GitHub Actions runners.' >&2
  exit 1
fi
test_python=$1
for target in /opt/gpu-timeline /etc/gpu-timeline /var/lib/gpu-timeline /usr/local/bin/gputl /usr/local/bin/nvidia-smi /etc/systemd/system/gpu-timeline-shared.service; do
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "Refusing to replace an existing installation: $target" >&2
    exit 1
  fi
done
if id gputl_admin >/dev/null 2>&1 || id gputl_member >/dev/null 2>&1; then
  echo 'Fixture accounts already exist.' >&2
  exit 1
fi
useradd -m gputl_admin
useradd -m gputl_member
mkdir -p /home/gputl_admin/.config/gpu-timeline /home/gputl_admin/.local/state/gpu-timeline
cat > /home/gputl_admin/.config/gpu-timeline/config.json <<'EOF'
{"server_id":"ci-server","name":"CI fixture","state_dir":"~/.local/state/gpu-timeline","github_repository":"invalid-local-test","github_branch":"status"}
EOF
# Invalid repository syntax is rejected before ANY GitHub/network request.
printf '%s\n' 'GPU_TIMELINE_TOKEN=local-fixture-not-a-real-token' > /home/gputl_admin/.config/gpu-timeline/agent.env
chmod 600 /home/gputl_admin/.config/gpu-timeline/agent.env
cat > /home/gputl_admin/.local/state/gpu-timeline/jobs.json <<'EOF'
[{"id":"legacy","name":"Existing experiment","status":"running","gpu_uuids":["GPU-CI"],"started_at":"2026-09-01T00:00:00+00:00","expected_end_at":null,"ended_at":null}]
EOF
chown -R gputl_admin:gputl_admin /home/gputl_admin
cat > /usr/local/bin/nvidia-smi <<'EOF'
#!/bin/sh
case "$1" in
  --query-gpu=*) printf '%s\n' '0, GPU-CI, Test GPU, 24000, 1000, 0' ;;
  --query-compute-apps=*) exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod 755 /usr/local/bin/nvidia-smi
"$test_python" agent/install_shared.py --user gputl_admin --python "$test_python"
for attempt in $(seq 1 15); do
  if runuser -u gputl_member -- /usr/local/bin/gputl status > /tmp/gputl-ci-status.json; then break; fi
  sleep 1
done
"$test_python" - <<'PY'
import json
import subprocess
from pathlib import Path
installed = json.loads(Path("/opt/gpu-timeline/version.json").read_text())
status = json.loads(Path("/tmp/gputl-ci-status.json").read_text())
assert installed == status["agent_version"]
assert installed["version"] == Path("VERSION").read_text().strip()
assert installed["revision"] == subprocess.check_output(["git", "-c", "safe.directory=" + str(Path.cwd()), "rev-parse", "HEAD"], text=True).strip()
assert installed["dirty"] is False
assert installed["installed_at"]
PY
runuser -u gputl_admin -- /usr/local/bin/gputl list > /tmp/gputl-ci-legacy.json
"$test_python" -c 'import json; assert json.load(open("/tmp/gputl-ci-legacy.json"))["jobs"][0]["id"] == "legacy"'
runuser -u gputl_member -- /usr/local/bin/gputl add --id legacy --name 'Member experiment' --owner 'Member label' --gpus 0
runuser -u gputl_member -- /usr/local/bin/gputl finish --id legacy
runuser -u gputl_admin -- /usr/local/bin/gputl list > /tmp/gputl-ci-legacy.json
"$test_python" -c 'import json; assert json.load(open("/tmp/gputl-ci-legacy.json"))["jobs"][0]["status"] == "running"'
if runuser -u gputl_member -- test -r /etc/gpu-timeline/agent.env; then exit 1; fi
if runuser -u gputl_member -- test -r /var/lib/gpu-timeline/jobs.json; then exit 1; fi
# The checkout belongs to the runner account and may have private parent dirs.
install -o gputl_member -g gputl_member -m 600 tests/ci_run_client.py /home/gputl_member/ci_run_client.py
runuser -u gputl_member -- /usr/bin/python3 /home/gputl_member/ci_run_client.py
# Reinstall must preserve both accounts' current records and administrator config.
"$test_python" agent/install_shared.py --user gputl_admin --python "$test_python"
"$test_python" -c 'import json; jobs=json.load(open("/var/lib/gpu-timeline/jobs.json")); assert len(jobs)==5; assert len({j["_owner_uid"] for j in jobs})==2'
systemctl stop gpu-timeline-shared.service
echo 'Shared install, legacy migration, cross-account use, private file permissions and reinstall passed.'
