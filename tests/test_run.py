"""Real local commands; an in-process broker avoids requiring GPUs or a socket."""
import contextlib
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "agent"))
import gpu_agent as agent
import shared_cli as cli
import shared_daemon as shared


class RunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = {"server_id": "test", "name": "Test", "state_dir": str(self.root / "broker")}
        self.broker = shared.Broker(self.config)
        self.requests = []
        self.env = patch.dict(os.environ, {"XDG_STATE_HOME": str(self.root / "client"),
                                           "RUN_ENV_TEST": "caller-env", "CUDA_VISIBLE_DEVICES": "1"})
        self.env.start()
        self.gpu_patch = patch.object(agent, "collect_gpus", return_value=[{"uuid": "GPU-A", "index": 0}])
        self.gpu_patch.start()
        self.transport = patch.object(cli, "request", side_effect=self.request)
        self.transport.start()
        self.stderr = contextlib.redirect_stderr(io.StringIO())
        self.stderr.__enter__()

    def tearDown(self):
        self.stderr.__exit__(None, None, None)
        self.transport.stop()
        self.gpu_patch.stop()
        self.env.stop()
        self.temp.cleanup()

    def request(self, argv):
        self.requests.append(argv)
        return self.broker.dispatch(argv, os.getuid())

    def run_command(self, command, job_id="exp"):
        return cli.main(["run", "--id", job_id, "--name", "Experiment", "--owner", "Public label",
                         "--gpus", "0", "--"] + command)

    def job(self):
        return agent.read_jobs(self.config["state_dir"])[-1]

    def receipts(self):
        return list(cli.receipt_directory().glob("*.json"))

    def test_success_preserves_caller_environment_cwd_uid_and_literal_argv(self):
        output = self.root / "child.json"
        code = ("import json,os,sys;json.dump([os.getuid(),os.getcwd(),os.environ['RUN_ENV_TEST'],"
                "os.environ['CUDA_VISIBLE_DEVICES'],sys.argv[2:]],open(sys.argv[1],'w'))")
        self.assertEqual(self.run_command([sys.executable, "-c", code, str(output), "a b", "$(echo literal)"]), 0)
        self.assertEqual(json.loads(output.read_text()), [os.getuid(), os.getcwd(), "caller-env", "1",
                                                        ["a b", "$(echo literal)"]])
        job = self.job()
        self.assertEqual((job["status"], job["exit_code"]), ("completed", 0))
        self.assertLessEqual(agent.parse_time(job["started_at"]), agent.parse_time(job["ended_at"]))
        self.assertNotIn(code, json.dumps(self.requests))
        public = json.dumps(agent.make_snapshot(self.config)["jobs"])
        for secret in ("_run_token", "_runner_pid", "_owner_uid", str(output), "caller-env"):
            self.assertNotIn(secret, public)
        self.assertEqual(self.receipts(), [])

    def test_nonzero_missing_executable_and_self_signal_are_failures(self):
        for job_id, command, expected, exit_code in (
            ("nonzero", [sys.executable, "-c", "raise SystemExit(7)"], 7, 7),
            ("missing", [str(self.root / "does-not-exist")], 127, None),
            ("signal", [sys.executable, "-c", "import os,signal;os.kill(os.getpid(),signal.SIGTERM)"], 143, -15),
        ):
            with self.subTest(job_id=job_id):
                self.assertEqual(self.run_command(command, job_id), expected)
                self.assertEqual(self.job()["status"], "failed")
                self.assertEqual(self.job().get("exit_code"), exit_code)

    def test_duplicate_invalid_metadata_old_or_unavailable_collector_never_launches(self):
        self.assertEqual(self.run_command([sys.executable, "-c", "pass"]), 0)
        with patch.object(cli.subprocess, "Popen") as popen:
            self.assertEqual(self.run_command(["do-not-run"]), 1)
            with patch.object(cli, "request", return_value={"ok": True}):
                self.assertEqual(self.run_command(["do-not-run"]), 1)
            with patch.object(cli, "request", side_effect=cli.TransportError("unavailable")):
                self.assertEqual(self.run_command(["do-not-run"]), 1)
            self.assertEqual(cli.main(["run", "--name", "x", "--owner", "x", "--gpus", "99",
                                       "--", "do-not-run"]), 1)
            popen.assert_not_called()

    def test_lost_ack_retries_do_not_duplicate_registration_or_final_result(self):
        seen = set()
        def lost_ack(argv):
            result = self.request(argv)
            if argv[0] in ("add", "finish") and argv[0] not in seen:
                seen.add(argv[0])
                raise cli.TransportError("ACK lost")
            return result
        with patch.object(cli, "request", side_effect=lost_ack):
            self.assertEqual(self.run_command([sys.executable, "-c", "pass"]), 0)
        self.assertEqual(len(agent.read_jobs(self.config["state_dir"])), 1)
        self.assertEqual(self.job()["status"], "completed")
        self.assertEqual(self.receipts(), [])

    def test_final_outage_is_durable_and_replay_only_sends_finish(self):
        def fail_finish(argv):
            if argv[0] == "finish":
                raise cli.TransportError("service restarting")
            return self.request(argv)
        with patch.object(cli, "request", side_effect=fail_finish):
            self.assertEqual(self.run_command([sys.executable, "-c", "raise SystemExit(9)"]), 9)
        receipt = self.receipts()[0]
        record = json.loads(receipt.read_text())
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        self.assertEqual(receipt.parent.stat().st_mode & 0o777, 0o700)
        ended = record["pending"][record["pending"].index("--at") + 1]
        with patch.object(cli.subprocess, "Popen") as popen:
            self.assertEqual(cli.main(["replay"]), 0)
            popen.assert_not_called()
        self.assertEqual(self.job()["status"], "failed")
        self.assertEqual(self.job()["exit_code"], 9)
        self.assertEqual(self.job()["ended_at"], ended)
        self.assertEqual(self.receipts(), [])

    def test_ambiguous_registration_does_not_launch_and_can_be_reconciled(self):
        def fail_ack(argv):
            result = self.request(argv)
            if argv[0] == "add":
                raise cli.TransportError("lost response")
            return result
        with patch.object(cli, "request", side_effect=fail_ack), patch.object(cli.subprocess, "Popen") as popen:
            self.assertEqual(self.run_command(["do-not-run"]), 1)
            popen.assert_not_called()
        self.assertEqual(cli.main(["replay"]), 0)
        self.assertEqual(self.job()["status"], "cancelled")

    def test_stale_receipt_cannot_override_manual_correction_or_restart(self):
        token = "a" * 32
        self.request(["add", "--id", "x", "--name", "x", "--owner", "x", "--gpus", "0", "--run-token", token])
        final = ["finish", "--id", "x", "--run-token", token, "--status", "failed", "--exit-code", "7"]
        self.request(["finish", "--id", "x", "--status", "cancelled"])
        with self.assertRaises(ValueError):
            self.request(final)
        self.request(["update", "--id", "x", "--start", agent.now_iso()])
        with self.assertRaises(ValueError):
            self.request(final)
        self.assertEqual(self.job()["status"], "running")

    def test_dead_runner_is_unknown_until_real_result_arrives(self):
        token = "b" * 32
        self.request(["add", "--id", "x", "--name", "x", "--owner", "x", "--gpus", "0",
                      "--run-token", token, "--runner-pid", str(os.getpid())])
        with patch.object(agent, "pid_identity", return_value=None):
            job = agent.make_snapshot(self.config)["jobs"][0]
        self.assertEqual(job["status"], "unknown")
        self.assertIsNone(job["ended_at"])
        self.request(["finish", "--id", "x", "--run-token", token, "--exit-code", "0"])
        self.assertEqual(self.job()["status"], "completed")

    def test_broker_rejects_execution_requests_and_foreign_runner_pid(self):
        for argv in (["run", "--name", "x", "--owner", "x", "--gpus", "0", "--", "true"], ["replay"]):
            with self.assertRaises(ValueError):
                self.request(argv)
        with self.assertRaisesRegex(ValueError, "자기 계정"):
            self.broker.dispatch(["add", "--id", "x", "--name", "x", "--owner", "x", "--gpus", "0",
                                  "--run-token", "c" * 32, "--runner-pid", str(os.getpid())], os.getuid() + 1)

    def test_replay_skips_active_runner_receipt(self):
        path = cli.receipt_directory() / "active.json"
        agent.atomic_json(path, {"id": "x", "pending": None})
        with cli.receipt_lock(path):
            self.assertEqual(cli.main(["replay"]), 0)
        self.assertTrue(path.exists())

    def test_sigint_and_sigterm_forward_to_child_group_and_preserve_unrelated_process(self):
        # Separate runner process so the unit-test process never changes its own
        # signal disposition or sends a cancellation signal to itself.
        helper = self.root / "runner.py"
        helper.write_text('''import json,os,sys
sys.path.insert(0,sys.argv[1])
import gpu_agent as agent, shared_cli as cli, shared_daemon as shared
agent.collect_gpus=lambda:[{"uuid":"GPU-A","index":0}]
broker=shared.Broker({"server_id":"test","name":"Test","state_dir":sys.argv[2]})
def request(argv):
    # Signal test only: this sandbox may not expose spawned PIDs in /proc.
    # Actual peer UID and runner PID checks have separate broker/install tests.
    if "--runner-pid" in argv:
        pos=argv.index("--runner-pid")
        argv=argv[:pos]+argv[pos+2:]
    return broker.dispatch(argv,os.getuid())
cli.request=request
raise SystemExit(cli.main(["run","--id","signal","--name","x","--owner","x","--gpus","0","--"]+sys.argv[3:]))
''')
        child = self.root / "child.py"
        child.write_text('''import os,pathlib,signal,subprocess,sys,time
# Workers inherit the runner's command group. Their handlers make delivery observable.
worker=subprocess.Popen([sys.executable,"-c", "import pathlib,signal,sys,time; signal.signal(signal.SIGINT,lambda *_:sys.exit(0)); signal.signal(signal.SIGTERM,lambda *_:sys.exit(0)); pathlib.Path(sys.argv[1]).touch(); time.sleep(30)", sys.argv[1]+".worker"])
def stop(*_):
    worker.wait(timeout=5)
    pathlib.Path(sys.argv[1]+".stopped").touch()
    raise SystemExit(0)
signal.signal(signal.SIGINT,stop)
signal.signal(signal.SIGTERM,stop)
pathlib.Path(sys.argv[1]).touch()
time.sleep(30)
''')
        unrelated = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])
        try:
            for signum in (signal.SIGINT, signal.SIGTERM):
                marker = self.root / ("ready-" + str(signum))
                state = self.root / ("signal-" + str(signum))
                runner = subprocess.Popen([sys.executable, str(helper), str(Path(cli.__file__).parent), str(state),
                                           sys.executable, str(child), str(marker)], stderr=subprocess.PIPE, text=True)
                try:
                    deadline = time.monotonic() + 8
                    while not (marker.exists() and Path(str(marker) + ".worker").exists()):
                        if runner.poll() is not None or time.monotonic() > deadline:
                            self.fail("runner did not become ready: " + (runner.communicate(timeout=1)[1] if runner.poll() is not None else "timed out"))
                        time.sleep(0.02)
                    runner.send_signal(signum)
                    _, stderr = runner.communicate(timeout=8)
                    self.assertEqual(runner.returncode, 128 + signum, stderr)
                    job = agent.read_jobs(state)[0]
                    self.assertEqual((job["status"], job["exit_code"], job["stop_signal"]), ("cancelled", 0, signum))
                    self.assertTrue(Path(str(marker) + ".stopped").exists())
                    self.assertIsNone(unrelated.poll())
                finally:
                    if runner.poll() is None:
                        runner.kill()
                        runner.wait()
                    runner.stderr.close()
        finally:
            unrelated.terminate()
            unrelated.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
