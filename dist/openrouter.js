import {sealToken, openToken} from './vault.js';
import {queryUsage, dollars, usageStatus, dueForRefresh, REFRESH_MS} from './openrouter-model.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(new Date(value));
const messages = {unauthorized:'키 만료·권한 확인 필요', rate_limit:'조회 제한 · 다음 시간에 재시도', unavailable:'조회 실패 · 이전 값 유지'};
export class OpenRouterBoard {
  constructor(editor) {
    this.editor = editor; this.keys = new Map(); this.attempts = new Map(); this.epoch = 0; this.busy = false;
    this.storageKey = `gpu-timeline.openrouter.v1:${editor.context}`;
    if (!editor.enabled) { $('openrouter-add').disabled = true; this.render(); return; }
    editor.onSession = password => this.session(password);
    $('openrouter-add').onclick = () => this.showAdd();
    $('openrouter-form').onsubmit = event => this.add(event);
    $('openrouter-cancel').onclick = () => { if (!this.busy) $('openrouter-dialog').close(); };
    $('openrouter-dialog').addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
    $('openrouter-dialog').addEventListener('close', () => { $('openrouter-key').value = ''; });
    $('openrouter-grid').onclick = event => {
      const button = event.target.closest('[data-token-action]');
      if (!button || this.busy || !editor.unlocked) return;
      const id = button.dataset.tokenId;
      if (button.dataset.tokenAction === 'refresh') this.refresh(true, id);
      else if (button.dataset.tokenAction === 'connect') this.showAdd(id);
      else if (button.dataset.tokenAction === 'remove') this.remove(id);
    };
    setInterval(() => this.refresh(false), 60000);
    window.addEventListener('focus', () => this.refresh(false));
    this.render();
  }
  records() { return this.editor.data.openrouter_tokens || []; }
  encrypted() { try { return JSON.parse(localStorage.getItem(this.storageKey)) || {}; } catch { return {}; } }
  async session(password) {
    const epoch = ++this.epoch;
    this.keys.clear(); this.password = password;
    if (password === null) { $('openrouter-dialog').close(); this.render(); return; }
    let failed = false;
    for (const [id, vault] of Object.entries(this.encrypted())) {
      try {
        const key = await openToken(vault, password, `${this.storageKey}/${id}`);
        if (this.epoch !== epoch) return;
        this.keys.set(id, key);
      } catch { failed = true; }
    }
    if (this.epoch !== epoch) return;
    if (failed) this.feedback('저장된 일부 키를 열지 못했어요. 해당 카드에서 이 브라우저 연결을 다시 해 주세요.');
    this.render();
    // Login updates editor.data after this hook. Queue a due check afterwards.
    setTimeout(() => this.refresh(false), 0);
  }
  feedback(message) { $('openrouter-feedback').textContent = message; }
  render() {
    const tokens = this.records(), admin = this.editor.unlocked;
    $('openrouter-count').textContent = `${tokens.length} keys`;
    $('openrouter-add').textContent = '+ 추가';
    $('openrouter-add').disabled = this.busy;
    $('openrouter-grid').innerHTML = tokens.map(token => {
      const usage = token.usage, connected = this.keys.has(token.id), stale = usageStatus(token) !== '조회 완료';
      const metric = (name, value) => `<div><dt>${name}</dt><dd>${dollars(value)}</dd></div>`;
      return `<article class="openrouter-card"><header><span class="openrouter-icon" aria-hidden="true">↗</span><div><h3>${esc(token.name)}</h3><span class="openrouter-state ${stale?'old':''}">${usageStatus(token)}</span></div></header>
        <div class="openrouter-total"><span>누적 사용액</span><strong>${dollars(usage.usage)}</strong><small>USD · 이 API 키 기준</small></div>
        <dl class="openrouter-metrics">${metric('오늘 · UTC',usage.usage_daily)}${metric('이번 주 · UTC',usage.usage_weekly)}${metric('이번 달 · UTC',usage.usage_monthly)}</dl>
        <div class="openrouter-limit"><span>키 한도 ${usage.limit === null?'미설정':dollars(usage.limit)}</span><strong>남은 한도 ${dollars(usage.limit_remaining)}</strong></div>
        <p class="openrouter-note">${usage.limit_reset ? ({daily:'일',weekly:'주',monthly:'월'}[usage.limit_reset]+'마다 한도 초기화 · UTC') : '키에 설정한 한도 · 계정 잔액과 다를 수 있음'}${usage.byok_usage ? ' · BYOK 누적 '+dollars(usage.byok_usage)+' 별도' : ''}</p>
        <footer><span>조회 ${esc(date(token.checked_at))} KST</span>${token.error?`<span class="openrouter-error">${messages[token.error]}</span>`:''}</footer>
        ${admin?`<div class="openrouter-actions"><button type="button" class="edit-button" data-token-action="${connected?'refresh':'connect'}" data-token-id="${esc(token.id)}" ${this.busy?'disabled':''}>${connected?'지금 갱신':'이 브라우저 연결'}</button><button type="button" class="edit-button danger" data-token-action="remove" data-token-id="${esc(token.id)}" ${this.busy?'disabled':''}>목록에서 삭제</button></div>`:''}</article>`;
    }).join('') || '<div class="openrouter-empty"><strong>OpenRouter 사용량을 한곳에서</strong><p>추가 버튼으로 token 이름과 API 키를 등록하세요.<br>조회한 사용 금액을 연구실 구성원과 공유할 수 있어요.</p></div>';
  }
  setBusy(value) {
    this.busy = value;
    for (const element of document.querySelectorAll('#openrouter-form input, #openrouter-form button')) element.disabled = value;
    if (this.connectID) $('openrouter-name').disabled = true;
    this.render();
  }
  showAdd(id = null) {
    if (!this.editor.unlocked) return this.editor.showLogin();
    if (this.busy) return;
    this.connectID = id; this.pendingID = null;
    $('openrouter-form').reset(); $('openrouter-error').textContent = '';
    $('openrouter-name').value = this.records().find(t => t.id === id)?.name || '';
    $('openrouter-name').disabled = !!id;
    $('openrouter-dialog-title').textContent = id ? '이 브라우저에 키 연결' : 'OpenRouter token 추가';
    $('openrouter-dialog').showModal();
    $(id ? 'openrouter-key' : 'openrouter-name').focus();
  }
  async persist(id, key, epoch) {
    const vault = await sealToken(key, this.password, `${this.storageKey}/${id}`);
    if (epoch !== this.epoch || !this.editor.unlocked) throw new Error('다시 로그인해 주세요.');
    const saved = this.encrypted(); saved[id] = vault;
    try { localStorage.setItem(this.storageKey, JSON.stringify(saved)); }
    catch { throw new Error('브라우저에 키를 저장하지 못했습니다. 저장 공간 설정을 확인하세요.'); }
    this.keys.set(id,key);
  }
  async save(operation, epoch) {
    if (epoch !== this.epoch || !this.editor.unlocked) throw new Error('다시 로그인해 주세요.');
    const saved = await this.editor.store.save(this.editor.token, operation);
    // An already-sent public write may finish after logout. No credentials persist in it.
    if (saved.revision >= this.editor.data.revision) this.editor.data = saved;
    this.editor.changed();
  }
  async add(event) {
    event.preventDefault();
    if (this.busy || !this.editor.unlocked) return;
    const epoch = this.epoch, key = $('openrouter-key').value.trim(), name = $('openrouter-name').value.trim();
    this.setBusy(true); $('openrouter-error').textContent = '';
    try {
      if (!name || !key || /\s/.test(key)) throw new Error('token 이름과 공백 없는 API 키를 입력하세요.');
      for (const [id, stored] of this.keys) {
        if (stored === key && this.records().some(t => t.id === id) && id !== this.connectID && id !== this.pendingID) throw new Error('이 브라우저에 이미 등록한 키입니다. 기존 카드를 사용하세요.');
      }
      const usage = await queryUsage(key), at = new Date().toISOString();
      const id = this.connectID || this.pendingID || `or-${crypto.randomUUID()}`;
      this.pendingID = id;
      await this.persist(id,key,epoch);
      const entry = {id,name,usage,checked_at:at,attempted_at:at,error:null};
      await this.save(this.connectID || this.records().some(t => t.id === id)
        ? {type:'token_refresh', entries:[entry], at} : {type:'token_add', entry, at}, epoch);
      $('openrouter-dialog').close();
      this.feedback('추가했어요. 이름·사용량은 공유되고, 키는 이 브라우저에 암호화되어 보관됩니다.');
    } catch(error) { if (epoch === this.epoch) $('openrouter-error').textContent = error.message; }
    finally { this.setBusy(false); }
  }
  async refresh(force = false, onlyID = null) {
    if (!this.editor.unlocked || this.busy || this.editor.busy || this.editor.store.saving) return;
    const now = Date.now(), epoch = this.epoch;
    const targets = this.records().filter(t => this.keys.has(t.id) && (!onlyID || t.id === onlyID) &&
      (force || (dueForRefresh(t,now) && now - (this.attempts.get(t.id) || 0) >= REFRESH_MS)));
    if (!targets.length) return;
    this.setBusy(true);
    try {
      const entries = [];
      for (const token of targets) {
        if (epoch !== this.epoch) return;
        this.attempts.set(token.id,Date.now());
        const attempted_at = new Date().toISOString();
        try { entries.push({id:token.id, usage:await queryUsage(this.keys.get(token.id)), attempted_at, checked_at:new Date().toISOString(), error:null}); }
        catch(error) { entries.push({id:token.id, attempted_at, error:error.code || 'unavailable'}); }
      }
      await this.save({type:'token_refresh',entries,at:new Date().toISOString()},epoch);
      if (epoch === this.epoch) this.feedback(entries.some(e => e.error) ? '일부 키 조회에 실패했어요. 마지막 조회값과 시각을 유지합니다.' : 'OpenRouter 사용량을 갱신했어요.');
    } catch(error) { if (epoch === this.epoch) this.feedback(error.message); }
    finally { this.setBusy(false); }
  }
  async remove(id) {
    const token = this.records().find(t => t.id === id);
    if (!token || !confirm(`“${token.name}”을 공유 목록에서 삭제할까요? OpenRouter의 실제 키는 폐기하지 않습니다.`)) return;
    const epoch = this.epoch; this.setBusy(true);
    try {
      await this.save({type:'token_remove',id,at:new Date().toISOString()},epoch);
      this.keys.delete(id);
      const saved = this.encrypted(); delete saved[id];
      try { localStorage.setItem(this.storageKey,JSON.stringify(saved)); } catch { /* encrypted only */ }
      if (epoch === this.epoch) this.feedback('공유 목록에서 삭제했어요. OpenRouter의 실제 키는 그대로 유지됩니다.');
    } catch(error) { if (epoch === this.epoch) this.feedback(error.message); }
    finally { this.setBusy(false); }
  }
}
