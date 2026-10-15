// All GitHub requests are intercepted. This test never writes to the real repo.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {emptyEdits, encodeJSON, decodeJSON} from '../dist/edits.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const {chromium} = await import(runtime ? pathToFileURL(path.join(runtime, 'playwright/index.mjs')).href : 'playwright');
const output = process.env.GPU_TIMELINE_SCREENSHOTS || '/tmp/gpu-timeline-browser';
await fs.mkdir(output, {recursive: true});
const host = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const filename = path.resolve(root, 'dist', `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filename.startsWith(path.join(root, 'dist') + path.sep)) throw new Error('path');
    const bytes = await fs.readFile(filename);
    const types = {'.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.mp4': 'video/mp4', '.gif': 'image/gif', '.jpg': 'image/jpeg'};
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
  const telemetry = id => ({server_id: id, name: `Server ${id.slice(-1).toUpperCase()}`, updated_at: iso(id === 'server-c' && serverCStale ? -2 : 0), collector_ok: true,
    agent_version: id === 'server-b' ? {version: '1.1.2', revision: 'b'.repeat(40)} : id === 'server-a' && serverUpgraded ? {version: '1.1.5', revision: 'a'.repeat(40)} : null,
    gpus: [{uuid: `${id}-gpu`, index: 0, name: 'NVIDIA GeForce RTX 4090', process_count: 0, utilization: 0,
      memory_used_mib: 0, memory_total_mib: 24564}],
    jobs: id === 'server-a' ? [{id: 'job-original', name: 'GEPA collector', owner: '상현', gpu_uuids: [`${id}-gpu`],
      started_at: iso(-2), expected_end_at: iso(2), eta_source: 'progress',
      progress: {completed: progressCompleted, total: 100, updated_at: iso(0)},
      ended_at: collectorFinished ? iso(0) : null, status: collectorFinished ? 'completed' : 'running'}] : []});
  const fulfill = (route, body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
  await context.route('https://fonts.gstatic.com/**', route => route.abort());
  await context.route('**/version.json*', route => fulfill(route, {version: '1.1.5', revision: 'a'.repeat(40)}));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.route('**/config.json*', async route => {
    const config = JSON.parse(await fs.readFile(path.join(root, 'dist/config.json'), 'utf8'));
    config.servers[2].actions = [{title: '서버 C 점검 <script>', description: '이 서버에서만 보이는 안내', command: 'echo \"점검 & 확인\"'}];
    return fulfill(route, config);
  });
  await context.route('https://raw.githubusercontent.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/hardware-prices/prices.json')) return fulfill(route, JSON.parse(await fs.readFile(path.join(root, 'dist/hardware-prices.json'), 'utf8')));
    if (url.pathname.endsWith('/dashboard/edits.json')) {
      assert.equal(route.request().headers().authorization, undefined);
      if (failRaw) return fulfill(route, {}, 503);
      return fulfill(route, staleRaw ? emptyEdits() : data);
    }
    const match = url.pathname.match(/servers\/(server-[abc])\.json$/);
    assert.ok(match, url.pathname);
    return fulfill(route, telemetry(match[1]));
  });
  await context.route('https://api.github.com/**', route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(request.headers().authorization, 'Bearer test-browser-only-token');
    if (url.pathname === '/user') return fulfill(route, {login: 'cvml-admin'});
    if (url.pathname === '/repos/shxyzn/gpu-timeline') return fulfill(route, {permissions: {push: true}});
    if (url.pathname.endsWith('/git/ref/heads/status')) return fulfill(route, {ref: 'refs/heads/status'});
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
  await calendarPage.goto(base);
  const nationalDay = calendarPage.locator('.tick.holiday[title="10/3 (토) · 개천절"]').first();
  await nationalDay.waitFor();
  assert.equal(await nationalDay.locator('.tick-weekday').evaluate(e => getComputedStyle(e).color), 'rgb(182, 75, 84)');
  assert.equal(await nationalDay.locator('strong').evaluate(e => getComputedStyle(e).color), 'rgb(182, 75, 84)');
  assert.match(await calendarPage.locator('#calendar-note').innerText(), /10\/5 대체공휴일 · 개천절/);
  await calendarPage.setViewportSize({width: 390, height: 844});
  assert.ok(await calendarPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await calendarPage.screenshot({path: path.join(output, 'holidays-mobile.png'), fullPage: true});
  await calendarPage.close();
  await page.goto(base);
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
  await page.locator('[data-job="job-original"]').waitFor();
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
  assert.equal(await page.locator('[data-manage-server]').count(), 3);
  assert.equal(await page.locator('#deployment-version').count(), 0);
  assert.match(await page.locator('#dashboard-version').innerText(), /v1\.1\.5\+aaaaaaa/);
  assert.match(await page.locator('.server-version').nth(0).innerText(), /v1\.0\.0/);
  assert.match(await page.locator('.server-version').nth(1).innerText(), /v1\.1\.2\+bbbbbbb/);
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
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
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

  await page.locator('[data-job="job-original"]').click();
  await page.locator('[data-delete-experiment]').click();
  await page.locator('#delete-form button[type=submit]').click();
  await page.locator('#delete-dialog').waitFor({state: 'hidden'});
  assert.equal(data.hidden_jobs.length, 1);
  assert.equal(await page.locator('[data-job="job-original"]').count(), 0);
  assert.match(await page.locator('#overview .stat').nth(1).innerText(), /1/);

  staleRaw = true;
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  assert.equal(await page.locator('[data-job="job-original"]').count(), 0);
  assert.equal(await page.locator('.job-bar.manual').count(), 1);
  failRaw = true;
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  assert.match(await page.locator('#edit-notice').innerText(), /수신 실패/);
  assert.equal(await page.locator('[data-job="job-original"]').count(), 0);
  failRaw = false; staleRaw = false;

  // A separate visitor immediately sees shared edits without credentials.
  const visitor = await context.newPage();
  await visitor.goto(base);
  await visitor.locator('.job-bar.manual').waitFor();
  assert.equal(await visitor.locator('[data-job="job-original"]').count(), 0);
  assert.equal(await visitor.locator('#admin-tools').isVisible(), false);
  await visitor.close();

  await page.locator('#record-list').click();
  await page.locator('[data-record-action=restore]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-record-action=restore]').length === 0);
  assert.equal(data.hidden_jobs.length, 0);
  await page.locator('[data-close-dialog=records-dialog]').click();
  assert.equal(await page.locator('[data-job="job-original"]').count(), 1);

  // Denied writes must remain visible as errors with no optimistic removal.
  forbidden = true;
  await page.locator('[data-job="job-original"]').click();
  await page.locator('[data-delete-experiment]').click();
  await page.locator('#delete-form button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('delete-error').textContent.includes('권한'));
  assert.equal(data.hidden_jobs.length, 0);
  assert.equal(await page.locator('[data-job="job-original"]').count(), 1);
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
  await page.locator('[data-job="job-original"]').click();
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
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  await page.locator('[data-job="job-original"]').click();
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
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('[data-token-action=remove]').click();
  await page.locator('.openrouter-card').waitFor({state:'hidden'});
  assert.deepEqual(data.openrouter_tokens,[]);

  // The retimed media must still decode and seek through the full 60 seconds.
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.promo-note-link').click();
  await page.locator('#release-video').screenshot({path:path.join(output,'promo-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await page.locator('#release-video').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#release-video').screenshot({path:path.join(output,'promo-mobile.png')});
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
  assert.deepEqual(errors,[]);

  console.log('Browser checks passed: per-server management, baseline/report versions, copied pinned commands, no management writes, logout, mobile, login, add/hide/restore, manual editing, collector time overrides and reset, automatic completion/progress, no-op and precision, conflicts/errors, KST, mobile.');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => host.close(resolve));
}
