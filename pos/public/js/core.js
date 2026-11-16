/* NetCHIEF Smart POS — ortak yardımcılar: DOM, biçimlendirme, API, pencere (dialog), tuş takımı. Bağımlılık yok. */

export function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'data') Object.assign(n.dataset, v);
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

const ICONS = {
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 5l8 12H4z" fill="currentColor"/>',
  down: '<path d="M12 19L4 7h16z" fill="currentColor"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 19c.6-3.4 3.2-5.2 6.5-5.2s5.900 1.800 6.500 5.200"/><circle cx="17" cy="9" r="2.500"/><path d="M17.500 13.600c2.200.3 3.700 1.800 4.100 4.400"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.500-1.900"/>',
  note: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  search: '<circle cx="11" cy="11" r="6.500"/><path d="M16 16l4.500 4.500"/>',
  print: '<path d="M7 9V4h10v5M7 17H4v-7h16v7h-3"/><rect x="7" y="14" width="10" height="6"/>',
  cash: '<rect x="2.500" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.800"/><path d="M6 9.500v5M18 9.500v5"/>',
  card: '<rect x="2.500" y="5" width="19" height="14" rx="2.500"/><path d="M2.500 10h19M6 15h4"/>',
  wallet: '<path d="M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10"/><path d="M15.500 13.500h2"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h1M4 12h1M4 18h1"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.500 6.500l4 4"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  move: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  percent: '<path d="M19 5L5 19"/><circle cx="7.500" cy="7.500" r="2.500"/><circle cx="16.500" cy="16.500" r="2.500"/>',
  clock: '<circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/>',
  bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l1.500 2h-15z"/><path d="M10 21h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.600 5.600l2.100 2.100M16.300 16.300l2.100 2.100M5.600 18.400l2.100-2.100M16.300 7.700l2.100-2.100"/>',
  drawer: '<rect x="3" y="10" width="18" height="9" rx="1.500"/><path d="M6 10V6h12v4M10 14.500h4"/>',
  gift: '<rect x="4" y="10" width="16" height="10" rx="1"/><path d="M3 7h18v3H3zM12 7v13M12 7c-1-3-5-3-5-1s3 1 5 1zm0 0c1-3 5-3 5-1s-3 1-5 1z"/>',
  left: '<path d="M14.500 5l-7 7 7 7"/>',
  right: '<path d="M9.500 5l7 7-7 7"/>',
  dleft: '<path d="M12 5l-7 7 7 7M19 5l-7 7 7 7"/>',
  dright: '<path d="M5 5l7 7-7 7M12 5l7 7-7 7"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
  phone: '<path d="M6 3h4l1.500 5-2.500 1.500a12 12 0 0 0 5.500 5.500L16 12.500l5 1.500v4c0 1.500-1.500 3-3.500 2.500C9.500 19 5 14.500 3.500 6.500 3 4.500 4.500 3 6 3z"/>',
  calendar: '<rect x="3.500" y="5" width="17" height="15" rx="2"/><path d="M3.500 10h17M8 3v4M16 3v4"/>',
  logout: '<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  box: '<path d="M3.500 8L12 4l8.500 4v8L12 20l-8.500-4z"/><path d="M3.500 8L12 12l8.500-4M12 12v8"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l9-8M16 6.500l3 3"/>',
  sitemap: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>',
  backspace: '<path d="M9 5h11v14H9l-6-7z"/><path d="M12 9.500l5 5M17 9.500l-5 5"/>',
};
export function icon(name, cls = '') {
  const s = el('span', { class: `ic ${cls}`, 'aria-hidden': 'true' });
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return s;
}

const money2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (n) => money2.format(n || 0);
export const tl = (n) => `${money2.format(n || 0)} TL`;
export const qty = (n) => Number(n || 0).toLocaleString('tr-TR', { maximumFractionDigits: 3 });
export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
/** "12,50" / "12.50" → 12.5 */
export const parseNum = (s) => {
  const n = Number(String(s ?? '').trim().replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
export const trDateTime = (stamp) => (stamp ? `${stamp.slice(8, 10)}.${stamp.slice(5, 7)}.${stamp.slice(0, 4)} - ${stamp.slice(11, 16)}` : '');
export const span = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;
export const minutesSince = (stamp) => (stamp ? Math.max(0, (Date.now() - new Date(stamp.replace(' ', 'T'))) / 60000) : 0);
export const isoDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- Bildirim ----------
let toastTimer;
export function toast(message, kind = '') {
  let t = document.getElementById('toast');
  if (!t) { t = el('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = message;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, kind === 'err' ? 4200 : 2200);
}

// ---------- API ----------
export class Cancelled extends Error {}
let onUnauthorized = () => {};
let approvers = [];
export const setAuthHooks = (unauth, managers) => { onUnauthorized = unauth; approvers = managers; };

export async function api(path, body, approver) {
  const opts = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(approver ? { ...body, approver } : body),
  };
  let res;
  try { res = await fetch(`/api${path}`, opts); } catch { throw new Error('Sunucuya ulaşılamıyor.'); }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  if (res.status === 401 && path !== '/login') { onUnauthorized(); throw new Cancelled(); }
  if (res.status === 403 && data.needApproval) {
    // Yetkili Girişi: garson yetkisi yetmeyen işlemde bir yetkili şifresini girer
    const ap = await askApproval(approver ? data.error : '');
    if (!ap) throw new Cancelled();
    return api(path, body, ap);
  }
  throw new Error(data.error || 'İşlem başarısız.');
}
/** Hata gösteren sarmalayıcı: vazgeçmeler sessiz geçer. */
export async function run(fn) {
  try { return await fn(); } catch (e) {
    if (!(e instanceof Cancelled)) toast(e.message, 'err');
    return undefined;
  }
}

// ---------- Pencere ----------
/**
 * Orijinal programdaki küçük pencerelerin karşılığı. body: düğüm(ler); done(value) pencereyi kapatıp değeri döndürür.
 * Esc / dışarı tıklama = vazgeç (undefined).
 */
export function dialog({ title, cls = '', build }) {
  return new Promise((resolve) => {
    const d = el('dialog', { class: `win ${cls}` });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      d.close();
      d.remove();
      resolve(value);
    };
    d.append(el('header', { class: 'win-head' }, el('h2', {}, title), el('button', { class: 'win-x', title: 'Kapat', onclick: () => done(undefined) }, icon('x'))));
    const body = el('div', { class: 'win-body' });
    d.append(body);
    body.append(...[build(done, d)].flat());
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(undefined); });
    d.addEventListener('mousedown', (e) => { if (e.target === d) done(undefined); });
    document.body.append(d);
    d.showModal();
    const first = d.querySelector('[autofocus]');
    if (first) first.focus();
  });
}
/** Onay / vazgeç düğme çifti (orijinaldeki X ve ✓). */
export const okCancel = (done, onOk, okLabel) => el('div', { class: 'win-foot' },
  el('button', { class: 'btn sq', title: 'Vazgeç', onclick: () => done(undefined) }, icon('x')),
  el('button', { class: 'btn sq ok', title: 'Tamam', onclick: onOk }, icon('check'), okLabel));

export function confirmBox(message, { yes = 'Evet', no = 'Hayır', danger = false } = {}) {
  return dialog({
    title: 'NetCHIEF Smart', cls: 'sm',
    build: (done) => [
      el('p', { class: 'msg' }, message),
      el('div', { class: 'win-foot' },
        el('button', { class: 'btn', onclick: () => done(false) }, no),
        el('button', { class: `btn ${danger ? 'danger' : 'ok'}`, autofocus: true, onclick: () => done(true) }, yes)),
    ],
  }).then((v) => v === true);
}

/** Dokunmatik tuş takımı: hedef input'a yazar. */
export function numpad(input, { decimal = true, onEnter } = {}) {
  const press = (k) => {
    if (k === 'del') input.value = input.value.slice(0, -1);
    else if (k === 'clr') input.value = '';
    else if (k === ',' && (!decimal || input.value.includes(','))) return;
    else input.value += k;
    input.dispatchEvent(new Event('input'));
  };
  const key = (k, label = k, cls = '') => el('button', { type: 'button', class: `key ${cls}`, onclick: () => press(k) }, label);
  if (onEnter) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') onEnter(); });
  return el('div', { class: 'numpad' },
    ...'789456123'.split('').map((k) => key(k)),
    decimal ? key(',') : key('clr', 'C', 'soft'), key('0'), key('del', icon('backspace'), 'soft'));
}

/** Yetkili Girişi penceresi → { userId, password } */
function askApproval(error) {
  return dialog({
    title: 'Yetkili Girişi', cls: 'approve',
    build: (done) => {
      let selected = approvers[0];
      const pass = el('input', { type: 'password', class: 'inp big', autocomplete: 'off', autofocus: true, inputMode: 'none' });
      const submit = () => { if (selected && pass.value) done({ userId: selected.id, password: pass.value }); };
      const list = el('div', { class: 'userlist' });
      const paint = () => list.replaceChildren(...approvers.map((u) => el('button', {
        class: `userrow ${u === selected ? 'on' : ''}`, onclick: () => { selected = u; paint(); pass.focus(); },
      }, u.name)));
      paint();
      return [
        el('p', { class: 'msg' }, error || 'Bu işlem için yetkili şifresi gerekir.'),
        el('div', { class: 'approve-grid' }, list, el('div', {}, el('label', { class: 'lbl' }, 'Şifre'), pass, numpad(pass, { decimal: false, onEnter: submit }))),
        okCancel(done, submit),
      ];
    },
  });
}

/** Tutar / sayı sorma penceresi. */
export function askNumber({ title, label, value = '', decimal = true, hint }) {
  return dialog({
    title, cls: 'sm',
    build: (done) => {
      const inp = el('input', { class: 'inp big num', value, autofocus: true, inputMode: 'none' });
      const submit = () => { const n = parseNum(inp.value); if (Number.isFinite(n)) done(n); };
      return [el('label', { class: 'lbl' }, label), inp, hint && el('p', { class: 'hint' }, hint), numpad(inp, { decimal, onEnter: submit }), okCancel(done, submit)];
    },
  });
}
