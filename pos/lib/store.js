'use strict';
/**
 * NetCHIEF Smart POS iş kuralları — `netchief` şeması üzerinde.
 * Davranış ve SQL'ler orijinal programın (NetCHIEF Smart.exe) kaynak çözümlemesinden alınmıştır:
 *   - lmv_sales.totalprice = kalemler toplamı − ön ödeme (prepay); ödenecek = totalprice − discounted
 *   - bedelsiz (ikram) kalem: pricegroup=2, fiyat 0
 *   - paket: müşteri adı (yoksa '0'), paket_id: müşteri no
 *   - yetki: lmv_users.userauth (0 garson, 1 ödeme/ayar, 2 iptal-indirim-bedelsiz); "Kasiyer" ve "root" tam yetkili
 * Yalnızca taşınabilir SQL kullanılır (MySQL + demo için SQLite); okuma sorguları SELECT * ile yapılır.
 */
const dgram = require('node:dgram');
const { kitchenTicket, billTicket } = require('./print');
const { DETAIL_COLS } = require('./schema');

class PosError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const parseStamp = (s) => new Date(String(s || '').replace(' ', 'T'));
const active = (v) => v == null || Number(v) === 1;
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);

const METHODS = { 1: 'Nakit', 2: 'Kredi Kartı', 3: 'Kapalı' };
const SPECIAL = [[/^rezervasyon$/i, 'rezervasyon'], [/^[çc]a[ğg]r[ıi] merkezi$/i, 'cagri'], [/^kasa [çc][ıi]k[ıi][şs]$/i, 'kasa']];
const HIDDEN_FIELD = /senqron|self servis|h[ıi]zl[ıi] sat[ıi][şs]/i;
const PACKET_FIELD = /^(paket servis( [234])?|yemeksepeti|paket geliyor|paket|z paket)$/i;
const FULL_USERS = /^(root|kasiyer)$/i;

function createStore(db, cfg, printer) {
  const one = async (t, sql, params) => (await t.all(sql, params))[0] || null;

  /** Diğer terminallere "yenile" sinyali: lmv_ccard bayrağı + orijinal programın dinlediği UDP 2459 yayını. */
  async function bump(t, sid = 0) {
    try { await t.run("UPDATE lmv_ccard SET tag=1 WHERE cname='Refresh'"); } catch { /* tablo yoksa önemli değil */ }
    if (cfg.demo || !sid) return;
    try {
      const sock = dgram.createSocket('udp4');
      sock.on('error', () => sock.close());
      sock.bind(() => {
        sock.setBroadcast(true);
        sock.send(String(sid), 2459, '255.255.255.255', () => sock.close());
      });
    } catch { /* yayın yapılamazsa diğer terminaller kendi yoklamasıyla yenilenir */ }
  }
  /** İş günü: [gün StartTime, ertesi gün StartTime) */
  function businessRange(start, end = start) {
    const at = (date, addDays) => {
      const d = new Date(`${date}T00:00:00`);
      d.setDate(d.getDate() + addDays);
      d.setMinutes(cfg.dayStartMinutes);
      return stamp(d);
    };
    return [at(start, 0), at(end, 1)];
  }
  const businessDay = (d = new Date()) => stamp(new Date(d.getTime() - cfg.dayStartMinutes * 60000)).slice(0, 10);

  // ---------- Kullanıcılar ----------
  function userOut(u) {
    const ua = num(u.userauth);
    const full = FULL_USERS.test(u.name || '');
    return { id: u.id, name: u.name, auth: num(u.auth), userauth: ua, manager: full || ua > 1, canPay: full || ua >= 1, canSettings: full || ua >= 1 };
  }
  async function users() {
    const all = (await db.all('SELECT * FROM lmv_users ORDER BY id')).filter((u) => u.name);
    const listed = all.filter((u) => [11, 12, 14].includes(num(u.auth)));
    return (listed.length ? listed : all).map(userOut);
  }
  async function login(id, password) {
    const u = await one(db, 'SELECT * FROM lmv_users WHERE id=?', [id]);
    if (!u || String(u.password ?? '') !== String(password)) return null;
    return userOut(u);
  }

  // ---------- Bölümler ve masalar ----------
  async function fields() {
    return (await db.all('SELECT * FROM lmv_fields ORDER BY id')).filter((f) => f.name && !HIDDEN_FIELD.test(f.name)).map((f) => ({
      id: f.id, name: f.name, special: (SPECIAL.find(([re]) => re.test(f.name)) || [])[1] || null, packet: PACKET_FIELD.test(f.name),
    }));
  }
  async function tables(fid) {
    const now = Date.now();
    const open = new Map();
    for (const s of await db.all('SELECT * FROM lmv_sales WHERE inuse=1 AND fieldid=?', [fid])) {
      if (num(s.tableid) < 1) continue;
      open.set(s.tableid, {
        no: s.tableid, sid: s.sid, total: r2(num(s.totalprice) - num(s.discounted)), paket: String(s.paket ?? '0') !== '0' ? String(s.paket) : '',
        printed: num(s.isprinted) === 1, pax: num(s.pax), user: s.username || '', minutes: Math.max(0, Math.round((now - parseStamp(s.open_date)) / 60000)),
        alert: num(s.alerton) === 1 ? String(s.alerttime || '').slice(11, 16) : '',
      });
    }
    const max = Math.min(500, Math.max(cfg.tableCount, ...open.keys()));
    const rows = [];
    for (let no = 1; no <= max; no++) if (no <= cfg.tableCount || open.has(no)) rows.push(open.get(no) || { no, sid: 0 });
    return rows;
  }

  // ---------- Menü ----------
  async function menu({ all = false } = {}) {
    const cats = (await db.all('SELECT * FROM lmv_menu_cat_top')).filter((c) => c.name && (all || active(c.tag)))
      .sort((a, b) => num(a.psort) - num(b.psort) || a.id - b.id)
      .map((c) => ({ id: c.id, name: c.name, alt: num(c.menualt) || 1, kasiyerOnly: num(c.psort) === 9999, joker: c.id === 999 }));
    const catIds = new Set(cats.map((c) => c.id));
    const products = (await db.all('SELECT * FROM lmv_product')).filter((p) => p.prname && num(p.packqty) === 0 && active(p.inuse) && (all || catIds.has(p.catid)))
      .sort((a, b) => num(b.pdasort) - num(a.pdasort) || String(a.prname).localeCompare(b.prname, 'tr'))
      .map((p) => ({ id: p.prid, name: p.prname, cat: p.catid, price: r2(p.price_s), type: num(p.p_type), prn: p.prn || '', unit: p.hm ? String(p.hm) : '' }));
    return { categories: cats, products };
  }

  // ---------- Adisyon ----------
  const lineOut = (d) => ({
    id: d.detailedsalesid, prid: d.prid, name: d.prname, quantity: num(d.quantity), unit: r2(d.unitprice), total: r2(d.totalprice),
    gift: num(d.pricegroup) === 2 || num(d.pricegroup) === 3, comment: d.comment || '', prn: d.prn || '', kg: String(d.p_type || '').includes('kg'),
    paidQty: num(d.ispay), user: d.username || '', date: d.salesdate || '',
  });
  const payOut = (p) => ({
    id: p.payid, sid: num(p.salesid), amount: r2(p.totalprice), method: num(p.paymethod), label: p.pay_comment || '', type: p.pay_type || '',
    date: p.paydate, user: p.username || '', ref: num(p.paymethoddetails), fieldId: num(p.fieldid), tableId: num(p.tableid), note: p.paytag || '',
  });
  async function loadSale(t, sid) {
    const s = await one(t, 'SELECT * FROM lmv_sales WHERE sid=?', [sid]);
    if (!s) throw new PosError('Satış No. ile ilgili kayıt bulunamadı !', 404);
    const field = await one(t, 'SELECT * FROM lmv_fields WHERE id=?', [s.fieldid]);
    const lines = (await t.all('SELECT * FROM lmv_salesdetails WHERE salesid=? ORDER BY detailedsalesid', [sid])).map(lineOut);
    const payments = (await t.all('SELECT * FROM lmv_payments WHERE salesid=? ORDER BY payid', [sid])).map(payOut);
    const subtotal = r2(lines.reduce((a, l) => a + l.total, 0));
    const discount = r2(s.discounted);
    const paid = r2(s.prepay);
    const fieldName = field ? field.name : '';
    const paket = String(s.paket ?? '0') !== '0' ? String(s.paket) : '';
    return {
      sid: s.sid, fieldId: s.fieldid, tableId: s.tableid, fieldName, packet: PACKET_FIELD.test(fieldName), tableName: `${fieldName}-${s.tableid}`,
      user: s.username || '', openDate: s.open_date, lastOrder: lines.length ? lines[lines.length - 1].date : '', pax: num(s.pax), note: s.tag11 || '',
      paket, customerId: paket ? num(s.paket_id) : 0, discount, discountTag: s.discounttag || '', paid, subtotal,
      due: r2(subtotal - discount - paid), printed: num(s.isprinted) === 1, open: num(s.inuse) === 1,
      alert: num(s.alerton) === 1 ? String(s.alerttime || '').slice(11, 16) : '', multi: lines.some((l) => l.paidQty > 0), lines, payments,
    };
  }
  const sale = (sid) => loadSale(db, sid);
  async function openSale(t, sid) {
    const s = await loadSale(t, sid);
    if (!s.open) throw new PosError('Bu adisyon kapanmış.', 409);
    return s;
  }
  /** Orijinal programdaki totalPriceUpdate. */
  async function recalc(t, sid) {
    const s = await loadSale(t, sid);
    await t.run('UPDATE lmv_sales SET salesdate=?, totalprice=? WHERE sid=?', [stamp(), r2(s.subtotal - s.paid), sid]);
    await bump(t, sid);
    return s;
  }
  async function customerOf(t, id) {
    const c = id ? await one(t, 'SELECT * FROM lmv_customer WHERE cid=?', [id]) : null;
    if (id && (!c || !active(c.inuse))) throw new PosError('Müşteri bulunamadı.');
    return c;
  }

  /**
   * Kaydet: adisyon yoksa açar, kalemleri ekler, toplamı günceller ve mutfak fişlerini gönderir.
   * Fiyat, yazıcı ve ürün tipi istemciden değil ürün kaydından alınır.
   */
  async function saveLines(user, o) {
    const lines = Array.isArray(o.lines) ? o.lines : [];
    if (lines.length < 1 || lines.length > 200) throw new PosError('Adisyona eklenecek ürün yok.');
    const now = stamp();
    const note = clean(o.note);
    const alert = /^\d{2}:\d{2}$/.test(o.alert || '') ? o.alert : '';
    const sid = await db.tx(async (t) => {
      const field = await one(t, 'SELECT * FROM lmv_fields WHERE id=?', [o.fieldId]);
      if (!field) throw new PosError('Bölüm bulunamadı.');
      if (!(Number.isInteger(o.tableId) && o.tableId > 0)) throw new PosError('Satış yapılacak masa seçilmedi !');
      let head = await one(t, 'SELECT * FROM lmv_sales WHERE inuse=1 AND fieldid=? AND tableid=?', [o.fieldId, o.tableId]);
      if (!head) {
        const customer = await customerOf(t, o.customerId);
        const packet = PACKET_FIELD.test(field.name);
        const paket = customer ? customer.cname : packet ? cfg.packId : '0';
        const res = await t.run(
          'INSERT INTO lmv_sales(fieldid,tableid,userid,username,inuse,open_date,paket,paket_id,pax,tag11) VALUES (?,?,?,?,1,?,?,?,?,?)',
          [o.fieldId, o.tableId, user.id, user.name, now, paket, customer ? customer.cid : packet ? 2 : 0, Math.max(1, num(o.pax)), note],
        );
        head = { sid: res.insertId };
      }
      for (const l of lines) {
        let p;
        let unit;
        if (l.joker) {
          // Joker ürün: serbest açıklama ve tutar (catid 999, prid 9999)
          unit = r2(l.joker.price);
          if (!clean(l.joker.name, 60) || !(unit > 0)) throw new PosError('Joker ürün açıklaması veya tutarı geçersiz.');
          p = { prid: 9999, prname: clean(l.joker.name, 60), catid: 999, prn: cfg.jokerPrinter, hm_c: 0, p_type: 0 };
        } else {
          p = await one(t, 'SELECT * FROM lmv_product WHERE prid=?', [l.id]);
          if (!p || !active(p.inuse)) throw new PosError('Ürün bulunamadı veya satışa kapalı.');
          unit = r2(p.price_s);
        }
        const type = num(p.p_type);
        const q = l.quantity;
        if (!(typeof q === 'number' && q > 0 && q <= 999)) throw new PosError('Geçersiz miktar.');
        if (type === 0 && !Number.isInteger(q)) throw new PosError(`${p.prname} yalnızca tam adet satılır.`);
        if ((type === 2 || type === 3) && !Number.isInteger(q * 2)) throw new PosError('Geçersiz porsiyon.');
        const gift = !!l.gift;
        if (gift) unit = 0;
        // Tartılan ürün: tutar tam liraya yuvarlanır (orijinal davranış)
        const total = type === 1 ? Math.round(unit * q) : r2(unit * q);
        await t.run(
          `INSERT INTO lmv_salesdetails(fieldid,tableid,salesid,unitprice,prid,prname,quantity,catid,totalprice,userid,username,
             pricegroup,salesprice,isprinted,prn,notprepare,hm_c,p_type,salesdate,comment)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`,
          [o.fieldId, o.tableId, head.sid, unit, p.prid, p.prname, q, num(p.catid), total, user.id, user.name,
            gift ? 2 : 0, unit, p.prn || '', o.noprep ? 1 : 0, num(p.hm_c), type === 1 ? ' kg.' : '', now, clean(l.comment)],
        );
      }
      await t.run('UPDATE lmv_sales SET isprinted=0, islocked=0, tag11=? WHERE sid=?', [alert ? `Saat :  ${alert} - ${note}` : note, head.sid]);
      if (alert) await t.run('UPDATE lmv_sales SET alerttime=?, alerton=1 WHERE sid=?', [`${now.slice(0, 10)} ${alert}:00`, head.sid]);
      await recalc(t, head.sid);
      return head.sid;
    });
    const printed = await kitchen(sid, o.print !== false, !!o.noprep);
    return { sale: await sale(sid), printed };
  }

  /** Basılmamış kalemleri yazıcıya (prn) göre gruplayıp gönderir ve basıldı olarak işaretler. */
  async function kitchen(sid, print, noprep) {
    const s = await sale(sid);
    const fresh = await db.all('SELECT * FROM lmv_salesdetails WHERE salesid=? AND isprinted=0 ORDER BY detailedsalesid', [sid]);
    const jobs = [];
    if (print) {
      const groups = new Map();
      for (const d of fresh) {
        if (!d.prn) continue;
        if (!groups.has(d.prn)) groups.set(d.prn, []);
        groups.get(d.prn).push({ name: d.prname, quantity: num(d.quantity), comment: d.comment || '' });
      }
      for (const [prn, lines] of groups) {
        jobs.push(await printer.print(prn, 'kitchen', kitchenTicket({
          printer: prn, table: s.paket ? `${s.tableName} / ${s.paket}` : s.tableName, user: s.user, time: stamp(), lines,
          note: [noprep ? 'Sipariş Hazırlanmasın !' : '', s.note].filter(Boolean).join(' — '),
        })));
      }
    }
    if (fresh.length) await db.run('UPDATE lmv_salesdetails SET isprinted=1 WHERE salesid=? AND isprinted=0', [sid]);
    return jobs;
  }

  const DEL_COLS = DETAIL_COLS.join(',');
  async function toDeleted(t, lineId, reason, quantity, total) {
    const res = await t.run(`INSERT INTO lmv_salesdetails_del (${DEL_COLS}) SELECT ${DEL_COLS} FROM lmv_salesdetails WHERE detailedsalesid=?`, [lineId]);
    if (quantity == null) await t.run('UPDATE lmv_salesdetails_del SET comment=? WHERE detailedsalesid=?', [reason, res.insertId]);
    else await t.run('UPDATE lmv_salesdetails_del SET comment=?, isprinted=0, quantity=?, totalprice=? WHERE detailedsalesid=?', [reason, quantity, total, res.insertId]);
  }

  /**
   * Düzenle modu "Kaydet": changes = [{ id, quantity, reason }].
   * Adet azalırsa fark iptal tablosuna (sebebiyle) yazılır; 0 ise kalem tümüyle iptal edilir; artarsa kalem güncellenir.
   */
  async function editSale(user, sid, changes) {
    if (!Array.isArray(changes) || !changes.length) throw new PosError('Değişiklik yok.');
    const cancelled = [];
    await db.tx(async (t) => {
      const s = await openSale(t, sid);
      for (const c of changes) {
        const d = await one(t, 'SELECT * FROM lmv_salesdetails WHERE detailedsalesid=? AND salesid=?', [c.id, sid]);
        if (!d) throw new PosError('Kalem bulunamadı.', 404);
        const cur = num(d.quantity);
        const q = c.quantity;
        if (!(typeof q === 'number' && q >= 0 && q <= 999)) throw new PosError('Geçersiz miktar.');
        if (q === cur) continue;
        const unit = num(d.salesprice);
        if (q < cur) {
          if (num(d.ispay) > q) throw new PosError('Ödemesi alınmış kalem iptal edilemez.');
          const reason = clean(c.reason, 100) || (q === 0 ? '' : 'Satış Düzenleme');
          if (!reason) throw new PosError('Lütfen iptal için açıklama giriniz.');
          if (q === 0) {
            await toDeleted(t, d.detailedsalesid, reason);
            await t.run('DELETE FROM lmv_salesdetails WHERE detailedsalesid=?', [d.detailedsalesid]);
          } else {
            await toDeleted(t, d.detailedsalesid, reason, cur - q, r2(unit * (cur - q)));
            await t.run('UPDATE lmv_salesdetails SET quantity=?, totalprice=? WHERE detailedsalesid=?', [q, r2(unit * q), d.detailedsalesid]);
          }
          if (num(d.isprinted) === 1 && d.prn) cancelled.push({ prn: d.prn, name: d.prname, quantity: cur - q, reason });
        } else {
          await t.run('UPDATE lmv_salesdetails SET quantity=?, totalprice=? WHERE detailedsalesid=?', [q, r2(unit * q), d.detailedsalesid]);
        }
      }
      const after = await recalc(t, sid);
      if (after.due < 0) throw new PosError('Kalan tutar, alınan ön ödemenin altına düşüyor.');
      if (!after.lines.length && after.paid === 0) await t.run('UPDATE lmv_sales SET alerton=0, inuse=0, totalprice=0, discounted=0 WHERE sid=?', [sid]);
      cancelled.table = s.tableName;
    });
    const printed = [];
    for (const c of cancelled) {
      printed.push(await printer.print(c.prn, 'cancel', kitchenTicket({
        printer: c.prn, title: '*** İPTAL ***', table: cancelled.table, user: user.name, time: stamp(), lines: [c], note: c.reason,
      })));
    }
    return { sale: await sale(sid), printed };
  }

  /** İptal: adisyonun tamamı (ön ödeme alınmamışsa). */
  async function voidSale(sid) {
    await db.tx(async (t) => {
      const s = await openSale(t, sid);
      if (s.paid !== 0) throw new PosError('Ön ödeme alınmış adisyon iptal edilemez.');
      for (const l of s.lines) await toDeleted(t, l.id, 'Adisyon İptal');
      await t.run('DELETE FROM lmv_salesdetails WHERE salesid=?', [sid]);
      await t.run('UPDATE lmv_sales SET alerton=0, inuse=0, totalprice=0, discounted=0 WHERE sid=?', [sid]);
      await bump(t, sid);
    });
    return { ok: true };
  }

  /** İndirim: mutlak tutar (birikmez), açıklaması discounttag'e yazılır. 0 → indirim kaldırılır. */
  async function setDiscount(sid, amount, tag) {
    return db.tx(async (t) => {
      const s = await openSale(t, sid);
      const value = r2(amount);
      if (!(value >= 0) || value >= r2(s.subtotal - s.paid)) throw new PosError('İndirim yapılacak tutar yanlış!');
      await t.run('UPDATE lmv_sales SET discounted=?, discounttag=? WHERE sid=?', [value, value ? clean(tag, 100) : '', sid]);
      return recalc(t, sid);
    });
  }
  async function setPax(sid, pax) {
    if (!(Number.isInteger(pax) && pax >= 1 && pax <= 999)) throw new PosError('Geçersiz kişi sayısı.');
    await db.run('UPDATE lmv_sales SET pax=? WHERE sid=? AND inuse=1', [pax, sid]);
    return sale(sid);
  }

  /**
   * Masa Aktarım (Taşı). items yoksa hesabın tamamı taşınır; verilirse yalnızca seçilen adetler.
   * Hedef masa doluysa: tam taşımada merge=true ile hesaplar birleştirilir; kısmi taşımada kalemler hedef adisyona eklenir.
   */
  async function transfer(user, sid, { fieldId, tableId, items, merge }) {
    return db.tx(async (t) => {
      const s = await openSale(t, sid);
      if (s.multi) throw new PosError('Bu adisyon için parçalı ödeme alındı,\nTaşıma işlemi gerçekleştirilemez !');
      const field = await one(t, 'SELECT * FROM lmv_fields WHERE id=?', [fieldId]);
      if (!field || !(Number.isInteger(tableId) && tableId > 0)) throw new PosError('Aktarım yapılacak masa seçilmedi !');
      if (s.fieldId === fieldId && s.tableId === tableId) throw new PosError('Aktarım yapılacak masa ile eski masa aynı !');
      const now = stamp();
      const moves = new Map();
      if (Array.isArray(items) && items.length) {
        for (const it of items) {
          const l = s.lines.find((x) => x.id === it.id);
          if (!l || !(it.quantity > 0) || it.quantity > l.quantity + 0.0001) throw new PosError('Aktarılacak kalemler geçersiz.');
          moves.set(l.id, Math.min(it.quantity, l.quantity));
        }
      }
      const whole = !moves.size || s.lines.every((l) => moves.get(l.id) === l.quantity);
      let target = await one(t, 'SELECT * FROM lmv_sales WHERE inuse=1 AND fieldid=? AND tableid=?', [fieldId, tableId]);
      if (target && whole && !merge) return { needConfirm: true };
      if (target && whole && s.paid !== 0) throw new PosError('Ön ödemesi olan hesap başka hesapla birleştirilemez.');
      const targetName = `${field.name}-${tableId}`;
      if (!target) {
        const src = await one(t, 'SELECT * FROM lmv_sales WHERE sid=?', [sid]);
        const res = await t.run(
          'INSERT INTO lmv_sales(fieldid,tableid,userid,username,inuse,open_date,comments,prepay,paket_id,paket) VALUES (?,?,?,?,1,?,?,?,?,?)',
          [fieldId, tableId, user.id, user.name, now, `${s.tableName} aktarılan hesap`, whole ? num(src.prepay) : 0, num(src.paket_id), String(src.paket ?? '0')],
        );
        target = { sid: res.insertId };
        if (whole) await t.run('UPDATE lmv_sales SET pax=?, tag11=?, discounted=?, discounttag=? WHERE sid=?', [num(src.pax), src.tag11 || '', num(src.discounted), src.discounttag || '', target.sid]);
      }
      if (whole) {
        await t.run('UPDATE lmv_salesdetails SET fieldid=?, tableid=?, salesid=? WHERE salesid=?', [fieldId, tableId, target.sid, sid]);
        await t.run('UPDATE lmv_payments SET fieldid=?, tableid=?, salesid=? WHERE salesid=?', [fieldId, tableId, target.sid, sid]);
        await t.run('UPDATE lmv_sales SET inuse=0, totalprice=0, discounted=0, comments=?, salesdate=? WHERE sid=?',
          [`${merge ? 'hesap birleştirildi' : 'hesap aktarıldı'}: ${targetName}`, now, sid]);
      } else {
        for (const [id, q] of moves) {
          const d = await one(t, 'SELECT * FROM lmv_salesdetails WHERE detailedsalesid=?', [id]);
          const cur = num(d.quantity);
          if (q >= cur) {
            await t.run('UPDATE lmv_salesdetails SET fieldid=?, tableid=?, salesid=? WHERE detailedsalesid=?', [fieldId, tableId, target.sid, id]);
          } else {
            const unit = num(d.salesprice);
            await t.run('UPDATE lmv_salesdetails SET quantity=?, totalprice=? WHERE detailedsalesid=?', [cur - q, r2(unit * (cur - q)), id]);
            await t.run(
              `INSERT INTO lmv_salesdetails(fieldid,tableid,salesid,unitprice,prid,prname,quantity,catid,totalprice,userid,username,pricegroup,salesprice,isprinted,prn,hm_c,p_type,salesdate,comment)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [fieldId, tableId, target.sid, num(d.unitprice), d.prid, d.prname, q, num(d.catid), r2(unit * q), d.userid, d.username, num(d.pricegroup), unit,
                num(d.isprinted), d.prn || '', num(d.hm_c), d.p_type || '', d.salesdate, d.comment || ''],
            );
          }
        }
        await recalc(t, sid);
      }
      return { sale: await recalc(t, target.sid) };
    });
  }

  /** Yazdır: hesap fişi basılır, masa "yazdırıldı" (sarı) olur. */
  async function printBill(sid) {
    const s = await sale(sid);
    const customer = s.customerId > 2 ? await one(db, 'SELECT * FROM lmv_customer WHERE cid=?', [s.customerId]) : null;
    const lines = billTicket({ restaurant: cfg.restaurant, sale: { ...s, customer: customer ? [customer.cname, customer.cphone, customer.caddress].filter(Boolean).join('\n') : '' } });
    const job = await printer.print(s.packet ? cfg.packPrinter : cfg.checkPrinter, 'bill', lines);
    if (s.open) {
      await db.run('UPDATE lmv_sales SET isprinted=1, islocked=1 WHERE sid=? AND isprinted=0', [sid]);
      await bump(db, sid);
    }
    return { sale: await sale(sid), printed: [job], receipt: lines };
  }
  /** Kilit Aç: yazdırıldı işaretini kaldırır (masa yeniden yeşil olur). */
  async function unlock(sid) {
    await db.run('UPDATE lmv_sales SET islocked=0, isprinted=0 WHERE sid=? AND inuse=1', [sid]);
    await bump(db, sid);
    return sale(sid);
  }

  // ---------- Ödeme ----------
  /** Orijinal programın iki bakiye formülünden doğru olanı: cari satışlar − cari tahsilatlar. */
  async function recalcBalance(t, cid) {
    let balance = 0;
    for (const p of await t.all('SELECT * FROM lmv_payments WHERE paymethoddetails=?', [cid])) {
      if (num(p.paymethod) === 3) balance += num(p.totalprice);
      else if (num(p.salesid) === 0 && (num(p.paymethod) === 1 || num(p.paymethod) === 2)) balance -= num(p.totalprice);
    }
    await t.run('UPDATE lmv_customer SET bakiye=? WHERE cid=?', [r2(balance), cid]);
  }
  async function insertPayment(t, user, s, row) {
    const amount = r2(row.amount);
    if (!(amount > 0)) throw new PosError('Ödeme yapılacak tutar yanlış.');
    if (![1, 2, 3].includes(row.method)) throw new PosError('Geçersiz ödeme türü.');
    let customer = null;
    if (row.method === 3) {
      customer = await customerOf(t, row.customerId);
      if (!customer) throw new PosError('Kapalı (cari) ödeme için müşteri seçin.');
    }
    await t.run(
      'INSERT INTO lmv_payments(fieldid,tableid,salesid,totalprice,userid,username,paymethod,paymethoddetails,pay_comment,pay_type,paytag,paydate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [s.fieldId, s.tableId, s.sid, amount, user.id, user.name, row.method, customer ? customer.cid : 0, customer ? customer.cname : METHODS[row.method],
        METHODS[row.method], clean(row.note, 100), stamp()],
    );
    if (customer) await recalcBalance(t, customer.cid);
    return amount;
  }
  /**
   * Ödeme penceresi "Kaydet": bir veya birkaç ödeme satırı (+ isteğe bağlı indirim).
   * Toplam kalan tutarın altındaysa ön ödeme olarak işlenir ve masa açık kalır; değilse adisyon kapanır.
   */
  async function pay(user, sid, { rows, discount }) {
    if (!Array.isArray(rows) || !rows.length) throw new PosError('Ödeme satırı yok.');
    return db.tx(async (t) => {
      let s = await openSale(t, sid);
      if (discount != null) {
        const d = r2(discount);
        if (!(d >= 0) || d > r2(s.subtotal - s.paid)) throw new PosError('İndirim tutarı geçersiz.');
        await t.run('UPDATE lmv_sales SET discounted=? WHERE sid=?', [d, sid]);
        s = await loadSale(t, sid);
      }
      let sum = 0;
      for (const row of rows) sum = r2(sum + await insertPayment(t, user, s, row));
      if (sum > s.due + 0.001) throw new PosError('Ödeme yapılacak tutar adisyon tutarından büyük!');
      const closed = sum >= s.due - 0.001;
      await t.run('UPDATE lmv_sales SET ispayed=?, prepay=prepay+?, inuse=? WHERE sid=?', [closed ? 1 : 0, sum, closed ? 0 : 1, sid]);
      return { closed, sale: await recalc(t, sid) };
    });
  }
  /** Multi Ödeme: seçilen kalem adetleri ödenir (ispay artar); ödenmemiş kalem kalmayınca adisyon kapanır. */
  async function payMulti(user, sid, { method, items }) {
    if (![1, 2].includes(method)) throw new PosError('Geçersiz ödeme türü.');
    if (!Array.isArray(items) || !items.length) throw new PosError('Lütfen ödeme için ürün seçiniz.');
    return db.tx(async (t) => {
      const s = await openSale(t, sid);
      let amount = 0;
      for (const it of items) {
        const l = s.lines.find((x) => x.id === it.id);
        if (!l || !(it.quantity > 0) || it.quantity > l.quantity - l.paidQty + 0.0001) throw new PosError('Ödenecek kalemler geçersiz.');
        await t.run('UPDATE lmv_salesdetails SET ispay=ispay+? WHERE detailedsalesid=?', [it.quantity, l.id]);
        amount = r2(amount + it.quantity * l.unit);
      }
      await insertPayment(t, user, s, { method, amount });
      const after = await loadSale(t, sid);
      const closed = after.lines.every((l) => l.paidQty >= l.quantity - 0.0001);
      await t.run('UPDATE lmv_sales SET ispayed=?, prepay=prepay+?, inuse=? WHERE sid=?', [closed ? 1 : 0, amount, closed ? 0 : 1, sid]);
      return { closed, amount, sale: await recalc(t, sid) };
    });
  }

  /** Tahsilat İptal: satışa ait tüm ödemeler silinir, cari bakiyeler düzeltilir, kalemler iptal tablosuna taşınır (orijinal davranış). */
  async function paymentsOf(number, byPayment) {
    let sid = number;
    if (byPayment) {
      const p = await one(db, 'SELECT * FROM lmv_payments WHERE payid=?', [number]);
      if (!p) throw new PosError('Ödeme No. ile ilgili kayıt bulunamadı !', 404);
      sid = num(p.salesid);
      if (!sid) return { sid: 0, payments: [payOut(p)], lines: [], total: r2(p.totalprice) };
    }
    const s = await sale(sid);
    return { sid, payments: s.payments, lines: s.lines, total: r2(s.payments.reduce((a, p) => a + p.amount, 0)) };
  }
  async function cancelPayments(number, byPayment) {
    const info = await paymentsOf(number, byPayment);
    if (!info.payments.length) throw new PosError('Bu satışa ait tahsilat yok.');
    await db.tx(async (t) => {
      const cids = new Set();
      for (const p of info.payments) {
        if (![1, 2, 3].includes(p.method)) continue;
        await t.run('DELETE FROM lmv_payments WHERE payid=?', [p.id]);
        if (p.ref > 0) cids.add(p.ref);
      }
      for (const cid of cids) await recalcBalance(t, cid);
      for (const l of info.lines) {
        await toDeleted(t, l.id, 'Tahsilat İptal');
        await t.run('DELETE FROM lmv_salesdetails WHERE detailedsalesid=?', [l.id]);
      }
      await bump(t, info.sid);
    });
    return { ok: true };
  }

  // ---------- Kasadan çıkış (paymethod=9) ----------
  async function payoutTypes() {
    try {
      const rows = (await db.all('SELECT * FROM lmv_payoutunit')).map((r) => String(Object.values(r)[1] ?? '')).filter(Boolean);
      if (rows.length) return rows;
    } catch { /* tablo yoksa varsayılan liste */ }
    return cfg.payoutTypes;
  }
  async function payouts(date) {
    const [from, to] = businessRange(date);
    const rows = (await db.all('SELECT * FROM lmv_payments WHERE paydate>=? AND paydate<? AND paymethod=9 ORDER BY payid', [from, to])).map(payOut);
    return { rows, total: r2(rows.reduce((a, p) => a + p.amount, 0)) };
  }
  async function addPayout(user, { type, comment, amount }) {
    const types = await payoutTypes();
    const index = types.indexOf(type);
    const value = r2(amount);
    if (index < 0) throw new PosError('Ödeme tipi seçin.');
    if (!(value > 0)) throw new PosError('Ödeme tutarı geçersiz');
    if (/^personel$/i.test(type) && !clean(comment)) throw new PosError('Ödeme yapılacak personeli seçiniz.');
    await db.run(
      'INSERT INTO lmv_payments(paydate,totalprice,userid,username,paymethod,paymethoddetails,pay_comment,pay_type) VALUES (?,?,?,?,9,?,?,?)',
      [stamp(), value, user.id, user.name, index + 1, clean(comment, 150), type],
    );
    return { ok: true };
  }
  async function removePayout(id) {
    await db.run('DELETE FROM lmv_payments WHERE payid=? AND paymethod=9', [id]);
    return { ok: true };
  }

  // ---------- Cari hesaplar ----------
  const customerOut = (c) => ({ id: c.cid, name: c.cname || '', address: c.caddress || '', phone: c.cphone || '', note: c.ccomment || '', balance: r2(c.bakiye) });
  async function customers({ name = '', phone = '' } = {}) {
    const n = String(name).trim().toLocaleLowerCase('tr');
    const p = String(phone).replace(/\D/g, '');
    return (await db.all('SELECT * FROM lmv_customer')).filter((c) => active(c.inuse)).map(customerOut)
      .filter((c) => (!n || c.name.toLocaleLowerCase('tr').includes(n)) && (!p || c.phone.includes(p)))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr')).slice(0, 500);
  }
  function customerInput(b) {
    const name = clean(b.name, 100);
    if (!name) throw new PosError('Adı Soyadı geçerli değil !');
    return [name, clean(b.address, 250), String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 20), clean(b.note, 250)];
  }
  async function saveCustomer(cid, b) {
    const v = customerInput(b);
    let id = cid;
    if (cid) await db.run('UPDATE lmv_customer SET cname=?, caddress=?, cphone=?, ccomment=? WHERE cid=?', [...v, cid]);
    else id = (await db.run('INSERT INTO lmv_customer(cname,caddress,cphone,ccomment,inuse) VALUES (?,?,?,?,1)', v)).insertId;
    const c = await one(db, 'SELECT * FROM lmv_customer WHERE cid=?', [id]);
    if (!c) throw new PosError('Müşteri bulunamadı.', 404);
    return customerOut(c);
  }
  async function removeCustomer(cid) {
    await db.run('UPDATE lmv_customer SET inuse=0 WHERE cid=?', [cid]);
    return { ok: true };
  }
  /** Cari işlemler / hesap ekstresi. */
  async function statement(cid) {
    const c = await one(db, 'SELECT * FROM lmv_customer WHERE cid=?', [cid]);
    if (!c) throw new PosError('Müşteri bulunamadı.', 404);
    const rows = (await db.all('SELECT * FROM lmv_payments WHERE paymethoddetails=? ORDER BY payid DESC', [cid]))
      .filter((p) => [1, 2, 3].includes(num(p.paymethod)) && (num(p.paymethod) === 3 || num(p.salesid) === 0))
      .map((p) => ({ id: p.payid, sid: num(p.salesid), date: p.paydate, amount: r2(p.totalprice), kind: num(p.paymethod) === 3 ? `Satış ${p.paytag || ''}`.trim() : 'Tahsilat' }));
    const orders = (await db.all('SELECT * FROM lmv_sales WHERE paket_id=? ORDER BY sid DESC', [cid])).slice(0, 50)
      .map((s) => ({ sid: s.sid, date: s.open_date, total: r2(num(s.prepay) + (num(s.inuse) === 1 ? num(s.totalprice) - num(s.discounted) : 0)) }));
    return { customer: customerOut(c), rows, orders };
  }
  /** Cari Tahsilat: adisyonsuz ödeme (salesid=0), bakiyeden düşer. */
  async function collect(user, cid, rows) {
    if (!Array.isArray(rows) || !rows.length) throw new PosError('Tahsilat satırı yok.');
    return db.tx(async (t) => {
      const c = await customerOf(t, cid);
      if (!c) throw new PosError('Lütfen Müşteri seçiniz !');
      for (const row of rows) {
        const value = r2(row.amount);
        if (!(value > 0) || ![1, 2].includes(row.method)) throw new PosError('Tahsilat tutarı veya türü geçersiz.');
        await t.run(
          'INSERT INTO lmv_payments(fieldid,tableid,salesid,totalprice,userid,username,paymethod,paymethoddetails,pay_comment,pay_type,paydate) VALUES (0,0,0,?,?,?,?,?,?,?,?)',
          [value, user.id, user.name, row.method, cid, METHODS[row.method], c.cname, stamp()],
        );
      }
      await recalcBalance(t, cid);
      return customerOut(await one(t, 'SELECT * FROM lmv_customer WHERE cid=?', [cid]));
    });
  }

  // ---------- Çağrı merkezi ----------
  async function calls(date) {
    const rows = await db.all('SELECT * FROM lmv_calls WHERE call_date>=? AND call_date<=? ORDER BY cid DESC', [`${date} 00:00:00`, `${date} 23:59:59`]);
    const byPhone = new Map((await db.all('SELECT * FROM lmv_customer')).filter((c) => active(c.inuse) && c.cphone).map((c) => [String(c.cphone), customerOut(c)]));
    return rows.map((r) => {
      const c = byPhone.get(String(r.callerid));
      return { id: r.cid, time: String(r.call_time || '').slice(0, 5), phone: r.callerid || '', customer: r.customer || (c ? c.name : ''), customerId: c ? c.id : 0 };
    });
  }
  /** Bölümdeki ilk boş masa (paket siparişi / çağrıdan satış için). */
  async function firstFreeTable(fid) {
    const used = new Set((await db.all('SELECT tableid FROM lmv_sales WHERE inuse=1 AND fieldid=?', [fid])).map((r) => r.tableid));
    for (let n = 1; n <= cfg.tableCount; n++) if (!used.has(n)) return n;
    throw new PosError('Bölümde boş masa yok.');
  }

  // ---------- Rezervasyon ----------
  const rezOut = (r) => ({
    id: r.rid, name: r.rname || '', phone: r.rphone || '', date: String(r.rdate || '').slice(0, 10), time: String(r.rtime || '').slice(0, 5),
    pax: num(r.rpax), kids: num(r.rpaxc), table: r.rtable == null ? '' : String(r.rtable), note: r.rcomment || '',
  });
  const reservations = async (date) => (await db.all('SELECT * FROM lmv_rezerv WHERE rdate=?', [date])).map(rezOut).sort((a, b) => a.time.localeCompare(b.time));
  async function saveReservation(id, b) {
    const name = clean(b.name, 100);
    if (!name) throw new PosError('Müşteri alanı geçersiz.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) throw new PosError('Tarih geçersiz.');
    const v = [name, String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 20), b.date, clean(b.time, 5), clean(b.note, 250)];
    let rid = id;
    if (id) await db.run('UPDATE lmv_rezerv SET rname=?, rphone=?, rdate=?, rtime=?, rcomment=? WHERE rid=?', [...v, id]);
    else rid = (await db.run('INSERT INTO lmv_rezerv(rname,rphone,rdate,rtime,rcomment) VALUES (?,?,?,?,?)', v)).insertId;
    // Kişi / çocuk / masa: orijinal program bu alanları gösterir ama kaydetmezdi; burada kaydedilir (kolonlar yoksa atlanır).
    try {
      await db.run('UPDATE lmv_rezerv SET rpax=?, rpaxc=?, rtable=? WHERE rid=?', [Math.max(0, Math.trunc(num(b.pax))), Math.max(0, Math.trunc(num(b.kids))), clean(b.table, 20), rid]);
    } catch { /* eski şema */ }
    return { ok: true };
  }
  const removeReservation = async (id) => { await db.run('DELETE FROM lmv_rezerv WHERE rid=?', [id]); return { ok: true }; };

  // ---------- Raporlar ----------
  const fieldNames = async () => new Map((await db.all('SELECT * FROM lmv_fields')).map((f) => [f.id, f.name]));
  const agg = (rows) => rows.map((r) => ({ ...r, quantity: num(r.quantity), total: r2(r.total), unit: r.unit == null ? undefined : r2(r.unit) }));
  const sumOf = (rows, key = 'total') => r2(rows.reduce((a, r) => a + num(r[key]), 0));

  const reports = {
    /** Kasa Hareketleri: filter 0 hepsi, 1 nakit, 2 kredi kartı, 3 kapalı */
    async kasa(start, end, filter = 0) {
      const [from] = businessRange(start);
      const [, to] = businessRange(end);
      const names = await fieldNames();
      const all = (await db.all('SELECT * FROM lmv_payments WHERE paydate>=? AND paydate<? AND paymethod<4 ORDER BY payid', [from, to])).map(payOut);
      const rows = all.filter((p) => !filter || p.method === filter).map((p) => ({ ...p, table: p.sid ? `${names.get(p.fieldId) || ''}-${p.tableId}` : '' }));
      const by = (m) => sumOf(all.filter((p) => p.method === m), 'amount');
      return { from, to, rows, cash: by(1), card: by(2), closed: by(3), total: filter === 3 ? by(3) : r2(by(1) + by(2)) };
    },
    async sales(start, end) {
      const [from] = businessRange(start);
      const [, to] = businessRange(end);
      const rows = agg(await db.all(
        'SELECT prname AS name, SUM(quantity) AS quantity, unitprice AS unit, SUM(totalprice) AS total FROM lmv_salesdetails WHERE salesdate>=? AND salesdate<? GROUP BY prid, prname, unitprice ORDER BY prname', [from, to]));
      return { from, to, rows, total: sumOf(rows) };
    },
    async tables(start, end) {
      const [from] = businessRange(start);
      const [, to] = businessRange(end);
      const names = await fieldNames();
      const rows = (await db.all('SELECT * FROM lmv_sales WHERE salesdate>=? AND salesdate<? AND ispayed=1 ORDER BY open_date', [from, to]))
        .map((s) => ({ sid: s.sid, date: s.open_date, table: `${names.get(s.fieldid) || ''}-${s.tableid}`, pax: num(s.pax), total: r2(s.prepay), discount: r2(s.discounted), note: s.comments || '' }));
      return { from, to, rows, total: sumOf(rows), discount: sumOf(rows, 'discount'), pax: rows.reduce((a, r) => a + r.pax, 0) };
    },
    async staff(start, end) {
      const [from] = businessRange(start);
      const [, to] = businessRange(end);
      const rows = agg(await db.all(
        'SELECT username AS name, SUM(quantity) AS quantity, SUM(totalprice) AS total FROM lmv_salesdetails WHERE salesdate>=? AND salesdate<? GROUP BY username', [from, to]))
        .sort((a, b) => b.total - a.total);
      return { from, to, rows, total: sumOf(rows) };
    },
    async cancels(start, end) {
      const [from] = businessRange(start);
      const [, to] = businessRange(end);
      const rows = agg(await db.all(
        'SELECT prname AS name, comment AS reason, SUM(quantity) AS quantity, SUM(totalprice) AS total FROM lmv_salesdetails_del WHERE salesdate>=? AND salesdate<? GROUP BY comment, prid, prname ORDER BY prname', [from, to]));
      return { from, to, rows, total: sumOf(rows) };
    },
    /** Gün Sonu özet raporu — bölümler orijinal raporla aynı sırada. counted: kasiyer sayımı { cash, card } */
    async eod(date, counted = {}) {
      const range = businessRange(date);
      const pays = (await db.all('SELECT * FROM lmv_payments WHERE paydate>=? AND paydate<?', range)).map(payOut);
      const names = await fieldNames();
      const custs = new Map((await db.all('SELECT * FROM lmv_customer')).map((c) => [c.cid, c]));
      const group = (rows, keyOf) => {
        const m = new Map();
        for (const p of rows) {
          const k = keyOf(p);
          const g = m.get(k) || { name: k, count: 0, total: 0 };
          g.count++;
          g.total = r2(g.total + p.amount);
          m.set(k, g);
        }
        return [...m.values()];
      };
      const cashCard = pays.filter((p) => p.method === 1 || p.method === 2);
      const collections = [1, 2].map((m) => {
        const rows = cashCard.filter((p) => p.method === m);
        return { name: m === 1 ? 'Nakit Tahsilat' : 'Kredi Kartı Tahsilat', count: rows.length, total: sumOf(rows, 'amount') };
      });
      const payoutRows = pays.filter((p) => p.method === 9);
      const payoutTotal = sumOf(payoutRows, 'amount');
      const notStatic = (p) => p.ref > 0 && custs.has(p.ref) && num(custs.get(p.ref).static) === 0;
      const cName = (p) => custs.get(p.ref).cname;
      return {
        date, from: range[0], to: range[1], restaurant: cfg.restaurant,
        count: [
          { name: 'Nakit', counted: r2(counted.cash), diff: r2(num(counted.cash) - (collections[0].total - payoutTotal)) },
          { name: 'Kredi', counted: r2(counted.card), diff: r2(num(counted.card) - collections[1].total) },
        ],
        collections, collected: sumOf(collections),
        byField: group(cashCard.filter((p) => names.has(p.fieldId)), (p) => names.get(p.fieldId)),
        cariSales: group(pays.filter((p) => p.method === 3 && notStatic(p)), (p) => `${cName(p)} ${p.note}`.trim()),
        cariCollections: group(cashCard.filter((p) => p.sid === 0 && notStatic(p)), cName),
        byCategory: agg(await db.all(
          `SELECT mct.name AS name, SUM(sd.quantity) AS quantity, SUM(sd.totalprice) AS total FROM lmv_salesdetails sd
           INNER JOIN lmv_menu_cat_top mct ON sd.catid=mct.id WHERE sd.salesdate>=? AND sd.salesdate<? GROUP BY sd.catid, mct.name`, range)),
        byProduct: agg(await db.all(
          'SELECT prname AS name, SUM(quantity) AS quantity, MAX(unitprice) AS unit, SUM(totalprice) AS total FROM lmv_salesdetails WHERE salesdate>=? AND salesdate<? GROUP BY prid, prname, catid ORDER BY catid, prname', range)),
        gifts: agg(await db.all(
          `SELECT sd.prname AS name, sd.username AS user, SUM(sd.quantity) AS quantity, SUM(pr.price_s*sd.quantity) AS total FROM lmv_salesdetails sd
           INNER JOIN lmv_product pr ON pr.prid=sd.prid WHERE sd.salesdate>=? AND sd.salesdate<? AND sd.pricegroup=2 GROUP BY sd.username, sd.prid, sd.prname ORDER BY sd.username, sd.prname`, range)),
        cancels: agg(await db.all(
          'SELECT prname AS name, comment AS reason, SUM(quantity) AS quantity, SUM(totalprice) AS total FROM lmv_salesdetails_del WHERE salesdate>=? AND salesdate<? GROUP BY comment, prid, prname ORDER BY prname', range)),
        payoutSummary: group(payoutRows, (p) => p.type || 'Diğer'),
        payoutList: payoutRows.map((p) => ({ type: p.type, comment: p.label, amount: p.amount })).sort((a, b) => a.type.localeCompare(b.type, 'tr')),
        payoutTotal,
      };
    },
  };

  // ---------- Ayarlar (Seçenekler) ----------
  const req = (v, name, max = 100) => {
    const s = clean(v, max);
    if (!s) throw new PosError(`${name} alanı geçersiz!`);
    return s;
  };
  const admin = {
    async products(q = '') {
      const cats = new Map((await db.all('SELECT * FROM lmv_menu_cat_top')).map((c) => [c.id, c.name]));
      const needle = String(q).trim().toLocaleLowerCase('tr');
      return (await db.all('SELECT * FROM lmv_product')).filter((p) => active(p.inuse) && num(p.catid) !== 0 && p.prname && (!needle || p.prname.toLocaleLowerCase('tr').includes(needle)))
        .map((p) => ({ id: p.prid, name: p.prname, cat: p.catid, group: cats.get(p.catid) || '', price: r2(p.price_s), prn: p.prn || '', type: num(p.p_type) }))
        .sort((a, b) => a.group.localeCompare(b.group, 'tr') || a.name.localeCompare(b.name, 'tr'));
    },
    async saveProduct(id, b) {
      const name = req(b.name, 'Ürün Adı');
      const p = r2(b.price);
      if (typeof b.price !== 'number' || !(p >= 0 && p < 1e7)) throw new PosError('Fiyat alanı geçersiz!');
      const cat = await one(db, 'SELECT * FROM lmv_menu_cat_top WHERE id=?', [b.cat]);
      if (!cat) throw new PosError('Ürün Grubu alanı geçersiz!');
      if (![0, 1, 2].includes(b.type)) throw new PosError('Birim alanı geçersiz!');
      const prn = clean(b.prn, 30);
      if (id) await db.run('UPDATE lmv_product SET prname=?, catid=?, price=?, price_s=?, prn=?, p_type=? WHERE prid=?', [name, cat.id, p, p, prn, b.type, id]);
      else await db.run('INSERT INTO lmv_product(prname,catid,price,price_s,price_fd,price_yr,prn,p_type) VALUES (?,?,?,?,?,?,?,?)', [name, cat.id, p, p, p, p, prn, b.type]);
      return { ok: true };
    },
    async removeProduct(id) { await db.run('UPDATE lmv_product SET inuse=0 WHERE prid=?', [id]); return { ok: true }; },
    categories: async () => (await db.all('SELECT * FROM lmv_menu_cat_top')).filter((c) => active(c.tag) && c.id !== 999).map((c) => ({ id: c.id, name: c.name })),
    async saveCategory(id, b) {
      const name = req(b.name, 'Grup adı', 29);
      if (id) await db.run('UPDATE lmv_menu_cat_top SET name=? WHERE id=?', [name, id]);
      else await db.run('INSERT INTO lmv_menu_cat_top(name) VALUES (?)', [name]);
      return { ok: true };
    },
    async removeCategory(id) {
      if ((await db.all('SELECT prid FROM lmv_product WHERE catid=? AND inuse=1', [id])).length) throw new PosError('Bu gruba bağlı ürünler var; önce ürünleri silin veya başka gruba alın.');
      await db.run('UPDATE lmv_menu_cat_top SET tag=0 WHERE id=?', [id]);
      return { ok: true };
    },
    fields: async () => (await db.all('SELECT * FROM lmv_fields ORDER BY id')).map((f) => ({ id: f.id, name: f.name })),
    async saveField(id, b) {
      const name = req(b.name, 'Bölüm adı', 12);
      if (id) await db.run('UPDATE lmv_fields SET name=? WHERE id=?', [name, id]);
      else await db.run('INSERT INTO lmv_fields(name) VALUES (?)', [name]);
      return { ok: true };
    },
    async removeField(id) {
      if (await one(db, 'SELECT sid FROM lmv_sales WHERE inuse=1 AND fieldid=?', [id])) throw new PosError('Açık adisyonu olan bölüm silinemez.');
      await db.run('DELETE FROM lmv_fields WHERE id=?', [id]);
      return { ok: true };
    },
    users: async () => (await db.all('SELECT * FROM lmv_users ORDER BY id')).map((u) => ({ id: u.id, name: u.name, card: u.crid || '', userauth: num(u.userauth) })),
    async saveUser(id, b) {
      const name = req(b.name, 'Kullanıcı Adı', 50);
      const dup = await one(db, 'SELECT id FROM lmv_users WHERE name=?', [name]);
      if (dup && dup.id !== id) throw new PosError('Bu kullanıcı adı kullanılıyor.');
      const card = clean(b.card, 50);
      if (id) {
        await db.run('UPDATE lmv_users SET name=?, crid=? WHERE id=?', [name, card, id]);
        if (b.password) await db.run('UPDATE lmv_users SET password=? WHERE id=?', [String(b.password).slice(0, 50), id]);
      } else {
        await db.run('INSERT INTO lmv_users(name,password,auth,crid) VALUES (?,?,14,?)', [name, req(b.password, 'Şifre', 50), card]);
      }
      return { ok: true };
    },
    async removeUser(id, self) {
      const u = await one(db, 'SELECT * FROM lmv_users WHERE id=?', [id]);
      if (!u) return { ok: true };
      if (id === self || /^(root|iptal|kasiyer|salon)$/i.test(u.name)) throw new PosError('Bu kullanıcı silinemez.');
      await db.run('DELETE FROM lmv_users WHERE id=?', [id]);
      return { ok: true };
    },
    async staff(q = '') {
      const needle = String(q).trim().toLocaleLowerCase('tr');
      return (await db.all('SELECT * FROM lmv_staff')).filter((s) => active(s.tag) && (!needle || String(s.namesurname).toLocaleLowerCase('tr').includes(needle)))
        .map((s) => ({ id: s.id, name: s.namesurname || '', role: s.gorevi || '', wage: r2(s.ucret) }))
        .sort((a, b) => a.role.localeCompare(b.role, 'tr') || a.name.localeCompare(b.name, 'tr'));
    },
    async saveStaff(id, b) {
      const v = [req(b.name, 'Adı Soyadı'), req(b.role, 'Görevi'), r2(b.wage)];
      if (id) await db.run('UPDATE lmv_staff SET namesurname=?, gorevi=?, ucret=? WHERE id=?', [...v, id]);
      else await db.run('INSERT INTO lmv_staff(namesurname,gorevi,ucret) VALUES (?,?,?)', v);
      return { ok: true };
    },
    async removeStaff(id) { await db.run('UPDATE lmv_staff SET tag=0 WHERE id=?', [id]); return { ok: true }; },
  };

  return {
    users, login, fields, tables, menu, sale, saveLines, editSale, voidSale, setDiscount, setPax, transfer, printBill, unlock,
    pay, payMulti, paymentsOf, cancelPayments, payoutTypes, payouts, addPayout, removePayout,
    customers, saveCustomer, removeCustomer, statement, collect, calls, firstFreeTable,
    reservations, saveReservation, removeReservation, reports, businessDay, admin,
  };
}

module.exports = { createStore, PosError };
