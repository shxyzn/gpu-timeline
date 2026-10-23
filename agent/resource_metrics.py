"""Read-only, bounded Linux resource telemetry. No process control or directory scans.

Public rows: [Unix seconds, observed seconds, values[], valid seconds[]].
Each column declares its reducer. Missing counters remain null, never zero.
"""
import copy
import json
import math
import os
from pathlib import Path
import re
import tempfile
import threading
import time

GIB = 1024 ** 3
MIB = 1024 ** 2
DAY = 86400
COLUMNS = [
    ("gpu_pct", "mean"), ("gpu_active_pct", "mean"),
    ("cpu_pct", "mean"), ("cpu_peak_pct", "max"), ("core_peak_pct", "max"),
    ("ram_pct", "mean"), ("ram_peak_pct", "max"), ("ram_available_gib", "min"),
    ("swap_mib_s", "max"), ("cpu_psi_pct", "max"),
    ("memory_psi_pct", "max"), ("io_psi_pct", "max"),
    ("io_latency_ms", "max"), ("read_mib_s", "mean"), ("write_mib_s", "mean"),
    ("iops", "mean"), ("vram_pct", "max"), ("allocated_gpus", "mean"),
    ("gpu_count", "mean"), ("local_gpu_jobs", "mean"), ("api_jobs", "mean"),
    ("cpu_iowait_pct", "mean"),
]


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def rounded(value):
    return round(value, 3) if finite(value) else None


def read_text(path):
    try:
        return Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return ""


def parse_cpu(text):
    result = {}
    for line in text.splitlines():
        parts = line.split()
        if parts and re.fullmatch(r"cpu\d*", parts[0]) and len(parts) >= 5:
            try:
                # guest/guest_nice are already included in user/nice.
                values = [int(x) for x in parts[1:9]]
                values += [0] * (8 - len(values))
                result[parts[0]] = values
            except ValueError:
                pass
    return result


def parse_pairs(text, colon=False):
    result = {}
    for line in text.splitlines():
        parts = line.split()
        try:
            result[parts[0].rstrip(":" if colon else " ")] = int(parts[1])
        except (ValueError, IndexError):
            pass
    return result


def parse_psi(text):
    match = re.search(r"(?m)^some\s+.*?\btotal=(\d+)\b", text)
    return int(match.group(1)) if match else None


def parse_disks(text):
    result = {}
    for line in text.splitlines():
        p = line.split()
        if len(p) < 14:
            continue
        try:
            v = [int(x) for x in p[3:14]]
            result[p[0] + ":" + p[1]] = {
                "name": p[2], "reads": v[0], "read_sectors": v[2], "read_ms": v[3],
                "writes": v[4], "write_sectors": v[6], "write_ms": v[7], "busy_ms": v[9],
            }
        except ValueError:
            pass
    return result


def mount_entries(text):
    result, seen = [], set()
    for line in text.splitlines():
        parts = line.split()
        try:
            sep = parts.index("-")
            device, mount, fs = parts[2], parts[4], parts[sep + 1]
            mount = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), mount)
            # Remote/FUSE/pseudo filesystems can hang statvfs; do not query them.
            if fs not in ("ext2", "ext3", "ext4", "xfs", "btrfs", "zfs") or device in seen:
                continue
            if not mount.startswith("/") or any(ord(c) < 32 for c in mount):
                continue
            seen.add(device)
            result.append({"mount": mount[:200], "device_id": device, "filesystem": fs})
        except (IndexError, ValueError):
            pass
    return sorted(result, key=lambda m: (m["mount"] != "/", m["mount"]))[:24]


def collect_raw(proc="/proc", sys_root="/sys"):
    proc = Path(proc)
    raw = {"at": time.time(), "monotonic": time.monotonic(),
           "boot": read_text(proc / "sys/kernel/random/boot_id").strip(),
           "cpu": parse_cpu(read_text(proc / "stat")),
           "memory": parse_pairs(read_text(proc / "meminfo"), True),
           "vm": parse_pairs(read_text(proc / "vmstat")),
           "pressure": {key: parse_psi(read_text(proc / "pressure" / key))
                        for key in ("cpu", "memory", "io")},
           "disks": parse_disks(read_text(proc / "diskstats")), "mounts": []}
    for entry in mount_entries(read_text(proc / "self/mountinfo")):
        entry = dict(entry)
        io_id = entry["device_id"]
        # Partition counters omit some timings on older kernels. Use their disk.
        block = Path(sys_root) / "dev/block" / io_id
        try:
            if (block / "partition").exists():
                parent_id = read_text(block.resolve().parent / "dev").strip()
                if parent_id in raw["disks"]:
                    io_id = parent_id
        except OSError:
            pass
        entry["io_device_id"] = io_id
        entry["io_device"] = raw["disks"].get(io_id, {}).get("name")
        try:
            stat = os.statvfs(entry["mount"])
            total, available = stat.f_blocks * stat.f_frsize, stat.f_bavail * stat.f_frsize
            used = (stat.f_blocks - stat.f_bfree) * stat.f_frsize
            entry.update(total_bytes=total, used_bytes=used, available_bytes=available,
                         used_pct=round(100 * used / (used + available), 2) if used + available else None)
        except OSError:
            entry.update(total_bytes=None, used_bytes=None, available_bytes=None, used_pct=None)
        raw["mounts"].append(entry)
    return raw


def delta(current, previous):
    if finite(current) and finite(previous) and current >= previous:
        return current - previous
    return None


def cpu_usage(current, previous):
    if not current or not previous or len(current) != len(previous):
        return None, None
    changes = [delta(a, b) for a, b in zip(current, previous)]
    if any(v is None for v in changes) or sum(changes) <= 0:
        return None, None
    total = sum(changes)
    return (100 * (total - changes[3] - changes[4]) / total, 100 * changes[4] / total)


def derive(raw, previous, gpus, jobs, sample_seconds=15, page_size=4096):
    dt = raw["monotonic"] - previous["monotonic"] if previous else 0
    wall_dt = raw["at"] - previous["at"] if previous else 0
    valid = bool(previous and raw["boot"] and raw["boot"] == previous["boot"]
                 and 0 < dt <= sample_seconds * 2.5 and abs(dt - wall_dt) < 5)
    prev = previous if valid else {"cpu": {}, "vm": {}, "pressure": {}, "disks": {}}
    duration = dt if valid else 0
    values = {key: None for key, _ in COLUMNS}
    cpu, iowait = cpu_usage(raw["cpu"].get("cpu"), prev["cpu"].get("cpu"))
    cores = [{"index": int(k[3:]), "usage_pct": rounded(cpu_usage(v, prev["cpu"].get(k))[0])}
             for k, v in raw["cpu"].items() if k != "cpu"]
    core_values = [c["usage_pct"] for c in cores if c["usage_pct"] is not None]
    values.update(cpu_pct=cpu, cpu_peak_pct=cpu, cpu_iowait_pct=iowait,
                  core_peak_pct=max(core_values) if core_values else None)
    mem = raw["memory"]
    total, available = mem.get("MemTotal", 0) * 1024, mem.get("MemAvailable")
    available = available * 1024 if available is not None else None
    ram = 100 * (1 - available / total) if total > 0 and available is not None and 0 <= available <= total else None
    values.update(ram_pct=ram, ram_peak_pct=ram,
                  ram_available_gib=available / GIB if available is not None else None)
    swap = [delta(raw["vm"].get(k), prev["vm"].get(k)) for k in ("pswpin", "pswpout")]
    if duration and all(v is not None for v in swap):
        values["swap_mib_s"] = sum(swap) * page_size / MIB / duration
    for key in ("cpu", "memory", "io"):
        change = delta(raw["pressure"][key], prev["pressure"].get(key))
        if duration and change is not None:
            values[key + "_psi_pct"] = min(100, 100 * change / (duration * 1000000))
    local = [j for j in jobs if j.get("resource_type") != "api" and j.get("status") == "running"]
    gpu_list = gpus if isinstance(gpus, list) else []
    gpu_ids = {g["uuid"] for g in gpu_list}
    allocated = {u for j in local for u in j.get("gpu_uuids", []) if u in gpu_ids}
    utils = [g.get("utilization") for g in gpu_list]
    vram = [100 * g["memory_used_mib"] / g["memory_total_mib"] for g in gpu_list
            if finite(g.get("memory_used_mib")) and finite(g.get("memory_total_mib")) and g["memory_total_mib"] > 0]
    if gpu_list and all(finite(u) and 0 <= u <= 100 for u in utils):
        values["gpu_pct"] = sum(utils) / len(utils)
    values.update(gpu_active_pct=values["gpu_pct"] if local else None,
                  vram_pct=max(vram) if vram else None, allocated_gpus=len(allocated) if gpus is not None else None,
                  gpu_count=len(gpu_list) if gpus is not None else None,
                  local_gpu_jobs=len(local), api_jobs=sum(j.get("resource_type") == "api" and j.get("status") == "running" for j in jobs))
    devices = []
    for device_id in sorted({m["io_device_id"] for m in raw["mounts"]}):
        current, old = raw["disks"].get(device_id), prev["disks"].get(device_id)
        device = {"id": device_id, "name": current["name"] if current else None,
                  "read_mib_s": None, "write_mib_s": None, "iops": None, "latency_ms": None}
        if duration and current and old and current["name"] == old["name"]:
            changes = {k: delta(current[k], old[k]) for k in current if k != "name"}
            if all(v is not None for v in changes.values()):
                count = changes["reads"] + changes["writes"]
                device.update(read_mib_s=changes["read_sectors"] * 512 / MIB / duration,
                              write_mib_s=changes["write_sectors"] * 512 / MIB / duration,
                              iops=count / duration,
                              latency_ms=(changes["read_ms"] + changes["write_ms"]) / count if count else None)
        devices.append({k: rounded(v) if isinstance(v, float) else v for k, v in device.items()})
    # Device maxima avoid double-counting stacked volumes and shared disks.
    for name, source in (("io_latency_ms", "latency_ms"), ("read_mib_s", "read_mib_s"),
                         ("write_mib_s", "write_mib_s"), ("iops", "iops")):
        observed = [d[source] for d in devices if finite(d[source])]
        values[name] = max(observed) if observed else None
    return {"at": raw["at"], "duration": duration, "values": {k: rounded(v) for k, v in values.items()},
            "cpu_cores": sorted(cores, key=lambda c: c["index"])[:256], "cpu_count": len(cores),
            "memory_total_bytes": total or None, "mounts": raw["mounts"], "devices": devices,
            "gpu_count": len(gpu_list) if gpus is not None else None,
            "psi_supported": {k: raw["pressure"][k] is not None for k in ("cpu", "memory", "io")}}


def candidates(values):
    def ge(key, n):
        return finite(values.get(key)) and values[key] >= n
    return {
        "memory": ge("ram_pct", 95) and (ge("memory_psi_pct", 5) or ge("swap_mib_s", 1)),
        "cpu": (ge("cpu_pct", 85) or ge("core_peak_pct", 95)) and ge("cpu_psi_pct", 10),
        "io": ge("io_psi_pct", 10) and ge("io_latency_ms", 20),
    }


def merge_row(row, values, seconds):
    row[1] += seconds
    for i, (key, reducer) in enumerate(COLUMNS):
        value = values.get(key)
        if not finite(value):
            continue
        before, weight = row[2][i], row[3][i]
        row[2][i] = value if not weight else (
            (before * weight + value * seconds) / (weight + seconds) if reducer == "mean"
            else max(before, value) if reducer == "max" else min(before, value))
        row[3][i] += seconds


class ResourceSampler:
    def __init__(self, config):
        options = config.get("resources", {})
        self.enabled = options.get("enabled", True)
        self.interval = max(15, min(60, int(options.get("sample_seconds", 15))))
        self.path = Path(config["state_dir"]) / "resource-history.json"
        self.lock = threading.Lock()
        self.previous = None
        self.current = None
        self.started_at = None
        self.fine, self.hourly, self.events = [], [], []
        self.runs = {}
        self.last_save = 0
        self.error = False
        try:
            if self.path.stat().st_size < 4 * 1024 * 1024:
                saved = json.loads(self.path.read_text())
                if saved.get("schema_version") == 1 and saved.get("columns") == [x[0] for x in COLUMNS]:
                    self.fine = self.valid_rows(saved.get("fine", []), 300, DAY)
                    self.hourly = self.valid_rows(saved.get("hourly", []), 3600, 30 * DAY)
                    self.started_at = saved.get("started_at")
                    self.events = [e for e in saved.get("events", []) if self.valid_event(e)][-240:]
        except (OSError, ValueError, TypeError, AttributeError):
            pass

    @staticmethod
    def valid_rows(rows, width, retention):
        now = time.time()
        n = len(COLUMNS)
        result = []
        for r in rows[-(int(retention / width) + 1):]:
            if (isinstance(r, list) and len(r) == 4 and finite(r[0]) and now - retention - width <= r[0] <= now
                    and r[0] % width == 0 and finite(r[1]) and 0 <= r[1] <= width + 1
                    and isinstance(r[2], list) and isinstance(r[3], list) and len(r[2]) == len(r[3]) == n
                    and all(v is None or finite(v) for v in r[2])
                    and all(finite(w) and 0 <= w <= r[1] + 1 for w in r[3])
                    and all(finite(v) if w > 0 else v is None for v, w in zip(r[2], r[3]))):
                result.append(r)
        return sorted({r[0]: r for r in result}.values(), key=lambda r: r[0])

    @staticmethod
    def valid_event(event):
        return (isinstance(event, dict) and event.get("kind") in ("memory", "cpu", "io")
                and finite(event.get("start")) and finite(event.get("end"))
                and time.time() - 7 * DAY <= event["end"] <= time.time() + 60
                and 0 <= event["end"] - event["start"] <= 7 * DAY
                and isinstance(event.get("evidence"), dict))

    def add_history(self, sample):
        for rows, width, retention in ((self.fine, 300, DAY), (self.hourly, 3600, 30 * DAY)):
            start, end = sample["at"] - sample["duration"], sample["at"]
            while start < end - 0.00001:
                bucket = int(start // width) * width
                seconds = min(end, bucket + width) - start
                if not rows or rows[-1][0] < bucket:
                    rows.append([bucket, 0, [None] * len(COLUMNS), [0] * len(COLUMNS)])
                if rows[-1][0] == bucket:
                    # Also protects retained buckets after a backwards wall clock jump.
                    seconds = min(seconds, max(0, width - rows[-1][1]))
                    if seconds:
                        merge_row(rows[-1], sample["values"], seconds)
                start = min(end, bucket + width)
            rows[:] = [r for r in rows if r[0] + width > end - retention][-(int(retention / width) + 1):]

    def add_events(self, sample):
        at, dt = sample["at"], sample["duration"]
        self.events = [e for e in self.events if e["end"] > at - 7 * DAY][-240:]
        if not dt:
            self.runs = {}
            return
        for kind, matched in candidates(sample["values"]).items():
            if not matched:
                self.runs.pop(kind, None)
                continue
            run = self.runs.setdefault(kind, {"kind": kind, "start": at - dt, "end": at,
                                               "evidence": {}, "local_gpu_observed": False})
            run["end"] = at
            # The evidence is one concurrent observed sample, not maxima from unrelated times.
            run["evidence"] = dict(sample["values"])
            run["local_gpu_observed"] = bool(sample["values"].get("local_gpu_jobs", 0) > 0)
            if run["end"] - run["start"] >= 120 and not any(e is run for e in self.events):
                self.events.append(run)

    def observe(self, raw, gpus, jobs):
        sample = derive(raw, self.previous, gpus, jobs, self.interval, os.sysconf("SC_PAGE_SIZE"))
        self.previous = raw
        with self.lock:
            self.started_at = self.started_at if finite(self.started_at) else sample["at"]
            self.current, self.error = sample, False
            self.add_history(sample)
            self.add_events(sample)
            if sample["at"] - self.last_save >= 60:
                self.save()
                self.last_save = sample["at"]
        return sample

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".resource-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump({"schema_version": 1, "columns": [x[0] for x in COLUMNS],
                           "started_at": self.started_at, "fine": self.fine,
                           "hourly": self.hourly, "events": self.events}, out,
                          separators=(",", ":"), allow_nan=False)
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def public(self):
        with self.lock:
            def compact(rows):
                return [[r[0], rounded(r[1]), [rounded(v) for v in r[2]], [rounded(v) for v in r[3]]] for r in rows]
            return copy.deepcopy({"schema_version": 1, "enabled": self.enabled, "sample_seconds": self.interval,
                                  "started_at": self.started_at, "current": self.current, "error": self.error,
                                  "columns": [x[0] for x in COLUMNS], "reducers": [x[1] for x in COLUMNS],
                                  "fine": compact(self.fine), "hourly": compact(self.hourly),
                                  "events": self.events[-240:]})

    def run(self, stopping, collect_gpus, read_jobs):
        if not self.enabled:
            return
        while not stopping.is_set():
            started = time.monotonic()
            try:
                try:
                    gpus = collect_gpus()
                except Exception:
                    gpus = None
                raw = collect_raw()
                self.observe(raw, gpus, read_jobs())
            except Exception:
                # Telemetry failure never interrupts the broker or training jobs.
                with self.lock:
                    self.error = True
                self.previous = None
                print("자원 통계 수집 일부 실패. 다음 주기에 재시도합니다.", flush=True)
            stopping.wait(max(1, self.interval - (time.monotonic() - started)))
