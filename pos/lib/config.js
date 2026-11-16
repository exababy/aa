'use strict';
/**
 * NetCHIEF Smart POS ayarları.
 * Öncelik: ortam değişkenleri (POS_*) → config.ini (orijinal programın dosyası, POS_CONFIG_INI ile gösterilir) → varsayılan.
 */
const fs = require('node:fs');

/** Orijinal config.ini Windows-1254 kodludur. */
function readIni(file) {
  const out = {};
  let text;
  try { text = new TextDecoder('windows-1254').decode(fs.readFileSync(file)); } catch { return out; }
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { section = sec[1].toLowerCase(); continue; }
    const kv = /^([^=;#]+)=(.*)$/.exec(line);
    if (kv) out[`${section}.${kv[1].trim().toLowerCase()}`] = kv[2].trim();
  }
  return out;
}

function parseTableSet(spec) {
  const set = new Set();
  for (const part of String(spec || '').split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b) && set.size < 1000; n++) set.add(n);
  }
  return set;
}

function parsePrinters(spec) {
  // POS_PRINTERS='{"KEBAP":"192.168.1.60:9100","BAR":"192.168.1.61"}'
  const map = new Map();
  if (!spec) return map;
  let obj;
  try { obj = JSON.parse(spec); } catch { throw new Error('POS_PRINTERS geçerli bir JSON değil.'); }
  for (const [name, addr] of Object.entries(obj)) {
    const [host, port] = String(addr).split(':');
    if (host) map.set(name.toUpperCase(), { host, port: Number(port) || 9100 });
  }
  return map;
}

function load(env = process.env) {
  const ini = env.POS_CONFIG_INI ? readIni(env.POS_CONFIG_INI) : {};
  const pick = (envKey, iniKey, def) => env[envKey] ?? ini[iniKey] ?? def;
  const demo = env.POS_DEMO === '1';
  const [h, m] = String(pick('POS_START_TIME', 'main.starttime', '06:00')).split(':').map(Number);
  return {
    demo,
    port: Number(env.POS_PORT || 3100),
    restaurant: pick('POS_RESTAURANT', 'main.restaurant_name', demo ? 'KEBAPÇI YALÇIN' : 'NetCHIEF Smart'),
    db: {
      host: pick('POS_DB_HOST', 'connection.server_ip', ''),
      port: Number(pick('POS_DB_PORT', 'connection.port', 3306)),
      database: pick('POS_DB_NAME', 'connection.db', 'netchief'),
      user: pick('POS_DB_USER', 'connection.user', ''),
      password: env.POS_DB_PASSWORD || '',
    },
    dayStartMinutes: (h || 0) * 60 + (m || 0),
    tableCount: Math.min(500, Math.max(1, Number(env.POS_TABLE_COUNT || 72) || 72)),
    packId: pick('POS_PACK_ID', 'main.pack_id', 'PKT'),
    payPrompt: String(pick('POS_PAY_PROMPT', 'main.paypromt', '1')) === '1',
    lockTimeoutMs: Number(env.POS_LOCK_TIMEOUT_MS || 0),
    sessionHours: Number(env.POS_SESSION_HOURS || 16),
    checkPrinter: String(pick('POS_CHECK_PRN', 'main.checkprn', 'BAR')).toUpperCase(),
    packPrinter: String(pick('POS_PACK_PRN', 'main.pack_prn', 'KEBAP')).toUpperCase(),
    jokerPrinter: String(pick('POS_JOKER_PRN', 'main.jokerprn', 'KEBAP')).toUpperCase(),
    eodPrinter: String(pick('POS_EOD_PRN', 'main.eodreceiptprn', 'BAR')).toUpperCase(),
    printers: parsePrinters(env.POS_PRINTERS),
    drawerPrinter: String(env.POS_DRAWER_PRN || pick('POS_CHECK_PRN', 'main.checkprn', 'BAR')).toUpperCase(),
    notes: (env.POS_NOTES || 'PİŞMİŞ BİBER BOL,POS İLE ÖDENECEK,AYNI TABAK,YARIM EKMEK,BİR EKMEK,DOĞRANMIŞ,GELİP ALACAK,ÜCRET ÖDENDİ,Soslu Soğan Koy,Pişmiş Domates Biber,Soğansız Salata,Yarım Ekmek,Yol Dürümü,Ekstra Turşu,Tırnaklı Ekmek,SADE,AZ ACILI,İLAVE !!!,AYIRIN !!!,ACILI,ACISIZ,SOĞANSIZ,Yazarkasa Fişi !!!,GİDECEK !!!')
      .split(',').map((v) => v.trim()).filter(Boolean),
    cancelReasons: ['Hatalı', 'İade', 'Yanlış Satış'],
    payoutTypes: ['Genel Giderler', 'Sarf Malzeme', 'Araç Yakıt', 'Yemek', 'Personel', 'Tepsi İade'],
    staffRoles: ['KOMİ', 'MUTFAK', 'ÜRETİM', 'PAKETÇİ', 'ŞEF', 'ŞUBE MÜDÜRÜ', 'YÖNETİCİ'],
  };
}

module.exports = { load, readIni, parseTableSet };
