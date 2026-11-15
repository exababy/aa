'use strict';
/* SAS Smart PWA — tek sayfa mobil arayüz (bağımlılık yok). */

// ---------- Yardımcılar ----------
const $app = document.getElementById('app');
const money = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' });
const fmt = (n) => money.format(n || 0);

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
function icon(name) {
  const paths = {
    tables: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    kitchen: '<path d="M6 13h12v5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/><path d="M6 13a4 4 0 1 1 2.5-7.1 4 4 0 0 1 7 0A4 4 0 1 1 18 13"/>',
    reports: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
    account: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  };
  const s = el('span', { class: 'icon', 'aria-hidden': 'true' });
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
  return s;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* depolama kapalı */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* depolama kapalı */ } },
};

let toastTimer;
function toast(msg, kind) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3200);
}

async function api(path, body, method) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('Bağlantı kurulamadı. İnternetinizi kontrol edin.');
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/login') {
    S.user = null;
    viewLogin();
    throw new Error((data && data.error) || 'Oturum kapandı.');
  }
  if (!res.ok) throw new Error((data && data.error) || 'İşlem başarısız.');
  return data;
}

// ---------- Durum ----------
const S = {
  user: null,
  nav: 0,          // her ekran değişiminde artar; geç gelen yanıtları yok saymak için
  timer: null,
  fields: null,
  fieldId: store.get('fieldId', null),
  cats: null,
  products: new Map(), // catId -> ürünler
  installEvt: null,
};

function begin() {
  clearInterval(S.timer);
  S.timer = null;
  return ++S.nav;
}
const loading = () => el('div', { class: 'state' }, el('div', { class: 'spinner' }));
const empty = (text) => el('div', { class: 'state' }, text);
function errorBox(err, retry) {
  return el('div', { class: 'state error' }, el('p', null, err.message),
    retry && el('button', { class: 'btn', onclick: retry }, 'Tekrar dene'));
}

const TABS = [
  ['tables', 'Masalar', () => viewTables()],
  ['kitchen', 'Mutfak', () => viewKitchen()],
  ['reports', 'Raporlar', () => viewReports()],
  ['account', 'Hesap', () => viewAccount()],
];

/** Ortak sayfa iskeleti. main öğesini döndürür. */
function shell({ title, sub, back, action, tab, footer }) {
  const main = el('main', { class: footer ? 'has-footer' : '' });
  $app.replaceChildren(...[
    el('header', { class: 'top' },
      back ? el('button', { class: 'iconbtn', 'aria-label': 'Geri', onclick: back }, icon('back')) : null,
      el('div', { class: 'titles' }, el('h1', null, title), sub ? el('p', null, sub) : null),
      action || null),
    el('div', { class: 'offline-bar' }, 'Çevrimdışısınız — veriler güncel olmayabilir'),
    main,
    footer || null,
    tab ? el('nav', { class: 'tabs', 'aria-label': 'Ana menü' }, TABS.map(([id, label, go]) =>
      el('button', { class: id === tab ? 'active' : '', 'aria-current': id === tab ? 'page' : null, onclick: go },
        icon(id), el('span', null, label)))) : null,
  ].filter(Boolean));
  window.scrollTo(0, 0);
  return main;
}
const refreshBtn = (fn) => el('button', { class: 'iconbtn', 'aria-label': 'Yenile', onclick: fn }, icon('refresh'));

function segmented(options, value, onchange) {
  const box = el('div', { class: 'segmented', role: 'tablist' });
  const paint = (v) => box.replaceChildren(...options.map(([id, label]) =>
    el('button', {
      role: 'tab', 'aria-selected': String(id === v), class: id === v ? 'active' : '',
      onclick: () => { paint(id); onchange(id); },
    }, label)));
  paint(value);
  return box;
}

// ---------- Giriş ----------
function viewLogin() {
  begin();
  const saved = store.get('login', {});
  const cc = el('input', { name: 'cc', required: true, autocomplete: 'organization', autocapitalize: 'none', value: saved.cc || '' });
  const un = el('input', { name: 'username', required: true, autocomplete: 'username', autocapitalize: 'none', value: saved.username || '' });
  const pw = el('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' });
  const msg = el('p', { class: 'form-error', role: 'alert' });
  const btn = el('button', { class: 'btn primary block', type: 'submit' }, 'Giriş yap');
  const form = el('form', {
    class: 'login-card',
    onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Giriş yapılıyor…';
      try {
        const r = await api('/login', { cc: cc.value, username: un.value, password: pw.value });
        store.set('login', { cc: cc.value.trim(), username: un.value.trim() });
        S.user = r.user;
        viewTables();
      } catch (err) {
        msg.textContent = err.message;
        btn.disabled = false;
        btn.textContent = 'Giriş yap';
      }
    },
  },
    el('img', { class: 'logo', src: '/icons/icon.svg', alt: '', width: 72, height: 72 }),
    el('h1', null, 'SAS Smart'),
    el('p', { class: 'muted' }, 'Adisyon ve sipariş'),
    el('label', null, 'Müşteri kodu', cc),
    el('label', null, 'Kullanıcı adı', un),
    el('label', null, 'Şifre', pw),
    msg, btn);
  $app.replaceChildren(el('div', { class: 'login' }, form));
  (saved.cc ? pw : cc).focus();
}

// ---------- Masalar ----------
function duration(t) {
  const parts = [];
  if (t.days) parts.push(`${t.days}g`);
  if (t.hours) parts.push(`${t.hours}sa`);
  parts.push(`${t.minutes}dk`);
  return parts.join(' ');
}

async function viewTables() {
  const tok = begin();
  const main = shell({ title: 'Masalar', sub: S.user && S.user.name, tab: 'tables', action: refreshBtn(() => load()) });
  const chips = el('div', { class: 'chips' });
  const grid = el('div', { class: 'grid' }, loading());
  main.append(chips, grid);

  const paintChips = () => chips.replaceChildren(...S.fields.map((f) =>
    el('button', {
      class: 'chip' + (f.id === S.fieldId ? ' active' : ''),
      onclick: () => { S.fieldId = f.id; store.set('fieldId', f.id); paintChips(); grid.replaceChildren(loading()); load(); },
    }, f.name)));

  async function load(silent) {
    try {
      if (!S.fields) S.fields = await api('/fields');
      if (tok !== S.nav) return;
      if (!S.fields.length) return grid.replaceChildren(empty('Tanımlı bölüm bulunamadı.'));
      if (!S.fields.some((f) => f.id === S.fieldId)) S.fieldId = S.fields[0].id;
      if (!chips.children.length) paintChips();
      const fid = S.fieldId;
      const tables = await api('/tables?field=' + fid);
      if (tok !== S.nav || fid !== S.fieldId) return;
      if (!tables.length) return grid.replaceChildren(empty('Bu bölümde masa yok.'));
      grid.replaceChildren(...tables.map((t) => {
        const open = t.sid > 0;
        return el('button', { class: 'table' + (open ? ' open' : ''), onclick: () => viewOrder(t, fid) },
          el('strong', null, t.tableName),
          open ? el('span', { class: 'amount' }, fmt(t.totalPrice)) : el('span', { class: 'muted' }, 'Boş'),
          open ? el('span', { class: 'muted small' }, duration(t)) : null);
      }));
    } catch (err) {
      if (tok === S.nav && !silent) grid.replaceChildren(errorBox(err, () => { grid.replaceChildren(loading()); load(); }));
    }
  }
  await load();
  if (tok === S.nav) S.timer = setInterval(() => { if (!document.hidden) load(true); }, 20000);
}

// ---------- Sipariş (masa) ----------
async function viewOrder(table, fid) {
  const tok = begin();
  const cartKey = 'cart:' + table.tableId;
  let cart = store.get(cartKey, []); // [{ id, name, price, quantity, comment }]
  let catId = null;
  let query = '';
  let tab = 'menu';

  const list = el('div', { class: 'list' });
  const chips = el('div', { class: 'chips' });
  const search = el('input', {
    type: 'search', class: 'search', placeholder: 'Ürün ara…', 'aria-label': 'Ürün ara',
    oninput: () => { query = search.value.trim().toLocaleLowerCase('tr'); paintProducts(); },
  });
  const menuPane = el('section', null, chips, search, list);
  const billPane = el('section', { hidden: true });
  const bar = el('button', { class: 'cartbar', onclick: () => openCart() });
  const footer = el('div', { class: 'footer' }, bar);

  const main = shell({
    title: table.tableName,
    sub: table.sid > 0 ? `Açık adisyon · ${fmt(table.totalPrice)}` : 'Yeni adisyon',
    back: () => viewTables(),
    footer,
  });
  if (table.sid > 0) {
    main.append(segmented([['menu', 'Menü'], ['bill', 'Adisyon']], tab, (v) => {
      tab = v;
      menuPane.hidden = v !== 'menu';
      billPane.hidden = v !== 'bill';
      footer.hidden = v !== 'menu';
      if (v === 'bill') loadBill();
    }));
  }
  main.append(menuPane, billPane);

  const count = () => cart.reduce((a, i) => a + i.quantity, 0);
  const total = () => cart.reduce((a, i) => a + i.price * i.quantity, 0);
  const line = (id) => cart.find((i) => i.id === id);
  function change(p, delta) {
    let l = line(p.id);
    if (!l) { l = { id: p.id, name: p.name, price: p.price, quantity: 0, comment: '' }; cart.push(l); }
    l.quantity = Math.min(999, l.quantity + delta);
    if (l.quantity <= 0) cart = cart.filter((i) => i !== l);
    store.set(cartKey, cart);
    paintProducts();
    paintBar();
  }
  function stepper(p, qty) {
    return el('div', { class: 'stepper' },
      qty > 0 ? el('button', { 'aria-label': `${p.name} azalt`, onclick: () => change(p, -1) }, '−') : null,
      qty > 0 ? el('output', null, qty) : null,
      el('button', { class: 'plus', 'aria-label': `${p.name} ekle`, onclick: () => change(p, 1) }, '+'));
  }
  function paintBar() {
    const n = count();
    bar.disabled = n === 0;
    bar.replaceChildren(
      el('span', null, n ? `${n} ürün` : 'Sepet boş'),
      el('span', null, n ? `Sepeti gör · ${fmt(total())}` : 'Ürün ekleyin'));
  }
  function paintProducts() {
    const items = S.products.get(catId);
    if (!items) return;
    const shown = query ? items.filter((p) => p.name.toLocaleLowerCase('tr').includes(query)) : items;
    if (!shown.length) return list.replaceChildren(empty(query ? 'Eşleşen ürün yok.' : 'Bu kategoride ürün yok.'));
    list.replaceChildren(...shown.map((p) => {
      const l = line(p.id);
      return el('div', { class: 'row' + (l ? ' selected' : '') },
        el('div', { class: 'grow' }, el('strong', null, p.name), el('span', { class: 'muted' }, fmt(p.price))),
        stepper(p, l ? l.quantity : 0));
    }));
  }
  const paintChips = () => chips.replaceChildren(...S.cats.map((c) =>
    el('button', { class: 'chip' + (c.id === catId ? ' active' : ''), onclick: () => selectCat(c.id) }, c.name)));

  async function selectCat(id) {
    catId = id;
    paintChips();
    if (!S.products.has(id)) {
      list.replaceChildren(loading());
      try {
        const items = await api('/products?cat=' + id);
        S.products.set(id, items);
      } catch (err) {
        if (tok === S.nav && catId === id) list.replaceChildren(errorBox(err, () => selectCat(id)));
        return;
      }
    }
    if (tok === S.nav && catId === id) paintProducts();
  }

  async function loadBill() {
    billPane.replaceChildren(loading());
    try {
      const rows = await api('/sales/' + table.sid);
      if (tok !== S.nav) return;
      const sum = rows.reduce((a, r) => a + r.totalPrice, 0);
      const printBtn = el('button', {
        class: 'btn block',
        onclick: async () => {
          printBtn.disabled = true;
          try { await api(`/sales/${table.sid}/print`, null, 'POST'); toast('Adisyon yazıcıya gönderildi', 'ok'); }
          catch (err) { toast(err.message, 'err'); }
          printBtn.disabled = false;
        },
      }, 'Adisyonu yazdır');
      billPane.replaceChildren(
        rows.length ? el('div', { class: 'list' }, rows.map((r) =>
          el('div', { class: 'row' },
            el('div', { class: 'grow' }, el('strong', null, `${r.quantity} × ${r.productName}`),
              el('span', { class: 'muted' }, `${fmt(r.unitPrice)} · ${r.salesDate}`)),
            el('span', { class: 'amount' }, fmt(r.totalPrice))))) : empty('Adisyonda ürün yok.'),
        el('div', { class: 'total' }, el('span', null, 'Toplam'), el('strong', null, fmt(sum))),
        printBtn);
    } catch (err) {
      if (tok === S.nav) billPane.replaceChildren(errorBox(err, loadBill));
    }
  }

  function openCart() {
    const body = el('div', { class: 'sheet-body' });
    const totalEl = el('strong');
    const save = el('button', { class: 'btn primary block', onclick: submit }, 'Siparişi kaydet');
    const dlg = el('dialog', { class: 'sheet', onclose: () => { dlg.remove(); paintProducts(); paintBar(); } },
      el('div', { class: 'sheet-head' }, el('h2', null, `Sepet · ${table.tableName}`),
        el('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Kapat')),
      body,
      el('div', { class: 'sheet-foot' }, el('div', { class: 'total' }, el('span', null, 'Toplam'), totalEl), save));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

    function paint() {
      if (!cart.length) return dlg.close();
      totalEl.textContent = fmt(total());
      body.replaceChildren(...cart.map((l) => el('div', { class: 'cart-line' },
        el('div', { class: 'row' },
          el('div', { class: 'grow' }, el('strong', null, l.name),
            el('span', { class: 'muted' }, `${fmt(l.price)} × ${l.quantity} = ${fmt(l.price * l.quantity)}`)),
          el('div', { class: 'stepper' },
            el('button', { 'aria-label': `${l.name} azalt`, onclick: () => { step(l, -1); } }, '−'),
            el('output', null, l.quantity),
            el('button', { class: 'plus', 'aria-label': `${l.name} artır`, onclick: () => { step(l, 1); } }, '+'))),
        el('input', {
          class: 'note', placeholder: 'Not (örn. acısız)', maxLength: 200, value: l.comment, 'aria-label': `${l.name} notu`,
          oninput: (e) => { l.comment = e.target.value; store.set(cartKey, cart); },
        }))));
    }
    function step(l, d) {
      l.quantity = Math.min(999, l.quantity + d);
      if (l.quantity <= 0) cart = cart.filter((i) => i !== l);
      store.set(cartKey, cart);
      paint();
    }
    async function submit() {
      save.disabled = true;
      save.textContent = 'Kaydediliyor…';
      try {
        await api('/orders', {
          fid, tid: table.tableId, sid: table.sid,
          items: cart.map((l) => ({ id: l.id, quantity: l.quantity, comment: l.comment })),
        });
        cart = [];
        store.del(cartKey);
        dlg.close();
        toast('Sipariş kaydedildi', 'ok');
        viewTables();
      } catch (err) {
        toast(err.message, 'err');
        save.disabled = false;
        save.textContent = 'Siparişi kaydet';
      }
    }
    document.body.append(dlg);
    paint();
    if (cart.length) dlg.showModal();
  }

  paintBar();
  list.replaceChildren(loading());
  try {
    if (!S.cats) S.cats = await api('/categories');
    if (tok !== S.nav) return;
    if (!S.cats.length) return list.replaceChildren(empty('Menü kategorisi bulunamadı.'));
    selectCat(S.cats[0].id);
  } catch (err) {
    if (tok === S.nav) list.replaceChildren(errorBox(err, () => viewOrder(table, fid)));
  }
}

// ---------- Mutfak ----------
async function viewKitchen() {
  const tok = begin();
  let status = 'bekleyen';
  const box = el('div', { class: 'cards' });
  const main = shell({ title: 'Mutfak', tab: 'kitchen', action: refreshBtn(() => load()) });
  main.append(
    segmented([['bekleyen', 'Bekleyen'], ['hazirlaniyor', 'Hazırlanıyor'], ['hazir', 'Hazır']], status,
      (v) => { status = v; box.replaceChildren(loading()); load(); }),
    box);

  async function load(silent) {
    const st = status;
    try {
      const rows = await api('/kitchen/' + st);
      if (tok !== S.nav || st !== status) return;
      box.replaceChildren(...(rows.length ? rows.map((r) =>
        el('article', { class: 'card ' + st },
          el('header', null, el('strong', null, r.name || `Adisyon #${r.sid}`), el('span', { class: 'muted small' }, r.salesDate)),
          el('p', { class: 'items' }, r.items))) : [empty('Sipariş yok.')]));
    } catch (err) {
      if (tok === S.nav && !silent) box.replaceChildren(errorBox(err, () => load()));
    }
  }
  box.replaceChildren(loading());
  await load();
  if (tok === S.nav) S.timer = setInterval(() => { if (!document.hidden) load(true); }, 15000);
}

// ---------- Raporlar ----------
function businessDay() {
  const d = new Date(Date.now() - 6 * 3600 * 1000); // iş günü 06:00'da başlar
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function viewReports() {
  const tok = begin();
  let kind = 'payments';
  const today = businessDay();
  const start = el('input', { type: 'date', value: today, max: today, onchange: () => load() });
  const end = el('input', { type: 'date', value: today, max: today, onchange: () => load() });
  const box = el('div');
  const main = shell({ title: 'Raporlar', tab: 'reports', action: refreshBtn(() => load()) });
  main.append(
    el('div', { class: 'dates' }, el('label', null, 'Başlangıç', start), el('label', null, 'Bitiş', end)),
    segmented([['payments', 'Ödemeler'], ['sales', 'Satışlar']], kind, (v) => { kind = v; load(); }),
    box);

  async function load() {
    if (!start.value || !end.value) return;
    if (start.value > end.value) return box.replaceChildren(empty('Başlangıç tarihi bitişten sonra olamaz.'));
    const k = kind;
    box.replaceChildren(loading());
    try {
      const rows = await api(`/reports/${k}?start=${start.value}&end=${end.value}`);
      if (tok !== S.nav || k !== kind) return;
      if (!rows.length) return box.replaceChildren(empty('Bu aralıkta kayıt yok.'));
      box.replaceChildren(...(k === 'payments' ? paymentsReport(rows) : salesReport(rows)));
    } catch (err) {
      if (tok === S.nav) box.replaceChildren(errorBox(err, load));
    }
  }
  load();
}
function paymentsReport(rows) {
  const by = new Map();
  let sum = 0;
  for (const r of rows) {
    const key = r.payMethod || r.payType || 'Diğer';
    by.set(key, (by.get(key) || 0) + r.totalPrice);
    sum += r.totalPrice;
  }
  return [
    el('div', { class: 'stats' },
      el('div', { class: 'stat main' }, el('span', null, 'Toplam'), el('strong', null, fmt(sum))),
      [...by].map(([k, v]) => el('div', { class: 'stat' }, el('span', null, k), el('strong', null, fmt(v))))),
    el('div', { class: 'list' }, rows.map((r) => el('div', { class: 'row' },
      el('div', { class: 'grow' }, el('strong', null, r.tableName || `Adisyon #${r.sid}`),
        el('span', { class: 'muted' }, [r.payMethod, r.user, r.payDate].filter(Boolean).join(' · '))),
      el('span', { class: 'amount' }, fmt(r.totalPrice))))),
  ];
}
function salesReport(rows) {
  const sorted = [...rows].sort((a, b) => b.quantity - a.quantity);
  const max = Math.max(1, sorted[0].quantity);
  const sum = sorted.reduce((a, r) => a + r.quantity, 0);
  return [
    el('div', { class: 'stats' }, el('div', { class: 'stat main' }, el('span', null, 'Satılan ürün adedi'), el('strong', null, sum))),
    el('div', { class: 'list' }, sorted.map((r) => {
      const bar = el('div', { class: 'bar' });
      bar.style.width = `${Math.round((r.quantity / max) * 100)}%`;
      return el('div', { class: 'row' },
        el('div', { class: 'grow' }, el('strong', null, r.name), bar),
        el('span', { class: 'amount' }, r.quantity));
    })),
  ];
}

// ---------- Hesap ----------
async function viewAccount() {
  const tok = begin();
  const branches = el('div', { class: 'list' }, loading());
  const main = shell({ title: 'Hesap', tab: 'account' });
  main.append(
    el('div', { class: 'profile' }, el('div', { class: 'avatar' }, (S.user.name || '?').slice(0, 1).toLocaleUpperCase('tr')),
      el('div', null, el('strong', null, S.user.name), el('span', { class: 'muted' }, `Kullanıcı no: ${S.user.id}`))),
    el('h2', { class: 'section' }, 'Şubeler'), branches,
    S.installEvt ? el('button', {
      class: 'btn block',
      onclick: async (e) => { S.installEvt.prompt(); await S.installEvt.userChoice; S.installEvt = null; e.target.remove(); },
    }, 'Uygulamayı ana ekrana ekle') : null,
    el('button', {
      class: 'btn danger block',
      onclick: async () => {
        try { await api('/logout', null, 'POST'); } catch { /* yine de çıkış yap */ }
        S.user = null;
        viewLogin();
      },
    }, 'Çıkış yap'));
  try {
    const rows = await api('/branches');
    if (tok !== S.nav) return;
    branches.replaceChildren(...(rows.length ? rows.map((b) =>
      el('div', { class: 'row' }, el('div', { class: 'grow' }, el('strong', null, b.shortcode || `Şube ${b.id}`)),
        el('span', { class: 'muted' }, `#${b.id}`))) : [empty('Şube bilgisi yok.')]));
  } catch (err) {
    if (tok === S.nav) branches.replaceChildren(empty(err.message));
  }
}

// ---------- Başlangıç ----------
const setOffline = () => document.body.classList.toggle('offline', !navigator.onLine);
window.addEventListener('online', setOffline);
window.addEventListener('offline', setOffline);
setOffline();
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

(async () => {
  $app.replaceChildren(loading());
  try {
    S.user = (await api('/me')).user;
    viewTables();
  } catch {
    if (!S.user) viewLogin();
  }
})();
