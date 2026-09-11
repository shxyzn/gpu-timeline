#!/usr/bin/env python3
"""One local broker and publisher per server. No TCP port or shell execution.

Local users may record their own experiments through a Unix socket. Linux peer
credentials supply ownership; neither request data nor public labels grant it.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import socketserver
import struct
import threading
import time

import gpu_agent as agent

SOCKET_PATH = "/run/gpu-timeline/control.sock"
MAX_REQUEST = 16384


class RequestParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)

    def exit(self, status=0, message=None):
        raise ValueError(message or "도움말은 gputl --help로 확인하세요.")


def validate_request(argv, uid):
    if (not isinstance(argv, list) or not argv or len(argv) > 64
            or any(not isinstance(v, str) or len(v) > 4096 for v in argv)):
        raise ValueError("잘못된 요청입니다.")
    if any(v in ("-h", "--help") for v in argv):
        raise ValueError("도움말은 gputl --help로 확인하세요.")
    args = agent.parser(shared=True, parser_class=RequestParser).parse_args(argv)
    if args.action in ("add", "update", "finish"):
        if not agent.re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", args.id):
            raise ValueError("실험 ID는 영문·숫자로 시작하는 128자 이하 영문·숫자·._-만 사용하세요.")
        for key, limit in (("name", 200), ("owner", 80)):
            value = getattr(args, key, None)
            if value is not None and (not value.strip() or len(value) > limit
                                      or any(ord(c) < 32 for c in value)):
                raise ValueError(f"{key}: 비어 있지 않은 {limit}자 이하 한 줄을 입력하세요.")
        pid = getattr(args, "pid", None)
        if pid is not None:
            if pid <= 0:
                raise ValueError("PID는 양수여야 합니다.")
            try:
                # /proc ownership comes from the kernel, never from the client.
                process_uid = Path(f"/proc/{pid}").stat().st_uid
            except OSError:
                raise ValueError("PID를 확인할 수 없습니다. --pid를 생략하고 결과를 직접 기록하세요.") from None
            if process_uid != uid:
                raise ValueError("자기 계정의 PID만 연결할 수 있습니다.")
    return args


class Broker:
    def __init__(self, config):
        self.config = config
        self.pending = threading.Event()
        self.pending.set()
        self.stopping = threading.Event()
        self.status_lock = threading.Lock()
        self.upload = {"last_upload_at": None, "last_attempt_at": None, "error": None}

    def dispatch(self, argv, uid):
        args = validate_request(argv, uid)
        if args.action == "status":
            with self.status_lock:
                return {"ok": True, "server_id": self.config["server_id"],
                        "name": self.config["name"], **self.upload,
                        "upload_requested": self.pending.is_set()}
        if args.action == "list":
            with agent.locked(Path(self.config["state_dir"]) / "jobs.lock"):
                jobs = agent.read_jobs(self.config["state_dir"])
            own = [j for j in jobs if j.get("_owner_uid") == uid][-100:]
            return {"ok": True, "jobs": [{"id": j["_local_id"], "name": j["name"],
                    "owner": j.get("owner"), "status": j["status"],
                    "started_at": j["started_at"], "expected_end_at": j.get("expected_end_at")}
                    for j in own]}
        if args.action != "sync":
            agent.metadata_command(self.config, args, owner_uid=uid)
        self.pending.set()
        return {"ok": True, "message": "업로드를 요청했어요." if args.action == "sync" else
                f"실험 정보 저장: {args.id}. 업로드를 요청했어요.",
                "note": "저장은 완료되었습니다. 업로드 결과는 gputl status로 확인하세요."}

    def publish_once(self):
        with self.status_lock:
            self.upload["last_attempt_at"] = agent.now_iso()
        try:
            with agent.locked(Path(self.config["state_dir"]) / "collect.lock", blocking=False):
                snapshot = agent.make_snapshot(self.config)
                agent.publish(self.config, snapshot)
            with self.status_lock:
                self.upload.update(last_upload_at=agent.now_iso(), error=None,
                                   collector_ok=snapshot["collector_ok"])
            print(f"업로드 완료: {self.config['server_id']} · {len(snapshot['gpus'])} GPU", flush=True)
            return True
        except Exception as error:
            # Do not expose request objects, credentials, paths or exception text.
            message = "업로드 실패. 관리자가 gpu-timeline-shared 서비스의 설정·토큰·네트워크를 확인해야 합니다."
            with self.status_lock:
                self.upload["error"] = message
            print(f"업로드 실패 ({type(error).__name__}). 설정·토큰·네트워크 확인 필요.", flush=True)
            return False

    def publisher(self):
        interval = max(60, int(self.config.get("publish_seconds", 600)))
        next_attempt = 0.0
        earliest = 0.0
        while not self.stopping.is_set():
            now = time.monotonic()
            if now >= earliest and (self.pending.is_set() or now >= next_attempt):
                # Clear before collecting: a change during upload requests another pass.
                self.pending.clear()
                success = self.publish_once()
                now = time.monotonic()
                earliest = now + 30  # Coalesce edits and bound GitHub writes.
                next_attempt = now + (interval if success else 60)
            self.stopping.wait(1)


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(5)
        try:
            credentials = self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED,
                                                     struct.calcsize("3i"))
            _, uid, _ = struct.unpack("3i", credentials)
            data = self.rfile.readline(MAX_REQUEST + 1)
            if len(data) > MAX_REQUEST or not data.endswith(b"\n"):
                raise ValueError("요청이 너무 크거나 끝나지 않았습니다.")
            request = json.loads(data)
            if not isinstance(request, dict) or set(request) != {"argv"}:
                raise ValueError("잘못된 요청입니다.")
            result = self.server.broker.dispatch(request["argv"], uid)
        except ValueError as error:
            result = {"ok": False, "error": str(error)}
        except Exception:
            result = {"ok": False, "error": "요청을 처리하지 못했습니다. 관리자가 서비스 로그를 확인해야 합니다."}
        try:
            self.wfile.write((json.dumps(result, ensure_ascii=False) + "\n").encode())
        except OSError:
            pass


class Server(socketserver.UnixStreamServer):
    def __init__(self, path, broker):
        self.broker = broker
        super().__init__(path, Handler)
        # All local accounts may connect; ownership is enforced using SO_PEERCRED.
        os.chmod(path, 0o666)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = agent.load_config(args.config)
    os.umask(0o077)
    with agent.locked(Path(config["state_dir"]) / "broker.lock", blocking=False):
        path = Path(SOCKET_PATH)
        if path.exists():
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                probe.settimeout(2)
                try:
                    probe.connect(str(path))
                except ConnectionRefusedError:
                    path.unlink()  # Stale socket after an interrupted service.
                else:
                    raise RuntimeError("공용 수집기가 이미 실행 중입니다.")
        broker = Broker(config)
        with Server(str(path), broker) as server:
            worker = threading.Thread(target=broker.publisher, daemon=True)
            worker.start()
            try:
                server.serve_forever(poll_interval=0.5)
            finally:
                broker.stopping.set()
                path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
