'use strict';
/**
 * SAS Smart PWA — Express BFF (proxy) + statik PWA sunucusu.
 *   [Tarayıcı / PWA] → /api/* → [bu sunucu] → http://{SAS_HOST}:8081/SASncps/@Action/...
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { api, cfg, SasError, HALF_TYPE } = require('./lib/sas');

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
const userOut = (u) => ({ id: u.uid, name: u.uname, auth: u.auth, reports: canReport(u) });

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

// Sürüm: arayüz dosyaları değişince değişir. index.html'deki dosya adreslerine eklenir (?v=...),
// böylece telefon eski app.js / styles.css dosyasını önbellekten kullanamaz.
const PUBLIC = path.join(__dirname, 'public');
const APP_SEMVER = require('./package.json').version;
function buildVersion() {
  const h = crypto.createHash('sha1');
  for (const f of ['index.html', 'app.js', 'styles.css', 'sw.js']) {
    const st = fs.statSync(path.join(PUBLIC, f));
    h.update(`${f}:${st.size}:${st.mtimeMs};`);
  }
  return `${APP_SEMVER}-${h.digest('hex').slice(0, 7)}`;
}
r.get('/version', (req, res) => res.json({ version: buildVersion() }));

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
  attempts.delete(req.ip); // başarılı giriş sayacı sıfırlar (aynı ağdaki telefonlar birbirini kilitlemesin)
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
r.get('/fields', wrap(async (req, res) => {
  const raw = (await api.fields()).map((f) => ({ id: String(f.id), fid: f.id, name: f.name }));
  // SAS'ta ayrı bir "Bahçe" bölümü yoksa Salon'u Salon + Bahçe olarak ikiye böl.
  const split = BAHCE.size && !raw.some((f) => /bah[cç]e/i.test(f.name))
    ? raw.find((f) => /salon/i.test(f.name)) || raw[0]
    : null;
  res.json(raw.flatMap((f) => (f !== split ? [f] : [
    { ...f, part: 'salon' },
    { id: `${f.fid}-bahce`, fid: f.fid, name: 'Bahçe', part: 'bahce' },
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
// Gizli ürünler: SAS API'si kasada kullanılmayan ürünleri de (örn. "Kurye Bedeli") döndürür ve ayırt edecek
// bir alan vermez. Kasiyer bunları Ayarlar > Menü düzeni ekranından gizler; liste sunucuda dosyada tutulur.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
function hiddenStore(fileName) {
  const file = path.join(DATA_DIR, fileName);
  const map = new Map(); // id -> ad
  try {
    for (const [id, name] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) map.set(Number(id), String(name));
  } catch { /* dosya yoksa gizli kayıt yok */ }
  map.save = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(Object.fromEntries(map), null, 2));
    fs.renameSync(file + '.tmp', file);
  };
  return map;
}
const hidden = hiddenStore('hidden-products.json');
const hiddenCats = hiddenStore('hidden-categories.json');
// Yarım porsiyon: SAS'ta tipi 2 olan ürünler yarım satılabilir; kasiyer bunu kategori bazında kapatıp açabilir.
// Ayar yapılmamış kategorilerde varsayılan: adı "dürüm" içerenlerde kapalı, diğerlerinde açık.
const halfCats = hiddenStore('half-categories.json'); // kategori id -> 'on' | 'off'
const NO_HALF_DEFAULT = /d[üu]r[üu]m/i;
const catNames = new Map();
async function categories() {
  const all = await api.categories();
  for (const c of all) catNames.set(c.id, c.name);
  return all;
}
const halfInCat = (id) => (halfCats.has(id) ? halfCats.get(id) === 'on' : !NO_HALF_DEFAULT.test(catNames.get(id) || ''));
const allowHalf = (p) => p.type === HALF_TYPE && halfInCat(p.cat);

const cashierOnly = (req, res, next) => (canReport(req.session)
  ? next() : res.status(403).json({ error: 'Bu işlemi yalnızca kasiyer yapabilir.' }));

r.get('/categories', wrap(async (req, res) => {
  const all = await categories();
  if (req.query.all !== '1') return res.json(all.filter((c) => !hiddenCats.has(c.id)));
  if (!canReport(req.session)) return res.status(403).json({ error: 'Bu işlemi yalnızca kasiyer yapabilir.' });
  res.json(all.map((c) => ({ ...c, hidden: hiddenCats.has(c.id), half: halfInCat(c.id) })));
}));
r.post('/categories/:id/half', cashierOnly, wrap(async (req, res) => {
  const id = intParam(req.params.id, 'id', 1);
  if (typeof (req.body || {}).half !== 'boolean') throw new BadRequest('Geçersiz parametre: half');
  if (!(await categories()).some((c) => c.id === id)) throw new BadRequest('Kategori bulunamadı.');
  halfCats.set(id, req.body.half ? 'on' : 'off');
  halfCats.save();
  res.json({ ok: true, half: req.body.half });
}));
r.post('/categories/:id/hidden', cashierOnly, wrap(async (req, res) => {
  const id = intParam(req.params.id, 'id', 1);
  if (typeof (req.body || {}).hidden !== 'boolean') throw new BadRequest('Geçersiz parametre: hidden');
  if (req.body.hidden) {
    const cat = (await categories()).find((c) => c.id === id);
    if (!cat) throw new BadRequest('Kategori bulunamadı.');
    hiddenCats.set(id, cat.name);
  } else {
    hiddenCats.delete(id);
  }
  hiddenCats.save();
  res.json({ ok: true, hidden: req.body.hidden });
}));

r.get('/products', wrap(async (req, res) => {
  const cat = intParam(req.query.cat, 'cat');
  if (req.query.all !== '1' && hiddenCats.has(cat)) return res.json([]);
  if (!catNames.has(cat)) await categories();
  const all = (await api.products(cat)).map((p) => ({ ...p, half: allowHalf(p) }));
  if (req.query.all !== '1') return res.json(all.filter((p) => !hidden.has(p.id)));
  if (!canReport(req.session)) return res.status(403).json({ error: 'Bu işlemi yalnızca kasiyer yapabilir.' });
  res.json(all.map((p) => ({ ...p, hidden: hidden.has(p.id) })));
}));
r.post('/products/:id/hidden', cashierOnly, wrap(async (req, res) => {
  const id = intParam(req.params.id, 'id', 1);
  if (typeof (req.body || {}).hidden !== 'boolean') throw new BadRequest('Geçersiz parametre: hidden');
  if (req.body.hidden) {
    const [product] = await api.resolveProducts([id]);
    if (!product) throw new BadRequest('Ürün bulunamadı.');
    hidden.set(id, product.name);
  } else {
    hidden.delete(id);
  }
  hidden.save();
  res.json({ ok: true, hidden: req.body.hidden });
}));
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
    // Adet 0,5'in katı olabilir (1,5 porsiyon gibi); ürünün buna uygunluğu saveSales içinde denetlenir.
    const quantity = it && typeof it.quantity === 'number' ? it.quantity : NaN;
    if (!(quantity > 0 && quantity <= 999 && Number.isInteger(quantity * 2))) throw new BadRequest('Geçersiz adet.');
    return {
      id: intParam(it.id, 'id', 1),
      quantity,
      comment: typeof it.comment === 'string' ? it.comment.trim().slice(0, 200) : '',
    };
  });
  // Adisyon notu (SaveSales 'comm' parametresi)
  const comm = typeof b.comm === 'string' ? b.comm.trim().slice(0, 200) : '';
  // uid / uname istemciden değil oturumdan alınır
  const blocked = items.find((it) => hidden.has(it.id));
  if (blocked) throw new BadRequest(`"${hidden.get(blocked.id)}" menüde gizli; sepetten çıkarın.`);
  if (items.some((it) => !Number.isInteger(it.quantity)) && !catNames.size) await categories();
  const out = await api.saveSales({ fid, tid, sid, uid: req.session.uid, uname: req.session.uname, comm }, items, allowHalf);
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
app.get(['/', '/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replaceAll('__V__', buildVersion());
  res.set('Cache-Control', 'no-store').type('html').send(html);
});
app.use(express.static(PUBLIC, {
  index: false,
  setHeaders(res, file) {
    // Sürümlü (?v=) dosyalar dışında her şey her açılışta sunucuya sorulur
    if (/\.(js|css|html|webmanifest)$/.test(file)) res.set('Cache-Control', 'no-cache');
  },
}));

// ---------- Telefona kurulum (yerel HTTPS) ----------
// Chrome bir PWA'yı yalnızca güvenli bağlantıda "Yükle" ile kurar. Sunucu, HTTP'nin yanında kendi ürettiği
// yerel sertifikayla HTTPS de dinler (HTTPS_PORT; varsayılan PORT+1, kapatmak için 0). Bkz. lib/tls.js ve /kurulum.
const HTTP_PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = process.env.HTTPS_PORT === undefined ? HTTP_PORT + 1 : Number(process.env.HTTPS_PORT);
let tls = null;
function tlsFiles() {
  if (!tls && HTTPS_PORT > 0) tls = require('./lib/tls').load(path.join(DATA_DIR, 'tls'), process.env.HTTPS_HOSTS);
  return tls;
}
app.get('/sas-smart-ca.crt', (req, res) => {
  const t = tlsFiles();
  if (!t) return res.status(404).send('HTTPS kapalı.');
  res.set({ 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="sas-smart-ca.crt"', 'Cache-Control': 'no-store' }).send(t.ca);
});
app.get('/kurulum', (req, res) => {
  const t = tlsFiles();
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/[^\w.\-]/g, '');
  const url = `https://${host}:${HTTPS_PORT}/`;
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>SAS Smart — Telefona kurulum</title>
<link rel="stylesheet" href="/styles.css"></head><body><main>
<h1>Telefona kurulum</h1>
<h2>iPhone</h2>
<p>Sertifika gerekmez. <strong>Safari</strong>'de <a href="/">bu adresi</a> açın → alttaki <strong>Paylaş</strong> düğmesi → <strong>Ana Ekrana Ekle</strong> → <strong>Ekle</strong>.</p>
<h2>Android</h2>
${t ? `<p class="muted">Her telefonda bir kez yapılır. Sertifika yalnızca bu sunucuya (yerel ağ) aittir.</p>
<ol>
<li><p><a class="btn primary" href="/sas-smart-ca.crt">1. Sertifikayı indir</a></p></li>
<li><p>2. Telefonda <strong>Ayarlar</strong> → arama kutusuna <strong>sertifika</strong> yazın → <strong>CA sertifikası</strong> (ya da "Sertifika yükle → CA sertifikası") → <strong>Yine de yükle</strong> → indirilen <strong>sas-smart-ca.crt</strong> dosyasını seçin.</p></li>
<li><p>3. Chrome'u tamamen kapatıp açın ve şu adrese gidin:</p><p><a class="btn primary" href="${url}">${url}</a></p></li>
<li><p>4. Chrome menüsü (⋮) → <strong>Ana ekrana ekle</strong> → <strong>Yükle</strong>.</p></li>
</ol>
<p class="muted small">Adres çubuğunda kilit simgesi görünmeli. "Bağlantınız gizli değil" uyarısı çıkarsa 2. adım tamamlanmamıştır.</p>`
    : '<p>Bu sunucuda HTTPS kapalı (HTTPS_PORT=0).</p>'}
</main></body></html>`);
});

if (require.main === module) {
  const host = process.env.HOST || '0.0.0.0';
  app.listen(HTTP_PORT, host, () => {
    console.log(`SAS Smart PWA → http://localhost:${HTTP_PORT}`);
    console.log(cfg.mock ? 'DEMO modu (SAS_MOCK=1): giriş demo / demo / demo' : `SAS sunucusu: ${cfg.host || '(SAS_HOST ayarlanmamış!)'}:${cfg.port}`);
  });
  try {
    const t = tlsFiles();
    if (t) {
      require('node:https').createServer({ key: t.key, cert: t.cert }, app).listen(HTTPS_PORT, host, () => {
        console.log(`HTTPS (telefona kurulum için) → https://${t.hosts[0]}:${HTTPS_PORT}  ·  kurulum adımları: http://${t.hosts[0]}:${HTTP_PORT}/kurulum`);
      }).on('error', (e) => console.error(`HTTPS başlatılamadı (port ${HTTPS_PORT}): ${e.message}`));
    }
  } catch (e) {
    console.error(`HTTPS sertifikası hazırlanamadı: ${e.message}`);
  }
}

module.exports = app;
