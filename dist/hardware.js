const DAY = 86400000;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(new Date(value));
export const priceFeed = 'https://raw.githubusercontent.com/shxyzn/gpu-timeline/hardware-prices/prices.json';
export function priceState(product, quote, now = Date.now()) {
  const checked = Date.parse(quote?.checked_at);
  const valid = quote?.pcode === product.pcode && Number.isFinite(checked) && checked <= now + 300000;
  const stale = !valid || now - checked > 2 * DAY || Boolean(quote.fetch_error);
  const priced = valid && quote.availability === 'available' && Number.isSafeInteger(quote.price_krw) && quote.price_krw > 0;
  return {
    price: priced ? new Intl.NumberFormat('ko-KR').format(quote.price_krw) + '원' : valid && quote.availability === 'unavailable' ? '판매 가격 없음' : '가격 확인 필요',
    label: priced ? stale ? '마지막 확인 가격' : '확인 최저가' : valid && quote.availability === 'unavailable' ? '단종·판매 중단 등' : '다나와에서 확인',
    checked: valid ? date(checked) + ' 확인' : '확인 기록 없음', stale,
  };
}
export function renderHardware(catalog, snapshot, now = Date.now()) {
  const quotes = new Map((Array.isArray(snapshot?.products) ? snapshot.products : []).map(p => [p.id, p]));
  return catalog.groups.map(group => `<article class="hardware-card hardware-${escape(group.id)}" aria-labelledby="hardware-${escape(group.id)}-title">
    <div class="hardware-card-heading"><span class="hardware-symbol" aria-hidden="true">${group.id === 'cpu' ? 'C' : group.id === 'gpu' ? 'G' : 'M'}</span><div><h3 id="hardware-${escape(group.id)}-title">${escape(group.name)}</h3><p>${escape(group.description)}</p></div></div>
    <ul class="hardware-products">${catalog.products.filter(p => p.group === group.id).map(product => {
      const state = priceState(product, quotes.get(product.id), now);
      const url = /^\d+$/.test(product.pcode) ? 'https://prod.danawa.com/info/?pcode=' + product.pcode : 'https://www.danawa.com/';
      return `<li><a class="hardware-product" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="${escape(product.name)} · ${escape(product.variant)} 다나와 가격비교 새 창">
        <div class="hardware-product-title"><strong>${escape(product.name)}</strong><span aria-hidden="true">↗</span></div>
        <p class="hardware-spec">${escape(product.spec)}</p><p class="hardware-variant">${escape(product.variant)}</p>
        <div class="hardware-price-line ${state.stale ? 'price-stale' : ''}"><small>${state.label}</small><b>${state.price}</b></div>
        <p class="hardware-checked">${state.checked}${state.stale ? ' · 갱신 확인 필요' : ''}</p>
      </a></li>`;
    }).join('')}</ul>
  </article>`).join('');
}
export async function loadHardware(readJSON) {
  const board = document.getElementById('hardware-grid'), status = document.getElementById('hardware-status');
  try {
    const [catalog, seed] = await Promise.all([readJSON('./hardware-products.json'), readJSON('./hardware-prices.json').catch(() => null)]);
    board.innerHTML = renderHardware(catalog, seed);
    try {
      const live = await readJSON(priceFeed);
      if (live.schema_version !== 1 || !Array.isArray(live.products) || !Number.isFinite(Date.parse(live.attempted_at))) throw new Error('invalid feed');
      // A cached feed must not replace more recent, reviewed bundled prices.
      const snapshot = Date.parse(live.attempted_at) >= (Date.parse(seed?.attempted_at) || 0) ? live : seed;
      board.innerHTML = renderHardware(catalog, snapshot);
      const errors = snapshot.products.filter(p => p.fetch_error).length;
      status.textContent = errors ? `${errors}개 제품 갱신 지연 · 마지막 확인 정보 표시` : '매일 오전 9시경 가격 확인 · 한국시간';
    } catch { status.textContent = '가격 갱신 연결 확인 필요 · 저장된 확인 정보 표시'; }
  } catch {
    status.textContent = '부품 목록을 불러오지 못했어요.';
    board.innerHTML = '<p class="hardware-empty"><a href="https://www.danawa.com/" target="_blank" rel="noopener noreferrer">다나와에서 부품 가격 확인 ↗</a></p>';
  }
}
