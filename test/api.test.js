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
  assert.deepEqual((await call('/login-users')).data, []);
  assert.equal((await call('/fields')).status, 401);
});

test('hatalı giriş reddedilir', async () => {
  assert.equal((await call('/login', { cc: 'demo', username: 'demo', password: 'yanlis' })).status, 401);
  assert.equal((await call('/login', { cc: 'demo' })).status, 400);
});

test('giriş → bölüm → masa → menü → sipariş → adisyon akışı', async () => {
  const login = await call('/login', { cc: 'demo', username: 'demo', password: 'demo' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.name, 'Demo Kasiyer');
  assert.equal(login.data.user.reports, true);
  assert.match(cookie, /^sas_sid=[a-f0-9]{64}$/);

  const fields = (await call('/fields')).data;
  assert.ok(fields.length && fields[0].fid && fields[0].name);

  const tables = (await call('/tables?field=' + fields[0].fid)).data;
  const free = tables.find((t) => t.sid === 0);
  assert.ok(free && free.tableId);

  const cats = (await call('/categories')).data;
  const products = (await call('/products?cat=' + cats[0].id)).data;
  assert.ok(products[0].price > 0);

  const order = await call('/orders', {
    fid: fields[0].fid, tid: free.tableId, sid: 0,
    items: [{ id: products[0].id, quantity: 2, comment: 'acısız', price: 1 }],
  });
  assert.equal(order.status, 200);

  const after = (await call('/tables?field=' + fields[0].fid)).data.find((t) => t.tableId === free.tableId);
  assert.ok(after.sid > 0);
  // fiyat istemciden değil sunucudaki menüden alınır
  assert.equal(after.totalPrice, products[0].price * 2);

  const details = (await call('/sales/' + after.sid)).data;
  assert.equal(details[0].quantity, 2);
  assert.equal(details[0].productName, products[0].name);
  assert.equal((await call(`/sales/${after.sid}/print`, null, 'POST')).status, 200);
});

test('paket servis bölümü işaretlenir ve sipariş alır', async () => {
  const fields = (await call('/fields')).data;
  const paket = fields.filter((f) => f.paket);
  assert.equal(paket.length, 1);
  const free = (await call('/tables?field=' + paket[0].fid)).data.find((t) => t.sid === 0);
  const order = await call('/orders', { fid: paket[0].fid, tid: free.tableId, sid: 0, items: [{ id: 101, quantity: 1, comment: 'PAKET: Ali, 0555' }] });
  assert.equal(order.status, 200);
});

test('SAS yalnızca açık masaları döndürse de 72 masanın tamamı listelenir', async () => {
  const all = (await call('/tables?field=1')).data;
  assert.equal(all.length, 72);
  assert.deepEqual(all.map((t) => t.tableId), [...Array(72).keys()].map((i) => i + 1));
  const open = all.filter((t) => t.sid > 0);
  assert.ok(open.length >= 5 && open.length < 72);
  assert.ok(open.every((t) => t.totalPrice > 0));
  assert.ok((await call('/tables')).data.every((t) => t.sid > 0)); // bölümsüz: yalnızca açık adisyonlar
  assert.equal((await call('/tables?field=2')).data.length, 72);
});

test('Salon ikiye ayrılır: Bahçe = 1-15 ve 51, kalanı sıralı Salon', async () => {
  const fields = (await call('/fields')).data;
  assert.deepEqual(fields.map((f) => f.name), ['Salon', 'Bahçe', 'Paket Servis']);
  const [salon, bahce] = fields;
  assert.equal(salon.fid, bahce.fid);
  const nums = async (f) => (await call(`/tables?field=${f.fid}&part=${f.part}`)).data.map((t) => t.no);
  assert.deepEqual(await nums(bahce), [...Array(15).keys()].map((i) => i + 1).concat(51));
  const rest = await nums(salon);
  assert.equal(rest.length, 72 - 16);
  assert.equal(rest[0], 16);
  assert.ok(!rest.includes(51) && rest.includes(50) && rest.includes(52));
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b));
  assert.equal((await call(`/tables?field=${salon.fid}&part=x`)).status, 400);
});

test('doğrulama hataları 400 döner', async () => {
  assert.equal((await call('/products?cat=abc')).status, 400);
  assert.equal((await call('/orders', { fid: 1, tid: 1, sid: 0, items: [] })).status, 400);
  assert.equal((await call('/orders', { fid: 1, tid: 1, sid: 0, items: [{ id: 101, quantity: 0 }] })).status, 400);
  assert.equal((await call('/orders', { fid: 1, tid: 1, sid: 0, items: [{ id: 999999, quantity: 1 }] })).status, 400);
  assert.equal((await call('/reports/payments?start=2026-13-99&end=x')).status, 400);
});

test('raporlar', async () => {
  assert.equal((await call('/kitchen/bekleyen')).status, 404); // mutfak bölümü kaldırıldı
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

test('garson raporları göremez', async () => {
  const login = await call('/login', { cc: 'demo', username: 'garson', password: 'garson' });
  assert.equal(login.data.user.reports, false);
  assert.equal((await call('/reports/payments?start=2026-11-15&end=2026-11-15')).status, 403);
  assert.equal((await call('/reports/sales?start=2026-11-15&end=2026-11-15')).status, 403);
  assert.equal((await call('/fields')).status, 200);
});

test('sürüm: index.html sürümlü dosya adresleri verir ve önbelleğe alınmaz', async () => {
  const root = base.replace('/api', '');
  const { version } = (await call('/version')).data;
  assert.match(version, /^\d+\.\d+\.\d+-[a-f0-9]{7}$/);
  const res = await fetch(root + '/');
  const html = await res.text();
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(html.includes(`/app.js?v=${version}`) && html.includes(`/styles.css?v=${version}`));
  assert.ok(!html.includes('__V__'));
  assert.equal((await fetch(root + '/app.js')).headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(root + '/sw.js')).headers.get('cache-control'), 'no-cache');
});
