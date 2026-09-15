import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyEdits, validateEdits, makeManualJob, makeEditOperation, applyOperation, mergeEdits, encodeJSON, decodeJSON, GitHubEditsStore} from '../dist/edits.js';
import {gpuState, jobETA} from '../dist/model.js';
import {sealToken, openToken} from '../dist/vault.js';
import {kstInput, fromKstInput} from '../dist/admin.js';

const now = '2026-09-15T01:00:00.000Z';
const server = {server_id: 'server-a', name: '서버 A', collector_ok: true, updated_at: now,
  gpus: [{uuid: 'GPU-A', index: 0, process_count: 0, utilization: 0, memory_used_mib: 0}],
  jobs: [{id: 'job-1', name: '서버 실험', status: 'running', gpu_uuids: ['GPU-A']}]};
const config = {repository: 'shxyzn/gpu-timeline', branch: 'status', path: 'dashboard/edits.json'};
const input = {server_id: 'server-a', name: 'GEPA · 상현 🧪', owner: '상현', gpu_uuids: ['GPU-A'],
  description: '실험', status: 'running', started_at: '2026-09-15T00:00:00.000Z'};
const job = () => makeManualJob(input, [server], now, 'web-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const add = () => ({type: 'add', job: job(), at: now});
const hide = {type: 'hide', reference: 'server-a/job-1', name: '서버 실험', at: now};
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const file = (data, sha = 'sha') => ({type: 'file', encoding: 'base64', content: encodeJSON(data), sha});

test('manual additions and persistent hides survive fresh telemetry without modifying originals or GPU occupancy', () => {
  const original = structuredClone(server);
  let data = applyOperation(emptyEdits(), add());
  data = applyOperation(data, hide);
  let [visible] = mergeEdits([server], data);
  assert.deepEqual(visible.jobs.map(j => j.id), [job().id]);
  assert.equal(visible.jobs[0].dashboard_manual, true);
  assert.deepEqual(server, original);
  assert.equal(gpuState(server, server.gpus[0], Date.parse(now), 1200), 'busy');
  const uploaded = {...server, jobs: [...server.jobs, {id: 'job-2', gpu_uuids: ['GPU-A']}]};
  [visible] = mergeEdits([uploaded], data);
  assert.equal(visible.jobs.some(j => j.id === 'job-1'), false);
  assert.equal(visible.jobs.some(j => j.id === 'job-2'), true);
  data = applyOperation(data, {type: 'restore', reference: hide.reference, at: now});
  assert.equal(mergeEdits([uploaded], data)[0].jobs.some(j => j.id === 'job-1'), true);
});

test('hide key includes server identity and restoration does not recreate expired collector records', () => {
  const other = {...server, server_id: 'server-b'};
  const data = applyOperation(emptyEdits(), hide);
  assert.equal(mergeEdits([server, other], data)[1].jobs.length, 1);
  const restored = applyOperation(data, {type: 'restore', reference: hide.reference, at: now});
  assert.deepEqual(mergeEdits([{...server, jobs: []}], restored)[0].jobs, []);
});

test('manual validation checks GPU identity, timing, terminal status and planned ETA', () => {
  const make = patch => makeManualJob({...input, ...patch}, [server], now);
  assert.throws(() => make({gpu_uuids: ['unknown']}), /GPU/);
  assert.throws(() => make({server_id: 'other'}), /GPU/);
  assert.throws(() => make({name: '   '}), /실험명/);
  assert.throws(() => make({status: 'planned'}), /예상 종료/);
  assert.throws(() => make({status: 'completed'}), /실제 종료/);
  assert.throws(() => make({expected_end_at: '2026-09-14T23:00:00Z'}), /시작시간 이후/);
  assert.throws(() => make({started_at: '2026-09-16T00:00:00Z'}), /예정/);
  assert.throws(() => make({ended_at: now}), /실행 중/);
  assert.throws(() => make({status: 'completed', ended_at: '2026-09-16T00:00:00Z'}), /미래/);
  assert.equal(make({expected_end_at: null}).expected_end_at, null);
  assert.equal(make({status: 'completed', ended_at: now}).ended_at, now);
});

test('invalid/future schemas and duplicate IDs are rejected rather than silently overwritten', () => {
  assert.throws(() => validateEdits({...emptyEdits(), schema_version: 2}));
  assert.throws(() => validateEdits({...emptyEdits(), revision: -1}));
  assert.throws(() => validateEdits({...emptyEdits(), manual_jobs: [job(), job()]}));
  assert.throws(() => validateEdits({...emptyEdits(), hidden_jobs: [{reference: 'x', name: 'x', hidden_at: now}]}));
});

test('all operations are idempotent and Korean/emoji text round trips', () => {
  const op = add(), data = applyOperation(emptyEdits(), op);
  assert.deepEqual(decodeJSON(encodeJSON(data)), data);
  assert.deepEqual(applyOperation(data, op), data);
  const hidden = applyOperation(data, hide);
  assert.deepEqual(applyOperation(hidden, hide), hidden);
  const restore = {type: 'restore', reference: hide.reference, at: now};
  const restored = applyOperation(hidden, restore);
  assert.deepEqual(applyOperation(restored, restore), restored);
});

test('GitHub conflict retries against current SHA and preserves another administrator edit', async () => {
  let data = emptyEdits(), sha = 'initial', writes = 0;
  const fetcher = async (url, options) => {
    assert.ok(url.startsWith('https://api.github.com/repos/shxyzn/gpu-timeline/contents/dashboard/edits.json'));
    if (options.method !== 'PUT') return json(file(data, sha));
    const body = JSON.parse(options.body);
    assert.equal(body.branch, 'status');
    if (writes++ === 0) {
      data = applyOperation(data, hide); sha = 'other-admin';
      return json({}, 409);
    }
    assert.equal(body.sha, 'other-admin');
    data = decodeJSON(body.content);
    return json({content: {sha: 'new'}}, 200);
  };
  const store = new GitHubEditsStore(config, fetcher, async () => {});
  const saved = await store.save('test-token', add());
  assert.equal(writes, 2);
  assert.equal(saved.manual_jobs.length, 1);
  assert.equal(saved.hidden_jobs.length, 1);
  assert.equal(saved.revision, 2);
});

test('a successful write with a lost response can be retried without duplicate commits', async () => {
  let data = emptyEdits(), writes = 0;
  const store = new GitHubEditsStore(config, async (url, options) => {
    if (options.method !== 'PUT') return json(file(data));
    writes++;
    data = decodeJSON(JSON.parse(options.body).content);
    throw new TypeError('lost response');
  });
  const operation = add();
  await assert.rejects(store.save('test-token', operation), /연결/);
  assert.equal((await store.save('test-token', operation)).manual_jobs.length, 1);
  assert.equal(writes, 1);
});

test('an invalid existing file or denied write never reports success or erases records', async () => {
  let writes = 0;
  const store = new GitHubEditsStore(config, async (url, options) => {
    if (options.method === 'PUT') writes++;
    return json(file({...emptyEdits(), schema_version: 9}));
  });
  await assert.rejects(store.save('test-token', add()), /형식/);
  assert.equal(writes, 0);
  const denied = new GitHubEditsStore(config, async (url, options) => options.method === 'PUT' ? json({}, 403) : json(file(emptyEdits())));
  await assert.rejects(denied.save('test-token', add()), /권한/);
  assert.equal(denied.saving, false);
});

test('first write creates only the dashboard file after checking status branch exists', async () => {
  let branchChecked = false;
  const store = new GitHubEditsStore(config, async (url, options) => {
    if (url.includes('/git/ref/heads/status')) { branchChecked = true; return json({ref: 'refs/heads/status'}); }
    if (options.method !== 'PUT') return json({}, 404);
    assert.equal(branchChecked, true);
    assert.equal(JSON.parse(options.body).sha, undefined);
    return json({}, 201);
  });
  assert.equal((await store.save('test-token', add())).revision, 1);
});

test('public reads have no authentication or custom headers and tolerate a not-yet-created overlay', async () => {
  const store = new GitHubEditsStore(config, async (url, options) => {
    assert.ok(url.startsWith('https://raw.githubusercontent.com/shxyzn/gpu-timeline/status/dashboard/edits.json'));
    assert.equal(options.headers, undefined);
    assert.equal(options.credentials, 'omit');
    return json({}, 404);
  });
  assert.deepEqual(await store.readPublic(), emptyEdits());
});

test('administrator verification requires an authenticated endpoint', async () => {
  const store = new GitHubEditsStore(config, async (url, options) => {
    assert.equal(url, 'https://api.github.com/user');
    assert.equal(options.headers.Authorization, 'Bearer invalid');
    return json({}, 401);
  });
  await assert.rejects(store.verify('invalid'), /관리자 연결 키/);
});

test('local vault unlocks only with password and matching repository, with tamper detection', async () => {
  const token = 'test-only-token-never-real', context = 'shxyzn/gpu-timeline/status/dashboard/edits.json';
  const vault = await sealToken(token, 'cvml-test', context);
  assert.equal(JSON.stringify(vault).includes(token), false);
  assert.equal(JSON.stringify(vault).includes('cvml-test'), false);
  assert.equal(await openToken(vault, 'cvml-test', context), token);
  await assert.rejects(openToken(vault, 'wrong-password', context), /비밀번호/);
  await assert.rejects(openToken(vault, 'cvml-test', 'another/repository'), /비밀번호/);
  await assert.rejects(openToken({...vault, ciphertext: 'AAAA'}, 'cvml-test', context), /비밀번호/);
});

test('form times always use Korea time independently of the browser timezone', () => {
  assert.equal(kstInput(new Date(now)), '2026-09-15T10:00');
  assert.equal(fromKstInput('2026-09-15T10:00'), now);
  assert.equal(fromKstInput(''), null);
});

const collector = {...server.jobs[0], owner: '상현', description: '', started_at: '2026-09-15T00:00:17.123Z', expected_end_at: null, ended_at: null,
  progress: {completed: 25, total: 100, updated_at: now}};
const editCollector = (patch, data = emptyEdits(), visible = collector) =>
  makeEditOperation({...visible, ...patch}, server.server_id, visible, [server], data, now);

test('manual editing preserves ID and creation time, updates times/GPU/status, and retries idempotently', () => {
  const data = applyOperation(emptyEdits(), add());
  const [visible] = mergeEdits([server], data);
  const before = visible.jobs.find(j => j.dashboard_manual);
  const op = makeEditOperation({...before, name: 'GEPA 수정', status: 'completed', ended_at: now}, 'server-a', before, [server], data, now);
  const next = applyOperation(data, op);
  assert.equal(next.manual_jobs.length, 1);
  assert.equal(next.manual_jobs[0].id, before.id);
  assert.equal(next.manual_jobs[0].created_at, before.created_at);
  assert.equal(next.manual_jobs[0].status, 'completed');
  assert.equal(next.manual_jobs[0].ended_at, now);
  assert.deepEqual(applyOperation(next, op), next);
});

test('collector edits contain only changed fields, keep timestamp precision, and cannot alter identity or status', () => {
  const op = editCollector({name: '이름 수정', status: 'completed', id: 'other'});
  assert.deepEqual(op.changes, {name: '이름 수정'});
  const next = applyOperation(emptyEdits(), op);
  const visible = mergeEdits([{...server, jobs: [collector]}], next)[0].jobs[0];
  assert.equal(visible.started_at, collector.started_at);
  assert.equal(visible.status, 'running');
  assert.equal(visible.id, collector.id);
  assert.throws(() => applyOperation(emptyEdits(), {...op, changes: {status: 'completed'}}), /수정할 수 없는/);
});

test('edited times/metadata survive collector upload while completion and progress remain live', () => {
  const op = editCollector({name: 'GEPA 웹 수정', started_at: '2026-09-14T23:00:00Z', expected_end_at: '2026-09-15T05:00:00Z'});
  const data = applyOperation(emptyEdits(), op);
  const uploaded = {...collector, status: 'completed', ended_at: now, progress: {completed: 100, total: 100}};
  const visible = mergeEdits([{...server, jobs: [uploaded]}], data)[0].jobs[0];
  assert.equal(visible.name, 'GEPA 웹 수정');
  assert.equal(visible.started_at, op.changes.started_at);
  assert.equal(visible.expected_end_at, op.changes.expected_end_at);
  assert.equal(visible.status, 'completed');
  assert.equal(visible.ended_at, now);
  assert.equal(visible.progress.completed, 100);
  assert.equal(uploaded.name, collector.name);
});

test('explicit ETA edit wins over progress; clearing and reset restore the intended behavior', () => {
  const source = {...collector, eta_source: 'progress'};
  let data = applyOperation(emptyEdits(), editCollector({expected_end_at: '2026-09-15T06:00:00Z'}, emptyEdits(), source));
  const view = () => mergeEdits([{...server, jobs: [source]}], data)[0].jobs[0];
  assert.equal(jobETA(view(), now).at, Date.parse('2026-09-15T06:00:00Z'));
  data = applyOperation(data, editCollector({expected_end_at: null}, data, view()));
  assert.equal(jobETA(view(), now).at, null);
  const reset = {type: 'reset_collector', reference: 'server-a/job-1', before: data.job_overrides[0].fields, at: now};
  data = applyOperation(data, reset);
  assert.equal(jobETA(view(), now).source, 'progress');
  assert.deepEqual(applyOperation(data, reset), data);
  const clearAuto = editCollector({expected_end_at: null, force_expected_end: true}, emptyEdits(), source);
  assert.deepEqual(clearAuto.changes, {expected_end_at: null});
});

test('concurrent edits merge different fields and reject stale same-field updates or resets', () => {
  const first = editCollector({name: 'A'}), second = editCollector({owner: '다른 등록자'}), conflict = editCollector({name: 'B'});
  const data = applyOperation(emptyEdits(), first);
  const merged = applyOperation(data, second);
  assert.deepEqual(merged.job_overrides[0].fields, {name: 'A', owner: '다른 등록자'});
  assert.throws(() => applyOperation(merged, conflict), /같은 항목/);
  assert.deepEqual(applyOperation(merged, first), merged);
  assert.throws(() => applyOperation(merged, {type: 'reset_collector', reference: 'server-a/job-1', before: data.job_overrides[0].fields, at: now}), /다른 관리자/);
});

test('concurrent manual edits merge independent fields and reject invalid time combinations', () => {
  const data = applyOperation(emptyEdits(), add()), before = {...data.manual_jobs[0], dashboard_manual: true};
  const make = patch => makeEditOperation({...before, ...patch}, 'server-a', before, [server], data, now);
  const first = applyOperation(data, make({name: 'A'}));
  const second = applyOperation(first, make({description: '추가 메모'}));
  assert.equal(second.manual_jobs[0].name, 'A');
  assert.equal(second.manual_jobs[0].description, '추가 메모');
  assert.throws(() => applyOperation(second, make({name: 'B'})), /같은 항목/);
  const end = make({expected_end_at: '2026-09-15T00:30:00Z'});
  const start = applyOperation(data, make({started_at: '2026-09-15T00:45:00Z'}));
  assert.throws(() => applyOperation(start, end), /형식/);
});

test('legacy documents remain valid; overlays are isolated by server, kept through hide/restore and do not invent expired records', () => {
  assert.equal(validateEdits(emptyEdits()).job_overrides, undefined);
  let data = applyOperation(emptyEdits(), editCollector({name: '웹 이름'}));
  data = applyOperation(data, hide);
  assert.equal(mergeEdits([{...server, jobs: [collector]}], data)[0].jobs.length, 0);
  data = applyOperation(data, {type: 'restore', reference: hide.reference, at: now});
  assert.equal(mergeEdits([{...server, jobs: [collector]}], data)[0].jobs[0].name, '웹 이름');
  assert.equal(mergeEdits([{...server, server_id: 'server-b', jobs: [collector]}], data)[0].jobs[0].name, collector.name);
  assert.equal(mergeEdits([{...server, jobs: []}], data)[0].jobs.length, 0);
});
