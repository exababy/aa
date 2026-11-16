'use strict';
/**
 * Fiş üretimi ve yazıcıya gönderim.
 * Yazıcı adı (KEBAP, BAR, MUTFAK...) POS_PRINTERS içinde bir ağ adresine eşlenmişse fiş ESC/POS olarak
 * TCP 9100'e gönderilir; eşlenmemişse yalnızca kayda alınır (demo / önizleme).
 */
const net = require('node:net');

const WIDTH = 42;
const money = (n) => Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n) => Number(n || 0).toLocaleString('tr-TR', { maximumFractionDigits: 3 });
const center = (s) => ' '.repeat(Math.max(0, Math.floor((WIDTH - s.length) / 2))) + s;
const cols = (left, right) => {
  const room = WIDTH - right.length - 1;
  const l = left.length > room ? left.slice(0, room) : left;
  return l + ' '.repeat(WIDTH - l.length - right.length) + right;
};
const rule = '-'.repeat(WIDTH);
const clock = (stamp) => String(stamp || '').slice(11, 16);
const trDate = (stamp) => `${String(stamp).slice(8, 10)}.${String(stamp).slice(5, 7)}.${String(stamp).slice(0, 4)} ${clock(stamp)}`;

/** Mutfak / hazırlık fişi: bir yazıcıya düşen kalemler. */
function kitchenTicket({ printer, title, table, user, time, lines, note }) {
  const out = [center(title || 'SİPARİŞ'), center(printer), rule, cols(`MASA: ${table}`, clock(time)), `PERSONEL: ${user}`, rule];
  for (const l of lines) {
    out.push(`${qty(l.quantity)} x ${l.name}`);
    if (l.comment) out.push(`    * ${l.comment}`);
  }
  if (note) out.push(rule, `NOT: ${note}`);
  out.push(rule);
  return out;
}

/** Adisyon / hesap fişi. */
function billTicket({ restaurant, sale }) {
  const out = [center(restaurant), '', cols(`Masa: ${sale.tableName}`, `#${sale.sid}`), cols(`Personel: ${sale.user}`, trDate(sale.openDate)), rule];
  for (const l of sale.lines) {
    out.push(cols(`${qty(l.quantity)} x ${l.name}`, l.gift ? 'İKRAM' : money(l.total)));
  }
  out.push(rule, cols('Ara Toplam', money(sale.subtotal)));
  if (sale.discount > 0) out.push(cols(`İndirim ${sale.discountTag || ''}`.trim(), `-${money(sale.discount)}`));
  if (sale.paid > 0) out.push(cols('Ödenen', `-${money(sale.paid)}`));
  out.push(cols('TOPLAM', `${money(sale.due)} TL`), '', center('Afiyet olsun...'));
  if (sale.customer) out.push(rule, sale.customer);
  return out;
}

// ESC/POS: Türkçe karakterler için PC857 kod sayfası
const CP857 = { ç: 0x87, Ç: 0x80, ğ: 0xa7, Ğ: 0xa6, ı: 0x8d, İ: 0x98, ö: 0x94, Ö: 0x99, ş: 0x9f, Ş: 0x9e, ü: 0x81, Ü: 0x9a, '₺': 0x54, '·': 0x2d };
function encode(text) {
  const bytes = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    bytes.push(CP857[ch] ?? (code < 128 ? code : 0x3f));
  }
  return Buffer.from(bytes);
}
function escpos(lines, { cut = true } = {}) {
  return Buffer.concat([
    Buffer.from([0x1b, 0x40, 0x1b, 0x74, 13]), // sıfırla + kod sayfası PC857
    encode(lines.join('\n') + '\n\n\n\n'),
    cut ? Buffer.from([0x1d, 0x56, 66, 0]) : Buffer.alloc(0),
  ]);
}
const DRAWER_KICK = Buffer.from([0x1b, 0x70, 0, 25, 250]);

function sendTcp({ host, port }, data, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port, timeout });
    sock.on('connect', () => sock.end(data));
    sock.on('close', (hadError) => (hadError ? null : resolve()));
    sock.on('timeout', () => sock.destroy(new Error('Yazıcı yanıt vermiyor')));
    sock.on('error', reject);
  });
}

function createPrinter(cfg) {
  const log = []; // son fişler (önizleme / hata ayıklama)
  async function deliver(printer, kind, lines, data) {
    const name = String(printer || '').toUpperCase();
    const target = cfg.printers.get(name);
    const job = { printer: name, kind, lines, sent: false, error: null, at: Date.now() };
    if (target) {
      try { await sendTcp(target, data); job.sent = true; } catch (e) { job.error = e.message; }
    }
    log.unshift(job);
    log.length = Math.min(log.length, 40);
    return { printer: name, kind, count: lines.length, sent: job.sent, error: job.error, configured: !!target };
  }
  return {
    log,
    print: (printer, kind, lines) => deliver(printer, kind, lines, escpos(lines)),
    drawer: () => deliver(cfg.drawerPrinter, 'drawer', [], DRAWER_KICK),
  };
}

module.exports = { createPrinter, kitchenTicket, billTicket, escpos, encode };
