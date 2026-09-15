import {emptyEdits, reference, makeManualJob, GitHubEditsStore} from './edits.js';
import {sealToken, openToken} from './vault.js';

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
    $('manual-form').reset();
    $('manual-error').textContent = '';
    $('manual-server').innerHTML = this.getServers().map(s => `<option value="${escape(s.server_id)}">${escape(s.name)}</option>`).join('');
    $('manual-start').value = kstInput();
    this.populateGPUs();
    this.changeStatus();
    $('manual-dialog').showModal();
  }
  populateGPUs() {
    const server = this.getServers().find(s => s.server_id === $('manual-server').value);
    $('manual-gpus').innerHTML = server?.gpus.length
      ? server.gpus.map(g => `<label class="gpu-choice"><input type="checkbox" name="gpu" value="${escape(g.uuid)}"><span>GPU ${g.index}<small>${escape(g.name)}</small></span></label>`).join('')
      : '<p class="admin-help">GPU 정보가 아직 없습니다. 서버 데이터를 받은 뒤 등록해 주세요.</p>';
  }
  changeStatus() {
    const status = $('manual-status').value, terminal = ['completed', 'failed', 'cancelled'].includes(status);
    $('manual-ended-field').hidden = !terminal;
    $('manual-ended').required = terminal;
    $('manual-end').required = status === 'planned';
    if (!terminal) $('manual-ended').value = '';
  }
  async add(event) {
    event.preventDefault();
    if (this.busy || !this.unlocked) return;
    try {
      const input = {server_id: $('manual-server').value, name: $('manual-name').value, owner: $('manual-owner').value,
        description: $('manual-description').value, gpu_uuids: [...document.querySelectorAll('#manual-gpus input:checked')].map(x => x.value),
        status: $('manual-status').value, started_at: fromKstInput($('manual-start').value),
        expected_end_at: fromKstInput($('manual-end').value), ended_at: fromKstInput($('manual-ended').value)};
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
    const row = (name, ref, action, label) => `<div class="record-item"><div><strong>${escape(name)}</strong><code>${escape(ref)}</code></div><button type="button" class="edit-button" data-record-action="${action}" data-reference="${escape(ref)}" ${this.busy ? 'disabled' : ''}>${label}</button></div>`;
    $('record-items').innerHTML = `<h3>수동 등록 · ${manual.length}</h3>${manual.map(j => row(j.name, reference(j.server_id, j.id), 'hide', '삭제')).join('') || '<p class="admin-help">수동으로 등록한 실험이 없습니다.</p>'}
      <h3>삭제된 기록 · ${hidden.size}</h3>${this.data.hidden_jobs.map(h => row(h.name, h.reference, 'restore', '복구')).join('') || '<p class="admin-help">삭제된 기록이 없습니다.</p>'}`;
  }
  async recordAction(event) {
    const button = event.target.closest('[data-record-action]');
    if (!button || this.busy || !this.unlocked) return;
    const ref = button.dataset.reference;
    if (button.dataset.recordAction === 'hide') {
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
