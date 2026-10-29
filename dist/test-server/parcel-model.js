// Test-server only. The unauthenticated v1 API is a limited trial integration.
// https://tracker.delivery/docs/api-versioning/v1
export const carriers = [
  {id:'kr.cjlogistics',name:'CJ대한통운',url:'https://www.cjlogistics.com/ko/tool/parcel/newTracking',parameter:'gnbInvcNo'},
  {id:'kr.epost',name:'우체국택배',url:'https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm',parameter:'sid1'},
  {id:'kr.hanjin',name:'한진택배',url:'https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillSch.do?mCode=MN038'},
  {id:'kr.lotte',name:'롯데택배',url:'https://www.lotteglogis.com/home/reservation/tracking/index'},
  {id:'kr.logen',name:'로젠택배',url:'https://www.ilogen.com/web/personal/tkSearch'},
  {id:'kr.kdexp',name:'경동택배',url:'https://kdexp.com/service/delivery/etc/delivery.do',parameter:'barcode'},
];
export const stages = [
  ['information_received','상품 준비'],['at_pickup','집화 완료'],['in_transit','이동 중'],['out_for_delivery','배송 출발'],['delivered','배송 완료'],
];
const labels = Object.fromEntries(stages);
labels.unknown='상태 확인 필요';
const text = value => typeof value==='string'?value.slice(0,1500):'';
export function trackingQuery(carrierId,input) {
  const carrier=carriers.find(item=>item.id===carrierId);
  if(!carrier)throw new Error('택배사를 선택해 주세요.');
  const number=String(input??'').normalize('NFKC').replace(/[\s\-‐‑‒–—]/g,'');
  if(!/^\d{8,20}$/.test(number)||/^(\d)\1+$/.test(number))throw new Error('운송장 번호를 확인해 주세요. 공백·하이픈을 제외한 숫자 8~20자리를 입력하세요.');
  const url=new URL(carrier.url);
  if(carrier.parameter)url.searchParams.set(carrier.parameter,number);
  return {carrier,number,official:url.href,endpoint:`https://apis.tracker.delivery/carriers/${carrier.id}/tracks/${number}`};
}
export class TrackingError extends Error {
  constructor(code,message){super(message);this.name='TrackingError';this.code=code;}
}
export function normalizeTrack(data,query) {
  if(!data||typeof data!=='object'||Array.isArray(data))throw new TrackingError('response','조회 응답을 확인하지 못했어요. 공식 조회를 이용해 주세요.');
  if(data.carrier?.id&&data.carrier.id!==query.carrier.id)throw new TrackingError('response','요청한 택배사와 조회 결과가 달라요. 공식 조회를 이용해 주세요.');
  const events=(Array.isArray(data.progresses)?data.progresses:[]).filter(item=>item&&typeof item==='object').map(item=>{
    const parsed=typeof item.time==='string'&&item.time.trim()?Date.parse(item.time):NaN;
    return {at:Number.isFinite(parsed)?parsed:null,code:text(item.status?.id),status:text(item.status?.text)||labels[item.status?.id]||'상태 확인 필요',location:text(item.location?.name),description:text(item.description)};
  }).filter(item=>item.code||item.location||item.description);
  // Newest first. Entries without a usable timestamp stay at the end.
  events.sort((a,b)=>(b.at??-Infinity)-(a.at??-Infinity));
  const code=text(data.state?.id)||events[0]?.code||'unknown';
  const status=text(data.state?.text)||labels[code]||'상태 확인 필요';
  if(!events.length&&!data.state?.id&&!data.state?.text)throw new TrackingError('not-found','아직 배송 정보가 없어요. 택배사와 번호를 확인하거나 접수 후 다시 조회해 주세요.');
  return {code,status,stage:stages.findIndex(item=>item[0]===code),events};
}
export async function fetchTrack(query,{signal,fetcher=globalThis.fetch,timeout=15000}={}) {
  const controller=new AbortController();
  let timedOut=false;
  const abort=()=>controller.abort();
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
  try {
    const response=await fetcher(query.endpoint,{signal:controller.signal,credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
    if(response.status===404)throw new TrackingError('not-found','아직 배송 정보가 없어요. 택배사와 번호를 확인하거나 접수 후 다시 조회해 주세요.');
    if(response.status===429)throw new TrackingError('rate-limit','조회 요청이 많아 잠시 제한됐어요. 잠시 후 다시 시도하거나 공식 조회를 이용해 주세요.');
    if(response.status===401||response.status===403||response.status===410)throw new TrackingError('unavailable','시험 조회 서비스가 현재 제한돼 있어요. 택배사 공식 조회를 이용해 주세요.');
    if(!response.ok)throw new TrackingError('unavailable','배송 조회 서비스에 연결하지 못했어요. 잠시 후 다시 시도하거나 공식 조회를 이용해 주세요.');
    let data;
    try {data=await response.json();}catch {throw new TrackingError('response','조회 응답을 확인하지 못했어요. 공식 조회를 이용해 주세요.');}
    if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
    return normalizeTrack(data,query);
  } catch(error) {
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    if(timedOut)throw new TrackingError('timeout','응답이 늦어 조회를 멈췄어요. 다시 시도하거나 공식 조회를 이용해 주세요.');
    if(error instanceof TrackingError)throw error;
    throw new TrackingError('network','네트워크 또는 조회 서비스 연결을 확인해 주세요. 공식 조회도 이용할 수 있어요.');
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
