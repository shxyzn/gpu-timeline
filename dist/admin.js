import {emptyEdits, reference, makeManualJob, makeEditOperation, mergeEdits, GitHubEditsStore} from './edits.js';
import {sealToken, openToken} from './vault.js';
import {jobETA} from './model.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const kstInput = (date = new Date()) => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 16);
export const fromKstInput = value => value ? new Date(`${value}+09:00`).toISOString() : null;

export class DashboardEditor {
  constructor(config, getServers, onChange) {
    this.getServers = getServers;
    this.onChange = onChange;
    this.data = emptyEdits();
    this.token = null;
    this.busy = false;
    this.loadError = '';
    this.enabled = config.mode === 'live' && !!config.dashboard;
    if (!this.enabled) return;
    this.store = new GitHubEditsStore(config.dashboard);
    this.context = `${config.dashboard.repository}/${config.dashboard.branch}/${config.dashboard.path}`;
    this.vaultKey = `gpu-timeline.admin.v1:${this.context}`;
    $('admin-login').hidden = false;
    $('admin-login').onclick = () => this.showLogin();
    $('admin-logout').onclick = () => this.lock();
    $('admin-connect-again').onclick = () => this.showLogin(true);
    $('admin-form').onsubmit = event => this.login(event);
    $('manual-add').onclick = () => this.showAdd();
    $('manual-form').onsubmit = event => this.add(event);
    $('manual-reset').onclick = () => this.resetCollector();
    $('manual-server').onchange = () => this.populateGPUs();
    $('manual-status').onchange = () => this.changeStatus();
    $('record-list').onclick = () => this.showRecords();
    $('record-items').onclick = event => this.recordAction(event);
    $('delete-form').onsubmit = event => this.confirmDelete(event);
    document.querySelectorAll('[data-close-dialog]').forEach(button => {
      button.onclick = () => { if (!this.busy) $(button.dataset.closeDialog).close(); };
    });
    for (const id of ['admin-dialog', 'manual-dialog', 'records-dialog', 'delete-dialog']) {
      $(id).addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
    }
    $('admin-dialog').addEventListener('close', () => {
      $('admin-password').value = '';
      $('admin-password-confirm').value = '';
      $('admin-token').value = '';
    });
    window.addEventListener('pagehide', () => this.lock());
    this.render();
  }
  get unlocked() { return !!this.token; }
  getVault() {
    try { return JSON.parse(localStorage.getItem(this.vaultKey)); } catch { return null; }
  }
  async refresh() {
    if (!this.enabled) return;
    try {
      const data = await this.store.readPublic();
      // Raw/CDN responses can lag behind a successful write. Never resurrect
      // a hidden record by replacing newer local data with an older revision.
      if (data.revision >= this.data.revision) this.data = data;
      this.loadError = data.revision < this.data.revision ? '공유 데이터 갱신 중 · 이 화면에는 방금 저장한 내용을 표시합니다.' : '';
    } catch {
      this.loadError = '수동 기록 수신 실패 · 마지막으로 받은 기록을 표시합니다. 새로고침해 주세요.';
    }
    this.render();
  }
  render() {
    if (!this.enabled) return;
    $('admin-login').hidden = this.unlocked;
    $('admin-tools').hidden = !this.unlocked;
    $('admin-account').textContent = this.account ? `${this.account} · 관리자` : '관리자';
    $('record-list').textContent = `기록 관리${this.data.hidden_jobs.length ? ` · 삭제 ${this.data.hidden_jobs.length}` : ''}`;
    $('edit-notice').textContent = this.loadError;
    if ($('records-dialog').open) this.fillRecords();
  }
  changed() { this.render(); this.onChange(); }
  lock() {
    this.token = null;
    this.account = null;
    // A request already sent to GitHub may still finish; a logout never
    // claims to cancel a committed edit.
    for (const id of ['admin-dialog', 'manual-dialog', 'records-dialog', 'delete-dialog']) $(id)?.close();
    this.changed();
  }
  showLogin(reset = false) {
    this.settingUp = reset || !this.getVault();
    $('admin-form').reset();
    $('admin-error').textContent = '';
    $('admin-title').textContent = this.settingUp ? '관리자 연결' : '관리자 로그인';
    $('admin-description').textContent = this.settingUp
      ? '이 브라우저에서 처음 한 번만 연결하세요. 다음부터는 설정한 비밀번호로 열 수 있어요.'
      : '이 브라우저에 설정한 관리자 비밀번호를 입력하세요.';
    $('admin-setup').hidden = !this.settingUp;
    $('admin-token').required = this.settingUp;
    $('admin-password-confirm').required = this.settingUp;
    $('admin-password').autocomplete = this.settingUp ? 'new-password' : 'current-password';
    $('admin-password').minLength = this.settingUp ? 4 : 1;
    $('admin-submit').textContent = this.settingUp ? '연결하고 로그인' : '로그인';
    $('admin-connect-again').hidden = this.settingUp;
    if (!$('admin-dialog').open) $('admin-dialog').showModal();
    $('admin-password').focus();
  }
  setBusy(value) {
    this.busy = value;
    for (const selector of ['#admin-form button', '#admin-form input', '#manual-form button', '#manual-form input',
      '#manual-form select', '#manual-form textarea', '#delete-form button', '#record-items button',
      '#admin-tools button', '[data-close-dialog]']) {
      document.querySelectorAll(selector).forEach(button => { button.disabled = value; });
    }
    this.syncFormLocks();
  }
  syncFormLocks() {
    $('manual-server').disabled = this.busy || !!this.editing;
    $('manual-status').disabled = this.busy || !!this.editing?.collector;
    document.querySelectorAll('#manual-gpus input').forEach(input => { input.disabled = this.busy || !!this.editing?.collector; });
  }
  async login(event) {
    event.preventDefault();
    if (this.busy) return;
    $('admin-error').textContent = '';
    this.setBusy(true);
    try {
      const password = $('admin-password').value;
      let token;
      if (this.settingUp) {
        if (password !== $('admin-password-confirm').value) throw new Error('비밀번호 확인이 일치하지 않습니다.');
        token = $('admin-token').value.trim();
        if (!token || /\s/.test(token)) throw new Error('GitHub 연결 키를 확인해 주세요.');
      } else {
        token = await openToken(this.getVault(), password, this.context);
      }
      const account = await this.store.verify(token);
      const {data} = await this.store.readLatest(token);
      if (this.settingUp) {
        if ($('admin-remember').checked) {
          const vault = await sealToken(token, password, this.context);
          try { localStorage.setItem(this.vaultKey, JSON.stringify(vault)); }
          catch { throw new Error('브라우저 저장 공간을 사용할 수 없습니다. 이 브라우저에 연결 기억을 해제해 주세요.'); }
        } else {
          try { localStorage.removeItem(this.vaultKey); } catch { /* session-only mode */ }
        }
      }
      this.token = token;
      this.account = account;
      if (data.revision >= this.data.revision) this.data = data;
      this.loadError = '';
      $('admin-dialog').close();
      this.changed();
      this.feedback('관리자 모드가 열렸어요. 추가·삭제한 기록은 모두에게 공유됩니다.');
    } catch (error) { $('admin-error').textContent = error.message; }
    finally { this.setBusy(false); }
  }
  feedback(message) { $('edit-feedback').textContent = message; }
  showAdd() {
    if (!this.unlocked) return this.showLogin();
    this.pendingAdd = null;
    this.editing = null;
    $('manual-form').reset();
    $('manual-error').textContent = '';
    $('manual-server').innerHTML = this.getServers().map(s => `<option value="${escape(s.server_id)}">${escape(s.name)}</option>`).join('');
    $('manual-start').value = kstInput();
    $('manual-title').textContent = '실험 추가';
    $('manual-submit').textContent = '실험 등록';
    $('manual-edit-note').hidden = true;
    $('manual-reset').hidden = true;
    document.querySelectorAll('[data-collector-status]').forEach(option => { option.hidden = true; });
    this.populateGPUs();
    this.changeStatus();
    this.syncFormLocks();
    $('manual-dialog').showModal();
  }
  showEdit(serverID, job) {
    if (!this.unlocked || this.busy) return;
    this.showAdd();
    this.editing = {server: serverID, job: structuredClone(job), data: structuredClone(this.data), collector: !job.dashboard_manual};
    $('manual-title').textContent = '실험 수정';
    $('manual-submit').textContent = '변경 저장';
    $('manual-edit-note').hidden = false;
    $('manual-edit-note').textContent = job.dashboard_manual
      ? '같은 실험 ID로 정보를 수정합니다. 상태를 완료로 바꿀 때 실제 종료시간도 입력해 주세요.'
      : '수정한 이름·설명·시간은 대시보드에 우선 표시합니다. 실행 상태·GPU·진행률은 서버 수집값을 따릅니다.';
    $('manual-reset').hidden = !job.dashboard_override_fields?.length;
    $('manual-server').value = serverID;
    $('manual-name').value = job.name || '';
    $('manual-owner').value = job.owner || '';
    $('manual-description').value = job.description || '';
    document.querySelectorAll('[data-collector-status]').forEach(option => { option.hidden = option.value !== job.status; });
    $('manual-status').value = job.status;
    this.changeStatus();
    this.populateGPUs();
    document.querySelectorAll('#manual-gpus input').forEach(input => { input.checked = job.gpu_uuids.includes(input.value); });
    const server = this.getServers().find(s => s.server_id === serverID);
    const eta = jobETA(job, server?.updated_at).at;
    for (const [id, value] of [['manual-start', job.started_at], ['manual-end', eta === null ? null : new Date(eta).toISOString()], ['manual-ended', job.ended_at]]) {
      $(id).value = value && Number.isFinite(Date.parse(value)) ? kstInput(new Date(value)) : '';
    }
    this.editing.shownTimes = Object.fromEntries(['manual-start', 'manual-end', 'manual-ended'].map(id => [id, $(id).value]));
    this.syncFormLocks();
  }
  populateGPUs() {
    const server = this.getServers().find(s => s.server_id === $('manual-server').value);
    $('manual-gpus').innerHTML = server?.gpus.length
      ? server.gpus.map(g => `<label class="gpu-choice"><input type="checkbox" name="gpu" value="${escape(g.uuid)}"><span>GPU ${g.index}<small>${escape(g.name)}</small></span></label>`).join('')
      : '<p class="admin-help">GPU 정보가 아직 없습니다. 서버 데이터를 받은 뒤 등록해 주세요.</p>';
  }
  changeStatus() {
    const status = $('manual-status').value, terminal = ['completed', 'failed', 'cancelled', 'stopped'].includes(status);
    $('manual-ended-field').hidden = !terminal;
    $('manual-ended').required = terminal;
    $('manual-end').required = status === 'planned';
    if (!terminal) $('manual-ended').value = '';
  }
  async add(event) {
    event.preventDefault();
    if (this.busy || !this.unlocked) return;
    try {
      // An untouched minute-resolution input must retain the original seconds
      // (and an automatic ETA must not become a frozen manual ETA).
      const readTime = (id, key) => this.editing && $(id).value === this.editing.shownTimes[id]
        ? (this.editing.job[key] || null) : fromKstInput($(id).value);
      const input = {server_id: $('manual-server').value, name: $('manual-name').value, owner: $('manual-owner').value,
        description: $('manual-description').value, gpu_uuids: [...document.querySelectorAll('#manual-gpus input:checked')].map(x => x.value),
        status: $('manual-status').value, started_at: readTime('manual-start', 'started_at'),
        expected_end_at: readTime('manual-end', 'expected_end_at'), ended_at: readTime('manual-ended', 'ended_at'),
        force_expected_end: !!this.editing && $('manual-end').value !== this.editing.shownTimes['manual-end']};
      if (this.editing) {
        const {server, job, data} = this.editing;
        const operation = makeEditOperation(input, server, job, this.getServers(), data);
        if (!Object.keys(operation.changes).length) {
          $('manual-dialog').close();
          this.feedback('변경한 항목이 없습니다.');
          return;
        }
        await this.save(operation, 'manual-error', () => {
          $('manual-dialog').close();
          this.feedback('실험 정보를 수정했어요. 같은 ID로 모든 사용자에게 공유됩니다.');
        });
        return;
      }
      const signature = JSON.stringify(input);
      // Reuse identity after an uncertain network result when the form is unchanged.
      if (!this.pendingAdd || this.pendingAdd.signature !== signature) {
        const at = new Date().toISOString();
        this.pendingAdd = {signature, operation: {type: 'add', job: makeManualJob(input, this.getServers(), at), at}};
      }
      const operation = this.pendingAdd.operation;
      await this.save(operation, 'manual-error', () => {
        $('manual-dialog').close();
        this.feedback(`수동 실험을 등록했어요. ${reference(operation.job.server_id, operation.job.id)}`);
      });
    } catch (error) { $('manual-error').textContent = error.message; }
  }
  async resetCollector() {
    if (!this.editing?.collector || !this.unlocked || this.busy) return;
    const ref = reference(this.editing.server, this.editing.job.id);
    const before = this.editing.data.job_overrides?.find(p => p.reference === ref)?.fields;
    if (!before) return;
    await this.save({type: 'reset_collector', reference: ref, before, at: new Date().toISOString()}, 'manual-error', () => {
      $('manual-dialog').close();
      this.feedback('웹에서 수정한 값을 해제했어요. 최신 서버 수집값으로 표시합니다.');
    });
  }
  showDelete(serverID, job) {
    if (!this.unlocked) return this.showLogin();
    this.pendingDelete = {type: 'hide', reference: reference(serverID, job.id), name: (job.name || job.id).slice(0, 160),
      at: new Date().toISOString()};
    $('delete-name').textContent = job.name || job.id;
    $('delete-reference').textContent = this.pendingDelete.reference;
    $('delete-error').textContent = '';
    $('delete-dialog').showModal();
  }
  async confirmDelete(event) {
    event.preventDefault();
    if (!this.pendingDelete || this.busy || !this.unlocked) return;
    await this.save(this.pendingDelete, 'delete-error', () => {
      $('delete-dialog').close();
      $('detail-dialog').close();
      this.feedback('대시보드에서 삭제했어요. 기록 관리에서 복구할 수 있습니다.');
    });
  }
  showRecords() {
    if (!this.unlocked) return this.showLogin();
    $('records-error').textContent = '';
    this.fillRecords();
    $('records-dialog').showModal();
  }
  fillRecords() {
    const hidden = new Set(this.data.hidden_jobs.map(h => h.reference));
    const manual = this.data.manual_jobs.filter(j => !hidden.has(reference(j.server_id, j.id)));
    const row = (name, ref, action, label) => `<div class="record-item"><div><strong>${escape(name)}</strong><code>${escape(ref)}</code></div><div class="record-actions">${action === 'hide' ? `<button type="button" class="edit-button" data-record-action="edit" data-reference="${escape(ref)}" ${this.busy ? 'disabled' : ''}>수정</button>` : ''}<button type="button" class="edit-button" data-record-action="${action}" data-reference="${escape(ref)}" ${this.busy ? 'disabled' : ''}>${label}</button></div></div>`;
    const modified = mergeEdits(this.getServers(), this.data).flatMap(s => s.jobs.filter(j => j.dashboard_override_fields?.length).map(j => ({...j, server_id: s.server_id})));
    $('record-items').innerHTML = `<h3>수동 등록 · ${manual.length}</h3>${manual.map(j => row(j.name, reference(j.server_id, j.id), 'hide', '삭제')).join('') || '<p class="admin-help">수동으로 등록한 실험이 없습니다.</p>'}
      ${modified.length ? `<h3>웹에서 수정한 수집 기록 · ${modified.length}</h3>${modified.map(j => row(j.name, reference(j.server_id, j.id), 'edit', '수정')).join('')}` : ''}
      <h3>삭제된 기록 · ${hidden.size}</h3>${this.data.hidden_jobs.map(h => row(h.name, h.reference, 'restore', '복구')).join('') || '<p class="admin-help">삭제된 기록이 없습니다.</p>'}`;
  }
  async recordAction(event) {
    const button = event.target.closest('[data-record-action]');
    if (!button || this.busy || !this.unlocked) return;
    const ref = button.dataset.reference;
    if (button.dataset.recordAction === 'edit') {
      const servers = mergeEdits(this.getServers(), this.data);
      for (const server of servers) {
        const job = server.jobs.find(j => reference(server.server_id, j.id) === ref);
        if (job) { this.showEdit(server.server_id, job); return; }
      }
      $('records-error').textContent = '서버 정보를 받은 뒤 다시 시도해 주세요.';
    } else if (button.dataset.recordAction === 'hide') {
      const job = this.data.manual_jobs.find(j => reference(j.server_id, j.id) === ref);
      if (job) this.showDelete(job.server_id, job);
    } else {
      await this.save({type: 'restore', reference: ref, at: new Date().toISOString()}, 'records-error', () => {
        this.feedback('삭제 상태를 해제했어요. 원본 기록이 있는 실험은 다시 표시됩니다.');
      });
    }
  }
  async save(operation, errorID, done) {
    $(errorID).textContent = '';
    this.setBusy(true);
    try {
      const token = this.token;
      const saved = await this.store.save(token, operation);
      if (saved.revision >= this.data.revision) this.data = saved;
      this.loadError = '';
      done();
      this.changed();
    } catch (error) { $(errorID).textContent = error.message; }
    finally { this.setBusy(false); }
  }
}
