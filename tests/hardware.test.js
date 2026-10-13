import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {priceState, renderHardware} from '../dist/hardware.js';
const catalog = JSON.parse(fs.readFileSync(new URL('../dist/hardware-products.json', import.meta.url)));
const seed = JSON.parse(fs.readFileSync(new URL('../dist/hardware-prices.json', import.meta.url)));
const product = catalog.products[0], quote = seed.products[0];
const now = Date.parse(quote.checked_at);

test('fresh, old, failed and wrong product prices remain distinguishable', () => {
  assert.equal(priceState(product, quote, now).label, '확인 최저가');
  for (const row of [{...quote, fetch_error:'HTTPError'}, {...quote, checked_at:new Date(now-3*86400000).toISOString()}]) {
    assert.equal(priceState(product, row, now).label, '마지막 확인 가격');
    assert.equal(priceState(product, row, now).price, priceState(product, quote, now).price);
  }
  for (const row of [null, {...quote, pcode:'wrong'}, {...quote, checked_at:'bad'}, {...quote, price_krw:0}, {...quote, checked_at:new Date(now+86400000).toISOString()}]) {
    assert.equal(priceState(product, row, now).price, '가격 확인 필요');
  }
  assert.equal(priceState(product, {...quote, price_krw:null, availability:'unavailable'}, now).price, '판매 가격 없음');
});

test('three groups, verified variants, exact Danawa links, no unsafe HTML', () => {
  const html = renderHardware(catalog, seed, now);
  assert.equal((html.match(/<article /g)||[]).length, 3);
  assert.equal((html.match(/class="hardware-product"/g)||[]).length, catalog.products.length);
  assert.ok(html.includes('https://prod.danawa.com/info/?pcode=63140417'));
  assert.ok(html.includes('64GB × 1개'));
  const poisoned = {...catalog, products:[{...product, name:'<img onerror="alert(1)">', pcode:'javascript:alert(1)'}]};
  const safe = renderHardware(poisoned, seed, now);
  assert.ok(safe.includes('&lt;img'));
  assert.ok(!safe.includes('href="javascript:'));
  assert.ok(!safe.includes('<img'));
});

test('catalog and snapshot agree, one observation per selected listing', () => {
  assert.equal(new Set(catalog.products.map(p => p.id)).size, catalog.products.length);
  assert.equal(seed.products.length, catalog.products.length);
  for (const product of catalog.products) {
    assert.match(product.pcode, /^\d+$/);
    assert.ok(product.expected_title);
    assert.equal(seed.products.find(p => p.id === product.id).pcode, product.pcode);
  }
});
