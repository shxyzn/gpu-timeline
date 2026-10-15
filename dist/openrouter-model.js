// This public schema is an allowlist. Never serialize an API response or key.
export const REFRESH_MS = 60 * 60 * 1000;
export const usageFields = ['usage', 'usage_daily', 'usage_weekly', 'usage_monthly', 'limit', 'limit_remaining', 'byok_usage'];
const validDate = s => typeof s === 'string' && Number.isFinite(Date.parse(s));
const amount = n => n === null || (typeof n === 'number' && Number.isFinite(n) && n >= 0);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function normalizeUsage(data) {
  if (!data || !Number.isFinite(data.usage) || data.usage < 0) throw new Error('사용량 응답 형식을 확인할 수 없습니다.');
  const result = Object.fromEntries(usageFields.map(k => [k, amount(data[k]) ? data[k] : null]));
  result.limit_reset = ['daily','weekly','monthly'].includes(data.limit_reset) ? data.limit_reset : null;
  return result;
}
export function validatePublicToken(token) {
  const allowed = ['id','name','usage','checked_at','attempted_at','error'];
  if (!token || Object.keys(token).some(k => !allowed.includes(k)) || !/^or-[a-f0-9-]{36}$/.test(token.id || '') ||
      typeof token.name !== 'string' || !token.name.trim() || token.name.length > 100 ||
      !validDate(token.checked_at) || !validDate(token.attempted_at) ||
      ![null,'unauthorized','rate_limit','unavailable'].includes(token.error) ||
      ![...usageFields,'limit_reset'].every(k => token.usage?.[k] === normalizeUsage(token.usage)[k]) ||
      Object.keys(token.usage).some(k => ![...usageFields,'limit_reset'].includes(k))) {
    throw new Error('OpenRouter 공유 기록 형식이 올바르지 않습니다.');
  }
  return token;
}
export function applyTokenOperation(original, op) {
  const tokens = structuredClone(original);
  if (op.type === 'token_add') {
    const entry = validatePublicToken(op.entry), previous = tokens.find(t => t.id === entry.id);
    if (previous) { if (!same(previous,entry)) throw new Error('같은 키 기록이 변경됐습니다. 새로고침해 주세요.'); return tokens; }
    if (tokens.some(t => t.name === entry.name)) throw new Error('같은 token 이름이 있습니다. 기존 카드의 연결 버튼을 사용하거나 다른 이름을 입력하세요.');
    tokens.push(entry);
  } else if (op.type === 'token_remove') {
    return tokens.filter(t => t.id !== op.id);
  } else if (op.type === 'token_refresh') {
    for (const update of op.entries) {
      const index = tokens.findIndex(t => t.id === update.id);
      if (index < 0) continue; // Never resurrect a key removed during a query.
      if (!validDate(update.attempted_at)) throw new Error('조회 시각이 올바르지 않습니다.');
      if (Date.parse(update.attempted_at) <= Date.parse(tokens[index].attempted_at)) continue;
      const previous = tokens[index];
      // Only known fields can cross into the public file, even on errors.
      tokens[index] = validatePublicToken({...previous, attempted_at: update.attempted_at, error: update.error,
        ...(update.error === null ? {usage: normalizeUsage(update.usage), checked_at: update.checked_at} : {})});
    }
  } else throw new Error('지원하지 않는 OpenRouter 요청입니다.');
  return tokens;
}
export function dueForRefresh(token, now = Date.now()) {
  return !token || now - Date.parse(token.attempted_at) >= REFRESH_MS;
}
export function usageStatus(token, now = Date.now()) {
  if (token.error || now - Date.parse(token.checked_at) > REFRESH_MS * 1.5 || Date.parse(token.checked_at) > now + 300000) return '마지막 조회값';
  return '조회 완료';
}
export function dollars(value) {
  return typeof value === 'number' && Number.isFinite(value) ? '$' + value.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:4}) : '—';
}
export async function queryUsage(key, fetcher = globalThis.fetch) {
  let response;
  try {
    response = await fetcher('https://openrouter.ai/api/v1/key', {
      method:'GET', headers:{Authorization:`Bearer ${key}`}, credentials:'omit',
      redirect:'error', cache:'no-store', signal:AbortSignal.timeout(15000),
    });
  } catch { throw Object.assign(new Error('OpenRouter 연결을 확인해 주세요.'), {code:'unavailable'}); }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 429 ? 'rate_limit' : 'unavailable';
    const message = {unauthorized:'토큰이 올바르지 않거나 만료되었습니다.', rate_limit:'조회 제한입니다. 잠시 뒤 다시 시도하세요.', unavailable:'OpenRouter 사용량을 조회하지 못했습니다.'}[code];
    throw Object.assign(new Error(message), {code});
  }
  try { return normalizeUsage((await response.json()).data); }
  catch { throw Object.assign(new Error('OpenRouter 사용량 응답을 확인할 수 없습니다.'), {code:'unavailable'}); }
}
