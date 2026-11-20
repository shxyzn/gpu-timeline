#!/usr/bin/env node
// Releases the test server to production.
//
//   node scripts/promote_release.mjs
//
// What it does, and nothing else:
// 1. dist/release/ becomes an unchanged copy of every script and stylesheet in dist/test-server/,
//    except profile.js: dist/release/profile.js is production's own and is left as it is.
// 2. dist/index.html (the workspace) and dist/login.html (the sign-in page) are written from
//    dist/test-server/preview.html and index.html. Asset addresses move to the site root, the
//    snapshot label becomes the release named in VERSION, the maintenance notice takes its
//    production ids, and the link to production becomes the link to the test server.
//    Whether the production notice is shown, and its two times, are carried over from the
//    dist/index.html being replaced: a release neither shows nor hides it.
// Both pages are built and checked before anything is written: a staging page this script does
// not understand stops the release with the tree as it was. The workspace page is stamped with a
// digest of the released modules, so tests/layers.test.js notices a release layer that was edited
// by hand or only half promoted.
// It does not touch VERSION, the changelog, the tests or any stored document, and it publishes
// nothing: review the diff, run the checks, then commit. RELEASING.md has the whole procedure.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist'), staging = path.join(dist, 'test-server'), release = path.join(dist, 'release');
const fail = message => { console.error('promote_release: ' + message); process.exit(1); };

const version = (await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`VERSION holds "${version}", not a release number`);

// ---- 1. Modules ---------------------------------------------------------------------------------
const stagingFiles = (await fs.readdir(staging, {withFileTypes: true}));
const strangers = stagingFiles.filter(entry => !entry.isFile() || !/\.(js|css|html)$/.test(entry.name)).map(entry => entry.name);
if (strangers.length) fail(`dist/test-server/ holds something this script does not know how to release: ${strangers.join(', ')}`);
const modules = stagingFiles.map(entry => entry.name).filter(name => /\.(js|css)$/.test(name) && name !== 'profile.js').sort();

const shape = value => value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, shape(value[key])])) : typeof value;
const profileOf = async directory => (await import(pathToFileURL(path.join(directory, 'profile.js')).href)).PROFILE;
const [test, production] = [await profileOf(staging), await profileOf(release)];
if (production.name !== 'production' || test.name !== 'test') fail('profile.js: the test server must be "test" and the release "production"');
if (JSON.stringify(shape(test)) !== JSON.stringify(shape(production))) fail('dist/release/profile.js does not offer the same fields as dist/test-server/profile.js');
for (const key of Object.keys(test.files)) if (test.files[key] === production.files[key]) fail(`both sites would write ${test.files[key]}`);

// What the release layer will hold, as one digest. The gate is left out: it changes with the
// password (scripts/make_workspace_gate.mjs writes both sites' copies) and has its own check.
const digest = createHash('sha256');
for (const name of modules) if (name !== 'gate.js') digest.update(name + '\0').update(await fs.readFile(path.join(staging, name))).update('\0');
const stamp = digest.digest('hex');

// ---- 2. Pages -----------------------------------------------------------------------------------
// Every replacement must find exactly what it expects: a staging page that changed shape stops the
// release here instead of producing a production page nobody looked at.
function rewrite(html, label, steps) {
  for (const [pattern, replacement, expected = 1] of steps) {
    const found = typeof pattern === 'string' ? html.split(pattern).length - 1 : (html.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')) || []).length;
    if (found !== expected) fail(`${label}: expected ${expected} of ${pattern} but found ${found}`);
    html = typeof pattern === 'string' ? html.replaceAll(pattern, replacement) : html.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'), replacement);
  }
  return html;
}
// Staging pages sit one directory below the site root, next to their modules. Production pages
// sit at the root and load the modules from release/. "@entry" and "@staging" stand for the two
// page links until the addresses have been moved.
function relocate(html, label) {
  const moved = html.replace(/\b(href|src|poster)="(\.\.?\/[^"]*)"/g, (all, attribute, address) => {
    const file = address.split(/[?#]/)[0];
    if (address.startsWith('../')) {
      if (address.startsWith('../test-server/') || file === '../') fail(`${label}: ${all} needs its own rule`);
      return `${attribute}="./${address.slice(3)}"`;
    }
    if (!modules.includes(file.slice(2))) fail(`${label}: ${all} is not a released module and needs its own rule`);
    return `${attribute}="./release/${address.slice(2)}"`;
  });
  return moved.replaceAll('"@entry"', '"./login.html"').replaceAll('"@staging"', '"./test-server/"');
}
// The two pages are checked together, once both are known: each may link to the other.
const PAGES = ['index.html', 'login.html'];
async function check(html, label) {
  if (/snapshot|data-staging-version|\.\.\/|TEST SERVER/.test(html)) fail(`${label}: a staging label or address is left in the page`);
  for (const [, address] of html.matchAll(/\b(?:href|src|poster)="(\.\/[^"#]*)"/g)) {
    const name = address.slice(2).split('?')[0];
    if (name === '' || PAGES.includes(name)) continue;
    // A released module is about to be copied; everything else must already be there.
    if (name.startsWith('release/') && (modules.includes(name.slice(8)) || name === 'release/profile.js')) continue;
    const target = path.join(dist, name.endsWith('/') ? name + 'index.html' : name);
    if (!(await fs.stat(target).then(() => true, () => false))) fail(`${label}: ${address} does not exist`);
  }
}

const stagingLabel = /v\d+\.\d+ snapshot \d+/;
// The production notice belongs to production. Its state and times are read from the page that is
// about to be replaced, so showing it before a release and hiding it afterwards stay their own steps.
const replaced = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
const shown = replaced.match(/<aside id="production-maintenance-notice"( hidden)? class="maintenance-notice" role="status" aria-labelledby="production-maintenance-title">/);
const times = ['start', 'end'].map(part => replaced.match(new RegExp(`<time id="production-maintenance-${part}" datetime="[^"]+">[^<]+</time>`))?.[0]);
if (!shown || !times[0] || !times[1]) fail('dist/index.html: the production maintenance notice (state and times) could not be read');
const workspace = relocate(rewrite(await fs.readFile(path.join(staging, 'preview.html'), 'utf8'), 'preview.html', [
  ['<meta name="description" content="CVML Workspace 테스트 서버">', `<meta name="description" content="CVML Workspace · 연구실 과제 실적과 GPU 현황"><meta name="release-modules" content="${stamp}">`],
  [/<body data-staging-version="[^"]*" class="/, '<body class="'],
  ['<a href="./">로그인 화면</a>', '<a href="@entry">로그인 화면</a>'],
  [new RegExp(`<strong>CVML Workspace</strong><span>${stagingLabel.source}</span>`), `<strong>CVML Workspace</strong><span>v${version}</span>`],
  [/<aside id="maintenance-notice" class="maintenance-notice" role="status" aria-labelledby="maintenance-title"(?: hidden)?>/,
    `<aside id="production-maintenance-notice"${shown[1] || ''} class="maintenance-notice" role="status" aria-labelledby="production-maintenance-title">`],
  ['<strong id="maintenance-title">', '<strong id="production-maintenance-title">'],
  [/<time id="maintenance-start" datetime="[^"]+">[^<]+<\/time>/, times[0]],
  [/<time id="maintenance-end" datetime="[^"]+">[^<]+<\/time>/, times[1]],
  ['<a class="priority-home" href="../">정식 화면</a>', '<a id="test-server-link" class="priority-home" href="@staging">테스트 서버</a>'],
]), 'preview.html');

const entry = relocate(rewrite(await fs.readFile(path.join(staging, 'index.html'), 'utf8'), 'index.html', [
  ['<p class="entry-brand">CVML · TEST SERVER</p>', '<p class="entry-brand">AJOU CVML LAB</p>'],
  [new RegExp(`<p class="entry-version">${stagingLabel.source}</p>`), `<p class="entry-version">v${version}</p>`],
  [/\n\s*<a class="entry-home" href="\.\.\/">정식 화면 보기<\/a>/, ''],
]), 'index.html');
await check(workspace, 'dist/index.html');
await check(entry, 'dist/login.html');

// ---- 3. Write ---------------------------------------------------------------------------------
// Nothing above changed a file. From here the release layer and the two pages change together.
for (const old of await fs.readdir(release)) if (old !== 'profile.js' && !modules.includes(old)) await fs.rm(path.join(release, old), {recursive: true});
for (const name of modules) await fs.copyFile(path.join(staging, name), path.join(release, name));
await fs.writeFile(path.join(dist, 'index.html'), workspace);
await fs.writeFile(path.join(dist, 'login.html'), entry);
console.log(`Released ${modules.length} modules to dist/release/ and wrote dist/index.html and dist/login.html as v${version}.`);
console.log('Next: npm test, the browser suite, CHANGELOG.md, then commit. Nothing was published.');
