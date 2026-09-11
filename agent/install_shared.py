#!/usr/bin/env python3
"""Administrator-only installation and migration, invoked by install-shared.sh."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys

import gpu_agent as agent

ROOT = Path("/opt/gpu-timeline")
ETC = Path("/etc/gpu-timeline")
STATE = Path("/var/lib/gpu-timeline")
UNIT = Path("/etc/systemd/system/gpu-timeline-shared.service")


def service_text(user, python):
    # These values occur in unit directives, not shell commands.
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*[$]?", user):
        raise ValueError("지원하지 않는 관리자 계정 이름입니다.")
    if not re.fullmatch(r"/[A-Za-z0-9_./+-]+", python):
        raise ValueError("Python 실행 경로에는 공백·제어문자·특수문자를 사용하지 마세요.")
    return f"""[Unit]
Description=Shared GPU Timeline collector and experiment registry
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={user}
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONNOUSERSITE=1
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/etc/gpu-timeline/agent.env
ExecStart={python} -s /opt/gpu-timeline/shared_daemon.py --config /etc/gpu-timeline/config.json
Restart=on-failure
RestartSec=5
RuntimeDirectory=gpu-timeline
RuntimeDirectoryMode=0755
StateDirectory=gpu-timeline
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
"""


def migrate_jobs(jobs, uid):
    result = []
    for job in jobs:
        item = dict(job)
        # Preserve public IDs, times, results and PID tracking from the old setup.
        item.setdefault("_owner_uid", uid)
        item.setdefault("_local_id", item["id"])
        result.append(item)
    return result


def write_owned(path, content, mode=0o644, uid=0, gid=0):
    # Replace atomically; never follow a preexisting file symlink.
    fd, temp = agent.tempfile.mkstemp(prefix=".install-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, mode)
        os.chown(temp, uid, gid)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def stop_legacy(account):
    home = Path(account.pw_dir)
    runtime = Path(f"/run/user/{account.pw_uid}")
    link = home / ".config/systemd/user/timers.target.wants/gpu-timeline.timer"
    if (runtime / "bus").exists():
        command = ["runuser", "-u", account.pw_name, "--", "env",
                   f"XDG_RUNTIME_DIR={runtime}",
                   f"DBUS_SESSION_BUS_ADDRESS=unix:path={runtime}/bus", "systemctl", "--user"]
        # Only stop this application's units; never touch experiments or other services.
        for unit in ("gpu-timeline.timer", "gpu-timeline.service"):
            state = subprocess.run(command + ["show", unit, "--property=LoadState", "--value"],
                                   capture_output=True, text=True)
            if state.returncode != 0:
                raise RuntimeError("기존 사용자 서비스 확인에 실패했습니다. 기존 수집기를 중지한 뒤 다시 실행하세요.")
            if state.stdout.strip() not in ("not-found", ""):
                subprocess.run(command + ["stop", unit], check=True)
    if link.is_symlink():
        link.unlink()  # Prevent the old timer restarting on the next login.
    elif link.exists():
        raise RuntimeError("기존 타이머 등록이 예상과 다릅니다. 수동으로 disable한 뒤 다시 실행하세요.")


def install(args):
    if os.geteuid() != 0:
        raise ValueError("관리자 계정에서 install-shared.sh로 실행하세요.")
    account = pwd.getpwnam(args.user)
    if account.pw_uid == 0:
        raise ValueError("수집기는 root가 아닌 관리자 로그인 계정으로 실행해야 합니다.")
    home = Path(account.pw_dir)
    source_dir = Path(__file__).resolve().parent
    text = service_text(args.user, args.python)
    source_config = Path(args.config) if args.config else (
        ETC / "config.json" if (ETC / "config.json").exists() else home / ".config/gpu-timeline/config.json")
    source_env = Path(args.env_file) if args.env_file else (
        ETC / "agent.env" if (ETC / "agent.env").exists() else home / ".config/gpu-timeline/agent.env")
    if not source_config.is_file():
        raise ValueError(f"기존 서버 설정 파일이 없습니다: {source_config}")
    if not source_env.is_file():
        raise ValueError(f"기존 토큰 환경 파일이 없습니다: {source_env}")
    config = json.loads(source_config.read_text())
    # Resolve legacy ~ against the installation owner's home, never root's home.
    state_value = config.get("state_dir", "~/.local/state/gpu-timeline")
    old_state = Path(str(home) + state_value[1:] if state_value.startswith("~/") else state_value)
    if not old_state.is_absolute():
        raise ValueError("기존 state_dir는 절대경로나 ~/ 경로여야 합니다.")
    if args.server_id:
        config["server_id"] = args.server_id
    config["state_dir"] = str(STATE)
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", config.get("server_id", "")):
        raise ValueError("올바른 server_id가 필요합니다.")
    if not isinstance(config.get("name"), str) or not config["name"].strip():
        raise ValueError("서버 표시 이름(name)이 필요합니다.")
    credentials = source_env.read_text()
    if not re.search(r"(?m)^GPU_TIMELINE_TOKEN=\S+", credentials):
        raise ValueError("agent.env에 GPU_TIMELINE_TOKEN이 필요합니다. 토큰을 설정한 뒤 다시 실행하세요.")
    for command in ("systemctl", "runuser", "nvidia-smi"):
        if not shutil.which(command):
            raise ValueError(f"필요한 명령을 찾지 못했습니다: {command}")
    subprocess.run(["runuser", "-u", args.user, "--", args.python, "-s", "-c",
                    "import sys; sys.exit(sys.version_info < (3, 10))"], check=True)
    subprocess.run(["/usr/bin/python3", "-c", "import sys; sys.exit(sys.version_info < (3, 8))"], check=True)
    for path in (ROOT, ETC, STATE):
        if path.is_symlink():
            raise ValueError(f"설치 경로가 심볼릭 링크입니다: {path}")
    launcher = Path("/usr/local/bin/gputl")
    if launcher.exists() and "/opt/gpu-timeline/shared_cli.py" not in launcher.read_text():
        raise ValueError("/usr/local/bin/gputl에 다른 명령이 있습니다. 파일을 확인한 뒤 다시 실행하세요.")
    if UNIT.exists():
        old_text = UNIT.read_text()
        old_user = re.search(r"(?m)^User=(.+)$", old_text)
        if not old_user or old_user.group(1) != args.user:
            raise ValueError("기존 공용 서비스의 설치 계정으로 업데이트하세요.")
    print(f"공용 수집기 설치: {config['server_id']} / {config['name']} / 관리자 {args.user}", flush=True)
    stop_legacy(account)
    if UNIT.exists():
        subprocess.run(["systemctl", "stop", "gpu-timeline-shared.service"], check=True)
    for path in (ROOT, ETC):
        path.mkdir(parents=True, exist_ok=True)
        os.chmod(path, 0o755)
        os.chown(path, 0, 0)
    STATE.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    os.chown(STATE, account.pw_uid, account.pw_gid)
    for filename in ("gpu_agent.py", "shared_daemon.py", "shared_cli.py"):
        write_owned(ROOT / filename, (source_dir / filename).read_text())
    write_owned(ETC / "config.json", json.dumps(config, ensure_ascii=False, indent=2) + "\n")
    write_owned(ETC / "agent.env", credentials, mode=0o600)
    if not (STATE / "jobs.json").exists() and (old_state / "jobs.json").exists():
        with agent.locked(old_state / "jobs.lock"):
            jobs = migrate_jobs(agent.read_jobs(old_state), account.pw_uid)
        write_owned(STATE / "jobs.json", json.dumps(jobs, ensure_ascii=False, indent=2) + "\n",
                    mode=0o600, uid=account.pw_uid, gid=account.pw_gid)
    if not (STATE / "snapshot.json").exists() and (old_state / "snapshot.json").exists():
        write_owned(STATE / "snapshot.json", (old_state / "snapshot.json").read_text(),
                    mode=0o600, uid=account.pw_uid, gid=account.pw_gid)
    Path("/usr/local/bin").mkdir(parents=True, exist_ok=True)
    write_owned(Path("/usr/local/bin/gputl"),
                '#!/bin/sh\nexec /usr/bin/python3 -s /opt/gpu-timeline/shared_cli.py "$@"\n', mode=0o755)
    write_owned(UNIT, text)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "--now", "gpu-timeline-shared.service"], check=True)
    subprocess.run(["systemctl", "is-active", "--quiet", "gpu-timeline-shared.service"], check=True)
    print("설치 완료. 모든 계정에서 /usr/local/bin/gputl status로 연결·업로드 결과를 확인하세요.")
    print("기존 실험 기록은 보존했습니다. GPU 작업 프로세스는 변경하지 않았습니다.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--config", help="기존 설정 파일 절대경로")
    parser.add_argument("--env-file", help="기존 토큰 환경 파일 절대경로")
    parser.add_argument("--server-id", help="이 서버의 ID. 예: server-b")
    try:
        install(parser.parse_args())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError, KeyError) as error:
        print(f"설치를 완료하지 못했습니다 ({type(error).__name__}).", file=sys.stderr)
        # Only deliberately authored validation messages are shown, never credential contents.
        if isinstance(error, (ValueError, RuntimeError)) and not isinstance(error, json.JSONDecodeError):
            print(str(error), file=sys.stderr)
        print("설정 파일·토큰 파일·Python 경로를 확인하세요. 기존 개인 수집기로 복귀하려면 "
              "공용 서비스를 중지하고 관리자 계정에서 기존 gpu-timeline.timer를 다시 활성화하세요.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
