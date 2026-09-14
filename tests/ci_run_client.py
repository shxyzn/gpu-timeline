"""Exercise the installed CLI as the disposable runner's ordinary member account."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

cli = "/usr/local/bin/gputl"
assert os.getuid() != 0
with tempfile.TemporaryDirectory() as temp:
    def command(job_id, code):
        return [cli, "run", "--id", job_id, "--name", "CI run", "--owner", "Member label",
                "--gpus", "0", "--", sys.executable, "-c", code]
    result = subprocess.run(command("ci-ok", "import json,os;print(json.dumps([os.getuid(),os.getcwd(),os.environ['GPUTL_FIXTURE']]))"),
                            cwd=temp, env={**os.environ, "GPUTL_FIXTURE": "caller-env"}, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == [os.getuid(), temp, "caller-env"]
    result = subprocess.run(command("ci-fail", "raise SystemExit(7)"), capture_output=True, text=True, timeout=30)
    assert result.returncode == 7, result.stderr
    marker = Path(temp) / "ready"
    child_code = "import pathlib,signal,sys,time;signal.signal(signal.SIGTERM,lambda *_:sys.exit(0));pathlib.Path('ready').touch();time.sleep(30)"
    runner = subprocess.Popen(command("ci-cancel", child_code), cwd=temp, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 15
        while not marker.exists():
            assert runner.poll() is None and time.monotonic() < deadline, "runner did not start"
            time.sleep(0.05)
        runner.send_signal(signal.SIGTERM)
        _, stderr = runner.communicate(timeout=15)
        assert runner.returncode == 143, stderr
    finally:
        if runner.poll() is None:
            runner.kill()
            runner.communicate()
    jobs = json.loads(subprocess.check_output([cli, "list"], text=True))["jobs"]
    results = {j["id"]: (j["status"], j["exit_code"]) for j in jobs}
    assert results["ci-ok"] == ("completed", 0), results
    assert results["ci-fail"] == ("failed", 7), results
    assert results["ci-cancel"] == ("cancelled", 0), results
    assert all(j["ended_at"] is not None for j in jobs)
print("Installed run: caller UID/environment/cwd/stdout, failure, cancellation and socket recording passed.")
