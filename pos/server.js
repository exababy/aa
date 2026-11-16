'use strict';
/**
 * NetCHIEF Smart POS — yeni kasa arayüzü (Express API + statik arayüz).
 *   [Kasa / tablet tarayıcısı] → /api/* → [bu sunucu] → MySQL `netchief`   (POS_DEMO=1 ise bellek içi demo veritabanı)
 */
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('./lib/config');
const dbs = require('./lib/db');
const schema = require('./lib/schema');
const { createStore, PosError } = require('./lib/store');
const { createPrinter } = require('./lib/print');

async function createApp(opts = {}) {
  const cfg = opts.cfg || config.load();
  let db = opts.db;
  if (!db) {
    if (cfg.demo) {
      db = dbs.sqlite(':memory:');
      await schema.install(db);
    } else {
      if (!cfg.db.host || !cfg.db.user) throw new Error('Veritabanı ayarı eksik: POS_DB_HOST / POS_DB_USER (veya POS_CONFIG_INI). Demo için POS_DEMO=1.');
      db = dbs.mysql(cfg.db);
    }
  }
  const printer = createPrinter(cfg);
  const store = createStore(db, cfg, printer);

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  // ---------- Oturum ----------
  const TTL = cfg.sessionHours * 3600 * 1000;
  const sessions = new Map();
  const attempts = new Map();
  function session(req) {
    const m = /(?:^|;\s*)pos_sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    const s = m && sessions.get(m[1]);
    if (!s || s.expires < Date.now()) return null;
    s.token = m[1];
    return s;
  }
  const cookie = (req, res, value, age) => res.append('Set-Cookie', `pos_sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${req.secure ? '; Secure' : ''}`);

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => { if (out !== undefined) res.json(out); }).catch(next);
  const int = (v, name, min = 1) => {
    const n = typeof v === 'number' ? v : /^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < min) throw new PosError(`Geçersiz parametre: ${name}`);
    return n;
  };
  const date = (v, name = 'tarih') => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) || Number.isNaN(Date.parse(v))) throw new PosError(`Geçersiz ${name}.`);
    return v;
  };

  const r = express.Router();
  r.use(express.json({ limit: '300kb' }));
  r.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* geçersiz */ }
      if (host !== req.headers.host) return res.status(403).json({ error: 'Geçersiz kaynak.' });
    }
    next();
  });

  // Giriş ekranı: işletme adı ve kullanıcı listesi (şifreler gönderilmez)
  r.get('/boot', wrap(async () => ({
    restaurant: cfg.restaurant, demo: cfg.demo,
    users: (await store.users()).map((u) => ({ id: u.id, name: u.name })),
  })));
  r.post('/login', wrap(async (req, res) => {
    const now = Date.now();
    let a = attempts.get(req.ip);
    if (!a || a.reset < now) { a = { count: 0, reset: now + 5 * 60000 }; attempts.set(req.ip, a); }
    if (++a.count > 20) return res.status(429).json({ error: 'Çok fazla deneme. Birkaç dakika sonra tekrar deneyin.' });
    const { userId, password } = req.body || {};
    if (typeof password !== 'string' || !password || password.length > 100) throw new PosError('Şifre gerekli.');
    const user = await store.login(int(userId, 'kullanıcı'), password);
    if (!user) return res.status(401).json({ error: 'Şifre hatalı.' });
    attempts.delete(req.ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user, expires: now + TTL });
    cookie(req, res, token, TTL / 1000);
    return { user };
  }));

  r.use((req, res, next) => {
    const s = session(req);
    if (!s) return res.status(401).json({ error: 'Oturum kapalı. Tekrar giriş yapın.' });
    req.user = s.user;
    req.token = s.token;
    next();
  });
  r.post('/logout', (req, res) => { sessions.delete(req.token); cookie(req, res, '', 0); res.json({ ok: true }); });

  /**
   * Yetkili işlemi (iptal, indirim, bedelsiz...): oturumdaki kullanıcı yetkiliyse geçer; değilse istekle birlikte
   * bir yetkilinin şifresi (approver: {userId, password}) gelmelidir — orijinal programdaki "Yetkili Girişi" penceresi.
   */
  const approved = async (req) => {
    if (req.user.manager) return true;
    const ap = (req.body || {}).approver;
    if (!ap || typeof ap.password !== 'string') return false;
    const u = await store.login(int(ap.userId, 'yetkili'), ap.password);
    return !!(u && u.manager);
  };
  const manager = (req, res, next) => {
    approved(req).then((ok) => (ok ? next() : res.status(403).json({
      error: (req.body || {}).approver ? 'Kullanıcı Adı veya Şifre Hatalı !' : 'Bu işlem için yetkili değilsiniz !', needApproval: true,
    }))).catch(next);
  };
  const role = (key, message) => (req, res, next) => (req.user[key] ? next() : res.status(403).json({ error: message }));
  const settings = role('canSettings', 'Bu işlem için yetkili değilsiniz !');
  const cashier = role('canPay', 'Ödeme almak için yetkili değilsiniz !');

  r.get('/me', wrap(async (req) => ({
    user: req.user, restaurant: cfg.restaurant, demo: cfg.demo, notes: cfg.notes, cancelReasons: cfg.cancelReasons, staffRoles: cfg.staffRoles,
    payPrompt: cfg.payPrompt, lockTimeoutMs: cfg.lockTimeoutMs, today: store.businessDay(), tableCount: cfg.tableCount,
    managers: (await store.users()).filter((u) => u.manager).map((u) => ({ id: u.id, name: u.name })),
  })));
  r.get('/fields', wrap(() => store.fields()));
  r.get('/tables', wrap((req) => store.tables(int(req.query.field, 'bölüm'))));
  r.get('/menu', wrap(() => store.menu()));

  // ---------- Adisyon ----------
  const sid = (req) => int(req.params.sid, 'satış no');
  const items = (list) => (Array.isArray(list) ? list : []).map((i) => ({ id: int(i && i.id, 'kalem'), quantity: Number(i.quantity), reason: i.reason }));
  r.post('/sales', wrap(async (req, res) => {
    const b = req.body || {};
    const lines = (Array.isArray(b.lines) ? b.lines : []).map((l) => ({
      id: l && l.joker ? 0 : int(l && l.id, 'ürün'), quantity: l.quantity, comment: l.comment, gift: !!l.gift,
      joker: l.joker ? { name: l.joker.name, price: Number(l.joker.price) } : null,
    }));
    // Bedelsiz kalem yetkili onayı ister
    if (lines.some((l) => l.gift) && !(await approved(req))) return void res.status(403).json({ error: 'Bedelsiz satış için yetkili değilsiniz !', needApproval: true });
    return store.saveLines(req.user, {
      fieldId: int(b.fieldId, 'bölüm'), tableId: int(b.tableId, 'masa'), pax: int(b.pax ?? 1, 'pax', 0), customerId: int(b.customerId ?? 0, 'müşteri', 0),
      note: b.note, alert: b.alert, noprep: !!b.noprep, print: b.print !== false, lines,
    });
  }));
  r.get('/sales/:sid', wrap((req) => store.sale(sid(req))));
  r.post('/sales/:sid/edit', manager, wrap((req) => store.editSale(req.user, sid(req), items(req.body.changes))));
  r.post('/sales/:sid/void', manager, wrap((req) => store.voidSale(sid(req))));
  r.post('/sales/:sid/discount', manager, wrap((req) => store.setDiscount(sid(req), Number(req.body.amount), req.body.tag)));
  r.post('/sales/:sid/pax', wrap((req) => store.setPax(sid(req), req.body.pax)));
  r.post('/sales/:sid/transfer', wrap((req) => store.transfer(req.user, sid(req), {
    fieldId: int(req.body.fieldId, 'bölüm'), tableId: int(req.body.tableId, 'masa'), items: req.body.items ? items(req.body.items) : null, merge: !!req.body.merge,
  })));
  r.post('/sales/:sid/print', wrap((req) => store.printBill(sid(req))));
  r.post('/sales/:sid/unlock', wrap((req) => store.unlock(sid(req))));
  r.post('/sales/:sid/pay', cashier, wrap((req) => {
    const b = req.body || {};
    return store.pay(req.user, sid(req), {
      rows: (Array.isArray(b.rows) ? b.rows : []).map((x) => ({ method: Number(x.method), amount: Number(x.amount), customerId: int(x.customerId ?? 0, 'müşteri', 0), note: x.note })),
      discount: b.discount == null ? null : Number(b.discount),
    });
  }));
  r.post('/sales/:sid/paymulti', cashier, wrap((req) => store.payMulti(req.user, sid(req), { method: Number(req.body.method), items: items(req.body.items) })));
  r.post('/drawer', wrap(async () => ({ printed: [await printer.drawer()] })));

  // ---------- Kasadan çıkış ----------
  r.get('/payouts', wrap(async (req) => ({ ...(await store.payouts(date(req.query.date))), types: await store.payoutTypes() })));
  r.post('/payouts', wrap((req) => store.addPayout(req.user, { type: req.body.type, comment: req.body.comment, amount: Number(req.body.amount) })));
  r.post('/payouts/:id/delete', manager, wrap((req) => store.removePayout(int(req.params.id, 'kayıt'))));

  // ---------- Cari / müşteri ----------
  r.get('/customers', wrap((req) => store.customers({ name: req.query.name, phone: req.query.phone })));
  r.post('/customers', wrap((req) => store.saveCustomer(0, req.body || {})));
  r.post('/customers/:id', wrap((req) => store.saveCustomer(int(req.params.id, 'müşteri'), req.body || {})));
  r.post('/customers/:id/delete', manager, wrap((req) => store.removeCustomer(int(req.params.id, 'müşteri'))));
  r.get('/customers/:id/statement', wrap((req) => store.statement(int(req.params.id, 'müşteri'))));
  r.post('/customers/:id/collect', cashier, wrap((req) => store.collect(req.user, int(req.params.id, 'müşteri'),
    (Array.isArray(req.body.rows) ? req.body.rows : []).map((x) => ({ method: Number(x.method), amount: Number(x.amount) })))));

  // ---------- Çağrı merkezi ve rezervasyon ----------
  r.get('/calls', wrap((req) => store.calls(date(req.query.date))));
  r.get('/free-table', wrap(async (req) => ({ no: await store.firstFreeTable(int(req.query.field, 'bölüm')) })));
  r.get('/reservations', wrap((req) => store.reservations(date(req.query.date))));
  r.post('/reservations', wrap((req) => store.saveReservation(0, req.body || {})));
  r.post('/reservations/:id', wrap((req) => store.saveReservation(int(req.params.id, 'rezervasyon'), req.body || {})));
  r.post('/reservations/:id/delete', wrap((req) => store.removeReservation(int(req.params.id, 'rezervasyon'))));

  // ---------- Seçenekler: raporlar, gün sonu, tanımlar ----------
  const a = express.Router();
  a.use(settings);
  const range = (req) => [date(req.query.start, 'başlangıç tarihi'), date(req.query.end || req.query.start, 'bitiş tarihi')];
  a.get('/reports/kasa', wrap((req) => store.reports.kasa(...range(req), int(req.query.filter ?? 0, 'filtre', 0))));
  for (const name of ['sales', 'tables', 'staff', 'cancels']) a.get(`/reports/${name}`, wrap((req) => store.reports[name](...range(req))));
  a.get('/reports/eod', wrap((req) => store.reports.eod(date(req.query.date), { cash: Number(req.query.cash) || 0, card: Number(req.query.card) || 0 })));
  a.get('/payments-of', wrap((req) => store.paymentsOf(int(req.query.no, 'numara'), req.query.by === 'pay')));
  a.post('/payments-cancel', manager, wrap((req) => store.cancelPayments(int(req.body.no, 'numara'), req.body.by === 'pay')));
  const optId = (req) => (req.params.id ? int(req.params.id, 'kayıt') : 0);
  const crud = (path, list, save, remove) => {
    a.get(`/${path}`, wrap((req) => list(req.query.q)));
    a.post(`/${path}/:id/delete`, wrap((req) => remove(optId(req), req.user.id)));
    a.post(`/${path}/:id?`, wrap((req) => save(optId(req), req.body || {})));
  };
  crud('products', store.admin.products, store.admin.saveProduct, store.admin.removeProduct);
  crud('categories', store.admin.categories, store.admin.saveCategory, store.admin.removeCategory);
  crud('fields', store.admin.fields, store.admin.saveField, store.admin.removeField);
  crud('users', store.admin.users, store.admin.saveUser, store.admin.removeUser);
  r.get('/staff', wrap((req) => store.admin.staff(req.query.q)));
  r.post('/staff/:id/delete', wrap((req) => store.admin.removeStaff(optId(req))));
  r.post('/staff/:id?', wrap((req) => store.admin.saveStaff(optId(req), req.body || {})));
  r.use('/admin', a);

  r.use((req, res) => res.status(404).json({ error: 'Bulunamadı.' }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    const known = err instanceof PosError || err.type === 'entity.parse.failed';
    if (!known) console.error(err);
    res.status(known ? err.status || 400 : 500).json({ error: known ? err.message : 'Beklenmeyen bir hata oluştu.' });
  });

  app.use('/api', r);
  // Arayüz dosyaları: exe içinde gömülü (bellekten, anında) ya da geliştirmede diskten sunulur.
  const embedded = globalThis.__POS_ASSETS__;
  if (embedded) {
    const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', woff2: 'font/woff2', txt: 'text/plain' };
    const files = new Map(Object.entries(embedded).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
    app.use((req, res, next) => {
      const body = req.method === 'GET' && files.get(req.path === '/' ? '/index.html' : req.path);
      if (!body) return next();
      res.set({ 'Content-Type': types[req.path.split('.').pop()] || types.html, 'Cache-Control': req.path.startsWith('/fonts/') ? 'max-age=2592000' : 'no-cache' }).send(body);
    });
  } else {
    const noCache = { setHeaders(res, file) { if (/\.(js|css|html)$/.test(file)) res.set('Cache-Control', 'no-cache'); } };
    app.use('/fonts', express.static(path.join(__dirname, '..', 'public', 'fonts'), { maxAge: '30d' }));
    app.use(express.static(path.join(__dirname, 'public'), noCache));
  }

  app.locals.store = store;
  app.locals.db = db;
  app.locals.printer = printer;
  return app;
}

/** Sunucuyu başlatır; port doluysa (program zaten açıksa) null döner. */
async function start() {
  const cfg = config.load();
  const app = await createApp({ cfg });
  return new Promise((resolve, reject) => {
    const server = app.listen(cfg.port, process.env.HOST || '0.0.0.0', () => {
      console.log(`NetCHIEF Smart POS → http://localhost:${cfg.port}`);
      console.log(cfg.demo ? 'DEMO modu: Kasiyer / Yalçın şifresi 1234 (yetkili), Ahmet 1111 (garson)' : `Veritabanı: ${cfg.db.user}@${cfg.db.host}:${cfg.db.port}/${cfg.db.database}`);
      resolve({ cfg, server });
    });
    server.on('error', (e) => (e.code === 'EADDRINUSE' ? resolve({ cfg, server: null }) : reject(e)));
  });
}

if (require.main === module && !globalThis.__POS_ASSETS__) {
  start().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { createApp, start };
