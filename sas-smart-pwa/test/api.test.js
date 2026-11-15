'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');
const { parseEnvelope, buildUrl } = require('../lib/sas');

let base, server, cookie = '';
const call = async (path, body, method) => {
  const res = await fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, data: await res.json() };
};

test.before(() => new Promise((ok) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api`; ok(); }); }));
test.after(() => server.close());

test('URL deseni @Action/ ve ! ayracını korur', () => {
  assert.match(buildUrl('Product', { cat: 3 }), /:8081\/SASncps\/@Action\/Product!\?cat=3$/);
  assert.match(buildUrl('Fields'), /\/@Action\/Fields!$/);
  assert.match(buildUrl('Payments', { start: '2026-11-15 06:00:00' }), /start=2026-11-15%2006%3A00%3A00$/);
});

test('zarf çözümleme: bool/int Result, string sarılı JSON, düz dizi', () => {
  assert.equal(parseEnvelope('{"Result":1,"Data":[{"id":1}],"Message":""}').ok, true);
  assert.equal(parseEnvelope('{"result":"false","data":null,"message":"x"}').ok, false);
  assert.deepEqual(parseEnvelope(JSON.stringify('{"Result":true,"Data":"[1,2]"}')).data, [1, 2]);
  assert.deepEqual(parseEnvelope('[{"id":5}]').data, [{ id: 5 }]);
  assert.throws(() => parseEnvelope('<html>'));
});

test('oturum olmadan API kapalı', async () => {
  assert.equal((await call('/fields')).status, 401);
});

test('hatalı giriş reddedilir', async () => {
  assert.equal((await call('/login', { cc: 'demo', username: 'demo', password: 'yanlis' })).status, 401);
  assert.equal((await call('/login', { cc: 'demo' })).status, 400);
});

test('giriş → bölüm → masa → menü → sipariş → adisyon akışı', async () => {
  const login = await call('/login', { cc: 'demo', username: 'demo', password: 'demo' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.name, 'Demo Garson');
  assert.match(cookie, /^sas_sid=[a-f0-9]{64}$/);

  const fields = (await call('/fields')).data;
  assert.ok(fields.length && fields[0].id && fields[0].name);

  const tables = (await call('/tables?field=' + fields[0].id)).data;
  const free = tables.find((t) => t.sid === 0);
  assert.ok(free && free.tableId);

  const cats = (await call('/categories')).data;
  const products = (await call('/products?cat=' + cats[0].id)).data;
  assert.ok(products[0].price > 0);

  const order = await call('/orders', {
    fid: fields[0].id, tid: free.tableId, sid: 0,
    items: [{ id: products[0].id, quantity: 2, comment: 'acısız', price: 1 }],
  });
  assert.equal(order.status, 200);

  const after = (await call('/tables?field=' + fields[0].id)).data.find((t) => t.tableId === free.tableId);
  assert.ok(after.sid > 0);
  // fiyat istemciden değil sunucudaki menüden alınır
  assert.equal(after.totalPrice, products[0].price * 2);

  const details = (await call('/sales/' + after.sid)).data;
  assert.equal(details[0].quantity, 2);
  assert.equal(details[0].productName, products[0].name);
  assert.equal((await call(`/sales/${after.sid}/print`, null, 'POST')).status, 200);
});

test('doğrulama hataları 400 döner', async () => {
  assert.equal((await call('/products?cat=abc')).status, 400);
  assert.equal((await call('/orders', { fid: 1, tid: 1, sid: 0, items: [] })).status, 400);
  assert.equal((await call('/orders', { fid: 1, tid: 1, sid: 0, items: [{ id: 101, quantity: 0 }] })).status, 400);
  assert.equal((await call('/orders', { fid: 1, tid: 1, sid: 0, items: [{ id: 999999, quantity: 1 }] })).status, 400);
  assert.equal((await call('/kitchen/__proto__')).status, 400);
  assert.equal((await call('/reports/payments?start=2026-13-99&end=x')).status, 400);
});

test('mutfak ve raporlar', async () => {
  for (const s of ['bekleyen', 'hazirlaniyor', 'hazir']) assert.ok(Array.isArray((await call('/kitchen/' + s)).data));
  const pay = (await call('/reports/payments?start=2026-11-15&end=2026-11-15')).data;
  assert.ok(pay[0].totalPrice > 0 && pay[0].payMethod);
  assert.ok((await call('/reports/sales?start=2026-11-01&end=2026-11-15')).data[0].quantity > 0);
});

test('farklı kaynaktan POST reddedilir, çıkış oturumu kapatır', async () => {
  const res = await fetch(base + '/logout', { method: 'POST', headers: { cookie, origin: 'https://kotu.example' } });
  assert.equal(res.status, 403);
  assert.equal((await call('/logout', null, 'POST')).status, 200);
  assert.equal((await call('/me')).status, 401);
});
