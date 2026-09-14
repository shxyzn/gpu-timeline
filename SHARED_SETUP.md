# 여러 계정이 함께 사용하는 서버

**서버당 관리자가 한 번 설치합니다.** `cvml`이 설치했다면 수집·업로드 서비스는 `cvml` 권한으로 계속 실행합니다. `psh` 등 다른 계정은 실험을 기록할 때만 공용 `gputl` 명령을 사용합니다. 개인별 수집기, Conda 환경, 설정 파일, GitHub 토큰, 사용자 서비스는 필요 없습니다.

실험 코드는 `/ssd`, `/data`, 홈 폴더 등 어디에 있어도 됩니다. `gputl run` 뒤에 원래 실험 명령을 넣으면 현재 계정·작업 폴더·Conda 환경을 그대로 사용하면서 시작과 종료를 기록합니다.

## 관리자: 기존 설치에서 전환

기존 수집기를 설치한 **관리자 로그인 계정(예: cvml)** 으로 접속합니다. `server_id`, `name`, GitHub 저장소가 설정된 `~/.config/gpu-timeline/config.json`과 토큰 파일 `~/.config/gpu-timeline/agent.env`가 있어야 합니다.

```bash
cd ~/gpu-timeline
git pull --ff-only
bash agent/install-shared.sh
```

설치 과정에서 sudo 비밀번호를 요청할 수 있습니다. 시스템 Python 3.10 이상을 쓰거나 활성화된 Conda 환경을 사용합니다. 시스템 Python이 3.8이면 `~/anaconda3/envs/py311/bin/python` 등 기존 환경도 자동으로 확인합니다. Python을 명시하려면:

```bash
GPU_TIMELINE_PYTHON=/home/cvml/anaconda3/envs/py311/bin/python bash agent/install-shared.sh
```

**같은 명령을 각 서버에서 한 번씩 실행**합니다. 각 서버의 ID는 서로 달라야 합니다. 두 번째 서버의 기존 설정 ID가 아직 틀렸다면 설치 시 지정할 수 있습니다:

```bash
bash agent/install-shared.sh --server-id server-b
```

세 번째 서버에서는 `--server-id server-c`를 사용합니다. 이 옵션은 공용 설정에 적용됩니다. 설치 후 서버 이름·ID 등은 `/etc/gpu-timeline/config.json`에서 관리합니다.

설치 프로그램은 다음을 수행합니다:

1. 기존 설정·Python·토큰 파일을 확인합니다.
2. 해당 관리자 계정의 이전 `gpu-timeline.timer`와 수집 서비스를 중지하고 타이머 자동 시작을 해제합니다.
3. 기존 실험 기록과 마지막 스냅샷을 공용 수집기 저장소로 **복사**합니다. 이전 파일은 남겨 둡니다. 재설치 시 기존 공용 기록을 덮어쓰지 않습니다.
4. 공용 코드와 `gputl` 명령을 설치하고 시스템 서비스 `gpu-timeline-shared.service`를 활성화합니다. 로그인 유지나 계정별 linger 설정은 필요 없습니다.

기존 실험의 시작시간, 종료 결과, PID 연결, 공개 ID는 유지합니다. 이전 기록의 수정 권한은 설치한 관리자 계정에 귀속됩니다. 기존 실험 프로세스나 GPU 설정은 변경하지 않습니다.

다른 계정에도 이전 수집기를 별도로 설치했다면 **그 계정의 이전 타이머도 중지**하세요. 같은 서버 ID로 업로드하는 수집기는 하나만 운영합니다. 프로젝트 폴더를 이동할 필요는 없습니다.

설치가 끝나면:

```bash
/usr/local/bin/gputl status
sudo journalctl -u gpu-timeline-shared.service -n 20 --no-pager
```

`status`의 `last_upload_at`에 시간이 표시되고 `error`가 `null`이면 업로드가 성공한 것입니다. 서비스가 시작되어 있어도 첫 업로드는 진행 중일 수 있습니다. `collector_ok`가 `false`이면 업로드는 됐지만 GPU 조회에 문제가 있습니다.

기존에 `alias gputl=...`을 사용했다면 현재 터미널에서 `unalias gputl`을 실행하고, 셸 설정에 저장한 예전 alias도 제거하세요. `/usr/local/bin/gputl`은 alias의 영향을 받지 않습니다.

## 사용자: 자기 계정에서 기록

관리자의 설치 이후에는 새로 계정을 만든 사용자도 바로 사용할 수 있습니다. 등록 명령에는 **sudo를 붙이지 않습니다.** 본인 계정에서 실행해야 본인 소유 기록이 됩니다.

새 실험은 사용할 Conda 환경과 작업 폴더에서 다음처럼 실행합니다. `python train.py`를 **원래 실행할 명령 전체**로 바꾸세요.

```bash
/usr/local/bin/gputl run --name "GEPA" --owner "상현" --gpus 0 \
  -- python train.py
```

실험 ID는 자동 생성됩니다. 직접 지정하려면 `--id gepa-01`을 `--` 앞에 추가합니다. 같은 계정에서 이미 사용한 ID는 다시 쓸 수 없습니다. 예상 종료를 알 때는 `--end "$(date -d '+6 hours' --iso-8601=seconds)"`를 `--` 앞에 추가할 수 있습니다.

- 시작 등록이 확인된 뒤에만 명령을 실행합니다. 수집기에 연결할 수 없거나 입력이 잘못되면 실험을 시작하지 않습니다.
- 명령이 종료 코드 0을 반환하면 **완료**, 0 이외의 코드이면 **실패**, `gputl run`에 Ctrl+C·SIGTERM·SIGHUP이 전달되면 자식 명령 그룹에도 신호를 전달하고 실제 종료 후 **취소**로 기록합니다. 터미널에는 실험의 종료 코드(신호 종료는 128 + 신호 번호)를 반환합니다.
- 수집기는 실험을 실행하지 않습니다. 실행 명령·환경 변수·작업 경로는 업로드하지 않으며, 사이트에는 직접 입력한 정보와 시작·종료시각, 결과, 종료 코드만 전달합니다.
- `--gpus`는 **기록용**입니다. `CUDA_VISIBLE_DEVICES` 등 원래 GPU 선택 설정은 그대로 유지하므로 물리 GPU 번호와 맞추세요.
- `python`, `torchrun`처럼 작업 완료까지 기다리는 명령을 감쌉니다. 스크립트가 내부에서 작업을 백그라운드로 띄우고 바로 끝나면 그 이후까지 추적하지 못합니다. 셸 파이프라인이 필요하면 `-- bash -o pipefail -c '원래 파이프라인'`처럼 명시합니다.
- 장시간 작업은 **tmux 안에서 실행**하세요. `gputl run` 자체를 SIGKILL로 종료하거나 서버가 재부팅되어 종료 결과가 없으면 수집 시 추적 끊김을 확인해 **확인 필요**로 표시합니다. GPU 작업이 종료됐다는 뜻은 아닙니다. `/proc` 접근이 제한되면 추적 끊김 감지도 제한됩니다.
- 종료 결과 전송에 실패하면 이 계정의 `~/.local/state/gpu-timeline/runs/`에 재전송 기록을 자동 보관합니다. `XDG_STATE_HOME`이 설정돼 있으면 그 위치를 사용합니다. 사용자별 설정·토큰은 필요 없습니다. 수집기 복구 후 `gputl replay`를 실행하면 **원래 종료시각**으로 결과만 재전송합니다. 실험을 다시 실행하지 않습니다.
- `replay`가 종료 결과가 없다고 안내하면 실제 실험 상태를 확인한 뒤 `finish`로 직접 기록합니다. 완료로 추정하지 않습니다.

이미 실행 중인 실험은 재실행하지 않고 기존 등록 명령을 사용합니다:

```bash
# 이미 실행 중인 실험 등록: 필요하면 --start에 실제 시작시각 입력
gputl add --id exp01 --name "GEPA" --owner "상현" --gpus 0

# 내 실험 ID와 상태 확인
gputl list

# 종료 예정 수정 (exp01을 해당 실험 ID로 변경)
gputl update --id exp01 --end "$(date -d '+2 hours' --iso-8601=seconds)"

# 수동 등록한 실험의 실제 결과 확인 후 completed/failed/cancelled 중 선택
gputl finish --id exp01 --status completed
```

`run`으로 시작한 실험은 별도로 `add`·`finish`할 필요가 없습니다. `finish`는 기록만 바꾸며 실행 중인 프로세스를 중단하지 않습니다.

- 다른 사용자도 `exp01`을 사용할 수 있습니다. 실험 ID는 **로그인 계정 안에서** 구분하며, 사이트에 쓰이는 ID는 자동으로 생성합니다.
- `--owner`는 사이트에 공개할 표시 이름입니다. 로그인 계정을 자동으로 공개하지 않습니다. 표시 이름을 바꾸어도 실제 기록의 소유 계정은 바뀌지 않습니다. 같은 표시 이름은 인증을 의미하지 않습니다.
- 다른 계정의 실험은 수정하거나 완료 처리할 수 없습니다. `gputl list`에는 자기 계정의 최근 100개 기록만 표시합니다. 전체 서버 상태와 공개 실험은 웹에서 함께 확인합니다.
- `--gpus`에는 `nvidia-smi`의 물리 번호를 사용합니다. 여러 GPU는 `0,1`처럼 입력합니다.
- 실제 시작을 나중에 등록할 때는 `--start "2026-09-11T16:00:00+09:00"`처럼 시간대를 포함합니다.
- 예상 종료를 모르면 `--end`를 생략합니다. 종료시간은 GPU 사용률로 추측하지 않습니다.
- `--pid`는 자기 계정의 프로세스만 연결할 수 있습니다. 수집기의 `/proc` 접근 권한 때문에 확인이 안 되면 생략하고 `finish`로 결과를 기록합니다. 프로세스 종료 감지는 성공 판정이 아닙니다.
- API 추론처럼 GPU 프로세스를 다른 계정의 공용 서버가 소유한 경우에도 자기 실험 메타데이터는 등록할 수 있습니다. 그 공용 서버 PID를 자기 실험 PID로 연결하지 않습니다.

실험 저장·수정·완료 시 공용 수집기에 업로드를 자동 요청합니다. 업로드 요청들은 합쳐서 처리하며, 연속 업로드 간격은 최소 30초입니다. 평소 GPU 상태는 10분마다 올리고, 업로드 실패 시 재시도합니다. **저장 완료와 GitHub 업로드 완료는 별개**이며 `gputl status`에서 확인합니다. 웹 조회는 60초 간격이고 raw 파일 캐시 때문에 추가 지연이 있을 수 있습니다.

필요하면 `gputl sync`로 업로드를 요청할 수 있습니다. 토큰이나 관리자 서비스 실행 권한은 필요 없습니다.

## 코딩 Agent에 전달할 규칙

```text
GPU Timeline은 서버 공용 설치를 사용한다.
명령은 /usr/local/bin/gputl이며 현재 로그인 계정에서 실행한다.
프로젝트 위치와 관계없이 status와 run --help로 연결·옵션을 확인한다.

새 실험은 사용자의 작업 폴더·Conda 환경에서 다음 형태로 실행한다:
gputl run --name "실험명" --owner "공개 표시 이름" --gpus 물리번호 -- 원래명령
시작·완료·실패·취소는 자동 기록되므로 add/finish를 중복 호출하지 않는다.
원래 명령은 모든 작업이 끝날 때까지 기다려야 한다. 장시간 작업은 tmux에서 실행한다.
이미 진행 중인 실험은 재실행하지 않고 add로 실제 시작시각과 정보를 등록한다.
수동 등록 실험의 실제 결과는 finish로 기록한다.

공개 표시 이름이 정해지지 않았다면 사용자에게 확인한다.
--gpus는 기록용이므로 실제 GPU 선택 설정도 물리 번호와 맞춘다.
예상 종료를 알면 --end로 입력하고 모르면 추측하지 않는다.
변경은 list에서 ID를 확인해 update한다.
종료 기록 전송에 실패하면 수집기 복구 후 replay한다.
종료 결과가 없으면 성공을 단정하지 말고 실제 실행 상태를 확인한다.

저장하면 공용 수집기가 업로드를 처리한다. 결과는 status로 확인한다.
개인 수집기·토큰·사용자 서비스를 만들거나 sudo로 실험을 실행하지 않는다.
공용 명령이나 run 기능이 없으면 관리자에게 공용 설치·업데이트를 요청한다.
```

## 관리자: 운영·업데이트

```bash
# 로그 / 재시작
sudo journalctl -u gpu-timeline-shared.service -n 30 --no-pager
sudo systemctl restart gpu-timeline-shared.service

# 서버 이름·설정 변경
sudo nano /etc/gpu-timeline/config.json
sudo systemctl restart gpu-timeline-shared.service

# 토큰 교체 (사용자에게 배포하지 않음)
sudo nano /etc/gpu-timeline/agent.env
sudo systemctl restart gpu-timeline-shared.service

# 코드 업데이트: 최초 설치한 관리자 계정으로 실행
cd ~/gpu-timeline
git pull --ff-only
bash agent/install-shared.sh
```

**업데이트는 각 서버에서 최초 설치한 관리자 계정으로 한 번씩만 실행합니다.** 기존 설정·기록은 유지하고 수집기만 재시작합니다. 진행 중인 실험은 중단하지 않으며, 이전 방식으로 실행한 실험이 자동으로 `run` 추적에 편입되지는 않습니다. 다른 사용자들은 추가 설치 없이 새 명령을 사용할 수 있습니다.

공용 설치 후에는 `/etc/gpu-timeline/` 설정이 적용됩니다. 이전 `~/.config/gpu-timeline/` 파일 변경은 공용 서비스에 반영되지 않습니다. 사이트의 서버 목록에도 같은 ID가 등록돼 있어야 합니다.

| 위치 | 용도·접근 |
| --- | --- |
| `/usr/local/bin/gputl` | 모든 계정이 실행하는 작은 클라이언트. 시스템 Python 3.8 이상 |
| `/opt/gpu-timeline/` | 관리자가 배포하는 공용 코드 |
| `/etc/gpu-timeline/config.json` | 서버 설정 |
| `/etc/gpu-timeline/agent.env` | root만 읽는 토큰 파일. systemd가 수집기 프로세스에 전달 |
| `/var/lib/gpu-timeline/` | 관리자 서비스 계정만 읽고 쓰는 실험 기록·스냅샷 |
| `/run/gpu-timeline/control.sock` | 로컬 계정들의 등록 창구. 외부 네트워크 포트는 열지 않음 |

클라이언트 연결의 Linux `SO_PEERCRED`로 실제 계정을 식별합니다. 요청에 계정 ID, 파일 경로, 업로드 토큰을 지정할 수 없습니다. 모든 로컬 계정에 **자기 실험 기록 권한**을 제공하는 연구실 서버용 구성입니다. 관리자 계정과 root는 운영상 신뢰합니다. 컨테이너 안에서는 호스트 설치와 소켓이 자동으로 보이지 않으므로 호스트의 자기 계정에서 명령을 실행합니다.

기존 개인 설치로 복귀해야 한다면:

```bash
sudo systemctl disable --now gpu-timeline-shared.service
systemctl --user enable --now gpu-timeline.timer
```

이 명령은 공용 전환 전의 개인 상태 파일을 사용합니다. 전환 후 새로 기록한 실험은 `/var/lib/gpu-timeline/jobs.json`에 남아 있으며 자동으로 역이관하지 않습니다.

구현 참고: [Python Unix 소켓](https://docs.python.org/3/library/socket.html), [systemd 실행 환경](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
