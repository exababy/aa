'use strict';
/* NetCHIEF Smart POS (pos/) API testleri — demo veritabanı (SQLite) üzerinde.
   POS_TEST_MYSQL='{"socketPath":"...","user":"root","database":"postest"}' verilirse aynı testler MySQL/MariaDB üzerinde koşar. */
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../pos/lib/config');
const dbs = require('../pos/lib/db');
const schema = require('../pos/lib/schema');
const { createApp } = require('../pos/server');

let base;
let server;
let db;
const jar = {};
async function call(who, path, body) {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: jar[who] || '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) jar[who] = set.split(';')[0];
  return { status: res.status, data: await res.json() };
}
const ok = async (who, path, body) => {
  const r = await call(who, path, body);
  assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.data)}`);
  return r.data;
};

test.before(async () => {
  const cfg = config.load({ POS_DEMO: '1' });
  if (process.env.POS_TEST_MYSQL) db = dbs.mysql(JSON.parse(process.env.POS_TEST_MYSQL));
  else db = dbs.sqlite(':memory:');
  await schema.install(db);
  const app = await createApp({ cfg, db });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  assert.equal((await call('k', '/login', { userId: 1, password: '1234' })).status, 200); // Kasiyer (tam yetki)
  assert.equal((await call('g', '/login', { userId: 3, password: '1111' })).status, 200); // Ahmet (garson)
});
test.after(async () => { server.close(); await db.close(); });

test('giriş: yanlış şifre reddedilir, oturumsuz istek 401', async () => {
  assert.equal((await call('x', '/login', { userId: 1, password: 'yanlis' })).status, 401);
  assert.equal((await call('yok', '/fields')).status, 401);
});

test('bölümler ve masalar: 72 masa, açık masalar tutarıyla', async () => {
  const fields = await ok('g', '/fields');
  assert.deepEqual(fields.filter((f) => f.special).map((f) => f.special), ['rezervasyon', 'cagri', 'kasa']);
  const tables = await ok('g', '/tables?field=1');
  assert.equal(tables.length, 72);
  assert.equal(tables.find((t) => t.no === 3).total, 1040);
  assert.equal(tables.find((t) => t.no === 12).printed, true);
});

test('sipariş: fiyat sunucudan alınır, yarım porsiyon kuralı, mutfak fişi yazıcıya göre ayrılır', async () => {
  const menu = await ok('g', '/menu');
  const adana = menu.products.find((p) => p.name === 'Adana Kebap');
  const ayran = menu.products.find((p) => p.name === 'Ayran');
  const bad = await call('g', '/sales', { fieldId: 1, tableId: 30, lines: [{ id: ayran.id, quantity: 0.5 }] });
  assert.equal(bad.status, 400);
  const out = await ok('g', '/sales', { fieldId: 1, tableId: 30, note: 'ACILI', lines: [{ id: adana.id, quantity: 1.5 }, { id: ayran.id, quantity: 2 }] });
  assert.equal(out.sale.subtotal, 1.5 * 420 + 80);
  assert.equal(out.sale.note, 'ACILI');
  assert.deepEqual(out.printed.map((p) => p.printer).sort(), ['BAR', 'KEBAP']);
  // aynı masaya ikinci kayıt aynı adisyona eklenir
  const again = await ok('g', '/sales', { fieldId: 1, tableId: 30, lines: [{ id: ayran.id, quantity: 1 }] });
  assert.equal(again.sale.sid, out.sale.sid);
  assert.equal(again.sale.lines.length, 3);
});

test('yetki: garson iptal/indirim/bedelsiz yapamaz; yetkili onayıyla yapar', async () => {
  const sid = (await ok('g', '/tables?field=1')).find((t) => t.no === 30).sid;
  const sale = await ok('g', `/sales/${sid}`);
  const change = { changes: [{ id: sale.lines[2].id, quantity: 0, reason: 'Hatalı' }] };
  const denied = await call('g', `/sales/${sid}/edit`, change);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.needApproval, true);
  assert.equal((await call('g', `/sales/${sid}/edit`, { ...change, approver: { userId: 1, password: 'yanlis' } })).status, 403);
  const done = await ok('g', `/sales/${sid}/edit`, { ...change, approver: { userId: 1, password: '1234' } });
  assert.equal(done.sale.lines.length, 2);
  assert.equal((await call('g', `/sales/${sid}/pay`, { rows: [{ method: 1, amount: 10 }] })).status, 403); // garson ödeme alamaz
  const eod = await ok('k', `/admin/reports/eod?date=${(await ok('k', '/me')).today}`);
  assert.ok(eod.cancels.some((c) => c.reason === 'Hatalı' && c.name === 'Ayran'));
});

test('indirim + ön ödeme + kapalı (cari) ödeme: adisyon kapanır, bakiye güncellenir', async () => {
  const sid = (await ok('k', '/tables?field=1')).find((t) => t.no === 30).sid;
  assert.equal((await call('k', `/sales/${sid}/discount`, { amount: 99999 })).status, 400);
  const d = await ok('k', `/sales/${sid}/discount`, { amount: 60, tag: 'ikram' });
  assert.equal(d.due, 710 - 60);
  const part = await ok('k', `/sales/${sid}/pay`, { rows: [{ method: 1, amount: 150 }], discount: 60 });
  assert.equal(part.closed, false);
  assert.equal(part.sale.due, 500);
  assert.equal((await call('k', `/sales/${sid}/pay`, { rows: [{ method: 2, amount: 501 }] })).status, 400);
  const before = (await ok('k', '/customers?name=Elif'))[0];
  const fin = await ok('k', `/sales/${sid}/pay`, { rows: [{ method: 2, amount: 200 }, { method: 3, amount: 300, customerId: before.id, note: 'fatura' }] });
  assert.equal(fin.closed, true);
  assert.equal((await ok('k', '/customers?name=Elif'))[0].balance, before.balance + 300);
  assert.equal((await ok('k', '/tables?field=1')).find((t) => t.no === 30).sid, 0);
  // cari tahsilat bakiyeden düşer
  const c = await ok('k', `/customers/${before.id}/collect`, { rows: [{ method: 1, amount: 100 }] });
  assert.equal(c.balance, before.balance + 200);
});

test('multi ödeme: seçilen kalemler ödenir, hepsi ödenince masa kapanır', async () => {
  const sid = (await ok('k', '/tables?field=1')).find((t) => t.no === 18).sid;
  const s = await ok('k', `/sales/${sid}`);
  const one = await ok('k', `/sales/${sid}/paymulti`, { method: 1, items: [{ id: s.lines[0].id, quantity: 1 }] });
  assert.equal(one.closed, false);
  assert.equal(one.amount, 360);
  assert.equal((await call('k', `/sales/${sid}/transfer`, { fieldId: 1, tableId: 60 })).status, 400); // parçalı ödeme sonrası taşınamaz
  const two = await ok('k', `/sales/${sid}/paymulti`, { method: 2, items: [{ id: s.lines[1].id, quantity: 1 }] });
  assert.equal(two.closed, true);
});

test('taşıma: boş masaya tam, dolu masaya onayla birleştirme, kısmi aktarım', async () => {
  const t = async (no) => (await ok('k', '/tables?field=1')).find((x) => x.no === no);
  const moved = await ok('k', `/sales/${(await t(24)).sid}/transfer`, { fieldId: 1, tableId: 25 });
  assert.equal(moved.sale.tableId, 25);
  assert.equal((await t(24)).sid, 0);
  const ask = await ok('k', `/sales/${moved.sale.sid}/transfer`, { fieldId: 1, tableId: 3 });
  assert.equal(ask.needConfirm, true);
  const merged = await ok('k', `/sales/${moved.sale.sid}/transfer`, { fieldId: 1, tableId: 3, merge: true });
  assert.equal(merged.sale.due, 1040 + 1410);
  const line = merged.sale.lines.find((l) => l.quantity >= 2);
  const partial = await ok('k', `/sales/${merged.sale.sid}/transfer`, { fieldId: 1, tableId: 26, items: [{ id: line.id, quantity: 1 }] });
  assert.equal(partial.sale.due, line.unit);
  assert.equal((await ok('k', `/sales/${merged.sale.sid}`)).due, 1040 + 1410 - line.unit);
});

test('yazdır / kilit aç / adisyon iptal', async () => {
  const sid = (await ok('k', '/tables?field=1')).find((t) => t.no === 51).sid;
  const p = await ok('k', `/sales/${sid}/print`, {});
  assert.equal(p.sale.printed, true);
  assert.ok(p.receipt.some((l) => l.includes('TOPLAM')));
  assert.equal((await ok('k', `/sales/${sid}/unlock`, {})).printed, false);
  await ok('k', `/sales/${sid}/void`, {});
  assert.equal((await ok('k', '/tables?field=1')).find((t) => t.no === 51).sid, 0);
});

test('kasa çıkış, rezervasyon, raporlar ve tanımlar', async () => {
  const today = (await ok('k', '/me')).today;
  await ok('k', '/payouts', { type: 'Yemek', comment: 'öğle', amount: 250 });
  const po = await ok('k', `/payouts?date=${today}`);
  assert.equal(po.total, 250);
  await ok('k', '/reservations', { name: 'Deneme', date: '2030-01-02', time: '20:00', pax: 4, kids: 1, table: '7' });
  const rez = await ok('k', '/reservations?date=2030-01-02');
  assert.deepEqual([rez[0].pax, rez[0].kids, rez[0].table], [4, 1, '7']);
  const kasa = await ok('k', `/admin/reports/kasa?start=${today}&end=${today}`);
  assert.equal(kasa.total, kasa.cash + kasa.card);
  assert.equal((await call('g', `/admin/reports/kasa?start=${today}&end=${today}`)).status, 403);
  await ok('k', '/admin/products', { name: 'Test Ürün', cat: 1, price: 99.5, prn: 'BAR', type: 0 });
  assert.ok((await ok('k', '/menu')).products.some((p) => p.name === 'Test Ürün' && p.price === 99.5));
});
