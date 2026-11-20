#!/usr/bin/env node
// Gives every module and stylesheet of the test server one cache token.
//
//   node scripts/staging_token.mjs <token>        e.g. workspace-12
//
// Pages has no build step, so a changed file is only fetched again when the address that loads it
// changes. Rather than tracking which importer points at which changed file, a staging patch sets
// one new token for the whole directory: every './name.js?…' import and every './name.css?…' or
// './name.js?…' reference in the two pages of dist/test-server/ gets '?v=<token>'. Addresses that
// leave the directory ('../app.js?…') are not touched: the shared core keeps its own token, which
// must stay identical in every module that imports it (tests/layers.test.js checks both).
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const token = process.argv[2];
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(token || '')) {
  console.error('Usage: staging_token.mjs <token>   (letters, digits, dot, dash, underscore)');
  process.exit(2);
}
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/test-server');
const names = new Set(await fs.readdir(directory));
let changed = 0;
for (const name of [...names].sort()) {
  if (!/\.(js|html)$/.test(name)) continue;
  const file = path.join(directory, name), before = await fs.readFile(file, 'utf8');
  const local = (target, keep) => names.has(target) ? `./${target}?v=${token}` : keep;
  const after = name.endsWith('.js')
    ? before.replace(/(['"])\.\/([\w.-]+\.js)(?:\?[^'"]*)?\1/g, (all, quote, target) => quote + local(target, all.slice(1, -1)) + quote)
    : before.replace(/((?:src|href)=")\.\/([\w.-]+\.(?:js|css))(?:\?[^"]*)?"/g, (all, lead, target) => lead + local(target, all.slice(lead.length, -1)) + '"');
  if (after !== before) { await fs.writeFile(file, after); changed++; }
}
console.log(`${changed} file(s) now load the test-server modules with ?v=${token}`);
