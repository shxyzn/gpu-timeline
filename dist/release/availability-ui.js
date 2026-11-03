export const escapeAvailability=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function repairPanel(serverID,{compact=false,history=true}={}){
  return `<div class="as-cover${compact?' as-cover-compact':''}"><div class="as-panel"><span class="as-pause" aria-hidden="true">Ⅱ</span><div class="as-copy"><span class="as-eyebrow">장비 수리 · A/S 중</span><strong>사용 일시 중단</strong><small>복귀 일정 미정 · 기존 기록 유지</small></div>${history?`<button type="button" class="as-history-button" data-as-history="${escapeAvailability(serverID)}">이전 실험 보기</button>`:''}</div></div>`;
}
