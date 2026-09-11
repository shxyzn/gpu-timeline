#!/usr/bin/env bash
# Run from the administrator's ordinary login (e.g. cvml), once per server.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [ "$(id -u)" -eq 0 ]; then
  echo 'sudo 없이 bash agent/install-shared.sh로 실행하세요. 설치 단계에서 sudo를 요청합니다.' >&2
  exit 1
fi
if [ -n "${GPU_TIMELINE_PYTHON:-}" ]; then
  candidates=("$GPU_TIMELINE_PYTHON")
else
  candidates=("$(command -v python3 || true)" "$HOME/anaconda3/envs/py311/bin/python" "$HOME/miniconda3/envs/py311/bin/python" "$HOME/anaconda3/envs/py310/bin/python")
fi
for candidate in "${candidates[@]}"; do
  if [ -x "$candidate" ] && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
    exec sudo "$candidate" "$script_dir/install_shared.py" --user "$(id -un)" --python "$candidate" "$@"
  fi
done
echo 'Python 3.10 이상을 찾지 못했습니다. Conda 환경을 활성화하거나 GPU_TIMELINE_PYTHON에 실행 파일의 절대경로를 지정하세요.' >&2
exit 1
