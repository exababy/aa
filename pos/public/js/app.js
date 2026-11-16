/* NetCHIEF Smart POS — ana ekran. Yerleşim ve akış orijinal programla aynıdır:
   sol: Masa / Satış sekmeleri · orta: masa ya da ürün ızgarası · sağ: sipariş paneli · alt: adisyon detayları. */
import { el, icon, tl, money, qty, r2, api, run, toast, dialog, confirmBox, numpad, setAuthHooks, trDateTime, span, minutesSince, askNumber } from './core.js';
import * as dlg from './dialogs.js';
import { openPage, openOptions } from './pages.js';

const $app = document.getElementById('app');
const QTYS = [0.5, 1.5, 1, 2, 3, 4];

export const S = {
  boot: null, me: null, cfg: null,
  fields: [], field: null, tables: [], menu: { categories: [], products: [] },
  tab: 'masa', tableNo: 0, sale: null, // seçili masa ve (açıksa) adisyonu
  cat: null, alt: 1, qty: 1, draft: [], selected: -1, note: '', alert: '', gift: false, noPrint: false, noPrep: false, customer: null,
  edit: null, // Düzenle modu: [{ id, name, unit, quantity, orig, reason }]
  page: null,
};
let R = {}; // ekran bölgeleri
let pollTimer;
let idleTimer;

// ---------- Başlangıç ve giriş ----------
async function start() {
  S.boot = await api('/boot');
  setAuthHooks(() => showLogin(), []);
  try { await enter(); } catch { showLogin(); }
}

function showLogin() {
  clearInterval(pollTimer);
  S.me = null;
  let user = null;
  const err = el('div', { class: 'err' });
  const name = el('input', { class: 'inp', readOnly: true, placeholder: 'Listeden seçin' });
  const pass = el('input', { class: 'inp', type: 'password', autocomplete: 'off', inputMode: 'none' });
  const grid = el('div', { class: 'ugrid' });
  const paint = () => grid.replaceChildren(...S.boot.users.map((u) => el('button', {
    class: `ubtn ${u === user ? 'on' : ''}`, onclick: () => { user = u; name.value = u.name; err.textContent = ''; paint(); pass.focus(); },
  }, u.name)));
  const submit = () => run(async () => {
    if (!user) { err.textContent = 'Kullanıcı seçin.'; return; }
    try {
      await api('/login', { userId: user.id, password: pass.value });
      await enter();
    } catch (e) {
      err.textContent = e.message === 'Şifre hatalı.' ? 'Kullanıcı Adı veya Şifre Hatalı !' : e.message;
      pass.value = '';
    }
  });
  const time = el('div', { class: 'time' });
  const date = el('div', { class: 'date' });
  const tick = () => {
    const d = new Date();
    time.textContent = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    date.textContent = d.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
  };
  tick();
  paint();
  $app.replaceChildren(el('div', { class: 'login' },
    S.boot.demo && el('div', { class: 'demo' }, 'DEMO — Kasiyer / Yalçın: 1234 · Ahmet: 1111'),
    el('div', { class: 'login-card' },
      el('div', { class: 'login-info' },
        el('div', { class: 'name' }, S.boot.restaurant),
        el('p', {}, 'Lütfen kullanıcınızı seçip şifrenizi girin'),
        time, date),
      el('div', {}, el('h3', {}, 'Kullanıcı Listesi'), grid),
      el('form', { class: 'login-form', onsubmit: (e) => { e.preventDefault(); submit(); } },
        el('label', { class: 'lbl' }, 'Kullanıcı Adı'), name,
        el('label', { class: 'lbl' }, 'Şifre'), pass,
        numpad(pass, { decimal: false }),
        err,
        el('button', { class: 'big green', type: 'submit' }, icon('check'), 'Giriş'),
        el('button', { class: 'big red', type: 'button', onclick: () => window.close() }, icon('x'), 'Kapat')))));
}

async function enter() {
  const me = await api('/me');
  S.me = me.user;
  S.cfg = me;
  setAuthHooks(() => showLogin(), me.managers);
  [S.fields, S.menu] = await Promise.all([api('/fields'), api('/menu')]);
  Object.assign(S, { tab: 'masa', tableNo: 0, sale: null, draft: [], edit: null, page: null, customer: null });
  S.field = S.fields.find((f) => !f.special) || S.fields[0];
  buildMain();
  await loadTables();
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 4000);
  armIdle();
}

/** Diğer terminallerdeki değişiklikler: masa ekranı açıkken düzenli yenilenir. */
function poll() {
  if (!S.me || S.tab !== 'masa' || S.page || S.edit || document.querySelector('dialog[open]')) return;
  loadTables(true).catch(() => {});
}
/** lock_timeout: hareketsizlikte giriş ekranına dönülür. */
function armIdle() {
  clearTimeout(idleTimer);
  if (S.cfg && S.cfg.lockTimeoutMs > 0 && S.me) idleTimer = setTimeout(() => { if (!S.draft.length && !S.edit) logout(); else armIdle(); }, S.cfg.lockTimeoutMs);
}
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, armIdle, { passive: true });
const logout = () => run(async () => { await api('/logout', {}); showLogin(); });

// ---------- Ana ekran iskeleti ----------
function buildMain() {
  R = {
    left: el('aside', { class: 'left' }), center: el('section', { class: 'center' }), edit: el('section', { class: 'edit' }),
    bottom: el('section', { class: 'bottom' }), page: el('section', { class: 'page', hidden: true }),
  };
  $app.replaceChildren(el('div', { class: 'main' }, R.left, R.center, R.edit, R.bottom, R.page));
  render();
}
export function render() {
  renderLeft();
  renderCenter();
  renderEdit();
  renderBottom();
  R.page.hidden = !S.page;
}

// ---------- Sol sütun ----------
let clockEl;
setInterval(() => { if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); }, 5000);

function renderLeft() {
  const masa = S.tab === 'masa';
  const tabs = el('div', { class: 'ltabs' },
    el('button', { class: `ltab ${masa ? 'on' : ''}`, onclick: () => setTab('masa') }, 'Masa'),
    el('button', { class: `ltab ${masa ? '' : 'on'}`, onclick: () => setTab('satis') }, 'Satış'));
  let body;
  if (masa) {
    const find = el('input', { class: 'inp', inputMode: 'numeric', placeholder: 'Satış No.', onkeydown: (e) => { if (e.key === 'Enter') findSale(); } });
    const findSale = () => run(async () => {
      const n = Number(find.value);
      if (!Number.isInteger(n) || n < 1) return;
      await dlg.salesDetails(await api(`/sales/${n}`));
      find.value = '';
    });
    clockEl = el('div', { class: 'clock' }, new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }));
    body = el('div', { class: 'lbody' },
      el('div', { class: 'secs' }, S.fields.map((f) => el('button', {
        class: `secbtn ${f === S.field ? 'on' : ''}`, onclick: () => selectField(f),
      }, f.name))),
      el('div', { class: 'lfill' }),
      el('div', { class: 'find' }, find, el('button', { onclick: findSale }, 'BUL')),
      clockEl,
      el('div', { class: 'brand' }, el('b', {}, S.cfg.restaurant), el('span', {}, 'NetCHIEF Smart')),
      el('div', { class: 'userchip' }, S.me.name));
  } else {
    const alts = new Set(S.menu.categories.map((c) => c.alt));
    const cats = S.menu.categories.filter((c) => c.alt === S.alt && (!c.kasiyerOnly || S.me.manager));
    body = el('div', { class: 'lbody' },
      alts.size > 1 && el('button', { class: 'shift', onclick: () => { S.alt = S.alt === 1 ? 2 : 1; S.cat = null; render(); } }, S.alt === 1 ? 'Gündüz' : 'Gece'),
      el('div', { class: 'cats' }, cats.map((c) => el('button', { class: `catbtn ${c === S.cat ? 'on' : ''}`, onclick: () => selectCat(c) }, c.name))));
  }
  R.left.replaceChildren(tabs, body,
    el('button', { class: 'optbtn', onclick: () => { if (!busy()) openOptions(); } }, icon('gear', 'sm'), 'Seçenekler'));
}

const busy = () => S.draft.length > 0 || !!S.edit;
const current = () => S.tables.find((t) => t.no === S.tableNo) || null;

async function selectField(f) {
  if (S.edit) return;
  S.field = f;
  S.page = null;
  if (f.special) {
    S.tableNo = 0;
    S.sale = null;
    S.page = f.special;
    render();
    openPage(R.page, f.special, { closePage, startPacketSale });
    return;
  }
  S.tableNo = 0;
  S.sale = null;
  S.customer = null;
  S.tables = [];
  render();
  await run(() => loadTables());
}
function closePage() {
  selectField(S.fields.find((f) => !f.special));
}

async function loadTables(silent) {
  if (!S.field || S.field.special) return;
  const fid = S.field.id;
  const rows = await api(`/tables?field=${fid}`);
  if (S.field.id !== fid) return;
  const before = JSON.stringify(S.tables);
  S.tables = rows;
  const t = current();
  const sid = t ? t.sid : 0;
  if (sid && (!S.sale || S.sale.sid !== sid || !silent || before !== JSON.stringify(rows))) S.sale = await api(`/sales/${sid}`);
  if (!sid) S.sale = null;
  if (silent && before === JSON.stringify(rows)) return;
  if (S.tab === 'masa') { renderCenter(); renderBottom(); renderEdit(); }
}

// ---------- Orta alan: masalar / ürünler ----------
function renderCenter() {
  if (S.edit) {
    R.center.replaceChildren(el('div', { class: 'notice' }, icon('edit', 'lg'), el('p', {}, 'yeni ürün eklemek için lütfen satış bölümünü kullanın.')));
    return;
  }
  if (S.tab === 'masa') {
    R.center.replaceChildren(el('div', { class: `tgrid ${S.tables.length <= 72 ? 'rows8' : ''}` }, S.tables.map((t) => {
      const cls = ['tbl', t.sid && 'open', t.printed && 'printed', t.no === S.tableNo && 'sel', t.paket && 'pkt'].filter(Boolean).join(' ');
      return el('button', { class: cls, onclick: () => clickTable(t), ondblclick: () => enterSale(t) },
        t.paket || t.no,
        t.sid ? el('small', {}, money(t.total)) : null,
        t.sid && !t.paket ? el('i', {}, span(t.minutes)) : null);
    })));
    return;
  }
  if (!S.tableNo) {
    R.center.replaceChildren(el('div', { class: 'notice' }, icon('bell', 'lg'), el('p', {}, 'Satış yapılacak masa seçilmedi !'),
      el('button', { class: 'btn navy', onclick: () => setTab('masa') }, 'Masa Seç')));
    return;
  }
  const items = S.cat ? S.menu.products.filter((p) => p.cat === S.cat.id) : [];
  R.center.replaceChildren(el('div', { class: `pgrid ${items.length <= 50 ? 'fit' : ''}` }, items.map((p) => el('button', {
    class: 'prod', onclick: (e) => addProduct(p, e.currentTarget),
  }, el('small', {}, money(p.price)), p.name))));
}

function clickTable(t) {
  if (t.no === S.tableNo) return void enterSale(t); // seçili masaya yeniden dokunmak = çift tıklama
  S.tableNo = t.no;
  S.sale = null;
  S.customer = null;
  S.note = '';
  S.alert = '';
  renderCenter();
  renderBottom();
  renderEdit();
  if (t.sid) run(async () => { const s = await api(`/sales/${t.sid}`); if (S.tableNo === t.no) { S.sale = s; renderBottom(); renderEdit(); } });
}
function enterSale(t) {
  S.tableNo = t.no;
  setTab('satis');
}
/** Çağrı merkezinden / paket müşterisiyle satış başlatır. */
async function startPacketSale(customer) {
  const field = S.fields.find((f) => f.packet);
  if (!field) throw new Error('"Paket Servis" bölümü tanımlı değil.');
  const { no } = await api(`/free-table?field=${field.id}`);
  S.field = field;
  S.page = null;
  S.tables = await api(`/tables?field=${field.id}`);
  S.tableNo = no;
  S.sale = null;
  S.customer = customer;
  setTab('satis');
}

function setTab(tab) {
  if (S.edit) return;
  if (tab === 'masa' && S.draft.length) return void toast('Önce siparişi kaydedin veya vazgeçin.', 'err');
  if (S.page) { S.page = null; S.field = S.fields.find((f) => !f.special); loadTables().catch(() => {}); }
  S.tab = tab;
  if (tab === 'satis' && !S.cat) S.cat = S.menu.categories.find((c) => c.alt === S.alt && !c.joker) || null;
  render();
  if (tab === 'masa') loadTables(true).catch(() => {});
}

function selectCat(c) {
  if (!S.tableNo) return;
  if (c.id === 999) return void run(async () => {
    const j = await dlg.joker();
    if (j) { S.draft.push({ joker: { name: j.name, price: j.price }, name: j.name, unit: j.price, quantity: j.quantity, type: 0, gift: false }); S.selected = S.draft.length - 1; renderEdit(); }
  });
  S.cat = c;
  renderLeft();
  renderCenter();
}

// ---------- Sipariş paneli ----------
async function addProduct(p, btn) {
  let q = S.qty;
  if (p.type === 0 && !Number.isInteger(q)) q = 1; // adetlik üründe 0,5 / 1,5 geçersiz
  if (p.type === 1) {
    q = await askNumber({ title: 'NetCHIEF Smart - Satış', label: `${p.name} — miktar (kg)`, hint: `Kg fiyatı: ${tl(p.price)}` });
    if (!(q > 0)) return;
  }
  const whole = Number.isInteger(q);
  const same = S.draft.find((l) => l.id === p.id && l.gift === S.gift && !l.comment && p.type !== 2 && p.type !== 1 && whole && Number.isInteger(l.quantity));
  if (same) same.quantity += q;
  else S.draft.push({ id: p.id, name: p.name, unit: p.price, quantity: q, type: p.type, gift: S.gift, comment: '' });
  S.selected = same ? S.draft.indexOf(same) : S.draft.length - 1;
  S.qty = 1;
  if (btn) { btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 140); }
  renderEdit();
}
const lineTotal = (l) => (l.gift ? 0 : l.type === 1 ? Math.round(l.unit * l.quantity) : r2(l.unit * l.quantity));
const step = (l) => (l.type === 2 || l.type === 3 || !Number.isInteger(l.quantity) ? 0.5 : 1);

function renderEdit() {
  const editing = !!S.edit;
  const rows = editing ? S.edit : S.draft;
  const sel = rows[S.selected];
  const total = editing ? r2(S.edit.reduce((a, l) => a + l.unit * l.quantity, 0)) : r2(S.draft.reduce((a, l) => a + lineTotal(l), 0));
  const canSave = editing ? S.edit.some((l) => l.quantity !== l.orig) : S.draft.length > 0;

  const change = (dir) => {
    if (!sel) return;
    if (editing) {
      const st = Number.isInteger(sel.orig) ? 1 : 0.5;
      sel.quantity = Math.max(0, r2(sel.quantity + dir * st));
      if (sel.quantity >= sel.orig) sel.reason = '';
    } else {
      if (sel.type === 1) return;
      const next = r2(sel.quantity + dir * step(sel));
      if (next <= 0) return;
      sel.quantity = next;
    }
    renderEdit();
  };
  const remove = () => run(async () => {
    if (!sel) return;
    if (editing) {
      const reason = await dlg.cancelReason(S.cfg.cancelReasons);
      if (!reason) return;
      sel.quantity = 0;
      sel.reason = reason;
    } else {
      S.draft.splice(S.selected, 1);
      S.selected = Math.min(S.selected, S.draft.length - 1);
    }
    renderEdit();
  });
  const note = () => run(async () => {
    // Satır seçiliyse o kalemin notu, değilse adisyon notu (orijinaldeki Açıklama penceresi)
    const target = !editing && sel ? sel : null;
    const v = await dlg.aciklama(S.cfg.notes, target ? target.comment : S.note);
    if (v === undefined) return;
    if (target) target.comment = v; else S.note = v;
    renderEdit();
  });

  const list = el('div', { class: 'elist' }, rows.length ? rows.map((l, i) => el('div', {
    class: `row ${i === S.selected ? 'sel' : ''} ${l.gift ? 'gift' : ''} ${editing && l.quantity === 0 ? 'paid' : ''}`,
    onclick: () => { S.selected = i === S.selected ? -1 : i; renderEdit(); },
  },
  el('b', {}, qty(l.quantity)), el('span', {}, l.name), el('em', {}, l.gift ? 'Bedelsiz' : money(editing ? l.unit * l.quantity : lineTotal(l))),
  (l.comment || l.reason) && el('small', {}, l.comment || `İptal: ${l.reason}`)))
    : el('div', { class: 'empty' }, editing ? '' : S.tab === 'satis' && S.tableNo ? 'Ürün seçerek siparişe ekleyin' : ''));

  const t = current();
  const showCustomer = !editing && S.tableNo && S.field && S.field.packet && !(t && t.sid);
  R.edit.replaceChildren(
    el('div', { class: 'qtybar' }, QTYS.map((q) => el('button', { class: `q ${S.qty === q ? 'on' : ''}`, disabled: editing, onclick: () => { S.qty = q; renderEdit(); } }, qty(q)))),
    el('div', { class: 'ehead' },
      el('div', { class: 'who' }, S.me.name),
      el('button', { class: 'alarm', onclick: () => run(async () => dlg.alarms(S.tables)) }, 'ALARM'),
      el('label', { class: 'chk' }, el('input', {
        type: 'checkbox', checked: sel && !editing ? sel.gift : S.gift, disabled: editing,
        onchange: (e) => { if (sel) sel.gift = e.target.checked; else S.gift = e.target.checked; renderEdit(); },
      }), 'Bedelsiz')),
    el('div', { class: 'side' },
      el('button', { class: 'sb x', title: 'Kapat', onclick: () => run(async () => { if (await confirmBox('NetCHIEF Smart kapanıyor, emin misiniz ?')) { await api('/logout', {}); window.close(); showLogin(); } }) }, icon('x')),
      el('button', { class: 'sb dash', title: 'Tam ekran', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {})) }, icon('minus')),
      el('button', { class: 'sb gray', title: 'Kullanıcı değiştir', onclick: () => { if (!busy()) logout(); } }, icon('users')),
      el('button', { class: 'sb gray', title: 'Ekranı kilitle', onclick: () => { if (!busy()) logout(); } }, icon('lock')),
      el('button', { class: 'sb saat', onclick: () => run(async () => { const v = await dlg.saat(S.alert); if (v !== undefined) { S.alert = v; renderEdit(); } }) }, S.alert || 'SAAT'),
      el('button', { class: 'sb arrow', onclick: () => change(1) }, icon('up')),
      el('button', { class: 'sb arrow', onclick: () => change(-1) }, icon('down')),
      el('button', { class: 'sb sil', onclick: remove }, 'SİL')),
    list,
    el('div', { class: 'etotal' },
      el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: S.noPrint, disabled: editing, onchange: (e) => { S.noPrint = e.target.checked; } }), 'Yazdırma !'),
      el('b', {}, tl(total))),
    showCustomer
      ? el('button', { class: 'cust', onclick: () => run(async () => { const c = await dlg.pickCustomer({ packet: true }); if (c !== undefined) { S.customer = c; renderEdit(); if (c) setTab('satis'); } }) },
        S.customer ? S.customer.name : 'M ü ş t e r i   S e ç')
      : el('div', { class: 'cesni' },
        el('p', {}, S.customer ? `${S.customer.name}${S.note ? ' — ' : ''}${S.note}` : S.note || (S.sale && !S.draft.length ? S.sale.note : '')),
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: S.noPrep, disabled: editing, onchange: (e) => { S.noPrep = e.target.checked; } }), 'Sipariş Hazırlanmasın')),
    el('div', { class: 'efoot' },
      el('button', { class: 'big red', disabled: !editing && S.tab !== 'satis', onclick: cancelEdit }, icon('x'), 'Vazgeç'),
      el('button', { class: 'big green', disabled: !canSave, onclick: save }, icon('check'), 'Kaydet'),
      el('button', { class: 'big light', title: 'Açıklama', disabled: editing, onclick: note }, icon('note', 'lg'))));
}

function resetOrder() {
  Object.assign(S, { draft: [], selected: -1, note: '', alert: '', gift: false, noPrint: false, noPrep: false, qty: 1, edit: null, customer: null });
}
function cancelEdit() {
  resetOrder();
  S.tab = 'masa';
  render();
  loadTables().catch(() => {});
}

async function save() {
  await run(async () => {
    let out;
    if (S.edit) {
      const changes = S.edit.filter((l) => l.quantity !== l.orig).map((l) => ({ id: l.id, quantity: l.quantity, reason: l.reason || '' }));
      out = await api(`/sales/${S.sale.sid}/edit`, { changes });
    } else {
      out = await api('/sales', {
        fieldId: S.field.id, tableId: S.tableNo, customerId: S.customer ? S.customer.id : 0, note: S.note, alert: S.alert, noprep: S.noPrep, print: !S.noPrint,
        lines: S.draft.map((l) => ({ id: l.id, joker: l.joker, quantity: l.quantity, comment: l.comment, gift: l.gift })),
      });
    }
    reportPrint(out.printed, 'Kaydedildi');
    resetOrder();
    S.tab = 'masa';
    S.sale = out.sale.open ? out.sale : null;
    render();
    await loadTables();
  });
}
/** Yazıcı sonucu: gönderildiyse bilgi, hata varsa uyarı. */
export function reportPrint(jobs, okText) {
  const failed = (jobs || []).filter((j) => j.error);
  if (failed.length) toast(`${okText} — yazıcı hatası: ${failed.map((j) => j.printer).join(', ')}`, 'err');
  else toast(okText, 'ok');
}

// ---------- Adisyon detayları (alt panel) ----------
function renderBottom() {
  const s = S.sale;
  const t = current();
  const on = !!s && !S.edit && S.tab === 'masa';
  const title = S.tableNo && S.field && !S.field.special ? `Adisyon Detayları / ${S.field.name} (${S.tableNo})${s ? ` · #${s.sid}` : ''}` : 'Adisyon Detayları';
  const act = (fn) => () => run(async () => { await fn(); });
  const after = async (out) => {
    if (out === undefined) return;
    await loadTables();
  };
  const copy = () => {
    const text = s.lines.map((l) => `${qty(l.quantity)} x ${money(l.unit)}\t${l.name}\t\t${money(l.total)}`).join('\n');
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Kopyalandı', 'ok'), () => toast('Kopyalanamadı', 'err'));
  };
  const payMenu = act(async () => {
    const choice = await dlg.payMenu();
    if (!choice) return;
    if (choice === 'cash' || choice === 'card') {
      const label = choice === 'cash' ? 'Nakit' : 'Kredi Kartı';
      if (S.cfg.payPrompt && !(await confirmBox(`${s.tableName} için ${money(s.due)} TL ${label} Tahsilat yapılıyor, emin misiniz ?`))) return;
      await api(`/sales/${s.sid}/pay`, { rows: [{ method: choice === 'cash' ? 1 : 2, amount: s.due }] });
      toast(`Ödeme Alındı: ${label} - ${money(s.due)}`, 'ok');
      S.tableNo = 0;
      await loadTables();
    } else if (choice === 'multi') {
      await dlg.payMulti(s);
      await loadTables();
    } else {
      if (s.multi) return void toast('Bu adisyon için Multi Ödeme yapılmış,\nParçalı ödeme yapılamaz !', 'err');
      const out = await dlg.payment(s);
      if (out && out.closed) S.tableNo = 0;
      await loadTables();
    }
  });
  const print = act(async () => {
    const out = await api(`/sales/${s.sid}/print`, {});
    if (out.printed.some((j) => j.sent)) toast('Adisyon yazdırıldı', 'ok');
    else await dlg.receipt(out.receipt, out.printed[0]);
    await loadTables();
  });
  const editMode = act(async () => {
    S.edit = s.lines.map((l) => ({ id: l.id, name: l.name, unit: l.unit, quantity: l.quantity, orig: l.quantity, gift: l.gift, reason: '' }));
    S.selected = -1;
    render();
  });
  const cancelAll = act(async () => {
    if (!(await confirmBox('Seçilen adisyon iptal ediliyor, emin misiniz ?', { danger: true }))) return;
    await api(`/sales/${s.sid}/void`, {});
    toast('Adisyon iptal edildi', 'ok');
    S.tableNo = 0;
    await loadTables();
  });

  R.bottom.replaceChildren(
    el('div', { class: 'bhead' }, el('div', { class: 'btab' }, title), s && s.lines.length ? el('button', { class: 'copy', onclick: copy }, 'Kopyala') : null),
    el('div', { class: 'bbody' },
      el('div', { class: 'alist' },
        s ? s.lines.map((l) => el('div', { class: `row ${l.gift ? 'gift' : ''} ${l.paidQty >= l.quantity ? 'paid' : ''}` },
          el('b', {}, qty(l.quantity)), el('span', {}, l.name), el('i', {}, money(l.unit)), el('em', {}, l.gift ? 'Bedelsiz' : money(l.total)),
          el('small', {}, [l.user, l.comment].filter(Boolean).join(' · '))))
          : el('div', { class: 'empty' }, S.tableNo ? (t && t.sid ? '' : 'Masa boş — sipariş için masaya yeniden dokunun ya da "Satış" sekmesine geçin') : 'Masa seçin')),
      el('div', { class: 'abtns' },
        el('button', { class: 'ab pay', disabled: !on || !S.me.canPay, onclick: payMenu }, 'Ödeme'),
        el('button', { class: 'ab print', disabled: !on, onclick: print }, 'Yazdır'),
        el('button', { class: 'ab peri', disabled: !on, onclick: editMode }, 'Düzenle'),
        el('button', { class: 'ab peri', disabled: !on, onclick: act(async () => after(await dlg.transfer(s, S.fields))) }, 'Taşı'),
        el('button', { class: 'ab peri', disabled: !on, onclick: act(async () => after(await dlg.discount(s))) }, 'İndirim'),
        s && s.printed
          ? el('button', { class: 'ab', disabled: !on, onclick: act(async () => { await api(`/sales/${s.sid}/unlock`, {}); await loadTables(); }) }, 'Kilit Aç')
          : el('button', { class: 'ab cancel', disabled: !on, onclick: cancelAll }, 'İptal')),
      el('div', { class: 'infowrap' },
        el('div', { class: 'ainfo' },
          el('div', { class: 'h' }, 'Masa Açılış'), el('div', { class: 'h' }, 'Süre'),
          el('div', { class: 'v' }, s ? trDateTime(s.openDate) : '00.00.0000 - 00:00'), el('div', { class: 'v' }, s ? span(minutesSince(s.openDate)) : '00:00'),
          el('div', { class: 'h' }, 'Son Sipariş'), el('div', { class: 'h' }, 'Süre'),
          el('div', { class: 'v' }, s && s.lastOrder ? trDateTime(s.lastOrder) : '00.00.0000 - 00:00'), el('div', { class: 'v' }, s && s.lastOrder ? span(minutesSince(s.lastOrder)) : '00:00')),
        el('div', { class: 'ainfo two' },
          el('div', { class: 'h dark' }, 'Toplam'), el('div', { class: 'h' }, 'Ön Ödeme'),
          el('div', { class: 'v r dark' }, s ? tl(s.due) : '0,00 TL'), el('div', { class: 'v r' }, s ? tl(s.paid) : '0,00 TL'))),
      el('div', { class: 'apax' },
        el('div', { class: 'n' }, icon('users'), s ? s.pax : 0),
        el('button', { disabled: !on, onclick: act(async () => { S.sale = await api(`/sales/${s.sid}/pax`, { pax: s.pax + 1 }); renderBottom(); }) }, icon('plus')),
        el('button', { disabled: !on || (s && s.pax <= 1), onclick: act(async () => { S.sale = await api(`/sales/${s.sid}/pax`, { pax: s.pax - 1 }); renderBottom(); }) }, icon('minus')))));
}

document.addEventListener('keydown', (e) => { if (e.key === 'F5' && S.me) { e.preventDefault(); loadTables().catch(() => {}); } });
start().catch((e) => { $app.textContent = e.message; });
