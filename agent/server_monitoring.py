"""Opt-in, read-only monitoring for the v2.1 dashboards. Python 3.8+."""
import base64
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlencode

import gpu_agent as agent

KST = timezone(timedelta(hours=9))
CHECK_IDS = {"gpu_response", "gpu_count", "gpu_temperature", "driver_loaded", "xid_errors",
             "cpu_load", "cpu_pressure", "memory_available", "uptime", "collector_upload",
             "disk_space", "io_pressure"}
TIME = re.compile(r"(?:[01]\d|2[0-3]):[0-5]\d\Z")


def parse_at(value):
    if not isinstance(value, str):
        raise ValueError("invalid timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp timezone required")
    return parsed.astimezone(timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def validate_config(c):
    if not isinstance(c, dict) or not isinstance(c.get("server_id"), str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", c.get("server_id", "")):
        raise ValueError("invalid server")
    if not integer(c.get("revision"), 1, 2**53-1) or type(c.get("enabled")) is not bool:
        raise ValueError("invalid revision or state")
    parse_at(c.get("updated_at"))
    for key, low, high in [("expected_gpu_count", 1, 32), ("timeout_seconds", 5, 60),
                           ("temperature_warn_c", 50, 110)]:
        if not integer(c.get(key), low, high):
            raise ValueError("invalid threshold")
    schedules = c.get("schedules")
    if not isinstance(schedules, list) or len(schedules) > 12:
        raise ValueError("invalid schedules")
    ids = set()
    for s in schedules:
        if not isinstance(s, dict) or not isinstance(s.get("id"), str) or not re.fullmatch(r"mon-[a-f0-9-]{36}", s.get("id", "")) or s["id"] in ids:
            raise ValueError("invalid schedule id")
        ids.add(s["id"])
        if not isinstance(s.get("name"), str) or not s["name"].strip() or len(s["name"]) > 60:
            raise ValueError("invalid name")
        if s.get("kind") not in ("interval", "daily") or type(s.get("enabled")) is not bool:
            raise ValueError("invalid kind")
        if not integer(s.get("interval_minutes"), 5, 1440) or type(s.get("all_day")) is not bool:
            raise ValueError("invalid interval")
        if any(not isinstance(s.get(k), str) or not TIME.fullmatch(s[k]) for k in ("start_time", "end_time")):
            raise ValueError("invalid window")
        if not s["all_day"] and s["start_time"] == s["end_time"]:
            raise ValueError("empty window")
        days, checks, times = s.get("days"), s.get("checks"), s.get("times")
        if not isinstance(days, list) or not 1 <= len(days) <= 7 or any(not integer(d, 0, 6) for d in days) or len(set(days)) != len(days):
            raise ValueError("invalid days")
        if not isinstance(checks, list) or not 1 <= len(checks) <= len(CHECK_IDS) or any(not isinstance(i, str) or i not in CHECK_IDS for i in checks) or len(set(checks)) != len(checks):
            raise ValueError("invalid checks")
        if not isinstance(times, list) or any(not isinstance(t, str) or not TIME.fullmatch(t) for t in times) or len(set(times)) != len(times):
            raise ValueError("invalid times")
        if (s["kind"] == "daily" and len(times) not in (1, 2)) or (s["kind"] == "interval" and times):
            raise ValueError("invalid frequency")
    if c["enabled"] and not any(s["enabled"] for s in schedules):
        raise ValueError("no enabled schedules")
    return deepcopy(c)


def minutes(text):
    return int(text[:2])*60 + int(text[3:])


def in_window(s, now):
    now = now.astimezone(KST)
    if s["kind"] == "daily" or s["all_day"]:
        return now.weekday() in s["days"]
    m, a, b = now.hour*60 + now.minute, minutes(s["start_time"]), minutes(s["end_time"])
    if a < b:
        return now.weekday() in s["days"] and a <= m < b
    return (m >= a and now.weekday() in s["days"]) or (m < b and (now.weekday()-1) % 7 in s["days"])


def next_run(s, now, last=None):
    if not s["enabled"]:
        return None
    if s["kind"] == "interval" and in_window(s, now):
        due = max(now, parse_at(last) + timedelta(minutes=s["interval_minutes"])) if last else now
        if in_window(s, due):
            return due
    local = now.astimezone(KST)
    for offset in range(9):
        day = (local + timedelta(days=offset)).replace(hour=0, minute=0, second=0, microsecond=0)
        if day.weekday() not in s["days"]:
            continue
        slots = sorted(s["times"]) if s["kind"] == "daily" else ["00:00" if s["all_day"] else s["start_time"]]
        for slot in slots:
            at = day + timedelta(minutes=minutes(slot))
            if at > now:
                return at
    return None


def daily_slot(s, now):
    local = now.astimezone(KST)
    if local.weekday() not in s["days"]:
        return None
    for slot in sorted(s["times"], reverse=True):
        due = local.replace(hour=int(slot[:2]), minute=int(slot[3:]), second=0, microsecond=0)
        if 0 <= (local-due).total_seconds() < 900:
            return s["id"] + ":" + due.isoformat()
    return None


class HealthMonitor:
    def __init__(self, config, upload_status=lambda: {}, runner=subprocess.run, api=agent.github_request, clock=None):
        self.config, self.upload_status, self.runner, self.api = config, upload_status, runner, api
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.profile = config.get("monitoring_profile", "test")
        if self.profile not in ("production", "test"):
            raise ValueError("invalid monitoring profile")
        filename = "monitoring.json" if self.profile == "production" else "monitoring-test.json"
        self.config_file = filename
        self.path = Path(config["state_dir"]) / filename.replace(".json", "-state.json")
        self.lock = threading.RLock()
        self.settings = None
        self.error = None
        self.applied_at = None
        self.history, self.last, self.seen = [], {}, []
        try:
            saved = agent.json.loads(self.path.read_text())
            if not isinstance(saved, dict) or not isinstance(saved.get("history", []), list) or not isinstance(saved.get("last", {}), dict) or not isinstance(saved.get("seen", []), list):
                raise ValueError("invalid cached state")
            self.settings = validate_config(saved["settings"]) if saved.get("settings") else None
            self.history = [r for r in saved.get("history", []) if isinstance(r, dict) and isinstance(r.get("checks"), list)][-20:]
            self.last = {k: v for k, v in saved.get("last", {}).items() if isinstance(k, str) and parse_at(v)}
            self.seen = [v for v in saved.get("seen", []) if isinstance(v, str)][-256:]
            self.applied_at = saved.get("applied_at")
        except (OSError, ValueError, KeyError, TypeError):
            self.settings = None
            self.history, self.last, self.seen = [], {}, []

    def persist(self):
        agent.atomic_json(self.path, {"settings": self.settings, "applied_at": self.applied_at,
                                     "history": self.history[-20:], "last": self.last, "seen": self.seen[-256:]})

    def sync(self):
        with self.lock:
            previous_error = self.error
        try:
            repo = self.config.get("github_repository", "")
            if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
                raise ValueError("repository required")
            token = os.environ.get("GPU_TIMELINE_TOKEN", "").strip()
            if not token:
                raise ValueError("token required")
            url = "/repos/" + repo + "/contents/dashboard/" + self.config_file + "?" + urlencode({"ref": "status"})
            try:
                file = self.api("GET", url, token)
            except HTTPError as error:
                if error.code != 404:
                    raise
                with self.lock:
                    changed = self.settings is not None or self.error is not None
                    self.settings, self.error = None, None
                    self.persist()
                return changed
            if file.get("encoding") != "base64" or file.get("size", 0) > 180000 or len(file.get("content", "")) > 250000:
                raise ValueError("invalid settings file")
            document = agent.json.loads(base64.b64decode(file["content"]))
            if document.get("schema_version") != 1 or not isinstance(document.get("servers"), list) or len(document["servers"]) > 30:
                raise ValueError("invalid document")
            matches = [c for c in document["servers"] if isinstance(c, dict) and c.get("server_id") == self.config["server_id"]]
            if len(matches) > 1:
                raise ValueError("duplicate server")
            settings = validate_config(matches[0]) if matches else None
            with self.lock:
                if settings and self.settings and settings["revision"] < self.settings["revision"]:
                    raise ValueError("stale revision")
                changed = settings != self.settings
                self.settings, self.error = settings, None
                if changed:
                    self.applied_at = iso(self.clock())
                    active = {s["id"] for s in settings["schedules"]} if settings else set()
                    self.last = {k: v for k, v in self.last.items() if k in active}
                    self.persist()
            return changed or previous_error is not None
        except Exception:
            # Never publish credentials, local paths, raw API errors or kernel log lines.
            with self.lock:
                self.error = "최신 설정 확인 실패 · 마지막 적용 설정 유지"
                return self.error != previous_error

    def command(self, args, timeout):
        key = tuple(args)
        if key in self.command_cache:
            return self.command_cache[key]
        remaining = self.deadline-time.monotonic()
        if remaining <= 0:
            raise TimeoutError("monitor deadline")
        result = self.runner(args, capture_output=True, text=True, timeout=max(1, min(timeout, remaining)), check=False)
        self.command_cache[key] = result
        return result

    def check(self, check_id, settings):
        result = {"id": check_id, "status": "ok", "summary": ""}
        try:
            if check_id in ("gpu_response", "gpu_count", "gpu_temperature"):
                field = "temperature.gpu" if check_id == "gpu_temperature" else "uuid"
                probe = self.command(["nvidia-smi", "--query-gpu="+field, "--format=csv,noheader,nounits"], settings["timeout_seconds"])
                if probe.returncode:
                    result.update(status="error", summary="GPU 조회 실패 · 종료 코드 " + str(probe.returncode))
                else:
                    rows = [line.strip() for line in probe.stdout.splitlines() if line.strip()]
                    if check_id == "gpu_response":
                        result.update(status="ok" if rows else "error", summary="GPU 응답 확인" if rows else "응답한 GPU가 없습니다.")
                    elif check_id == "gpu_count":
                        result.update(status="ok" if len(rows) == settings["expected_gpu_count"] else "warning",
                                      summary="인식 {0} / 설정 {1} GPU".format(len(rows), settings["expected_gpu_count"]))
                    else:
                        values = [float(v) for v in rows if re.fullmatch(r"\d+(?:\.\d+)?", v)]
                        if len(values) != len(rows) or not values:
                            result.update(status="unsupported", summary="일부 GPU의 온도를 읽을 수 없습니다.")
                        else:
                            highest = max(values)
                            result.update(status="warning" if highest >= settings["temperature_warn_c"] else "ok",
                                          summary="최고 {0:g}°C · 경고 기준 {1}°C".format(highest, settings["temperature_warn_c"]))
            elif check_id == "driver_loaded":
                loaded = Path("/proc/driver/nvidia/version").is_file()
                result.update(status="ok" if loaded else "warning", summary="NVIDIA 커널 드라이버 로드 확인" if loaded else "NVIDIA 커널 드라이버를 확인하지 못했습니다.")
            elif check_id == "xid_errors":
                probe = self.command(["journalctl", "-k", "--since", "24 hours ago", "--no-pager", "-o", "cat", "-n", "2000"], settings["timeout_seconds"])
                if probe.returncode or re.search(r"permission|not seeing|access denied|no journal files", probe.stderr, re.I):
                    result.update(status="unsupported", summary="커널 로그 조회 권한 또는 journal 지원을 확인해 주세요.")
                else:
                    codes = re.findall(r"\bXid(?:\s*\([^)]*\))?\s*:\s*(\d+)", probe.stdout)
                    result.update(status="warning" if codes else "ok", summary="최근 24시간 조회 범위: Xid {0}건{1}".format(len(codes), " · 코드 "+", ".join(sorted(set(codes))) if codes else ""))
            elif check_id == "cpu_load":
                load, count = os.getloadavg()[0], os.cpu_count() or 1
                result.update(status="warning" if load > count else "ok", summary="1분 부하 {0:.2f} / 논리 CPU {1}개".format(load, count))
            elif check_id in ("cpu_pressure", "io_pressure"):
                resource = "cpu" if check_id == "cpu_pressure" else "io"
                content = Path("/proc/pressure/"+resource).read_text()
                match = re.search(r"^some .*?avg60=([\d.]+)", content, re.M)
                if not match:
                    raise ValueError("unsupported pressure")
                value = float(match[1])
                result.update(status="warning" if value >= 10 else "ok", summary="최근 1분 대기율 {0:.2f}% · 확인 기준 10%".format(value))
            elif check_id == "memory_available":
                values = dict(re.findall(r"^(MemTotal|MemAvailable):\s+(\d+)", Path("/proc/meminfo").read_text(), re.M))
                available = int(values["MemAvailable"])/int(values["MemTotal"])*100
                result.update(status="warning" if available <= 5 else "ok", summary="사용 가능한 메모리 {0:.1f}% · 확인 기준 5% 이하".format(available))
            elif check_id == "disk_space":
                usage = shutil.disk_usage("/")
                percent = usage.free/usage.total*100
                result.update(status="warning" if percent <= 5 else "ok", summary="시스템 디스크 여유 {0:.1f}% ({1:.1f} GiB)".format(percent, usage.free/1024**3))
            elif check_id == "uptime":
                hours = float(Path("/proc/uptime").read_text().split()[0])/3600
                result["summary"] = "부팅 후 {0:.1f}시간".format(hours)
            elif check_id == "collector_upload":
                last = self.upload_status().get("last_upload_at")
                if not last:
                    result.update(status="unsupported", summary="업로드 성공 기록 수신 대기")
                else:
                    age = max(0, (self.clock()-parse_at(last)).total_seconds())
                    limit = max(120, int(self.config.get("publish_seconds", 600))*2)
                    result.update(status="warning" if age > limit else "ok", summary="마지막 업로드 성공 {0:.0f}분 전".format(age/60))
            else:
                raise ValueError("unsupported check")
        except (subprocess.TimeoutExpired, TimeoutError):
            result.update(status="error", summary="점검 응답 제한 시간을 초과했습니다.")
        except (FileNotFoundError, PermissionError, KeyError, ValueError, OSError, ZeroDivisionError):
            result.update(status="unsupported", summary="이 서버에서 해당 항목을 조회할 수 없습니다. 지원·권한을 확인해 주세요.")
        return result

    def tick(self):
        now = self.clock()
        with self.lock:
            settings = deepcopy(self.settings)
        if not settings or not settings["enabled"]:
            return False
        changed = False
        for schedule in settings["schedules"]:
            if not schedule["enabled"] or not in_window(schedule, now):
                continue
            with self.lock:
                previous = self.last.get(schedule["id"])
                slot = daily_slot(schedule, now) if schedule["kind"] == "daily" else None
                if schedule["kind"] == "daily":
                    if not slot or slot in self.seen:
                        continue
                elif previous and now < parse_at(previous)+timedelta(minutes=schedule["interval_minutes"]):
                    continue
                # Claim a slot before execution so a process restart cannot repeat it.
                self.last[schedule["id"]] = iso(now)
                if slot:
                    self.seen.append(slot)
                    self.seen = self.seen[-256:]
                self.persist()
            self.command_cache, self.deadline = {}, time.monotonic()+90
            checks = [self.check(key, settings) for key in schedule["checks"]]
            rank = {"ok": 0, "unsupported": 1, "warning": 2, "error": 3}
            outcome = max((item["status"] for item in checks), key=lambda key: rank[key])
            run = {"schedule_id": schedule["id"], "name": schedule["name"], "started_at": iso(now),
                   "finished_at": iso(self.clock()), "status": outcome, "checks": checks}
            with self.lock:
                self.history = (self.history+[run])[-20:]
                self.persist()
            changed = True
        return changed

    def public(self):
        now = self.clock()
        with self.lock:
            settings = deepcopy(self.settings)
            schedules = []
            for s in settings["schedules"] if settings else []:
                due = next_run(s, now, self.last.get(s["id"])) if settings["enabled"] else None
                schedules.append({"id": s["id"], "last_run_at": self.last.get(s["id"]), "next_run_at": iso(due) if due else None})
            return {"schema_version": 1, "profile": self.profile, "capabilities": ["server-monitoring-v1"],
                    "enabled": bool(settings and settings["enabled"]), "applied_revision": settings["revision"] if settings else 0,
                    "applied_at": self.applied_at, "config_error": self.error, "schedules": schedules,
                    "last_run": deepcopy(self.history[-1]) if self.history else None, "history": deepcopy(self.history[-20:])}

    def run(self, stopping, pending):
        next_sync = 0
        while not stopping.is_set():
            try:
                changed = False
                if time.monotonic() >= next_sync:
                    changed = self.sync()
                    next_sync = time.monotonic()+60
                changed = self.tick() or changed
                if changed:
                    pending.set()
            except Exception:
                # A monitoring failure must not stop telemetry or experiment recording.
                with self.lock:
                    self.error = "모니터링 상태 확인 실패 · 관리자 점검 필요"
            stopping.wait(10)
