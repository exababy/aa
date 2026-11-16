'use strict';
/**
 * SAS Smart Suite backend istemcisi.
 * URL deseni:  http://{host}:{port}/SASncps/@Action/<ACTION>!<?query>
 * Tüm isteklerde SasUsername / SasPasswd header'ları sunucu tarafında eklenir;
 * tarayıcıya asla gönderilmez.
 */
const mock = require('./mock');

const cfg = {
  host: process.env.SAS_HOST || '',
  port: Number(process.env.SAS_PORT || 8081),
  username: process.env.SAS_USERNAME || '',
  passwd: process.env.SAS_PASSWD || '',
  timeoutMs: Number(process.env.SAS_TIMEOUT_MS || 8000),
  mock: process.env.SAS_MOCK === '1',
};

class SasError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function buildUrl(action, params) {
  const qs = params && Object.keys(params).length
    ? '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    : '';
  return `http://${cfg.host}:${cfg.port}/SASncps/@Action/${action}!${qs}`;
}

/** Büyük/küçük harfe duyarsız alan okuma (sunucu PascalCase/karışık döndürüyor). */
function g(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  const lk = key.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lk) return obj[k];
  return undefined;
}

const truthy = (v) => v === true || v === 1 || v === '1' || (typeof v === 'string' && v.toLowerCase() === 'true');

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
const int = (v) => Math.trunc(num(v));
const str = (v) => (v == null ? '' : String(v));

function parseEnvelope(text) {
  let j = text;
  // Bazı .NET servisleri JSON'u string içine sarılı döndürür; iki kata kadar aç.
  for (let i = 0; i < 2 && typeof j === 'string'; i++) {
    try { j = JSON.parse(j); } catch { throw new SasError('SAS sunucusundan geçersiz yanıt alındı.'); }
  }
  if (Array.isArray(j)) return { ok: true, data: j, message: '' };
  if (!j || typeof j !== 'object') throw new SasError('SAS sunucusundan geçersiz yanıt alındı.');
  const result = g(j, 'Result');
  let data = g(j, 'Data');
  if (typeof data === 'string' && /^\s*[[{]/.test(data)) {
    try { data = JSON.parse(data); } catch { /* düz metin olarak bırak */ }
  }
  return {
    ok: result === undefined ? data != null : truthy(result),
    data,
    message: str(g(j, 'Message')),
  };
}

/** Ham SAS çağrısı → { ok, data, message } */
async function call(action, params, body) {
  if (cfg.mock) return parseEnvelope(JSON.stringify(mock.handle(action, params || {}, body)));
  if (!cfg.host) throw new SasError('SAS_HOST ayarlanmamış. .env dosyasını kontrol edin.', 500);

  const headers = { SasUsername: cfg.username, SasPasswd: cfg.passwd, Accept: 'application/json' };
  const init = { method: 'GET', headers, signal: AbortSignal.timeout(cfg.timeoutMs) };
  if (body !== undefined) {
    init.method = 'POST';
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(buildUrl(action, params), init);
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new SasError('SAS sunucusu zamanında yanıt vermedi.', 504);
    throw new SasError('SAS sunucusuna bağlanılamadı.');
  }
  const text = await res.text();
  if (!res.ok) throw new SasError(`SAS sunucusu hata döndürdü (HTTP ${res.status}).`);
  return parseEnvelope(text);
}

const list = (d) => (Array.isArray(d) ? d : d && typeof d === 'object' ? [d] : []);

async function getList(action, params, map) {
  const r = await call(action, params);
  return list(r.data).map(map);
}

// ---- DTO → sade (camelCase) dönüştürücüler ----
const mapIdName = (o) => ({ id: int(g(o, 'id')), name: str(g(o, 'name')) });
const mapProduct = (o) => ({
  id: int(g(o, 'PrId')), name: str(g(o, 'PrName')), price: num(g(o, 'Price_s')), type: int(g(o, 'P_Type')),
});
const mapTable = (o) => ({
  sid: int(g(o, 'Sid')), tableId: int(g(o, 'TableId')), tableName: str(g(o, 'TableName')),
  days: int(g(o, 'Days')), hours: int(g(o, 'Hours')), minutes: int(g(o, 'Minutes')),
  totalPrice: num(g(o, 'TotalPrice')), discount: num(g(o, 'Discount')),
  user: str(g(o, 'Usr')), openDate: str(g(o, 'OpenDate')),
});
const mapDetail = (o) => ({
  dsid: int(g(o, 'Dsid')), sid: int(g(o, 'Sid')), tableName: str(g(o, 'TableName')),
  productName: str(g(o, 'ProductName')), unitPrice: num(g(o, 'UnitPrice')),
  totalPrice: num(g(o, 'TotalPrice')), quantity: num(g(o, 'Quantity')), salesDate: str(g(o, 'SalesDate')),
});
const mapPayment = (o) => ({
  payId: int(g(o, 'PayId')), sid: int(g(o, 'Sid')), tableName: str(g(o, 'TableName')),
  payDate: str(g(o, 'PayDate')), totalPrice: num(g(o, 'TotalPrice')),
  payType: str(g(o, 'PayType')), payMethod: str(g(o, 'PayMethod')), user: str(g(o, 'Usr')),
});
const mapSalesReport = (o) => ({
  id: int(g(o, 'Prid')), name: str(g(o, 'Prname')), quantity: num(g(o, 'Quantity')), categoryId: int(g(o, 'Mid')),
});

const HALF_TYPE = 2;

// ---- Ürün önbelleği: sipariş kaydında fiyat/isim istemciden değil buradan alınır ----
const productCache = new Map();
const remember = (products, cat) => { for (const p of products) { p.cat = cat; productCache.set(p.id, p); } return products; };

const api = {
  async login(cc, un, pw) {
    const r = await call('Auth', { cc, un, pw });
    const d = list(r.data)[0];
    const id = d ? g(d, 'id') : undefined;
    if (!r.ok || id == null || id === '') return null;
    return { uid: int(id), uname: str(g(d, 'name')) || un, auth: int(g(d, 'auth')) };
  },
  branches: () => getList('Branch', { Auth: 22 }, (o) => ({
    id: int(g(o, 'id')), secid: int(g(o, 'secid')), shortcode: str(g(o, 'shortcode')),
  })),
  fields: () => getList('Fields', null, mapIdName),
  tables: (field) => getList('TableStatus', field == null ? null : { field }, mapTable),
  categories: () => getList('MenuCat', null, mapIdName),
  products: async (cat) => remember(await getList('Product', { cat }, mapProduct), cat),
  salesDetails: (sid) => getList('SalesDetails', { sid }, mapDetail),
  async print(sid) {
    const r = await call('SalesPrint', { sid });
    if (!r.ok) throw new SasError(r.message || 'Adisyon yazdırılamadı.');
  },
  payments: (start, end) => getList('Payments', { start, end }, mapPayment),
  salesReport: (start, end) => getList('SalesReport', { start, end }, mapSalesReport),

  async resolveProducts(ids) {
    if (ids.some((id) => !productCache.has(id))) {
      for (const c of await api.categories()) await api.products(c.id);
    }
    return ids.map((id) => productCache.get(id) || null);
  },

  /** items: [{ id, quantity, comment }] */
  async saveSales({ fid, tid, sid, uid, uname, comm = '' }, items, allowHalf = (p) => p.type === HALF_TYPE) {
    const products = await api.resolveProducts(items.map((i) => i.id));
    const missing = products.findIndex((p) => !p);
    if (missing !== -1) throw new SasError('Sepetteki bir ürün artık menüde yok. Menüyü yenileyin.', 400);
    // Orijinal uygulamadaki kural: yalnızca P_Type = 2 olan ürünler yarım porsiyon (0,5 adım) satılır.
    const half = items.findIndex((it, i) => !Number.isInteger(it.quantity) && !allowHalf(products[i]));
    if (half !== -1) throw new SasError(`"${products[half].name}" yarım porsiyon satılamaz.`, 400);
    const body = items.map((it, i) => {
      const p = products[i];
      return {
        PrId: p.id, PrName: p.name, Price_s: p.price, P_Type: p.type,
        Quantity: it.quantity, PrComment: it.comment, TmpIndex: i,
        Price_t: Math.round(p.price * it.quantity * 100) / 100,
      };
    });
    const r = await call('SaveSales', { fid, tid, sid, uid, uname, comm }, body);
    if (!r.ok) throw new SasError(r.message || 'Sipariş kayıt işlemi başarısız!');
    return { message: r.message };
  },
};

module.exports = { api, cfg, SasError, parseEnvelope, buildUrl, HALF_TYPE };
