import test from 'node:test';
import assert from 'node:assert/strict';
import {LIMITS, emptyResearch, validateResearch, validDate, makeProject, makeOutput, applyResearchOperation, projectProgress,
  remainingText, researchOverview, outputWarnings, ackText, targetLabel, statusLabel, today, daysUntil, ddayLabel} from '../dist/test-server/research-model.js';
import {sealGate, openGate, validGate, importDocumentKey, sealJSON, openJSON, isEnvelope, toBase64, fromBase64} from '../dist/test-server/workspace-crypto.js';
import {ResearchStore, RESEARCH_PATH} from '../dist/test-server/research-store.js';
import {currentSession, startSession, endSession, cleanName, lastName} from '../dist/test-server/session.js';
import {GATE} from '../dist/test-server/gate.js';
import {encodeJSON, decodeJSON} from '../dist/edits.js';

const at = '2026-11-01T00:00:00.000Z', on = '2026-11-13';
const project = (input = {}, options = {}) => makeProject({name: 'IITP 과제', ends_on: '2027-12-31', targets: [], ...input}, {by: '상현', at, ...options});
const output = (input, projects, options = {}) => makeOutput({kind: 'paper', grade: 'sci', status: 'published', title: '논문', acks: [], ...input}, projects, {by: '상현', at, ...options});
const doc = (projects, outputs = []) => validateResearch({...emptyResearch(), projects, outputs});
const row = (progress, index) => { const r = progress.rows[index]; return [r.done, r.pending, r.remaining, r.state]; };

test('calendar dates are real days and are read in Korean time', () => {
  assert.equal(validDate('2026-02-28'), true);
  for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', '', null, 20260101]) assert.equal(validDate(bad), false, String(bad));
  // 15:30 UTC is already the next day in Seoul.
  assert.equal(today(Date.parse('2026-11-13T15:30:00Z')), '2026-11-14');
  assert.equal(today(Date.parse('2026-11-13T14:59:00Z')), '2026-11-13');
  assert.equal(daysUntil('2026-12-31', '2026-11-13'), 48);
  assert.equal(daysUntil('2026-11-13', '2026-11-13'), 0);
  assert.deepEqual([ddayLabel(48), ddayLabel(0), ddayLabel(-13)], ['D-48', 'D-DAY', 'D+13']);
});

test('a project needs a name, an end date and well-formed targets', () => {
  const p = project({name: '  멀티모달  과제 ', short: 'IITP', number: 'RS-2025-1', starts_on: '2025-04-01',
    targets: [{metric: 'paper_sci', count: '3'}, {metric: 'custom', label: '기술이전', count: 1, due_on: '2026-12-31'}],
    milestones: [{title: '연차보고서', date: '2026-12-10'}]});
  assert.equal(p.name, '멀티모달 과제');
  assert.match(p.id, /^p-[a-f0-9-]{36}$/);
  assert.deepEqual(p.targets.map(t => [t.metric, t.count, t.due_on]), [['paper_sci', 3, null], ['custom', 1, '2026-12-31']]);
  assert.equal(p.milestones[0].done, false);
  assert.equal(targetLabel(p.targets[0]), 'SCI(E) 논문');
  assert.equal(targetLabel({metric: 'paper_sci', label: '2차년도'}), 'SCI(E) 논문 · 2차년도');
  assert.equal(targetLabel(p.targets[1]), '기술이전');
  assert.throws(() => project({name: ' '}), /과제명/);
  assert.throws(() => project({ends_on: ''}), /종료일/);
  assert.throws(() => project({starts_on: '2028-01-01'}), /시작일/);
  assert.throws(() => project({targets: [{metric: 'paper_sci', count: 0}]}), /목표 수/);
  assert.throws(() => project({targets: [{metric: 'paper_sci', count: 1.5}]}), /목표 수/);
  assert.throws(() => project({targets: [{metric: 'custom', label: ' ', count: 1}]}), /이름/);
  assert.throws(() => project({targets: [{metric: 'unknown', count: 1}]}), /목표/);
  assert.throws(() => project({targets: [{metric: 'paper_sci', count: 1, due_on: '2026-02-31'}]}), /기한/);
  assert.throws(() => project({milestones: [{title: '보고', date: ''}]}), /일정/);
  assert.throws(() => project({targets: Array.from({length: LIMITS.targets + 1}, () => ({metric: 'paper_sci', count: 1}))}), /목표는/);
  // An edit keeps the identity and creation time.
  const edited = project({name: '새 이름'}, {previous: p, at: '2026-11-02T00:00:00.000Z'});
  assert.deepEqual([edited.id, edited.created_at, edited.updated_at], [p.id, at, '2026-11-02T00:00:00.000Z']);
});

test('an output is validated against its kind and the projects it acknowledges', () => {
  const p = project({targets: [{metric: 'paper_sci', count: 1}]});
  const o = output({title: ' A  paper ', link: 'https://doi.org/10.1/x', acks: [{project_id: p.id, text: ' custom '}]}, [p]);
  assert.equal(o.title, 'A paper');
  assert.deepEqual(o.acks, [{project_id: p.id, target_id: null, text: 'custom'}]);
  assert.equal(statusLabel(o), '게재 완료');
  assert.equal(statusLabel({kind: 'conference', status: 'accepted'}), '발표 확정');
  assert.equal(output({kind: 'software', grade: 'ignored', status: 'registered'}, [p]).grade, '');
  assert.throws(() => output({title: ''}, [p]), /제목/);
  assert.throws(() => output({kind: 'book'}, [p]), /종류/);
  assert.throws(() => output({grade: 'intl'}, [p]), /구분/);
  assert.throws(() => output({status: 'registered'}, [p]), /상태/);
  assert.throws(() => output({date: '2026-02-30'}, [p]), /날짜/);
  for (const link of ['javascript:alert(1)', 'ftp://example.com/a', 'https://a b', 'https://x"onmouseover="1']) assert.throws(() => output({link}, [p]), /링크/, link);
  assert.throws(() => output({acks: [{project_id: 'p-00000000-0000-4000-8000-000000000000'}]}, [p]), /사사 과제/);
  assert.throws(() => output({acks: [{project_id: p.id}, {project_id: p.id}]}, [p]), /사사 과제/);
  assert.throws(() => output({acks: [{project_id: p.id, target_id: 't-00000000-0000-4000-8000-000000000000'}]}, [p]), /목표/);
  assert.equal(output({acks: [{project_id: p.id, target_id: 'none'}]}, [p]).acks[0].target_id, 'none');
});

test('papers fill the matching indicator; submitted work is shown as pipeline, not as done', () => {
  const p = project({targets: [{metric: 'paper_sci', count: 3}, {metric: 'paper_kci', count: 1}, {metric: 'paper_any', count: 4}]});
  const outputs = [
    output({title: 'published', status: 'published', acks: [{project_id: p.id}]}, [p]),
    output({title: 'accepted', status: 'accepted', acks: [{project_id: p.id}]}, [p]),
    output({title: 'submitted', status: 'submitted', acks: [{project_id: p.id}]}, [p]),
    output({title: 'kci', grade: 'kci', status: 'preparing', acks: [{project_id: p.id}]}, [p]),
    output({title: 'not acknowledged', acks: []}, [p]),
  ];
  const progress = projectProgress(p, outputs, on);
  // 게재 확정 is not yet an achievement: only the published paper is done.
  assert.deepEqual(row(progress, 0), [1, 2, 2, 'covered']);
  assert.deepEqual(progress.rows[0].pipeline, [{label: '게재 확정', count: 1}, {label: '투고·심사 중', count: 1}]);
  assert.equal(progress.rows[0].gap, 0);
  assert.deepEqual(row(progress, 1), [0, 1, 1, 'covered']);
  // The "all journal papers" indicator also counts the SCI papers.
  assert.deepEqual(row(progress, 2), [1, 3, 3, 'covered']);
  assert.equal(progress.linked.length, 4);
  assert.deepEqual([progress.remaining, progress.pending, progress.gap], [6, 6, 0]);
  assert.equal(progress.state, 'covered');
  assert.equal(remainingText(progress), 'SCI(E) 논문 2편 · KCI 논문 1편 · 학술지 논문 (전체) 3편 더 필요');
  const short = projectProgress(p, outputs.slice(0, 1), on);
  assert.deepEqual([short.rows[0].gap, short.gap, short.state], [2, 6, 'short']);
});

test('a patent is an application first and a registration later', () => {
  const p = project({targets: [{metric: 'patent_app', count: 2}, {metric: 'patent_reg', count: 1}]});
  const filed = output({kind: 'patent', grade: 'domestic', status: 'filed', title: '출원 특허', acks: [{project_id: p.id}]}, [p]);
  let progress = projectProgress(p, [filed], on);
  assert.deepEqual(row(progress, 0), [1, 0, 1, 'short']);
  assert.deepEqual(row(progress, 1), [0, 1, 1, 'covered']);
  progress = projectProgress(p, [{...filed, status: 'registered'}], on);
  assert.deepEqual(row(progress, 0), [1, 0, 1, 'short']);
  assert.deepEqual(row(progress, 1), [1, 0, 0, 'met']);
  progress = projectProgress(p, [{...filed, status: 'preparing'}], on);
  assert.deepEqual(row(progress, 0), [0, 1, 2, 'short']);
  assert.equal(progress.state, 'short');
});

test('yearly targets of one indicator fill the earliest deadline first', () => {
  const p = project({ends_on: '2028-12-31', targets: [
    {metric: 'paper_sci', count: 2, due_on: '2027-12-31', label: '2차년도'},
    {metric: 'paper_sci', count: 1, due_on: '2026-12-31', label: '1차년도'},
    {metric: 'paper_sci', count: 1}]});
  const paper = (title, date, status = 'published') => output({title, date, status, acks: [{project_id: p.id}]}, [p]);
  let progress = projectProgress(p, [paper('b', '2026-09-01'), paper('a', '2026-03-01')], on);
  assert.deepEqual(progress.rows.map(r => [r.label, r.done, r.remaining]), [['SCI(E) 논문 · 2차년도', 1, 1], ['SCI(E) 논문 · 1차년도', 1, 0], ['SCI(E) 논문', 0, 1]]);
  assert.deepEqual(progress.rows[1].outputs.map(item => item.output.title), ['a']);
  assert.equal(progress.next_due_on, '2027-12-31');
  assert.equal(remainingText(progress), 'SCI(E) 논문 2편 더 필요');
  // Five papers against 1 + 2 + 1: the extra one stays on the last target as over-achievement.
  progress = projectProgress(p, ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'].map((d, i) => paper('p' + i, d)), on);
  assert.deepEqual(progress.rows.map(r => [r.done, r.over, r.state]), [[2, 0, 'met'], [1, 0, 'met'], [2, 1, 'met']]);
  assert.equal(progress.state, 'met');
  assert.equal(remainingText(progress), '모든 목표를 달성했어요.');
  // Pipeline work goes to the first target that still has room.
  progress = projectProgress(p, [paper('done', '2026-01-01'), paper('s1', null, 'submitted'), paper('s2', null, 'submitted')], on);
  assert.deepEqual(progress.rows.map(r => [r.done, r.pending]), [[0, 2], [1, 0], [0, 0]]);
});

test('an explicit target ties an output to one row; "none" keeps it out of the count', () => {
  const p = project({targets: [{metric: 'paper_sci', count: 2}, {metric: 'conf_intl', count: 1}, {metric: 'custom', label: '석사 배출', count: 2}]});
  const [sci, conf, custom] = p.targets.map(t => t.id);
  const outputs = [
    // A top-tier conference paper that the programme counts as a journal paper.
    output({kind: 'conference', grade: 'intl', status: 'presented', title: 'CVPR', acks: [{project_id: p.id, target_id: sci}]}, [p]),
    output({kind: 'other', grade: '', status: 'done', title: '학위', acks: [{project_id: p.id, target_id: custom}]}, [p]),
    output({kind: 'other', grade: '', status: 'preparing', title: '학위 예정', acks: [{project_id: p.id, target_id: custom}]}, [p]),
    output({title: '집계 제외', acks: [{project_id: p.id, target_id: 'none'}]}, [p]),
    output({kind: 'software', grade: '', status: 'registered', title: '목표 외', acks: [{project_id: p.id}]}, [p]),
  ];
  const progress = projectProgress(p, outputs, on);
  assert.deepEqual(row(progress, 0), [1, 0, 1, 'short']);
  assert.deepEqual(row(progress, 1), [0, 0, 1, 'short']);
  assert.deepEqual(row(progress, 2), [1, 1, 1, 'covered']);
  assert.deepEqual(progress.excluded.map(o => o.title), ['집계 제외']);
  assert.deepEqual(progress.extra.map(o => o.title), ['목표 외']);
  assert.deepEqual(progress.rows[conf === p.targets[1].id ? 1 : 0].outputs, []);
  assert.equal(remainingText(progress), 'SCI(E) 논문 1편 · 국제 학술대회 발표 1편 · 석사 배출 1건 더 필요');
});

test('one paper acknowledging two projects counts for both and is flagged', () => {
  const a = project({name: 'A', targets: [{metric: 'paper_sci', count: 1}]}), b = project({name: 'B', ack_en: 'Supported by B.', ack_ko: 'B 지원', targets: [{metric: 'paper_sci', count: 2}]});
  const shared = output({acks: [{project_id: a.id, text: 'Custom A sentence'}, {project_id: b.id}]}, [a, b]);
  const alone = output({title: '사사 없음'}, [a, b]);
  assert.equal(projectProgress(a, [shared, alone], on).state, 'met');
  assert.deepEqual(row(projectProgress(b, [shared, alone], on), 0), [1, 0, 1, 'short']);
  assert.deepEqual(outputWarnings(shared, [a, b]).map(w => w.code), ['multi-ack']);
  assert.deepEqual(outputWarnings(alone, [a, b]).map(w => w.code), ['no-ack']);
  assert.deepEqual(ackText(shared.acks[0], a, shared), {text: 'Custom A sentence', source: 'custom', label: '이 실적에 직접 적은 문구'});
  assert.deepEqual(ackText(shared.acks[1], b, shared), {text: 'Supported by B.', source: 'standard', label: '과제 표준 문구 · 논문 · 영문'});
  assert.equal(ackText({project_id: a.id, target_id: null, text: ''}, a, shared).source, 'missing');
  // A patent uses the application wording, a domestic paper the Korean sentence.
  const c = project({name: 'C', ack_en: 'EN', ack_ko: '국문', ack_patent: '과제고유번호 1234'});
  const link = {project_id: c.id, target_id: null, text: ''};
  assert.equal(ackText(link, c, {kind: 'patent', grade: 'domestic'}).text, '과제고유번호 1234');
  assert.equal(ackText(link, c, {kind: 'paper', grade: 'kci'}).text, '국문');
  assert.equal(ackText(link, c, {kind: 'conference', grade: 'intl'}).text, 'EN');
  assert.equal(ackText(link, {...c, ack_patent: ''}, {kind: 'patent', grade: 'intl'}).label, '과제 표준 문구 · 논문 · 국문');
});

test('deadlines: missed targets, ended projects and the overview', () => {
  const late = project({name: '끝난 과제', short: '종료', ends_on: '2026-10-31', targets: [{metric: 'patent_app', count: 1}, {metric: 'software', count: 1}]});
  const active = project({name: '진행 과제', short: '진행', ends_on: '2027-02-28', targets: [{metric: 'paper_sci', count: 1, due_on: '2026-12-31'}, {metric: 'paper_sci', count: 1}],
    milestones: [{title: '연차보고서', date: '2026-12-10'}, {title: '지난 일정', date: '2026-11-01'}, {title: '끝낸 일정', date: '2026-10-01', done: true}]});
  const done = project({name: '달성 과제', ends_on: '2027-06-30', targets: [{metric: 'paper_kci', count: 1}]});
  const archived = project({name: '보관 과제', archived: true, targets: [{metric: 'paper_sci', count: 9}]});
  const projects = [late, active, done, archived];
  const outputs = [output({grade: 'kci', acks: [{project_id: done.id}]}, projects), output({title: '연결 안 됨'}, projects),
    output({status: 'submitted', acks: [{project_id: active.id}]}, projects)];
  const lateProgress = projectProgress(late, outputs, on);
  assert.deepEqual([lateProgress.phase, lateProgress.state, lateProgress.rows[0].state, lateProgress.rows[0].days], ['ended', 'missed', 'missed', -13]);
  assert.equal(projectProgress(project({starts_on: '2027-01-01'}), [], on).phase, 'upcoming');
  assert.equal(projectProgress(project(), [], on).state, 'untargeted');
  const overview = researchOverview(doc(projects, outputs), on);
  assert.deepEqual(overview.progress.map(p => p.project.name), ['진행 과제', '달성 과제', '끝난 과제']);
  assert.deepEqual(overview.counts, {projects: 2, ended: 1, archived: 1, remaining: 2, pending: 1, gap: 1, missed: 0, outputs: 3, unacknowledged: 1});
  assert.deepEqual(overview.deadlines.map(d => [d.date, d.kind, d.title]), [
    ['2026-10-31', 'target', '특허 출원 1건 · SW 등록 1건 남음'],
    ['2026-11-01', 'milestone', '지난 일정'],
    ['2026-12-10', 'milestone', '연차보고서'],
    ['2026-12-31', 'target', 'SCI(E) 논문 1편 남음'],
    ['2027-02-28', 'target', 'SCI(E) 논문 1편 남음'],
    ['2027-06-30', 'end', '과제 종료'],
  ]);
  assert.deepEqual([overview.next.date, overview.next.days], ['2026-12-10', 27]);
  assert.deepEqual(overview.overdue.map(d => d.days), [-13, -12]);
});

test('edits apply to the latest document with optimistic concurrency', () => {
  const p = project({targets: [{metric: 'paper_sci', count: 1}, {metric: 'custom', label: '기술이전', count: 1}]});
  let data = applyResearchOperation(emptyResearch(), {type: 'project_save', project: p, base: null, at});
  assert.deepEqual([data.revision, data.updated_at, data.projects.length], [1, at, 1]);
  // Retrying a save whose reply was lost changes nothing.
  assert.equal(applyResearchOperation(data, {type: 'project_save', project: p, base: null, at}).revision, 1);
  const o = output({acks: [{project_id: p.id, target_id: p.targets[1].id}]}, [p]);
  data = applyResearchOperation(data, {type: 'output_save', output: o, base: null, at});
  assert.equal(data.revision, 2);
  const later = '2026-11-02T00:00:00.000Z';
  const edited = project({targets: [p.targets[0]]}, {previous: p, at: later});
  assert.throws(() => applyResearchOperation(data, {type: 'project_save', project: edited, base: '2026-10-01T00:00:00.000Z', at: later}), /먼저 수정/);
  data = applyResearchOperation(data, {type: 'project_save', project: edited, base: p.updated_at, at: later});
  // The explicitly chosen target was removed, so the output falls back to automatic matching.
  assert.equal(data.outputs[0].acks[0].target_id, null);
  assert.throws(() => applyResearchOperation(data, {type: 'project_save', project: project({}, {previous: {...p, id: 'p-00000000-0000-4000-8000-000000000000'}}), base: at, at}), /삭제/);
  assert.throws(() => applyResearchOperation(data, {type: 'project_delete', id: p.id, base: later, at: later}), /사사한 실적이 1건/);
  assert.throws(() => applyResearchOperation(data, {type: 'output_delete', id: o.id, base: 'stale', at: later}), /먼저 수정/);
  data = applyResearchOperation(data, {type: 'output_delete', id: o.id, base: o.updated_at, at: later});
  assert.equal(applyResearchOperation(data, {type: 'output_delete', id: o.id, base: o.updated_at, at: later}).revision, data.revision);
  data = applyResearchOperation(data, {type: 'project_delete', id: p.id, base: later, at: later});
  assert.deepEqual([data.projects.length, data.outputs.length, data.revision], [0, 0, 5]);
  assert.throws(() => applyResearchOperation(data, {type: 'other', at}), /지원하지 않는/);
  assert.throws(() => validateResearch({...data, schema_version: 2}), /형식/);
  assert.throws(() => validateResearch({...emptyResearch(), projects: [p, p]}), /두 번/);
  assert.throws(() => validateResearch({...emptyResearch(), outputs: [o]}), /사사 과제/);
});

test('the gate opens only with the shared password and never stores it', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const gate = await sealGate('연구실-비밀번호', key, {iterations: 100000});
  assert.equal(validGate(gate), true);
  assert.equal(JSON.stringify(gate).includes('비밀번호'), false);
  assert.deepEqual(await openGate(gate, '연구실-비밀번호'), key);
  assert.equal(await openGate(gate, '연구실-비밀번호 '), null);
  assert.equal(await openGate(gate, ''), null);
  // The same text typed in a decomposed Unicode form is still the same password.
  assert.deepEqual(await openGate(gate, '연구실-비밀번호'.normalize('NFD')), key);
  const again = await sealGate('연구실-비밀번호', key, {iterations: 100000});
  assert.notEqual(again.salt, gate.salt);
  for (const broken of [null, {...gate, version: 2}, {...gate, iterations: 1000}, {...gate, wrapped: gate.wrapped.slice(4)}, {...gate, salt: '***'}, {...gate, key_id: 'K 1'}]) {
    assert.equal(validGate(broken), false);
    await assert.rejects(openGate(broken, 'x'), /로그인 설정/);
  }
  await assert.rejects(sealGate('', key), /password/);
  await assert.rejects(sealGate('x', new Uint8Array(16)), /key/);
  // The published gate is well formed and does not open with a wrong guess.
  assert.equal(validGate(GATE), true);
  assert.equal(await openGate(GATE, 'definitely-not-the-password'), null);
});

test('documents are sealed with a fresh nonce and reject tampering', async () => {
  const raw = crypto.getRandomValues(new Uint8Array(32)), key = await importDocumentKey(raw), context = 'cvml-workspace/research/v1';
  const value = {title: '한글 제목 · émoji 🚗', list: Array.from({length: 4000}, (_, i) => '항목 ' + i)};
  const a = await sealJSON(key, 'k1', value, context), b = await sealJSON(key, 'k1', value, context);
  assert.equal(isEnvelope(a), true);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
  assert.equal(JSON.stringify(a).includes('한글'), false);
  assert.deepEqual(await openJSON(key, 'k1', a, context), value);
  const code = promise => promise.then(() => 'opened', error => error.code);
  assert.equal(await code(openJSON(key, 'k1', {...a, data: a.data.slice(0, -8) + 'AAAAAAA='}, context)), 'open');
  assert.equal(await code(openJSON(key, 'k1', a, 'cvml-workspace/other/v1')), 'open');
  assert.equal(await code(openJSON(key, 'k2', a, context)), 'key');
  assert.equal(await code(openJSON(await importDocumentKey(crypto.getRandomValues(new Uint8Array(32))), 'k1', a, context)), 'open');
  assert.equal(await code(openJSON(key, 'k1', value, context)), 'format');
  assert.equal(isEnvelope({...a, cipher: 'none'}), false);
  const bytes = crypto.getRandomValues(new Uint8Array(65536));
  const large = new Uint8Array(300000); for (let i = 0; i < large.length; i++) large[i] = bytes[i % bytes.length];
  assert.deepEqual(fromBase64(toBase64(large)), large);
  assert.throws(() => fromBase64('not base64!'));
});

test('the research store keeps the public file sealed and retries conflicts', async () => {
  const key = await importDocumentKey(crypto.getRandomValues(new Uint8Array(32))), session = {key, keyID: 'k1'};
  const dashboard = {repository: 'shxyzn/gpu-timeline', branch: 'status', path: 'dashboard/edits.json'};
  let stored = null, sha = 0, conflicts = 0, branch = true;
  const calls = [];
  const reply = (status, body = {}) => ({ok: status >= 200 && status < 300, status, json: async () => body});
  const fetcher = async (url, options = {}) => {
    const address = new URL(url);
    calls.push([options.method || 'GET', address.hostname + address.pathname]);
    if (address.hostname === 'raw.githubusercontent.com') {
      assert.equal(address.pathname, '/shxyzn/gpu-timeline/status/' + RESEARCH_PATH);
      assert.equal(options.headers, undefined);
      return stored ? reply(200, stored) : reply(404);
    }
    assert.equal(options.headers.Authorization, 'Bearer token');
    if (address.pathname.endsWith('/git/ref/heads/status')) return branch ? reply(200, {ref: 'refs/heads/status'}) : reply(404);
    assert.equal(address.pathname, '/repos/shxyzn/gpu-timeline/contents/' + RESEARCH_PATH);
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      if (conflicts) { conflicts--; return reply(409); }
      assert.equal(body.sha, stored ? 'sha-' + sha : undefined);
      assert.equal(body.branch, 'status');
      assert.equal(body.message, 'research: update workspace records');
      stored = decodeJSON(body.content); sha++;
      return reply(200, {content: {sha: 'sha-' + sha}});
    }
    return stored ? reply(200, {type: 'file', encoding: 'base64', sha: 'sha-' + sha, content: encodeJSON(stored)}) : reply(404);
  };
  const store = new ResearchStore(dashboard, session, fetcher);
  store.client.pause = async () => {};
  assert.deepEqual(await store.readPublic(), emptyResearch());
  const p = project({name: '비공개여야 하는 과제명', number: 'RS-2026-SECRET'});
  const operation = {type: 'project_save', project: p, base: null, at};
  conflicts = 2;
  const saved = await store.save('token', operation);
  assert.equal(saved.revision, 1);
  assert.equal(calls.filter(([method]) => method === 'PUT').length, 3);
  assert.equal(isEnvelope(stored), true);
  assert.equal(JSON.stringify(stored).includes('RS-2026-SECRET'), false);
  assert.deepEqual((await store.readPublic()).projects, [p]);
  // Saving the same record again is a no-op without another write.
  const before = calls.length;
  assert.equal((await store.save('token', operation)).revision, 1);
  assert.equal(calls.slice(before).some(([method]) => method === 'PUT'), false);
  await assert.rejects(store.save('', operation), /관리자/);
  // Another browser's key cannot read the file, and a plain file is refused, never overwritten.
  const stranger = new ResearchStore(dashboard, {key: await importDocumentKey(crypto.getRandomValues(new Uint8Array(32))), keyID: 'k1'}, fetcher);
  await assert.rejects(stranger.readPublic(), /다시 로그인/);
  await assert.rejects(stranger.save('token', operation), /다시 로그인/);
  const sealed = stored;
  stored = {schema_version: 1, records: []};
  await assert.rejects(store.readPublic(), /형식/);
  await assert.rejects(store.save('token', {...operation, project: project({name: '다른 과제'})}), /형식/);
  assert.deepEqual(stored, {schema_version: 1, records: []});
  stored = sealed;
  // A missing file is a first save only when the branch itself is reachable.
  stored = null; branch = false;
  await assert.rejects(store.save('token', operation), /status 브랜치/);
  conflicts = 9; branch = true;
  await assert.rejects(store.save('token', operation), /겹쳤습니다/);
  assert.equal(store.saving, false);
});

test('a workspace session lives in the tab, or for 30 days when remembered', () => {
  const memory = () => { const items = new Map(); return {getItem: k => items.has(k) ? items.get(k) : null, setItem: (k, v) => { items.set(k, String(v)); }, removeItem: k => { items.delete(k); }, items}; };
  const original = {s: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), l: Object.getOwnPropertyDescriptor(globalThis, 'localStorage')};
  const install = (name, value) => Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
  try {
    const tab = memory(), disk = memory();
    install('sessionStorage', tab); install('localStorage', disk);
    const gate = {salt: 'salt-1', key_id: 'k1'}, key = toBase64(new Uint8Array(32)), now = Date.parse('2026-11-13T00:00:00Z');
    assert.equal(currentSession(gate, now), null);
    disk.setItem('cvml.test.login-log', '[]'); tab.setItem('cvml-gpu-timeline.test-preview.v1', 'entered');
    startSession(gate, {name: '  박\u0000상현  ', key}, now);
    assert.deepEqual(currentSession(gate, now), {name: '박 상현', key, key_id: 'k1', remembered: false});
    assert.equal(disk.items.has('cvml.workspace.session.v1'), false);
    assert.equal(lastName(), '박 상현');
    // Old flags from the previous login are cleared, and the old flag alone is not a session.
    assert.equal(disk.items.has('cvml.test.login-log'), false);
    assert.equal(tab.items.has('cvml-gpu-timeline.test-preview.v1'), false);
    assert.equal(currentSession(gate, now + 2 * 86400000), null);
    assert.equal(currentSession({salt: 'salt-2', key_id: 'k1'}, now), null);
    assert.equal(currentSession({salt: 'salt-1', key_id: 'k2'}, now), null);
    startSession(gate, {name: '상현', key, remember: true}, now);
    assert.equal(tab.items.has('cvml.workspace.session.v1'), false);
    assert.equal(currentSession(gate, now + 29 * 86400000).remembered, true);
    assert.equal(currentSession(gate, now + 31 * 86400000), null);
    endSession();
    assert.equal(currentSession(gate, now), null);
    assert.equal(lastName(), '상현');
    assert.throws(() => startSession(gate, {name: ' ', key}, now), /이름/);
    for (const text of ['{', '{"name":"x"}', JSON.stringify({name: 'x', key: 'short', key_id: 'k1', gate: 'salt-1', expires: now + 1000})]) {
      tab.setItem('cvml.workspace.session.v1', text);
      assert.equal(currentSession(gate, now), null);
    }
    // Blocked storage is an error to show, not a crash.
    install('sessionStorage', {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }});
    install('localStorage', {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }});
    assert.equal(currentSession(gate, now), null);
    assert.throws(() => startSession(gate, {name: '상현', key}, now), /저장 공간/);
    assert.equal(cleanName('a'.repeat(60)).length, 40);
  } finally {
    for (const [name, descriptor] of [['sessionStorage', original.s], ['localStorage', original.l]]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});
