import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PROFILE as STAGING} from '../dist/test-server/profile.js';
import {PROFILE as PRODUCTION} from '../dist/release/profile.js';
import {RESEARCH_PATH as STAGING_RESEARCH} from '../dist/test-server/research-store.js';
import {RESEARCH_PATH as PRODUCTION_RESEARCH} from '../dist/release/research-store.js';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const read = file => fs.readFileSync(file, 'utf8');

// Every address a module or page of one layer loads: {from, specifier}.
function references(directory, pages) {
  const found = [];
  for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.js'))) {
    const source = read(path.join(directory, name));
    for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\1/g)) found.push({from: path.join(directory, name), specifier: m[2]});
  }
  for (const page of pages) {
    for (const m of read(page).matchAll(/(?:src|href)="(\.\.?\/[^"#]+\.(?:js|css)(?:\?[^"]*)?)"/g)) found.push({from: page, specifier: m[1].replaceAll('&amp;', '&')});
  }
  return found;
}
const target = ref => path.resolve(path.dirname(ref.from), ref.specifier.split('?')[0]);

function checkLayer(name, directory, pages) {
  const refs = references(directory, pages);
  assert.ok(refs.length > 20, `${name}: the reference scan found too little to be trusted`);
  const addresses = new Map();
  for (const ref of refs) {
    const file = target(ref);
    assert.ok(fs.existsSync(file), `${name}: ${path.relative(dist, ref.from)} loads ${ref.specifier}, which does not exist`);
    // A module loaded under two addresses runs twice: two controllers, two copies of the state.
    if (!file.endsWith('.js')) continue;
    if (!addresses.has(file)) addresses.set(file, new Map());
    const address = path.relative(dist, file) + (ref.specifier.includes('?') ? '?' + ref.specifier.split('?')[1] : '');
    addresses.get(file).set(address, path.relative(dist, ref.from));
  }
  for (const [file, seen] of addresses) {
    // The dashboard core and the layer's own modules hold state; shared helpers outside the layer
    // (../edits.js, ../usage.js) are stateless and are also loaded by the core with its own address.
    const stateful = file === path.join(dist, 'app.js') || path.dirname(file) === directory;
    if (stateful) assert.equal(seen.size, 1, `${name}: ${path.relative(dist, file)} is loaded under different addresses: ${[...seen].map(([a, f]) => `${a} (in ${f})`).join(', ')}`);
  }
  return refs;
}

test('the test server loads every module under one address', () => {
  const directory = path.join(dist, 'test-server');
  const refs = checkLayer('test server', directory, [path.join(directory, 'index.html'), path.join(directory, 'preview.html')]);
  assert.ok(refs.some(ref => target(ref) === path.join(dist, 'app.js')), 'the test server loads the dashboard core');
});

test('the test-server profile names its own pages and documents', () => {
  assert.equal(STAGING.name, 'test');
  assert.deepEqual(STAGING.pages, {entry: './', workspace: './preview.html'});
  assert.deepEqual(STAGING.files, {research: 'dashboard/research-test.json', monitoring: 'dashboard/monitoring-test.json', usage: 'dashboard/openrouter-usage-test.json'});
  for (const page of Object.values(STAGING.pages)) assert.ok(fs.existsSync(path.join(dist, 'test-server', page === './' ? 'index.html' : page)));
});

test('production loads every module under one address, from the release layer', () => {
  const directory = path.join(dist, 'release'), pages = [path.join(dist, 'index.html'), path.join(dist, 'login.html')];
  const refs = checkLayer('production', directory, pages);
  assert.ok(refs.some(ref => target(ref) === path.join(dist, 'app.js')), 'production loads the dashboard core');
  // A production page that reached into the test server would change whenever staging does.
  for (const ref of refs) assert.equal(target(ref).startsWith(path.join(dist, 'test-server') + path.sep), false, `${path.relative(dist, ref.from)} loads ${ref.specifier}`);
  for (const page of pages) {
    const html = read(page);
    assert.equal(/snapshot|data-staging-version/.test(html), false, `${path.basename(page)} carries a staging label`);
    assert.deepEqual([...html.matchAll(/test-server\//g)].length, page.endsWith('index.html') ? 1 : 0, `${path.basename(page)}: only the workspace links to the test server, once`);
  }
  const workspace = read(pages[0]);
  assert.match(workspace, /<a id="test-server-link" class="priority-home" href="\.\/test-server\/">테스트 서버<\/a>/);
  // Shown or hidden, the notice is written the one way scripts/promote_release.mjs reads it back.
  assert.match(workspace, /<aside id="production-maintenance-notice"( hidden)? class="maintenance-notice" role="status" aria-labelledby="production-maintenance-title">/);
  for (const part of ['start', 'end']) assert.match(workspace, new RegExp(`<time id="production-maintenance-${part}" datetime="\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\+09:00">\\d{4}\\. \\d{2}\\. \\d{2}\\. \\d{2}:\\d{2}</time>`));
  assert.equal(/id="maintenance-(notice|title|start|end)"/.test(workspace), false, 'the production notice keeps its own ids');
  const version = read(path.resolve(dist, '../VERSION')).trim();
  assert.ok(workspace.includes(`<strong>CVML Workspace</strong><span>v${version}</span>`), 'the workspace names the release in VERSION');
  assert.ok(read(pages[1]).includes(`<p class="entry-version">v${version}</p>`), 'the sign-in page names the release in VERSION');
});

test('the shared core does not know either site', () => {
  // A file directly under dist/ serves both sites. If it named a layer it would decide, a second
  // time and under its own never-changing address, which site it runs for.
  const shared = fs.readdirSync(dist).filter(name => name.endsWith('.js'));
  assert.ok(shared.includes('app.js') && shared.length > 5);
  for (const name of shared) assert.equal(/release\/|test-server\//.test(read(path.join(dist, name))), false, `dist/${name} names a layer`);
});

test('the release layer is exactly what was promoted', () => {
  // scripts/promote_release.mjs stamps the workspace page with a digest of the modules it copied.
  // A module edited by hand, or a promotion that stopped half way, no longer matches the stamp.
  const directory = path.join(dist, 'release'), digest = createHash('sha256');
  const modules = fs.readdirSync(directory).filter(name => /\.(js|css)$/.test(name) && name !== 'profile.js' && name !== 'gate.js').sort();
  assert.ok(modules.length > 20);
  for (const name of modules) digest.update(name + '\0').update(fs.readFileSync(path.join(directory, name))).update('\0');
  const stamp = read(path.join(dist, 'index.html')).match(/<meta name="release-modules" content="([0-9a-f]{64})">/);
  assert.ok(stamp, 'dist/index.html carries no release stamp: run scripts/promote_release.mjs');
  assert.equal(digest.digest('hex'), stamp[1], 'dist/release/ differs from what scripts/promote_release.mjs released');
});

test('the two sites keep separate documents and offer the same profile fields', () => {
  assert.equal(PRODUCTION.name, 'production');
  assert.deepEqual(PRODUCTION.pages, {entry: '../login.html', workspace: '../'});
  assert.deepEqual(PRODUCTION.files, {research: 'dashboard/research.json', monitoring: 'dashboard/monitoring.json', usage: 'dashboard/openrouter-usage.json'});
  const shape = value => value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, shape(value[key])])) : typeof value;
  assert.deepEqual(shape(PRODUCTION), shape(STAGING));
  for (const key of Object.keys(STAGING.files)) assert.notEqual(PRODUCTION.files[key], STAGING.files[key], `both sites would write ${STAGING.files[key]}`);
  // The history of the status branch tells the two sites' writes apart by their first word.
  assert.deepEqual(PRODUCTION.commits, {research: 'research', monitoring: 'monitoring', usage: 'usage charts'});
  assert.deepEqual(STAGING.commits, {research: 'research-test', monitoring: 'monitoring-test', usage: 'test usage charts'});
  assert.deepEqual([STAGING_RESEARCH, PRODUCTION_RESEARCH], ['dashboard/research-test.json', 'dashboard/research.json']);
  // One password opens both sites: production's gate is the test server's, byte for byte
  // (scripts/make_workspace_gate.mjs writes the two together).
  assert.equal(read(path.join(dist, 'release/gate.js')), read(path.join(dist, 'test-server/gate.js')));
  // The real research records are production's; the test server points at them.
  assert.deepEqual([STAGING.practiceOf, PRODUCTION.practiceOf], ['../#research', '']);
  assert.ok(fs.existsSync(path.join(dist, 'login.html')) && fs.existsSync(path.join(dist, 'index.html')));
});
