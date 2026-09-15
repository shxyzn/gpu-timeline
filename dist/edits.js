// Dashboard records are deliberately separate from collector-owned snapshots.
export const emptyEdits = () => ({schema_version: 1, revision: 0, updated_at: null, manual_jobs: [], hidden_jobs: []});
export const reference = (server, job) => `${server}/${job}`;
const validText = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;
const validTime = s => typeof s === 'string' && Number.isFinite(Date.parse(s));
const serverID = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(s);
const statuses = ['planned', 'running', 'completed', 'failed', 'cancelled'];
const terminal = s => ['completed', 'failed', 'cancelled'].includes(s);

export function validateEdits(data) {
  const fail = () => { throw new Error('수동 기록 파일 형식이 올바르지 않습니다. 원본을 확인해 주세요.'); };
  if (!data || data.schema_version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
      !Array.isArray(data.manual_jobs) || !Array.isArray(data.hidden_jobs) ||
      !(data.updated_at === null || validTime(data.updated_at))) fail();
  const ids = new Set();
  for (const j of data.manual_jobs) {
    if (!serverID(j.server_id) || !/^web-[a-f0-9-]{36}$/.test(j.id || '') ||
        !validText(j.name, 160) || typeof j.owner !== 'string' || j.owner.length > 100 ||
        typeof j.description !== 'string' || j.description.length > 2000 ||
        !statuses.includes(j.status) || !Array.isArray(j.gpu_uuids) || !j.gpu_uuids.length ||
        j.gpu_uuids.some(g => !validText(g, 200)) || new Set(j.gpu_uuids).size !== j.gpu_uuids.length ||
        !validTime(j.started_at) || !validTime(j.created_at) ||
        !(j.expected_end_at === null || (validTime(j.expected_end_at) && Date.parse(j.expected_end_at) > Date.parse(j.started_at))) ||
        !(j.ended_at === null || (validTime(j.ended_at) && Date.parse(j.ended_at) >= Date.parse(j.started_at))) ||
        (terminal(j.status) !== (j.ended_at !== null)) ||
        (j.status === 'planned' && j.expected_end_at === null)) fail();
    const key = reference(j.server_id, j.id);
    if (ids.has(key)) fail();
    ids.add(key);
  }
  ids.clear();
  for (const h of data.hidden_jobs) {
    if (!validText(h.reference, 500) || !h.reference.includes('/') || !validText(h.name, 160) ||
        !validTime(h.hidden_at) || ids.has(h.reference)) fail();
    ids.add(h.reference);
  }
  // GitHub's base64 Contents response is supported for files below 1 MB.
  if (new TextEncoder().encode(JSON.stringify(data)).length > 800000) {
    throw new Error('수동 기록 저장 용량에 도달했습니다. 기록 정리가 필요합니다.');
  }
  return data;
}

export function makeManualJob(input, servers, now = new Date().toISOString(), id = `web-${crypto.randomUUID()}`) {
  const server = servers.find(s => s.server_id === input.server_id);
  if (!server || !input.gpu_uuids?.length || input.gpu_uuids.some(g => !server.gpus.some(x => x.uuid === g))) {
    throw new Error('서버와 GPU를 선택해 주세요.');
  }
  const job = {
    id, server_id: input.server_id, name: input.name?.trim(), owner: (input.owner || '').trim(),
    description: (input.description || '').trim(), gpu_uuids: [...new Set(input.gpu_uuids)],
    status: input.status, started_at: input.started_at, expected_end_at: input.expected_end_at || null,
    ended_at: input.ended_at || null, created_at: now,
  };
  if (!job.name) throw new Error('실험명을 입력해 주세요.');
  if (!validTime(job.started_at)) throw new Error('시작시간을 입력해 주세요.');
  if (job.status === 'planned' && !job.expected_end_at) throw new Error('예정 실험에는 예상 종료시간을 입력해 주세요.');
  if (terminal(job.status) && !job.ended_at) throw new Error('종료된 실험에는 실제 종료시간을 입력해 주세요.');
  if (!terminal(job.status) && job.ended_at) throw new Error('실행 중·예정 실험에는 실제 종료시간을 입력할 수 없습니다.');
  if (job.expected_end_at && Date.parse(job.expected_end_at) <= Date.parse(job.started_at)) throw new Error('예상 종료시간은 시작시간 이후여야 합니다.');
  if (job.ended_at && Date.parse(job.ended_at) < Date.parse(job.started_at)) throw new Error('실제 종료시간은 시작시간 이후여야 합니다.');
  if (job.status !== 'planned' && Date.parse(job.started_at) > Date.parse(now)) throw new Error('미래에 시작할 실험은 상태를 예정으로 선택해 주세요.');
  if (job.ended_at && Date.parse(job.ended_at) > Date.parse(now)) throw new Error('실제 종료시간은 미래로 입력할 수 없습니다.');
  validateEdits({...emptyEdits(), manual_jobs: [job]});
  return job;
}

export function applyOperation(original, operation) {
  const data = structuredClone(validateEdits(original));
  if (operation.type === 'add') {
    const job = operation.job, key = reference(job.server_id, job.id);
    const previous = data.manual_jobs.find(j => reference(j.server_id, j.id) === key);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(job)) throw new Error('같은 ID의 다른 실험이 있습니다. 새로고침 후 다시 시도해 주세요.');
      return data; // Retrying a write whose response was lost must not duplicate it.
    }
    data.manual_jobs.push(job);
  } else if (operation.type === 'hide') {
    if (data.hidden_jobs.some(h => h.reference === operation.reference)) return data;
    data.hidden_jobs.push({reference: operation.reference, name: operation.name, hidden_at: operation.at});
  } else if (operation.type === 'restore') {
    if (!data.hidden_jobs.some(h => h.reference === operation.reference)) return data;
    data.hidden_jobs = data.hidden_jobs.filter(h => h.reference !== operation.reference);
  } else {
    throw new Error('지원하지 않는 편집 요청입니다.');
  }
  data.revision++;
  data.updated_at = operation.at;
  return validateEdits(data);
}

export function mergeEdits(servers, data) {
  validateEdits(data);
  const hidden = new Set(data.hidden_jobs.map(h => h.reference));
  return servers.map(server => {
    const jobs = [...server.jobs];
    const existing = new Set(jobs.map(j => j.id));
    for (const j of data.manual_jobs) {
      if (j.server_id === server.server_id && !existing.has(j.id)) jobs.push({...j, dashboard_manual: true});
    }
    return {...server, jobs: jobs.filter(j => !hidden.has(reference(server.server_id, j.id)))};
  });
}

export function encodeJSON(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n');
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}
export function decodeJSON(content) {
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(atob(content.replace(/\s/g, '')), c => c.charCodeAt(0))));
}

class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class GitHubEditsStore {
  constructor(config, fetcher = (...args) => globalThis.fetch(...args), pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    if (!config || !/^[\w.-]+\/[\w.-]+$/.test(config.repository || '') ||
        config.branch !== 'status' || config.path !== 'dashboard/edits.json') {
      throw new Error('대시보드 저장소 설정을 확인해 주세요.');
    }
    this.config = config;
    this.fetcher = fetcher;
    this.pause = pause;
    this.root = `https://api.github.com/repos/${config.repository}`;
    this.url = `${this.root}/contents/${config.path}`;
    this.rawURL = `https://raw.githubusercontent.com/${config.repository}/${config.branch}/${config.path}`;
    this.saving = false;
  }
  async request(url, token, options = {}) {
    let response;
    try {
      response = await this.fetcher(url, {
        ...options, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(options.body ? {'Content-Type': 'application/json'} : {})},
      });
    } catch {
      throw new Error('GitHub 연결을 확인할 수 없습니다. 저장 결과가 불확실하면 같은 요청을 다시 시도해 주세요.');
    }
    if (!response.ok) {
      const messages = {401: '관리자 연결 키가 만료되었거나 올바르지 않습니다. 연결을 다시 설정해 주세요.',
        403: 'GitHub 요청 제한 또는 쓰기 권한을 확인해 주세요.',
        404: '저장소·status 브랜치 또는 토큰의 저장소 접근 권한을 확인해 주세요.',
        409: '다른 변경과 겹쳤습니다. 잠시 후 다시 저장해 주세요.',
        422: '변경을 저장하지 못했습니다. 권한·저장소 설정을 확인하거나 잠시 후 다시 시도해 주세요.'};
      throw new GitHubError(response.status, messages[response.status] || `GitHub 응답 오류 (${response.status})`);
    }
    return response.json();
  }
  async verify(token) {
    // A public GET alone does not verify credentials. /user requires a valid token.
    const user = await this.request('https://api.github.com/user', token);
    const repo = await this.request(this.root, token);
    if (repo.permissions && !repo.permissions.push) throw new Error('이 저장소에 쓰기 권한이 있는 관리자 계정이 필요합니다.');
    await this.request(`${this.root}/git/ref/heads/${this.config.branch}`, token);
    return user.login;
  }
  async readPublic() {
    const response = await this.fetcher(`${this.rawURL}?_=${Date.now()}`, {
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return emptyEdits();
    if (!response.ok) throw new Error('수동 기록을 불러오지 못했습니다. 마지막 수신 기록을 유지합니다.');
    return validateEdits(await response.json());
  }
  async readLatest(token) {
    try {
      const file = await this.request(`${this.url}?ref=${this.config.branch}&_=${Date.now()}`, token);
      if (file.type !== 'file' || file.encoding !== 'base64' || !file.sha || typeof file.content !== 'string') {
        throw new Error('수동 기록 파일을 읽지 못했습니다. 기존 내용을 덮어쓰지 않았습니다.');
      }
      return {data: validateEdits(decodeJSON(file.content)), sha: file.sha};
    } catch (error) {
      if (error.status !== 404) throw error;
      // Distinguish a missing file from an inaccessible/missing branch before creation.
      await this.request(`${this.root}/git/ref/heads/${this.config.branch}`, token);
      return {data: emptyEdits(), sha: null};
    }
  }
  async save(token, operation) {
    if (!token) throw new Error('관리자 로그인이 필요합니다.');
    if (this.saving) throw new Error('앞선 저장이 끝난 뒤 다시 시도해 주세요.');
    this.saving = true;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const {data, sha} = await this.readLatest(token);
        const next = applyOperation(data, operation);
        if (next.revision === data.revision) return data;
        try {
          await this.request(this.url, token, {method: 'PUT', body: JSON.stringify({
            message: `dashboard: ${operation.type} experiment record`, branch: this.config.branch,
            content: encodeJSON(next), ...(sha ? {sha} : {}),
          })});
          return next;
        } catch (error) {
          if (![409, 422].includes(error.status) || attempt === 3) throw error;
          await this.pause(200 * (attempt + 1));
        }
      }
    } finally { this.saving = false; }
  }
}
