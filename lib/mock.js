'use strict';
/**
 * Demo / test için bellek içi sahte SAS sunucusu (SAS_MOCK=1).
 * Yanıtlar gerçek API'deki zarf ve alan adlarıyla (SasResult<T>) üretilir.
 * Giriş: müşteri kodu "demo"; kasiyer: demo / demo, garson: garson / garson.
 */
const ok = (Data, Message = '') => ({ Result: true, Data, Message });
const fail = (Message) => ({ Result: false, Data: null, Message });

// Gerçek sunucuda Fields yalnızca Salon döndürür (pda filtresi).
const fields = [{ id: 1, name: 'Salon' }];
const cats = [
  { id: 1, name: 'Kebaplar' }, { id: 2, name: 'Dürümler' }, { id: 3, name: 'Pide & Lahmacun' },
  { id: 4, name: 'İçecekler' }, { id: 5, name: 'Tatlılar' },
];
const menu = {
  1: [['Adana Kebap', 420], ['Urfa Kebap', 420], ['Beyti Sarma', 480], ['Kuzu Şiş', 520], ['Tavuk Şiş', 360], ['Karışık Izgara', 690]],
  2: [['Adana Dürüm', 260], ['Urfa Dürüm', 260], ['Tavuk Dürüm', 210], ['Ciğer Dürüm', 280]],
  3: [['Lahmacun', 110], ['Kıymalı Pide', 290], ['Kuşbaşılı Pide', 340], ['Kaşarlı Pide', 260]],
  4: [['Ayran', 40], ['Şalgam', 45], ['Kola', 70], ['Su', 20], ['Çay', 25]],
  5: [['Künefe', 190], ['Baklava', 220], ['Sütlaç', 130]],
};
let pid = 100;
const products = {};
for (const [cat, rows] of Object.entries(menu)) {
  products[cat] = rows.map(([PrName, Price_s]) => ({
    PrId: ++pid, PrName, Price_s, P_Type: cat === '1' || cat === '2' ? 2 : 0, // kebap ve dürümler SAS'ta yarım porsiyon tipinde
    Quantity: 0, PrComment: '', TmpIndex: 0, Price_t: 0,
  }));
}

const fieldName = (id) => (fields.find((f) => f.id === id) || {}).name || '';
const saleName = (s) => `${fieldName(s.field)}-${s.tid}`;

let nextSid = 40;
let nextDsid = 1;
const sales = new Map(); // sid -> { field, tid, lines, opened, usr }
const stamp = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

function addSale(tid, lines, usr, minutesAgo = 0, field = 1) {
  const sid = ++nextSid;
  sales.set(sid, { field, tid, lines: [], opened: Date.now() - minutesAgo * 60000, usr });
  appendLines(sid, lines);
  return sid;
}
function appendLines(sid, lines) {
  const s = sales.get(sid);
  for (const l of lines) s.lines.push({ ...l, Dsid: nextDsid++, at: Date.now() });
}
const all = Object.values(products).flat();
addSale(2, [{ ...all[0], Quantity: 2 }, { ...all[14], Quantity: 2 }], 'demo', 35);
addSale(5, [{ ...all[10], Quantity: 4 }, { ...all[16], Quantity: 1 }], 'demo', 82);
addSale(15, [{ ...all[6], Quantity: 3 }], 'demo', 12);
addSale(51, [{ ...all[2], Quantity: 1 }], 'demo', 20);
addSale(23, [{ ...all[4], Quantity: 2 }, { ...all[17], Quantity: 2 }], 'demo', 48);

function tableRow([sid, s]) {
  const mins = Math.floor((Date.now() - s.opened) / 60000);
  return {
    Sid: sid, TableName: saleName(s), Days: 0, Hours: Math.floor(mins / 60), Minutes: mins % 60,
    TotalPrice: s.lines.reduce((a, l) => a + l.Price_s * l.Quantity, 0), Discount: 0,
    Usr: s.usr, OpenDate: stamp(s.opened), TableId: s.tid,
  };
}
function handle(action, p, body) {
  switch (action) {
    case 'Auth':
      if (p.cc === 'demo' && p.un === 'demo' && p.pw === 'demo') return ok([{ id: 7, name: 'Demo Kasiyer', auth: 1 }]);
      if (p.cc === 'demo' && p.un === 'garson' && p.pw === 'garson') return ok([{ id: 8, name: 'Demo Garson', auth: 14 }]);
      return fail('Kullanıcı adı veya şifre hatalı');
    case 'Branch': return ok([{ id: 1, secid: 1, shortcode: 'MERKEZ', ip: '' }]);
    case 'Fields': return ok(fields);
    case 'TableStatus': // gerçek sunucu gibi: yalnızca açık masalar
      return ok([...sales.entries()].filter(([, s]) => p.field == null || s.field === Number(p.field)).map(tableRow));
    case 'MenuCat': return ok(cats);
    case 'Product': return ok(products[p.cat] || []);
    case 'SaveSales': {
      if (!Array.isArray(body) || !body.length) return fail('Boş sipariş');
      let sid = Number(p.sid);
      if (sid && sales.has(sid)) appendLines(sid, body);
      else sid = addSale(Number(p.tid), body, p.uname, 0, Number(p.fid));
      return ok(sid, p.comm ? 'comm:' + p.comm : 'OK'); // comm'u testte doğrulamak için yansıt
    }
    case 'SalesDetails': {
      const s = sales.get(Number(p.sid));
      if (!s) return ok([]);
      const name = saleName(s);
      return ok(s.lines.map((l) => ({
        Dsid: l.Dsid, Sid: Number(p.sid), TableName: name, ProductName: l.PrName,
        UnitPrice: l.Price_s, TotalPrice: l.Price_s * l.Quantity, Quantity: l.Quantity, SalesDate: stamp(l.at),
      })));
    }
    case 'SalesPrint': return sales.has(Number(p.sid)) ? ok([]) : fail('Adisyon bulunamadı');
    case 'Payments': return ok([
      { PayId: 1, Sid: 31, TableName: '3', Days: 0, Hours: 1, Minutes: 5, PayDate: stamp(Date.now() - 7200000), TotalPrice: 1240, PayType: 'Satış', PayMethod: 'Nakit', Usr: 'demo', TableId: 3 },
      { PayId: 2, Sid: 32, TableName: '12', Days: 0, Hours: 0, Minutes: 48, PayDate: stamp(Date.now() - 3600000), TotalPrice: 2180.5, PayType: 'Satış', PayMethod: 'Kredi Kartı', Usr: 'demo', TableId: 13 },
      { PayId: 3, Sid: 33, TableName: '8', Days: 0, Hours: 0, Minutes: 30, PayDate: stamp(Date.now() - 1800000), TotalPrice: 760, PayType: 'Satış', PayMethod: 'Kredi Kartı', Usr: 'demo', TableId: 8 },
    ]);
    case 'SalesReport': return ok(all.slice(0, 9).map((pr, i) => ({ Prid: pr.PrId, Prname: pr.PrName, Quantity: 31 - i * 3, Mid: 1 })));
    default: return fail('Bilinmeyen işlem');
  }
}

module.exports = { handle };
