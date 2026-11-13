#!/usr/bin/env node
// Walks an unpacked GitHub Pages artifact the way a visitor would, for sessions that cannot open
// https://shxyzn.github.io/ directly. The artifact of a "Publish GPU Timeline" run is exactly
// what Pages serves: download github-pages-<run>-<attempt>.zip, unpack artifact.tar, then
//
//   node scripts/verify_deployed.mjs <site-dir> --notice visible|hidden [--revision <sha>]
//
// The site is served under /gpu-timeline/ so relative paths resolve as they do live. The
// sign-in gate is swapped for a throwaway one, so the real workspace password is not needed and
// no stored research record is opened. Dashboard data still comes from the network.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
const site = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
const notice = option('--notice'), revision = option('--revision');
if (!site || !['visible', 'hidden'].includes(notice)) {
  console.error('Usage: verify_deployed.mjs <site-dir> --notice visible|hidden [--revision <sha>]');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.GPU_TIMELINE_NODE_MODULES || process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const {chromium} = await import(runtime ? pathToFileURL(path.join(runtime, 'playwright/index.mjs')).href : 'playwright');
const {sealGate} = await import(pathToFileURL(path.join(root, 'dist/test-server/workspace-crypto.js')).href);

let failed = 0;
const check = (name, passed, detail = '') => { console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!passed) failed++; };
const types = {'.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.gif': 'image/gif'};
const outside = new Set();
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  try {
    if (!pathname.startsWith('/gpu-timeline/')) throw new Error('outside the site');
    let relative = pathname.slice('/gpu-timeline/'.length);
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const file = path.resolve(site, relative);
    if (!file.startsWith(site + path.sep)) throw new Error('path');
    const bytes = await fs.readFile(file);
    response.writeHead(200, {'Content-Type': types[path.extname(file)] || 'text/plain', 'Content-Length': bytes.length}).end(bytes);
  } catch { outside.add(pathname); response.writeHead(404).end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/gpu-timeline`;
let browser;
try {
  const build = JSON.parse(await fs.readFile(path.join(site, 'version.json'), 'utf8'));
  check('version.json names a clean build', /^\d+\.\d+\.\d+$/.test(build.version) && /^[0-9a-f]{40}$/.test(build.revision) && build.dirty === false, `v${build.version}+${build.revision.slice(0, 7)}`);
  if (revision) check('artifact was built from the expected commit', build.revision.startsWith(revision), build.revision);

  browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, locale: 'ko-KR', timezoneId: 'Asia/Seoul'});
  const password = 'deployment-check-only', gate = await sealGate(password, crypto.getRandomValues(new Uint8Array(32)), {iterations: 100000});
  await context.route('**/test-server/gate.js*', route => route.fulfill({contentType: 'text/javascript', body: `export const GATE=Object.freeze(${JSON.stringify(gate)});`}));
  await context.route('https://raw.githubusercontent.com/**/dashboard/research-test.json*', route => route.fulfill({status: 404, contentType: 'application/json', body: '{}'}));
  const errors = [];

  const staging = await context.newPage();
  staging.on('pageerror', error => errors.push('test server: ' + error.message));
  await staging.goto(base + '/test-server/preview.html#research');
  await staging.waitForURL(base + '/test-server/?panel=research');
  check('a signed-out link returns to the sign-in page', true, await staging.locator('.entry-version').innerText());
  await staging.getByLabel('이름').fill('배포 확인');
  await staging.getByLabel('비밀번호', {exact: true}).fill(password);
  await staging.getByRole('button', {name: '로그인'}).click();
  await staging.waitForURL(base + '/test-server/preview.html#research');
  await staging.locator('body[data-workspace=ready]').waitFor();
  check('the workspace opens on the requested view', await staging.locator('#workspace-research').isVisible());
  const banner = staging.locator('#maintenance-notice');
  const shown = await banner.isVisible();
  check(`the maintenance notice is ${notice}`, shown === (notice === 'visible'),
    shown ? `${await staging.locator('#maintenance-start').getAttribute('datetime')} → ${await staging.locator('#maintenance-end').getAttribute('datetime')}` : '');
  if (shown) {
    const stamp = id => staging.locator(id).evaluate(time => [time.dateTime, time.textContent.trim()]);
    const kst = iso => {
      const part = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(iso)).map(p => [p.type, p.value]));
      return `${part.year}. ${part.month}. ${part.day}. ${part.hour}:${part.minute}`;
    };
    for (const id of ['#maintenance-start', '#maintenance-end']) { const [iso, text] = await stamp(id); check(`${id} shows the same KST time as its datetime`, kst(iso) === text, `${iso} / ${text}`); }
  }
  await staging.locator('.ws-nav [data-ws-view=gpu]').click();
  await staging.locator('#gpu-workspace').waitFor();
  const rows = await staging.locator('.current-gpu-table tbody tr').first().waitFor({timeout: 20000}).then(() => true, () => false);
  check('the GPU dashboard shows server rows (needs the status branch to be reachable)', rows);
  await staging.waitForFunction(() => /^테스트 v/.test(document.getElementById('dashboard-version').textContent), null, {timeout: 10000}).catch(() => {});
  check('the test server names its snapshot and build', /^테스트 v3\.0 snapshot \d+\+[0-9a-f]{7}$/.test(await staging.locator('#dashboard-version').innerText()), await staging.locator('#dashboard-version').innerText());
  await staging.locator('#workspace-logout').click();
  await staging.waitForURL(base + '/test-server/');
  check('signing out returns to the sign-in page', true);

  const production = await context.newPage();
  production.on('pageerror', error => errors.push('production: ' + error.message));
  await production.goto(base + '/');
  await production.waitForFunction(() => /^대시보드 v\d/.test(document.getElementById('dashboard-version').textContent), null, {timeout: 20000}).catch(() => {});
  check('production shows the release version', (await production.locator('#dashboard-version').innerText()).startsWith(`대시보드 v${build.version}+`), await production.locator('#dashboard-version').innerText());
  check('production keeps its notice hidden and has no workspace bar', !(await production.locator('#production-maintenance-notice').isVisible()) && (await production.locator('.ws-bar').count()) === 0);
  check('production links to the test server', (await production.locator('#test-server-link').getAttribute('href')) === './test-server/');
  check('no script errors on either page', errors.length === 0, errors.join(' | '));
  if (outside.size) console.log('NOTE  requests that fell outside the site: ' + [...outside].join(', '));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
console.log(failed ? `${failed} check(s) failed.` : 'Deployed site verified.');
process.exit(failed ? 1 : 0);
