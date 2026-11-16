'use strict';
/**
 * DEMO / TEST şeması ve örnek veri. Canlı `netchief` veritabanına ASLA uygulanmaz;
 * yalnızca POS_DEMO=1 (SQLite) ve testlerde kullanılır. Tablo ve kolon adları exe.md §3'teki
 * (orijinal programın SQL'lerinden çıkarılmış) şemayı izler.
 */

const DETAIL_COLS = [
  ['fieldid', 'int'], ['tableid', 'int'], ['salesid', 'int'], ['salesdate', 'dt'], ['unitprice', 'dec'], ['prid', 'int'],
  ['prname', 'str'], ['quantity', 'dec'], ['catid', 'int'], ['isgift', 'int'], ['totalprice', 'dec'], ['userid', 'int'],
  ['username', 'str'], ['salesprice', 'dec'], ['pricegroup', 'int'], ['isprinted', 'int'], ['prn', 'str'],
  ['notprepare', 'int'], ['comment', 'str'], ['uretim', 'int'], ['mfd', 'int'], ['ispay', 'dec'], ['hm_c', 'int'],
  ['p_type', 'str'], ['section', 'int'], ['prmalz', 'str'], ['prmalzex', 'str'], ['propt', 'str'], ['prstatus', 'int'], ['mid', 'int'],
];

const TABLES = {
  lmv_fields: ['id', [['name', 'str'], ['tag', 'int', 1], ['pda', 'int', 1]]],
  lmv_users: ['id', [['name', 'str'], ['password', 'str'], ['auth', 'int', 14], ['userauth', 'int'], ['section', 'int'], ['smartlogin', 'int'], ['crid', 'str']]],
  lmv_staff: ['id', [['namesurname', 'str'], ['gorevi', 'str'], ['ucret', 'dec'], ['tag', 'int', 1]]],
  lmv_menu_cat_top: ['id', [['name', 'str'], ['tag', 'int', 1], ['psort', 'int'], ['menualt', 'int', 1]]],
  lmv_product: ['prid', [['prname', 'str'], ['catid', 'int'], ['price', 'dec'], ['price_s', 'dec'], ['price_fd', 'dec'],
    ['price_yr', 'dec'], ['p_type', 'int'], ['prn', 'str'], ['inuse', 'int', 1], ['pdasort', 'int'], ['hm', 'int'],
    ['hm_c', 'int'], ['packqty', 'dec'], ['mid', 'int']]],
  lmv_sales: ['sid', [['fieldid', 'int'], ['tableid', 'int'], ['userid', 'int'], ['username', 'str'], ['inuse', 'int'],
    ['open_date', 'dt'], ['salesdate', 'dt'], ['pax', 'int'], ['prepay', 'dec'], ['discounted', 'dec'], ['discounttag', 'str'],
    ['comments', 'str'], ['paket', 'str', '0'], ['paket_id', 'int'], ['totalprice', 'dec'], ['isprinted', 'int'], ['islocked', 'int'],
    ['ispayed', 'int'], ['alerton', 'int'], ['alerttime', 'dt'], ['tag11', 'str'], ['section', 'int']]],
  lmv_salesdetails: ['detailedsalesid', DETAIL_COLS],
  lmv_salesdetails_del: ['detailedsalesid', DETAIL_COLS],
  lmv_payments: ['payid', [['fieldid', 'int'], ['tableid', 'int'], ['salesid', 'int'], ['totalprice', 'dec'], ['userid', 'int'],
    ['username', 'str'], ['paymethod', 'int'], ['paymethoddetails', 'int'], ['pay_comment', 'str'], ['pay_type', 'str'],
    ['paydate', 'dt'], ['paytag', 'str']]],
  lmv_customer: ['cid', [['cname', 'str'], ['caddress', 'str'], ['cphone', 'str'], ['ccomment', 'str'], ['inuse', 'int', 1], ['bakiye', 'dec'], ['static', 'int']]],
  lmv_rezerv: ['rid', [['rname', 'str'], ['rphone', 'str'], ['rdate', 'str'], ['rtime', 'str'], ['rcomment', 'str'], ['rpax', 'int'], ['rpaxc', 'int'], ['rtable', 'str']]],
  lmv_payoutunit: ['id', [['name', 'str']]],
  lmv_calls: ['cid', [['callerid', 'str'], ['call_chan', 'str'], ['call_time', 'str'], ['call_date', 'dt'], ['customer_id', 'int'], ['customer', 'str']]],
  lmv_ccard: ['id', [['cname', 'str'], ['tag', 'int']]],
};

function ddl(dialect) {
  const my = dialect === 'mysql';
  const type = (t, def) => ({
    int: `INTEGER NOT NULL DEFAULT ${def ?? 0}`,
    dec: `${my ? 'DECIMAL(12,3)' : 'REAL'} NOT NULL DEFAULT ${def ?? 0}`,
    str: `${my ? 'VARCHAR(255)' : 'TEXT'} NOT NULL DEFAULT '${def ?? ''}'`,
    dt: `${my ? 'DATETIME' : 'TEXT'} NULL`,
  }[t]);
  return Object.entries(TABLES).map(([name, [pk, cols]]) => {
    const id = my ? `${pk} INTEGER AUTO_INCREMENT PRIMARY KEY` : `${pk} INTEGER PRIMARY KEY AUTOINCREMENT`;
    return `CREATE TABLE ${name} (${[id, ...cols.map(([c, t, d]) => `${c} ${type(t, d)}`)].join(', ')})`;
  }).join(';\n');
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const MENU = [
  ['Kebaplar', 'KEBAP', 2, [['Adana Kebap', 420], ['Urfa Kebap', 420], ['Beyti Sarma', 480], ['Kuzu Şiş', 520], ['Tavuk Şiş', 360],
    ['Karışık Izgara', 690], ['Patlıcan Kebap', 460], ['Ciğer Şiş', 400], ['Kanat', 340], ['Pirzola', 720]]],
  ['Dürümler', 'KEBAP', 0, [['Adana Dürüm', 260], ['Urfa Dürüm', 260], ['Tavuk Dürüm', 210], ['Ciğer Dürüm', 280], ['Kuzu Şiş Dürüm', 320]]],
  ['Pide & Lahmacun', 'FIRIN', 0, [['Lahmacun', 110], ['Kıymalı Pide', 290], ['Kuşbaşılı Pide', 340], ['Kaşarlı Pide', 260], ['Karışık Pide', 360]]],
  ['Ara Sıcak', 'MUTFAK', 0, [['Mercimek Çorbası', 120], ['İçli Köfte', 95], ['Çiğ Köfte', 140], ['Humus', 130], ['Sigara Böreği', 150]]],
  ['Salata & Meze', 'MUTFAK', 0, [['Çoban Salata', 120], ['Gavurdağı Salata', 160], ['Ezme', 80], ['Haydari', 90], ['Közlenmiş Biber', 95]]],
  ['İçecekler', 'BAR', 0, [['Ayran', 40], ['Şalgam', 45], ['Kola', 70], ['Fanta', 70], ['Soda', 35], ['Su', 20], ['Çay', 25], ['Türk Kahvesi', 60]]],
  ['Tatlılar', 'BAR', 0, [['Künefe', 190], ['Fıstıklı Baklava', 220], ['Sütlaç', 130], ['Katmer', 240]]],
  ['Kiloluk', 'KEBAP', 1, [['Adana (kg)', 1600], ['Kuzu Şiş (kg)', 2100], ['Baklava (kg)', 1400]]],
];

/** Demo verisi: menü, kullanıcılar, birkaç açık masa, bugünün ödemeleri, cari ve rezervasyon. */
async function seed(db) {
  const ins = async (table, row) => {
    const keys = Object.keys(row);
    return (await db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(row))).insertId;
  };
  for (const name of ['Salon', 'Paket Servis', 'Bekleyen', 'Rezervasyon', 'Çağrı Merkezi', 'Kasa Çıkış']) await ins('lmv_fields', { name, tag: 1, pda: name === 'Salon' ? 1 : 0 });
  // userauth: 0 garson, 1 ödeme alabilir / ayarlara girebilir, 2 iptal-indirim-bedelsiz yetkisi (orijinal programdaki anlamlar)
  const users = [['Kasiyer', '1234', 11, 2], ['Yalçın', '1234', 12, 2], ['Ahmet', '1111', 14, 0], ['Mehmet', '2222', 14, 0], ['Zeynep', '3333', 14, 1]];
  for (const [name, password, auth, userauth] of users) await ins('lmv_users', { name, password, auth, userauth });
  for (const name of ['Genel Giderler', 'Sarf Malzeme', 'Araç Yakıt', 'Yemek', 'Personel', 'Tepsi İade']) await ins('lmv_payoutunit', { name });
  for (const [namesurname, gorevi, ucret] of [['Ali Usta', 'ŞEF', 42000], ['Hasan Demir', 'PAKETÇİ', 28000], ['Ayşe Kaya', 'MUTFAK', 26000]]) {
    await ins('lmv_staff', { namesurname, gorevi, ucret });
  }
  const products = [];
  let sort = 100;
  for (const [i, [name, prn, ptype, rows]] of MENU.entries()) {
    const catid = await ins('lmv_menu_cat_top', { name, psort: i + 1 });
    for (const [prname, price] of rows) {
      const prid = await ins('lmv_product', { prname, catid, price, price_s: price, p_type: ptype, prn, pdasort: sort-- });
      products.push({ prid, prname, catid, price, prn, p_type: ptype });
    }
  }
  await ins('lmv_menu_cat_top', { id: 999, name: 'JOKER', psort: 99 });
  await ins('lmv_product', { prname: 'Kurye Bedeli', catid: 1, price: 50, price_s: 50, inuse: 0 });
  await ins('lmv_ccard', { cname: 'Refresh', tag: 0 });

  const customers = [
    ['Mustafa Öztürk', 'Atatürk Cad. No:12 D:3', '05321112233', 'Kapıyı çalmayın, arayın'],
    ['Elif Yıldız', 'Cumhuriyet Mah. 45. Sk. No:7', '05445556677', ''],
    ['Demir İnşaat Ltd.', 'Sanayi Sitesi B Blok No:21', '03422223344', 'Aylık cari'],
    ['Okan Şahin', 'Bahçelievler 3. Cad. No:9', '05057778899', ''],
  ];
  const cids = [];
  for (const [cname, caddress, cphone, ccomment] of customers) cids.push(await ins('lmv_customer', { cname, caddress, cphone, ccomment }));

  const now = Date.now();
  const P = (name) => products.find((p) => p.prname === name);
  const addSale = async (fieldid, tableid, user, minutesAgo, items, extra = {}) => {
    const open = stamp(new Date(now - minutesAgo * 60000));
    const sid = await ins('lmv_sales', { fieldid, tableid, userid: user[0], username: user[1], inuse: 1, open_date: open, salesdate: open, pax: 2, ...extra });
    let total = 0;
    for (const [name, quantity, comment = ''] of items) {
      const p = P(name);
      total += p.price * quantity;
      await ins('lmv_salesdetails', {
        fieldid, tableid, salesid: sid, salesdate: open, unitprice: p.price, prid: p.prid, prname: p.prname, quantity, catid: p.catid,
        totalprice: p.price * quantity, userid: user[0], username: user[1], salesprice: p.price, pricegroup: 1, isprinted: 1,
        prn: p.prn, p_type: '', comment,
      });
    }
    await db.run('UPDATE lmv_sales SET totalprice=? WHERE sid=?', [total, sid]);
    return { sid, total };
  };
  const ahmet = [3, 'Ahmet'];
  const mehmet = [4, 'Mehmet'];
  await addSale(1, 3, ahmet, 18, [['Adana Kebap', 2, 'Acılı'], ['Ayran', 2], ['Çoban Salata', 1]], { pax: 2 });
  await addSale(1, 7, mehmet, 52, [['Karışık Izgara', 1], ['Kuzu Şiş', 1.5], ['Şalgam', 3], ['Künefe', 2]], { pax: 4 });
  await addSale(1, 12, ahmet, 96, [['Lahmacun', 6], ['Ayran', 4], ['Mercimek Çorbası', 2]], { pax: 4, isprinted: 1, islocked: 1 });
  await addSale(1, 18, mehmet, 7, [['Tavuk Şiş', 1], ['Kola', 1]], { pax: 1 });
  await addSale(1, 24, ahmet, 33, [['Beyti Sarma', 2], ['Gavurdağı Salata', 1], ['Soda', 2], ['Fıstıklı Baklava', 1]], { pax: 2 });
  await addSale(1, 31, [5, 'Zeynep'], 71, [['Pirzola', 2], ['Humus', 1], ['Ezme', 1], ['Şalgam', 2], ['Katmer', 1]], { pax: 3 });
  await addSale(1, 51, mehmet, 24, [['Kıymalı Pide', 2], ['Ayran', 2]], { pax: 2 });
  await addSale(2, 1, [2, 'Kasa'], 12, [['Adana Dürüm', 3], ['Ayran', 3]], { paket: 'Mustafa Öztürk', paket_id: cids[0], tag11: 'Kapıda kart' });

  // Bugün kapanmış adisyonlar ve ödemeleri (raporlar dolu görünsün)
  const closed = [
    [5, 190, 1, [['Adana Kebap', 2], ['Ayran', 2]]], [9, 170, 2, [['Karışık Pide', 1], ['Lahmacun', 4], ['Kola', 2]]],
    [14, 150, 1, [['Kuzu Şiş', 2], ['Çoban Salata', 1], ['Şalgam', 2]]], [2, 130, 2, [['Urfa Dürüm', 2], ['Ayran', 2]]],
    [20, 110, 1, [['Beyti Sarma', 1], ['Tavuk Şiş', 1], ['Künefe', 2], ['Çay', 4]]], [8, 85, 2, [['Pirzola', 1], ['Ezme', 1], ['Soda', 1]]],
    [40, 60, 3, [['Adana Dürüm', 10], ['Ayran', 10]]],
  ];
  for (const [tableid, ago, method, items] of closed) {
    const { sid, total } = await addSale(1, tableid, ahmet, ago, items);
    const paid = stamp(new Date(now - (ago - 40 > 1 ? ago - 40 : 1) * 60000));
    await db.run('UPDATE lmv_sales SET inuse=0, ispayed=1, prepay=?, totalprice=0, salesdate=? WHERE sid=?', [total, paid, sid]);
    await ins('lmv_payments', {
      fieldid: 1, tableid, salesid: sid, totalprice: total, userid: 2, username: 'Kasa', paymethod: method,
      paymethoddetails: method === 3 ? cids[2] : 0, pay_comment: ['', 'Nakit', 'Kredi Kartı', customers[2][0]][method],
      pay_type: ['', 'Nakit', 'Kredi Kartı', 'Kapalı'][method], paydate: paid,
    });
    if (method === 3) await db.run('UPDATE lmv_customer SET bakiye=bakiye+? WHERE cid=?', [total, cids[2]]);
  }
  const today = stamp(new Date()).slice(0, 10);
  for (const [rname, rphone, rtime, rcomment] of [['Kemal Bey', '05331234567', '19:30', 'Cam kenarı'], ['Selin Hanım', '05429876543', '20:00', 'Doğum günü pastası gelecek']]) {
    await ins('lmv_rezerv', { rname, rphone, rdate: today, rtime, rcomment, rpax: rname[0] === 'K' ? 8 : 12, rpaxc: rname[0] === 'K' ? 0 : 2, rtable: rname[0] === 'K' ? '31' : '40-42' });
  }
}

async function install(db) {
  await db.exec(ddl(db.dialect));
  await seed(db);
}

module.exports = { ddl, seed, install, TABLES, DETAIL_COLS: DETAIL_COLS.map((c) => c[0]) };
