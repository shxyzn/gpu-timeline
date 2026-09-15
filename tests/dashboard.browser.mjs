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
let browser;
try {
  browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, timezoneId: 'America/Los_Angeles'});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const now = new Date(), iso = hours => new Date(now.getTime() + hours * 3600000).toISOString();
  let data = emptyEdits(), staleRaw = false, failRaw = false, forbidden = false, writes = 0;
  const telemetry = id => ({server_id: id, name: `Server ${id.slice(-1).toUpperCase()}`, updated_at: iso(0), collector_ok: true,
    gpus: [{uuid: `${id}-gpu`, index: 0, name: 'NVIDIA GeForce RTX 4090', process_count: 0, utilization: 0,
      memory_used_mib: 0, memory_total_mib: 24564}],
    jobs: id === 'server-a' ? [{id: 'job-original', name: 'GEPA collector', owner: '상현', gpu_uuids: [`${id}-gpu`],
      started_at: iso(-2), expected_end_at: iso(2), ended_at: null, status: 'running'}] : []});
  const fulfill = (route, body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({body: '', contentType: 'text/css'}));
  await context.route('https://fonts.gstatic.com/**', route => route.abort());
  await context.route('**/version.json*', route => fulfill(route, {version: '1.1.1', revision: 'a'.repeat(40)}));
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
  await page.locator('#admin-login').click();
  await page.locator('#admin-password').fill('cvml-test');
  await page.locator('#admin-password-confirm').fill('cvml-test');
  await page.locator('#admin-token').fill('test-browser-only-token');
  await page.locator('#admin-submit').click();
  await page.locator('#admin-tools').waitFor();
  assert.equal(await page.locator('#admin-dialog').evaluate(e => e.open), false);
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  assert.equal(storage.includes('test-browser-only-token'), false);
  assert.equal(storage.includes('cvml-test'), false);

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
  await page.locator('[data-close-dialog=delete-dialog]').click();
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
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#manual-add').click();
  assert.ok(await page.locator('#manual-dialog').evaluate(e => e.scrollWidth <= e.clientWidth));
  await page.screenshot({path: path.join(output, 'add-mobile.png')});
  await page.locator('[data-close-dialog=manual-dialog]').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: path.join(output, 'dashboard-mobile.png'), fullPage: true});
  assert.deepEqual(errors, []);
  assert.equal(writes, 3);
  console.log('Browser checks passed: setup, password unlock, shared add/hide/restore, denied writes, stale/offline reads, telemetry occupancy, reload lock, KST, mobile.');
  console.log(`Screenshots: ${output}`);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => host.close(resolve));
}
