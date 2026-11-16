'use strict';
/**
 * SAS Smart PWA — Express BFF (proxy) + statik PWA sunucusu.
 *   [Tarayıcı / PWA] → /api/* → [bu sunucu] → http://{SAS_HOST}:8081/SASncps/@Action/...
 */
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { api, cfg, SasError } = require('./lib/sas');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

// ---------- Oturum (bellek içi, HttpOnly çerez) ----------
const COOKIE = 'sas_sid';
const SESSION_TTL = Number(process.env.SESSION_HOURS || 12) * 3600 * 1000;
const sessions = new Map();

function readSession(req) {
  const m = /(?:^|;\s*)sas_sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  const s = m && sessions.get(m[1]);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(m[1]); return null; }
  s.token = m[1];
  return s;
}
function setCookie(req, res, value, maxAgeSec) {
  res.append('Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${req.secure ? '; Secure' : ''}`);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.expires < now) sessions.delete(k);
}, 600000).unref();

// ---------- Giriş denemesi sınırlama ----------
const attempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < now) { a = { count: 0, reset: now + 5 * 60000 }; attempts.set(ip, a); }
  return ++a.count <= 10;
}

// ---------- Yardımcılar ----------
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
class BadRequest extends Error { constructor(m) { super(m); this.status = 400; } }
function intParam(v, name, min = 0) {
  const n = typeof v === 'number' ? v : /^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min) throw new BadRequest(`Geçersiz parametre: ${name}`);
  return n;
}
function dateParam(v, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) || Number.isNaN(Date.parse(v))) throw new BadRequest(`Geçersiz tarih: ${name}`);
  return v;
}
/** İş günü 06:00'da başlar: [start 06:00, (end + 1 gün) 06:00) */
function businessRange(q) {
  const start = dateParam(q.start, 'start');
  const end = dateParam(q.end, 'end');
  const next = new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10);
  return [`${start} 06:00:00`, `${next} 06:00:00`];
}

// Raporlar: orijinal SAS Smart uygulamasındaki kural — yetki seviyesi 14'ün altındakiler (kasiyer/yönetici) görür.
const REPORT_MAX_AUTH = Number(process.env.SAS_REPORT_MAX_AUTH ?? 13);
const canReport = (u) => u.auth <= REPORT_MAX_AUTH;
const userOut = (u) => ({ id: u.uid, name: u.uname, reports: canReport(u) });

// Bahçe: SAS'ta ayrı bölüm yoksa Salon'un belirli masaları "Bahçe" olarak ayrılır (örn. "1-15,51").
function parseTableSet(spec) {
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b) && set.size < 1000; n++) set.add(n);
  }
  return set;
}
const BAHCE = parseTableSet(process.env.SAS_BAHCE_TABLES ?? '1-15,51');
// SAS yalnızca AÇIK masaları döndürür; orijinal uygulama her bölümde 1..72 numaralı masaları sabit çizer
// ve TableId'yi masa numarası olarak kullanır. Boş masalar burada tamamlanır.
const TABLE_COUNT = Math.min(500, Math.max(1, Number(process.env.SAS_TABLE_COUNT ?? 72) || 72));
function fullTableList(open) {
  const byNo = new Map(open.filter((t) => t.tableId > 0).map((t) => [t.tableId, t]));
  const max = Math.min(500, Math.max(TABLE_COUNT, ...byNo.keys()));
  const rows = [];
  for (let n = 1; n <= max; n++) {
    if (n > TABLE_COUNT && !byNo.has(n)) continue;
    rows.push({
      sid: 0, tableId: n, tableName: '', days: 0, hours: 0, minutes: 0, totalPrice: 0, discount: 0, user: '', openDate: '',
      ...byNo.get(n), no: n,
    });
  }
  return rows;
}

const r = express.Router();
r.use(express.json({ limit: '200kb' }));
r.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // Durum değiştiren isteklerde kaynak kontrolü (CSRF'e karşı ek katman)
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* geçersiz origin */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Geçersiz kaynak.' });
  }
  next();
});

// Giriş ekranında seçilebilecek kullanıcı adları (isteğe bağlı). SAS API'sinde kullanıcı listesi yoktur.
const LOGIN_USERS = (process.env.SAS_LOGIN_USERS || '').split(',').map((v) => v.trim()).filter(Boolean).slice(0, 50);
r.get('/login-users', (req, res) => res.json(LOGIN_USERS));

r.post('/login', wrap(async (req, res) => {
  if (!loginAllowed(req.ip)) return res.status(429).json({ error: 'Çok fazla deneme. Birkaç dakika sonra tekrar deneyin.' });
  const { cc, username, password } = req.body || {};
  if (![cc, username, password].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 100)) {
    throw new BadRequest('Müşteri kodu, kullanıcı adı ve şifre gerekli.');
  }
  const user = await api.login(cc.trim(), username.trim(), password);
  if (!user) return res.status(401).json({ error: 'Giriş başarısız. Bilgilerinizi kontrol edin.' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { ...user, expires: Date.now() + SESSION_TTL });
  setCookie(req, res, token, SESSION_TTL / 1000);
  res.json({ user: userOut(user) });
}));

r.use((req, res, next) => {
  req.session = readSession(req);
  if (!req.session) return res.status(401).json({ error: 'Oturum süresi doldu. Tekrar giriş yapın.' });
  next();
});

r.post('/logout', (req, res) => {
  sessions.delete(req.session.token);
  setCookie(req, res, '', 0);
  res.json({ ok: true });
});
r.get('/me', (req, res) => res.json({ user: userOut(req.session) }));

r.get('/branches', wrap(async (req, res) => res.json(await api.branches())));
// Paket servis bölümü: SAS_PAKET_FIELD (bölüm id) verilmişse o, yoksa adı "paket" içeren bölümler
const PAKET_ID = process.env.SAS_PAKET_FIELD ? Number(process.env.SAS_PAKET_FIELD) : null;
const isPaket = (f) => (PAKET_ID != null ? f.id === PAKET_ID : /paket|gel\s*al|take\s*away/i.test(f.name));
r.get('/fields', wrap(async (req, res) => {
  const raw = (await api.fields()).map((f) => ({ id: String(f.id), fid: f.id, name: f.name, paket: isPaket(f) }));
  const split = BAHCE.size && !raw.some((f) => /bah[cç]e/i.test(f.name))
    ? raw.find((f) => !f.paket && /salon/i.test(f.name)) || raw.find((f) => !f.paket)
    : null;
  res.json(raw.flatMap((f) => (f !== split ? [f] : [
    { ...f, part: 'salon' },
    { id: `${f.fid}-bahce`, fid: f.fid, name: 'Bahçe', paket: false, part: 'bahce' },
  ])));
}));
r.get('/tables', wrap(async (req, res) => {
  const { part } = req.query;
  if (part !== undefined && part !== 'salon' && part !== 'bahce') throw new BadRequest('Geçersiz parametre: part');
  if (req.query.field === undefined) return res.json(await api.tables(null)); // tüm bölümlerdeki açık adisyonlar
  let rows = fullTableList(await api.tables(intParam(req.query.field, 'field')));
  if (part) rows = rows.filter((t) => BAHCE.has(t.no) === (part === 'bahce'));
  res.json(rows);
}));
r.get('/categories', wrap(async (req, res) => res.json(await api.categories())));
r.get('/products', wrap(async (req, res) => res.json(await api.products(intParam(req.query.cat, 'cat')))));
r.get('/sales/:sid', wrap(async (req, res) => res.json(await api.salesDetails(intParam(req.params.sid, 'sid', 1)))));
r.post('/sales/:sid/print', wrap(async (req, res) => {
  await api.print(intParam(req.params.sid, 'sid', 1));
  res.json({ ok: true });
}));

r.post('/orders', wrap(async (req, res) => {
  const b = req.body || {};
  const fid = intParam(b.fid, 'fid');
  const tid = intParam(b.tid, 'tid', 1);
  const sid = intParam(b.sid ?? 0, 'sid');
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 200) throw new BadRequest('Sepet boş.');
  const items = b.items.map((it) => {
    const quantity = intParam(it && it.quantity, 'quantity', 1);
    if (quantity > 999) throw new BadRequest('Geçersiz adet.');
    return {
      id: intParam(it.id, 'id', 1),
      quantity,
      comment: typeof it.comment === 'string' ? it.comment.trim().slice(0, 200) : '',
    };
  });
  // uid / uname istemciden değil oturumdan alınır
  const out = await api.saveSales({ fid, tid, sid, uid: req.session.uid, uname: req.session.uname }, items);
  // Not: SAS sunucusu sipariş kaydında fişi kendisi basar; mobil API'de bunu kapatan parametre yoktur.
  res.json({ ok: true, ...out });
}));

r.use('/reports', (req, res, next) => {
  if (!canReport(req.session)) return res.status(403).json({ error: 'Raporları yalnızca kasiyer görebilir.' });
  next();
});
r.get('/reports/payments', wrap(async (req, res) => res.json(await api.payments(...businessRange(req.query)))));
r.get('/reports/sales', wrap(async (req, res) => res.json(await api.salesReport(...businessRange(req.query)))));

r.use((req, res) => res.status(404).json({ error: 'Bulunamadı.' }));
// eslint-disable-next-line no-unused-vars
r.use((err, req, res, next) => {
  const known = err instanceof SasError || err instanceof BadRequest || err.type === 'entity.parse.failed';
  if (!known) console.error(err);
  res.status(known ? err.status || 400 : 500).json({ error: known ? err.message : 'Beklenmeyen bir hata oluştu.' });
});

app.use('/api', r);
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    if (/(sw\.js|index\.html|manifest\.webmanifest)$/.test(file)) res.set('Cache-Control', 'no-cache');
  },
}));

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`SAS Smart PWA → http://localhost:${port}`);
    console.log(cfg.mock ? 'DEMO modu (SAS_MOCK=1): giriş demo / demo / demo' : `SAS sunucusu: ${cfg.host || '(SAS_HOST ayarlanmamış!)'}:${cfg.port}`);
  });
}

module.exports = app;
