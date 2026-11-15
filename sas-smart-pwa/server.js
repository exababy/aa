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
  res.json({ user: { id: user.uid, name: user.uname } });
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
r.get('/me', (req, res) => res.json({ user: { id: req.session.uid, name: req.session.uname } }));

r.get('/branches', wrap(async (req, res) => res.json(await api.branches())));
r.get('/fields', wrap(async (req, res) => res.json(await api.fields())));
r.get('/tables', wrap(async (req, res) =>
  res.json(await api.tables(req.query.field === undefined ? null : intParam(req.query.field, 'field')))));
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
  res.json({ ok: true, ...out });
}));

const KITCHEN = { bekleyen: 'Bekleyen', hazirlaniyor: 'Hazirlaniyor', hazir: 'Hazir' };
r.get('/kitchen/:status', wrap(async (req, res) => {
  const action = Object.hasOwn(KITCHEN, req.params.status) && KITCHEN[req.params.status];
  if (!action) throw new BadRequest('Geçersiz durum.');
  res.json(await api.kitchen(action));
}));

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
