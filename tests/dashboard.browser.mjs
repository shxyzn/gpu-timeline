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
    const types = {'.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css'};
    response.writeHead(200, {'Content-Type': types[path.extname(filename)] || 'text/plain'}).end(bytes);
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
    agent_version: id === 'server-b' ? {version: '1.1.2', revision: 'b'.repeat(40)} : id === 'server-a' && serverUpgraded ? {version: '1.1.4', revision: 'a'.repeat(40)} : null,
    gpus: [{uuid: `${id}-gpu`, index: 0, name: 'NVIDIA GeForce RTX 4090', process_count: 0, utilization: 0,
      memory_used_mib: 0, memory_total_mib: 24564}],
    jobs: id === 'server-a' ? [{id: 'job-original', name: 'GEPA collector', owner: '상현', gpu_uuids: [`${id}-gpu`],
      started_at: iso(-2), expected_end_at: iso(2), eta_source: 'progress',
      progress: {completed: progressCompleted, total: 100, updated_at: iso(0)},
      ended_at: collectorFinished ? iso(0) : null, status: collectorFinished ? 'completed' : 'running'}] : []});
  const fulfill = (route, body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
  await context.route('https://fonts.gstatic.com/**', route => route.abort());
  await context.route('**/version.json*', route => fulfill(route, {version: '1.1.4', revision: 'a'.repeat(40)}));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.route('**/config.json*', async route => {
    const config = JSON.parse(await fs.readFile(path.join(root, 'dist/config.json'), 'utf8'));
    config.servers[2].actions = [{title: '서버 C 점검 <script>', description: '이 서버에서만 보이는 안내', command: 'echo \"점검 & 확인\"'}];
    return fulfill(route, config);
  });
  await context.route('https://raw.githubusercontent.com/**', route => {
    const url = new URL(route.request().url());
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
  const base = `http://127.0.0.1:${host.address().port}`;
  await page.goto(base);
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
  assert.match(await page.locator('#dashboard-version').innerText(), /v1\.1\.4\+aaaaaaa/);
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
  await page.waitForFunction(() => document.getElementById('server-manage-installed').textContent === 'v1.1.4+aaaaaaa (latest)');
  assert.equal(await page.locator('#server-update-command').count(), 0);
  assert.match(await page.locator('#server-manage-source').innerText(), /수집기/);
  await page.locator('#server-manage-close').click();
  await page.locator('[data-manage-server=server-b]').click();
  assert.match(await page.locator('.server-action-overview').innerText(), /추가 적용할 서버 기능 안내가 없/);
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
  console.log('Browser checks passed: per-server management, baseline/report versions, copied pinned commands, no management writes, logout, mobile, login, add/hide/restore, manual editing, collector time overrides and reset, automatic completion/progress, no-op and precision, conflicts/errors, KST, mobile.');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => host.close(resolve));
}
