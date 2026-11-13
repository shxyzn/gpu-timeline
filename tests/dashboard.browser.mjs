// All GitHub requests are intercepted. This test never writes to the real repo.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {emptyEdits, encodeJSON, decodeJSON} from '../dist/edits.js';
import {resourceFixture} from './resources-fixture.mjs';
import {emptyMonitoring} from '../dist/test-server/monitoring-model.js';
import {emptyHistory,mergeSamples,samplesFromTokens,DAY} from '../dist/test-server/api-usage-model.js';
import {sealGate,importDocumentKey,sealJSON,openJSON,isEnvelope} from '../dist/test-server/workspace-crypto.js';
import {makeProject,makeOutput,validateResearch} from '../dist/test-server/research-model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A preinstalled Playwright can be used instead of node_modules by naming its folder.
const runtime = process.env.GPU_TIMELINE_NODE_MODULES || process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const {chromium} = await import(runtime ? pathToFileURL(path.join(runtime, 'playwright/index.mjs')).href : 'playwright');
const output = process.env.GPU_TIMELINE_SCREENSHOTS || '/tmp/gpu-timeline-browser';
await fs.mkdir(output, {recursive: true});
// The release films are rendered in CI and are not committed. GPU_TIMELINE_SKIP_FILMS=1 lets a
// local run without them skip only the decode checks; CI must always run them.
const skipFilms = process.env.GPU_TIMELINE_SKIP_FILMS === '1';
if (skipFilms && process.env.GITHUB_ACTIONS === 'true') throw new Error('GPU_TIMELINE_SKIP_FILMS is for local runs only');
const host = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const legacy=pathname==='/__legacy.html';
    const filename = legacy ? path.join(root,'tests/fixtures/dashboard-v120.html') : path.resolve(root, 'dist', `.${pathname.endsWith('/') ? pathname+'index.html' : pathname}`);
    if (!legacy && !filename.startsWith(path.join(root, 'dist') + path.sep)) throw new Error('path');
    const bytes = await fs.readFile(filename);
    const types = {'.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.mp4': 'video/mp4', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'};
    const headers = {'Content-Type': types[path.extname(filename)] || 'text/plain', 'Accept-Ranges': 'bytes'};
    // Match static hosting: media seeking requires byte ranges and known lengths.
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start=Number(range[1]), end=range[2] ? Math.min(Number(range[2]),bytes.length-1) : bytes.length-1;
      if (start>end || start>=bytes.length) {
        response.writeHead(416,{'Content-Range':`bytes */${bytes.length}`}).end();
      } else {
        response.writeHead(206,{...headers,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${bytes.length}`}).end(bytes.subarray(start,end+1));
      }
    } else {
      response.writeHead(200,{...headers,'Content-Length':bytes.length}).end(bytes);
    }
  } catch { response.writeHead(404).end('not found'); }
});
await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
let browser, page;
try {
  browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env.GPU_TIMELINE_CHROMIUM ? {executablePath: process.env.GPU_TIMELINE_CHROMIUM} : {})});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, timezoneId: 'America/Los_Angeles'});
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const now = new Date(), iso = hours => new Date(now.getTime() + hours * 3600000).toISOString();
  let data = emptyEdits(), staleRaw = false, failRaw = false, forbidden = false, writes = 0;
  let collectorFinished = false, progressCompleted = 25, serverUpgraded = false, serverCStale = false;
  let resourceEnabled = false, resourceFailed = false, testAPI = false, previewMode = false;
  let monitoringData=emptyMonitoring(),monitoringWrites=0,monitoringForbidden=false,monitoringApplied=false,monitoringProfile='test',monitoringReportProfile=null;
  const monitoringProfiles={test:emptyMonitoring(),production:emptyMonitoring()};
  const usageHistories={test:emptyHistory(),production:emptyHistory()};
  const usageProfile=pathname=>pathname.endsWith('/dashboard/openrouter-usage-test.json')?'test':pathname.endsWith('/dashboard/openrouter-usage.json')?'production':null;
  let usageHistoryWrites=0,usageHistoryReads=0,usageHistoryForbidden=false,usageHistoryUnavailable=false;
  // The test server's login gate and sealed research document use a throwaway password and key
  // here, so the real shared password never has to appear in this file.
  const workspacePassword='browser-test-workspace',workspaceKeyBytes=crypto.getRandomValues(new Uint8Array(32));
  const workspaceGate=await sealGate(workspacePassword,workspaceKeyBytes,{iterations:100000});
  const workspaceKey=await importDocumentKey(workspaceKeyBytes),researchContext='cvml-workspace/research/v1';
  let researchDoc=null,researchSealed=null,researchWrites=0,researchForbidden=false,researchUnavailable=false;
  const sealResearch=async doc=>{researchDoc=doc;researchSealed=await sealJSON(workspaceKey,workspaceGate.key_id,doc,researchContext);};
  const telemetry = id => ({server_id: id, name: `Server ${id.slice(-1).toUpperCase()}`, updated_at: iso(id === 'server-c' && serverCStale ? -2 : 0), collector_ok: true,
    resources: resourceEnabled && id !== 'server-c' ? resourceFixture(Date.now(),resourceFailed) : undefined,
    monitoring: monitoringApplied&&id==='server-b'?{profile:monitoringReportProfile||monitoringProfile,enabled:true,applied_revision:monitoringData.servers.find(c=>c.server_id===id)?.revision||0,applied_at:iso(0),config_error:null,schedules:[],history:[{name:'일반 점검',finished_at:iso(0),status:'warning',checks:[{id:'gpu_count',status:'warning',summary:'인식 1 / 설정 2 GPU'}]}]}:undefined,
    agent_version: id === 'server-b' ? {version: '1.1.2', revision: 'b'.repeat(40)} : id === 'server-a' && serverUpgraded ? {version: '1.1.5', revision: 'a'.repeat(40)} : null,
    gpus: [{uuid: `${id}-gpu`, index: 0, name: 'NVIDIA GeForce RTX 4090', process_count: 0, utilization: previewMode && id === 'server-a' ? 86 : 0,
      memory_used_mib: previewMode && id === 'server-a' ? 21000 : 0, memory_total_mib: 24564},
      ...(previewMode && id === 'server-b' ? [{uuid:`${id}-gpu-1`,index:1,name:'NVIDIA GeForce RTX 4090',process_count:0,utilization:0,memory_used_mib:0,memory_total_mib:24564}] : [])],
    jobs: id === 'server-a' ? [{id: 'job-original', name: previewMode ? 'exp46 · AIME · 8B GEPA · 정답 2회 연속 시 진짜 AIME 문제로 교체 · 8B 검증 · seed0' : 'GEPA collector', owner: '상현', gpu_uuids: [`${id}-gpu`],
      started_at: iso(-2), expected_end_at: iso(2), eta_source: 'progress',
      progress: {completed: progressCompleted, total: 100, updated_at: iso(0)},
      ended_at: collectorFinished ? iso(0) : null, status: collectorFinished ? 'completed' : 'running'}] : id === 'server-b' && testAPI ? [{id:'api-live',name:'API current <script> test',owner:'상현',resource_type:'api',api_slot:0,gpu_uuids:[],started_at:iso(-1),expected_end_at:iso(2),status:'running',progress:{completed:25,total:100,updated_at:iso(0)}}] : []});
  const fulfill = (route, body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
  await context.route('https://fonts.gstatic.com/**', route => route.abort());
  let staleControllerRequests=0;
  // Model an immutable cached v2.1 controller that has no history-recorder export.
  for(const cachedVersion of ['2.1-test-monitor','2.1-formal'])await context.route(`**/app.js?v=${cachedVersion}`,async route=>{
    staleControllerRequests++;
    const source=await fs.readFile(path.join(root,'dist/app.js'),'utf8');
    const previous=source.replace(/^export function save(?:Test)?APIUsageHistory\(\)\{[^\n]*\}\n/gm,'');
    return route.fulfill({body:previous,contentType:'text/javascript'});
  });
  await context.route('**/version.json*', route => fulfill(route, {version: '1.1.5', revision: 'a'.repeat(40)}));
  await context.route('**/test-server/gate.js*', route => route.fulfill({contentType: 'text/javascript', body: `export const GATE=Object.freeze(${JSON.stringify(workspaceGate)});`}));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.route('**/config.json*', async route => {
    const config = JSON.parse(await fs.readFile(path.join(root, 'dist/config.json'), 'utf8'));
    config.servers[2].actions = [{title: '서버 C 점검 <script>', description: '이 서버에서만 보이는 안내', command: 'echo \"점검 & 확인\"'}];
    return fulfill(route, config);
  });
  await context.route('https://raw.githubusercontent.com/**', async route => {
    const url = new URL(route.request().url());
    const historyProfile=usageProfile(url.pathname);
    if(historyProfile){assert.equal(historyProfile,monitoringProfile,'read only the current history profile');usageHistoryReads++;assert.equal(route.request().headers().authorization,undefined);return fulfill(route,usageHistoryUnavailable?{}:usageHistories[historyProfile],usageHistoryUnavailable?503:200);}
    if (url.pathname.endsWith('/hardware-prices/prices.json')) return fulfill(route, JSON.parse(await fs.readFile(path.join(root, 'dist/hardware-prices.json'), 'utf8')));
    if(/\/dashboard\/monitoring(?:-test)?\.json$/.test(url.pathname))return fulfill(route,monitoringProfiles[url.pathname.endsWith('monitoring-test.json')?'test':'production']);
    if(url.pathname.endsWith('/dashboard/research-test.json')){
      assert.equal(route.request().headers().authorization,undefined);
      if(researchUnavailable)return fulfill(route,{},503);
      return researchSealed?fulfill(route,researchSealed):fulfill(route,{},404);
    }
    if (url.pathname.endsWith('/dashboard/edits.json')) {
      assert.equal(route.request().headers().authorization, undefined);
      if (failRaw) return fulfill(route, {}, 503);
      return fulfill(route, staleRaw ? emptyEdits() : data);
    }
    const match = url.pathname.match(/servers\/(server-[abcd])\.json$/);
    assert.ok(match, url.pathname);
    // A newly registered server has no telemetry until its first real upload.
    if (match[1] === 'server-d') return fulfill(route, {}, 404);
    return fulfill(route, telemetry(match[1]));
  });
  await context.route('https://api.github.com/**', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(request.headers().authorization, 'Bearer test-browser-only-token');
    if (url.pathname === '/user') return fulfill(route, {login: 'cvml-admin'});
    if (url.pathname === '/repos/shxyzn/gpu-timeline') return fulfill(route, {permissions: {push: true}});
    if (url.pathname.endsWith('/git/ref/heads/status')) return fulfill(route, {ref: 'refs/heads/status'});
    const historyProfile=usageProfile(url.pathname);
    if(historyProfile){
      assert.equal(historyProfile,monitoringProfile,'write only the current history profile');
      const usageHistory=usageHistories[historyProfile];
      if(request.method()==='PUT'){
        if(usageHistoryForbidden)return fulfill(route,{},403);
        const body=request.postDataJSON();assert.equal(body.branch,'status');assert.equal(body.sha,'usage-'+usageHistory.revision);
        const next=decodeJSON(body.content);assert.equal(JSON.stringify(next).includes(fakeKey),false);usageHistories[historyProfile]=next;usageHistoryWrites++;return fulfill(route,{content:{sha:'usage-'+next.revision}});
      }
      return fulfill(route,{type:'file',encoding:'base64',sha:'usage-'+usageHistory.revision,content:encodeJSON(usageHistory)});
    }
    if(/\/contents\/dashboard\/monitoring(?:-test)?\.json$/.test(url.pathname)){
      const profile=url.pathname.endsWith('monitoring-test.json')?'test':'production';
      assert.equal(profile,monitoringProfile,'each dashboard must save only its own monitoring profile');
      if(request.method()==='PUT'){
        if(monitoringForbidden)return fulfill(route,{},403);
        const body=request.postDataJSON();assert.equal(body.branch,'status');assert.equal(body.sha,'monitor-'+monitoringData.revision);
        monitoringData=decodeJSON(body.content);monitoringProfiles[profile]=monitoringData;monitoringWrites++;return fulfill(route,{content:{sha:'monitor-'+monitoringData.revision}});
      }
      return fulfill(route,{type:'file',encoding:'base64',sha:'monitor-'+monitoringData.revision,content:encodeJSON(monitoringData)});
    }
    if(url.pathname.endsWith('/contents/dashboard/research-test.json')){
      if(request.method()==='PUT'){
        if(researchForbidden)return fulfill(route,{},403);
        const body=request.postDataJSON();assert.equal(body.branch,'status');assert.equal(body.message,'research: update workspace records');
        assert.equal(body.sha,researchSealed?'research-'+researchDoc.revision:undefined);
        const sealed=decodeJSON(body.content);assert.equal(isEnvelope(sealed),true,'research records must be stored sealed');
        researchDoc=await openJSON(workspaceKey,workspaceGate.key_id,sealed,researchContext);researchSealed=sealed;researchWrites++;
        return fulfill(route,{content:{sha:'research-'+researchDoc.revision}});
      }
      return researchSealed?fulfill(route,{type:'file',encoding:'base64',sha:'research-'+researchDoc.revision,content:encodeJSON(researchSealed)}):fulfill(route,{},404);
    }
    assert.ok(url.pathname.endsWith('/contents/dashboard/edits.json'), url.pathname);
    if (request.method() === 'PUT') {
      if (forbidden) return fulfill(route, {}, 403);
      const body = request.postDataJSON();
      assert.equal(body.branch, 'status');
      assert.equal(body.sha, `sha-${data.revision}`);
      data = decodeJSON(body.content);
      writes++;
      return fulfill(route, {content: {sha: `sha-${data.revision}`}});
    }
    return fulfill(route, {type: 'file', encoding: 'base64', sha: `sha-${data.revision}`, content: encodeJSON(data)});
  });
  let openRouterCalls = 0, openRouterFail = false;
  const fakeKey = 'test-openrouter-never-real';
  await context.route('https://openrouter.ai/**', route => {
    assert.equal(route.request().url(), 'https://openrouter.ai/api/v1/key');
    assert.equal(route.request().method(), 'GET');
    assert.equal(route.request().headers().authorization, `Bearer ${fakeKey}`);
    openRouterCalls++;
    return fulfill(route, openRouterFail ? {error:{message:fakeKey}} : {data:{usage:12.34,usage_daily:1.23,usage_weekly:4.56,usage_monthly:12.34,limit:50,limit_remaining:37.66,limit_reset:'monthly',label:fakeKey}}, openRouterFail ? 401 : 200);
  });
  const base = `http://127.0.0.1:${host.address().port}`;
  // The browser is in Los Angeles; the calendar must still follow Korean days.
  // Freeze only this page so the existing live-time editor fixtures stay intact.
  const calendarPage = await context.newPage();
  await calendarPage.addInitScript(() => { Date.now = () => Date.parse('2026-10-03T01:00:00Z'); });
  await calendarPage.goto(base+'/__legacy.html');
  await calendarPage.locator('.priority-tabs button[tabindex="0"]').waitFor();
  await calendarPage.locator('#tab-timeline').click();
  const nationalDay = calendarPage.locator('.tick.holiday[title="10/3 (토) · 개천절"]').first();
  await nationalDay.waitFor();
  assert.equal(await nationalDay.locator('.tick-weekday').evaluate(e => getComputedStyle(e).color), 'rgb(182, 75, 84)');
  assert.equal(await nationalDay.locator('strong').evaluate(e => getComputedStyle(e).color), 'rgb(182, 75, 84)');
  assert.match(await calendarPage.locator('#calendar-note').innerText(), /10\/5 대체공휴일 · 개천절/);
  await calendarPage.setViewportSize({width: 390, height: 844});
  assert.ok(await calendarPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await calendarPage.screenshot({path: path.join(output, 'holidays-mobile.png'), fullPage: true});
  await calendarPage.close();
  await page.goto(base+'/__legacy.html');
  await page.locator('.priority-tabs button[tabindex="0"]').waitFor();
  await page.locator('#tab-more').click();
  await page.locator('.hardware-product').first().waitFor();
  assert.equal(await page.locator('.hardware-card').count(), 3);
  assert.equal(await page.locator('.hardware-product').count(), 44);
  assert.ok(await page.locator('#hardware').evaluate(e => Boolean(e.compareDocumentPosition(document.getElementById('usage')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  assert.match(await page.locator('.hardware-gpu').innerText(), /판매 가격 없음/);
  assert.equal(await page.locator('.hardware-product').first().getAttribute('href'), 'https://prod.danawa.com/info/?pcode=63140417');
  for (const [group, count] of [['cpu',16], ['gpu',16], ['memory',12]]) {
    const list = page.locator(`[data-hardware-group=${group}]`);
    assert.equal(await list.locator('li').count(), count);
    assert.ok(await list.evaluate(e => e.scrollHeight > e.clientHeight && e.clientHeight === 520));
    const bounds = await list.boundingBox();
    const third = await list.locator('li').nth(2).boundingBox();
    assert.ok(third.y < bounds.y + bounds.height);
  }
  const cpuList = page.locator('[data-hardware-group=cpu]');
  await cpuList.focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => { const e = document.querySelector('[data-hardware-group=cpu]'); return Math.abs(e.scrollHeight - e.clientHeight - e.scrollTop) < 2; });
  assert.equal(await page.locator('[data-hardware-group=gpu]').evaluate(e => e.scrollTop), 0);
  const scrollBefore = await cpuList.evaluate(e => { e.scrollTop = 850; return e.scrollTop; });
  await page.evaluate(async () => {
    const {loadHardware} = await import('./hardware.js');
    await loadHardware(async url => { const r = await fetch(url); if (!r.ok) throw new Error('fetch'); return r.json(); });
  });
  // Chromium can round the tail of a native keyboard scroll by one CSS pixel.
  assert.ok(Math.abs(await cpuList.evaluate(e => e.scrollTop) - scrollBefore) <= 1, 'price refresh preserves the scroll position within one CSS pixel');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.hardwareGroup), 'cpu');
  await cpuList.evaluate(e => { e.scrollTop = 0; });
  await page.locator('#hardware').screenshot({path:path.join(output, 'hardware-desktop.png')});
  await page.setViewportSize({width:390, height:844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.locator('[data-hardware-group=gpu]').evaluate(e => e.scrollHeight > e.clientHeight && e.clientHeight === 520));
  await page.locator('#hardware').screenshot({path:path.join(output, 'hardware-mobile.png')});
  await page.setViewportSize({width:1440, height:1000});
  await page.locator('#tab-timeline').click();
  await page.locator('#timeline [data-job="job-original"]').waitFor();
  assert.equal(await page.locator('[data-manage-server]').count(), 0);
  await page.locator('#admin-login').click();
  await page.locator('#admin-password').fill('cvml-test');
  await page.locator('#admin-password-confirm').fill('cvml-test');
  await page.locator('#admin-token').fill('test-browser-only-token');
  await page.locator('#admin-submit').click();
  await page.waitForFunction(() => !document.getElementById('admin-tools').hidden || document.getElementById('admin-error').textContent);
  assert.equal(await page.locator('#admin-error').innerText(), '');
  await page.locator('#admin-tools').waitFor();
  assert.equal(await page.locator('#admin-dialog').evaluate(e => e.open), false);
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  assert.equal(storage.includes('test-browser-only-token'), false);
  assert.equal(storage.includes('cvml-test'), false);

  // Server management is visible only after login; viewing/copying writes nothing.
  assert.equal(await page.locator('[data-manage-server]').count(), 4);
  assert.equal(await page.locator('#deployment-version').count(), 0);
  assert.match(await page.locator('#dashboard-version').innerText(), /v1\.1\.5\+aaaaaaa/);
  assert.match(await page.locator('.server-version').nth(0).innerText(), /v1\.0\.0/);
  assert.match(await page.locator('.server-version').nth(1).innerText(), /v1\.1\.2\+bbbbbbb/);
  await page.locator('#tab-servers').click();
  await page.locator('[data-manage-server=server-a]').click();
  assert.equal(await page.locator('#server-manage-installed').innerText(), 'v1.0.0');
  assert.match(await page.locator('#server-manage-source').innerText(), /관리자 지정/);
  const upgradeCommand = await page.locator('#server-update-command').innerText();
  assert.ok(upgradeCommand.includes("'server-a'"));
  assert.ok(upgradeCommand.includes("'" + 'a'.repeat(40) + "'"));
  assert.equal(upgradeCommand.includes('--server-id'), false);
  await page.locator('[data-copy-server-command=server-update-command]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), upgradeCommand);
  await page.locator('.server-update > summary').click();
  await page.locator('#server-manage-refresh').click();
  await page.waitForFunction(() => !document.getElementById('server-manage-refresh').disabled);
  assert.equal(await page.locator('.server-update').evaluate(e => e.open), false);
  serverUpgraded = true;
  await page.locator('#server-manage-refresh').click();
  await page.waitForFunction(() => document.getElementById('server-manage-installed').textContent === 'v1.1.5+aaaaaaa (latest)');
  assert.equal(await page.locator('#server-update-command').count(), 0);
  assert.match(await page.locator('#server-manage-source').innerText(), /수집기/);
  await page.locator('#server-manage-close').click();
  await page.locator('[data-manage-server=server-b]').click();
  assert.match(await page.locator('.server-action-overview').innerText(), /gputl update --gpus/);
  await page.locator('#server-manage-close').click();
  serverCStale = true;
  await page.locator('#tab-timeline').click();
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  await page.locator('#tab-servers').click();
  await page.locator('[data-manage-server=server-c]').click();
  assert.equal(await page.locator('#server-manage-health').innerText(), '갱신 지연');
  assert.equal(await page.locator('#server-inspect-command').isVisible(), true);
  assert.match(await page.locator('#server-update-command').innerText(), /'server-c'/);
  assert.match(await page.locator('#server-manage-body').innerText(), /서버 C 점검 <script>/);
  assert.equal(await page.locator('#server-manage-body script').count(), 0);
  const customCommand = await page.locator('#server-custom-0').innerText();
  await page.locator('[data-copy-server-command=server-custom-0]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), customCommand);
  await page.setViewportSize({width: 390, height: 844});
  assert.ok(await page.locator('#server-manage-dialog').evaluate(e => e.scrollWidth <= e.clientWidth));
  await page.screenshot({path: path.join(output, 'server-management-mobile.png')});
  await page.setViewportSize({width: 1440, height: 1000});
  await page.screenshot({path: path.join(output, 'server-management-desktop.png')});
  // Logout must also close a management dialog even when it is currently open.
  await page.evaluate(() => document.getElementById('admin-logout').click());
  assert.equal(await page.locator('#server-manage-dialog').evaluate(e => e.open), false);
  assert.equal(await page.locator('[data-manage-server]').count(), 0);
  assert.equal(writes, 0);
  serverCStale = false;
  await page.locator('#tab-timeline').click();
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  await page.locator('#admin-login').click();
  await page.locator('#admin-password').fill('cvml-test');
  await page.locator('#admin-submit').click();
  await page.locator('#admin-tools').waitFor();

  await page.locator('#manual-add').click();
  await page.locator('#manual-name').fill('Qwen3 · 수동 실험 <script> 🧪');
  await page.locator('#manual-owner').fill('상현');
  await page.locator('#manual-server').selectOption('server-b');
  await page.locator('#manual-gpus input').check();
  const start = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 16); // 1h ago in KST
  await page.locator('#manual-start').fill(start);
  await page.screenshot({path: path.join(output, 'add-desktop.png')});
  await page.locator('#manual-form button[type=submit]').click();
  await page.locator('.job-bar.manual').waitFor();
  assert.equal(data.manual_jobs.length, 1);
  assert.equal(data.manual_jobs[0].started_at, new Date(`${start}+09:00`).toISOString());
  assert.equal(data.manual_jobs[0].expected_end_at, null);
  // Manual records do not claim to measure GPU occupancy.
  assert.match(await page.locator('#overview .stat').nth(1).innerText(), /1/);
  assert.match(await page.locator('#overview .stat').nth(2).innerText(), /2/);

  await page.locator('#timeline [data-job="job-original"]').click();
  await page.locator('[data-delete-experiment]').click();
  await page.locator('#delete-form button[type=submit]').click();
  await page.locator('#delete-dialog').waitFor({state: 'hidden'});
  assert.equal(data.hidden_jobs.length, 1);
  assert.equal(await page.locator('#timeline [data-job="job-original"]').count(), 0);
  assert.match(await page.locator('#overview .stat').nth(1).innerText(), /1/);

  staleRaw = true;
  await page.locator('#tab-timeline').click();
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  assert.equal(await page.locator('#timeline [data-job="job-original"]').count(), 0);
  assert.equal(await page.locator('.job-bar.manual').count(), 1);
  failRaw = true;
  await page.locator('#tab-timeline').click();
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  assert.match(await page.locator('#edit-notice').innerText(), /수신 실패/);
  assert.equal(await page.locator('#timeline [data-job="job-original"]').count(), 0);
  failRaw = false; staleRaw = false;

  // A separate visitor immediately sees shared edits without credentials.
  const visitor = await context.newPage();
  await visitor.goto(base+'/__legacy.html');
  await visitor.locator('.priority-tabs button[tabindex="0"]').waitFor();
  await visitor.locator('#tab-timeline').click();
  await visitor.locator('.job-bar.manual').waitFor();
  assert.equal(await visitor.locator('#timeline [data-job="job-original"]').count(), 0);
  assert.equal(await visitor.locator('#admin-tools').isVisible(), false);
  await visitor.close();

  await page.locator('#record-list').click();
  await page.locator('[data-record-action=restore]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-record-action=restore]').length === 0);
  assert.equal(data.hidden_jobs.length, 0);
  await page.locator('[data-close-dialog=records-dialog]').click();
  assert.equal(await page.locator('#timeline [data-job="job-original"]').count(), 1);

  // Denied writes must remain visible as errors with no optimistic removal.
  forbidden = true;
  await page.locator('#timeline [data-job="job-original"]').click();
  await page.locator('[data-delete-experiment]').click();
  await page.locator('#delete-form button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('delete-error').textContent.includes('권한'));
  assert.equal(data.hidden_jobs.length, 0);
  assert.equal(await page.locator('#timeline [data-job="job-original"]').count(), 1);
  await page.locator('[data-close-dialog=delete-dialog]').first().click();
  await page.locator('#close-detail').click();
  forbidden = false;

  await page.locator('#admin-logout').click();
  await page.locator('#admin-login').click();
  assert.equal(await page.locator('#admin-setup').isVisible(), false);
  await page.locator('#admin-password').fill('incorrect');
  await page.locator('#admin-submit').click();
  await page.waitForFunction(() => document.getElementById('admin-error').textContent.includes('비밀번호'));
  assert.equal(await page.locator('#admin-tools').isVisible(), false);
  await page.locator('#admin-password').fill('cvml-test');
  await page.locator('#admin-submit').click();
  await page.locator('#admin-tools').waitFor();
  await page.screenshot({path: path.join(output, 'dashboard-desktop.png'), fullPage: true});
  await page.reload();
  await page.locator('.job-bar.manual').waitFor();
  assert.equal(await page.locator('#admin-tools').isVisible(), false);
  await page.locator('#admin-login').click();
  await page.locator('#admin-password').fill('cvml-test');
  await page.locator('#admin-submit').click();
  await page.locator('#admin-tools').waitFor();
  // Edit an existing manual experiment without creating a second identity.
  const manualID = data.manual_jobs[0].id, createdAt = data.manual_jobs[0].created_at;
  await page.locator('.job-bar.manual').click();
  await page.locator('[data-edit-experiment]').click();
  assert.equal(await page.locator('#manual-server').isDisabled(), true);
  assert.equal(await page.locator('#manual-status').isDisabled(), false);
  await page.locator('#manual-name').fill('수정한 GEPA');
  await page.locator('#manual-description').fill('완료 확인');
  await page.locator('#manual-status').selectOption('completed');
  await page.locator('#manual-ended').fill(new Date(now.getTime() + 6 * 3600000).toISOString().slice(0, 16));
  await page.locator('#manual-submit').click();
  await page.waitForFunction(() => document.getElementById('manual-error').textContent.includes('시작시간 이후'));
  assert.equal(data.manual_jobs[0].status, 'running');
  await page.locator('#manual-ended').fill(new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 16));
  await page.locator('#manual-submit').click();
  await page.locator('#manual-dialog').waitFor({state: 'hidden'});
  assert.equal(data.manual_jobs.length, 1);
  assert.equal(data.manual_jobs[0].id, manualID);
  assert.equal(data.manual_jobs[0].created_at, createdAt);
  assert.equal(data.manual_jobs[0].status, 'completed');
  assert.equal(data.manual_jobs[0].description, '완료 확인');
  await page.locator('#close-detail').click();

  // Metadata-only collector edit must not freeze ETA, truncate seconds, or
  // replace automatically reported status/GPU/progress with a form snapshot.
  await page.locator('#timeline [data-job="job-original"]').click();
  await page.locator('[data-edit-experiment]').click();
  assert.equal(await page.locator('#manual-status').isDisabled(), true);
  assert.equal(await page.locator('#manual-gpus input').isDisabled(), true);
  await page.locator('#manual-name').fill('수집 실험 이름 수정');
  await page.locator('#manual-submit').click();
  await page.locator('#manual-dialog').waitFor({state: 'hidden'});
  assert.deepEqual(data.job_overrides[0].fields, {name: '수집 실험 이름 수정'});
  await page.locator('[data-edit-experiment]').click();
  const newETA = new Date(now.getTime() + 10 * 3600000).toISOString().slice(0, 16);
  await page.locator('#manual-end').fill(newETA);
  await page.screenshot({path: path.join(output, 'edit-collector-desktop.png')});
  await page.locator('#manual-submit').click();
  await page.locator('#manual-dialog').waitFor({state: 'hidden'});
  assert.equal(data.job_overrides[0].fields.expected_end_at, new Date(`${newETA}+09:00`).toISOString());
  await page.locator('#close-detail').click();
  collectorFinished = true; progressCompleted = 100;
  await page.locator('#tab-timeline').click();
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  await page.locator('#timeline [data-job="job-original"]').click();
  const detail = await page.locator('#job-detail').innerText();
  assert.match(detail, /수집 실험 이름 수정/);
  assert.match(detail, /완료/);
  assert.match(detail, /100 \/ 100/);
  await page.locator('[data-edit-experiment]').click();
  assert.equal(await page.locator('#manual-status').inputValue(), 'completed');
  assert.equal(await page.locator('#manual-start').inputValue(), new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 16));
  await page.locator('#manual-ended').fill(new Date(now.getTime() + 8.5 * 3600000).toISOString().slice(0, 16));
  await page.locator('#manual-submit').click();
  await page.locator('#manual-dialog').waitFor({state: 'hidden'});
  assert.ok(data.job_overrides[0].fields.ended_at);
  await page.locator('[data-edit-experiment]').click();
  const beforeNoop = writes;
  await page.locator('#manual-submit').click();
  await page.locator('#manual-dialog').waitFor({state: 'hidden'});
  assert.equal(writes, beforeNoop);
  await page.locator('[data-edit-experiment]').click();
  await page.locator('#manual-reset').click();
  await page.locator('#manual-dialog').waitFor({state: 'hidden'});
  assert.equal(data.job_overrides.length, 0);
  assert.match(await page.locator('#job-detail').innerText(), /GEPA collector/);
  await page.locator('#close-detail').click();
  await page.locator('#record-list').click();
  await page.locator('[data-record-action=edit]').click();
  assert.equal(await page.locator('#manual-name').inputValue(), '수정한 GEPA');
  await page.locator('[data-close-dialog=manual-dialog]').first().click();
  await page.locator('[data-close-dialog=records-dialog]').click();
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#manual-add').click();
  assert.ok(await page.locator('#manual-dialog').evaluate(e => e.scrollWidth <= e.clientWidth));
  await page.screenshot({path: path.join(output, 'add-mobile.png')});
  await page.locator('[data-close-dialog=manual-dialog]').first().click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: path.join(output, 'dashboard-mobile.png'), fullPage: true});
  assert.deepEqual(errors, []);
  assert.equal(writes, 8);
  // API resource form uses no physical GPU and retains the same experiment ID.
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#manual-add').click();
  await page.locator('#manual-name').fill('API evaluation');
  await page.locator('#manual-resource').selectOption('api');
  await page.locator('#manual-server').selectOption('server-c');
  assert.equal(await page.locator('#manual-gpu-fieldset').isVisible(),false);
  await page.locator('#manual-start').fill(new Date(now.getTime()+8*3600000).toISOString().slice(0,16));
  await page.locator('#manual-submit').click();
  await page.locator('#manual-dialog').waitFor({state:'hidden'});
  const apiJob = data.manual_jobs.find(j=>j.name==='API evaluation');
  assert.equal(apiJob.api_slot,0);assert.deepEqual(apiJob.gpu_uuids,[]);
  await page.locator('.api-lane .job-bar').waitFor();
  assert.match(await page.locator('.api-lane .gpu-num').innerText(),/API 0/);
  assert.match(await page.locator('#overview .stat').first().innerText(),/3/);
  await page.locator('.api-lane .job-bar').click();
  assert.match(await page.locator('#job-detail').innerText(),/API 0 · 외부 API/);
  await page.locator('#close-detail').click();
  // API keys go only to OpenRouter; GitHub receives strictly numeric summaries.
  await page.locator('#tab-resources').click();
  await page.locator('#openrouter-add').click();
  await page.locator('#openrouter-name').fill('연구실 공용');
  await page.locator('#openrouter-key').fill(fakeKey);
  await page.locator('#openrouter-submit').click();
  await page.locator('#openrouter-dialog').waitFor({state:'hidden'});
  assert.equal(data.openrouter_tokens.length,1);
  assert.equal(JSON.stringify(data).includes(fakeKey),false);
  assert.equal(await page.evaluate(k=>JSON.stringify(localStorage).includes(k),fakeKey),false);
  assert.equal(await page.locator('#openrouter-key').inputValue(),'');
  assert.match(await page.locator('.openrouter-card').innerText(),/\$12.34/);
  const checked = data.openrouter_tokens[0].checked_at;
  openRouterFail=true;
  await page.locator('[data-token-action=refresh]').click();
  await page.waitForFunction(()=>document.getElementById('openrouter-feedback').textContent.includes('실패'));
  assert.equal(data.openrouter_tokens[0].checked_at,checked);
  assert.equal(data.openrouter_tokens[0].error,'unauthorized');
  assert.equal(JSON.stringify(data).includes(fakeKey),false);
  assert.match(await page.locator('.openrouter-card').innerText(),/마지막 조회값/);
  openRouterFail=false;
  await page.locator('[data-token-action=refresh]').click();
  await page.waitForFunction(()=>document.getElementById('openrouter-feedback').textContent.includes('갱신했어요'));
  await page.locator('#openrouter').scrollIntoViewIfNeeded();
  const usagePercent=Number(await page.locator('.openrouter-budget-track').getAttribute('aria-valuenow'));
  assert.ok(Math.abs(usagePercent-24.68)<0.001);
  assert.match(await page.locator('.openrouter-budget-label').innerText(),/잔여 75.3%/);
  await page.screenshot({path:path.join(output,'openrouter-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await page.locator('#openrouter').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,'openrouter-mobile.png')});
  await page.locator('#admin-logout').click();
  assert.equal(await page.locator('[data-token-action]').count(),0);
  assert.equal(await page.locator('.openrouter-card').count(),1);
  const beforeLoginCalls = openRouterCalls;
  await page.locator('#admin-login').click();
  await page.locator('#admin-password').fill('cvml-test');
  await page.locator('#admin-submit').click();
  await page.locator('#admin-dialog').waitFor({state:'hidden'});
  await page.locator('[data-token-action=refresh]').waitFor();
  assert.equal(openRouterCalls,beforeLoginCalls); // Not due: no query on every login.
  const previewPublicToken=structuredClone(data.openrouter_tokens[0]);
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('[data-token-action=remove]').click();
  await page.locator('.openrouter-card').waitFor({state:'hidden'});
  assert.deepEqual(data.openrouter_tokens,[]);

  // v1.2.0: grouped production panels, missing-history states, measured stats and evidence.
  const order=await page.locator('#panel-resources>section[id]').evaluateAll(elements=>elements.map(e=>e.id));
  assert.deepEqual(order,['openrouter','resources','bottlenecks']);
  assert.equal(await page.locator('main').evaluate(e=>e.querySelector(':scope > :not(#production-maintenance-notice)').id),'release-video');
  assert.equal(await page.locator('main').evaluate(e=>e.lastElementChild.textContent),'designed by psh in suwon');
  assert.match(await page.locator('#resource-grid').innerText(),/수집기 업데이트 필요/);
  resourceEnabled=true;
  await page.locator('#tab-timeline').click();
  await page.locator('#refresh').click();
  await page.locator('#tab-resources').click();
  await page.locator('.resource-card').first().waitFor();
  assert.equal(await page.locator('.resource-card').count(),4);
  assert.match(await page.locator('#resource-meta').innerText(),/GPU·h/);
  assert.equal(await page.locator('#resource-storage script').count(),0);
  assert.match(await page.locator('#resource-storage').innerText(),/data<script>/);
  assert.match(await page.locator('#bottleneck-detail').innerText(),/RAM 여유 부족 의심/);
  assert.equal(await page.locator('.resource-chart path[d*="NaN"]').count(),0);
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#resources').screenshot({path:path.join(output,'resources-desktop.png')});
  await page.locator('#bottlenecks').screenshot({path:path.join(output,'bottlenecks-desktop.png')});
  await page.locator('#resource-period').selectOption('168');
  assert.match(await page.locator('.resource-card').first().innerText(),/1시간 집계/);
  await page.locator('#resource-server').selectOption('server-c');
  assert.match(await page.locator('#resource-grid').innerText(),/수집기 업데이트 필요/);
  await page.locator('#resource-server').selectOption('server-b');
  await page.locator('#resource-period').selectOption('24');
  resourceFailed=true;
  await page.locator('#tab-timeline').click();
  await page.locator('#refresh').click();
  await page.locator('#tab-resources').click();
  await page.waitForFunction(()=>document.getElementById('resource-state').textContent==='마지막 수신 통계');
  assert.equal(await page.locator('.resource-card').count(),4);
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    await page.locator('#resources').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('#resources').screenshot({path:path.join(output,`resources-mobile-${width}.png`)});
    await page.locator('#bottlenecks').screenshot({path:path.join(output,`bottlenecks-mobile-${width}.png`)});
  }

  // The release film must decode and seek through all 60 seconds.
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#tab-more').click();
  await page.locator('.promo-note-link').click();
  await page.locator('#release-video').screenshot({path:path.join(output,'promo-desktop.png')});
  if(skipFilms)await page.locator('#release-video-toggle').click();
  else{
  const media = await page.locator('#release-video video').evaluate(video=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Promo media load/seek timeout')),15000);
    video.addEventListener('error',()=>{clearTimeout(timer);reject(new Error(`Promo decode error: ${video.error?.code}`));},{once:true});
    video.addEventListener('loadedmetadata',()=>{video.currentTime=59.5;},{once:true});
    video.addEventListener('seeked',()=>{clearTimeout(timer);resolve({duration:video.duration,time:video.currentTime,width:video.videoWidth,ready:video.readyState,paused:video.paused});},{once:true});
    video.load();
  }));
  assert.equal(media.duration,60);
  assert.equal(media.time,59.5);
  assert.equal(media.width,1280);
  assert.ok(media.ready>=2);
  assert.equal(media.paused,true);
  await page.locator('#release-video video').evaluate(async video=>{video.currentTime=5;await video.play()});
  await page.locator('#release-video-toggle').click();
  await page.waitForFunction(()=>document.querySelector('#release-video video').paused);
  }
  assert.equal(await page.locator('#release-video').evaluate(panel=>panel.open),false);
  await page.goto(base+'/__legacy.html');
  await page.locator('.priority-tabs button[tabindex="0"]').waitFor();
  assert.equal(await page.locator('#release-video').evaluate(panel=>panel.open),false);
  await page.locator('#tab-more').click();
  await page.locator('.promo-note-link').click();
  assert.equal(await page.locator('#release-video').evaluate(panel=>panel.open),true);
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    await page.locator('#release-video').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('#release-video').screenshot({path:path.join(output,`promo-mobile-${width}.png`)});
  }
  assert.deepEqual(errors,[]);

  const stagingEntry=base+'/test-server/', stagingPreview=stagingEntry+'preview.html';
  // Sign in to the workspace. A panel name lands on that view; without one the visitor arrives
  // on the home and opens the GPU dashboard from the bar.
  async function enterStaging(page,anchor=''){
    await page.goto(stagingEntry+(anchor?'?panel='+anchor:''));
    await page.getByLabel('이름').fill('테스트 사용자');
    const field=page.getByLabel('비밀번호',{exact:true});
    await field.fill(workspacePassword);
    await field.press('Enter');
    await page.waitForURL(stagingPreview+(anchor?'#'+anchor:''));
    await page.locator('body[data-workspace=ready]').waitFor();
    assert.equal(await page.locator('#workspace-user').innerText(),'테스트 사용자님');
    if(!anchor){
      assert.equal(await page.locator('#workspace-home').isVisible(),true);
      await page.locator('#workspace-gpu-link').click();
    }
  }
  async function openDashboard(page,environment,anchor=''){
    if(environment.profile==='test')await enterStaging(page,anchor);
    else await page.goto(base+environment.path+(anchor?'#'+anchor:''));
  }

  // The public entry stays closed until the preview code is accepted.
  const closed=await context.newPage(),closedRequests=[];
  closed.on('request',request=>closedRequests.push(new URL(request.url())));
  await closed.setViewportSize({width:320,height:844});
  await closed.goto(stagingPreview+'#resources');
  await closed.waitForURL(stagingEntry+'?panel=resources');
  assert.equal(await closed.getByRole('heading',{name:'CVML Workspace'}).isVisible(),true);
  assert.equal(await closed.locator('#api-usage-board').count(),0);
  const premature=closedRequests.filter(url=>url.pathname.endsWith('/config.json')||url.pathname.endsWith('/app.js')||['raw.githubusercontent.com','api.github.com','openrouter.ai'].includes(url.hostname));
  assert.deepEqual(premature.map(url=>url.pathname),[],'the preview must not load the dashboard or its data before entry');
  assert.equal(new URL(await closed.getByRole('link',{name:'정식 화면 보기'}).getAttribute('href'),closed.url()).href,base+'/');
  assert.ok(await closed.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await closed.getByLabel('이름').fill('테스트 사용자');
  const entryCode=closed.getByLabel('비밀번호',{exact:true});
  await entryCode.fill('0000');
  await entryCode.press('Enter');
  await closed.getByText('비밀번호가 맞지 않아요.',{exact:true}).waitFor();
  assert.equal(await entryCode.getAttribute('aria-invalid'),'true');
  assert.equal(await entryCode.inputValue(),'');
  assert.equal(new URL(closed.url()).pathname,'/test-server/');
  // A blank name is refused, and nothing is kept until a sign-in succeeds.
  await closed.getByLabel('이름').fill('   ');
  await entryCode.fill(workspacePassword);
  await entryCode.press('Enter');
  await closed.getByText('이름을 입력해 주세요.',{exact:true}).waitFor();
  assert.equal(new URL(closed.url()).pathname,'/test-server/');
  assert.equal(await closed.evaluate(()=>sessionStorage.length+':'+localStorage.getItem('cvml.workspace.session.v1')),'0:null');
  await closed.close();

  // Run the v2.1 workflows on production and the retained staging preview.
  for(const environment of [{path:'/',profile:'production'},{path:'/test-server/preview.html',profile:'test'}]){
  monitoringProfile=environment.profile;monitoringData=monitoringProfiles[monitoringProfile];monitoringWrites=0;monitoringForbidden=false;monitoringApplied=false;
  const otherMonitoring=structuredClone(monitoringProfiles[monitoringProfile==='test'?'production':'test']);
  const otherProfile=environment.profile==='test'?'production':'test';
  const otherUsage=structuredClone(usageHistories[otherProfile]);
  usageHistoryWrites=0;usageHistoryForbidden=false;usageHistoryUnavailable=false;
  await context.unroute('https://apis.tracker.delivery/carriers/*/tracks/*');
  // The retained test URL shares data and editor behavior without a production footer link.
  collectorFinished=false;progressCompleted=25;serverCStale=true;testAPI=true;previewMode=true;
  resourceEnabled=true;resourceFailed=false;failRaw=false;staleRaw=false;
  const comparisonToken={...structuredClone(previewPublicToken),id:'or-00000000-0000-4000-8000-000000000002',name:'대조 <script> 키',usage:{...previewPublicToken.usage,usage:5,usage_daily:0}};
  const chartTokens=[previewPublicToken,comparisonToken];
  data={...emptyEdits(),openrouter_tokens:chartTokens};
  const historyReadsBefore=usageHistoryReads;
  {
    const at=Date.now();usageHistories[environment.profile]={...mergeSamples(emptyHistory(),[
      {key_id:previewPublicToken.id,at:new Date(at-5*DAY).toISOString(),total:7,daily:2},
      {key_id:previewPublicToken.id,at:new Date(at-3*DAY).toISOString(),total:9,daily:2},
      {key_id:previewPublicToken.id,at:new Date(at-DAY).toISOString(),total:10,daily:3},
      ...samplesFromTokens(chartTokens,at)
    ],at),revision:1,updated_at:new Date(at).toISOString()};
  }
  const writesBeforePreview=writes;
  let parcelCalls=0,parcelMode='success',releaseParcel=null,parcelHoldStarted=null;
  await context.route('https://apis.tracker.delivery/carriers/*/tracks/*',async route=>{
    parcelCalls++;
    assert.equal(route.request().headers().authorization,undefined);
    const carrierId=new URL(route.request().url()).pathname.split('/')[2];
    if(parcelMode==='hold')await new Promise(resolve=>{releaseParcel=resolve;parcelHoldStarted?.();});
    if(parcelMode==='network')return route.abort();
    if(parcelMode==='limited')return fulfill(route,{message:'private provider error'},429);
    if(parcelMode==='missing')return fulfill(route,{message:'not found'},404);
    if(parcelMode==='bad')return route.fulfill({body:'not JSON',contentType:'text/html'});
    const delivered=parcelMode==='delivered'||(parcelMode==='mixed'&&route.request().url().endsWith('13'));
    const deliveryState={id:delivered?'delivered':'out_for_delivery',text:delivered?'배송완료':'배송출발'};
    return fulfill(route,{carrier:{id:carrierId},state:deliveryState,progresses:[
      {time:'2026-10-29T06:00:00+09:00',status:{id:'in_transit',text:'간선 하차'},location:{name:'대전 HUB'},description:'배송 지역으로 이동 중'},
      {time:'2026-10-29T09:12:00+09:00',status:deliveryState,location:{name:'성북 배송점'},description:'배송 예정 <script> test'},
    ]});
  });
  const preview=await context.newPage();
  // A preference saved by the old page must not expand the new header on arrival.
  await preview.addInitScript(()=>localStorage.setItem('cvml-release-video-v2.1-open','true'));
  preview.on('pageerror',error=>errors.push(error.message));
  await openDashboard(preview,environment);
  await preview.locator('.current-gpu-table tbody tr').first().waitFor();
  assert.equal(new URL(preview.url()).pathname,environment.path);
  assert.equal(staleControllerRequests,0,'current dashboards must bypass cached pre-chart controllers');
  const controllerURLs=await preview.evaluate(()=>performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname==='/app.js').map(e=>e.name));
  assert.equal(new Set(controllerURLs).size,1,'all entry modules must share exactly one dashboard controller');
  assert.equal(await preview.locator('.design-credit').innerText(),'designed by psh in suwon');
  assert.equal(await preview.locator('#patch-notes').count(),0);
  if(environment.profile==='production'){
    assert.equal(await preview.title(),'CVML GPU Timeline');
    assert.equal(await preview.locator('#admin-login').evaluate(e=>e.previousElementSibling.id),'test-server-link');
    assert.equal(await preview.getByRole('link',{name:'테스트 서버',exact:true}).getAttribute('href'),'./test-server/');
    assert.equal(await preview.locator('#kimi-service-notice,#server-welcome,#kimi-tribute-dialog').count(),0);
    assert.equal(await preview.locator('#maintenance-notice').count(),0);
    assert.equal(await preview.locator('#production-maintenance-notice').isVisible(),false);
    assert.equal(await preview.locator('.priority-home').count(),0);
    assert.match(await preview.locator('#dashboard-version').innerText(),/^대시보드 v2\.1\.2(?:\+|$)/);
  }else{
    assert.equal(await preview.locator('#maintenance-notice').count(),1);
    assert.match(await preview.locator('#maintenance-notice').textContent(),/사이트 점검 중/);
  }
  assert.equal(await preview.locator(environment.profile==='test'?'#gpu-workspace>details[open]':'main>details[open]').count(),0);
  if(environment.profile==='test'){
    // Kimi tribute: user gesture, keyboard guardrails, original asset, dismissal.
    assert.equal(await preview.locator('#kimi-service-notice').evaluate(e=>e.previousElementSibling.id),'release-video');
    assert.equal(await preview.locator('#server-welcome').evaluate(e=>e.previousElementSibling.id),'kimi-service-notice');
    assert.equal(await preview.locator('#server-welcome img').isVisible(),false);
    await preview.locator('.server-welcome-toggle').press('Enter');
    await preview.waitForFunction(()=>document.querySelector('#server-welcome img').naturalWidth===1122);
    assert.equal(await preview.locator('#server-welcome img').evaluate(e=>e.naturalHeight),1402);
    assert.match(await preview.locator('#server-welcome img').getAttribute('src'),/media\/alonso-welcome\.webp$/);
    await preview.locator('#server-welcome').screenshot({path:path.join(output,environment.profile+'-alonso-welcome-desktop.png')});
    for(const width of [390,320]){
      await preview.setViewportSize({width,height:844});
      assert.ok(await preview.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await preview.locator('#server-welcome').screenshot({path:path.join(output,environment.profile+'-alonso-welcome-'+width+'.png')});
    }
    await preview.locator('.server-welcome-toggle').click();
    assert.equal(await preview.locator('#server-welcome img').isVisible(),false);
    await preview.setViewportSize({width:1440,height:1000});
    await preview.keyboard.press('x');
    assert.equal(await preview.locator('#kimi-tribute-dialog').isVisible(),false);
    await preview.locator('.kimi-service-toggle').click();
    assert.match(await preview.locator('#kimi-service-notice').innerText(),/Kimi\(191\).*서버 장애로 A\/S 진행 중/s);
    await preview.locator('#kimi-tribute-open').click();
    await preview.locator('#kimi-tribute-dialog').waitFor({state:'visible'});
    await preview.waitForFunction(()=>document.querySelector('#kimi-tribute-image').naturalWidth===401);
    assert.equal(await preview.locator('#kimi-tribute-image').evaluate(e=>e.naturalHeight),498);
    assert.match(await preview.locator('#kimi-tribute-caption').innerText(),/드라이버 챔피언을 확정 짓고 휴가를 떠났습니다/);
    await preview.screenshot({path:path.join(output,environment.profile+'-kimi-tribute-desktop.png'),fullPage:false});
    await preview.keyboard.press('Escape');
    assert.equal(await preview.locator('#kimi-tribute-dialog').isVisible(),false);
    assert.equal(await preview.locator('#kimi-tribute-open').evaluate(e=>e===document.activeElement),true);
    await preview.keyboard.press('x');
    assert.equal(await preview.locator('#kimi-tribute-dialog').isVisible(),true);
    await preview.mouse.click(8,8);
    assert.equal(await preview.locator('#kimi-tribute-dialog').isVisible(),false);
    await preview.locator('.kimi-service-toggle').click();
    await preview.keyboard.press('x');
    assert.equal(await preview.locator('#kimi-tribute-dialog').isVisible(),false);
    await preview.locator('.kimi-service-toggle').click();
    await preview.keyboard.press('Shift+X');
    assert.equal(await preview.locator('#kimi-tribute-dialog').isVisible(),true);
    await preview.locator('#kimi-tribute-close').click();
  }
  assert.equal(await preview.locator('#panel-now').isVisible(),true);
  assert.equal(await preview.locator('#panel-timeline').isVisible(),false);
  assert.equal(await preview.locator('.current-gpu-table tbody tr').count(),4);
  assert.equal(await preview.locator('[data-gpu-state=idle]').count(),2);
  assert.equal(await preview.locator('[data-gpu-state=busy]').count(),0);
  assert.equal(await preview.locator('[data-gpu-state=maintenance]').count(),1);
  assert.equal(await preview.locator('#current-gpu-count').innerText(),'3');
  assert.match(await preview.locator('#as-capacity-note').innerText(),/Server A.*A\/S 중/);
  assert.equal(await preview.locator('[data-gpu-state=unknown]').count(),1);
  assert.match(await preview.locator('#priority-alerts').innerText(),/Server C/);
  assert.equal(await preview.locator('.current-server-label').count(),3);
  assert.equal(await preview.locator('.current-server-label').nth(1).getAttribute('rowspan'),'2');
  assert.match(await preview.locator('[data-current-server=server-a]').innerText(),/사용 일시 중단/);
  assert.equal(await preview.locator('[data-current-server=server-a] .current-gpu-percent').count(),0);
  assert.equal(await preview.locator('#current-api-panel').isVisible(),false);
  await preview.locator('#priority-overview [data-resource-view=api]').click();
  assert.equal(await preview.locator('#current-api-panel').isVisible(),true);
  assert.equal(await preview.locator('#current-gpu-panel').isVisible(),false);
  assert.equal(await preview.locator('#current-api-tab').getAttribute('aria-selected'),'true');
  assert.equal(await preview.locator('.current-api-row').count(),1);
  assert.match(await preview.locator('#current-api').innerText(),/API current <script> test/);
  assert.equal(await preview.locator('#current-api script').count(),0);
  await preview.locator('#current-api [data-job="api-live"]').click();
  assert.match(await preview.locator('#job-detail').innerText(),/API current <script> test/);
  await preview.locator('#close-detail').click();
  await preview.screenshot({path:path.join(output,environment.profile+'-test-server-api-desktop.png'),fullPage:true});
  await preview.locator('#current-gpu-tab').click();
  assert.equal(await preview.locator('#current-gpus [data-job="job-original"]').count(),0);
  await preview.locator('#current-gpus [data-as-history="server-a"]').click();
  assert.match(await preview.locator('#as-history-dialog').innerText(),/server-a\/job-original/);
  assert.match(await preview.locator('#as-history-dialog').innerText(),/정답 2회 연속 시 진짜 AIME 문제로 교체/);
  assert.match(await preview.locator('#as-history-dialog').innerText(),/수집 당시 실행 중/);
  await preview.keyboard.press('x');
  assert.equal(await preview.locator('#kimi-tribute-dialog').isVisible(),false);
  await preview.locator('[data-as-close]').click();
  await preview.screenshot({path:path.join(output,environment.profile+'-test-server-desktop.png'),fullPage:true});
  await preview.locator('#tab-resources').click();
  await preview.locator('.resource-card').first().waitFor({state:'visible'});
  assert.equal(await preview.locator('.resource-card').count(),4);
  assert.match(await preview.locator('#openrouter-grid').innerText(),/연구실 공용/);
  {
    await preview.waitForFunction(()=>document.getElementById('api-usage-state').textContent.includes('개 키의 관측 기록'));
    assert.ok(usageHistoryReads>historyReadsBefore);
    assert.equal(await preview.locator('#api-usage-board').evaluate(e=>e.previousElementSibling.id),'openrouter-grid');
    if(environment.profile==='test')assert.match(await preview.locator('#dashboard-version').innerText(),/테스트 v3.0 snapshot 3/);
    assert.equal(await preview.locator('#api-usage-key option').count(),3);
    assert.ok(await preview.locator('#api-usage-plot [data-usage-day]').count()>0);
    assert.equal(await preview.locator('#api-usage-board script').count(),0);
    await preview.locator('#api-usage-key').selectOption(comparisonToken.id);
    assert.equal(await preview.locator('#api-usage-amount').innerText(),'$0.00');
    await preview.locator('#api-usage-metric').selectOption('cumulative');
    assert.equal(await preview.locator('#api-usage-amount').innerText(),'$5.00');
    assert.equal(await preview.locator('#api-usage-plot circle').count(),1);
    await preview.locator('#api-usage-key').selectOption('all');
    await preview.locator('[data-usage-days="30"]').click();
    assert.equal(await preview.locator('[data-usage-days="30"]').getAttribute('aria-pressed'),'true');
    assert.ok(await preview.locator('#api-usage-plot path').count()>0);
    await preview.locator('#api-usage-metric').selectOption('daily');
    await preview.locator('[data-usage-days="7"]').click();
    await preview.locator('.api-usage-records > summary').click();
    assert.match(await preview.locator('#api-usage-table').innerText(),/대조 <script> 키/);
    assert.match(await preview.locator('#api-usage-table').innerText(),/일부 키 미관측/);
    await preview.locator('.api-usage-records > summary').click();
    await preview.locator('#api-usage-board').screenshot({path:path.join(output,environment.profile+'-api-usage-desktop.png')});
    assert.equal(usageHistoryWrites,0);
  }
  assert.equal(await preview.locator('#resource-server').inputValue(),'server-b');
  await preview.locator('#resource-server').selectOption('server-a');
  await preview.locator('#as-resource-body > .as-cover').waitFor({state:'visible'});
  assert.match(await preview.locator('#resource-state').innerText(),/A\/S 중/);
  await preview.locator('[data-as-stats="resource"]').click();
  assert.match(await preview.locator('#as-resource-body > .as-past-note').innerText(),/수리 전 수집 기록/);
  assert.equal(await preview.locator('.resource-card').first().isVisible(),true);
  await preview.locator('#resource-server').selectOption('server-b');
  await preview.locator('#tab-timeline').click();
  assert.equal(await preview.locator('#timeline').isVisible(),true);
  assert.ok(await preview.locator('#timeline .as-lane').count()>0);
  assert.equal(await preview.locator('#timeline .as-lane [data-job="job-original"]').evaluateAll(els=>els.every(e=>e.closest('[inert]')!==null)),true);
  await preview.locator('#tab-servers').click();
  assert.equal(await preview.locator('.server-card').count(),4);
  const pendingServer=preview.locator('.server-card').filter({has:preview.getByRole('heading',{name:'Alonso(194)',exact:true})});
  assert.match(await pendingServer.innerText(),/GPU 정보 대기.*0 GPU/s);
  assert.match(await pendingServer.innerText(),/마지막 수신 없음/);
  assert.match(await pendingServer.innerText(),/설치 버전 확인 필요/);
  assert.equal(await preview.locator('[data-monitor-server="server-d"]').count(),1);
  await preview.locator('[data-monitor-server="server-b"]').waitFor();
  assert.equal(await preview.locator('[data-monitor-server="server-a"]').count(),0);
  assert.equal(await preview.locator('[data-monitor-server]').count(),3);
  assert.match(await preview.locator('[data-as-server="server-a"]').innerText(),/A\/S 중/);
  assert.equal(await preview.locator('[data-as-server="server-a"] .server-heading .state').innerText(),'A/S 중');
  assert.equal(monitoringWrites,0);
  await preview.locator('#tab-more').click();
  assert.equal(await preview.locator('#usage').isVisible(),true);
  await preview.locator('#tab-parcel').click();
  assert.equal(new URL(preview.url()).hash,'#parcel');
  assert.equal(parcelCalls,0);
  assert.equal(await preview.locator('#parcel-count-active').innerText(),'0');
  await preview.locator('#parcel-quick-lookup > summary').click();
  await preview.locator('#parcel-number').press('x');
  assert.equal(await preview.locator('#kimi-tribute-dialog').isVisible(),false);
  await preview.locator('#parcel-number').fill('');
  await preview.locator('#parcel-submit').click();
  assert.match(await preview.locator('#parcel-feedback').innerText(),/택배사를 선택/);
  assert.equal(parcelCalls,0);
  await preview.locator('#parcel-carrier').selectOption('kr.cjlogistics');
  await preview.locator('#parcel-number').fill('000000000000');
  await preview.locator('#parcel-submit').click();
  assert.match(await preview.locator('#parcel-feedback').innerText(),/운송장 번호를 확인/);
  assert.equal(parcelCalls,0);
  await preview.locator('#parcel-number').fill('1234-5678 9012');
  await preview.locator('#parcel-number').press('Enter');
  await preview.locator('.parcel-history li').first().waitFor();
  assert.equal(parcelCalls,1);
  assert.equal(await preview.locator('#parcel-number').inputValue(),'123456789012');
  assert.match(await preview.locator('.parcel-summary').innerText(),/배송출발/);
  assert.match(await preview.locator('.parcel-history li').first().innerText(),/09:12.*KST[\s\S]*성북 배송점/);
  assert.match(await preview.locator('.parcel-history').innerText(),/<script> test/);
  assert.equal(await preview.locator('#parcel-result-body script').count(),0);
  assert.match(await preview.locator('.parcel-stages [aria-current=step]').innerText(),/배송 출발/);
  assert.match(await preview.locator('#parcel-official').getAttribute('href'),/gnbInvcNo=123456789012/);
  await preview.locator('#parcel-copy').click();
  assert.equal(await preview.evaluate(()=>navigator.clipboard.readText()),'123456789012');
  await preview.screenshot({path:path.join(output,environment.profile+'-test-server-parcel-desktop.png'),fullPage:true});
  await preview.locator('#tab-now').click();
  await preview.locator('#tab-parcel').click();
  assert.equal(await preview.locator('.parcel-history li').count(),2);
  assert.equal(parcelCalls,1);
  const departureColor=await preview.locator('.parcel-summary h3').evaluate(e=>getComputedStyle(e).color);
  parcelMode='delivered';await preview.locator('#parcel-submit').click();
  await preview.waitForFunction(()=>document.querySelector('.parcel-summary h3')?.textContent==='배송완료');
  const deliveredColor=await preview.locator('.parcel-summary h3').evaluate(e=>getComputedStyle(e).color);
  assert.notEqual(departureColor,deliveredColor,'departure and delivered summaries have distinct colors');
  parcelMode='success';await preview.locator('#parcel-submit').click();
  await preview.waitForFunction(()=>document.querySelector('.parcel-summary h3')?.textContent==='배송출발');
  for(const [mode,message] of [['missing',/아직 배송 정보/],['limited',/제한/],['network',/네트워크/],['bad',/응답/]]) {
    parcelMode=mode;
    await preview.locator('#parcel-submit').click();
    await preview.waitForFunction(()=>document.querySelector('#parcel-result').getAttribute('aria-busy')==='false');
    assert.match(await preview.locator('#parcel-feedback').innerText(),message);
    assert.equal(await preview.locator('.parcel-history li').count(),0);
    assert.equal(await preview.locator('#parcel-official').isVisible(),true);
  }
  parcelMode='hold';
  const heldParcel=new Promise(resolve=>{parcelHoldStarted=resolve;});
  await preview.locator('#parcel-submit').click();
  await heldParcel;
  await preview.waitForFunction(()=>document.querySelector('#parcel-result').getAttribute('aria-busy')==='true');
  await preview.locator('#parcel-clear').click();
  releaseParcel?.();parcelMode='success';
  assert.equal(await preview.locator('#parcel-result').isVisible(),false);
  assert.equal(await preview.locator('#parcel-number').inputValue(),'');
  assert.equal(await preview.locator('#parcel-carrier').inputValue(),'');
  assert.equal(await preview.locator('#parcel-result-body').innerText(),'');
  assert.equal(await preview.locator('#parcel-query').innerText(),'');
  assert.equal(await preview.locator('#parcel-official').getAttribute('href'),null);
  assert.equal(await preview.locator('#parcel-feedback').innerText(),'');
  await preview.locator('#parcel-carrier').selectOption('kr.cjlogistics');
  await preview.locator('#parcel-number').fill('123456789012');
  await preview.locator('#parcel-submit').click();
  await preview.locator('.parcel-history li').first().waitFor();
  assert.equal(await preview.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('123456789012')),false);
  assert.equal(writes,writesBeforePreview);
  await preview.locator('#parcel-order-add').click();
  assert.equal(await preview.locator('#admin-dialog').isVisible(),true);
  await preview.locator('#admin-password').fill('cvml-test');
  await preview.locator('#admin-submit').click();
  await preview.locator('#admin-tools').waitFor();
  const addOrder=async(name,quantity=1,carrier='',number='')=>{
    await preview.locator('#parcel-order-add').click();
    await preview.locator('#parcel-order-name').fill(name);
    await preview.locator('#parcel-order-quantity').fill(String(quantity));
    await preview.locator('#parcel-order-carrier').selectOption(carrier);
    await preview.locator('#parcel-order-number').fill(number);
    await preview.locator('#parcel-order-save').click();
    await preview.locator('#parcel-order-dialog').waitFor({state:'hidden'});
  };
  await preview.locator('#parcel-order-add').click();
  await preview.locator('#parcel-order-save').click();
  assert.match(await preview.locator('#parcel-order-error').innerText(),/장비명/);
  await preview.locator('#parcel-order-dialog [data-close-parcel]').first().click();
  const callsBeforeOrders=parcelCalls;
  await addOrder('측정용 마이크',4);
  assert.equal(data.parcels.length,1);assert.equal(data.parcels[0].tracking_number,null);
  assert.equal(parcelCalls,callsBeforeOrders);
  const microphone=data.parcels[0].id;
  assert.match(await preview.locator(`[data-parcel-card="${microphone}"]`).innerText(),/운송장 대기/);
  await addOrder('오디오 인터페이스',1,'kr.hanjin','123456789013');
  await preview.waitForFunction(()=>[...document.querySelectorAll('.parcel-order-status')].some(e=>e.textContent==='배송출발'));
  await addOrder('차량 고정 브래킷',2);
  const bracket=data.parcels[2].id;
  assert.equal(await preview.locator('[data-parcel-card]').count(),3);
  await preview.locator(`[data-parcel-id="${microphone}"][data-parcel-action=edit]`).click();
  await preview.locator('#parcel-order-carrier').selectOption('kr.cjlogistics');
  await preview.locator('#parcel-order-number').fill('1234-5678 9012');
  await preview.locator('#parcel-order-note').fill('차량 수집용 <script> test');
  await preview.locator('#parcel-order-save').click();
  await preview.locator('#parcel-order-dialog').waitFor({state:'hidden'});
  await preview.waitForFunction(id=>document.querySelector(`[data-parcel-card="${id}"] .parcel-order-status`).textContent==='배송출발',microphone);
  assert.equal(data.parcels[0].tracking_number,'123456789012');
  assert.equal(await preview.locator('#parcel-orders script').count(),0);
  assert.match(await preview.locator(`[data-parcel-card="${microphone}"]`).innerText(),/<script> test/);
  await preview.locator(`[data-parcel-id="${microphone}"][data-parcel-action=edit]`).click();
  await preview.locator('#parcel-order-quantity').fill('5');forbidden=true;
  await preview.locator('#parcel-order-save').click();
  await preview.waitForFunction(()=>document.querySelector('#parcel-order-error').textContent.includes('권한'));
  assert.equal(data.parcels[0].quantity,4);
  assert.equal(await preview.locator('#parcel-order-dialog').isVisible(),true);
  forbidden=false;await preview.locator('#parcel-order-save').click();
  await preview.locator('#parcel-order-dialog').waitFor({state:'hidden'});
  assert.equal(data.parcels[0].quantity,5);
  await preview.locator(`[data-parcel-id="${microphone}"][data-parcel-action=received]`).click();
  await preview.waitForFunction(()=>document.querySelector('#parcel-count-received').textContent==='1');
  await preview.locator('#parcel-filter-received').click();
  assert.equal(await preview.locator('[data-parcel-card]').count(),1);
  await preview.locator(`[data-parcel-id="${microphone}"][data-parcel-action=received]`).click();
  await preview.waitForFunction(()=>document.querySelector('#parcel-count-received').textContent==='0');
  await preview.locator('#parcel-filter-active').click();
  await preview.locator(`[data-parcel-id="${bracket}"][data-parcel-action=archive]`).click();
  await preview.waitForFunction(()=>document.querySelector('#parcel-count-archived').textContent==='1');
  await preview.locator('#parcel-filter-archived').click();
  await preview.locator(`[data-parcel-id="${bracket}"][data-parcel-action=archive]`).click();
  await preview.waitForFunction(()=>document.querySelector('#parcel-count-archived').textContent==='0');
  await preview.locator('#parcel-filter-active').click();
  parcelMode='network';await preview.locator(`[data-parcel-id="${microphone}"][data-parcel-action=query]`).click();
  await preview.waitForFunction(id=>!!document.querySelector(`[data-parcel-card="${id}"] .parcel-order-error`),microphone);
  assert.match(await preview.locator(`[data-parcel-card="${microphone}"] .parcel-order-status`).innerText(),/마지막 조회/);
  parcelMode='mixed';const callsBeforeBulk=parcelCalls;
  await preview.locator('#parcel-board-refresh').click();
  await preview.waitForFunction(()=>!document.querySelector('#parcel-board-refresh').disabled);
  assert.equal(parcelCalls-callsBeforeBulk,2);
  const orderDeparture=preview.locator('.parcel-order-status.out-for-delivery');
  const orderDelivered=preview.locator('.parcel-order-status.delivered');
  assert.equal(await orderDeparture.count(),1);assert.equal(await orderDelivered.count(),1);
  assert.notEqual(await orderDeparture.evaluate(e=>getComputedStyle(e).color),await orderDelivered.evaluate(e=>getComputedStyle(e).color));
  assert.notEqual(await orderDeparture.evaluate(e=>getComputedStyle(e).backgroundColor),await orderDelivered.evaluate(e=>getComputedStyle(e).backgroundColor));
  assert.equal(data.openrouter_tokens[0].id,previewPublicToken.id);
  const writesAfterOrders=writes;
  await preview.locator('#parcel-board-sync').click();
  await preview.waitForFunction(()=>!document.querySelector('#refresh').disabled);
  assert.equal(await preview.locator('[data-parcel-card]').count(),3);
  await preview.locator('#parcel-quick-lookup > summary').click();
  await preview.locator('#parcel-board-title').scrollIntoViewIfNeeded();
  await preview.screenshot({path:path.join(output,environment.profile+'-test-server-parcel-orders-desktop.png'),fullPage:true});
  const viewer=await context.newPage();viewer.on('pageerror',error=>errors.push(error.message));
  const callsBeforeViewer=parcelCalls;
  await openDashboard(viewer,environment,'parcel');await viewer.locator('[data-parcel-card]').first().waitFor();
  assert.equal(await viewer.locator('[data-parcel-card]').count(),3);
  assert.equal(await viewer.locator('[data-parcel-action=edit]').count(),0);
  assert.equal(parcelCalls,callsBeforeViewer);assert.equal(writes,writesAfterOrders);
  await viewer.reload();
  // A reload keeps the signed-in visitor on the same dashboard tab.
  if(environment.profile==='test'){await viewer.locator('body[data-workspace=ready]').waitFor();assert.equal(await viewer.locator('#tab-parcel').getAttribute('aria-selected'),'true');}
  await viewer.locator('[data-parcel-card]').first().waitFor();
  assert.equal(await viewer.locator('[data-parcel-card]').count(),3);
  assert.equal(await viewer.locator('#parcel-count-active').innerText(),'3');
  await viewer.close();
  await preview.locator('#manual-add').click();
  await preview.waitForFunction(()=>document.querySelector('#manual-server option[value="server-a"]')?.disabled);
  assert.equal(await preview.locator('#manual-server').inputValue(),'server-b');
  await preview.locator('[data-close-dialog="manual-dialog"]').first().click();
  // v2.1: independently stored per-server schedules and honest collector acknowledgement.
  const experimentWritesBeforeMonitoring=writes,ordersBeforeMonitoring=structuredClone(data.parcels);
  await preview.locator('#tab-servers').click();
  await preview.locator('[data-monitor-server="server-b"]').click();
  await preview.locator('#monitor-dialog').waitFor();
  await preview.locator('#monitor-add').click();
  await preview.locator('#monitor-check-none').click();
  await preview.locator('#monitor-editor-add').click();
  assert.match(await preview.locator('#monitor-schedule-error').innerText(),/점검 항목/);
  await preview.locator('[name=monitor-check][value=gpu_response]').check();
  await preview.locator('[name=monitor-check][value=gpu_count]').check();
  await preview.locator('#monitor-interval').fill('15');
  await preview.locator('#monitor-editor-add').click();
  await preview.locator('#monitor-add').click();
  await preview.locator('#monitor-kind').selectOption('daily');
  await preview.locator('#monitor-daily-count').selectOption('2');
  await preview.locator('#monitor-time-one').fill('09:00');
  await preview.locator('#monitor-time-two').fill('09:00');
  await preview.locator('#monitor-editor-add').click();
  assert.match(await preview.locator('#monitor-schedule-error').innerText(),/서로 다른/);
  await preview.locator('#monitor-time-two').fill('21:00');
  await preview.locator('[name=monitor-day][value="5"]').uncheck();
  await preview.locator('[name=monitor-day][value="6"]').uncheck();
  await preview.locator('#monitor-editor-add').click();
  await preview.locator('#monitor-save').click();
  await preview.waitForFunction(()=>document.getElementById('monitor-feedback').textContent.includes('공용 설정을 저장'));
  assert.equal(monitoringWrites,1);
  assert.equal(monitoringData.servers[0].server_id,'server-b');
  assert.equal(monitoringData.servers[0].schedules.length,2);
  assert.equal(monitoringData.servers[0].schedules[0].interval_minutes,15);
  assert.deepEqual(monitoringData.servers[0].schedules[1].times,['09:00','21:00']);
  assert.deepEqual(monitoringData.servers[0].schedules[1].days,[0,1,2,3,4]);
  assert.match(await preview.locator('#monitor-connection').innerText(),/수집기 연결 필요/);
  await preview.locator('#monitor-dialog').screenshot({path:path.join(output,environment.profile+'-monitoring-settings-desktop.png')});
  await preview.locator('#monitor-close').click();
  const bConfig=structuredClone(monitoringData.servers[0]);
  await preview.locator('[data-monitor-server="server-c"]').click();
  assert.equal(await preview.locator('.monitor-schedule-row').count(),0);
  await preview.locator('#monitor-add').click();await preview.locator('#monitor-editor-add').click();
  monitoringForbidden=true;await preview.locator('#monitor-save').click();
  await preview.waitForFunction(()=>document.getElementById('monitor-config-error').textContent.includes('권한'));
  assert.equal(monitoringWrites,1);assert.equal(monitoringData.servers.length,1);
  monitoringForbidden=false;await preview.locator('#monitor-save').click();
  await preview.waitForFunction(()=>document.getElementById('monitor-feedback').textContent.includes('공용 설정을 저장'));
  assert.equal(monitoringWrites,2);assert.deepEqual(monitoringData.servers.find(c=>c.server_id==='server-b'),bConfig);
  await preview.locator('#monitor-close').click();
  monitoringApplied=true;monitoringReportProfile=monitoringProfile==='test'?'production':'test';
  await preview.locator('#tab-now').click();await preview.locator('#current-refresh').click();await preview.locator('#tab-servers').click();
  await preview.locator('[data-monitor-server="server-b"]').click();
  assert.match(await preview.locator('#monitor-connection').innerText(),/수집기 연결 필요/);
  assert.match(await preview.locator('#monitor-results').innerText(),/아직 없어요/);
  await preview.locator('#monitor-close').click();monitoringReportProfile=null;
  await preview.locator('#tab-now').click();await preview.locator('#current-refresh').click();await preview.locator('#tab-servers').click();
  await preview.locator('[data-monitor-server="server-b"]').click();
  assert.match(await preview.locator('#monitor-connection').innerText(),/서버 적용 완료/);
  assert.match(await preview.locator('#monitor-results').innerText(),/확인 필요/);
  await preview.locator('#monitor-close').click();
  assert.equal(writes,experimentWritesBeforeMonitoring);assert.deepEqual(data.parcels,ordersBeforeMonitoring);
  const monitoringViewer=await context.newPage();await openDashboard(monitoringViewer,environment,'servers');
  await monitoringViewer.locator('[data-monitor-server="server-b"]').click();
  await monitoringViewer.waitForFunction(()=>document.querySelectorAll('.monitor-schedule-row').length===2);
  assert.match(await monitoringViewer.locator('#monitor-auth').innerText(),/로그인이 필요/);
  await monitoringViewer.locator('#monitor-close').click();await monitoringViewer.close();
  {
    const mainWritesBefore=writes,providerCallsBefore=openRouterCalls;
    usageHistoryForbidden=true;
    data.openrouter_tokens[0]={...data.openrouter_tokens[0],checked_at:new Date().toISOString(),attempted_at:new Date().toISOString(),usage:{...data.openrouter_tokens[0].usage,usage:40,usage_daily:5}};
    await preview.locator('#tab-now').click();await preview.locator('#current-refresh').click();
    await preview.locator('#tab-resources').click();
    await preview.waitForFunction(()=>document.getElementById('api-usage-state').textContent.includes('저장하지 못했어요'));
    assert.equal(usageHistoryWrites,0);assert.notEqual(await preview.locator('#api-usage-amount').innerText(),'$0.00');
    usageHistoryForbidden=false;await preview.locator('#api-usage-reload').click();
    await preview.waitForFunction(()=>!document.getElementById('api-usage-state').textContent.includes('저장 중')&&!document.getElementById('api-usage-state').textContent.includes('저장하지 못했어요'));
    assert.equal(usageHistoryWrites,1);assert.equal(writes,mainWritesBefore);
    usageHistoryUnavailable=true;await preview.locator('#api-usage-reload').click();
    await preview.waitForFunction(()=>document.getElementById('api-usage-state').textContent.includes('불러오지 못했어요'));
    assert.ok(await preview.locator('#api-usage-plot svg').count()>0);
    usageHistoryUnavailable=false;await preview.locator('#api-usage-reload').click();
    await preview.waitForFunction(()=>!document.getElementById('api-usage-state').textContent.includes('불러오지 못했어요'));
    assert.equal(usageHistoryWrites,1);assert.equal(openRouterCalls,providerCallsBefore);
    const historyViewer=await context.newPage();await openDashboard(historyViewer,environment,'resources');
    await historyViewer.locator('#api-usage-plot svg').waitFor();
    assert.match(await historyViewer.locator('#api-usage-table').textContent(),/UTC/);
    await historyViewer.close();assert.equal(usageHistoryWrites,1);
  }

  await preview.locator('#tab-more').click();
  if(!await preview.locator('#release-video').evaluate(e=>e.open))await preview.locator('#release-video-toggle').click();
  await preview.locator('#release-video').scrollIntoViewIfNeeded();
  assert.match(await preview.locator('#release-video source').getAttribute('src'),/v2\.1-film/);
  assert.equal(await preview.locator('#patch-notes').count(),0);
  if(!skipFilms){
  await preview.locator('#release-video video').evaluate(video=>video.load());
  await preview.waitForFunction(()=>document.querySelector('#release-video video').readyState>=1);
  assert.equal(await preview.locator('#release-video video').evaluate(v=>v.duration),60);
  assert.equal(await preview.locator('#release-video video').evaluate(v=>v.videoWidth),1920);
  }
  assert.equal(await preview.locator('#release-video video').getAttribute('poster'),'../media/poster-v2.1.jpg');

  await preview.locator('#tab-now').click();
  for(const width of [390,320]) {
    await preview.setViewportSize({width,height:844});
    for(const name of ['now','timeline','resources','servers','parcel','more']) {
      await preview.locator('#tab-'+name).click();
      assert.ok(await preview.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`test-server ${name} overflows at ${width}px`);
      if(name==='resources'){
        await preview.locator('#api-usage-metric').selectOption('cumulative');
        await preview.locator('[data-usage-days="90"]').click();
        await preview.locator('#api-usage-board').screenshot({path:path.join(output,environment.profile+`-api-usage-mobile-${width}.png`)});
        assert.ok(await preview.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      }
    }
    await preview.locator('#tab-now').click();
    await preview.locator('#current-gpu-tab').click();
    if(environment.profile==='test'){
      await preview.locator('#kimi-tribute-open').click();
      assert.ok(await preview.locator('#kimi-tribute-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
      assert.ok(await preview.locator('#kimi-tribute-dialog').evaluate(e=>e.getBoundingClientRect().height<=innerHeight));
      await preview.locator('#kimi-tribute-dialog').screenshot({path:path.join(output,environment.profile+`-kimi-tribute-mobile-${width}.png`)});
      await preview.locator('#kimi-tribute-close').click();
    }
    await preview.screenshot({path:path.join(output,environment.profile+`-test-server-mobile-${width}.png`),fullPage:true});
    await preview.locator('#current-gpus [data-as-history="server-a"]').click();
    assert.ok(await preview.locator('#as-history-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
    await preview.locator('[data-as-close]').click();
    await preview.locator('#current-api-tab').click();
    assert.ok(await preview.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`test-server API overflows at ${width}px`);
    await preview.screenshot({path:path.join(output,environment.profile+`-test-server-api-mobile-${width}.png`),fullPage:true});
    await preview.locator('#tab-parcel').click();
    assert.ok(await preview.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`parcel result overflows at ${width}px`);
    await preview.screenshot({path:path.join(output,environment.profile+`-test-server-parcel-mobile-${width}.png`),fullPage:true});
    await preview.locator('#parcel-order-add').click();
    assert.ok(await preview.locator('#parcel-order-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
    await preview.screenshot({path:path.join(output,environment.profile+`-test-server-parcel-order-form-${width}.png`),fullPage:true});
    await preview.locator('#parcel-order-dialog [data-close-parcel]').first().click();
    await preview.locator('#tab-servers').click();
    await preview.locator('[data-monitor-server="server-b"]').click();
    await preview.locator('#monitor-add').click();await preview.locator('#monitor-kind').selectOption('daily');await preview.locator('#monitor-daily-count').selectOption('2');
    assert.ok(await preview.locator('#monitor-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1),`monitoring dialog overflows at ${width}px`);
    assert.ok(await preview.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await preview.locator('#monitor-dialog').screenshot({path:path.join(output,environment.profile+`-monitoring-schedule-mobile-${width}.png`)});
    await preview.locator('#monitor-close').click();

  }
  await preview.locator('#tab-now').click();
  serverCStale=false;testAPI=false;
  await preview.locator('#current-refresh').click();
  await preview.waitForFunction(()=>document.querySelectorAll('[data-gpu-state=unknown]').length===0);
  assert.equal(await preview.locator('.current-api-row').count(),0);
  assert.equal(await preview.locator('#current-api-tab').getAttribute('aria-selected'),'true');
  assert.equal(await preview.locator('#current-api-panel').isVisible(),true);
  assert.equal(writes,writesAfterOrders);
  assert.deepEqual(errors,[]);
  await preview.close();
  assert.deepEqual(monitoringProfiles[monitoringProfile==='test'?'production':'test'],otherMonitoring,'testing one dashboard must preserve the other monitoring profile');
  assert.deepEqual(usageHistories[otherProfile],otherUsage,'testing one dashboard must preserve the other usage history');
  }

  // ---- Test-server workspace: home, research tracker, sealed storage, sign-out ----------------
  {
    const kst=offset=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(Date.now()+offset*86400000);
    const made={by:'상현',at:new Date(Date.now()-86400000).toISOString()};
    const running=makeProject({name:'멀티모달 주행 과제 <b>',short:'IITP 멀티모달',agency:'IITP',number:'RS-2025-00123456',starts_on:kst(-300),ends_on:kst(400),
      ack_en:'This work was supported by IITP (No. RS-2025-00123456).',ack_patent:'과제고유번호 RS-2025-00123456 · 기여율 1/1',
      targets:[{metric:'paper_sci',count:2,due_on:kst(40),label:'2차년도'},{metric:'patent_app',count:1}],milestones:[{title:'연차보고서 제출',date:kst(20)}]},made);
    const ended=makeProject({name:'끝난 과제',short:'종료 과제',ends_on:kst(-10),targets:[{metric:'software',count:1}]},made);
    const seedProjects=[running,ended];
    const seedOutputs=[
      makeOutput({kind:'paper',grade:'sci',status:'published',title:'Published driving paper',venue:'IEEE TIV',date:kst(-100),acks:[{project_id:running.id}]},seedProjects,made),
      makeOutput({kind:'paper',grade:'sci',status:'submitted',title:'Submitted paper',acks:[{project_id:running.id,text:'Custom <i>acknowledgement</i> sentence'}]},seedProjects,made),
      makeOutput({kind:'patent',grade:'domestic',status:'filed',title:'출원한 특허',date:kst(-30),identifier:'10-2026-0012345',acks:[{project_id:running.id}]},seedProjects,made),
      makeOutput({kind:'paper',grade:'kci',status:'published',title:'<script>window.__researchXSS=1</script> 국내 논문',acks:[]},seedProjects,made),
    ];
    await sealResearch(validateResearch({schema_version:1,revision:4,updated_at:made.at,projects:seedProjects,outputs:seedOutputs}));
    const researchErrors=[],fits=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
    // The view follows the hash, which changes just after the click.
    const openView=async(page,view)=>{await page.locator(`.ws-nav [data-ws-view=${view}]`).click();await page.locator(`[data-ws-section=${view}]`).waitFor();};

    // A signed-in reader sees what each project still owes and which acknowledgement was used.
    const reader=await context.newPage();reader.on('pageerror',error=>researchErrors.push(error.message));
    await enterStaging(reader,'research');
    await reader.locator('.rs-project').first().waitFor();
    assert.equal(await reader.title(),'연구과제 · CVML Workspace');
    assert.equal(await reader.locator('#workspace-research').isVisible(),true);
    assert.equal(await reader.locator('#gpu-workspace').isVisible(),false);
    assert.equal(await reader.locator('.ws-nav [aria-current=page]').innerText(),'연구과제');
    // The page reads its own "today": allow for midnight (KST) passing after the dates were seeded.
    assert.match((await reader.locator('#rs-summary .rs-stat strong').allTextContents()).join(' | '),/^1개 \| 1건 \| D-(20|19) \| 2건$/);
    const card=reader.locator(`[data-rs-project="${running.id}"]`);
    assert.equal(await reader.locator('.rs-project').count(),1);
    assert.equal(await card.locator('h3').innerText(),'멀티모달 주행 과제 <b>');
    assert.equal(await card.locator('h3 b').count(),0);
    assert.match(await card.locator('.rs-verdict').innerText(),/SCI\(E\) 논문 1편 더 필요 · 그중 1건은 진행 중/);
    assert.deepEqual(await card.locator('tr[data-rs-target]').evaluateAll(rows=>rows.map(row=>row.dataset.state)),['covered','met']);
    assert.match(await card.locator('tr[data-rs-target]').first().innerText(),/SCI\(E\) 논문 · 2차년도[\s\S]*1\s*\/ 2편[\s\S]*투고·심사 중 1[\s\S]*1편 더 필요[\s\S]*D-(40|39)/);
    assert.match(await card.locator('tr[data-rs-target]').nth(1).innerText(),/특허 출원[\s\S]*1\s*\/ 1건[\s\S]*달성/);
    await card.locator('summary',{hasText:'사사한 실적 3건'}).click();
    assert.equal(await card.locator('.rs-line').count(),3);
    const customLine=card.locator('.rs-line',{hasText:'Submitted paper'});
    await customLine.locator('summary').click();
    assert.equal(await customLine.locator('.rs-ack p').innerText(),'Custom <i>acknowledgement</i> sentence');
    assert.equal(await customLine.locator('.rs-ack i').count(),0);
    const patentLine=card.locator('.rs-line',{hasText:'출원한 특허'});
    await patentLine.locator('summary').click();
    assert.match(await patentLine.locator('.rs-ack').innerText(),/특허 출원서 표기[\s\S]*과제고유번호 RS-2025-00123456/);
    await card.locator('summary',{hasText:'이 과제의 사사문구'}).click();
    await card.locator('.rs-fold').nth(1).locator('[data-rs-copy]').first().click();
    assert.equal(await reader.evaluate(()=>navigator.clipboard.readText()),'This work was supported by IITP (No. RS-2025-00123456).');
    assert.equal(await reader.locator('#rs-feedback').innerText(),'사사문구를 복사했어요.');
    // Opening a fold is not a change: the next periodic render leaves the card, and so keyboard
    // focus and a text selection inside it, alone.
    await reader.evaluate(()=>{window.__card=document.querySelector('.rs-project');document.dispatchEvent(new CustomEvent('dashboard:render'));});
    assert.equal(await reader.evaluate(()=>window.__card.isConnected&&[...window.__card.querySelectorAll('.rs-fold')].every(fold=>fold.open)),true);
    assert.equal(await reader.locator('#workspace-research [data-rs-action]').count(),0);
    assert.match(await reader.locator('#rs-access').innerText(),/읽기 전용/);
    await reader.screenshot({path:path.join(output,'research-projects-desktop.png'),fullPage:true});
    await reader.locator('[data-rs-phase=ended]').click();
    assert.match(await reader.locator('.rs-project .rs-verdict').innerText(),/기한 지난 목표 있음[\s\S]*SW 등록 1건 더 필요/);

    await reader.locator('#rs-tab-outputs').click();
    assert.equal(await reader.locator('.rs-output').count(),4);
    assert.equal(await reader.evaluate(()=>window.__researchXSS),undefined);
    assert.equal(await reader.locator('.rs-output script').count(),0);
    assert.match(await reader.locator('.rs-output',{hasText:'국내 논문'}).innerText(),/사사 과제 미지정[\s\S]*어느 과제의 실적인지/);
    assert.match(await reader.locator('.rs-output',{hasText:'Published driving paper'}).locator('.rs-acks').innerText(),/IITP 멀티모달[\s\S]*RS-2025-00123456[\s\S]*SCI\(E\) 논문 · 2차년도 목표에 반영/);
    assert.match(await reader.locator('.rs-output',{hasText:'출원한 특허'}).locator('.rs-acks').innerText(),/특허 출원 목표에 반영/);
    await reader.locator('[data-rs-kind=patent]').click();
    assert.equal(await reader.locator('.rs-output').count(),1);
    assert.equal(await reader.evaluate(()=>document.activeElement.dataset.rsKind),'patent','choosing a kind keeps keyboard focus on its chip');
    assert.equal(await reader.locator('[data-rs-kind=patent]').getAttribute('aria-pressed'),'true');
    await reader.locator('[data-rs-kind=all]').click();
    await reader.locator('#rs-project-filter').selectOption('none');
    assert.equal(await reader.locator('.rs-output').count(),1);
    await reader.locator('#rs-project-filter').selectOption('all');
    await reader.locator('#rs-query').fill('submitted');
    assert.equal(await reader.locator('.rs-output').count(),1);
    await reader.locator('#rs-query').fill('');
    await reader.screenshot({path:path.join(output,'research-outputs-desktop.png'),fullPage:true});
    await reader.locator('#rs-tab-schedule').click();
    assert.match(await reader.locator('#rs-schedule').innerText(),/기한이 지났어요[\s\S]*SW 등록 1건 남음[\s\S]*다가오는 기한[\s\S]*연차보고서 제출[\s\S]*SCI\(E\) 논문 1편 남음[\s\S]*과제 종료/);
    await reader.locator('#rs-tab-acks').click();
    assert.equal(await reader.locator('#rs-acks [data-rs-ack-project]').count(),2);
    await reader.locator(`[data-rs-ack-project="${running.id}"] [data-rs-copied]`).click();
    assert.equal(await reader.evaluate(()=>navigator.clipboard.readText()),'RS-2025-00123456');
    await reader.locator('#rs-tab-acks').press('Home');
    assert.equal(await reader.locator('#rs-tab-projects').getAttribute('aria-selected'),'true');
    // Editing asks for the administrator connection; the stored file itself stays unreadable.
    await reader.locator('#rs-add-project').click();
    await reader.locator('#admin-dialog').waitFor();
    assert.equal(await reader.locator('#rs-feedback').innerText(),'관리자 연결 후 다시 눌러 주세요.');
    await reader.locator('#admin-dialog [data-close-dialog]').first().click();
    assert.equal(researchWrites,0);
    // A failed refresh keeps the last records on screen.
    researchUnavailable=true;
    await reader.locator('#rs-refresh').click();
    await reader.waitForFunction(()=>document.getElementById('rs-error').textContent==='연구과제 기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
    await reader.locator('[data-rs-phase=active]').click();
    assert.equal(await reader.locator('.rs-project').count(),1);
    assert.match(await reader.locator('#workspace-home').textContent(),/실적 1건 더 필요[\s\S]*마지막으로 받은 내용/);
    researchUnavailable=false;
    await reader.locator('#rs-refresh').click();
    await reader.waitForFunction(()=>!document.getElementById('rs-error').textContent);

    // The home summarises both workspaces; the hash keeps the view across Back and reload.
    await openView(reader,'home');
    assert.equal(await reader.title(),'CVML Workspace');
    await reader.waitForFunction(()=>document.getElementById('workspace-home').innerText.includes('여유 GPU'));
    assert.match(await reader.locator('#workspace-home').innerText(),/테스트 사용자님, 안녕하세요[\s\S]*실적 1\s*건 더 필요[\s\S]*여유 GPU[\s\S]*챙겨야 할 기한[\s\S]*연차보고서 제출/);
    await reader.screenshot({path:path.join(output,'workspace-home-desktop.png'),fullPage:true});
    await reader.locator('#workspace-home .ws-card').first().click();
    await reader.locator('#workspace-research').waitFor();
    assert.equal(new URL(reader.url()).hash,'#research');
    await reader.goBack();
    await reader.locator('#workspace-home').waitFor();
    await openView(reader,'gpu');
    await reader.locator('.current-gpu-table tbody tr').first().waitFor();
    assert.equal(await reader.title(),'GPU 대시보드 · CVML Workspace');
    assert.equal(await reader.locator('#workspace-home').isVisible(),false);
    await reader.locator('#tab-timeline').click();
    assert.equal(await reader.locator('#workspace-gpu-link').getAttribute('href'),'#timeline');
    // The bar's link follows the open tab however it was chosen, here with the arrow keys.
    await reader.locator('#tab-timeline').press('ArrowRight');
    assert.equal(await reader.locator('#tab-resources').getAttribute('aria-selected'),'true');
    assert.equal(await reader.locator('#workspace-gpu-link').getAttribute('href'),'#resources');
    // Leaving the dashboard stops its film: a hidden player must not keep sounding.
    await reader.evaluate(()=>{window.__filmPauses=0;document.querySelector('#gpu-workspace video').pause=()=>{window.__filmPauses++;};});
    await openView(reader,'home');
    assert.equal(await reader.evaluate(()=>window.__filmPauses),1);
    assert.equal(await reader.locator('#workspace-home .ws-card').nth(1).getAttribute('href'),'#resources');
    await reader.locator('#workspace-gpu-link').click();
    await reader.locator('#gpu-workspace').waitFor();
    assert.equal(await reader.locator('#tab-resources').getAttribute('aria-selected'),'true');
    await reader.locator('#tab-timeline').click();
    await reader.reload();
    await reader.locator('body[data-workspace=ready]').waitFor();
    assert.equal(await reader.locator('#gpu-workspace').isVisible(),true);
    assert.equal(await reader.locator('#tab-timeline').getAttribute('aria-selected'),'true');
    await reader.close();

    // The administrator adds and corrects records; every write goes out sealed.
    const admin=await context.newPage();admin.on('pageerror',error=>researchErrors.push(error.message));
    await enterStaging(admin,'research');
    await admin.locator('.rs-project').first().waitFor();
    await admin.locator('#rs-admin').click();
    await admin.locator('#admin-password').fill('cvml-test');
    await admin.locator('#admin-submit').click();
    await admin.waitForFunction(()=>document.getElementById('rs-access').textContent.includes('관리자 모드'));
    assert.equal(await admin.locator('#rs-admin').isVisible(),false);
    assert.equal(await admin.locator('#workspace-research').isVisible(),true);
    await admin.locator('#rs-add-project').click();
    await admin.locator('#rs-p-name').fill('NRF 경량화 과제');
    await admin.locator('#rs-project-save').click();
    assert.equal(await admin.locator('#rs-project-error').innerText(),'과제 종료일을 입력해 주세요.');
    assert.equal(researchWrites,0);
    await admin.locator('#rs-p-end').fill(kst(200));
    await admin.locator('#rs-p-number').fill('RS-2026-00000001');
    await admin.locator('#rs-p-ack-en').fill('Supported by NRF (No. RS-2026-00000001).');
    await admin.locator('#rs-p-targets [data-f=count]').first().fill('2');
    await admin.locator('#rs-p-target-add').click();
    const customTarget=admin.locator('#rs-p-targets .rs-row').nth(1);
    await customTarget.locator('[data-f=metric]').selectOption('custom');
    await customTarget.locator('[data-f=count]').fill('1');
    await admin.locator('#rs-project-save').click();
    assert.equal(await admin.locator('#rs-project-error').innerText(),'직접 입력한 목표에는 이름이 필요해요.');
    await customTarget.locator('[data-f=label]').fill('기술이전');
    await admin.screenshot({path:path.join(output,'research-project-form-desktop.png')});
    await admin.locator('#rs-project-save').click();
    await admin.locator('#rs-project-dialog').waitFor({state:'hidden'});
    assert.equal(researchWrites,1);
    assert.equal(await admin.locator('#rs-feedback').innerText(),'과제를 추가했어요.');
    const added=researchDoc.projects.find(project=>project.name==='NRF 경량화 과제');
    assert.deepEqual([added.updated_by,added.targets.length,researchDoc.revision],['테스트 사용자',2,5]);
    assert.equal(/NRF|RS-2026|기술이전/.test(JSON.stringify(researchSealed)),false);
    const fresh=admin.locator(`[data-rs-project="${added.id}"]`);
    assert.match(await fresh.locator('.rs-verdict').innerText(),/SCI\(E\) 논문 2편 · 기술이전 1건 더 필요/);
    await fresh.locator('[data-rs-action=output-for]').click();
    assert.equal(await admin.locator(`#rs-o-acks [data-rs-ack="${added.id}"] [data-f=on]`).isChecked(),true);
    await admin.locator('#rs-o-title').fill('Tiny ViT 논문');
    await admin.locator('#rs-o-status').selectOption('accepted');
    await admin.locator('#rs-output-save').click();
    await admin.locator('#rs-output-dialog').waitFor({state:'hidden'});
    assert.equal(researchWrites,2);
    // 게재 확정 is still on the way; it counts once it is published.
    assert.match(await fresh.locator('tr[data-rs-target]').first().innerText(),/0\s*\/ 2편[\s\S]*게재 확정 1[\s\S]*2편 더 필요/);
    await admin.locator('#rs-tab-outputs').click();
    const tiny=admin.locator('.rs-output',{hasText:'Tiny ViT 논문'});
    await tiny.locator('[data-rs-action=output-edit]').click();
    assert.equal(await admin.locator('#rs-o-status').inputValue(),'accepted');
    await admin.locator('#rs-o-status').selectOption('published');
    await admin.locator('#rs-o-date').fill(kst(-1));
    await admin.locator('#rs-output-save').click();
    await admin.locator('#rs-output-dialog').waitFor({state:'hidden'});
    assert.equal(researchWrites,3);
    await admin.locator('#rs-tab-projects').click();
    assert.match(await fresh.locator('tr[data-rs-target]').first().innerText(),/1\s*\/ 2편[\s\S]*1편 더 필요/);
    // Someone else changes the same record first: the stale save is refused, nothing is overwritten.
    await admin.locator('#rs-tab-outputs').click();
    await tiny.locator('[data-rs-action=output-edit]').click();
    const elsewhere=structuredClone(researchDoc),touched=elsewhere.outputs.find(item=>item.title==='Tiny ViT 논문');
    touched.note='다른 관리자가 먼저 수정';touched.updated_at=new Date().toISOString();elsewhere.revision++;
    await sealResearch(validateResearch(elsewhere));
    await admin.locator('#rs-o-title').fill('Tiny ViT 논문 (덮어쓰기 시도)');
    await admin.locator('#rs-output-save').click();
    await admin.getByText('다른 사람이 먼저 수정했어요. 창을 닫고 최신 내용을 확인한 뒤 다시 저장해 주세요.',{exact:true}).waitFor();
    assert.equal(researchWrites,3);
    await admin.locator('#rs-output-dialog [data-rs-close]').first().click();
    await admin.locator('#rs-refresh').click();
    await admin.locator('.rs-output',{hasText:'다른 관리자가 먼저 수정'}).waitFor();
    // A refused write keeps the form open, and the same save succeeds once it is allowed.
    researchForbidden=true;
    await tiny.locator('[data-rs-action=output-edit]').click();
    await admin.locator('#rs-o-note').fill('권한 오류 뒤 다시 저장');
    await admin.locator('#rs-output-save').click();
    await admin.getByText('GitHub 요청 제한 또는 쓰기 권한을 확인해 주세요.',{exact:true}).waitFor();
    assert.equal(await admin.locator('#rs-output-dialog').evaluate(dialog=>dialog.open),true);
    researchForbidden=false;
    await admin.locator('#rs-output-save').click();
    await admin.locator('#rs-output-dialog').waitFor({state:'hidden'});
    assert.equal(researchWrites,4);
    await admin.locator('.rs-output',{hasText:'Submitted paper'}).locator('[data-rs-action=output-edit]').click();
    await admin.locator('#rs-output-delete').click();
    assert.match(await admin.locator('#rs-confirm-text').innerText(),/Submitted paper/);
    await admin.locator('#rs-confirm-ok').click();
    await admin.locator('#rs-confirm-dialog').waitFor({state:'hidden'});
    assert.equal(researchWrites,5);
    assert.equal(researchDoc.outputs.some(item=>item.title==='Submitted paper'),false);
    assert.equal(await admin.locator('.rs-output').count(),4);
    // A project that outputs acknowledge cannot be deleted, only archived.
    await admin.locator('#rs-tab-projects').click();
    await admin.locator(`[data-rs-project="${running.id}"] [data-rs-action=project-edit]`).click();
    assert.equal(await admin.locator('#rs-p-ack-patent').inputValue(),'과제고유번호 RS-2025-00123456 · 기여율 1/1');
    await admin.locator('#rs-project-delete').click();
    await admin.locator('#rs-confirm-ok').click();
    await admin.getByText(/이 과제를 사사한 실적이 2건 있어요/).waitFor();
    assert.equal(researchWrites,5);
    await admin.locator('#rs-confirm-cancel').click();
    await admin.locator('#rs-p-archived').check();
    await admin.locator('#rs-project-save').click();
    await admin.locator('#rs-project-dialog').waitFor({state:'hidden'});
    assert.equal(researchWrites,6);
    assert.equal(await admin.locator('[data-rs-phase=archived]').getAttribute('aria-pressed'),'true');
    assert.equal(await admin.locator('.rs-project').count(),1);
    assert.equal(await admin.locator('#rs-count-active').innerText(),'1');
    assert.deepEqual(researchErrors,[]);

    for(const width of [390,320]){
      await admin.setViewportSize({width,height:844});
      await admin.locator('#rs-tab-projects').click();
      // The archived project is the full card: a date range, a milestone and linked outputs.
      await admin.locator('[data-rs-phase=archived]').click();
      await admin.locator(`[data-rs-project="${running.id}"] details.rs-fold`).first().evaluate(fold=>{fold.open=true;});
      assert.ok(await fits(admin),`a full project card overflows at ${width}px`);
      await admin.screenshot({path:path.join(output,`research-project-card-mobile-${width}.png`),fullPage:true});
      await admin.locator('[data-rs-phase=active]').click();
      for(const name of ['projects','outputs','schedule','acks']){
        await admin.locator('#rs-tab-'+name).click();
        assert.ok(await fits(admin),`research ${name} overflows at ${width}px`);
        if(name==='projects')await admin.screenshot({path:path.join(output,`research-projects-mobile-${width}.png`),fullPage:true});
      }
      await admin.locator('#rs-add-project').click();
      assert.ok(await admin.locator('#rs-project-dialog').evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth+1),`project form overflows at ${width}px`);
      // A date needs room to be read while it is typed; the count beside it must not squeeze it.
      const dueWidth=await admin.locator('#rs-p-targets [data-f=due_on]').first().evaluate(input=>input.getBoundingClientRect().width);
      assert.ok(dueWidth>=140,`the target deadline field is only ${dueWidth}px wide at ${width}px`);
      await admin.locator('#rs-p-targets').scrollIntoViewIfNeeded();
      await admin.screenshot({path:path.join(output,`research-project-form-${width}.png`)});
      await admin.locator('#rs-project-dialog [data-rs-close]').first().click();
      await admin.locator('#rs-add-output').click();
      assert.ok(await admin.locator('#rs-output-dialog').evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth+1),`output form overflows at ${width}px`);
      await admin.screenshot({path:path.join(output,`research-output-form-${width}.png`)});
      await admin.locator('#rs-output-dialog [data-rs-close]').first().click();
      await openView(admin,'home');
      assert.ok(await fits(admin),`workspace home overflows at ${width}px`);
      await admin.screenshot({path:path.join(output,`workspace-home-mobile-${width}.png`),fullPage:true});
      await openView(admin,'research');
    }
    await admin.setViewportSize({width:1440,height:1000});
    // Locking the administrator connection removes the edit controls again.
    await admin.evaluate(()=>document.getElementById('admin-logout').click());
    await admin.waitForFunction(()=>!document.querySelector('#workspace-research [data-rs-action]'));
    assert.match(await admin.locator('#rs-access').innerText(),/읽기 전용/);

    // "모든 목표 달성" is never claimed for a project that ended short, or one without targets.
    const summaryNote=text=>admin.waitForFunction(expected=>document.querySelector('#rs-summary .rs-stat:nth-child(2) p')?.textContent.includes(expected),text);
    await sealResearch(validateResearch({schema_version:1,revision:researchDoc.revision+1,updated_at:made.at,projects:[ended],outputs:[]}));
    await admin.locator('#rs-refresh').click();
    await summaryNote('기한 지난 목표 1건');
    assert.equal(await admin.locator('#rs-summary .rs-stat.ok').count(),0);
    await openView(admin,'home');
    assert.equal(await admin.locator('#workspace-home .ws-card-title').first().innerText(),'기한 지난 목표 1건');
    await openView(admin,'research');
    await sealResearch(validateResearch({schema_version:1,revision:researchDoc.revision+1,updated_at:made.at,projects:[makeProject({name:'목표 없는 과제',ends_on:kst(100),targets:[]},made)],outputs:[]}));
    await admin.locator('#rs-refresh').click();
    await summaryNote('목표 실적을 등록하면');
    await openView(admin,'home');
    assert.match(await admin.locator('#workspace-home .ws-card').first().innerText(),/목표 실적 미등록[\s\S]*목표 미등록 1개/);
    assert.doesNotMatch(await admin.locator('#workspace-home').innerText(),/모든 목표 달성/);
    await openView(admin,'research');

    // Signing out closes the workspace; staying signed in is opt-in and ends everywhere at once.
    await admin.locator('#workspace-logout').click();
    await admin.waitForURL(stagingEntry);
    assert.equal(await admin.getByLabel('이름').inputValue(),'테스트 사용자');
    await admin.goto(stagingPreview+'#research');
    await admin.waitForURL(stagingEntry+'?panel=research');
    await admin.getByLabel('비밀번호',{exact:true}).fill(workspacePassword);
    await admin.getByLabel(/로그인 유지/).check();
    await admin.getByRole('button',{name:'로그인'}).click();
    await admin.waitForURL(stagingPreview+'#research');
    await admin.locator('body[data-workspace=ready]').waitFor();
    const remembered=await context.newPage();remembered.on('pageerror',error=>researchErrors.push(error.message));
    await remembered.goto(stagingEntry);
    await remembered.waitForURL(stagingPreview);
    await remembered.locator('body[data-workspace=ready]').waitFor();
    assert.equal(await remembered.locator('#workspace-user').innerText(),'테스트 사용자님');
    await remembered.locator('#workspace-logout').click();
    await remembered.waitForURL(stagingEntry);
    await admin.waitForURL(stagingEntry+'?panel=research');
    assert.equal(await admin.evaluate(()=>localStorage.getItem('cvml.workspace.session.v1')),null);
    await remembered.close();await admin.close();
    assert.deepEqual(researchErrors,[]);
  }

  console.log('Browser checks passed: existing dashboard workflows plus the test-server workspace (sign-in, home, sealed research records), live data, shared editor, stale GPU/API handling, tabs, details, refresh and 320/390px layouts.');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => host.close(resolve));
}
