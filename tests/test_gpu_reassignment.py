"""Exercise real parsers, storage, Unix transport and publication; fake only GPUs/HTTP."""
import base64
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "agent"))
import gpu_agent as agent
import shared_cli as cli
import shared_daemon as shared


class GPUReassignmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = {"server_id": "test-server", "name": "Test", "state_dir": self.temp.name,
                       "github_repository": "fixture/unused", "github_branch": "status"}
        self.broker = shared.Broker(self.config)
        self.gpus = [{"uuid": "GPU-" + str(i), "index": i, "name": "Test GPU",
                      "memory_total_mib": 24000, "memory_used_mib": 100,
                      "utilization": 0, "process_count": 0} for i in range(2)]
        gpu_patch = patch.object(agent, "collect_gpus", return_value=self.gpus)
        self.collect = gpu_patch.start()
        self.addCleanup(gpu_patch.stop)
        self.path = Path(self.temp.name) / "jobs.json"

    def add(self, uid=1001, extra=()):
        return self.broker.dispatch(["add", "--id", "exp19", "--name", "Experiment",
                                    "--owner", "Owner", "--gpus", "1",
                                    "--start", "2026-09-30T01:00:00+00:00",
                                    "--end", "2026-10-01T01:00:00+00:00",
                                    "--description", "Keep this", *extra], uid)

    def test_same_id_and_all_other_metadata_survive_planned_and_running_updates(self):
        for planned in (False, True):
            with self.subTest(planned=planned):
                if self.path.exists():
                    self.path.unlink()
                ref = self.add(extra=["--planned"] if planned else ["--run-token", "a" * 32])["reference"]
                self.add(1002)
                self.broker.dispatch(["update", "--id", ref, "--completed", "5", "--total", "20"], 1001)
                before = agent.read_jobs(self.temp.name)
                # Private tracking metadata must survive even without a token on a manual correction.
                before[0].update(_pid=123, _pid_identity="identity", _runner_pid=456,
                                 _runner_identity="runner-identity")
                agent.atomic_json(self.path, before)
                self.broker.pending.clear()
                result = self.broker.dispatch(["update", "--id", ref, "--gpus", "0,GPU-0,1"], 1001)
                before[0]["gpu_uuids"] = ["GPU-0", "GPU-1"]
                self.assertEqual(agent.read_jobs(self.temp.name), before)
                self.assertEqual(result["reference"], ref)
                self.assertTrue(self.broker.pending.is_set())
                self.broker.dispatch(["update", "--id", "exp19", "--gpus", "GPU-0"], 1001)
                self.assertEqual(self.broker.dispatch(["list"], 1001)["jobs"][0]["gpu_uuids"], ["GPU-0"])

    def test_omitted_option_does_not_collect_or_change_gpus(self):
        self.add()
        self.collect.reset_mock()
        self.collect.side_effect = RuntimeError("GPU query unavailable")
        self.broker.dispatch(["update", "--id", "exp19", "--name", "Renamed"], 1001)
        self.collect.assert_not_called()
        self.assertEqual(agent.read_jobs(self.temp.name)[0]["gpu_uuids"], ["GPU-1"])

    def test_invalid_updates_are_atomic_and_do_not_request_upload(self):
        self.add()
        before = self.path.read_bytes()
        self.broker.pending.clear()
        for suffix in (["--gpus", ""], ["--gpus", "2"], ["--gpus", "0,"],
                       ["--gpus", "0", "--completed", "10", "--total", "1"]):
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                self.broker.dispatch(["update", "--id", "exp19", *suffix], 1001)
            self.assertEqual(self.path.read_bytes(), before)
            self.assertFalse(self.broker.pending.is_set())
        self.collect.side_effect = RuntimeError("GPU query unavailable")
        with self.assertRaises(RuntimeError):
            self.broker.dispatch(["update", "--id", "exp19", "--gpus", "0"], 1001)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(self.broker.pending.is_set())

    def test_ownership_server_and_run_token_checked_before_gpu_query(self):
        ref = self.add(extra=["--run-token", "a" * 32])["reference"]
        before = self.path.read_bytes()
        self.collect.reset_mock()
        for uid, job_id, extra in ((1002, "exp19", []), (1002, ref, []),
                                   (1001, "other/" + ref.split("/")[1], []),
                                   (1001, ref, ["--run-token", "b" * 32])):
            with self.subTest(uid=uid, job_id=job_id, extra=extra), self.assertRaises(ValueError):
                self.broker.dispatch(["update", "--id", job_id, "--gpus", "0", *extra], uid)
        self.collect.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)

    def test_delayed_update_cannot_change_finished_automatic_run(self):
        self.add(extra=["--run-token", "a" * 32])
        self.broker.dispatch(["update", "--id", "exp19", "--gpus", "0", "--run-token", "a" * 32], 1001)
        for status in ("completed", "failed", "cancelled"):
            self.broker.dispatch(["finish", "--id", "exp19", "--status", status,
                                  "--exit-code", "0", "--at", "2026-09-30T02:00:00+00:00",
                                  "--run-token", "a" * 32], 1001)
            before = self.path.read_bytes()
            self.collect.reset_mock()
            self.broker.dispatch(["update", "--id", "exp19", "--gpus", "1",
                                  "--run-token", "a" * 32], 1001)
            self.assertEqual(self.path.read_bytes(), before)
            self.collect.assert_not_called()

    def test_real_cli_socket_broker_and_publication_keep_corrected_gpu(self):
        socket_path = str(Path(self.temp.name) / "control.sock")
        try:
            server = shared.Server(socket_path, self.broker)
        except PermissionError:
            if os.environ.get("GPU_TIMELINE_REQUIRE_SOCKET_TESTS") == "1":
                raise
            self.skipTest("Unix sockets unavailable; required in CI")
        with server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.object(cli, "SOCKET_PATH", socket_path), redirect_stdout(io.StringIO()):
                    self.assertEqual(cli.main(["add", "--id", "exp19", "--name", "Real CLI",
                                               "--owner", "Owner", "--gpus", "1"]), 0)
                    original = agent.read_jobs(self.temp.name)[0]
                    ref = "test-server/" + original["id"]
                    self.broker.pending.clear()
                    self.assertEqual(cli.main(["update", "--id", ref, "--gpus", "0"]), 0)
                    self.assertTrue(self.broker.pending.is_set())
                    self.assertEqual(cli.request(["list"])["jobs"][0]["gpu_uuids"], ["GPU-0"])
                    with patch.dict(os.environ, {"GPU_TIMELINE_TOKEN": "test-only"}), \
                            patch.object(agent, "github_request", side_effect=[{"sha": "old"}, {}]) as http:
                        self.assertTrue(self.broker.publish_once())
                    call = http.call_args_list[1].args
                    self.assertEqual(call[0:2], ("PUT", "/repos/fixture/unused/contents/servers/test-server.json"))
                    self.assertEqual(call[3]["branch"], "status")
                    uploaded = json.loads(base64.b64decode(call[3]["content"]))
                    self.assertEqual(uploaded["jobs"][0]["id"], original["id"])
                    self.assertEqual(uploaded["jobs"][0]["gpu_uuids"], ["GPU-0"])
                    self.assertFalse(any(key.startswith("_") for key in uploaded["jobs"][0]))
                    status = cli.request(["status"])
                    self.assertIsNotNone(status["last_upload_at"])
                    self.assertIn("gpu-reassignment-v1", status["capabilities"])
                    self.assertEqual(agent.read_jobs(self.temp.name)[0]["_owner_uid"], os.getuid())
            finally:
                server.shutdown()
                thread.join(timeout=3)

    def test_legacy_parser_and_metadata_path_also_support_reassignment(self):
        parser = agent.parser()
        prefix = ["--config", "unused.json"]
        with redirect_stdout(io.StringIO()):
            agent.metadata_command(self.config, parser.parse_args(prefix + ["add", "--id", "legacy",
                                   "--name", "Legacy", "--gpus", "1"]))
            agent.metadata_command(self.config, parser.parse_args(prefix + ["update", "--id", "legacy", "--gpus", "0"]))
        self.assertEqual(agent.read_jobs(self.temp.name)[0]["gpu_uuids"], ["GPU-0"])

    def test_installer_import_leaves_no_bytecode_in_temporary_source(self):
        source = Path(__file__).parents[1] / "agent"
        with tempfile.TemporaryDirectory() as directory:
            for name in ("install_shared.py", "gpu_agent.py", "version_info.py"):
                shutil.copyfile(source / name, Path(directory) / name)
            env = dict(os.environ)
            env.pop("PYTHONDONTWRITEBYTECODE", None)
            subprocess.run([sys.executable, str(Path(directory) / "install_shared.py"), "--help"],
                           env=env, check=True, capture_output=True, text=True, timeout=10)
            self.assertFalse((Path(directory) / "__pycache__").exists())


if __name__ == "__main__":
    unittest.main()
