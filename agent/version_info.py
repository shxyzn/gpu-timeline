"""Build and installed-code version metadata; Python 3.8+, no network access."""
import argparse
from datetime import datetime, timezone
from functools import lru_cache
import json
from pathlib import Path
import re
import subprocess

VERSION_PATTERN = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"


def source_version(root):
    root = Path(root).resolve()
    version = (root / "VERSION").read_text(encoding="utf-8").strip()
    if not re.fullmatch(VERSION_PATTERN, version):
        raise ValueError("VERSION에는 major.minor.patch 숫자를 입력하세요.")
    revision, dirty = None, None
    # Installation already explicitly trusts this checkout. The ownership
    # exception is scoped to this read-only invocation, never a global config.
    command = ["git", "-c", "safe.directory=" + str(root), "-C", str(root)]
    try:
        result = subprocess.run(command + ["rev-parse", "HEAD"], check=True,
                                capture_output=True, text=True, timeout=5)
        candidate = result.stdout.strip()
        if re.fullmatch(r"[0-9a-f]{40}", candidate):
            revision = candidate
        changes = subprocess.run(command + ["status", "--porcelain", "--untracked-files=normal",
                                            "--", "VERSION", "agent", "dist", ".github/workflows/pages.yml"], check=True,
                                 capture_output=True, text=True, timeout=5)
        dirty = bool(changes.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        pass
    return {"version": version, "revision": revision, "dirty": dirty}


@lru_cache(maxsize=1)
def runtime_version():
    # Pin the version to installed copies, not a checkout later updated by pull.
    path = Path(__file__).with_name("version.json")
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            version = data.get("version", "")
            if not isinstance(version, str) or not re.fullmatch(VERSION_PATTERN, version):
                return None
            revision = data.get("revision")
            if revision is not None and (not isinstance(revision, str) or
                                         not re.fullmatch(r"[0-9a-f]{40}", revision)):
                return None
            return {k: data[k] for k in ("version", "revision", "dirty",
                                         "installed_at") if k in data}
        except (OSError, ValueError, AttributeError, TypeError):
            return None
    try:
        return source_version(Path(__file__).resolve().parent.parent)
    except (OSError, ValueError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    data = source_version(Path(__file__).resolve().parent.parent)
    data["built_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    Path(args.output).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
