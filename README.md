# GPU Timeline

SSH로 사용하는 여러 서버의 GPU 실험과 예상 종료시간을 조회하는 대시보드입니다. 상단은 서버/GPU별 가로 타임라인, 하단은 GPU 사용률·VRAM·마지막 갱신 정보입니다. 첨부한 일정표의 행/시간축/막대 구성을 바탕으로 만들었습니다.

공개 대시보드: **https://shxyzn.github.io/gpu-timeline/**. 현재 설정은 실제 서버 데이터를 읽는 live 모드입니다.

**여러 사람이 각자 계정으로 쓰는 서버는 [공용 설치 안내](SHARED_SETUP.md)를 사용하세요.** 관리자(`cvml` 등)가 서버당 한 번 설치하면 모든 계정에서 `gputl`로 자기 실험을 기록할 수 있습니다. 토큰·수집기·서비스를 사용자마다 설치할 필요가 없습니다. 새 실험은 `gputl run --name "실험명" --owner "표시 이름" --gpus 0 -- python train.py`로 실행하면 시작·완료·실패·취소가 자동 기록됩니다. 기존 공용 설치는 같은 설치 명령으로 업데이트하세요. 아래 개인 설치 절차는 기존 단일 계정 운영을 위한 설명입니다.

**버전·일괄 서버 배포:** [버전 관리 안내](RELEASING.md) · [변경 이력](CHANGELOG.md). 대시보드는 전체 버전과 각 서버의 설치 버전을 표시합니다. 버전은 대시보드·서버 모두 세 자리로 통일하며, 필요한 서버 기능을 원하는 시점에 모아서 적용하세요.

**v1.1.1 사이트 수동 편집:** [관리자 연결·추가·삭제·복구 안내](DASHBOARD_EDITING.md). 별도 백엔드와 서버 업데이트 없이 사용합니다. 관리자 브라우저에서 최초 한 번 GitHub 연결 키를 등록하고 이후 비밀번호로 로그인합니다.

**v1.1.2 실험 수정:** 실험 상세 → 수정에서 시간·이름·설명을 변경할 수 있습니다. 수동 실험은 상태·GPU도 수정합니다. 서버 수집 실험의 수정값은 웹 표시용으로 별도 보관하며 최신 실행 상태와 진행률은 계속 수집합니다.

**v1.1.3 서버 관리:** 관리자 로그인 후 각 서버의 **서버 관리**에서 필요한 조치와 복사할 명령어를 확인합니다. 현재 세 서버의 기존 설치는 **v1.0.0**으로 명명하며, 다음 설치부터 수집기가 보고한 전체 버전을 사용합니다. [서버별 조치 편집 안내](SERVER_MANAGEMENT.md).

## 구성

| 위치 | 역할 |
| --- | --- |
| GitHub Pages (`main` 브랜치의 `dist/`) | 공개 조회·관리자 수동 편집. 60초마다 상태 파일 확인 |
| 같은 공개 저장소의 `status` 브랜치 | `servers/server-a.json` 등 서버별 최신 상태 |
| `status/dashboard/edits.json` | 브라우저가 저장하는 수동 실험·삭제 목록. 서버 스냅샷과 별도로 보존 |
| 각 GPU 서버의 Python 수집 프로그램 | `nvidia-smi` 조회, 실험 메타데이터 결합, 10분마다 상태 업로드 |
| 각 GPU 서버의 로컬 실험 파일 | 실험명, 실제 시작, 예상 종료, 사용 GPU, 선택적 PID |

브라우저에서 SSH에 접속하지 않습니다. 서버가 GitHub에 HTTPS로 올리는 방식이라, 조회를 위해 GPU 서버의 인바운드 포트를 추가로 열 필요가 없습니다. 서버에는 GitHub API로의 아웃바운드 HTTPS 접속이 필요합니다. LLM agent는 필요 없으며, 기존 코딩 agent가 이 프로그램의 등록 명령을 호출하도록 연결할 수도 있습니다.

이 구성의 데이터 저장소는 **공개 저장소**입니다. 상태 JSON과 실험명이 인터넷에 공개됩니다. 기본 수집 필드는 GPU 수치와 직접 입력한 표시 이름·실험 설명이며, IP·SSH 키·환경 변수·프로세스 명령·사용자명은 자동 수집하거나 업로드하지 않습니다. 실험명/설명에 비공개 정보는 입력하지 마세요. 로그인 기반 비공개 운영이 필요하면 별도 인증 API가 필요합니다. 서버용 GitHub 토큰은 웹 코드에 넣지 않습니다.

## 화면에서 할 수 있는 일

- 24시간 / 3일 / 7일 범위로 타임라인 조회, 이전/다음 기간 이동
- 실험 막대 선택 → GPU, 시작, 경과 시간, 예상 종료, 실제 종료, 설명 조회
- 실행/예정/완료/종료 미정·초과 표시, 같은 GPU의 겹치는 실험은 별도 줄에 표시
- GPU 실제 점유 상태와 예약을 분리해서 확인
- 20분 이상 갱신이 없거나 수집/통신이 실패하면 확인 필요 표시
- 관리자 로그인 후 수동 실험 추가, 실험 상세에서 삭제, 기록 관리에서 복구

실험 실행, 중단, GPU 할당, 예약 강제는 하지 않습니다. `예정`은 정보 표시이며 자동 실행을 뜻하지 않습니다. GPU가 낮은 사용률을 보이더라도 메모리나 프로세스가 남아 있으면 점유로 표시합니다. `현재 여유`도 다른 사용자의 다음 작업이나 독점 사용 가능성을 보장하지 않습니다.

## 1. GitHub Pages 게시

1. GitHub에서 빈 **공개** 저장소를 만듭니다. 예: `shxyzn/gpu-timeline`.
2. 압축을 푼 폴더의 `dist/config.json`을 실제 저장소와 서버 목록으로 수정합니다.

```json
{
  "mode": "live",
  "title": "GPU Timeline",
  "refresh_seconds": 60,
  "stale_after_seconds": 1200,
  "data_base_url": "https://raw.githubusercontent.com/shxyzn/gpu-timeline/status/",
  "servers": [
    {"id": "server-a", "name": "Atlas", "file": "servers/server-a.json"},
    {"id": "server-b", "name": "Nova", "file": "servers/server-b.json"}
  ]
}
```

`data_base_url` 끝의 `/`를 유지합니다. `id`는 각 서버의 설정과 정확히 같아야 합니다. 서버 수와 GPU 수는 제한을 하드코딩하지 않았고, GPU는 수신 데이터에서 자동으로 늘어납니다. GPU당 물리 UUID를 식별자로 사용합니다.

3. 이 폴더를 저장소에 올립니다. 아래는 **새로 압축을 푼 폴더**에서, GitHub 인증이 준비된 상태를 가정합니다.

```bash
git init -b main
git add .
git commit -m "Add GPU timeline"
git remote add origin https://github.com/shxyzn/gpu-timeline.git
git push -u origin main
git push origin main:status
```

마지막 명령은 상태 전용 브랜치를 한 번 생성합니다. 이미 `status` 브랜치가 있다면 생략하세요. 기존 데이터가 있는 브랜치에 강제 push 하지 마세요.

4. GitHub 저장소 **Settings → Pages → Build and deployment → Source: GitHub Actions**를 선택합니다.
5. **Actions → Publish GPU Timeline → Run workflow**를 한 번 실행합니다.

게시 주소: `https://shxyzn.github.io/gpu-timeline/`. `shxyzn.github.io` 이름의 저장소를 쓰면 루트 주소에서 사용할 수 있습니다.

웹 코드는 `main` 변경 시 배포됩니다. 수집기는 `status` 브랜치만 수정하므로 데이터 업로드마다 Pages 배포가 발생하지 않습니다. 브라우저는 해당 브랜치의 raw JSON을 조회합니다. 새 서버를 추가할 때는 웹 `config.json` 서버 목록을 수정해 한 번 배포합니다.

## 2. 각 서버 준비

필요 환경: Linux, Python 3.10 이상, NVIDIA 드라이버와 `nvidia-smi`. Python 외부 패키지를 설치하지 않습니다. 일반적인 NVIDIA 물리 GPU 서버를 대상으로 하며 MIG/MPS·컨테이너 내부 프로세스 매핑은 별도 검증이 필요합니다. 호스트에서 실행하세요.

폴더를 서버의 `~/gpu-timeline`에 복사한 뒤:

```bash
mkdir -p ~/.config/gpu-timeline
cp ~/gpu-timeline/agent/config.example.json ~/.config/gpu-timeline/config.json
```

서버별 설정을 편집합니다:

```json
{
  "server_id": "server-a",
  "name": "Atlas",
  "github_repository": "shxyzn/gpu-timeline",
  "github_branch": "status",
  "state_dir": "~/.local/state/gpu-timeline",
  "history_days": 30
}
```

서버마다 **고유한 `server_id`**를 사용합니다. 별도 GPU 목록은 필요 없습니다. `name`은 공개 화면에 보일 별칭입니다. 해당 서버 한 곳에서만 그 서버의 상태 파일을 작성합니다. 동시에 다른 서버가 업로드할 때 GitHub 충돌이 생기면 최신 SHA를 다시 읽고 재시도합니다.

먼저 업로드 없이 실제 GPU 조회를 확인합니다:

```bash
python3 ~/gpu-timeline/agent/gpu_agent.py --config ~/.config/gpu-timeline/config.json collect
```

결과는 `~/.local/state/gpu-timeline/snapshot.json`에 저장됩니다.

## 3. 상태 업로드 인증

GitHub의 **Settings → Developer settings → Personal access tokens → Fine-grained tokens**에서 대상 저장소만 선택하고 **Contents: Read and write** 권한을 부여합니다. 계정/조직 정책에 따라 승인이나 토큰 사용 제한이 있을 수 있습니다.

서버의 `~/.config/gpu-timeline/agent.env`에 아래 환경 변수를 저장합니다. 이 파일은 저장소 밖에 두세요.

```text
GPU_TIMELINE_TOKEN=여기에_실제_토큰
```

```bash
chmod 600 ~/.config/gpu-timeline/agent.env
```

한 번 수동 업로드하려면 터미널에서 토큰을 숨겨서 입력할 수 있습니다:

```bash
read -rs -p "GitHub token: " GPU_TIMELINE_TOKEN
export GPU_TIMELINE_TOKEN
python3 ~/gpu-timeline/agent/gpu_agent.py --config ~/.config/gpu-timeline/config.json collect --publish
unset GPU_TIMELINE_TOKEN
```

이 예제는 Bash 기준입니다. 설정 파일에는 토큰을 넣지 않습니다. 토큰 만료 시 새 토큰으로 교체합니다.

## 4. 10분마다 자동 업로드

사용자 systemd가 제공되는 서버에서:

```bash
mkdir -p ~/.config/systemd/user
cp ~/gpu-timeline/agent/gpu-timeline.service ~/.config/systemd/user/
cp ~/gpu-timeline/agent/gpu-timeline.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gpu-timeline.timer
systemctl --user start gpu-timeline.service
```

로그 확인:

```bash
journalctl --user -u gpu-timeline.service -n 30
```

SSH 로그아웃 뒤에도 사용자 서비스를 계속 실행하려면 서버의 linger 정책을 확인해야 합니다. 허용되는 환경에서는 `loginctl enable-linger "$USER"`를 사용하며, 권한이 없으면 서버 관리자에게 사용자 서비스 유지 설정을 요청합니다. linger 설정이나 시스템 서비스 권한은 자동으로 변경하지 않습니다.

기본 업로드 주기는 10분, 화면 조회 주기는 60초, 갱신 지연 판정은 20분입니다. 새 수치는 **서버 업로드 주기 + raw 파일 캐시/전송 지연**만큼 늦게 보일 수 있습니다. 60초 조회가 60초 단위 실측을 의미하지 않습니다. GitHub의 저장소/API를 초 단위 모니터링이나 장기 시계열 저장 용도로 사용하는 구성은 아닙니다. 서버 수/빈도가 커지면 전용 저장소/API로 전환할 수 있습니다.

## 5. 실험 정보 등록

아래 시각은 예시입니다. 실제 날짜와 시간으로 바꾸세요. `+09:00`은 한국 시간입니다.

```bash
python3 ~/gpu-timeline/agent/gpu_agent.py \
  --config ~/.config/gpu-timeline/config.json add \
  --id gepa-qwen8b-seed42 \
  --name "GEPA · Qwen3-8B" \
  --gpus 0,1 \
  --end "2026-09-12T09:00:00+09:00" \
  --description "AIME25 / seed 42 / reflection batch 3"
```

- `--gpus`에는 `nvidia-smi`의 **물리 GPU 번호 또는 UUID**를 넣습니다. `CUDA_VISIBLE_DEVICES`로 재매핑된 프로세스 내부 GPU 번호가 아닙니다.
- 시작시간은 생략하면 등록 시각입니다. 이미 실행 중인 작업은 `--start "...+09:00"`로 실제 시작을 기록합니다.
- `--end`를 생략하면 종료 미정으로 표시합니다. GPU 사용률만으로 종료시간을 자동 예측하지 않습니다.
- 미래 계획은 `--planned --start "...+09:00" --end "...+09:00"`를 붙여 등록합니다. 예정 시각이 되어도 실제 실행 상태로 자동 변경하지 않습니다.
- 실험과 수명이 일치하는 PID를 알고 있으면 `--pid 12345`를 붙입니다. 재사용된 PID를 오인하지 않도록 프로세스 시작값과 서버 부팅 ID를 함께 확인합니다. 프로세스가 없어지면 `프로세스 종료 · 결과 미확인`으로 바꾸고 관측 시각을 기록합니다. 성공/실패를 추측하지 않습니다.
- PID를 연결하지 않은 실험은 자동으로 종료를 판정하지 않으므로 완료 시 아래 `finish` 명령이 필요합니다. GPU를 계속 점유하는 공용 vLLM 서버 PID는 개별 실험 수명과 다를 수 있습니다.

예상 종료시간/진행 상황 수정:

```bash
python3 ~/gpu-timeline/agent/gpu_agent.py \
  --config ~/.config/gpu-timeline/config.json update \
  --id gepa-qwen8b-seed42 \
  --end "2026-09-12T11:00:00+09:00" \
  --completed 168 --total 280
```

종료 예정을 지우려면 `update --id ... --clear-end`. 예정 실험이 실제로 시작하면 `update --id ... --start "실제시각+09:00"`로 변경합니다. 필요 시 `--pid`를 같이 붙입니다. 진행률은 받은 값을 표시하며 선형 ETA를 강제로 계산하지 않습니다.

완료 기록:

```bash
python3 ~/gpu-timeline/agent/gpu_agent.py \
  --config ~/.config/gpu-timeline/config.json finish \
  --id gepa-qwen8b-seed42 --status completed
```

실패는 `--status failed`, 취소는 `--status cancelled`입니다. 이 명령들은 메타데이터만 변경하며 프로세스를 실행하거나 중단하지 않습니다. 다음 수집 때 업로드됩니다. 즉시 반영하려면 인증 환경에서 `collect --publish`를 실행하거나 등록한 systemd 서비스를 한 번 시작합니다.

다른 코딩 agent에게는 아래처럼 요청하면 됩니다:

> 실험은 기존 방식으로 실행하고, 시작 후 GPU Timeline의 add 명령으로 이름·사용 GPU·예상 종료를 등록해. 실행 중 계획이 바뀌면 update, 종료 결과를 확인하면 finish로 기록해. 웹사이트는 수정하지 말고 해당 서버의 수집 프로그램을 사용해.

## 데이터·표시 규칙

- `updated_at`은 **서버에서 수집한 시간**입니다. 페이지를 새로고침했다고 최신 수신으로 바뀌지 않습니다.
- 수신 실패/오래된 데이터/수집 오류는 GPU 여유로 판정하지 않습니다.
- 사용률이 0%여도 프로세스, 512 MiB 초과 VRAM, 실행 중 등록 작업이 있으면 점유로 봅니다. 이는 가벼운 표시용 휴리스틱입니다.
- 종료 예정이 지나도 자동 완료하지 않습니다. 실행 중 표시를 유지하고 종료 확인 대상으로 표시합니다.
- 종료 미정·예정 초과 막대는 현재 시점까지 그립니다. 미래 길이를 임의로 만들지 않습니다.
- GPU 프로세스가 있지만 실험 메타데이터가 없으면 점유 사실만 표시합니다. 실험명과 시작시간은 추측하지 않습니다.
- 서버 내부 실험 기록은 보존하고, 상태 JSON에는 최근 30일에 끝난 실험과 현재/예정 실험을 포함합니다. GitHub에는 커밋 이력이 별도로 쌓입니다.

## 로컬 확인 및 검증

웹 화면을 로컬에서 열기:

```bash
python3 -m http.server 8080 --directory dist
```

`http://localhost:8080`에서 확인합니다. HTML 파일 더블클릭(`file://`)은 JSON fetch 제약 때문에 사용하지 않습니다.

```bash
node --test tests/model.test.js
python3 -m unittest discover -s tests -p 'test_*.py'
```

핵심 검증 범위: 갱신 지연/수집 오류 시 여유 오판 방지, 알 수 없는 ETA, 겹치는 일정 배치, PID 재사용, 공개 필드 제한, 업로드 충돌 시 재시도. 실제 GPU 서버·GitHub 계정 연결은 사용자의 환경에서 확인해야 합니다.

## 참고 문서

- [GitHub Pages 소개](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [GitHub Pages 사용자 지정 워크플로](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents)
- [NVIDIA nvidia-smi 문서](https://docs.nvidia.com/deploy/nvidia-smi/index.html)

## 파일 구성

| 파일/폴더 | 용도 |
| --- | --- |
| `dist/` | 그대로 배포할 정적 웹 파일. `config.json`에서 demo/live 전환 |
| `agent/gpu_agent.py` | 상태 조회·등록·업로드 명령 |
| `agent/config.example.json` | 서버 설정 예시 |
| `SHARED_SETUP.md` | 연구실 공용 설치·기존 기록 전환·사용자 안내 |
| `agent/install-shared.sh`, `install_shared.py` | 서버당 한 번 실행하는 관리자 설치 프로그램 |
| `agent/shared_daemon.py`, `shared_cli.py` | 사용자별 실험 권한을 확인하는 공용 수집기와 클라이언트 |
| `agent/gpu-timeline.service`, `.timer` | 사용자 systemd 자동 업로드 예시 |
| `.github/workflows/pages.yml` | GitHub Pages 배포 |
| `tests/` | 핵심 동작 검증 |

`.openai/hosting.json`은 ChatGPT 내 미리보기용 식별 파일이며 GitHub 배포본에는 필요하지 않습니다. GitHub 이전용 압축에서는 제외합니다.
