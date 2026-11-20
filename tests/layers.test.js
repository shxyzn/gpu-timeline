import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROFILE as STAGING} from '../dist/test-server/profile.js';

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
