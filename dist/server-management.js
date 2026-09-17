import {health, versionLabel} from './model.js';

const validVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const $ = id => document.getElementById(id);
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

export function compareVersions(a, b) {
  if (!validVersion(a) || !validVersion(b)) return null;
  const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
  return 0;
}

export function installedVersion(server, descriptor = {}, build = null) {
  if (validVersion(server.agent_version?.version)) {
    const latest = compareVersions(server.agent_version.version, build?.version) === 0 && server.agent_version.dirty !== true;
    return {version: server.agent_version.version, label: versionLabel(server.agent_version) + (latest ? ' (latest)' : ''),
      source: 'reported', note: '수집기가 마지막으로 보고한 설치 버전'};
  }
  // A baseline is an explicit administrator designation for these servers,
  // never a guess from the website version or an upload commit.
  if (server.agent_version == null && validVersion(descriptor.installed_version_baseline)) {
    return {version: descriptor.installed_version_baseline, label: 'v' + descriptor.installed_version_baseline,
      source: 'baseline', note: '관리자 지정 기준 · 다음 설치 후 수집기 보고값 사용'};
  }
  return {version: null, label: '설치 버전 확인 필요', source: 'unknown', note: '설치 버전 보고를 확인해 주세요.'};
}

export function updateCommand(serverID, build) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(serverID) || !validVersion(build?.version) ||
      !/^[0-9a-f]{40}$/.test(build?.revision || '') || build.dirty === true) return null;
  // Download exactly the build on this page into a temporary checkout. Never
  // switch/reset the user's working tree, overwrite a server ID, or expose tokens.
  return `(
  set -eu
  gputl_admin=$(systemctl show gpu-timeline-shared.service --property=User --value)
  if [ -z "$gputl_admin" ] || [ "$gputl_admin" != "$(id -un)" ]; then
    echo "기존 공용 수집기 설치 계정으로 로그인하세요: $gputl_admin" >&2
    exit 1
  fi
  gputl_python=$(systemctl show gpu-timeline-shared.service --property=ExecStart --value | sed -n 's/.*path=\\([^ ;]*\\).*/\\1/p')
  if [ -z "$gputl_python" ] || [ ! -x "$gputl_python" ]; then
    echo '기존 수집기의 Python 경로를 확인해 주세요.' >&2
    exit 1
  fi
  /usr/bin/python3 -c 'import json, sys; actual = json.load(open("/etc/gpu-timeline/config.json"))["server_id"]; sys.exit(0 if actual == sys.argv[1] else "서버 ID가 다릅니다. 이 서버의 관리 화면을 열어 주세요.")' ${quote(serverID)}
  gputl_source=$(mktemp -d /tmp/gpu-timeline-update.XXXXXXXX)
  trap 'rm -rf -- "$gputl_source"' EXIT
  git -C "$gputl_source" init -q
  git -C "$gputl_source" remote add origin https://github.com/shxyzn/gpu-timeline.git
  git -C "$gputl_source" fetch --depth 1 origin ${quote(build.revision)}
  git -C "$gputl_source" checkout --detach FETCH_HEAD
  test "$(git -C "$gputl_source" rev-parse HEAD)" = ${quote(build.revision)}
  test "$(cat "$gputl_source/VERSION")" = ${quote(build.version)}
  GPU_TIMELINE_PYTHON="$gputl_python" bash "$gputl_source/agent/install-shared.sh"
  /usr/local/bin/gputl sync
  /usr/local/bin/gputl status
)`;
}

export const inspectCommand = `hostname
id -un
systemctl show gpu-timeline-shared.service --property=User --property=ExecStart
systemctl status gpu-timeline-shared.service --no-pager
/usr/local/bin/gputl status
nvidia-smi -L`;
export const restartCommand = `sudo systemctl restart gpu-timeline-shared.service
systemctl is-active gpu-timeline-shared.service
/usr/local/bin/gputl sync
/usr/local/bin/gputl status`;

export function maintenanceState(server, descriptor, build, releases = [], now = Date.now(), stale = 1200) {
  const installed = installedVersion(server, descriptor, build);
  const pending = (Array.isArray(releases) ? releases : []).filter(release => {
    const available = compareVersions(release?.version, build?.version);
    return available !== null && available <= 0 && installed.version &&
      compareVersions(installed.version, release.version) < 0;
  });
  const connection = health(server, now, stale);
  const custom = (Array.isArray(descriptor?.actions) ? descriptor.actions : [])
    .filter(action => action && typeof action.title === 'string' && typeof action.command === 'string');
  return {installed, pending, connection, custom};
}

export class ServerManager {
  constructor(config, editor, getServers, getBuild, refresh) {
    this.config = config; this.editor = editor; this.getServers = getServers; this.getBuild = getBuild;
    this.selected = null;
    $('servers').addEventListener('click', event => {
      const button = event.target.closest('[data-manage-server]');
      if (button) this.open(button.dataset.manageServer);
    });
    $('server-manage-close').onclick = () => $('server-manage-dialog').close();
    $('server-manage-refresh').onclick = async () => {
      $('server-manage-refresh').disabled = true;
      try { await refresh(); } finally { $('server-manage-refresh').disabled = false; }
    };
    $('server-manage-body').addEventListener('click', async event => {
      const button = event.target.closest('[data-copy-server-command]');
      if (!button || !this.editor.unlocked) return;
      const code = $(button.dataset.copyServerCommand);
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent);
        if (!this.editor.unlocked || !button.isConnected) return;
        $('server-manage-feedback').textContent = '명령어를 복사했어요. 해당 서버의 SSH 터미널에 붙여넣으세요.';
      } catch {
        if (!this.editor.unlocked || !button.isConnected) return;
        const selection = window.getSelection(), range = document.createRange();
        range.selectNodeContents(code); selection.removeAllRanges(); selection.addRange(range);
        $('server-manage-feedback').textContent = '자동 복사가 차단됐어요. 선택된 명령어를 직접 복사하세요.';
      }
    });
  }
  descriptor(id) { return this.config.servers?.find(server => server.id === id) || {}; }
  state(server) {
    return maintenanceState(server, this.descriptor(server.server_id), this.getBuild(),
      this.config.server_management?.releases, Date.now(), this.config.stale_after_seconds || 1200);
  }
  button(server) {
    if (!this.editor.unlocked) return '';
    const state = this.state(server);
    const note = !state.connection.ok ? '수집 상태 확인' : state.custom.length ? `서버별 안내 ${state.custom.length}건` :
      state.pending.length ? '선택 업데이트 있음' : '설치·점검 안내';
    return `<div class="server-manage-entry"><span>${escape(note)}</span><button type="button" class="edit-button" data-manage-server="${escape(server.server_id)}" aria-label="${escape(server.name)} 서버 관리">서버 관리 ↗</button></div>`;
  }
  open(id) {
    if (!this.editor.unlocked || !this.getServers().some(server => server.server_id === id)) return;
    this.selected = id;
    this.lastContent = null;
    $('server-manage-feedback').textContent = '';
    this.render();
    $('server-manage-dialog').showModal();
    $('server-manage-dialog').scrollTop = 0;
  }
  render() {
    if (!this.editor.unlocked) {
      $('server-manage-dialog').close(); this.selected = null;
      $('server-manage-body').replaceChildren();
      $('server-manage-feedback').textContent = '';
      return;
    }
    if (!this.selected) return;
    const server = this.getServers().find(item => item.server_id === this.selected);
    if (!server) { $('server-manage-dialog').close(); this.selected = null; return; }
    const state = this.state(server), build = this.getBuild();
    $('server-manage-title').textContent = server.name + ' · 서버 관리';
    $('server-manage-id').textContent = server.server_id;
    $('server-manage-installed').textContent = state.installed.label;
    $('server-manage-source').textContent = state.installed.note;
    $('server-manage-target').textContent = versionLabel(build) || '버전 확인 중';
    $('server-manage-health').textContent = state.connection.label;
    const received = server.updated_at ? new Date(server.updated_at) : null;
    $('server-manage-received').textContent = received && Number.isFinite(received.getTime()) ?
      '마지막 수신 ' + received.toLocaleString('ko-KR', {timeZone: 'Asia/Seoul', hour12: false}) + ' KST' : '수신 기록 없음';
    const command = updateCommand(server.server_id, build);
    const block = (id, title, value) => `<div class="server-command"><div class="server-command-heading"><span>${escape(title)}</span><button type="button" class="edit-button" data-copy-server-command="${id}" aria-label="${escape(title)} 복사">복사</button></div><pre tabindex="0"><code id="${id}">${escape(value)}</code></pre></div>`;
    const guidance = state.pending.length ?
      '<p>아래 기능이 필요할 때 한 번에 업데이트하세요. 현재 대시보드는 서버 업데이트 없이 사용할 수 있어요.</p><ul>' +
      state.pending.flatMap(release => Array.isArray(release.features) ? release.features : []).map(item => '<li>' + escape(item) + '</li>').join('') + '</ul>' :
      `<p>${state.installed.version ? '현재 설치 버전을 기준으로 추가 적용할 서버 기능 안내가 없어요.' : '현재 설치 버전을 먼저 확인하세요.'} 웹 기능만 바뀐 버전은 서버에 매번 설치할 필요가 없어요.</p>`;
    const custom = state.custom.map((action, i) => `<article class="server-action"><span class="action-label">이 서버의 조치</span><h3>${escape(action.title)}</h3><p>${escape(action.description || '')}</p>${block('server-custom-' + i, action.title, action.command)}</article>`).join('');
    const updateAvailable = state.installed.version && compareVersions(state.installed.version, build?.version) < 0;
    const update = command && updateAvailable ?
      `<details class="server-action server-update" ${state.pending.length ? 'open' : ''}><summary>수집기 업데이트 명령 <span>선택 · v${escape(build.version)}</span></summary><p>기존 수집기를 설치한 계정에서 실행하세요. 설치 계정·서버 ID를 확인한 뒤 이 화면의 정확한 버전을 설치해요. 기존 Python·설정·실험 기록을 이어서 사용합니다.</p>${block('server-update-command', '수집기 업데이트', command)}<p>수집기가 잠시 재시작됩니다. 설치 후 업로드가 끝나면 위의 <b>수신 다시 확인</b>을 누르세요. 복사만으로 적용 완료 처리되지는 않아요.</p></details>` :
      !command ? '<p class="server-command-unavailable">정확한 배포 버전을 확인할 수 없어 업데이트 명령을 표시하지 못했어요. 배포 완료 후 새로고침하세요.</p>' : '';
    const content = `<article class="server-action server-action-overview"><span class="action-label">${state.pending.length ? '선택 업데이트' : '업데이트 안내'}</span><h3>${state.pending.length ? '서버에 모아서 적용할 기능' : '필요한 기능이 생기면 업데이트'}</h3>${guidance}</article>${custom}
      <details class="server-action" ${state.connection.ok ? '' : 'open'}><summary>수집기 상태·설치 계정 확인 <span>${escape(state.connection.label)}</span></summary><p>해당 서버의 SSH 터미널에서 확인하세요. User는 기존 설치 계정, ExecStart는 사용 중인 Python 경로예요.</p>${block('server-inspect-command', '연결 상태 확인', inspectCommand)}<p>공용 서비스나 gputl이 없다면 <a href="https://github.com/shxyzn/gpu-timeline/blob/main/SHARED_SETUP.md" target="_blank" rel="noopener noreferrer">공용 설치 안내</a>를 확인하세요.</p></details>
      ${update}<details class="server-action"><summary>업로드 요청·수집기 재시작 <span>필요할 때</span></summary><p>먼저 최신 상태 업로드를 요청하세요.</p>${block('server-sync-command', '최신 상태 업로드', '/usr/local/bin/gputl sync\n/usr/local/bin/gputl status')}<p>수집기가 응답하지 않으면 sudo 가능한 계정에서 재시작하세요. 실험 프로세스를 재실행하는 명령은 아닙니다.</p>${block('server-restart-command', '수집기 재시작', restartCommand)}</details>`;
    // Periodic telemetry refreshes should not collapse a command the user is
    // reading, move focus, or discard a text selection.
    if (content !== this.lastContent) {
      $('server-manage-body').innerHTML = content;
      this.lastContent = content;
    }
  }
}
