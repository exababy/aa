/* NetCHIEF Smart POS — tam panel sayfaları (Rezervasyon, Kasadan Çıkış, Çağrı Merkezi) ve Seçenekler penceresi. */
import { el, icon, tl, money, qty, r2, api, run, toast, dialog, okCancel, confirmBox, numpad, parseNum, trDateTime, isoDate } from './core.js';
import * as dlg from './dialogs.js';
import { S } from './app.js';

const trDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const shift = (iso, days) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + days); return isoDate(d); };

/** Liste (ListView) yardımcıları */
function grid(cols, rows, { selected, onPick, onOpen, foot } = {}) {
  return el('table', {},
    el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.cls || '' }, c.title)))),
    el('tbody', {}, rows.length ? rows.map((r) => el('tr', {
      class: selected && selected() === r ? 'sel' : '', onclick: onPick ? () => onPick(r) : null, ondblclick: onOpen ? () => onOpen(r) : null,
    }, cols.map((c) => el('td', { class: c.cls || '' }, c.get(r))))) : el('tr', {}, el('td', { colSpan: cols.length, class: 'c' }, 'Kayıt yok'))),
    foot ? el('tfoot', {}, el('tr', {}, foot.map((f, i) => el('td', { class: cols[i].cls || '' }, f)))) : null);
}
const dateBar = (get, set) => [
  el('input', { class: 'inp', type: 'date', value: get(), onchange: (e) => e.target.value && set(e.target.value) }),
  el('button', { class: 'btn', title: 'Önceki gün', onclick: () => set(shift(get(), -1)) }, icon('left', 'sm')),
  el('button', { class: 'btn', title: 'Sonraki gün', onclick: () => set(shift(get(), 1)) }, icon('right', 'sm')),
];
const title = (text, hooks) => el('div', { class: 'ptitle' }, el('h2', {}, text),
  el('button', { class: 'sb gray', title: 'Masalara dön', onclick: hooks.closePage }, icon('left')));

export function openPage(host, kind, hooks) {
  ({ rezervasyon, kasa, cagri })[kind](host, hooks);
}

// ---------- Rezervasyon ----------
function rezervasyon(host, hooks) {
  let date = isoDate();
  let rows = [];
  let selected = null;
  const lv = el('div', { class: 'lv' });
  const sumPax = el('b', {});
  const tools = el('div', { class: 'tools' });
  const load = () => run(async () => {
    rows = await api(`/reservations?date=${date}`);
    selected = null;
    paint();
  });
  const form = (r) => run(async () => {
    const out = await rezervForm(r || { date });
    if (out) { date = out.date; load(); }
  });
  function paint() {
    const kids = rows.reduce((a, r) => a + r.kids, 0);
    sumPax.textContent = `${rows.reduce((a, r) => a + r.pax, 0)}${kids ? ` + ${kids} çocuk` : ''}`;
    tools.replaceChildren(
      el('button', { class: 'btn teal', onclick: () => form(null) }, icon('plus', 'sm'), 'Yeni Kayıt'),
      ...dateBar(() => date, (d) => { date = d; load(); }),
      el('button', { class: 'btn danger', onclick: () => run(async () => {
        if (!selected) return;
        if (!(await confirmBox('Seçilen kayıt siliniyor !', { danger: true }))) return;
        await api(`/reservations/${selected.id}/delete`, {});
        load();
      }) }, 'SİL'),
      el('button', { class: 'btn gold', onclick: () => selected && form(selected) }, 'DÜZENLE'),
      el('div', { class: 'pill grow' }, 'Toplam Kişi', sumPax),
      el('button', { class: 'btn', onclick: () => window.print() }, icon('print', 'sm'), 'Yazdır'));
    lv.replaceChildren(grid([
      { title: 'No.', get: (r) => r.id }, { title: 'Müşteri', get: (r) => r.name }, { title: 'Telefon', get: (r) => r.phone },
      { title: 'Saat', get: (r) => r.time }, { title: 'Kişi', get: (r) => (r.kids ? `${r.pax}+${r.kids}` : r.pax), cls: 'c' },
      { title: 'Masa', get: (r) => r.table, cls: 'c' }, { title: 'Açıklama', get: (r) => r.note },
    ], rows, { selected: () => selected, onPick: (r) => { selected = r; paint(); }, onOpen: (r) => form(r) }));
  }
  host.replaceChildren(title('R e z e r v a s y o n', hooks), tools, lv);
  load();
}
export function rezervForm(r) {
  return dialog({
    title: 'Rezervasyon Ekle', cls: '',
    build: (done) => {
      const f = {
        name: el('input', { class: 'inp', value: r.name || '', autofocus: true }), date: el('input', { class: 'inp', type: 'date', value: r.date || isoDate() }),
        phone: el('input', { class: 'inp', inputMode: 'tel', value: r.phone || '' }), time: el('input', { class: 'inp', type: 'time', value: r.time || '19:00' }),
        pax: el('input', { class: 'inp num', inputMode: 'numeric', value: r.pax || '' }), kids: el('input', { class: 'inp num', inputMode: 'numeric', value: r.kids || '' }),
        table: el('input', { class: 'inp', value: r.table || '' }), note: el('textarea', { class: 'inp', value: r.note || '' }),
      };
      const pair = (a, la, b, lb) => el('div', { class: 'strip' }, el('label', {}, el('span', { class: 'lbl' }, la), a), el('label', {}, el('span', { class: 'lbl' }, lb), b));
      const go = () => run(async () => {
        const body = Object.fromEntries(Object.entries(f).map(([k, n]) => [k, n.value]));
        await api(r.id ? `/reservations/${r.id}` : '/reservations', body);
        done(body);
      });
      const node = [el('label', { class: 'lbl' }, 'Müşteri'), f.name, pair(f.date, 'Tarih', f.time, 'Saat'), el('label', { class: 'lbl' }, 'Telefon'), f.phone,
        pair(f.pax, 'Kişi Sayısı', f.kids, 'Çocuk'), el('label', { class: 'lbl' }, 'Masa'), f.table, el('label', { class: 'lbl' }, 'Açıklama'), f.note, okCancel(done, go)];
      return node;
    },
  });
}

// ---------- Kasadan Çıkış ----------
function kasa(host, hooks) {
  let date = S.cfg.today;
  let data = { rows: [], total: 0, types: [] };
  let selected = null;
  const lv = el('div', { class: 'lv' });
  const foot = el('div', { class: 'tools' });
  const type = el('select', { class: 'inp' });
  const comment = el('input', { class: 'inp soft', maxLength: 150 });
  const amount = el('input', { class: 'inp soft num', inputMode: 'decimal' });
  const commentLabel = el('span', { class: 'lbl' }, 'Açıklama');
  const staffBtn = el('button', { class: 'btn', title: 'Personel seç', hidden: true, onclick: () => run(async () => {
    const p = await staffDialog(true);
    if (p) { comment.value = p.name; if (!amount.value) amount.value = money(p.wage); }
  }) }, icon('users', 'sm'));
  type.onchange = () => { const personel = /^personel$/i.test(type.value); commentLabel.textContent = personel ? 'Personel' : 'Açıklama'; staffBtn.hidden = !personel; };
  const load = () => run(async () => {
    data = await api(`/payouts?date=${date}`);
    if (!type.options.length) type.replaceChildren(...data.types.map((t) => el('option', {}, t)));
    selected = null;
    paint();
  });
  const save = () => run(async () => {
    const v = parseNum(amount.value);
    if (!(v > 0)) throw new Error('Ödeme tutarı geçersiz');
    await api('/payouts', { type: type.value, comment: comment.value, amount: v });
    toast('Kayıt işlemi başarılı.', 'ok');
    comment.value = '';
    amount.value = '';
    load();
  });
  function paint() {
    lv.replaceChildren(grid([
      { title: 'İ.No.', get: (r) => r.id }, { title: 'Tarih', get: (r) => trDateTime(r.date) }, { title: 'Ödeme Türü', get: (r) => r.type },
      { title: 'Açıklama', get: (r) => r.label }, { title: 'Ödeme Tutarı', get: (r) => tl(r.amount), cls: 'r' },
    ], data.rows, { selected: () => selected, onPick: (r) => { selected = r; paint(); } }));
    foot.replaceChildren(...dateBar(() => date, (d) => { date = d; load(); }),
      el('button', { class: 'btn danger', onclick: () => run(async () => {
        if (!selected || !(await confirmBox('Seçilen kayıt siliniyor !', { danger: true }))) return;
        await api(`/payouts/${selected.id}/delete`, {});
        load();
      }) }, 'SİL'),
      el('div', { class: 'pill sum grow' }, 'T o p l a m', el('span', { class: 'grow' }), el('b', {}, tl(data.total))));
  }
  host.replaceChildren(title('K a s a d a n    Ç ı k ı ş    İ ş l e m l e r i', hooks),
    el('div', { class: 'group' }, el('h3', {}, 'Y E N İ    K A Y I T'),
      el('div', { class: 'tools' },
        el('label', { class: 'grow' }, el('span', { class: 'lbl' }, 'Ödeme Tipi'), type),
        el('label', { class: 'grow' }, commentLabel, comment),
        el('label', {}, el('span', { class: 'lbl' }, 'Ödeme Tutarı'), amount))),
    el('div', { class: 'tools' }, el('span', { class: 'grow' }), staffBtn,
      el('button', { class: 'btn ok', onclick: save }, icon('check', 'sm'), 'Kaydet'),
      el('button', { class: 'btn', onclick: () => { comment.value = ''; amount.value = ''; } }, icon('x', 'sm'), 'Temizle')),
    lv, foot);
  amount.onkeydown = (e) => { if (e.key === 'Enter') save(); };
  load();
}

/** STAFF — personel listesi (kasa çıkışında seçim; Seçenekler'de tanım) */
export function staffDialog(pick) {
  return dialog({
    title: 'Personel', cls: 'lg',
    build: (done) => {
      let rows = [];
      let selected = null;
      const lv = el('div', { class: 'lv' });
      const f = { name: el('input', { class: 'inp' }), role: el('select', { class: 'inp' }, S.cfg.staffRoles.map((r) => el('option', {}, r))), wage: el('input', { class: 'inp num', inputMode: 'decimal' }) };
      const load = () => run(async () => { rows = await api('/staff'); selected = null; fill(null); paint(); });
      const fill = (p) => { f.name.value = p ? p.name : ''; f.role.value = p ? p.role : S.cfg.staffRoles[0]; f.wage.value = p ? money(p.wage) : ''; };
      const paint = () => lv.replaceChildren(grid([
        { title: 'S.No', get: (r) => r.id }, { title: 'Adı Soyadı', get: (r) => r.name }, { title: 'Görevi', get: (r) => r.role }, { title: 'Ücret', get: (r) => money(r.wage), cls: 'r' },
      ], rows, { selected: () => selected, onPick: (r) => { selected = r; fill(r); paint(); }, onOpen: (r) => pick && done(r) }));
      const save = (id) => run(async () => { await api(id ? `/staff/${id}` : '/staff', { name: f.name.value, role: f.role.value, wage: parseNum(f.wage.value) || 0 }); load(); });
      load();
      return [lv,
        el('div', { class: 'tools' }, el('label', { class: 'grow' }, el('span', { class: 'lbl' }, 'Adı Soyadı'), f.name), el('label', {}, el('span', { class: 'lbl' }, 'Görevi'), f.role), el('label', {}, el('span', { class: 'lbl' }, 'Ücret'), f.wage)),
        el('div', { class: 'win-foot spread' },
          el('div', { class: 'win-foot' },
            el('button', { class: 'btn', onclick: () => save(0) }, icon('plus', 'sm'), 'Ekle'),
            el('button', { class: 'btn', onclick: () => selected && save(selected.id) }, icon('edit', 'sm'), 'Güncelle'),
            el('button', { class: 'btn', onclick: () => run(async () => { if (selected && await confirmBox('Seçilen kayıt siliniyor !', { danger: true })) { await api(`/staff/${selected.id}/delete`, {}); load(); } }) }, icon('trash', 'sm'), 'Sil')),
          pick ? el('button', { class: 'btn ok lg', onclick: () => (selected ? done(selected) : toast('Personel seçin.', 'err')) }, 'Seç') : el('button', { class: 'btn', onclick: () => done() }, 'Kapat'))];
    },
  });
}

// ---------- Çağrı Merkezi ----------
function cagri(host, hooks) {
  let date = isoDate();
  let calls = [];
  let call = null;
  let customer = null;
  let orders = [];
  const callsLv = el('div', { class: 'lv' });
  const ordersLv = el('div', { class: 'lv' });
  const f = { phone: el('input', { inputMode: 'tel' }), name: el('input', {}), address: el('textarea', {}), note: el('textarea', {}) };
  const load = () => run(async () => { calls = await api(`/calls?date=${date}`); paint(); });
  const pick = (c) => run(async () => {
    call = c;
    customer = null;
    orders = [];
    f.phone.value = c.phone;
    f.name.value = c.customer;
    f.address.value = '';
    f.note.value = '';
    const found = await api(`/customers?phone=${encodeURIComponent(c.phone)}`);
    if (found.length) await setCustomer(found[0]);
    paint();
  });
  const setCustomer = async (c) => {
    customer = c;
    f.phone.value = c.phone;
    f.name.value = c.name;
    f.address.value = c.address;
    f.note.value = c.note;
    orders = (await api(`/customers/${c.id}/statement`)).orders;
  };
  const saveCustomer = () => run(async () => {
    const c = await api(customer ? `/customers/${customer.id}` : '/customers', { name: f.name.value, phone: f.phone.value, address: f.address.value, note: f.note.value });
    await setCustomer(c);
    toast('Müşteri bilgileri kaydedildi.', 'ok');
    paint();
  });
  function paint() {
    callsLv.replaceChildren(grid([{ title: 'Saat', get: (r) => r.time }, { title: 'Telefon', get: (r) => r.phone }, { title: 'Müşteri', get: (r) => r.customer }],
      calls, { selected: () => call, onPick: pick }));
    ordersLv.replaceChildren(grid([{ title: 'Tarih', get: (r) => trDateTime(r.date) }, { title: 'Satış No.', get: (r) => r.sid }, { title: 'Tutar', get: (r) => money(r.total), cls: 'r' }],
      orders, { onOpen: (r) => run(async () => dlg.salesDetails(await api(`/sales/${r.sid}`))) }));
  }
  host.replaceChildren(
    el('div', { class: 'ptitle' }, el('h2', {}, 'S o n   Ç a ğ r ı'),
      el('button', { class: 'btn navy', onclick: () => run(async () => { const c = await dlg.pickCustomer(); if (c) { call = null; await setCustomer(c); paint(); } }) }, 'Müşteri Seç'),
      el('button', { class: 'btn teal', onclick: () => run(async () => { await rezervForm({ name: f.name.value, phone: f.phone.value }); }) }, 'Rezervasyon'),
      el('button', { class: 'sb gray', title: 'Masalara dön', onclick: hooks.closePage }, icon('left'))),
    el('div', { class: 'split' },
      el('div', { class: 'col' },
        el('div', { class: 'kv' }, el('b', {}, 'Arayan No :'), f.phone, el('b', {}, 'Müşteri :'), f.name, el('b', {}, 'Adres :'), f.address, el('b', {}, 'Açıklama :'), f.note),
        el('div', { class: 'tools' },
          el('button', { class: 'btn danger lg grow', onclick: () => run(async () => {
            if (!customer) throw new Error('Lütfen müşteri için kayıt oluşturunuz.');
            await hooks.startPacketSale(customer);
          }) }, icon('bag'), 'Satış'),
          el('button', { class: 'btn ok lg', onclick: saveCustomer }, icon('check'), 'Kaydet')),
        el('div', { class: 'pill' }, 'İ ş l e m   G e ç m i ş i'), ordersLv),
      el('div', { class: 'col' },
        el('div', { class: 'tools' }, el('div', { class: 'pill grow' }, 'Ç a ğ r ı   G e ç m i ş i'), ...dateBar(() => date, (d) => { date = d; load(); })),
        callsLv)));
  load();
}

// ---------- Seçenekler ----------
const MENU = [
  ['Genel Ayarlar', 'gear', genel], ['Müşteriler', 'users', musteriler], ['Kullanıcılar', 'key', (h) => crud(h, USERS)], ['Bölümler', 'sitemap', (h) => crud(h, FIELDS)],
  ['Ürünler', 'box', urunler], ['Raporlar', 'chart', raporlar], ['Gün Sonu', 'calendar', gunSonu], ['Tahsilat İptal', 'trash', tahsilatIptal],
];
export function openOptions() {
  if (!S.me.canSettings) return void toast('Bu işlem için yetkili değilsiniz !', 'err');
  dialog({
    title: 'NetCHIEF Smart / Seçenekler', cls: 'xl',
    build: () => {
      const host = el('div', { class: 'col grow' });
      const nav = el('div', { class: 'userlist' });
      let cur = MENU[0];
      const paint = () => {
        nav.replaceChildren(...MENU.map((m) => el('button', { class: `userrow ${m === cur ? 'on' : ''}`, onclick: () => { cur = m; paint(); } }, m[0])));
        host.replaceChildren();
        m2(cur);
      };
      const m2 = (m) => m[2](host);
      paint();
      return el('div', { class: 'approve-grid grow', style: null }, nav, host);
    },
  }).then(async () => { S.menu = await api('/menu'); S.fields = await api('/fields'); });
}

function genel(host) {
  host.replaceChildren(el('div', { class: 'kv' },
    el('b', {}, 'Restoran Adı'), el('div', {}, S.cfg.restaurant), el('b', {}, 'Kullanıcı'), el('div', {}, S.me.name),
    el('b', {}, 'İş günü'), el('div', {}, trDate(S.cfg.today)), el('b', {}, 'Mod'), el('div', {}, S.cfg.demo ? 'DEMO (örnek veri)' : 'Canlı veritabanı')),
  el('div', { class: 'tools' }, el('button', { class: 'btn', onclick: () => staffDialog(false) }, icon('users', 'sm'), 'Personel'),
    el('button', { class: 'btn', onclick: () => run(async () => { await api('/drawer', {}); toast('Çekmece komutu gönderildi', 'ok'); }) }, icon('drawer', 'sm'), 'Çekmece Aç')),
  el('p', { class: 'hint' }, 'Bağlantı ve yazıcı ayarları programın yanındaki pos.env / config.ini dosyasından okunur.'));
}

/** Basit tanım ekranı (liste + ad alanı): Kullanıcılar, Bölümler, Ürün Grupları */
const USERS = { path: 'users', cols: [{ title: 'S. No.', get: (r) => r.id }, { title: 'Kullanıcı Adı', get: (r) => r.name }, { title: 'Kart ID', get: (r) => r.card }], fields: [['name', 'Kullanıcı Adı'], ['password', 'Şifre', 'password'], ['password2', 'Şifre (tekrar)', 'password'], ['card', 'Kart ID']] };
const FIELDS = { path: 'fields', cols: [{ title: 'No.', get: (r) => r.id }, { title: 'Bölüm Adı', get: (r) => r.name }], fields: [['name', 'Bölüm Adı']] };
const GROUPS = { path: 'categories', cols: [{ title: 'No.', get: (r) => r.id }, { title: 'Grup Adı', get: (r) => r.name }], fields: [['name', 'Grup Adı']] };
function crud(host, def) {
  let rows = [];
  let selected = null;
  const lv = el('div', { class: 'lv' });
  const inputs = Object.fromEntries(def.fields.map(([k, , type]) => [k, el('input', { class: 'inp', type: type || 'text', autocomplete: 'off' })]));
  const fill = (r) => { for (const [k] of def.fields) inputs[k].value = r && typeof r[k] === 'string' ? r[k] : ''; };
  const load = () => run(async () => { rows = await api(`/admin/${def.path}`); selected = null; fill(null); paint(); });
  const paint = () => lv.replaceChildren(grid(def.cols, rows, { selected: () => selected, onPick: (r) => { selected = r; fill(r); paint(); } }));
  const save = (id) => run(async () => {
    const body = Object.fromEntries(Object.entries(inputs).map(([k, n]) => [k, n.value]));
    if ('password2' in body && body.password !== body.password2) throw new Error('Şifreler aynı değil.');
    await api(`/admin/${def.path}${id ? `/${id}` : ''}`, body);
    load();
  });
  host.replaceChildren(lv,
    el('div', { class: 'tools' }, def.fields.map(([k, label]) => el('label', { class: 'grow' }, el('span', { class: 'lbl' }, label), inputs[k]))),
    el('div', { class: 'win-foot' },
      el('button', { class: 'btn', onclick: () => save(0) }, icon('plus', 'sm'), 'Yeni Kayıt'),
      el('button', { class: 'btn', onclick: () => selected && save(selected.id) }, icon('edit', 'sm'), 'Düzenle'),
      el('button', { class: 'btn', onclick: () => run(async () => { if (selected && await confirmBox('Seçilen kayıt siliniyor !', { danger: true })) { await api(`/admin/${def.path}/${selected.id}/delete`, {}); load(); } }) }, icon('trash', 'sm'), 'Sil')));
  load();
}

function tabsOf(host, tabs) {
  const bar = el('div', { class: 'wtabs' });
  const body = el('div', { class: 'col grow' });
  const show = (t) => { bar.replaceChildren(...tabs.map((x) => el('button', { class: `wtab ${x === t ? 'on' : ''}`, onclick: () => show(x) }, x[0]))); body.replaceChildren(); t[1](body); };
  host.replaceChildren(bar, body);
  show(tabs[0]);
}

function urunler(host) {
  tabsOf(host, [['Ürünler', (h) => {
    let rows = [];
    let selected = null;
    const lv = el('div', { class: 'lv' });
    const q = el('input', { class: 'inp', placeholder: 'Ürün ara' });
    const load = () => run(async () => { rows = await api(`/admin/products?q=${encodeURIComponent(q.value)}`); selected = null; paint(); });
    const paint = () => lv.replaceChildren(grid([{ title: 'No.', get: (r) => r.id }, { title: 'Açıklama', get: (r) => r.name }, { title: 'Grup', get: (r) => r.group }, { title: 'Yazıcı', get: (r) => r.prn }, { title: 'Fiyat', get: (r) => money(r.price), cls: 'r' }],
      rows, { selected: () => selected, onPick: (r) => { selected = r; paint(); }, onOpen: (r) => edit(r) }));
    const edit = (p) => run(async () => { if (await productForm(p)) load(); });
    q.oninput = () => load();
    h.replaceChildren(el('div', { class: 'tools' }, el('label', { class: 'grow' }, q),
      el('button', { class: 'btn', onclick: () => edit(null) }, icon('plus', 'sm'), 'Yeni'),
      el('button', { class: 'btn', onclick: () => selected && edit(selected) }, icon('edit', 'sm'), 'Düzenle'),
      el('button', { class: 'btn', onclick: () => run(async () => { if (selected && await confirmBox(`${selected.name} siliniyor, emin misiniz ?`, { danger: true })) { await api(`/admin/products/${selected.id}/delete`, {}); load(); } }) }, icon('trash', 'sm'), 'Sil')), lv);
    load();
  }], ['Ürün Grupları', (h) => crud(h, GROUPS)]]);
}
function productForm(p) {
  return dialog({
    title: 'NetCHIEF Smart - Ürün Detayları', cls: '',
    build: (done) => {
      const cats = el('select', { class: 'inp' });
      const f = {
        name: el('input', { class: 'inp', value: p ? p.name : '', autofocus: true }), price: el('input', { class: 'inp num', inputMode: 'decimal', value: p ? money(p.price) : '' }),
        prn: el('input', { class: 'inp', value: p ? p.prn : '', placeholder: 'örn. KEBAP, BAR, MUTFAK' }),
        type: el('select', { class: 'inp' }, ['Adet', 'Kg.', 'Adet (Porsiyon)'].map((t, i) => el('option', { value: i, selected: p ? Math.min(p.type, 2) === i : i === 0 }, t))),
      };
      run(async () => { cats.replaceChildren(...(await api('/admin/categories')).map((c) => el('option', { value: c.id, selected: p && p.cat === c.id }, c.name))); });
      const go = () => run(async () => {
        await api(`/admin/products${p ? `/${p.id}` : ''}`, { name: f.name.value, cat: Number(cats.value), price: parseNum(f.price.value), prn: f.prn.value, type: Number(f.type.value) });
        done(true);
      });
      return [el('label', { class: 'lbl' }, 'Ürün Adı'), f.name, el('label', { class: 'lbl' }, 'Ürün Grubu'), cats, el('label', { class: 'lbl' }, 'Fiyat'), f.price,
        el('label', { class: 'lbl' }, 'Yazıcı'), f.prn, el('label', { class: 'lbl' }, 'Birim'), f.type, okCancel(done, go)];
    },
  });
}

function musteriler(host) {
  let rows = [];
  let selected = null;
  const lv = el('div', { class: 'lv' });
  const q = el('input', { class: 'inp', placeholder: 'Ünvanı' });
  const load = () => run(async () => { rows = await api(`/customers?name=${encodeURIComponent(q.value)}`); selected = rows.find((r) => selected && r.id === selected.id) || null; paint(); });
  const paint = () => lv.replaceChildren(grid([{ title: 'Müş. No.', get: (r) => r.id }, { title: 'Ünvanı', get: (r) => r.name }, { title: 'Telefon', get: (r) => r.phone }, { title: 'Bakiye', get: (r) => money(r.balance), cls: 'r' }],
    rows, { selected: () => selected, onPick: (r) => { selected = r; paint(); }, onOpen: () => islemler() }));
  const need = () => { if (!selected) throw new Error('Lütfen Müşteri seçiniz !'); return selected; };
  const islemler = () => run(async () => { await statementDialog(need()); load(); });
  q.oninput = () => load();
  host.replaceChildren(el('div', { class: 'tools' }, el('label', { class: 'grow' }, q),
    el('button', { class: 'btn', onclick: () => run(async () => { await dlg.pickCustomer(); load(); }) }, icon('edit', 'sm'), 'Kayıt / Düzenle'),
    el('button', { class: 'btn', onclick: islemler }, icon('list', 'sm'), 'İşlemler'),
    el('button', { class: 'btn ok', onclick: () => run(async () => { if (await tahsilat(need())) load(); }) }, icon('cash', 'sm'), 'Tahsilat')), lv);
  load();
}
/** Cari işlemler ve hesap ekstresi */
function statementDialog(c) {
  return dialog({
    title: `Hesap Ekstresi — ${c.name}`, cls: 'lg',
    build: (done) => {
      const lv = el('div', { class: 'lv' });
      const bal = el('b', {});
      run(async () => {
        const st = await api(`/customers/${c.id}/statement`);
        bal.textContent = tl(st.customer.balance);
        lv.replaceChildren(grid([{ title: 'Tarih', get: (r) => trDateTime(r.date) }, { title: 'İşlem', get: (r) => r.kind }, { title: 'Satış No.', get: (r) => r.sid || '' }, { title: 'Ödeme No.', get: (r) => r.id }, { title: 'Tutar', get: (r) => money(r.amount), cls: 'r' }],
          st.rows, { onOpen: (r) => r.sid && run(async () => dlg.salesDetails(await api(`/sales/${r.sid}`))) }));
      });
      return [lv, el('div', { class: 'sumline' }, 'Bakiye', bal),
        el('div', { class: 'win-foot' }, el('button', { class: 'btn', onclick: () => window.print() }, icon('print', 'sm'), 'Ekstre Yazdır'), el('button', { class: 'btn', onclick: () => done() }, 'Kapat'))];
    },
  });
}
/** PAYMENT_CARI — "Cari Tahsilat" */
function tahsilat(c) {
  return dialog({
    title: 'NetCHIEF Smart - Cari Tahsilat', cls: 'sm',
    build: (done) => {
      const rows = [];
      const amount = el('input', { class: 'inp big num soft', inputMode: 'none', autofocus: true });
      const list = el('div', { class: 'paylist' });
      const sum = el('b', {});
      const paint = () => {
        list.replaceChildren(...rows.map((r, i) => el('div', { class: 'payrow' }, el('span', {}, r.method === 1 ? 'Nakit' : 'Kredi Kartı'), el('b', {}, tl(r.amount)), el('button', { onclick: () => { rows.splice(i, 1); paint(); } }, icon('x', 'sm')))));
        sum.textContent = tl(rows.reduce((a, r) => a + r.amount, 0));
      };
      const add = (method) => { const v = parseNum(amount.value); if (!(v > 0)) return toast('Tutar numerik değil', 'err'); rows.push({ method, amount: r2(v) }); amount.value = ''; paint(); };
      paint();
      return [el('label', { class: 'lbl' }, 'Ödenecek Tutar'), amount,
        el('div', { class: 'methods' }, el('button', { class: 'method cash', onclick: () => add(1) }, icon('cash'), 'Nakit'), el('button', { class: 'method cc', onclick: () => add(2) }, icon('card'), 'Kredi Kartı')),
        el('div', { class: 'strip' }, el('div', { class: 'p' }, 'Müşteri:', el('b', {}, c.name)), el('div', { class: 't' }, 'Bakiye:', el('b', {}, tl(c.balance)))),
        list, el('div', { class: 'strip' }, el('div', { class: 'g' }, 'İşlem Toplamı:', sum)), numpad(amount),
        okCancel(done, () => run(async () => { if (!rows.length) throw new Error('Nakit ya da Kredi Kartı ile tutar ekleyin.'); await api(`/customers/${c.id}/collect`, { rows }); toast('Tahsilat kaydedildi', 'ok'); done(true); }))];
    },
  });
}

// ---------- Raporlar ----------
const REPORTS = [
  ['Kasa Hareketleri', 'kasa', [{ title: 'Ödeme No.', get: (r) => r.id }, { title: 'Satış No.', get: (r) => r.sid || '' }, { title: 'Masa', get: (r) => r.table }, { title: 'Tarih', get: (r) => trDateTime(r.date) }, { title: 'Tutar', get: (r) => money(r.amount), cls: 'r' }, { title: 'Ödeme Şekli', get: (r) => r.label }]],
  ['Satış Raporları', 'sales', [{ title: 'Ürün Açıklaması', get: (r) => r.name }, { title: 'Miktar', get: (r) => qty(r.quantity), cls: 'r' }, { title: 'Birim Fiyat', get: (r) => money(r.unit), cls: 'r' }, { title: 'Tutar', get: (r) => money(r.total), cls: 'r' }]],
  ['Masa Satış Listesi', 'tables', [{ title: 'Tarih', get: (r) => trDateTime(r.date) }, { title: 'Satış No.', get: (r) => r.sid }, { title: 'Masa', get: (r) => r.table }, { title: 'Pax', get: (r) => r.pax, cls: 'c' }, { title: 'İndirim', get: (r) => money(r.discount), cls: 'r' }, { title: 'Tutar', get: (r) => money(r.total), cls: 'r' }]],
  ['Personel Satış Listesi', 'staff', [{ title: 'Personel', get: (r) => r.name }, { title: 'Miktar', get: (r) => qty(r.quantity), cls: 'r' }, { title: 'Tutar', get: (r) => money(r.total), cls: 'r' }]],
  ['İptal Raporları', 'cancels', [{ title: 'Ürün', get: (r) => r.name }, { title: 'Miktar', get: (r) => qty(r.quantity), cls: 'r' }, { title: 'Açıklama', get: (r) => r.reason }, { title: 'Tutar', get: (r) => money(r.total), cls: 'r' }]],
];
function raporlar(host) {
  let start = S.cfg.today;
  let end = S.cfg.today;
  const kind = el('select', { class: 'inp' }, REPORTS.map((r, i) => el('option', { value: i }, r[0])));
  const filter = el('select', { class: 'inp' }, ['Hepsi', 'Nakit', 'Kredi Kartı', 'Kapalı'].map((t, i) => el('option', { value: i }, t)));
  const lv = el('div', { class: 'lv' });
  const sums = el('div', { class: 'sumline' });
  const d1 = el('input', { class: 'inp', type: 'date', value: start });
  const d2 = el('input', { class: 'inp', type: 'date', value: end });
  const load = () => run(async () => {
    const def = REPORTS[kind.value];
    filter.hidden = def[1] !== 'kasa';
    const data = await api(`/admin/reports/${def[1]}?start=${d1.value}&end=${d2.value}&filter=${filter.value}`);
    lv.replaceChildren(grid(def[2], data.rows, { onOpen: (r) => r.sid && run(async () => dlg.salesDetails(await api(`/sales/${r.sid}`))) }));
    sums.replaceChildren(...(def[1] === 'kasa'
      ? [`Nakit: ${tl(data.cash)}`, `Kredi Kartı: ${tl(data.card)}`, `Kapalı: ${tl(data.closed)}`, el('b', {}, `Toplam: ${tl(data.total)}`)]
      : [el('b', {}, `GENEL TOPLAM: ${tl(data.total)}`)]).map((x) => el('span', {}, x)));
  });
  for (const n of [kind, filter, d1, d2]) n.onchange = load;
  const move = (days) => { d1.value = shift(d1.value, days); d2.value = shift(d2.value, days); load(); };
  host.replaceChildren(el('div', { class: 'tools' }, el('label', { class: 'grow' }, kind), filter,
    el('button', { class: 'btn', onclick: () => move(-1) }, icon('left', 'sm')), d1, d2, el('button', { class: 'btn', onclick: () => move(1) }, icon('right', 'sm')),
    el('button', { class: 'btn', onclick: () => window.print() }, icon('print', 'sm'), 'YAZDIR')), lv, sums);
  load();
}

/** Gün Sonu: kasiyer sayımı → özet rapor (bölümler orijinal raporla aynı sırada) */
function gunSonu(host) {
  let date = S.cfg.today;
  const cash = el('input', { class: 'inp num', inputMode: 'decimal', placeholder: '0,00' });
  const card = el('input', { class: 'inp num', inputMode: 'decimal', placeholder: '0,00' });
  const out = el('div', { class: 'report lv' });
  const sec = (name, cols, rows, totalLabel, total) => el('section', {}, el('h3', {}, name),
    el('div', { class: 'lv' }, grid(cols, rows)), total != null ? el('div', { class: 'sumline' }, `${totalLabel || 'TOPLAM'}: ${money(total)}`) : null);
  const cnt = [{ title: 'Açıklama', get: (r) => r.name }, { title: 'İşlem', get: (r) => r.count, cls: 'c' }, { title: 'Tutar', get: (r) => tl(r.total), cls: 'r' }];
  const qt = [{ title: 'Açıklama', get: (r) => r.name }, { title: 'Miktar', get: (r) => qty(r.quantity), cls: 'c' }, { title: 'Tutar', get: (r) => tl(r.total), cls: 'r' }];
  const sum = (rows, k = 'total') => r2(rows.reduce((a, r) => a + r[k], 0));
  const load = () => run(async () => {
    const d = await api(`/admin/reports/eod?date=${date}&cash=${parseNum(cash.value) || 0}&card=${parseNum(card.value) || 0}`);
    out.replaceChildren(
      el('h3', { class: 'c' }, `${d.restaurant} Gün Sonu Raporu — ÖZET RAPOR / ${trDate(d.date)}`),
      sec('KASİYER SAYIM', [{ title: 'Açıklama', get: (r) => r.name }, { title: 'Tutar', get: (r) => money(r.counted), cls: 'c' }, { title: 'Fark', get: (r) => tl(r.diff), cls: 'r' }], d.count),
      sec('TAHSİLAT İŞLEMLERİ', cnt, d.collections, 'TOPLAM', d.collected),
      sec('SATIŞ GRUP ÖZET', [{ title: 'Bölüm', get: (r) => r.name }, cnt[1], cnt[2]], d.byField),
      sec('CARİ SATIŞLAR', cnt, d.cariSales, 'TOPLAM', sum(d.cariSales)),
      sec('CARİ TAHSİLATLAR', cnt, d.cariCollections, 'TOPLAM', sum(d.cariCollections)),
      sec('SATIŞ ÖZET', qt, d.byCategory, 'TOPLAM', sum(d.byCategory)),
      sec('SATIŞ DETAY', [qt[0], qt[1], { title: 'Fiyat', get: (r) => money(r.unit), cls: 'r' }, qt[2]], d.byProduct),
      sec('İKRAM DETAYLARI', [{ title: 'Personel', get: (r) => r.user }, ...qt], d.gifts, 'TOPLAM', sum(d.gifts)),
      sec('İPTAL İŞLEMLERİ', [qt[0], qt[1], { title: 'Sebep', get: (r) => r.reason }, qt[2]], d.cancels, 'TOPLAM', sum(d.cancels)),
      sec('ÖDEME ÖZETİ', cnt, d.payoutSummary, 'TOPLAM', d.payoutTotal),
      sec('ÖDEME LİSTESİ', [{ title: 'Tür', get: (r) => r.type }, { title: 'Açıklama', get: (r) => r.comment }, { title: 'Tutar', get: (r) => tl(r.amount), cls: 'r' }], d.payoutList));
  });
  host.replaceChildren(el('div', { class: 'tools' }, ...dateBar(() => date, (d) => { date = d; load(); }),
    el('label', {}, cash), el('label', {}, card),
    el('button', { class: 'btn ok', onclick: load }, 'LİSTELE'), el('button', { class: 'btn', onclick: () => window.print() }, icon('print', 'sm'), 'YAZDIR')),
  el('p', { class: 'hint' }, 'Kasiyer sayımı: soldaki kutuya sayılan nakit, sağdakine POS gün sonu toplamı yazılır.'), out);
  cash.placeholder = 'Sayılan nakit';
  card.placeholder = 'POS toplamı';
  load();
}

function tahsilatIptal(host) {
  const no = el('input', { class: 'inp big num', inputMode: 'numeric' });
  const by = el('select', { class: 'inp' }, el('option', { value: 'pay' }, 'Ödeme No.'), el('option', { value: 'sale' }, 'Satış No.'));
  const lv = el('div', { class: 'lv' });
  const sums = el('div', { class: 'sumline' });
  let info = null;
  const find = () => run(async () => {
    info = await api(`/admin/payments-of?no=${Number(no.value)}&by=${by.value}`);
    lv.replaceChildren(grid([{ title: 'Ödeme No.', get: (r) => r.id }, { title: 'Tarih', get: (r) => trDateTime(r.date) }, { title: 'Ödeme Şekli', get: (r) => r.type || r.label }, { title: 'Tutar', get: (r) => tl(r.amount), cls: 'r' }], info.payments));
    sums.textContent = `Satış No. ${info.sid || '—'} · Toplam: ${tl(info.total)}`;
  });
  host.replaceChildren(el('div', { class: 'tools' }, by, el('label', { class: 'grow' }, no), el('button', { class: 'btn', onclick: find }, icon('search', 'sm'), 'Bul'),
    el('button', { class: 'btn danger', onclick: () => run(async () => {
      if (!info) throw new Error('Önce ödeme ya da satış numarasını bulun.');
      if (!(await confirmBox(`Belirtilen işleme ait ${money(info.total)} tutarında tahsilat iptal ediliyor,\nİşleme devam et ?`, { danger: true }))) return;
      await api('/admin/payments-cancel', { no: Number(no.value), by: by.value });
      toast('Tahsilat iptal edildi', 'ok');
      info = null;
      lv.replaceChildren();
      sums.textContent = '';
    }) }, 'TAHSİLAT İPTAL')), lv, sums,
  el('p', { class: 'hint' }, 'Satışa ait tüm tahsilatlar silinir, cari bakiyeler düzeltilir ve satış kalemleri iptal kayıtlarına taşınır.'));
}
