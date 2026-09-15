import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyEdits, validateEdits, makeManualJob, applyOperation, mergeEdits, encodeJSON, decodeJSON, GitHubEditsStore} from '../dist/edits.js';
import {gpuState} from '../dist/model.js';
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
