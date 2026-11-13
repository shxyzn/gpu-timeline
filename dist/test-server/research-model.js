// Research-project tracker: document shape, validation, edits and the counting rules.
// Pure functions only. Calendar dates are plain YYYY-MM-DD strings read as Asia/Seoul days.
export const DAY = 86400000;
export const LIMITS = Object.freeze({projects: 100, outputs: 2000, targets: 30, milestones: 40, acks: 8, bytes: 300000});

// What an output can be, the states it moves through, and the states that count as achieved
// when a target does not say otherwise. A paper counts once it is published and a talk once it
// is given: 게재 확정 and 발표 확정 stay "in progress", which is the careful reading for a
// report. To count them as achieved, add 'accepted' to the two `achieved` lists below.
export const OUTPUT_KINDS = Object.freeze({
  paper: {label: '논문', unit: '편', grades: {sci: 'SCI(E)', scopus: 'SCOPUS', kci: 'KCI', other: '기타 학술지'},
    statuses: ['preparing', 'submitted', 'accepted', 'published'], achieved: ['published'],
    dateLabel: '게재(예정)일', venueLabel: '학술지', identifierLabel: 'DOI'},
  conference: {label: '학술대회', unit: '편', grades: {intl: '국제', domestic: '국내'},
    statuses: ['preparing', 'submitted', 'accepted', 'presented'], achieved: ['presented'],
    dateLabel: '발표(예정)일', venueLabel: '학술대회', identifierLabel: 'DOI'},
  patent: {label: '특허', unit: '건', grades: {domestic: '국내', intl: '국외'},
    statuses: ['preparing', 'filed', 'registered'], achieved: ['filed', 'registered'],
    dateLabel: '출원·등록일', venueLabel: '출원국·기관', identifierLabel: '출원·등록번호'},
  software: {label: 'SW 등록', unit: '건', grades: {},
    statuses: ['preparing', 'registered'], achieved: ['registered'],
    dateLabel: '등록일', venueLabel: '등록 기관', identifierLabel: '등록번호'},
  other: {label: '기타 성과', unit: '건', grades: {},
    statuses: ['preparing', 'done'], achieved: ['done'],
    dateLabel: '완료일', venueLabel: '구분', identifierLabel: '식별 번호'},
});
export const STATUS_LABELS = Object.freeze({preparing: '준비 중', submitted: '투고·심사 중', accepted: '게재 확정', published: '게재 완료',
  presented: '발표 완료', filed: '출원', registered: '등록', done: '완료'});
export const statusLabel = output => output.kind === 'conference' && output.status === 'accepted' ? '발표 확정'
  : output.kind === 'conference' && output.status === 'submitted' ? '제출·심사 중' : STATUS_LABELS[output.status] || output.status;

// A target row names one indicator. `accepts` decides which outputs fill it automatically;
// `achieved` overrides the kind's default when the indicator needs a later state.
export const METRICS = Object.freeze({
  paper_sci: {label: 'SCI(E) 논문', unit: '편', accepts: o => o.kind === 'paper' && o.grade === 'sci'},
  paper_scopus: {label: 'SCOPUS 논문', unit: '편', accepts: o => o.kind === 'paper' && o.grade === 'scopus'},
  paper_kci: {label: 'KCI 논문', unit: '편', accepts: o => o.kind === 'paper' && o.grade === 'kci'},
  paper_any: {label: '학술지 논문 (전체)', unit: '편', accepts: o => o.kind === 'paper'},
  conf_intl: {label: '국제 학술대회 발표', unit: '편', accepts: o => o.kind === 'conference' && o.grade === 'intl'},
  conf_domestic: {label: '국내 학술대회 발표', unit: '편', accepts: o => o.kind === 'conference' && o.grade === 'domestic'},
  patent_app: {label: '특허 출원', unit: '건', accepts: o => o.kind === 'patent', achieved: ['filed', 'registered']},
  patent_reg: {label: '특허 등록', unit: '건', accepts: o => o.kind === 'patent', achieved: ['registered']},
  software: {label: 'SW 등록', unit: '건', accepts: o => o.kind === 'software'},
  custom: {label: '직접 입력', unit: '건', accepts: () => false},
});

export const emptyResearch = () => ({schema_version: 1, revision: 0, updated_at: null, projects: [], outputs: []});
export const newID = prefix => `${prefix}-${crypto.randomUUID()}`;

const text = (value, max, min = 0) => typeof value === 'string' && value.length >= min && value.length <= max;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}-[a-f0-9-]{36}$`).test(value);
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(value + 'T00:00:00Z');
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value;
}
const optionalDate = value => value === null || validDate(value);
const link = value => value === '' || (text(value, 500, 8) && /^https?:\/\/[^\s<>"']+$/i.test(value));

export class ResearchError extends Error {}
const fail = message => { throw new ResearchError(message); };

// "SCI(E) 논문 · 2차년도": the indicator, then the optional name that tells yearly rows apart.
export function targetLabel(target) {
  const metric = METRICS[target.metric]?.label || '목표';
  return target.metric === 'custom' ? target.label || metric : target.label ? `${metric} · ${target.label}` : metric;
}
const groupLabel = target => target.metric === 'custom' ? target.label : METRICS[target.metric].label;
export const targetUnit = target => target.metric === 'custom' ? (target.unit || '건') : METRICS[target.metric].unit;

function checkProject(p) {
  if (!p || typeof p !== 'object' || !id(p.id, 'p')) fail('과제 기록 형식이 올바르지 않아요.');
  if (!text(p.name, 160, 1) || p.name.trim() !== p.name) fail('과제명을 입력해 주세요. (160자 이내)');
  if (!text(p.short, 24) || !text(p.agency, 120) || !text(p.number, 60) || !text(p.note, 1000)) fail('과제 정보가 너무 길어요.');
  if (!text(p.ack_ko, 1200) || !text(p.ack_en, 1200) || !text(p.ack_patent, 1200)) fail('사사문구는 1,200자 이내로 입력해 주세요.');
  if (!optionalDate(p.starts_on) || !validDate(p.ends_on)) fail('과제 종료일을 입력해 주세요.');
  if (p.starts_on && p.starts_on > p.ends_on) fail('과제 시작일은 종료일보다 앞서야 해요.');
  if (typeof p.archived !== 'boolean' || !time(p.created_at) || !time(p.updated_at) || !text(p.updated_by, 40)) fail('과제 기록 형식이 올바르지 않아요.');
  if (!Array.isArray(p.targets) || p.targets.length > LIMITS.targets) fail(`목표는 과제당 ${LIMITS.targets}개까지 등록할 수 있어요.`);
  const seen = new Set();
  for (const t of p.targets) {
    if (!t || !id(t.id, 't') || seen.has(t.id) || !Object.hasOwn(METRICS, t.metric)) fail('목표 형식이 올바르지 않아요.');
    seen.add(t.id);
    if (!text(t.label, 60) || !text(t.unit, 8) || !text(t.note, 200)) fail('목표 이름이 너무 길어요.');
    if (t.metric === 'custom' && !t.label.trim()) fail('직접 입력한 목표에는 이름이 필요해요.');
    if (!Number.isSafeInteger(t.count) || t.count < 1 || t.count > 999) fail('목표 수는 1 이상 999 이하의 숫자로 입력해 주세요.');
    if (!optionalDate(t.due_on)) fail('목표 기한의 날짜를 확인해 주세요.');
  }
  if (!Array.isArray(p.milestones) || p.milestones.length > LIMITS.milestones) fail(`일정은 과제당 ${LIMITS.milestones}개까지 등록할 수 있어요.`);
  seen.clear();
  for (const m of p.milestones) {
    if (!m || !id(m.id, 'm') || seen.has(m.id) || !text(m.title, 80, 1) || !validDate(m.date) || typeof m.done !== 'boolean') fail('일정의 이름과 날짜를 확인해 주세요.');
    seen.add(m.id);
  }
}

function checkOutput(o, projects) {
  const kind = o && OUTPUT_KINDS[o.kind];
  if (!o || typeof o !== 'object' || !id(o.id, 'o') || !kind) fail('실적 기록 형식이 올바르지 않아요.');
  if (!text(o.title, 300, 1) || o.title.trim() !== o.title) fail('실적 제목을 입력해 주세요. (300자 이내)');
  if (Object.keys(kind.grades).length ? !Object.hasOwn(kind.grades, o.grade) : o.grade !== '') fail('실적 구분을 선택해 주세요.');
  if (!kind.statuses.includes(o.status)) fail('실적 상태를 선택해 주세요.');
  if (!text(o.authors, 300) || !text(o.venue, 160) || !text(o.identifier, 120) || !text(o.note, 1000)) fail('실적 정보가 너무 길어요.');
  if (!link(o.link)) fail('링크는 http:// 또는 https://로 시작하는 주소로 입력해 주세요.');
  if (!optionalDate(o.date)) fail('실적 날짜를 확인해 주세요.');
  if (!time(o.created_at) || !time(o.updated_at) || !text(o.updated_by, 40)) fail('실적 기록 형식이 올바르지 않아요.');
  if (!Array.isArray(o.acks) || o.acks.length > LIMITS.acks) fail(`한 실적에 사사 과제는 ${LIMITS.acks}개까지 연결할 수 있어요.`);
  const seen = new Set();
  for (const a of o.acks) {
    const project = a && projects.get(a.project_id);
    if (!a || !project || seen.has(a.project_id)) fail('사사 과제 연결을 확인해 주세요.');
    seen.add(a.project_id);
    if (!(a.target_id === null || a.target_id === 'none' || project.targets.some(t => t.id === a.target_id))) fail('실적을 반영할 목표를 다시 선택해 주세요.');
    if (!text(a.text, 1200)) fail('사사문구는 1,200자 이내로 입력해 주세요.');
  }
}

export function validateResearch(doc) {
  if (!doc || doc.schema_version !== 1 || !Number.isSafeInteger(doc.revision) || doc.revision < 0 ||
      !(doc.updated_at === null || time(doc.updated_at)) || !Array.isArray(doc.projects) || !Array.isArray(doc.outputs)) {
    fail('연구과제 문서 형식이 올바르지 않아요. 원본을 확인해 주세요.');
  }
  if (doc.projects.length > LIMITS.projects) fail(`과제는 ${LIMITS.projects}개까지 등록할 수 있어요.`);
  if (doc.outputs.length > LIMITS.outputs) fail(`실적은 ${LIMITS.outputs}개까지 등록할 수 있어요.`);
  const projects = new Map();
  for (const p of doc.projects) {
    checkProject(p);
    if (projects.has(p.id)) fail('같은 과제가 두 번 저장돼 있어요.');
    projects.set(p.id, p);
  }
  const outputs = new Set();
  for (const o of doc.outputs) {
    checkOutput(o, projects);
    if (outputs.has(o.id)) fail('같은 실적이 두 번 저장돼 있어요.');
    outputs.add(o.id);
  }
  if (new TextEncoder().encode(JSON.stringify(doc)).length > LIMITS.bytes) fail('연구과제 문서가 저장 한도에 도달했어요. 오래된 기록을 정리해 주세요.');
  return doc;
}

const clean = value => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
const oneLine = value => clean(value).replace(/\s+/g, ' ');
const dateOrNull = value => value ? String(value) : null;

// Form input -> stored record. `previous` keeps identifiers and creation time on an edit.
export function makeProject(input, {by, at = new Date().toISOString(), previous = null} = {}) {
  const project = {
    id: previous?.id || newID('p'), name: oneLine(input.name), short: oneLine(input.short), agency: oneLine(input.agency),
    number: oneLine(input.number), starts_on: dateOrNull(input.starts_on), ends_on: dateOrNull(input.ends_on) || '',
    ack_ko: clean(input.ack_ko), ack_en: clean(input.ack_en), ack_patent: clean(input.ack_patent),
    targets: (input.targets || []).map(t => ({id: t.id || newID('t'), metric: t.metric, label: oneLine(t.label), unit: t.metric === 'custom' ? oneLine(t.unit) : '',
      count: Number(t.count), due_on: dateOrNull(t.due_on), note: oneLine(t.note)})),
    milestones: (input.milestones || []).map(m => ({id: m.id || newID('m'), title: oneLine(m.title), date: String(m.date || ''), done: !!m.done})),
    note: clean(input.note), archived: !!input.archived,
    created_at: previous?.created_at || at, updated_at: at, updated_by: oneLine(by).slice(0, 40),
  };
  if (!project.name) fail('과제명을 입력해 주세요.');
  if (!project.ends_on) fail('과제 종료일을 입력해 주세요.');
  checkProject(project);
  return project;
}

export function makeOutput(input, projects, {by, at = new Date().toISOString(), previous = null} = {}) {
  const kind = OUTPUT_KINDS[input.kind];
  if (!kind) fail('실적 종류를 선택해 주세요.');
  const output = {
    id: previous?.id || newID('o'), kind: input.kind, grade: Object.keys(kind.grades).length ? String(input.grade || '') : '',
    title: oneLine(input.title), authors: oneLine(input.authors), venue: oneLine(input.venue), status: input.status,
    date: dateOrNull(input.date), identifier: oneLine(input.identifier), link: oneLine(input.link),
    acks: (input.acks || []).map(a => ({project_id: a.project_id, target_id: a.target_id || null, text: clean(a.text)})),
    note: clean(input.note), created_at: previous?.created_at || at, updated_at: at, updated_by: oneLine(by).slice(0, 40),
  };
  if (!output.title) fail('실적 제목을 입력해 주세요.');
  checkOutput(output, new Map(projects.map(p => [p.id, p])));
  return output;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stale = '다른 사람이 먼저 수정했어요. 창을 닫고 최신 내용을 확인한 뒤 다시 저장해 주세요.';

// One edit applied to the latest document. `base` is the updated_at the editor started from
// (null for a new record); a different value means someone else saved in between.
export function applyResearchOperation(original, operation) {
  const doc = structuredClone(validateResearch(original));
  const collection = operation.type.startsWith('project') ? doc.projects : doc.outputs;
  if (operation.type === 'project_save' || operation.type === 'output_save') {
    const record = operation.type === 'project_save' ? operation.project : operation.output;
    const index = collection.findIndex(item => item.id === record.id);
    if (index < 0) {
      if (operation.base !== null) fail('수정하려던 기록이 삭제됐어요. 목록을 새로고침해 주세요.');
      collection.push(record);
    } else {
      // A retried request whose first response was lost must not fail or duplicate.
      if (same(collection[index], record)) return doc;
      if (collection[index].updated_at !== operation.base) fail(stale);
      collection[index] = record;
    }
    if (operation.type === 'project_save') {
      // A removed target can no longer be chosen explicitly; fall back to automatic matching.
      const targets = new Set(record.targets.map(t => t.id));
      for (const output of doc.outputs) for (const ack of output.acks) {
        if (ack.project_id === record.id && ack.target_id && ack.target_id !== 'none' && !targets.has(ack.target_id)) ack.target_id = null;
      }
    }
  } else if (operation.type === 'project_delete' || operation.type === 'output_delete') {
    const index = collection.findIndex(item => item.id === operation.id);
    if (index < 0) return doc;
    if (collection[index].updated_at !== operation.base) fail(stale);
    if (operation.type === 'project_delete') {
      const linked = doc.outputs.filter(o => o.acks.some(a => a.project_id === operation.id)).length;
      if (linked) fail(`이 과제를 사사한 실적이 ${linked}건 있어요. 과제를 보관하거나, 실적의 사사 연결을 먼저 정리해 주세요.`);
    }
    collection.splice(index, 1);
  } else {
    fail('지원하지 않는 편집 요청이에요.');
  }
  doc.revision++;
  doc.updated_at = operation.at;
  return validateResearch(doc);
}

// ---- Counting -------------------------------------------------------------------------------

export function today(now = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Seoul'}).format(now);
}
export const daysUntil = (date, from) => Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY);
export function ddayLabel(days) {
  return days === 0 ? 'D-DAY' : days > 0 ? `D-${days}` : `D+${-days}`;
}

function achievedBy(output, target) {
  const states = METRICS[target.metric].achieved;
  const kind = OUTPUT_KINDS[output.kind];
  // A patent target names its own stage; anything else uses the output kind's own finish line.
  return (states && states.some(s => kind.statuses.includes(s)) ? states : kind.achieved).includes(output.status);
}
const byDate = (a, b) => (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31') || a.created_at.localeCompare(b.created_at);

// Rows of one project with the outputs that fill them.
// - An output counts for a project only through an acknowledgement (사사) link to it.
// - Without an explicit choice it fills every indicator it matches (a patent is both an
//   application and, later, a registration). Among several targets of the same indicator
//   (yearly targets) the earliest deadline is filled first; anything beyond the last target's
//   number stays on that last row as over-achievement.
// - An explicit choice ties the output to that one row only; 'none' keeps it out of the count.
export function projectProgress(project, outputs, on = today()) {
  const rows = project.targets.map((target, index) => ({target, index, due_on: target.due_on || project.ends_on,
    done: [], pending: [], explicit: 0}));
  const byID = new Map(rows.map(row => [row.target.id, row]));
  const linked = [], extra = [], excluded = [];
  const auto = new Map();
  for (const output of [...outputs].sort(byDate)) {
    const ack = output.acks.find(a => a.project_id === project.id);
    if (!ack) continue;
    linked.push(output);
    if (ack.target_id === 'none') { excluded.push(output); continue; }
    const row = ack.target_id ? byID.get(ack.target_id) : null;
    if (row) { (achievedBy(output, row.target) ? row.done : row.pending).push(output); row.explicit++; continue; }
    const metrics = [...new Set(rows.filter(r => METRICS[r.target.metric].accepts(output)).map(r => r.target.metric))];
    if (!metrics.length) { extra.push(output); continue; }
    for (const metric of metrics) { if (!auto.has(metric)) auto.set(metric, []); auto.get(metric).push(output); }
  }
  for (const [metric, list] of auto) {
    const group = rows.filter(r => r.target.metric === metric).sort((a, b) => a.due_on.localeCompare(b.due_on) || a.index - b.index);
    const place = (output, key) => {
      const row = group.find(r => r.done.length + (key === 'pending' ? r.pending.length : 0) < r.target.count) || group[group.length - 1];
      row[key].push(output);
    };
    const sample = group[0].target;
    for (const output of list.filter(o => achievedBy(o, sample))) place(output, 'done');
    for (const output of list.filter(o => !achievedBy(o, sample))) place(output, 'pending');
  }
  const result = rows.map(row => {
    const done = row.done.length, pending = row.pending.length, remaining = Math.max(0, row.target.count - done);
    const days = daysUntil(row.due_on, on);
    // "게재 확정 1 · 투고·심사 중 1": what is on the way, the most advanced stage first.
    const stages = new Map();
    for (const output of [...row.pending].sort((a, b) => OUTPUT_KINDS[b.kind].statuses.indexOf(b.status) - OUTPUT_KINDS[a.kind].statuses.indexOf(a.status))) {
      stages.set(statusLabel(output), (stages.get(statusLabel(output)) || 0) + 1);
    }
    return {target: row.target, label: targetLabel(row.target), unit: targetUnit(row.target), count: row.target.count,
      done, pending, remaining, over: Math.max(0, done - row.target.count), due_on: row.due_on, days,
      gap: Math.max(0, remaining - pending), pipeline: [...stages].map(([label, count]) => ({label, count})),
      state: remaining === 0 ? 'met' : days < 0 ? 'missed' : remaining <= pending ? 'covered' : 'short',
      outputs: [...row.done.map(output => ({output, achieved: true})), ...row.pending.map(output => ({output, achieved: false}))]};
  });
  const open = result.filter(row => row.remaining > 0);
  const ended = daysUntil(project.ends_on, on) < 0;
  const next = open.length ? open.reduce((a, b) => a.due_on <= b.due_on ? a : b) : null;
  return {project, rows: result, linked, extra, excluded,
    remaining: open.reduce((sum, row) => sum + row.remaining, 0),
    pending: result.reduce((sum, row) => sum + Math.min(row.pending, row.remaining), 0),
    gap: result.reduce((sum, row) => sum + row.gap, 0),
    next_due_on: next?.due_on || null, next_days: next ? next.days : null,
    days: daysUntil(project.ends_on, on), ended,
    phase: project.starts_on && project.starts_on > on ? 'upcoming' : ended ? 'ended' : 'active',
    state: !result.length ? 'untargeted' : !open.length ? 'met' : open.some(row => row.state === 'missed') ? 'missed'
      : open.every(row => row.state === 'covered') ? 'covered' : 'short'};
}

// "SCI(E) 논문 3편 · 특허 출원 1건": what is still owed, yearly rows of one indicator added up.
export function remainingItems(rows) {
  const items = new Map();
  for (const row of rows) {
    if (row.remaining <= 0) continue;
    const key = groupLabel(row.target) + '\u0000' + row.unit;
    items.set(key, {label: groupLabel(row.target), unit: row.unit, count: (items.get(key)?.count || 0) + row.remaining});
  }
  return [...items.values()];
}
export function remainingText(progress, limit = 5) {
  if (!progress.rows.length) return '목표 실적이 아직 등록되지 않았어요.';
  const items = remainingItems(progress.rows);
  if (!items.length) return '모든 목표를 달성했어요.';
  return items.slice(0, limit).map(item => `${item.label} ${item.count}${item.unit}`).join(' · ') +
    (items.length > limit ? ` 외 ${items.length - limit}개 지표` : '') + ' 더 필요';
}

export function outputWarnings(output, projects) {
  const warnings = [];
  const live = output.acks.filter(a => projects.some(p => p.id === a.project_id));
  if (!live.length) warnings.push({code: 'no-ack', label: '사사 과제 미지정'});
  if (live.length > 1) warnings.push({code: 'multi-ack', label: `중복 사사 ${live.length}개 과제`});
  return warnings;
}

export const ACK_LABELS = Object.freeze({ack_en: '논문 · 영문', ack_ko: '논문 · 국문', ack_patent: '특허 출원서 표기'});
// The acknowledgement text that applies to one link: what was actually written when that was
// recorded, otherwise the project's standard text for this kind of output (a patent uses the
// 출원서 표기, a domestic paper the Korean sentence, anything else the English one).
export function ackText(ack, project, output) {
  if (ack.text) return {text: ack.text, source: 'custom', label: '이 실적에 직접 적은 문구'};
  const order = output?.kind === 'patent' ? ['ack_patent', 'ack_ko', 'ack_en']
    : output?.grade === 'kci' || output?.grade === 'domestic' ? ['ack_ko', 'ack_en'] : ['ack_en', 'ack_ko'];
  const field = order.find(name => project[name]);
  return field ? {text: project[field], source: 'standard', label: '과제 표준 문구 · ' + ACK_LABELS[field]} : {text: '', source: 'missing', label: '사사문구 미등록'};
}

export function researchOverview(doc, on = today()) {
  const active = doc.projects.filter(p => !p.archived);
  const progress = active.map(p => projectProgress(p, doc.outputs, on))
    .sort((a, b) => (a.phase === 'ended') - (b.phase === 'ended') || (a.next_due_on || a.project.ends_on).localeCompare(b.next_due_on || b.project.ends_on) || a.project.name.localeCompare(b.project.name, 'ko'));
  const running = progress.filter(p => p.phase !== 'ended');
  // One entry per project and date: everything still owed by that day, then dated milestones.
  const deadlines = [];
  for (const p of progress) {
    const dates = [...new Set(p.rows.filter(row => row.remaining > 0).map(row => row.due_on))];
    for (const date of dates) {
      const items = remainingItems(p.rows.filter(row => row.due_on === date));
      deadlines.push({kind: 'target', project: p.project, date, days: daysUntil(date, on),
        title: items.map(item => `${item.label} ${item.count}${item.unit}`).join(' · ') + ' 남음'});
    }
    for (const m of p.project.milestones) if (!m.done) deadlines.push({kind: 'milestone', project: p.project, date: m.date, days: daysUntil(m.date, on), title: m.title});
    if (!dates.includes(p.project.ends_on) && !p.ended) deadlines.push({kind: 'end', project: p.project, date: p.project.ends_on, days: p.days, title: '과제 종료'});
  }
  const order = {milestone: 0, target: 1, end: 2};
  deadlines.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || a.project.name.localeCompare(b.project.name, 'ko'));
  const unacknowledged = doc.outputs.filter(o => !o.acks.some(a => doc.projects.some(p => p.id === a.project_id)));
  return {progress, deadlines,
    counts: {projects: running.length, ended: progress.length - running.length, archived: doc.projects.length - active.length,
      remaining: running.reduce((sum, p) => sum + p.remaining, 0), pending: running.reduce((sum, p) => sum + p.pending, 0),
      gap: running.reduce((sum, p) => sum + p.gap, 0),
      missed: running.filter(p => p.state === 'missed').length, outputs: doc.outputs.length, unacknowledged: unacknowledged.length},
    next: deadlines.find(d => d.days >= 0) || null, overdue: deadlines.filter(d => d.days < 0)};
}
