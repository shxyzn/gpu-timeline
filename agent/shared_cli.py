#!/usr/bin/python3
"""Shared client and local experiment runner. Python 3.8+, stdlib only."""
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import uuid

import gpu_agent

SOCKET_PATH = "/run/gpu-timeline/control.sock"


class TransportError(Exception):
    pass


def request(argv):
    data = (json.dumps({"argv": argv}, ensure_ascii=False) + "\n").encode()
    if len(data) > 16384:
        raise ValueError("요청이 너무 큽니다.")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(40)
            connection.connect(SOCKET_PATH)
            connection.sendall(data)
            with connection.makefile("rb") as response:
                line = response.readline(2 * 1024 * 1024 + 1)
            if len(line) > 2 * 1024 * 1024 or not line.endswith(b"\n"):
                raise ValueError("invalid response")
            result = json.loads(line)
            if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                raise ValueError("invalid response")
    except (OSError, ValueError):
        raise TransportError("공용 수집기 응답을 확인하지 못했습니다. "
                             "관리자에게 gpu-timeline-shared 서비스 확인을 요청하세요.") from None
    if not result["ok"]:
        raise ValueError(result.get("error", "요청 실패"))
    return result


def send_retry(argv):
    # Mutations carrying a run token are idempotent even if an ACK was lost.
    try:
        return request(argv)
    except TransportError:
        return request(argv)


def note(message):
    print("[gputl] " + message, file=sys.stderr, flush=True)


def receipt_directory():
    base = os.environ.get("XDG_STATE_HOME")
    if not base or not Path(base).is_absolute():
        base = str(Path.home() / ".local" / "state")
    directory = Path(base) / "gpu-timeline" / "runs"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid():
        raise ValueError("이 계정 소유의 로컬 기록 디렉터리가 필요합니다.")
    directory.chmod(0o700)
    return directory


def receipt_lock(path, blocking=True):
    fd = os.open(str(path.with_suffix(".lock")), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    handle = os.fdopen(fd, "a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
    except BaseException:
        handle.close()
        raise
    return handle


def deliver(path, record, durable=True):
    try:
        send_retry(record["pending"])
    except (TransportError, ValueError) as error:
        note(str(error))
        note("종료 기록을 로컬에 보관했습니다. 수집기 복구 후 gputl replay를 실행하세요." if durable else
             "종료 결과를 저장하지 못했습니다. 실험 ID " + record["id"] + "의 결과를 gputl finish로 직접 기록하세요.")
        return False
    try:
        path.unlink(missing_ok=True)
        path.with_suffix(".lock").unlink(missing_ok=True)
    except OSError:
        note("결과는 저장됐지만 로컬 재전송 기록 정리에 실패했습니다.")
    note("종료 결과 저장 완료. 대시보드 업로드를 요청했어요.")
    return True


def replay():
    failures = 0
    count = 0
    for path in sorted(receipt_directory().glob("*.json")):
        try:
            lock = receipt_lock(path, blocking=False)
        except BlockingIOError:
            continue  # A foreground runner is still using this receipt.
        with lock:
            try:
                record = json.loads(path.read_text())
                pending = record.get("pending")
                if pending is None:
                    note("종료 결과가 없는 기록: " + str(record.get("id", path.stem)) +
                         ". 실행 상태를 확인한 뒤 gputl finish로 기록하세요.")
                    failures += 1
                    continue
                # Replay can only submit metadata, never rerun a command.
                if not isinstance(pending, list) or not pending or pending[0] != "finish":
                    raise ValueError("잘못된 로컬 종료 기록입니다.")
                count += 1
                failures += not deliver(path, record)
            except FileNotFoundError:
                pass
            except (OSError, ValueError) as error:
                note("로컬 기록 재전송 실패: " + str(error))
                failures += 1
    if not count and not failures:
        note("재전송할 종료 기록이 없습니다.")
    return 1 if failures else 0


def run_experiment(args):
    if not args.command or args.command[0] != "--" or len(args.command) < 2:
        raise ValueError("-- 뒤에 실행할 명령을 넣으세요. 예: gputl run --name 실험 --owner 별명 --gpus 0 -- python train.py")
    if "run-recording-v1" not in request(["status"]).get("capabilities", []):
        raise ValueError("관리자가 git pull 후 bash agent/install-shared.sh로 공용 수집기를 업데이트해야 합니다.")
    token = uuid.uuid4().hex
    job_id = args.id or "run-" + gpu_agent.datetime.now().strftime("%Y%m%d-%H%M%S-") + token[:8]
    path = receipt_directory() / (token + ".json")
    record = {"id": job_id, "pending": None}
    command = args.command[1:]
    child = None
    interrupted = []
    saved_handlers = {}

    def forward(signum, _frame):
        if not interrupted:
            interrupted.append(signum)
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signum)
            except ProcessLookupError:
                pass

    with receipt_lock(path):
        gpu_agent.atomic_json(path, record)  # Check durable local storage before launching.
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous = signal.getsignal(signum)
            if signum == signal.SIGHUP and previous == signal.SIG_IGN:
                continue  # Preserve nohup's deliberate SIGHUP handling.
            saved_handlers[signum] = previous
            signal.signal(signum, forward)
        try:
            started = gpu_agent.now_iso()
            add = ["add", "--id", job_id, "--name", args.name, "--owner", args.owner,
                   "--gpus", args.gpus, "--description", args.description,
                   "--start", started, "--run-token", token, "--runner-pid", str(os.getpid())]
            if args.end:
                add.extend(["--end", args.end])
            try:
                send_retry(add)
            except ValueError:
                path.unlink(missing_ok=True)
                path.with_suffix(".lock").unlink(missing_ok=True)
                raise  # Definite rejection: never start an unregistered command.
            except TransportError:
                # Registration may have been saved before its response was lost.
                record["pending"] = ["finish", "--id", job_id, "--run-token", token,
                                     "--status", "cancelled", "--at", gpu_agent.now_iso()]
                gpu_agent.atomic_json(path, record)
                note("실험 명령은 실행하지 않았습니다. 등록 여부 확인 및 정리를 위해 gputl replay를 실행하세요.")
                raise
            note("실험 등록: " + job_id + " · " + args.name)
            started = gpu_agent.now_iso()
            exit_code = None
            status = "cancelled" if interrupted else "failed"
            result_code = 128 + interrupted[0] if interrupted else 127
            if not interrupted:
                try:
                    # argv, cwd, environment and output stay in the calling account.
                    # The broker never receives the command and never executes it.
                    child = subprocess.Popen(command, start_new_session=True)
                except OSError as error:
                    note("실험 명령을 시작하지 못했습니다 (" + type(error).__name__ + "). 실행 경로와 권한을 확인하세요.")
                    result_code = 127 if isinstance(error, FileNotFoundError) else 126
                else:
                    if interrupted:
                        forward(interrupted[0], None)
                    # Wait immediately so metadata I/O cannot delay observation
                    # of a short command's exit. The final record includes start.
                    exit_code = child.wait()
                    status = "cancelled" if interrupted else "completed" if exit_code == 0 else "failed"
                    result_code = (128 + interrupted[0] if interrupted else
                                   128 - exit_code if exit_code < 0 else exit_code)
            if interrupted:
                status, result_code = "cancelled", 128 + interrupted[0]
            pending = ["finish", "--id", job_id, "--run-token", token, "--status", status,
                       "--start", started, "--at", gpu_agent.now_iso()]
            if exit_code is not None:
                pending.extend(["--exit-code", str(exit_code)])
            if interrupted or (exit_code is not None and exit_code < 0):
                pending.extend(["--stop-signal", str(interrupted[0] if interrupted else -exit_code)])
            record["pending"] = pending
            durable = True
            try:
                gpu_agent.atomic_json(path, record)
            except OSError:
                durable = False
                note("종료 결과의 로컬 보관에 실패했습니다. 아래 전송이 실패하면 gputl finish로 직접 기록하세요.")
            note("실험 종료: " + job_id + " · " + status)
            deliver(path, record, durable=durable)
            return result_code
        finally:
            for signum, previous in saved_handlers.items():
                signal.signal(signum, previous)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    args = gpu_agent.parser(shared=True, local_commands=True).parse_args(argv)
    try:
        if args.action == "run":
            return run_experiment(args)
        if args.action == "replay":
            return replay()
        result = request(argv)
        if "message" in result:
            print(result["message"])
            print(result.get("note", ""))
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, TransportError) as error:
        note("오류: " + str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
