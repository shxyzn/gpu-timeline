import ast
import concurrent.futures
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "agent"))
import gpu_agent as agent
import shared_daemon as shared
import install_shared as installer


class SharedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = {"server_id": "test-server", "name": "Test", "state_dir": self.temp.name}
        self.broker = shared.Broker(self.config)
        self.gpus = [{"uuid": "GPU-A", "index": 0, "name": "GPU", "memory_total_mib": 24000,
                      "memory_used_mib": 2000, "utilization": 0, "process_count": 1}]
        self.gpu_patch = patch.object(agent, "collect_gpus", return_value=self.gpus)
        self.gpu_patch.start()

    def tearDown(self):
        self.gpu_patch.stop()
        self.temp.cleanup()

    def add(self, uid, job_id="exp01"):
        return self.broker.dispatch(["add", "--id", job_id, "--name", "GEPA", "--gpus", "0",
                                     "--owner", "공개 별명"], uid)

    def require_socket(self):
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM):
                pass
        except PermissionError:
            if os.environ.get("GPU_TIMELINE_REQUIRE_SOCKET_TESTS") == "1":
                raise
            self.skipTest("This execution sandbox forbids Unix sockets; run the required CI socket checks")

    def test_same_id_belongs_to_separate_accounts(self):
        self.add(1001)
        self.add(1002)
        self.broker.dispatch(["finish", "--id", "exp01", "--status", "failed"], 1001)
        one = self.broker.dispatch(["list"], 1001)["jobs"]
        two = self.broker.dispatch(["list"], 1002)["jobs"]
        self.assertEqual(one[0]["status"], "failed")
        self.assertEqual(two[0]["status"], "running")
        self.assertEqual(one[0]["id"], "exp01")
        snapshot = agent.make_snapshot(self.config)
        self.assertEqual(len({j["id"] for j in snapshot["jobs"]}), 2)
        for job in snapshot["jobs"]:
            self.assertEqual(job["owner"], "공개 별명")
            self.assertNotIn("_owner_uid", job)
            self.assertNotIn("_local_id", job)

    def test_another_user_cannot_edit_using_local_or_public_id(self):
        self.add(1001)
        public_id = agent.read_jobs(self.temp.name)[0]["id"]
        for job_id in ("exp01", public_id):
            with self.assertRaises(ValueError):
                self.broker.dispatch(["finish", "--id", job_id], 1002)
        self.assertEqual(self.broker.dispatch(["list"], 1002)["jobs"], [])

    def test_concurrent_registration_does_not_lose_records(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(self.add, range(1001, 1021)))
        self.assertEqual(len(agent.read_jobs(self.temp.name)), 20)

    def test_clients_cannot_set_owner_uid_paths_or_run_collector(self):
        invalid = [["collect", "--publish"], ["--config", "/tmp/fake", "list"],
                   ["add", "--id", "x", "--name", "x", "--gpus", "0", "--owner", "x", "--uid", "1001"],
                   ["finish", "--id", "../1001/exp01"], ["--help"], {"action": "list"}]
        for argv in invalid:
            with self.assertRaises(ValueError):
                self.broker.dispatch(argv, 1002)

    def test_pid_must_belong_to_calling_account(self):
        other_uid = os.getuid() + 1
        with self.assertRaisesRegex(ValueError, "자기 계정"):
            self.broker.dispatch(["add", "--id", "x", "--name", "x", "--gpus", "0",
                                  "--owner", "label", "--pid", str(os.getpid())], other_uid)
        with self.assertRaises(ValueError):
            self.broker.dispatch(["update", "--id", "x", "--pid", "0"], os.getuid())

    def test_failed_upload_keeps_durable_metadata_and_reports_failure(self):
        self.add(1001)
        with patch.object(agent, "publish", side_effect=OSError("secret test value")):
            self.assertFalse(self.broker.publish_once())
        status = self.broker.dispatch(["status"], 1001)
        self.assertIsNone(status["last_upload_at"])
        self.assertNotIn("secret test value", status["error"])
        restarted = shared.Broker(self.config)
        self.assertEqual(restarted.dispatch(["list"], 1001)["jobs"][0]["id"], "exp01")
        with patch.object(agent, "publish"):
            self.assertTrue(restarted.publish_once())
        self.assertIsNotNone(restarted.dispatch(["status"], 1001)["last_upload_at"])

    def test_legacy_migration_preserves_job_and_is_idempotent(self):
        old = [{"id": "legacy", "status": "running", "_pid": 123,
                "_pid_identity": "identity", "started_at": "2026-09-01T01:00:00+00:00"}]
        migrated = installer.migrate_jobs(old, 1001)
        self.assertEqual(migrated[0]["id"], "legacy")
        self.assertEqual(migrated[0]["_owner_uid"], 1001)
        self.assertEqual(migrated[0]["_pid_identity"], "identity")
        self.assertEqual(installer.migrate_jobs(migrated, 1002), migrated)
        self.assertNotIn("_owner_uid", old[0])

    def test_unit_uses_explicit_conda_interpreter_and_unprivileged_owner(self):
        unit = installer.service_text("cvml", "/home/cvml/anaconda3/envs/py311/bin/python")
        self.assertIn("User=cvml\n", unit)
        self.assertIn("ExecStart=/home/cvml/anaconda3/envs/py311/bin/python -s ", unit)
        self.assertIn("EnvironmentFile=/etc/gpu-timeline/agent.env", unit)
        with self.assertRaises(ValueError):
            installer.service_text("cvml", "/tmp/python\nUser=root")


    def test_public_reference_matches_dashboard_and_preserves_account_isolation(self):
        result = self.add(1001)
        reference = result["reference"]
        one = self.broker.dispatch(["list"], 1001)["jobs"][0]
        public = agent.make_snapshot(self.config)["jobs"][0]
        self.assertEqual(reference, self.config["server_id"] + "/" + public["id"])
        self.assertEqual(one["reference"], reference)
        self.assertEqual(one["id"], "exp01")
        self.broker.dispatch(["update", "--id", reference, "--name", "Renamed"], 1001)
        for argv in (["finish", "--id", reference],
                     ["update", "--id", reference, "--name", "Forbidden"]):
            with self.assertRaises(ValueError):
                self.broker.dispatch(argv, 1002)
        with self.assertRaises(ValueError):
            self.broker.dispatch(["finish", "--id", "wrong-server/" + public["id"]], 1001)
        self.broker.dispatch(["finish", "--id", reference], 1001)
        own = self.broker.dispatch(["list"], 1001)["jobs"][0]
        self.assertEqual((own["name"], own["status"]), ("Renamed", "completed"))

    def test_qualified_ids_cannot_be_used_to_register_or_escape_paths(self):
        for job_id in ("test-server/job-example", "../example", "test-server/../example"):
            with self.assertRaises(ValueError):
                self.add(1001, job_id)

    def test_progress_timestamp_is_published_and_restart_drops_old_progress(self):
        self.add(1001)
        stamp = agent.now_iso()
        with patch.object(agent, "now_iso", return_value=stamp):
            self.broker.dispatch(["update", "--id", "exp01", "--completed", "25", "--total", "100"], 1001)
        self.assertEqual(agent.make_snapshot(self.config)["jobs"][0]["progress"],
                         {"completed": 25, "total": 100, "updated_at": stamp})
        self.broker.dispatch(["update", "--id", "exp01", "--start", stamp], 1001)
        self.assertNotIn("progress", agent.make_snapshot(self.config)["jobs"][0])

    def test_status_and_snapshot_report_the_same_installed_version(self):
        version = {"version": "1.1.0", "deployment_version": "1.1", "revision": "a" * 40,
                   "dirty": False, "installed_at": agent.now_iso()}
        with patch.object(agent.version_info, "runtime_version", return_value=version):
            self.assertEqual(self.broker.dispatch(["status"], 1001)["agent_version"], version)
            self.assertEqual(agent.make_snapshot(self.config)["agent_version"], version)

    def test_shared_client_and_imports_parse_on_python38(self):
        root = Path(__file__).parents[1] / "agent"
        for name in ("shared_cli.py", "gpu_agent.py", "version_info.py"):
            ast.parse((root / name).read_text(), feature_version=(3, 8))

    def test_unix_socket_rejects_claimed_uid_and_uses_kernel_identity(self):
        self.require_socket()
        socket_path = str(Path(self.temp.name) / "control.sock")
        with shared.Server(socket_path, self.broker) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def request(payload):
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                        client.settimeout(3)
                        client.connect(socket_path)
                        client.sendall(json.dumps(payload).encode() + b"\n")
                        return json.loads(client.makefile("rb").readline())
                self.assertFalse(request({"argv": ["list"], "uid": 1001})["ok"])
                self.assertFalse(request({"argv": ["collect", "--publish"]})["ok"])
                self.assertTrue(request({"argv": ["add", "--id", "socket", "--name", "x",
                                                    "--gpus", "0", "--owner", "x"]})["ok"])
                stored = agent.read_jobs(self.temp.name)[0]
                self.assertEqual(stored["_owner_uid"], os.getuid())
                self.assertTrue(request({"argv": ["status"]})["ok"])
            finally:
                server.shutdown()
                thread.join(timeout=3)

    @unittest.skipUnless(os.geteuid() == 0, "Real second-UID check requires root in the test container")
    def test_other_os_account_can_connect_but_cannot_change_first_accounts_job(self):
        self.require_socket()
        os.chmod(self.temp.name, 0o755)
        self.add(0)
        path = str(Path(self.temp.name) / "control.sock")
        script = """import json, socket, sys
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as c:
    c.connect(sys.argv[1])
    c.sendall(json.dumps({'argv': json.loads(sys.argv[2])}).encode() + b'\\n')
    print(c.makefile('rb').readline().decode())
"""
        def as_other_user():
            os.setgroups([])
            os.setgid(65534)
            os.setuid(65534)
        with shared.Server(path, self.broker) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def request(argv):
                    completed = subprocess.run(["/usr/bin/python3", "-c", script, path, json.dumps(argv)],
                                               preexec_fn=as_other_user, check=True, capture_output=True,
                                               text=True, timeout=10)
                    return json.loads(completed.stdout)
                self.assertFalse(request(["finish", "--id", "exp01"])["ok"])
                self.assertTrue(request(["add", "--id", "exp01", "--name", "second",
                                         "--gpus", "0", "--owner", "second"])["ok"])
                jobs = agent.read_jobs(self.temp.name)
                self.assertEqual({j["_owner_uid"] for j in jobs}, {0, 65534})
            finally:
                server.shutdown()
                thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
