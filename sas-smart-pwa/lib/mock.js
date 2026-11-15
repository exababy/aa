'use strict';
/**
 * Demo / test için bellek içi sahte SAS sunucusu (SAS_MOCK=1).
 * Yanıtlar gerçek API'deki zarf ve alan adlarıyla (SasResult<T>) üretilir.
 * Giriş: müşteri kodu "demo", kullanıcı "demo", şifre "demo".
 */
const ok = (Data, Message = '') => ({ Result: true, Data, Message });
const fail = (Message) => ({ Result: false, Data: null, Message });

const fields = [{ id: 1, name: 'Salon' }, { id: 2, name: 'Bahçe' }, { id: 3, name: 'Teras' }];
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
    PrId: ++pid, PrName, Price_s, P_Type: 0, Quantity: 0, PrComment: '', TmpIndex: 0, Price_t: 0,
  }));
}

const tables = [];
let tableId = 0;
for (const f of fields) for (let i = 1; i <= 12; i++) tables.push({ TableId: ++tableId, field: f.id, TableName: `${f.name} ${i}` });

let nextSid = 40;
let nextDsid = 1;
const sales = new Map(); // sid -> { tid, lines, opened, usr }
const stamp = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

function addSale(tid, lines, usr, minutesAgo = 0) {
  const sid = ++nextSid;
  sales.set(sid, { tid, lines: [], opened: Date.now() - minutesAgo * 60000, usr });
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

function tableRow(t) {
  const entry = [...sales.entries()].find(([, s]) => s.tid === t.TableId);
  if (!entry) {
    return { Sid: 0, TableName: t.TableName, Days: 0, Hours: 0, Minutes: 0, TotalPrice: 0, Discount: 0, Usr: '', OpenDate: '', TableId: t.TableId };
  }
  const [sid, s] = entry;
  const mins = Math.floor((Date.now() - s.opened) / 60000);
  return {
    Sid: sid, TableName: t.TableName, Days: 0, Hours: Math.floor(mins / 60), Minutes: mins % 60,
    TotalPrice: s.lines.reduce((a, l) => a + l.Price_s * l.Quantity, 0), Discount: 0,
    Usr: s.usr, OpenDate: stamp(s.opened), TableId: t.TableId,
  };
}
const kitchen = (from, to) => [...sales.entries()].slice(from, to).map(([sid, s]) => ({
  sid, cname: tables.find((t) => t.TableId === s.tid).TableName,
  urunler: s.lines.map((l) => `${l.Quantity} x ${l.PrName}`).join('\n'), salesdate: stamp(s.opened),
}));

function handle(action, p, body) {
  switch (action) {
    case 'Auth':
      return p.cc === 'demo' && p.un === 'demo' && p.pw === 'demo'
        ? ok([{ id: 7, name: 'Demo Garson', auth: 1 }])
        : fail('Kullanıcı adı veya şifre hatalı');
    case 'Branch': return ok([{ id: 1, secid: 1, shortcode: 'MERKEZ', ip: '' }]);
    case 'Fields': return ok(fields);
    case 'TableStatus': {
      const rows = tables.filter((t) => p.field == null || t.field === Number(p.field)).map(tableRow);
      return ok(p.field == null ? rows.filter((r) => r.Sid) : rows);
    }
    case 'MenuCat': return ok(cats);
    case 'Product': return ok(products[p.cat] || []);
    case 'SaveSales': {
      if (!Array.isArray(body) || !body.length) return fail('Boş sipariş');
      let sid = Number(p.sid);
      if (sid && sales.has(sid)) appendLines(sid, body);
      else sid = addSale(Number(p.tid), body, p.uname);
      return ok(sid, 'OK');
    }
    case 'SalesDetails': {
      const s = sales.get(Number(p.sid));
      if (!s) return ok([]);
      const name = tables.find((t) => t.TableId === s.tid).TableName;
      return ok(s.lines.map((l) => ({
        Dsid: l.Dsid, Sid: Number(p.sid), TableName: name, ProductName: l.PrName,
        UnitPrice: l.Price_s, TotalPrice: l.Price_s * l.Quantity, Quantity: l.Quantity, SalesDate: stamp(l.at),
      })));
    }
    case 'SalesPrint': return sales.has(Number(p.sid)) ? ok([]) : fail('Adisyon bulunamadı');
    case 'Bekleyen': return ok(kitchen(2));
    case 'Hazirlaniyor': return ok(kitchen(1, 2));
    case 'Hazir': return ok(kitchen(0, 1));
    case 'Payments': return ok([
      { PayId: 1, Sid: 31, TableName: 'Salon 3', Days: 0, Hours: 1, Minutes: 5, PayDate: stamp(Date.now() - 7200000), TotalPrice: 1240, PayType: 'Satış', PayMethod: 'Nakit', Usr: 'demo', TableId: 3 },
      { PayId: 2, Sid: 32, TableName: 'Bahçe 1', Days: 0, Hours: 0, Minutes: 48, PayDate: stamp(Date.now() - 3600000), TotalPrice: 2180.5, PayType: 'Satış', PayMethod: 'Kredi Kartı', Usr: 'demo', TableId: 13 },
      { PayId: 3, Sid: 33, TableName: 'Salon 8', Days: 0, Hours: 0, Minutes: 30, PayDate: stamp(Date.now() - 1800000), TotalPrice: 760, PayType: 'Satış', PayMethod: 'Kredi Kartı', Usr: 'demo', TableId: 8 },
    ]);
    case 'SalesReport': return ok(all.slice(0, 9).map((pr, i) => ({ Prid: pr.PrId, Prname: pr.PrName, Quantity: 31 - i * 3, Mid: 1 })));
    default: return fail('Bilinmeyen işlem');
  }
}

module.exports = { handle };
