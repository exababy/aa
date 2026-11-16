/* NetCHIEF Smart POS — pencereler. Her biri orijinal programdaki aynı adlı formun karşılığıdır. */
import { el, icon, tl, money, qty, r2, api, run, toast, dialog, okCancel, confirmBox, numpad, parseNum, trDateTime } from './core.js';

const rowsOf = (lines, onPick, selected) => (lines.length ? lines.map((l) => el('div', {
  class: `row ${selected && selected() === l.id ? 'sel' : ''}`, onclick: () => onPick && onPick(l),
}, el('b', {}, qty(l.quantity)), el('span', {}, l.name), el('em', {}, money(l.unit * l.quantity)))) : [el('div', { class: 'empty' }, '—')]);

/** Ödeme düğmesinin açtığı küçük menü: Nakit / Kredi Kartı / Multi Ödeme / Ödeme */
export function payMenu() {
  return dialog({
    title: 'Ödeme', cls: 'sm',
    build: (done) => el('div', { class: 'tiles' },
      el('button', { class: 'tile', onclick: () => done('cash') }, icon('cash'), 'Nakit'),
      el('button', { class: 'tile', onclick: () => done('card') }, icon('card'), 'Kredi Kartı'),
      el('button', { class: 'tile', onclick: () => done('multi') }, icon('list'), 'Multi Ödeme'),
      el('button', { class: 'tile', onclick: () => done('pay') }, icon('wallet'), 'Ödeme')),
  });
}

/** PAYMENT — "NetCHIEF Smart - Ödeme": indirim, parçalı / karışık ödeme, kapalı (cari) ödeme. */
export function payment(s) {
  return dialog({
    title: 'NetCHIEF Smart - Ödeme', cls: 'md',
    build: (done) => {
      const base = r2(s.subtotal - s.paid); // indirim öncesi kalan
      let discount = s.discount;
      const rows = [];
      const disc = el('input', { class: 'num', inputMode: 'none', value: discount ? money(discount) : '' });
      const amount = el('input', { class: 'num', inputMode: 'none', autofocus: true });
      const list = el('div', { class: 'paylist' });
      const sum = el('b', {});
      const entered = () => r2(rows.reduce((a, r) => a + r.amount, 0));
      const remaining = () => r2(base - discount - entered());
      const paint = () => {
        amount.value = money(remaining());
        amount.disabled = remaining() <= 0;
        sum.textContent = tl(entered());
        list.replaceChildren(...(rows.length ? rows.map((r, i) => el('div', { class: 'payrow' },
          el('span', {}, `${i + 1}. ${r.label}${r.note ? ` — ${r.note}` : ''}`), el('b', {}, tl(r.amount)),
          el('button', { title: 'Sil', onclick: () => { rows.splice(i, 1); paint(); } }, icon('x', 'sm')))) : [el('div', { class: 'empty' }, s.printed ? '' : 'Satış Yazdırılmadı !')]));
      };
      const setDiscount = (v) => {
        discount = Math.min(Math.max(0, r2(v)), r2(base - entered()));
        disc.value = discount ? money(discount) : '';
        paint();
      };
      disc.addEventListener('input', () => { const v = parseNum(disc.value); discount = Number.isFinite(v) ? Math.min(Math.max(0, v), base) : 0; amount.value = money(remaining()); });
      let target = amount;
      amount.addEventListener('focus', () => { target = amount; });
      disc.addEventListener('focus', () => { target = disc; });
      const pad = numpad({ get value() { return target.value; }, set value(v) { target.value = v; }, dispatchEvent: (e) => target.dispatchEvent(e), addEventListener() {} });
      const add = (method, label) => run(async () => {
        const v = parseNum(amount.value);
        if (!Number.isFinite(v)) throw new Error('Tutar numerik değil');
        if (v <= 0) throw new Error('Hata\nödeme yapılacak tutar yanlış');
        if (v > remaining() + 0.001) throw new Error('Hata\nÖdeme yapılacak tutar adisyon tutarından büyük!');
        if (method === 3) {
          const c = await pickCustomer({ withNote: true });
          if (!c) return;
          rows.push({ method, amount: r2(v), customerId: c.id, label: c.name, note: c.cariNote || '' });
        } else rows.push({ method, amount: r2(v), label });
        paint();
      });
      const saveRows = () => run(async () => {
        if (!rows.length) throw new Error('Ödeme türü seçerek tutar ekleyin.');
        const out = await api(`/sales/${s.sid}/pay`, { rows, discount });
        toast(out.closed ? 'Ödeme alındı, adisyon kapandı' : `Ön ödeme alındı: ${tl(entered())}`, 'ok');
        done(out);
      });
      paint();
      return [
        el('div', { class: 'pay-top' },
          el('div', { class: 'pay-pct' }, [10, 20, 25, 30, 50, 100].map((p) => el('button', { onclick: () => setDiscount(base * p / 100) }, `%${p}`))),
          el('label', { class: 'box disc' }, el('span', {}, 'İndirim'), disc),
          el('label', { class: 'box due' }, el('span', {}, 'Ödenecek Tutar'), amount)),
        el('div', { class: 'methods' },
          el('button', { class: 'method cash', onclick: () => add(1, 'Nakit') }, icon('cash'), 'Nakit'),
          el('button', { class: 'method cc', onclick: () => add(2, 'Kredi Kartı') }, icon('card'), 'Kredi Kartı'),
          el('button', { class: 'method closed', onclick: () => add(3) }, icon('wallet'), 'Kapalı'),
          el('button', { class: 'method pick', onclick: () => run(async () => { done(undefined); await payMulti(s); }) }, icon('list'), 'Ürün Seç.')),
        el('div', { class: 'strip' }, el('div', { class: 't' }, 'Toplam:', el('b', {}, tl(s.subtotal))), el('div', { class: 'p' }, 'Ödenen:', el('b', {}, tl(s.paid)))),
        list,
        el('div', { class: 'strip' }, el('div', { class: 'g' }, 'İşlem Toplamı:', sum)),
        pad,
        el('div', { class: 'win-foot spread' },
          el('button', { class: 'btn', onclick: () => run(async () => { const out = await api(`/sales/${s.sid}/print`, {}); if (!out.printed.some((j) => j.sent)) await receipt(out.receipt, out.printed[0]); }) }, icon('print', 'sm'), 'Yazdır'),
          el('div', { class: 'win-foot' },
            el('button', { class: 'btn sq ok', title: 'Kaydet', onclick: saveRows }, icon('check')),
            el('button', { class: 'btn sq', title: 'Vazgeç', onclick: () => done(undefined) }, icon('x')))),
      ];
    },
  });
}

/** İki liste arasında adet taşıma (Multi Ödeme ve Masa Aktarım pencerelerinin ortak parçası). */
function duo({ lines, leftTitle, rightTitle, onChange }) {
  const left = lines.map((l) => ({ id: l.id, name: l.name, unit: l.unit, quantity: r2(l.quantity - (l.paidQty || 0)) })).filter((l) => l.quantity > 0);
  const right = [];
  let selL = null;
  let selR = null;
  const leftBox = el('div', { class: 'list' });
  const rightBox = el('div', { class: 'list' });
  const moveOne = (from, to, id) => {
    const src = from.find((l) => l.id === id);
    if (!src) return;
    const q = Number.isInteger(src.quantity) ? 1 : src.quantity; // kesirli adet bütün olarak taşınır
    src.quantity = r2(src.quantity - q);
    if (src.quantity <= 0) from.splice(from.indexOf(src), 1);
    const dst = to.find((l) => l.id === id);
    if (dst) dst.quantity = r2(dst.quantity + q); else to.push({ ...src, quantity: q });
  };
  const moveAll = (from, to) => { for (const l of [...from]) while (from.includes(l)) moveOne(from, to, l.id); };
  const paint = () => {
    leftBox.replaceChildren(...rowsOf(left, (l) => { selL = l.id; paint(); }, () => selL));
    rightBox.replaceChildren(...rowsOf(right, (l) => { selR = l.id; paint(); }, () => selR));
    onChange(left, right);
  };
  const node = el('div', { class: 'duo' },
    el('div', { class: 'pane' }, el('h3', {}, leftTitle), leftBox),
    el('div', { class: 'arrows' },
      el('button', { title: 'Tümünü aktar', onclick: () => { moveAll(left, right); paint(); } }, icon('dright', 'lg')),
      el('button', { title: 'Tümünü geri al', onclick: () => { moveAll(right, left); paint(); } }, icon('dleft', 'lg')),
      el('button', { title: 'Seçileni aktar', onclick: () => { moveOne(left, right, selL ?? (left[0] && left[0].id)); paint(); } }, icon('right', 'lg')),
      el('button', { title: 'Seçileni geri al', onclick: () => { moveOne(right, left, selR ?? (right[0] && right[0].id)); paint(); } }, icon('left', 'lg'))),
    el('div', { class: 'pane' }, el('h3', {}, rightTitle), rightBox));
  return { node, left, right, paint };
}
const total = (list) => r2(list.reduce((a, l) => a + l.unit * l.quantity, 0));

/** PAYMENT_MULTI — "Multi Ödeme": seçilen ürünlerin ödemesi alınır. */
export function payMulti(s0) {
  return dialog({
    title: 'NetCHIEF Smart - Multi Ödeme', cls: 'lg',
    build: (done) => {
      let s = s0;
      const tt = el('b', {});
      const due = el('b', {});
      const host = el('div', {});
      let d;
      const mount = () => {
        d = duo({ lines: s.lines.filter((l) => !l.gift), leftTitle: 'Adisyon', rightTitle: 'Ödenecek', onChange: (l, r) => { tt.textContent = money(total(l)); due.textContent = money(total(r)); } });
        host.replaceChildren(d.node);
        d.paint();
      };
      const pay = (method, label) => run(async () => {
        if (!d.right.length) throw new Error('Lütfen ödeme için ürün seçiniz.');
        const out = await api(`/sales/${s.sid}/paymulti`, { method, items: d.right.map((l) => ({ id: l.id, quantity: l.quantity })) });
        toast(`Ödeme Alındı: ${label} - ${money(out.amount)}`, 'ok');
        if (out.closed) return done(out);
        s = out.sale;
        mount();
      });
      mount();
      return [host,
        el('div', { class: 'strip' }, el('div', { class: 't' }, 'Toplam:', tt), el('div', { class: 'p' }, 'Ödenecek:', due)),
        el('div', { class: 'win-foot' },
          el('button', { class: 'btn lg danger', onclick: () => done(undefined) }, icon('x'), 'Kapat'),
          el('button', { class: 'btn lg', onclick: () => pay(2, 'Kredi Kartı') }, icon('card'), 'Kredi Kartı'),
          el('button', { class: 'btn lg', onclick: () => pay(1, 'Nakit') }, icon('cash'), 'Nakit'))];
    },
  });
}

/** TRANSFER — "Masa Aktarım": hesabın tamamı ya da seçilen ürünler başka masaya taşınır. */
export function transfer(s, fields) {
  return dialog({
    title: 'NetCHIEF Smart - Masa Aktarım', cls: 'lg',
    build: (done) => {
      let field = fields.find((f) => f.id === s.fieldId) || fields.find((f) => !f.special);
      let tableNo = 0;
      const picker = el('div', { class: 'picker' });
      const target = el('h3', {}, 'Yeni Masa');
      const d = duo({ lines: s.lines, leftTitle: `Eski Masa / ${s.tableName}`, rightTitle: 'Yeni Masa', onChange: () => {} });
      const loadGrid = () => run(async () => {
        const tables = await api(`/tables?field=${field.id}`);
        picker.replaceChildren(...tables.map((t) => el('button', {
          class: `${t.sid ? 'open' : ''} ${t.no === tableNo ? 'on' : ''}`, disabled: field.id === s.fieldId && t.no === s.tableId,
          onclick: () => { tableNo = t.no; target.textContent = `Yeni Masa / ${field.name}-${t.no}`; loadGrid(); },
        }, t.paket ? '•' : t.no)));
      });
      const chips = el('div', { class: 'chips' });
      const paintChips = () => chips.replaceChildren(...fields.filter((f) => !f.special).map((f) => el('button', {
        class: `chip ${f === field ? 'on' : ''}`, onclick: () => { field = f; tableNo = 0; target.textContent = 'Yeni Masa'; paintChips(); loadGrid(); },
      }, f.name)));
      const go = () => run(async () => {
        if (!tableNo) throw new Error('Aktarım yapılacak masa seçilmedi !');
        if (!d.right.length) throw new Error('Aktarılacak ürünleri "Yeni Masa" listesine alın.');
        const body = { fieldId: field.id, tableId: tableNo, items: d.left.length ? d.right.map((l) => ({ id: l.id, quantity: l.quantity })) : null };
        let out = await api(`/sales/${s.sid}/transfer`, body);
        if (out.needConfirm) {
          if (!(await confirmBox('Aktarım yapılacak masada hesap var !\nHesaplar birleştirilsin mi ?', { yes: 'Hesapları birleştir', no: 'İptal' }))) return;
          out = await api(`/sales/${s.sid}/transfer`, { ...body, merge: true });
        }
        toast('Aktarım tamamlandı', 'ok');
        done(out);
      });
      d.node.querySelectorAll('.pane')[1].firstChild.replaceWith(target);
      paintChips();
      loadGrid();
      d.paint();
      return [chips, picker, d.node, okCancel(done, go)];
    },
  });
}

/** DISCOUNTF — "İndirim" */
export function discount(s) {
  return dialog({
    title: 'NetCHIEF Smart - İndirim', cls: 'sm',
    build: (done) => {
      const due = r2(s.subtotal - s.paid);
      const amount = el('input', { class: 'inp big num', inputMode: 'none', value: s.discount ? money(s.discount) : '', autofocus: true });
      const tag = el('input', { class: 'inp', value: s.discountTag, maxLength: 100 });
      const set = (v, t) => { amount.value = money(v); if (t) tag.value = t; };
      const go = () => run(async () => {
        const v = parseNum(amount.value || '0');
        if (!Number.isFinite(v) || v < 0 || v >= due) throw new Error('İndirim yapılacak tutar yanlış!');
        done(await api(`/sales/${s.sid}/discount`, { amount: v, tag: tag.value }));
      });
      return [
        el('label', { class: 'lbl' }, 'İndirim Yapılacak Tutar:'), amount,
        el('label', { class: 'lbl' }, 'Açıklama'), tag,
        el('div', { class: 'pct' },
          [10, 15, 20, 25].map((p) => el('button', { onclick: () => set(due * p / 100, `%${p}`) }, `%${p}`)),
          [10, 15, 25, 50].map((a) => el('button', { class: 'amt', onclick: () => set(a) }, `${a}₺`))),
        numpad(amount, { onEnter: go }),
        el('div', { class: 'win-foot spread' },
          el('button', { class: 'btn', onclick: () => { amount.value = '0'; go(); } }, 'İndirimi Kaldır'),
          okCancel(done, go)),
      ];
    },
  });
}

/** DELCOMMENT — "Satış İptal": iptal sebebi */
export function cancelReason(reasons) {
  return dialog({
    title: 'NetCHIEF Smart - Satış İptal', cls: 'sm',
    build: (done) => {
      const text = el('textarea', { class: 'inp', maxLength: 100, autofocus: true });
      const go = () => { if (text.value.trim()) done(text.value.trim()); else toast('Lütfen iptal için açıklama giriniz', 'err'); };
      return [el('p', { class: 'msg' }, 'Lütfen iptal için açıklama giriniz'),
        el('div', { class: 'tags' }, reasons.map((r) => el('button', { class: 'tag', onclick: () => { text.value = r; } }, r))),
        text, okCancel(done, go)];
    },
  });
}

/** ACIKLAMA — "Açıklama": hazır açıklama düğmeleri + serbest metin */
export function aciklama(notes, value = '') {
  return dialog({
    title: 'NetCHIEF Smart - Açıklama', cls: '',
    build: (done) => {
      const text = el('textarea', { class: 'inp', maxLength: 200, value });
      const add = (n) => { text.value = text.value.trim() ? `${text.value.trim()}, ${n}` : n; };
      return [el('div', { class: 'tags' }, notes.map((n) => el('button', { class: 'tag', onclick: () => add(n) }, n))),
        el('p', { class: 'msg' }, 'Lütfen açıklama giriniz'), text,
        el('div', { class: 'win-foot spread' }, el('button', { class: 'btn', onclick: () => { text.value = ''; } }, 'Temizle'), okCancel(done, () => done(text.value.trim())))];
    },
  });
}

/** ACIK_SAAT — "SAAT": siparişin teslim saati (alarm) */
export function saat(value) {
  return dialog({
    title: 'NetCHIEF Smart - SAAT', cls: 'sm',
    build: (done) => {
      const now = new Date();
      let [h, m] = value ? value.split(':').map(Number) : now.getHours() < 12 ? [12, 30] : [17, 30];
      const out = el('div', { class: 'box due' }, el('span', {}, 'SİPARİŞİN TESLİM SAATİ'), el('b', {}));
      const paint = () => { out.lastChild.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
      const btn = (label, fn) => el('button', { class: 'btn lg', onclick: () => { fn(); paint(); } }, label);
      paint();
      return [out,
        el('div', { class: 'pct' },
          btn('Saat +', () => { h = (h + 1) % 24; }), btn('Saat −', () => { h = (h + 23) % 24; }),
          btn('Dk. +10', () => { m = (m + 10) % 60; }), btn('Dk. −10', () => { m = (m + 50) % 60; })),
        el('div', { class: 'win-foot spread' },
          el('button', { class: 'btn', onclick: () => done('') }, 'Saati Kaldır'),
          okCancel(done, () => done(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)))];
    },
  });
}

/** ACIK_ALARM — "ALARM": teslim saati verilmiş açık siparişler */
export function alarms(tables) {
  const rows = tables.filter((t) => t.alert).sort((a, b) => a.alert.localeCompare(b.alert));
  return dialog({
    title: 'NetCHIEF Smart - ALARM', cls: 'md',
    build: (done) => [el('div', { class: 'lv' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Saat'), el('th', {}, 'Masa'), el('th', { class: 'r' }, 'Tutar'))),
      el('tbody', {}, rows.length ? rows.map((t) => el('tr', {}, el('td', {}, t.alert), el('td', {}, t.paket || t.no), el('td', { class: 'r' }, tl(t.total))))
        : el('tr', {}, el('td', { colSpan: 3, class: 'c' }, 'Bu bölümde saatli sipariş yok'))))),
    el('div', { class: 'win-foot' }, el('button', { class: 'btn lg', onclick: () => done() }, 'KAPAT'))],
  });
}

/** JOKER — "Joker Ürün": serbest açıklama, miktar ve tutar */
export function joker() {
  return dialog({
    title: 'NetCHIEF Smart - Joker Ürün', cls: 'sm',
    build: (done) => {
      const name = el('input', { class: 'inp', maxLength: 60, autofocus: true });
      const q = el('input', { class: 'inp num', value: '1', inputMode: 'numeric' });
      const price = el('input', { class: 'inp big num', inputMode: 'none' });
      const go = () => {
        const p = parseNum(price.value);
        const n = Math.trunc(parseNum(q.value));
        if (!name.value.trim()) return toast('Lütfen açıklama giriniz.', 'err');
        if (!(p > 0) || !(n > 0)) return toast('Tutar alanı geçersiz.', 'err');
        done({ name: name.value.trim(), price: p, quantity: n });
      };
      return [el('label', { class: 'lbl' }, 'Açıklama'), name, el('label', { class: 'lbl' }, 'Miktar'), q, el('label', { class: 'lbl' }, 'Tutar'), price, numpad(price, { onEnter: go }), okCancel(done, go)];
    },
  });
}

/** SALESDETAILS — satış numarasıyla adisyon görüntüleme (BUL) */
export function salesDetails(s) {
  return dialog({
    title: `Satış No. ${s.sid} — ${s.tableName}`, cls: 'md',
    build: (done) => [
      el('div', { class: 'strip' }, el('div', { class: 't' }, 'Satış Tarihi:', el('b', {}, trDateTime(s.openDate))),
        el('div', { class: 'p' }, 'Satış Tutarı:', el('b', {}, tl(r2(s.subtotal - s.discount))))),
      el('div', { class: 'lv' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Kullanıcı'), el('th', {}, 'Açıklama'), el('th', { class: 'r' }, 'Adet'), el('th', { class: 'r' }, 'B.Fiyat'), el('th', { class: 'r' }, 'Toplam'))),
        el('tbody', {}, s.lines.map((l) => el('tr', {}, el('td', {}, l.user), el('td', {}, l.name), el('td', { class: 'r' }, qty(l.quantity)), el('td', { class: 'r' }, money(l.unit)), el('td', { class: 'r' }, money(l.total))))))),
      s.payments.length ? el('p', { class: 'hint' }, `Ödemeler: ${s.payments.map((p) => `${p.type || p.label} ${money(p.amount)}`).join(' · ')}`) : null,
      el('div', { class: 'win-foot' },
        el('button', { class: 'btn', onclick: () => run(async () => { const out = await api(`/sales/${s.sid}/print`, {}); if (!out.printed.some((j) => j.sent)) await receipt(out.receipt, out.printed[0]); }) }, icon('print', 'sm'), 'Yazdır'),
        el('button', { class: 'btn', onclick: () => done() }, 'Kapat'))],
  });
}

/** Fiş önizleme: yazıcı tanımlı değilken (ya da hata verdiğinde) tarayıcıdan yazdırılabilir. */
export function receipt(lines, job) {
  return dialog({
    title: job && job.error ? `Yazıcı hatası (${job.printer}): ${job.error}` : `Fiş önizleme${job ? ` — ${job.printer}` : ''}`, cls: 'sm',
    build: (done) => [el('pre', { class: 'receipt' }, lines.join('\n')),
      el('div', { class: 'win-foot' }, el('button', { class: 'btn', onclick: () => window.print() }, icon('print', 'sm'), 'Yazdır'), el('button', { class: 'btn', onclick: () => done() }, 'Kapat'))],
  });
}

/**
 * CUSTOMERS / PAKETSERVIS — müşteri arama, yeni kayıt, düzenleme ve seçim.
 * packet: paket servis müşterisi (boş seçim = isimsiz paket → null); withNote: "Cari İşlem Açıklaması" alanı.
 */
export function pickCustomer({ packet = false, withNote = false } = {}) {
  return dialog({
    title: packet ? 'NetCHIEF / Paket Servis' : 'NetCHIEF Smart - Müşteriler', cls: 'lg',
    build: (done) => {
      let tab = 'ara';
      let list = [];
      let selected = null;
      let editing = null;
      const body = el('div', { class: 'col' });
      const name = el('input', { class: 'inp soft', autofocus: true });
      const phone = el('input', { class: 'inp soft', inputMode: 'tel' });
      const cariNote = el('input', { class: 'inp soft', maxLength: 100 });
      const table = el('div', { class: 'lv' });
      const search = (all) => run(async () => {
        const q = new URLSearchParams(all ? {} : { name: name.value, phone: phone.value });
        list = await api(`/customers?${q}`);
        selected = list.length === 1 ? list[0] : null;
        paintList();
      });
      const paintList = () => table.replaceChildren(el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Müş. No.'), el('th', {}, 'Ünvanı'), el('th', {}, 'Telefon'), el('th', { class: 'r' }, 'Bakiye'))),
        el('tbody', {}, list.map((c) => el('tr', { class: c === selected ? 'sel' : '', onclick: () => { selected = c; paintList(); }, ondblclick: () => choose() },
          el('td', {}, c.id), el('td', {}, c.name), el('td', {}, c.phone), el('td', { class: 'r' }, money(c.balance)))))));
      const choose = () => {
        if (selected) return done({ ...selected, cariNote: cariNote.value.trim() });
        if (packet) return done(null);
        toast('Lütfen listeden Müşteri seçiniz.', 'err');
      };
      const f = { name: el('input', { class: 'inp' }), phone: el('input', { class: 'inp', inputMode: 'tel', placeholder: 'örn. 0212 3150000' }), address: el('textarea', { class: 'inp' }), note: el('textarea', { class: 'inp' }) };
      const saveForm = () => run(async () => {
        const c = await api(editing ? `/customers/${editing.id}` : '/customers', { name: f.name.value, phone: f.phone.value, address: f.address.value, note: f.note.value });
        toast('Müşteri bilgileri kaydedildi.', 'ok');
        list = [c];
        selected = c;
        show('ara');
      });
      const openForm = (c) => {
        editing = c;
        f.name.value = c ? c.name : name.value;
        f.phone.value = c ? c.phone : phone.value;
        f.address.value = c ? c.address : '';
        f.note.value = c ? c.note : '';
        show('form');
      };
      const tabs = el('div', { class: 'wtabs' });
      function show(t) {
        tab = t;
        tabs.replaceChildren(
          el('button', { class: `wtab ${tab === 'ara' ? 'on' : ''}`, onclick: () => show('ara') }, 'Müşteri Ara'),
          el('button', { class: `wtab ${tab === 'form' ? 'on' : ''}`, onclick: () => openForm(null) }, editing && tab === 'form' ? 'Düzenle' : 'Yeni Kayıt'));
        if (tab === 'ara') {
          paintList();
          body.replaceChildren(
            el('div', { class: 'frow', style: null }, el('div', { class: 'tools' },
              el('label', { class: 'grow' }, el('span', { class: 'lbl' }, 'Ünvanı'), name),
              el('label', { class: 'grow' }, el('span', { class: 'lbl' }, 'Telefon'), phone))),
            el('div', { class: 'tools' },
              el('button', { class: 'btn', onclick: () => search(false) }, icon('search', 'sm'), 'Ara'),
              el('button', { class: 'btn', onclick: () => search(true) }, icon('list', 'sm'), 'Tümü'),
              withNote ? el('label', { class: 'grow' }, cariNote) : el('span', { class: 'grow' })),
            table,
            el('div', { class: 'win-foot spread' },
              el('div', { class: 'win-foot' },
                el('button', { class: 'btn', title: 'Yeni kayıt', onclick: () => openForm(null) }, icon('plus', 'sm')),
                el('button', { class: 'btn', title: 'Düzenle', onclick: () => (selected ? openForm(selected) : toast('Lütfen listeden Müşteri seçiniz.', 'err')) }, icon('edit', 'sm')),
                el('button', { class: 'btn', title: 'Sil', onclick: () => run(async () => {
                  if (!selected || !(await confirmBox('Seçilen müşteri kayıtları siliniyor emin misiniz ?', { danger: true }))) return;
                  await api(`/customers/${selected.id}/delete`, {});
                  search(false);
                }) }, icon('trash', 'sm'))),
              okCancel(done, choose)));
          if (withNote) cariNote.placeholder = 'Cari İşlem Açıklaması';
          name.onkeydown = phone.onkeydown = (e) => { if (e.key === 'Enter') search(false); };
        } else {
          body.replaceChildren(
            el('label', { class: 'lbl' }, 'Adı Soyadı / Ünvanı'), f.name, el('label', { class: 'lbl' }, 'Telefon'), f.phone,
            el('label', { class: 'lbl' }, 'Adres'), f.address, el('label', { class: 'lbl' }, 'Açıklama'), f.note,
            okCancel(() => show('ara'), saveForm));
        }
      }
      show('ara');
      return [tabs, body];
    },
  });
}
