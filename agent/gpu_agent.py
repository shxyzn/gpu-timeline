#!/usr/bin/env python3
"""Read-only GPU telemetry and experiment metadata. Python 3.10+, Linux, stdlib only.

No experiment launching, killing, GPU settings, or SSH credentials. GitHub write
credentials are read only from GPU_TIMELINE_TOKEN at publication time.
"""
from __future__ import annotations

import argparse
import base64
import csv
import fcntl
import io
import json
import math
import os
from pathlib import Path
import random
import re
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_time(value):
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("시간에는 시간대를 포함해 주세요. 예: 2026-09-12T09:00:00+09:00")
    return dt


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, indent=2, allow_nan=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextmanager
def locked(path, blocking=True):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield


def load_config(path):
    c = json.loads(Path(path).read_text(encoding="utf-8"))
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", c.get("server_id", "")):
        raise ValueError("server_id에는 소문자, 숫자, 하이픈만 사용하세요.")
    if not isinstance(c.get("name"), str) or not c["name"].strip():
        raise ValueError("서버 표시 이름(name)이 필요합니다.")
    c["state_dir"] = str(Path(c.get("state_dir", "~/.local/state/gpu-timeline")).expanduser().resolve())
    return c


def read_jobs(state):
    p = Path(state) / "jobs.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []


def numeric(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except ValueError:
        return None


def smi(query):
    result = subprocess.run(["nvidia-smi", query, "--format=csv,noheader,nounits"],
                            capture_output=True, text=True, timeout=15, check=True)
    return [row for row in csv.reader(io.StringIO(result.stdout), skipinitialspace=True) if row]


def collect_gpus():
    rows = smi("--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu")
    gpus = []
    for row in rows:
        if len(row) != 6:
            raise ValueError("예상과 다른 nvidia-smi 출력입니다.")
        index, uuid, name, total, used, util = row
        gpus.append({"index": int(index), "uuid": uuid.strip(), "name": name.strip(),
                     "memory_total_mib": numeric(total), "memory_used_mib": numeric(used),
                     "utilization": numeric(util), "process_count": None})
    try:
        processes = smi("--query-compute-apps=gpu_uuid,pid")
        counts = {g["uuid"]: set() for g in gpus}
        for row in processes:
            if len(row) == 2 and row[0].strip() in counts:
                counts[row[0].strip()].add(row[1].strip())
        for gpu in gpus:
            gpu["process_count"] = len(counts[gpu["uuid"]])
    except (OSError, subprocess.SubprocessError, ValueError):
        # Missing process visibility is unknown, never proof that a GPU is free.
        pass
    return gpus


def pid_identity(pid):
    try:
        # comm can contain spaces and parentheses; split after its final ')'.
        stat = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if stat[0] == "Z":
            return None
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        return f"{boot}:{pid}:{stat[19]}"
    except FileNotFoundError:
        return None


def normalize_gpu_selection(values, gpus):
    selected = []
    for value in values.split(","):
        value = value.strip()
        match = next((g for g in gpus if value == g["uuid"] or value == str(g["index"])), None)
        if match is None:
            raise ValueError(f"GPU를 찾을 수 없습니다: {value}")
        if match["uuid"] not in selected:
            selected.append(match["uuid"])
    return selected


def metadata_command(c, args):
    state = Path(c["state_dir"])
    with locked(state / "jobs.lock"):
        jobs = read_jobs(state)
        item = next((j for j in jobs if j["id"] == args.id), None)
        if args.action == "add":
            if item:
                raise ValueError("이미 존재하는 실험 id입니다. update를 사용하세요.")
            started = args.start or now_iso()
            parse_time(started)
            if args.end and parse_time(args.end) <= parse_time(started):
                raise ValueError("예상 종료시간은 시작시간 이후여야 합니다.")
            if args.planned and not args.end:
                raise ValueError("예정 실험은 --end를 입력해 주세요.")
            if args.planned and args.pid:
                raise ValueError("예정 실험에는 --pid를 연결할 수 없습니다.")
            item = {"id": args.id, "name": args.name, "description": args.description,
                    "gpu_uuids": normalize_gpu_selection(args.gpus, collect_gpus()),
                    "status": "planned" if args.planned else "running", "started_at": started,
                    "expected_end_at": args.end, "ended_at": None, "eta_source": "manual"}
            if args.pid:
                identity = pid_identity(args.pid)
                if not identity:
                    raise ValueError("지정한 PID가 실행 중이지 않습니다.")
                item["_pid"] = args.pid
                item["_pid_identity"] = identity
            jobs.append(item)
        elif item is None:
            raise ValueError("실험 id를 찾을 수 없습니다.")
        elif args.action == "finish":
            end = args.at or now_iso()
            if parse_time(end) < parse_time(item["started_at"]):
                raise ValueError("종료시간은 시작시간 이후여야 합니다.")
            item.update(status=args.status, ended_at=end, end_source="manual")
        elif args.action == "update":
            if args.name:
                item["name"] = args.name
            if args.description is not None:
                item["description"] = args.description
            if args.end:
                if parse_time(args.end) <= parse_time(item["started_at"]):
                    raise ValueError("예상 종료시간은 시작시간 이후여야 합니다.")
                item.update(expected_end_at=args.end, eta_source="manual")
            if args.clear_end:
                item.update(expected_end_at=None, eta_source="manual")
            if args.start:
                parse_time(args.start)
                if item.get("expected_end_at") and parse_time(item["expected_end_at"]) <= parse_time(args.start):
                    raise ValueError("새 시작시간은 예상 종료시간 이전이어야 합니다.")
                item.update(status="running", started_at=args.start, ended_at=None)
                item.pop("_pid", None)
                item.pop("_pid_identity", None)
            if args.pid:
                if item["status"] != "running":
                    raise ValueError("실행 중인 실험에만 PID를 연결할 수 있습니다.")
                identity = pid_identity(args.pid)
                if not identity:
                    raise ValueError("지정한 PID가 실행 중이지 않습니다.")
                item.update(_pid=args.pid, _pid_identity=identity)
            if args.completed is not None or args.total is not None:
                if args.completed is None or args.total is None or not 0 <= args.completed <= args.total or args.total <= 0:
                    raise ValueError("--completed와 --total을 함께 입력하세요. 0 ≤ completed ≤ total, total > 0")
                item["progress"] = {"completed": args.completed, "total": args.total}
        atomic_json(state / "jobs.json", jobs)
    print(f"실험 정보 저장: {args.id}")


def make_snapshot(c):
    state = Path(c["state_dir"])
    stamp = now_iso()
    try:
        gpus = collect_gpus()
        ok = True
    except (OSError, subprocess.SubprocessError, ValueError):
        # Keep topology for a useful error display; metrics become explicitly unknown.
        old = state / "snapshot.json"
        gpus = json.loads(old.read_text()).get("gpus", []) if old.exists() else []
        gpus = [{**g, "memory_used_mib": None, "utilization": None, "process_count": None} for g in gpus]
        ok = False
    with locked(state / "jobs.lock"):
        jobs = read_jobs(state)
        changed = False
        for item in jobs:
            if item["status"] == "running" and item.get("_pid"):
                try:
                    identity = pid_identity(item["_pid"])
                except (OSError, IndexError):
                    continue  # Permission/read errors do not mean a process has exited.
                if identity != item["_pid_identity"]:
                    item.update(status="stopped", ended_at=stamp, end_source="observed")
                    changed = True
        if changed:
            atomic_json(state / "jobs.json", jobs)
    cutoff = datetime.now(timezone.utc).timestamp() - c.get("history_days", 30) * 86400
    public_jobs = []
    # Whitelist fields: never publish PIDs, usernames, commands, local paths, tokens, or hostnames.
    fields = ("id", "name", "description", "gpu_uuids", "status", "started_at",
              "expected_end_at", "ended_at", "eta_source", "progress", "end_source")
    for item in jobs:
        if item.get("ended_at") and parse_time(item["ended_at"]).timestamp() < cutoff:
            continue
        public_jobs.append({k: item[k] for k in fields if k in item})
    snapshot = {"schema_version": 1, "server_id": c["server_id"], "name": c["name"],
                "updated_at": stamp, "collector_ok": ok, "gpus": gpus, "jobs": public_jobs}
    if not ok:
        snapshot["collector_error"] = "GPU 상태 수집 실패"
    atomic_json(state / "snapshot.json", snapshot)
    return snapshot


def github_request(method, path, token, payload=None):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "gpu-timeline-agent"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    request = Request("https://api.github.com" + path, headers=headers, method=method, data=data)
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def publish(c, snapshot):
    token = os.environ.get("GPU_TIMELINE_TOKEN", "").strip()
    if not token:
        raise ValueError("GPU_TIMELINE_TOKEN 환경 변수가 필요합니다.")
    repo = c.get("github_repository", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("github_repository는 OWNER/REPO 형식이어야 합니다.")
    branch = c.get("github_branch", "status")
    if not branch or branch in ("main", "master"):
        raise ValueError("상태 전용 브랜치를 사용하세요. 기본값: status")
    path = f"/repos/{repo}/contents/servers/{c['server_id']}.json"
    content = base64.b64encode(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).decode()
    for attempt in range(5):
        try:
            try:
                current = github_request("GET", path + "?" + urlencode({"ref": branch}), token)
                sha = current["sha"]
            except HTTPError as error:
                if error.code != 404:
                    raise
                sha = None
            payload = {"message": f"status: {c['server_id']}", "content": content, "branch": branch}
            if sha:
                payload["sha"] = sha
            github_request("PUT", path, token, payload)
            return
        except HTTPError as error:
            if error.code in (409, 422) and attempt < 4:
                time.sleep(min(16, 2 ** attempt) + random.random() * 2)
                continue
            raise RuntimeError(f"GitHub 업로드 실패 (HTTP {error.code}). 저장소·토큰 권한·status 브랜치를 확인하세요.") from None


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", required=True, help="서버별 설정 JSON 경로")
    sub = p.add_subparsers(dest="action", required=True)
    collect = sub.add_parser("collect", help="GPU 상태를 한 번 수집")
    collect.add_argument("--publish", action="store_true", help="수집 후 GitHub에 업로드")
    add = sub.add_parser("add", help="실험 정보 등록. 실험을 실행하지 않습니다.")
    add.add_argument("--id", required=True)
    add.add_argument("--name", required=True)
    add.add_argument("--gpus", required=True, help="물리 GPU index 또는 UUID. 예: 0,1")
    add.add_argument("--start")
    add.add_argument("--end")
    add.add_argument("--description", default="")
    add.add_argument("--planned", action="store_true")
    add.add_argument("--pid", type=int, help="실험 수명이 일치하는 대표 프로세스 PID")
    update = sub.add_parser("update", help="실험 정보·진행률·예상 종료시간 변경")
    update.add_argument("--id", required=True)
    update.add_argument("--name")
    update.add_argument("--description")
    eta = update.add_mutually_exclusive_group()
    eta.add_argument("--end")
    eta.add_argument("--clear-end", action="store_true")
    update.add_argument("--start", help="실제로 시작한 시각. 예정 실험을 실행 상태로 변경")
    update.add_argument("--pid", type=int)
    update.add_argument("--completed", type=int)
    update.add_argument("--total", type=int)
    finish = sub.add_parser("finish", help="실험을 완료/실패/취소로 기록. 프로세스는 건드리지 않습니다.")
    finish.add_argument("--id", required=True)
    finish.add_argument("--status", choices=["completed", "failed", "cancelled"], default="completed")
    finish.add_argument("--at")
    return p


def main():
    args = parser().parse_args()
    try:
        c = load_config(args.config)
        if args.action == "collect":
            try:
                # Prevent stale snapshots from overlapping timer/manual uploads on this server.
                with locked(Path(c["state_dir"]) / "collect.lock", blocking=False):
                    snapshot = make_snapshot(c)
                    if args.publish:
                        publish(c, snapshot)
                    print(f"{'업로드' if args.publish else '로컬 수집'} 완료: {c['server_id']} · {len(snapshot['gpus'])} GPU · 수집 정상={snapshot['collector_ok']}")
            except BlockingIOError:
                print("이미 수집·업로드가 실행 중입니다. 이번 요청은 건너뜁니다.")
        else:
            metadata_command(c, args)
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        # Never dump a request object or credentials to logs.
        print(f"오류: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
