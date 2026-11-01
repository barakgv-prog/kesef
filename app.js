'use strict';
// "הכסף שלי" — אפליקציית דפדפן. כל החישובים וההרשאות נעשים בשרת (Supabase);
// הקוד כאן רק מציג ושולח בקשות.

const CFG = window.KESEF_CONFIG || {};
const TZ = 'Asia/Jerusalem';
const configured = CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes('YOUR-PROJECT');
const sb = configured ? supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY,
  { auth: { persistSession: true, storageKey: 'kesef-auth' } }) : null;

const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $dlg = document.getElementById('dlg');

let S = null;                 // מצב מהשרת (get_state)
let view = { tab: null, childId: null };
let filters = { histType: 'all', feedChild: '', feedMonth: '', feedKind: '', compMonth: '' };
let channel = null, pollTimer = null, loading = false;

// ------------------------------------------------------------ helpers
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => crypto.randomUUID();
const fmtNum = c => { const a = Math.abs(c) / 100; return (c < 0 ? '−' : '') + (Number.isInteger(a) ? String(a) : a.toFixed(2)); };
const money = c => `<span class="m">${fmtNum(c || 0)} ₪</span>`;
const moneyTxt = c => `${fmtNum(c || 0)} ₪`;
function parseMoney(s) {
  s = String(s || '').trim().replace(',', '.').replace('₪', '').trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [a, b = ''] = s.split('.');
  const c = Number(a) * 100 + Number((b + '00').slice(0, 2));
  return c > 0 ? c : null;
}
const todayJ = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const fmtDate = d => { if (!d) return ''; const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${+dd}.${+m}.${y}`; };
const fmtDT = t => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date(t));
const monthName = ym => { const [y, m] = ym.split('-'); return new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(+y, +m - 1, 15))); };
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const KIND = { job: '🏠 עבודה בבית', external_job: '🧰 עבודה בחוץ', gift: '🎁 מתנה', allowance: '🪙 דמי כיס', other: '✨ אחר', bonus: '⭐ בונוס' };
const METHOD = { cash: 'מזומן', bit: 'ביט / אפליקציה', transfer: 'העברה', other: 'אחר' };
const JOB = {
  todo: ['🔵', 'לביצוע', 'c-todo'], pending: ['⏳', 'ממתין לאישור', 'c-pending'], approved: ['✅', 'אושר', 'c-approved'],
  needs_fix: ['🔧', 'נדרש תיקון', 'c-fix'], cancelled: ['✖️', 'בוטל', 'c-cancel']
};
const chip = (cls, txt) => `<span class="chip ${cls}">${txt}</span>`;
const jobChip = s => chip(JOB[s][2], `${JOB[s][0]} ${JOB[s][1]}`);
function payChip(i) {
  if (i.status !== 'active') return '';
  if (i.paid_cents >= i.amount_cents) return chip('c-paid', '✔ שולם');
  if (i.paid_cents > 0) return chip('c-partial', '◐ שולם חלקית');
  return chip('c-unpaid', '○ לא שולם');
}
const isParent = () => S && S.me.role === 'parent';
const mem = id => S.members.find(m => m.id === id);
const nameOf = id => esc(mem(id)?.display_name || '?');
const g = (m, f, ms) => (m && m.gender === 'm') ? ms : f;
const kids = () => S.members.filter(m => m.role === 'child' && m.active);
const parents = () => S.members.filter(m => m.role === 'parent' && m.active);
const payerName = o => o.payer_member_id ? nameOf(o.payer_member_id) : esc(o.payer_name || '');
const avatar = m => m.role === 'parent' ? (m.gender === 'm' ? '🧔' : '👩') : (m.gender === 'm' ? '👦' : '👧');

function errText(e) {
  if (!e) return 'שגיאה';
  if (e.message && /fetch|network|Failed/i.test(e.message) && !e.hint) return 'אין חיבור לשרת. בדקו אינטרנט ונסו שוב.';
  if (e.message === 'Invalid login credentials') return 'שם המשתמש או הסיסמה לא נכונים';
  return e.message || String(e);
}
async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args || {});
  if (error) throw error;
  return data;
}

// ----------------------------------------------------------- startup
async function start() {
  if (!configured) {
    $app.innerHTML = `<div class="wrap"><h1>🐷 הכסף שלי</h1><div class="banner b-warn">האתר עוד לא חובר למסד הנתונים.
      יש למלא את הקובץ <b>config.js</b> בכתובת ובמפתח של פרויקט Supabase.</div></div>`;
    return;
  }
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') { S = null; stopLive(); renderLogin(); } });
  const { data } = await sb.auth.getSession();
  if (!data.session) return renderLogin();
  await boot();
}

async function boot() {
  seen = null;
  try {
    const w = await rpc('whoami');
    if (!w.member) return w.family_exists ? renderNotLinked() : renderSetup();
    await load();
    rememberProfile();
    startLive();
  } catch (e) {
    $app.innerHTML = `<div class="wrap"><div class="banner b-err">${esc(errText(e))}</div>
      <button class="btn" data-act="reload">נסו שוב</button> <button class="btn ghost" data-act="logout">יציאה</button></div>`;
  }
}

// טעינה מהשרת. אם טעינה כבר רצה (למשל מעדכון חי), מריצים עוד אחת מיד אחריה כדי שהמסך לא יישאר ישן.
let reloadAgain = false, quietNext = false;
async function load() {
  if (loading) { reloadAgain = true; return; }
  loading = true;
  try {
    do {
      reloadAgain = false;
      S = await rpc('get_state');
      if (!view.tab) view.tab = 'home';
      render();
      announce();
    } while (reloadAgain);
  } finally { loading = false; }
}
// אחרי פעולה של המשתמש עצמו: מרעננים בלי להכריז על השינוי שהוא עצמו עשה
const loadQuiet = () => { quietNext = true; return load(); };

// ---------------------------------------------- עדכונים חיים: ענן קטן וצליל שמח
// משווים את המצב החדש למה שהמכשיר כבר ראה (נשמר במכשיר), ומודיעים במשפט קצר על שינויים של אחרים.
let seen = null;
const seenKey = () => 'kesef-seen-' + S.me.id;
function stateKeys() {
  const k = [];
  S.instances.forEach(i => k.push(`i:${i.id}:${i.status}`));
  S.receipts.forEach(r => k.push(`r:${r.id}:${r.status}:${r.child_ack}`));
  S.incomes.forEach(i => k.push(`n:${i.id}:${i.status}`));
  S.expenses.forEach(e => k.push(`e:${e.id}:${e.status}`));
  S.templates.forEach(t => t.assignees.forEach(a => k.push(`a:${t.id}:${a.child_id}:${a.approved ? 1 : 0}`)));
  if (!isParent()) S.feed.forEach(f => { if (f.child_id !== S.me.id) k.push(`f:${f.id}`); });
  return k;
}
function announce() {
  const keys = stateKeys(), quiet = quietNext;
  quietNext = false;
  let prev = seen;
  if (!prev) { try { const s = localStorage.getItem(seenKey()); prev = s ? new Set(JSON.parse(s)) : null; } catch { prev = null; } }
  seen = new Set(keys);
  try { localStorage.setItem(seenKey(), JSON.stringify(keys)); } catch { }
  if (!prev || quiet) return;              // פעם ראשונה במכשיר, או שינוי שהמשתמש עצמו עשה
  const msgs = [...new Set(keys.filter(x => !prev.has(x)).map(eventMsg).filter(Boolean))];
  if (msgs.length > 3) { const more = msgs.length - 2; msgs.splice(2); msgs.push(`ועוד ${more} עדכונים 📬`); }
  msgs.forEach(m => toast(m));
}
// משפט קצר לכל שינוי. ילד מקבל ניסוח אישי, הורה מקבל עם שם הילד.
function eventMsg(key) {
  const [t, id, st, ack] = key.split(':');
  const P = isParent();
  const nm = o => mem(o.child_id)?.display_name || '';
  const kd = o => mem(o.child_id);
  if (t === 'i') {
    const i = S.instances.find(x => x.id === id); if (!i) return null; const k = kd(i);
    if (st === 'todo') return (i.note || '').includes('בטעות') ? null : P ? `${nm(i)}: עבודה חדשה 🧹` : 'יש לך עבודה חדשה 🧹';
    if (st === 'pending') return P ? `${nm(i)} ${g(k, 'סיימה', 'סיים')} עבודה ⏳` : null;
    if (st === 'approved') return P ? `${nm(i)}: העבודה אושרה ✔` : 'העבודה אושרה 🎉';
    if (st === 'needs_fix') return P ? null : 'צריך תיקון קטן 🔧';
    return null;
  }
  if (t === 'r') {
    const r = S.receipts.find(x => x.id === id); if (!r) return null; const k = kd(r);
    if (st === 'pending') return P ? `${nm(r)} ${g(k, 'דיווחה', 'דיווח')} שקיבל${g(k, 'ה', '')} תשלום 💰` : null;
    if (st === 'rejected') return P ? null : 'דיווח התשלום לא אושר';
    if (st !== 'active') return null;
    if (ack === 'disputed') return P ? `${nm(r)}: "לא קיבלתי" ✋` : null;
    if (ack === 'confirmed') return P ? (r.reported_by_child ? null : `${nm(r)} ${g(k, 'אישרה', 'אישר')} קבלה 🤝`) : 'התשלום אושר 💰';
    if (r.note === 'התקבל יחד עם ההכנסה') return null;     // ההכנסה עצמה כבר מוכרזת
    return P ? `${nm(r)} ${g(k, 'קיבלה', 'קיבל')} תשלום 💰` : 'התשלום התקבל 💰';
  }
  if (t === 'n') {
    const i = S.incomes.find(x => x.id === id); if (!i) return null; const k = kd(i);
    if (st === 'pending') return P ? `${nm(i)} ${g(k, 'דיווחה', 'דיווח')} על הכנסה 📝` : null;
    if (st !== 'active' || i.kind === 'job') return null;
    if (i.kind === 'bonus') return P ? `${nm(i)}: בונוס ⭐` : 'קיבלת בונוס ⭐';
    return P ? null : 'ההכנסה נרשמה 🎁';
  }
  if (t === 'e') {
    const e = S.expenses.find(x => x.id === id); if (!e) return null; const k = kd(e);
    if (st === 'pending') return P ? `${nm(e)} ${g(k, 'דיווחה', 'דיווח')} על הוצאה 🛒` : null;
    if (st === 'approved') return P ? null : 'ההוצאה נרשמה 🛒';
    return null;
  }
  if (t === 'a') {
    const k = mem(st);
    if (ack === '0') return P ? `${k?.display_name || ''} ${g(k, 'הוסיפה', 'הוסיף')} עבודה קבועה 🔁` : null;
    return P ? null : 'עבודה קבועה אושרה 🔁';
  }
  if (t === 'f') {
    const f = S.feed.find(x => x.id === id); if (!f) return null; const k = mem(f.child_id);
    const work = f.kind === 'job' || f.kind === 'external_job';
    return `${k?.display_name || ''} ${work ? g(k, 'הרוויחה', 'הרוויח') : g(k, 'קיבלה', 'קיבל')} ${moneyTxt(f.amount_cents)} 🎉`;
  }
  return null;
}

// ענן הודעה קטן: לא חוסם, נעלם לבד, נסגר בהחלקה הצידה או ב-✕. צליל שמח רק להצלחה.
const $toasts = document.createElement('div');
$toasts.className = 'toasts'; $toasts.setAttribute('aria-live', 'polite');
document.body.appendChild($toasts);
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' t-err' : ''); el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.innerHTML = '<span class="t-txt"></span><button type="button" class="t-x" aria-label="סגירה">✕</button>';
  el.querySelector('.t-txt').textContent = msg;
  $toasts.prepend(el);
  while ($toasts.children.length > 3) $toasts.lastElementChild.remove();
  let gone = false, timer = null, x0 = null, dx = 0;
  const later = ms => { clearTimeout(timer); timer = setTimeout(() => close(0), ms); };
  const close = to => {
    if (gone) return; gone = true; clearTimeout(timer);
    el.style.transition = 'transform .2s, opacity .2s'; el.style.transform = `translateX(${to}px)`; el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  };
  el.querySelector('.t-x').onclick = () => close(0);
  el.addEventListener('pointerdown', ev => {
    if (ev.target.closest('.t-x')) return;
    x0 = ev.clientX; dx = 0; clearTimeout(timer);
    try { el.setPointerCapture(ev.pointerId); } catch { }
  });
  el.addEventListener('pointermove', ev => {
    if (x0 === null) return;
    dx = ev.clientX - x0; el.style.transform = `translateX(${dx}px)`; el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 220));
  });
  const up = () => {
    if (x0 === null) return; x0 = null;
    if (Math.abs(dx) > 60) close(dx > 0 ? 420 : -420);
    else { el.style.transform = ''; el.style.opacity = ''; later(2500); }
  };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  later(kind === 'err' ? 6000 : 3500);
  if (kind === 'ok' && soundOn()) chime();
}
const toastErr = e => toast(errText(e), 'err');

const soundOn = () => { try { return localStorage.getItem('kesef-sound') !== 'off'; } catch { return true; } };
let actx = null;
function audioCtx() {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch { }
  return actx;
}
document.addEventListener('pointerdown', audioCtx, { once: true });   // דפדפנים מאפשרים צליל רק אחרי נגיעה ראשונה
let lastChime = 0;
function chime() {                                    // "דינג-דינג" קצר ועדין
  const c = audioCtx(); if (!c || c.state !== 'running' || Date.now() - lastChime < 400) return;
  lastChime = Date.now();
  const t0 = c.currentTime;
  [783.99, 1174.66].forEach((f, i) => {
    const o = c.createOscillator(), gn = c.createGain(), t = t0 + i * 0.09;
    o.type = 'sine'; o.frequency.value = f;
    gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(0.12, t + 0.015); gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(gn).connect(c.destination); o.start(t); o.stop(t + 0.3);
  });
}

function startLive() {
  stopLive();
  channel = sb.channel('family-' + S.family.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'change_log', filter: 'family_id=eq.' + S.family.id },
      () => { if (!$dlg.open) load(); })
    .subscribe();
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible' && !$dlg.open) load(); }, 30000);
}
function stopLive() { if (channel) sb.removeChannel(channel); channel = null; clearInterval(pollTimer); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S && !$dlg.open) load(); });

// ----------------------------------------------------- login & setup
const PKEY = 'kesef-profiles';
function getProfiles() { try { return JSON.parse(localStorage.getItem(PKEY) || '[]'); } catch { return []; } }
function rememberProfile() {
  try {
    sb.auth.getUser().then(({ data }) => {
      const e = data.user?.email; if (!e) return;
      const list = getProfiles().filter(p => p.email !== e);
      list.unshift({ email: e, name: S.me.display_name, role: S.me.role, gender: S.me.gender });
      localStorage.setItem(PKEY, JSON.stringify(list.slice(0, 8)));
    });
  } catch { }
}
function forgetProfile(email) { try { localStorage.setItem(PKEY, JSON.stringify(getProfiles().filter(p => p.email !== email))); } catch { } }

function renderLogin(selected) {
  $tabs.hidden = true;
  const profs = getProfiles();
  const sel = selected ? profs.find(p => p.email === selected) : null;
  $app.innerHTML = `<div class="wrap">
    <h1 class="center">🐷 הכסף שלי</h1>
    ${!sel && profs.length ? `<p class="center muted">מי נכנס?</p><div class="profiles">
      ${profs.map(p => `<button class="profile" data-act="pickProfile" data-email="${esc(p.email)}"><span class="av">${avatar(p)}</span>${esc(p.name)}</button>`).join('')}
    </div><h2>משתמש אחר</h2>` : ''}
    <form class="card" id="loginForm">
      ${sel ? `<div class="center"><span style="font-size:44px">${avatar(sel)}</span><h2 style="margin:4px 0">${esc(sel.name)}</h2></div>
        <input type="hidden" name="user" value="${esc(sel.email)}">`
      : `<label class="f" for="lu">שם משתמש</label><input class="in" id="lu" name="user" autocomplete="username" autocapitalize="off" dir="ltr" required>`}
      <label class="f" for="lp">סיסמה</label>
      <input class="in" id="lp" name="pass" type="password" autocomplete="current-password" dir="ltr" required ${sel ? 'autofocus' : ''}>
      <div id="loginErr"></div>
      <p><button class="btn big mint" type="submit">כניסה</button></p>
      ${sel ? `<div class="row between"><button type="button" class="btn ghost sm" data-act="renderLogin">← חזרה</button>
        <button type="button" class="btn ghost sm" data-act="forgetProfile" data-email="${esc(sel.email)}">הסר מהמכשיר</button></div>` : ''}
    </form>
    <p class="note center">שכחתם סיסמה? הורה יכול לאפס אותה במסך הניהול.</p></div>`;
  document.getElementById('loginForm').onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target); const btn = ev.target.querySelector('[type=submit]');
    let user = String(f.get('user')).trim().toLowerCase();
    if (!user.includes('@')) user += '@' + (CFG.LOGIN_DOMAIN || 'example.com');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: user, password: String(f.get('pass')) });
    btn.disabled = false;
    if (error) { document.getElementById('loginErr').innerHTML = `<div class="banner b-err">${esc(errText(error))}</div>`; return; }
    view = { tab: null, childId: null };
    boot();
  };
}

function renderSetup() {
  $tabs.hidden = true;
  $app.innerHTML = `<div class="wrap"><h1>👋 הגדרה ראשונה</h1>
    <div class="banner b-info">זו הכניסה הראשונה. ניצור את המשפחה ואתם תהיו ההורה המנהל.</div>
    <form class="card" id="setupForm">
      <label class="f">שם המשפחה באפליקציה</label><input class="in" name="fam" required placeholder="למשל: המשפחה שלנו">
      <label class="f">איך לקרוא לך?</label><input class="in" name="name" required placeholder="למשל: אבא">
      <label class="f">פנייה</label>
      <div class="seg"><label><input type="radio" name="gender" value="m" checked>זכר</label><label><input type="radio" name="gender" value="f">נקבה</label></div>
      <div id="setupErr"></div>
      <p><button class="btn big mint">יצירת המשפחה</button></p>
    </form><button class="btn ghost" data-act="logout">יציאה</button></div>`;
  document.getElementById('setupForm').onsubmit = async ev => {
    ev.preventDefault(); const f = new FormData(ev.target);
    try { await rpc('setup_family', { p_family_name: f.get('fam'), p_display_name: f.get('name'), p_gender: f.get('gender') }); boot(); }
    catch (e) { document.getElementById('setupErr').innerHTML = `<div class="banner b-err">${esc(errText(e))}</div>`; }
  };
}
function renderNotLinked() {
  $tabs.hidden = true;
  $app.innerHTML = `<div class="wrap"><h1>🙈 עוד לא במשפחה</h1>
    <div class="banner b-warn">המשתמש קיים, אבל עדיין לא שויך למשפחה. בקשו מהורה להוסיף אתכם במסך הניהול.</div>
    <button class="btn" data-act="logout">יציאה</button></div>`;
}

// ------------------------------------------------------------ render
const TABS_CHILD = [['home', '🏠', 'הבית'], ['jobs', '🧹', 'עבודות'], ['owed', '⏳', 'מגיע לי'], ['history', '📜', 'היסטוריה'], ['family', '👨‍👩‍👧', 'משפחה']];
const TABS_PARENT = [['home', '🏠', 'הבית'], ['approvals', '✅', 'אישורים'], ['pay', '💸', 'תשלומים'], ['jobs', '🧹', 'עבודות'], ['family', '👨‍👩‍👧', 'משפחה'], ['admin', '⚙️', 'ניהול']];

const pendingAssignments = () => S.templates.flatMap(t => t.assignees.filter(a => !a.approved).map(a => ({ t, a })));
function pendingCount() {
  if (!isParent()) return 0;
  return S.instances.filter(i => i.status === 'pending').length + S.incomes.filter(i => i.status === 'pending').length
    + S.expenses.filter(e => e.status === 'pending').length + S.receipts.filter(r => r.status === 'pending').length
    + S.receipts.filter(r => r.status === 'active' && r.child_ack === 'disputed').length + pendingAssignments().length;
}

function render() {
  const tabs = isParent() ? TABS_PARENT : TABS_CHILD;
  const pc = pendingCount();
  $tabs.hidden = false;
  $tabs.innerHTML = tabs.map(([k, ic, l]) => `<button data-act="tab" data-tab="${k}" class="${view.tab === k ? 'on' : ''}" aria-current="${view.tab === k ? 'page' : 'false'}">
    <span aria-hidden="true">${ic}</span>${l}${k === 'approvals' && pc ? `<b class="badge">${pc}</b>` : ''}</button>`).join('');
  const top = `<div class="top"><div class="who">${esc(S.family.name)}${S.family.is_test ? ' · 🧪 משפחת בדיקה' : ''}</div>
    <div class="row"><span class="who">${avatar(S.me)} ${esc(S.me.display_name)}</span>
    <button class="btn ghost sm" data-act="sound" aria-label="${soundOn() ? 'כיבוי צלילים' : 'הפעלת צלילים'}" title="צלילים">${soundOn() ? '🔔' : '🔕'}</button>
    <button class="btn ghost sm" data-act="logout">החלפת משתמש</button></div></div>`;
  let body = '';
  const t = view.tab;
  if (t === 'home') body = isParent() ? renderParentHome() : renderChildHome(S.me.id);
  else if (t === 'jobs') body = isParent() ? renderParentJobs() : renderChildJobs();
  else if (t === 'owed') body = renderOwed(S.me.id);
  else if (t === 'history') body = renderHistory(S.me.id);
  else if (t === 'family') body = renderFamily();
  else if (t === 'approvals') body = renderApprovals();
  else if (t === 'pay') body = renderPay();
  else if (t === 'admin') body = renderAdmin();
  else if (t === 'child') body = renderChildForParent(view.childId);
  $app.innerHTML = `<div class="wrap">${top}${paydayBanner()}${body}</div>`;
  bindForms();
  refreshPushCard();
}

function paydayBanner() {
  if (S.family.payday === null || S.family.payday === undefined) return '';
  const dow = new Date(S.today + 'T12:00:00Z').getUTCDay();
  if (dow !== S.family.payday) return '';
  if (isParent()) {
    const owed = kids().reduce((a, k) => a + (k.totals?.owed || 0), 0);
    return owed > 0 ? `<div class="banner b-warn">📅 היום יום תשלום! סך הכול מגיע לילדים ${money(owed)}. <button class="btn sm" data-act="tab" data-tab="pay">לתשלומים</button></div>` : '';
  }
  const me = mem(S.me.id);
  return me?.totals?.owed > 0 ? `<div class="banner b-warn">📅 היום יום תשלום במשפחה. מגיע לך ${money(me.totals.owed)}.</div>` : '';
}

// ---------------------------------------------------------- child home
function statCards(m) {
  const t = m.totals;
  return `<div class="stats">
    <div class="stat s-earn"><div class="ic" aria-hidden="true">🛠️</div><div class="lbl">${g(m, 'הרווחתי', 'הרווחתי')}</div><div class="val">${money(t.earned_work)}</div><div class="sub">מעבודה, אחרי אישור</div></div>
    <div class="stat s-owed"><div class="ic" aria-hidden="true">⏳</div><div class="lbl">מגיע לי</div><div class="val">${money(t.owed)}</div><div class="sub">אושר ועוד לא שולם</div></div>
    <div class="stat s-recv"><div class="ic" aria-hidden="true">👛</div><div class="lbl">קיבלתי</div><div class="val">${money(t.received)}</div><div class="sub">כסף שהגיע בפועל</div></div>
    <div class="stat s-left"><div class="ic" aria-hidden="true">🐷</div><div class="lbl">בקופה</div><div class="val">${money(t.balance)}</div><div class="sub">פתיחה + קיבלתי − הוצאות</div></div>
  </div>
  <p class="note">ℹ️ "בקופה" הוא סכום לפי הרישומים באפליקציה. כסף שעוד חייבים לך נמצא ב"מגיע לי" ונכנס לקופה רק כשמשלמים. האפליקציה אינה חשבון בנק ואינה מעבירה כסף.</p>`;
}

function goalCard(m, canEdit) {
  if (!m.goal_name) return canEdit ? `<div class="card row between"><div>🎯 עוד אין יעד חיסכון</div>
    <button class="btn sm" data-act="goal" data-id="${m.id}">הגדרת יעד</button></div>` : '';
  const prog = m.goal_progress, fresh = m.goal_mode === 'fresh';
  return `<div class="card"><div class="row between"><h3>🎯 ${esc(m.goal_name)}</h3>${canEdit ? `<button class="btn ghost sm" data-act="goal" data-id="${m.id}">שינוי</button>` : ''}</div>
    <div class="bar" role="progressbar" aria-valuenow="${m.goal_pct}" aria-valuemin="0" aria-valuemax="100" aria-label="התקדמות ליעד"><i style="width:${m.goal_pct}%"></i></div>
    <div class="row between small" style="margin-top:6px"><span><b>${m.goal_pct}%</b> מהיעד</span>
    <span>${prog !== undefined && prog !== null ? `${money(prog)} מתוך ` : 'יעד: '}${money(m.goal_cents)}</span></div>
    <p class="note">${fresh ? `חיסכון חדש מ-${fmtDT(m.goal_start_at)}: נספר רק מה שנכנס לקופה מאז, פחות הוצאות.`
      : 'כולל הכסף שכבר בקופה. כסף שעוד לא שולם לא נספר עד שמשלמים.'}</p></div>`;
}

function ackList(childId) {
  const rs = S.receipts.filter(r => r.child_id === childId && r.status === 'active' && r.child_ack === 'none');
  if (!rs.length || isParent()) return '';
  return `<div class="card"><h3>💌 ${rs.length === 1 ? 'נרשם תשלום אליך' : 'נרשמו תשלומים אליך'}</h3><div class="list">
    ${rs.map(r => `<div class="item"><div class="emo">💵</div><div class="grow">נרשם שקיבלת ${money(r.amount_cents)} מ${payerName(r)}
      <div class="small muted">${fmtDate(r.received_date)} · ${METHOD[r.method]}</div>
      <div class="row" style="margin-top:8px"><button class="btn sm mint" data-act="ack" data-id="${r.id}" data-st="confirmed" data-rid="${uuid()}">✔ קיבלתי</button>
      <button class="btn sm ghost" data-act="ackNo" data-id="${r.id}">✋ לא קיבלתי</button></div></div></div>`).join('')}
  </div></div>`;
}

function renderChildHome(id) {
  const m = mem(id);
  const pend = S.incomes.filter(i => i.child_id === id && i.status === 'pending').length
    + S.expenses.filter(e => e.child_id === id && e.status === 'pending').length
    + S.receipts.filter(r => r.child_id === id && r.status === 'pending').length
    + S.instances.filter(i => i.child_id === id && i.status === 'pending').length;
  return `<h1>${g(m, 'היי', 'היי')} ${esc(m.display_name)} 👋</h1>
    ${ackList(id)}
    ${statCards(m)}
    ${pend ? `<div class="banner b-info">⏳ יש ${pend} ${pend === 1 ? 'רישום שממתין' : 'רישומים שממתינים'} לאישור הורה. הם עוד לא נספרים בסכומים.</div>` : ''}
    <div class="actions">
      <button class="btn mint" data-act="tab" data-tab="jobs"><span aria-hidden="true">✅</span>סיימתי עבודה</button>
      <button class="btn sky" data-act="moneyIn" data-id="${id}"><span aria-hidden="true">💵</span>קיבלתי כסף</button>
      <button class="btn berry" data-act="expense" data-id="${id}"><span aria-hidden="true">🛒</span>הוצאתי כסף</button>
    </div>
    <h2>הוספה</h2>${addMenu()}
    <h2>הקופה שלי</h2>${piggyCard(m)}
    <h2>היעד שלי</h2>${goalCard(m, true)}
    <div id="pushCard"></div>`;
}

// דף הבית של הורה: סיכום משפחתי ולוח קטן לכל ילד
function renderParentHome() {
  const ks = kids(), pc = pendingCount();
  const sum = key => ks.reduce((a, k) => a + (k.totals?.[key] || 0), 0);
  const mini = (cls, lbl, v) => `<div class="stat ${cls}"><div class="lbl">${lbl}</div><div class="val">${money(v)}</div></div>`;
  return `<h1>🏠 ${esc(S.family.name)}</h1>
    ${pc ? `<div class="banner b-warn row between"><span>⏳ ${pc === 1 ? 'דבר אחד מחכה' : `${pc} דברים מחכים`} לאישור שלך</span>
      <button class="btn sm" data-act="tab" data-tab="approvals">לאישורים</button></div>` : '<div class="banner b-ok">🎉 אין כרגע מה לאשר.</div>'}
    <div class="stats">
      <div class="stat s-earn"><div class="ic" aria-hidden="true">🛠️</div><div class="lbl">הרוויחו מעבודה</div><div class="val">${money(sum('earned_work'))}</div><div class="sub">כל הילדים, אחרי אישור</div></div>
      <div class="stat s-owed"><div class="ic" aria-hidden="true">⏳</div><div class="lbl">מגיע לילדים</div><div class="val">${money(sum('owed'))}</div><div class="sub">אושר ועוד לא שולם</div></div>
      <div class="stat s-recv"><div class="ic" aria-hidden="true">👛</div><div class="lbl">קיבלו</div><div class="val">${money(sum('received'))}</div><div class="sub">כסף שהגיע בפועל</div></div>
      <div class="stat s-left"><div class="ic" aria-hidden="true">🐷</div><div class="lbl">בקופות</div><div class="val">${money(sum('balance'))}</div><div class="sub">לפי הרישומים</div></div>
    </div>
    ${ks.some(k => !k.opening_set) ? `<div class="banner b-info">🐷 עוד לא נרשמה יתרת פתיחה ל: ${ks.filter(k => !k.opening_set).map(k => esc(k.display_name)).join(', ')}.
      אפשר לרשום ב"פרטים ופעולות".</div>` : ''}
    <h2>הילדים</h2>
    <div class="kid-cards">${ks.map(k => `<div class="card">
      <div class="row between"><h3>${avatar(k)} ${esc(k.display_name)}</h3>${S.family.competition_enabled ? `<span title="עבודות מאושרות החודש">⭐ ${k.totals.points_month}</span>` : ''}</div>
      <div class="stats sm">${mini('s-earn', 'הרוויח' + g(k, 'ה', ''), k.totals.earned_work)}${mini('s-owed', 'מגיע', k.totals.owed)}
        ${mini('s-recv', 'קיבל' + g(k, 'ה', ''), k.totals.received)}${mini('s-left', 'בקופה', k.totals.balance)}</div>
      <p style="margin-bottom:0"><button class="btn sm" data-act="openChild" data-id="${k.id}">פרטים ופעולות</button></p></div>`).join('')}</div>
    <h2>הוספה</h2>${addMenu()}
    <div id="pushCard"></div>`;
}

// התפריט: עבודה קבועה / עבודה מזדמנת / בונוס מאבא או מאמא
const addMenu = () => `<div class="actions">
  <button class="btn mint" data-act="addFixed"><span aria-hidden="true">🔁</span>עבודה קבועה</button>
  <button class="btn sky" data-act="addOnce"><span aria-hidden="true">⚡</span>עבודה מזדמנת</button>
  <button class="btn grape" data-act="addBonus"><span aria-hidden="true">⭐</span>בונוס מאבא/אמא</button></div>`;

// "הקופה שלי" = יתרת פתיחה + כסף שהתקבל בפועל − הוצאות. מתעדכנת לבד; כסף שעוד חייבים נשאר ב"מגיע לי".
function piggyCard(m) {
  const P = isParent(), t = m.totals;
  const btn = !m.opening_set ? `<button class="btn sm" data-act="opening" data-id="${m.id}">${P ? 'יתרת פתיחה' : 'כמה היה לי בהתחלה?'}</button>`
    : P ? `<button class="btn ghost sm" data-act="opening" data-id="${m.id}">✏️ תיקון יתרה</button>` : '';
  const log = (m.balance_log || []).map(x => `<div class="small muted">✏️ תוקן ${fmtDT(x.at)}: יתרת פתיחה ${money(x.old)} ← ${money(x.new)}${x.reason ? ' · ' + esc(x.reason) : ''}</div>`).join('');
  return `<div class="card"><div class="row between"><h3>🐷 ${P ? 'הקופה של ' + esc(m.display_name) : 'הקופה שלי'}</h3>${btn}</div>
    <div class="piggy-val">${money(t.balance)}</div>
    <div class="small">יתרת פתיחה ${money(t.opening)} + קיבלתי ${money(t.received)} − הוצאות ${money(t.spent)}</div>
    ${t.owed ? `<div class="small muted">⏳ עוד ${money(t.owed)} ${P ? 'מגיעים' : 'מגיעים לך'} ונכנסים לקופה רק כשמשלמים.</div>` : ''}
    ${!m.opening_set ? `<p class="note">${P ? 'עוד לא נרשמה יתרת פתיחה: כמה כסף היה לפני שהתחלתם להשתמש באפליקציה.'
      : 'ספרו כמה כסף היה לך לפני שהתחלת להשתמש באפליקציה ורשמו פעם אחת. מכאן והלאה הקופה מתעדכנת לבד מכל תשלום והוצאה.'}</p>`
      : P ? '' : '<p class="note">הקופה מתעדכנת לבד מכל תשלום והוצאה. טעות? אבא או אמא יכולים לתקן.</p>'}
    ${log}</div>`;
}

// כפתור שדורש לחיצה שנייה לאישור (בלי חלון קופץ)
function armed(b, label) {
  if (b.dataset.armed) return true;
  b.dataset.armed = '1'; const old = b.innerHTML; b.innerHTML = label; b.classList.add('berry');
  setTimeout(() => { if (b.isConnected && b.dataset.armed) { delete b.dataset.armed; b.innerHTML = old; b.classList.remove('berry'); } }, 4000);
  return false;
}

// --------------------------------------------------------------- jobs
// עבודה מזדמנת שאפשר לערוך: הורה — כל אחת שלא בוטלה; ילד — רק מה שהוסיף בעצמו ועוד לא אושר
const canEditJob = i => !i.template_id && i.status !== 'cancelled'
  && (isParent() || (i.created_by === S.me.id && i.status !== 'approved'));
const editBtn = i => canEditJob(i) ? `<button class="btn ghost sm" data-act="editJob" data-id="${i.id}">✏️ עריכה</button>` : '';
const removeTplBtn = (t, childId) => `<button class="btn ghost sm" data-act="unassign" data-tpl="${t.id}" data-child="${childId}" data-rid="${uuid()}">הסרה מהרשימה</button>`;

function renderChildJobs() {
  const me = S.me.id;
  const tpls = S.templates.filter(t => t.active && t.assignees.some(a => a.child_id === me));
  const inst = S.instances.filter(i => i.child_id === me);
  const open = inst.filter(i => i.status === 'todo' || i.status === 'needs_fix');
  const pend = inst.filter(i => i.status === 'pending');
  const done = inst.filter(i => i.status === 'approved' || i.status === 'cancelled').slice(0, 15);
  return `<h1>🧹 עבודות</h1>${addMenu()}
    ${open.length ? `<h2>⚡ לביצוע</h2>${open.map(i => `<div class="card"><div class="row between"><h3>${esc(i.title)}</h3>${jobChip(i.status)}</div>
      ${i.description ? `<div class="muted small">${esc(i.description)}</div>` : ''}
      ${i.status === 'needs_fix' && i.note ? `<div class="banner b-warn small" style="margin-top:8px">🔧 ${esc(i.note)}</div>` : ''}
      <div class="row between" style="margin-top:8px"><span>${money(i.price_cents)} · משלם: ${payerName(i)}</span>
      <div class="row">${editBtn(i)}<button class="btn mint" data-act="submit" data-inst="${i.id}" data-rid="${uuid()}">סיימתי ✓</button></div></div></div>`).join('')}` : ''}
    <div class="row between"><h2>🔁 העבודות הקבועות שלי</h2><button class="btn sm" data-act="addTpl">➕ הוספה</button></div>
    ${tpls.length ? tpls.map(t => { const a = t.assignees.find(x => x.child_id === me); const waiting = pend.filter(p => p.template_id === t.id).length;
      return `<div class="card"><div class="row between"><h3>🔁 ${esc(t.title)}</h3><span>${money(a.price_cents)}</span></div>
      ${t.description ? `<div class="muted small">${esc(t.description)}</div>` : ''}
      ${a.approved ? '' : '<div class="banner b-info small" style="margin-top:8px">⏳ מחכה לאישור של אבא או אמא (גם המחיר). אחרי האישור אפשר לסמן "סיימתי".</div>'}
      <div class="row between" style="margin-top:8px"><span class="small muted">משלם: ${payerName(a)}${waiting ? ` · ${waiting} ממתין לאישור` : ''}</span>
      <div class="row">${removeTplBtn(t, me)}${a.approved ? `<button class="btn mint" data-act="submit" data-tpl="${t.id}" data-rid="${uuid()}">סיימתי ✓</button>` : ''}</div></div></div>`; }).join('')
      : '<p class="muted">אין כרגע עבודות קבועות ברשימה שלך. אפשר להוסיף.</p>'}
    ${pend.length ? `<h2>ממתין לאישור</h2><div class="card list">${pend.map(i => instRow(i) + `<div class="row" style="padding-bottom:10px">${editBtn(i)}
      <button class="btn ghost sm" data-act="withdraw" data-kind="job" data-id="${i.id}" data-rid="${uuid()}">↩️ סימנתי בטעות</button></div>`).join('')}</div>` : ''}
    ${done.length ? `<h2>לאחרונה</h2><div class="card list">${done.map(instRow).join('')}</div>` : ''}
    ${bonusList()}`;
}
function bonusList() {
  const bs = S.incomes.filter(i => i.kind === 'bonus' && i.status !== 'rejected').slice(0, 10);
  return bs.length ? `<h2>⭐ בונוסים</h2><div class="card list">${bs.map(i => `<div class="item"><div class="emo">⭐</div><div class="grow">
    <b>${isParent() ? nameOf(i.child_id) + ' · ' : ''}${esc(i.description)}</b><div class="small muted">${fmtDate(i.income_date)} · מ${payerName(i)}</div></div>
    <div class="center">${money(i.amount_cents)} ${ST[i.status]} ${payChip(i)}</div></div>`).join('')}</div>` : '';
}
const instRow = i => `<div class="item"><div class="emo">${JOB[i.status][0]}</div><div class="grow"><b>${esc(i.title)}</b>
  ${isParent() ? ` · ${nameOf(i.child_id)}` : ''}<div class="small muted">${fmtDate(i.job_date)} · ${money(i.price_cents)}</div>
  ${i.note ? `<div class="small muted">💬 ${esc(i.note)}</div>` : ''}</div>${jobChip(i.status)}</div>`;

function renderParentJobs() {
  const open = S.instances.filter(i => i.status === 'todo' || i.status === 'needs_fix');
  const recent = S.instances.filter(i => i.status === 'approved' || i.status === 'cancelled').slice(0, 20);
  return `<h1>🧹 עבודות</h1>${addMenu()}
    <h2>🔁 עבודות קבועות</h2>
    ${S.templates.length ? S.templates.map(t => `<div class="card"><div class="row between"><h3>🔁 ${esc(t.title)} ${t.active ? '' : chip('c-cancel', 'מושבת')}</h3>
      <button class="btn ghost sm" data-act="jobForm" data-id="${t.id}">עריכה</button></div>
      ${t.description ? `<div class="muted small">${esc(t.description)}</div>` : ''}
      <div class="list">${t.assignees.map(a => `<div class="item"><div class="emo">${avatar(mem(a.child_id) || {})}</div><div class="grow">${nameOf(a.child_id)} · ${money(a.price_cents)}
        ${a.approved ? '' : chip('c-pending', '⏳ ממתין לאישור')}
        <div class="small muted">משלם: ${payerName(a)}</div>
        <div class="row" style="margin-top:6px">${t.active && a.approved ? `<button class="btn sm" data-act="submit" data-tpl="${t.id}" data-child="${a.child_id}" data-rid="${uuid()}">רישום ביצוע</button>` : ''}
        ${removeTplBtn(t, a.child_id)}</div></div></div>`).join('')}</div>
    </div>`).join('') : '<p class="muted">עוד אין עבודות קבועות.</p>'}
    <p class="note">הסרה מהרשימה של ילד לא מוחקת עבודות שכבר בוצעו או כסף שמגיע, ולא מורידה את העבודה מילדים אחרים.</p>
    <h2>⚡ לביצוע / נדרש תיקון</h2>
    ${open.length ? `<div class="card list">${open.map(i => `${instRow(i)}<div class="row" style="padding-bottom:10px">
      <button class="btn sm mint" data-act="review" data-id="${i.id}" data-a="approve">אישור</button>
      ${i.template_id ? `<button class="btn sm ghost" data-act="review" data-id="${i.id}" data-a="edit_price">שינוי מחיר</button>` : editBtn(i)}
      <button class="btn sm ghost" data-act="review" data-id="${i.id}" data-a="cancel">ביטול</button></div>`).join('')}</div>` : '<p class="muted">אין.</p>'}
    <h2>לאחרונה</h2>${recent.length ? `<div class="card list">${recent.map(i => { const inc = jobIncome(i);
      return instRow(i) + (inc || canEditJob(i) ? `<div class="row" style="padding-bottom:10px">${editBtn(i)}
        ${inc ? `<button class="btn ghost sm" data-act="void" data-kind="income" data-id="${inc.id}">↩️ ביטול אישור</button>` : ''}</div>` : ''); }).join('')}</div>` : '<p class="muted">אין.</p>'}
    ${bonusList()}`;
}
const jobIncome = i => i.status === 'approved' && S.incomes.find(x => x.job_instance_id === i.id && x.status === 'active');

// ---------------------------------------------------------------- owed
function owedGroups(childId) {
  const groups = new Map();
  for (const i of S.incomes) {
    if (i.child_id !== childId || i.status !== 'active') continue;
    const out = i.amount_cents - i.paid_cents; if (out <= 0) continue;
    const key = i.payer_member_id ? 'm:' + i.payer_member_id : 'o:' + (i.payer_name || '').trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, payer_member_id: i.payer_member_id, payer_name: i.payer_name, items: [], total: 0 });
    const gr = groups.get(key); gr.items.push(i); gr.total += out;
  }
  for (const gr of groups.values()) gr.items.sort((a, b) => a.income_date.localeCompare(b.income_date) || a.created_at.localeCompare(b.created_at));
  return [...groups.values()];
}

function renderOwed(childId) {
  const m = mem(childId);
  const groups = owedGroups(childId);
  const byParent = parents().map(p => ({ p, total: groups.filter(x => x.payer_member_id === p.id).reduce((a, x) => a + x.total, 0) }));
  const others = groups.filter(x => !x.payer_member_id);
  const othersTotal = others.reduce((a, x) => a + x.total, 0);
  const all = S.incomes.filter(i => i.child_id === childId && i.status === 'active');
  const myReports = S.receipts.filter(r => r.child_id === childId && r.status === 'pending');
  return `<h1>⏳ מגיע ${g(m, 'לי', 'לי')}</h1>
    <div class="stat s-owed card"><div class="lbl">סך הכול מגיע</div><div class="val">${money(m.totals.owed)}</div>
      <div class="sub">הכנסות שאושרו ועוד לא שולמו. נכנס לקופה רק כשמשלמים.</div></div>
    ${!isParent() && groups.length ? `<p><button class="btn sky big" data-act="reportReceipt">💰 קיבלתי תשלום</button></p>` : ''}
    ${myReports.length ? `<div class="card"><h3>⏳ דיווחי תשלום שמחכים לאישור</h3><div class="list">${myReports.map(r => `<div class="item"><div class="emo">💰</div>
      <div class="grow">${money(r.amount_cents)} מ${payerName(r)}<div class="small muted">${fmtDate(r.received_date)} · ${METHOD[r.method]}</div>
      ${isParent() ? '' : `<button class="btn ghost sm" data-act="withdraw" data-kind="receipt" data-id="${r.id}" data-rid="${uuid()}">↩️ ביטול, דיווחתי בטעות</button>`}</div></div>`).join('')}</div></div>` : ''}
    <div class="card list">
      ${byParent.map(({ p, total }) => `<div class="item"><div class="emo">${avatar(p)}</div><div class="grow"><b>${esc(p.display_name)} ${g(p, 'חייבת', 'חייב')}</b></div>${money(total)}</div>`).join('')}
      <div class="item"><div class="emo">🌍</div><div class="grow"><b>מקורות אחרים</b>
        ${others.map(o => `<div class="small muted">${esc(o.payer_name)}: ${money(o.total)}</div>`).join('')}</div>${money(othersTotal)}</div>
    </div>
    <h2>פירוט</h2>
    ${all.length ? `<div class="card list">${all.map(i => `<div class="item"><div class="emo">${KIND[i.kind].split(' ')[0]}</div>
      <div class="grow"><b>${esc(i.description)}</b><div class="small muted">${fmtDate(i.income_date)} · משלם: ${payerName(i)}</div>
      <div class="small">סכום ${money(i.amount_cents)} · שולם ${money(i.paid_cents)} · נשאר ${money(i.amount_cents - i.paid_cents)}</div></div>${payChip(i)}</div>`).join('')}</div>`
      : '<p class="muted">עוד אין הכנסות מאושרות.</p>'}`;
}

// ------------------------------------------------------------- history
function historyItems(childId) {
  const out = [];
  for (const i of S.incomes.filter(x => x.child_id === childId)) out.push({ t: 'income', d: i.income_date, c: i.created_at, o: i });
  for (const r of S.receipts.filter(x => x.child_id === childId)) out.push({ t: 'receipt', d: r.received_date, c: r.created_at, o: r });
  for (const e of S.expenses.filter(x => x.child_id === childId)) out.push({ t: 'expense', d: e.expense_date, c: e.created_at, o: e });
  return out.sort((a, b) => b.d.localeCompare(a.d) || b.c.localeCompare(a.c));
}
const ST = {
  pending: chip('c-pending', '⏳ ממתין לאישור'), rejected: chip('c-cancel', '✖️ נדחה'), voided: chip('c-cancel', '↩️ בוטל'),
  approved: chip('c-approved', '✅ אושר'), active: ''
};
// ביטול תשלום: לחיצה ואישור בלחיצה שנייה, בלי חלון והודעה; המסך מתעדכן מיד
const voidReceiptBtn = o => `<button class="btn ghost sm" data-act="voidReceipt" data-id="${o.id}" data-rid="${uuid()}">ביטול תשלום</button>`;
function historyRow(h, withName) {
  const o = h.o, P = isParent();
  const who = withName ? `${nameOf(o.child_id)} · ` : '';
  const wd = o.status === 'pending' ? `<button class="btn ghost sm" data-act="withdraw" data-kind="${h.t}" data-id="${o.id}" data-rid="${uuid()}">↩️ ביטול, נרשם בטעות</button>` : '';
  if (h.t === 'income') return `<div class="item"><div class="emo">${KIND[o.kind].split(' ')[0]}</div><div class="grow">
    <b>${who}הכנסה: ${esc(o.description)}</b><div class="small muted">${fmtDate(o.income_date)} · ${KIND[o.kind].slice(2)} · ${payerName(o)}</div>
    ${o.void_reason ? `<div class="small muted">סיבת ביטול: ${esc(o.void_reason)}</div>` : ''}
    ${o.review_note ? `<div class="small muted">💬 ${esc(o.review_note)}</div>` : ''}
    ${P && o.status === 'active' ? `<button class="btn ghost sm" data-act="void" data-kind="income" data-id="${o.id}">תיקון / ביטול</button>` : ''}${wd}</div>
    <div class="center"><div>+${money(o.amount_cents)}</div>${ST[o.status]} ${payChip(o)}</div></div>`;
  if (h.t === 'receipt') return `<div class="item"><div class="emo">💵</div><div class="grow">
    <b>${who}תקבול מ${payerName(o)}</b><div class="small muted">${fmtDate(o.received_date)} · ${METHOD[o.method]}${o.note ? ' · ' + esc(o.note) : ''}</div>
    ${o.reported_by_child ? '<div class="small">📝 הילד דיווח שקיבל</div>' : o.child_ack === 'confirmed' ? '<div class="small">✔ הילד אישר קבלה</div>' : o.child_ack === 'disputed' ? `<div class="small" style="color:var(--berry)">✋ סומן "לא קיבלתי"${o.ack_note ? ': ' + esc(o.ack_note) : ''}</div>` : ''}
    ${o.void_reason ? `<div class="small muted">סיבת ביטול: ${esc(o.void_reason)}</div>` : ''}
    ${o.review_note ? `<div class="small muted">💬 ${esc(o.review_note)}</div>` : ''}
    ${P && o.status === 'active' ? voidReceiptBtn(o) : ''}${wd}</div>
    <div class="center">${money(o.amount_cents)} ${ST[o.status]}</div></div>`;
  return `<div class="item"><div class="emo">🛒</div><div class="grow"><b>${who}הוצאה: ${esc(o.description)}</b>
    <div class="small muted">${fmtDate(o.expense_date)}</div>
    ${o.review_note ? `<div class="small muted">💬 ${esc(o.review_note)}</div>` : ''}
    ${o.void_reason ? `<div class="small muted">סיבת ביטול: ${esc(o.void_reason)}</div>` : ''}
    ${P && (o.status === 'approved') ? `<button class="btn ghost sm" data-act="void" data-kind="expense" data-id="${o.id}">ביטול הוצאה</button>` : ''}${wd}</div>
    <div class="center">−${money(o.amount_cents)} ${ST[o.status]}</div></div>`;
}
function renderHistory(childId) {
  const items = historyItems(childId).filter(h => filters.histType === 'all' || h.t === filters.histType);
  return `<h1>📜 היסטוריית כסף</h1>
    <div class="seg" role="radiogroup" aria-label="סינון">${[['all', 'הכול'], ['income', 'הכנסות'], ['receipt', 'תקבולים'], ['expense', 'הוצאות']].map(([k, l]) =>
      `<label><input type="radio" name="hist" value="${k}" data-act="histFilter" ${filters.histType === k ? 'checked' : ''}>${l}</label>`).join('')}</div>
    <p class="note">הכנסה = מה שהרווחת. תקבול = כסף שהגיע אליך בפועל. תשלום חוב הוא תקבול, לא הכנסה חדשה.</p>
    ${items.length ? `<div class="card list">${items.map(h => historyRow(h)).join('')}</div>` : '<p class="muted">אין עדיין רישומים.</p>'}`;
}

// --------------------------------------------------------------- family
function renderFamily() {
  const months = [...new Set([S.month, ...S.points.map(p => p.month), ...S.feed.map(f => f.income_date.slice(0, 7))])].sort().reverse();
  const cm = filters.compMonth || S.month;
  const pts = id => S.points.find(p => p.child_id === id && p.month === cm)?.points || 0;
  const ks = kids();
  let feed = S.feed.filter(f => (!filters.feedChild || f.child_id === filters.feedChild)
    && (!filters.feedMonth || f.income_date.startsWith(filters.feedMonth)) && (!filters.feedKind || f.kind === filters.feedKind));
  const comp = S.family.competition_enabled;
  return `<h1>👨‍👩‍👧 המשפחה</h1>
    <div class="kid-cards">${ks.map(k => `<div class="card">
      <div class="row between"><h3>${avatar(k)} ${esc(k.display_name)}</h3>${comp ? `<span title="עבודות מאושרות החודש">⭐ ${S.points.find(p => p.child_id === k.id && p.month === S.month)?.points || 0}</span>` : ''}</div>
      <div class="small">🛠️ מעבודה החודש: ${money(k.totals.earned_work_month)}</div>
      <div class="small">⏳ עוד לא שולם: ${money(k.totals.owed)}</div>
      ${k.goal_name ? `<div class="small" style="margin-top:6px">🎯 ${esc(k.goal_name)} · ${k.goal_pct}%</div>
        <div class="bar" role="progressbar" aria-valuenow="${k.goal_pct}" aria-valuemin="0" aria-valuemax="100" aria-label="יעד של ${esc(k.display_name)}"><i style="width:${k.goal_pct}%"></i></div>` : ''}
      ${isParent() ? `<p><button class="btn sm" data-act="openChild" data-id="${k.id}">פרטים ופעולות</button></p>` : ''}
    </div>`).join('')}</div>

    ${comp ? `<h2>🏆 תחרות העבודות</h2><div class="card">
      <div class="filters"><select data-act="compMonth" aria-label="חודש">${months.map(mo => `<option value="${mo}" ${mo === cm ? 'selected' : ''}>${monthName(mo)}</option>`).join('')}</select></div>
      <div class="list">${[...ks].sort((a, b) => pts(b.id) - pts(a.id)).map(k => `<div class="item"><div class="emo">${avatar(k)}</div>
        <div class="grow"><b>${esc(k.display_name)}</b><div class="small muted">${pts(k.id)} עבודות מאושרות${k.goal_name ? ` · 🎯 ${k.goal_pct}% מהיעד האישי` : ''}</div></div>
        <div aria-label="${pts(k.id)} נקודות">${'⭐'.repeat(Math.min(pts(k.id), 12))}${pts(k.id) > 12 ? '+' : ''}${pts(k.id) === 0 ? '<span class="muted small">עוד יבוא 💪</span>' : ''}</div></div>`).join('')}</div>
      <p class="note">נקודה אחת לכל עבודה שאושרה. מתנות, דמי כיס ותשלומים לא נותנים נקודות. כולם מנצחים כשעובדים 😊</p></div>` : ''}

    <h2>💬 מה הרווחנו</h2>
    <div class="filters">
      <select data-act="feedChild" aria-label="ילד"><option value="">כל הילדים</option>${ks.map(k => `<option value="${k.id}" ${filters.feedChild === k.id ? 'selected' : ''}>${esc(k.display_name)}</option>`).join('')}</select>
      <select data-act="feedMonth" aria-label="חודש"><option value="">כל החודשים</option>${months.map(mo => `<option value="${mo}" ${filters.feedMonth === mo ? 'selected' : ''}>${monthName(mo)}</option>`).join('')}</select>
      <select data-act="feedKind" aria-label="סוג"><option value="">כל הסוגים</option>${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${filters.feedKind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <p class="note">מוצגות רק הכנסות שהורה אישר.</p>
    ${feed.length ? `<div class="card list">${feed.slice(0, 100).map(f => { const k = mem(f.child_id);
      const verb = f.kind === 'job' || f.kind === 'external_job' ? g(k, 'הרוויחה', 'הרוויח') : g(k, 'קיבלה', 'קיבל');
      return `<div class="item"><div class="emo">${KIND[f.kind].split(' ')[0]}</div><div class="grow">${esc(k?.display_name)} ${verb} ${money(f.amount_cents)} על ${esc(f.description)}
      <div class="small muted">${fmtDate(f.income_date)}</div></div></div>`; }).join('')}</div>` : '<p class="muted">אין עדיין הכנסות מאושרות.</p>'}`;
}

// ------------------------------------------------------ parent screens
function renderApprovals() {
  const inst = S.instances.filter(i => i.status === 'pending');
  const inc = S.incomes.filter(i => i.status === 'pending');
  const exp = S.expenses.filter(e => e.status === 'pending');
  const disp = S.receipts.filter(r => r.status === 'active' && r.child_ack === 'disputed');
  const recs = S.receipts.filter(r => r.status === 'pending');
  const asg = pendingAssignments();
  const none = !inst.length && !inc.length && !exp.length && !disp.length && !recs.length && !asg.length;
  const incTitle = id => esc(S.incomes.find(i => i.id === id)?.description || '');
  return `<h1>✅ אישורים</h1>
    ${none ? '<div class="banner b-ok">🎉 אין כרגע מה לאשר.</div>' : ''}
    ${recs.length ? `<h2>💰 "קיבלתי תשלום" — דיווחים של ילדים</h2>${recs.map(r => { const k = mem(r.child_id);
      const incIds = r.allocations.map(a => a.income_id);
      const dup = S.receipts.some(x => x.id !== r.id && x.status === 'active' && x.child_id === r.child_id
        && x.allocations.some(a => a.status === 'active' && incIds.includes(a.income_id)) && x.created_at > r.created_at);
      return `<div class="card"><div class="row between"><h3>${avatar(k || {})} ${nameOf(r.child_id)} ${g(k, 'קיבלה', 'קיבל')} ${money(r.amount_cents)}</h3>${fmtDate(r.received_date)}</div>
      <div class="small muted">מ${payerName(r)} · ${METHOD[r.method]} · על: ${r.allocations.map(a => `${incTitle(a.income_id)} (${money(a.amount_cents)})`).join(', ')}</div>
      ${dup ? '<div class="banner b-warn small" style="margin-top:8px">⚠️ אחרי הדיווח הזה נרשם תשלום על אותו חוב. אם זה אותו כסף, דחו את הדיווח.</div>' : ''}
      <div class="row" style="margin-top:10px"><button class="btn mint" data-act="reviewReceipt" data-id="${r.id}" data-a="approve" data-rid="${uuid()}">✔ אישור</button>
      <button class="btn ghost" data-act="reviewReceipt" data-id="${r.id}" data-a="reject" data-rid="${uuid()}">✖ דחייה</button></div></div>`; }).join('')}` : ''}
    ${asg.length ? `<h2>🔁 עבודות קבועות שילדים הוסיפו</h2>${asg.map(({ t, a }) => `<div class="card"><div class="row between"><h3>${avatar(mem(a.child_id) || {})} ${nameOf(a.child_id)} · ${esc(t.title)}</h3>${money(a.price_cents)}</div>
      <div class="small muted">משלם: ${payerName(a)}${t.description ? ' · ' + esc(t.description) : ''}</div>
      <div class="row" style="margin-top:10px"><button class="btn mint" data-act="reviewAssign" data-tpl="${t.id}" data-child="${a.child_id}" data-a="approve" data-rid="${uuid()}">✔ אישור</button>
      <button class="btn ghost sm" data-act="assignPrice" data-tpl="${t.id}" data-child="${a.child_id}">אישור במחיר אחר</button>
      <button class="btn ghost sm" data-act="reviewAssign" data-tpl="${t.id}" data-child="${a.child_id}" data-a="reject" data-rid="${uuid()}">✖ דחייה</button></div></div>`).join('')}` : ''}
    ${inst.length ? `<h2>עבודות שסומנו כהושלמו</h2>${inst.map(i => `<div class="card"><div class="row between"><h3>${avatar(mem(i.child_id) || {})} ${nameOf(i.child_id)} · ${esc(i.title)}</h3>${money(i.price_cents)}</div>
      <div class="small muted">${fmtDate(i.job_date)} · משלם: ${payerName(i)}${i.note ? ' · 💬 ' + esc(i.note) : ''}</div>
      <div class="row" style="margin-top:10px"><button class="btn mint" data-act="approveJob" data-id="${i.id}" data-rid="${uuid()}">✔ אישור</button>
      <button class="btn ghost sm" data-act="review" data-id="${i.id}" data-a="approve">אישור במחיר אחר</button>
      <button class="btn ghost sm" data-act="review" data-id="${i.id}" data-a="needs_fix">🔧 נדרש תיקון</button>
      <button class="btn ghost sm" data-act="review" data-id="${i.id}" data-a="reopen">↩️ לא בוצע</button>
      <button class="btn ghost sm" data-act="review" data-id="${i.id}" data-a="cancel">ביטול</button></div></div>`).join('')}` : ''}
    ${inc.length ? `<h2>דיווחי הכנסה</h2>${inc.map(i => `<div class="card"><div class="row between"><h3>${nameOf(i.child_id)} · ${KIND[i.kind]}</h3>${money(i.amount_cents)}</div>
      <div class="small muted">${fmtDate(i.income_date)} · מ: ${payerName(i)} · ${esc(i.description)} · ${i.reported_received ? 'הכסף כבר התקבל' : 'הכסף עוד לא התקבל (יירשם כחוב)'}</div>
      <div class="row" style="margin-top:10px"><button class="btn mint" data-act="reviewIncome" data-id="${i.id}" data-a="approve" data-rid="${uuid()}">✔ אישור</button>
      <button class="btn ghost" data-act="reviewIncome" data-id="${i.id}" data-a="reject" data-rid="${uuid()}">✖ דחייה</button></div></div>`).join('')}` : ''}
    ${exp.length ? `<h2>דיווחי הוצאה</h2>${exp.map(e => { const k = mem(e.child_id); const after = (k?.totals?.balance || 0) - e.amount_cents;
      return `<div class="card"><div class="row between"><h3>${nameOf(e.child_id)} · ${esc(e.description)}</h3>${money(e.amount_cents)}</div>
      <div class="small muted">${fmtDate(e.expense_date)} · יתרה אחרי אישור: ${money(after)}</div>
      ${after < 0 ? `<div class="banner b-warn small" style="margin-top:8px">⚠️ אישור ההוצאה ייצור יתרה שלילית. כדאי לבדוק עם ${g(k, 'הילדה', 'הילד')} לפני אישור.</div>` : ''}
      <div class="row" style="margin-top:10px"><button class="btn mint" data-act="reviewExpense" data-id="${e.id}" data-a="approve" data-neg="${after < 0 ? 1 : 0}" data-rid="${uuid()}">✔ אישור${after < 0 ? ' למרות יתרה שלילית' : ''}</button>
      <button class="btn ghost" data-act="reviewExpense" data-id="${e.id}" data-a="reject" data-rid="${uuid()}">✖ דחייה</button></div></div>`; }).join('')}` : ''}
    ${disp.length ? `<h2>✋ "לא קיבלתי" — לבירור</h2>${disp.map(r => `<div class="card"><div class="row between"><h3>${nameOf(r.child_id)} · ${money(r.amount_cents)}</h3>${fmtDate(r.received_date)}</div>
      <div class="small muted">משלם: ${payerName(r)}${r.ack_note ? ' · 💬 ' + esc(r.ack_note) : ''}</div>
      <p class="note">אם התשלום נרשם בטעות, בטלו אותו. אם הכסף ניתן, דברו עם ${g(mem(r.child_id), 'הילדה', 'הילד')}.</p>
      ${voidReceiptBtn(r)}</div>`).join('')}` : ''}
    ${fixSection()}
    <h2>ילדים</h2><div class="kid-cards">${kids().map(k => `<button class="card profile" data-act="openChild" data-id="${k.id}">
      <span class="av">${avatar(k)}</span>${esc(k.display_name)}<div class="small muted">מגיע: ${money(k.totals.owed)} · נשאר: ${money(k.totals.balance)}</div></button>`).join('')}</div>`;
}

// רישומים אחרונים של כל הילדים, עם כפתור תיקון ליד כל אחד
function fixSection() {
  const items = kids().flatMap(k => historyItems(k.id))
    .filter(h => h.o.status === 'active' || h.o.status === 'approved')
    .sort((a, b) => b.c.localeCompare(a.c)).slice(0, 12);
  if (!items.length) return '';
  return `<h2>🛠️ תיקון טעויות</h2>
    <p class="note">משהו נרשם בטעות? ליד כל רישום יש כפתור ביטול. שום דבר לא נמחק: הרישום מסומן כמבוטל, עם הסיבה, ביומן השינויים.
    רישומים ישנים יותר נמצאים בהיסטוריה של כל ילד.</p>
    <div class="card list">${items.map(h => historyRow(h, true)).join('')}</div>`;
}

function renderPay() {
  const ks = kids();
  return `<h1>💸 תשלומים</h1>
    <p class="note">בחרו על מה משלמים. אפשר לשלם חלק מהחוב, או תשלום אחד שמכסה כמה עבודות של אותו משלם. אי אפשר לשלם יותר מהחוב. כסף נוסף רשמו בנפרד, למשל כמתנה.</p>
    ${ks.map(k => { const groups = owedGroups(k.id);
      return `<h2>${avatar(k)} ${esc(k.display_name)} · מגיע ${money(k.totals.owed)}</h2>
      ${groups.length ? groups.map(gr => `<form class="card payForm" data-child="${k.id}" data-rid="${uuid()}">
        <div class="row between"><h3>משלם: ${payerName(gr)}</h3>${money(gr.total)}</div>
        <div class="list">${gr.items.map(i => `<label class="item" style="cursor:pointer"><input type="checkbox" name="inc" value="${i.id}" data-out="${i.amount_cents - i.paid_cents}" checked style="width:22px;height:22px">
          <div class="grow">${esc(i.description)} <div class="small muted">${fmtDate(i.income_date)} · נשאר ${money(i.amount_cents - i.paid_cents)}</div></div>${payChip(i)}</label>`).join('')}</div>
        <div class="row"><div class="grow"><label class="f">סכום (₪)</label><input class="in" name="amount" inputmode="decimal" value="${fmtNum(gr.total)}" required></div>
        <div class="grow"><label class="f">אמצעי</label><select class="in" name="method">${Object.entries(METHOD).map(([k2, l]) => `<option value="${k2}">${l}</option>`).join('')}</select></div></div>
        <label class="f">תאריך</label><input class="in" type="date" name="date" value="${S.today}" max="${S.today}">
        <div class="formErr"></div>
        <p><button class="btn mint big" type="submit">רישום תשלום</button></p></form>`).join('') : '<p class="muted">אין חובות פתוחים 👍</p>'}
      <div class="row"><button class="btn ghost sm" data-act="income" data-id="${k.id}">➕ מתנה / הכנסה אחרת</button>
      <button class="btn ghost sm" data-act="expense" data-id="${k.id}">🛒 רישום הוצאה</button></div>`; }).join('')}`;
}

function renderChildForParent(id) {
  const m = mem(id); if (!m) { view.tab = 'approvals'; return renderApprovals(); }
  return `<button class="btn ghost sm" data-act="tab" data-tab="home">→ חזרה</button>
    <h1>${avatar(m)} ${esc(m.display_name)}</h1>${statCards(m)}
    <div class="actions"><button class="btn sky" data-act="income" data-id="${id}"><span>💵</span>הכנסה / מתנה</button>
    <button class="btn berry" data-act="expense" data-id="${id}"><span>🛒</span>הוצאה</button>
    <button class="btn grape" data-act="tab" data-tab="pay"><span>💸</span>תשלום</button></div>
    <h2>יעד</h2>${goalCard(m, true)}
    <h2>קופה</h2>${piggyCard(m)}
    ${renderOwed(id).replace(/<h1>.*?<\/h1>/, '<h2>⏳ מגיע</h2>')}
    ${renderHistory(id).replace(/<h1>.*?<\/h1>/, '<h2>📜 היסטוריה</h2>')}`;
}

const ACTION_LBL = {
  setup_family: 'הקמת משפחה', add_member: 'הוספת בן משפחה', link_member: 'חיבור משתמש', update_member: 'עדכון בן משפחה',
  set_opening_balance: 'יתרת פתיחה', set_goal: 'יעד חיסכון', update_settings: 'הגדרות', reset_password: 'איפוס סיסמה',
  create_template: 'עבודה קבועה חדשה', update_template: 'עדכון עבודה קבועה', create_job: 'עבודה חדשה', submit_job: 'סימון עבודה כהושלמה',
  approve_job: 'אישור עבודה', needs_fix: 'בקשת תיקון', cancel_job: 'ביטול עבודה', change_price: 'שינוי מחיר', report_income: 'רישום הכנסה',
  approve_income: 'אישור הכנסה', reject_income: 'דחיית הכנסה', record_payment: 'רישום תשלום', ack_receipt: 'אישור/בירור קבלה',
  report_expense: 'רישום הוצאה', approve_expense: 'אישור הוצאה', reject_expense: 'דחיית הוצאה', void_income: 'ביטול הכנסה',
  void_receipt: 'ביטול תשלום', void_expense: 'ביטול הוצאה', reopen_job: 'עבודה סומנה בטעות', withdraw_job: 'ביטול סימון עבודה',
  withdraw_income: 'ביטול דיווח הכנסה', withdraw_expense: 'ביטול דיווח הוצאה', export: 'ייצוא גיבוי', restore: 'שחזור מגיבוי',
  propose_job: 'עבודה מזדמנת חדשה', set_piggy: 'ספירת קופה', reset_family: 'איפוס כל הנתונים',
  correct_balance: 'תיקון יתרה', edit_job: 'עריכת עבודה', propose_template: 'הוספת עבודה קבועה לרשימה',
  remove_template: 'הסרת עבודה קבועה מרשימה', approve_assignment: 'אישור עבודה קבועה', reject_assignment: 'דחיית עבודה קבועה',
  report_receipt: 'דיווח "קיבלתי תשלום"', approve_receipt: 'אישור דיווח תשלום', reject_receipt: 'דחיית דיווח תשלום',
  withdraw_receipt: 'ביטול דיווח תשלום', reset_money: 'איפוס כספי'
};

function renderAdmin() {
  const f = S.family;
  return `<h1>⚙️ ניהול</h1>
    <h2>הגדרות משפחה</h2>
    <form class="card" id="settingsForm" data-rid="${uuid()}">
      <label class="row" style="gap:12px;cursor:pointer"><input type="checkbox" name="comp" ${f.competition_enabled ? 'checked' : ''} style="width:24px;height:24px"> <b>תחרות עבודות חודשית פעילה</b></label>
      <label class="f">יום תשלום שבועי (תזכורת באפליקציה)</label>
      <select class="in" name="payday"><option value="">בלי יום קבוע</option>${DAYS.map((d, i) => `<option value="${i}" ${f.payday === i ? 'selected' : ''}>יום ${d}</option>`).join('')}</select>
      <div class="formErr"></div><p><button class="btn">שמירה</button></p></form>

    <h2>בני המשפחה</h2>
    <div class="card list">${S.members.map(m => `<div class="item"><div class="emo">${avatar(m)}</div><div class="grow">
      <b>${esc(m.display_name)}</b> ${m.active ? '' : chip('c-cancel', 'מושבת')} ${m.linked ? '' : chip('c-fix', 'לא מחובר למשתמש')}
      <div class="small muted" dir="ltr" style="text-align:right">${esc(m.login_email)}</div>
      ${m.role === 'child' ? `<div class="small">יתרת פתיחה: ${m.opening_set ? money(m.totals.opening) : 'עוד לא נרשמה'}</div>` : '<div class="small">הורה</div>'}
      <div class="row" style="margin-top:6px"><button class="btn ghost sm" data-act="editMember" data-id="${m.id}">עריכה</button>
      ${m.role === 'child' ? `<button class="btn ${m.opening_set ? 'ghost ' : ''}sm" data-act="opening" data-id="${m.id}">${m.opening_set ? '✏️ תיקון יתרה' : '🐷 יתרת פתיחה'}</button>
      <button class="btn ghost sm" data-act="resetPw" data-id="${m.id}">🔑 איפוס סיסמה</button>` : ''}</div></div></div>`).join('')}</div>
    <button class="btn" data-act="addMember">➕ הוספת בן משפחה</button>

    <h2>💾 גיבוי ושחזור</h2>
    <div class="card">
      <p class="small">הגיבוי הוא קובץ שנשמר אצלכם. במסלול החינמי של Supabase אין גיבוי אוטומטי, לכן מומלץ לייצא פעם בחודש.</p>
      <div class="row"><button class="btn mint" data-act="exportBackup">⬇️ ייצוא גיבוי</button>
      <button class="btn ghost" data-act="testRestore">🧪 בדיקת שחזור (בלי שינוי)</button></div>
      <label class="f" for="restoreFile">שחזור מקובץ גיבוי</label>
      <input class="in" type="file" id="restoreFile" accept="application/json,.json">
      <div id="restoreOut"></div>
    </div>

    <h2>🧹 התחלה מחדש בכסף</h2>
    <div class="card">
      ${f.money_reset_at ? `<div class="banner b-ok small">האיפוס הכספי האחרון: ${fmtDT(f.money_reset_at)}.</div>` : ''}
      <p class="small"><b>מתאפס לכל הילדים:</b> יתרות פתיחה והקופה, הכנסות, תשלומים והוצאות, חובות שלא שולמו ותשלומים חלקיים, בונוסים,
      וההתקדמות ביעדי החיסכון (נקודת ההתחלה שלהם).</p>
      <p class="small"><b>נשאר בלי שינוי:</b> המשתמשים, הסיסמאות וההרשאות, העבודות הקבועות והמזדמנות והמחירים שלהן,
      יעדי החיסכון והסכומים שלהם, הניקוד בתחרות וההגדרות.</p>
      <p class="small">שום דבר לא נמחק: הרישומים הכספיים הישנים נשמרים בארכיון במסד ולא משפיעים יותר על החישובים. לפני האיפוס יורד גם קובץ גיבוי.</p>
      <button class="btn ghost" data-act="resetPreview">הצגת סיכום לפני איפוס</button>
      <div id="resetOut"></div>
    </div>

    <h2>📒 יומן שינויים</h2>
    <div class="card list">${S.audit.length ? S.audit.slice(0, 60).map(a => `<div class="item"><div class="grow"><b>${ACTION_LBL[a.action] || esc(a.action)}</b>
      · ${a.actor_member_id && mem(a.actor_member_id) ? nameOf(a.actor_member_id) : ''}
      ${a.reason ? `<div class="small">סיבה: ${esc(a.reason)}</div>` : ''}<div class="small muted">${fmtDT(a.created_at)}</div></div></div>`).join('') : '<p class="muted">ריק</p>'}</div>`;
}

// ---------------------------------------------------------------- dialogs
function openDialog(title, inner, onSubmit, submitLabel = 'שמירה') {
  if ($dlg.open) $dlg.close();
  const rid = uuid();
  $dlg.innerHTML = `<form method="dialog" id="dlgForm"><input type="hidden" name="_rid" value="${rid}"><div class="row between"><h2 style="margin:0">${title}</h2>
    <button type="button" class="btn ghost sm" data-act="closeDlg" aria-label="סגירה">✕</button></div>${inner}
    <div id="dlgErr"></div><p><button class="btn big mint" type="submit">${submitLabel}</button></p></form>`;
  const form = $dlg.querySelector('form');
  form.onsubmit = async ev => {
    ev.preventDefault();
    const btn = form.querySelector('[type=submit]'); if (btn.disabled) return;
    btn.disabled = true; document.getElementById('dlgErr').innerHTML = '';
    try {
      const msg = await onSubmit(new FormData(form), rid, form);
      if (msg === false) { btn.disabled = false; return; }
      $dlg.close(); if (msg) toast(msg); await loadQuiet();
    } catch (e) {
      document.getElementById('dlgErr').innerHTML = `<div class="banner b-err">${esc(errText(e))}</div>`;
      btn.disabled = false;
    }
  };
  $dlg.showModal();
  form.querySelector('input:not([type=hidden]),select,textarea')?.focus();
  return form;
}
const payerSelect = (sel = {}) => `<select class="in" name="payer" data-act="payerSel">
  ${parents().map(p => `<option value="${p.id}" ${sel.payer_member_id === p.id ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}
  <option value="other" ${sel.payer_name ? 'selected' : ''}>מישהו אחר…</option></select>
  <input class="in" name="payer_name" placeholder="שם המשלם" value="${esc(sel.payer_name || '')}" ${sel.payer_name ? '' : 'hidden'} style="margin-top:6px">`;
function readPayer(fd, prefix = '') {
  const v = fd.get(prefix + 'payer');
  return v === 'other' ? { payer_member_id: null, payer_name: String(fd.get(prefix + 'payer_name') || '').trim() } : { payer_member_id: v, payer_name: null };
}
function needMoney(v) { const c = parseMoney(v); if (c === null) throw new Error('סכום לא תקין. כתבו מספר, למשל 10 או 7.5'); return c; }

function dlgIncome(childId) {
  const P = isParent(), k = mem(childId);
  openDialog(P ? `💵 הכנסה ל${esc(k.display_name)}` : '💵 קיבלתי כסף', `
    <label class="f">מאיפה?</label>
    <div class="seg">${['external_job', 'gift', 'allowance', 'other'].map((x, i) => `<label><input type="radio" name="kind" value="${x}" ${i === 1 ? 'checked' : ''}>${KIND[x]}</label>`).join('')}</div>
    <label class="f">כמה? (₪)</label><input class="in" name="amount" inputmode="decimal" required>
    <label class="f">ממי?</label>${P ? payerSelect({ payer_name: ' ' }).replace('value=" "', 'value=""') : '<input class="in" name="payer_name" required placeholder="למשל: סבתא, השכנה">'}
    <label class="f">על מה? (לא חובה)</label><input class="in" name="desc" placeholder="למשל: יום הולדת">
    <label class="f">תאריך</label><input class="in" type="date" name="date" value="${S.today}">
    <label class="f">הכסף כבר אצלי?</label>
    <div class="seg"><label><input type="radio" name="recv" value="1" checked>כן, קיבלתי</label><label><input type="radio" name="recv" value="0">עוד לא, הבטיחו לי</label></div>
    <label class="f">איך?</label><select class="in" name="method">${Object.entries(METHOD).map(([a, b]) => `<option value="${a}">${b}</option>`).join('')}</select>
    ${P ? '' : '<p class="note">הורה יאשר את הדיווח, ורק אז הוא ייכנס לסכומים.</p>'}`,
    async fd => {
      const payer = P ? readPayer(fd) : { payer_member_id: null, payer_name: fd.get('payer_name') };
      const r = await rpc('report_income', { p_request_id: this_rid(fd), p_child_id: childId, p_kind: fd.get('kind'),
        p_amount_cents: needMoney(fd.get('amount')), p_date: fd.get('date') || null, p_source: payer.payer_name, p_payer_member_id: payer.payer_member_id,
        p_description: fd.get('desc'), p_received: fd.get('recv') === '1', p_method: fd.get('method') });
      return r.status === 'pending' ? 'נשלח לאישור הורה 👍' : 'נרשם ✔';
    }, P ? 'רישום' : 'שליחה לאישור');
}
// ה-request id של הדיאלוג נשמר בשדה נסתר, כך שלחיצה כפולה או ניסיון חוזר שולחים אותו מזהה
function this_rid(fd) { return fd.get('_rid'); }

function dlgExpense(childId) {
  const P = isParent(), k = mem(childId), bal = k.totals.balance;
  const f = openDialog(P ? `🛒 הוצאה של ${esc(k.display_name)}` : '🛒 הוצאתי כסף', `
    <label class="f">כמה? (₪)</label><input class="in" name="amount" inputmode="decimal" required data-act="expAmt">
    <label class="f">על מה?</label><input class="in" name="desc" required placeholder="למשל: גלידה">
    <label class="f">תאריך</label><input class="in" type="date" name="date" value="${S.today}" max="${S.today}">
    <div class="small" style="margin-top:8px">נשאר עכשיו: ${money(bal)} · <span id="expAfter"></span></div>
    <div id="expWarn"></div>
    ${P ? '<label class="row" id="negBox" hidden style="margin-top:8px;gap:10px"><input type="checkbox" name="neg" style="width:22px;height:22px"> אני מאשר/ת יתרה שלילית</label>'
      : '<p class="note">הורה יאשר את ההוצאה, ורק אז היא תוריד מהיתרה.</p>'}`,
    async fd => {
      const c = needMoney(fd.get('amount'));
      const r = await rpc('report_expense', { p_request_id: this_rid(fd), p_child_id: childId, p_amount_cents: c, p_date: fd.get('date') || null,
        p_description: fd.get('desc'), p_allow_negative: fd.get('neg') === 'on' });
      return P ? 'ההוצאה נרשמה ✔' : 'נשלח לאישור הורה 👍';
    }, P ? 'רישום' : 'שליחה לאישור');
  f.querySelector('[name=amount]').addEventListener('input', ev => {
    const c = parseMoney(ev.target.value); const after = c === null ? null : bal - c;
    document.getElementById('expAfter').innerHTML = after === null ? '' : `אחרי ההוצאה: ${money(after)}`;
    document.getElementById('expWarn').innerHTML = after !== null && after < 0
      ? `<div class="banner b-warn small" style="margin-top:8px">⚠️ ההוצאה הזו תיצור יתרה שלילית לפי הרישומים. הורה יצטרך לבדוק לפני אישור.</div>` : '';
    const nb = document.getElementById('negBox'); if (nb) nb.hidden = !(after !== null && after < 0);
  });
}

function dlgGoal(id) {
  const m = mem(id), mode = m.goal_mode || 'total';
  openDialog('🎯 יעד חיסכון', `<label class="f">למה חוסכים?</label><input class="in" name="name" value="${esc(m.goal_name || '')}" placeholder="למשל: אופניים">
    <label class="f">כמה צריך? (₪)</label><input class="in" name="amount" inputmode="decimal" value="${m.goal_cents ? fmtNum(m.goal_cents) : ''}">
    <label class="f">איך סופרים את ההתקדמות?</label>
    <div class="seg col">
      <label><input type="radio" name="mode" value="total" ${mode === 'total' ? 'checked' : ''}><span><b>כולל הכסף שכבר בקופה</b><br><span class="small muted">ההתקדמות לפי כל מה שיש בקופה עכשיו (${money(m.totals?.balance || 0)})</span></span></label>
      <label><input type="radio" name="mode" value="fresh" ${mode === 'fresh' ? 'checked' : ''}><span><b>חיסכון חדש מעכשיו</b><br><span class="small muted">מתחילים מאפס: נספר רק מה שנכנס לקופה מעכשיו, פחות הוצאות</span></span></label>
    </div>
    <p class="note">יצירת יעד לא משנה את הכסף בקופה. כדי למחוק יעד, השאירו את השם ריק.${m.goal_name && mode === 'fresh' ? ' שינוי שם או סכום שומר את נקודת ההתחלה.' : ''}</p>`,
    async fd => {
      const name = String(fd.get('name') || '').trim();
      await rpc('set_goal', { p_request_id: this_rid(fd), p_member_id: id, p_name: name, p_cents: name ? needMoney(fd.get('amount')) : null,
        p_mode: fd.get('mode') || 'total' });
      return name ? 'היעד נשמר 🎯' : 'היעד נמחק';
    });
}

// עריכת עבודה מזדמנת: שם, תיאור וסכום
function dlgEditJob(id) {
  const i = S.instances.find(x => x.id === id), appr = i.status === 'approved';
  const inc = appr ? S.incomes.find(x => x.job_instance_id === i.id && x.status === 'active') : null;
  const locked = appr && !inc;           // אושרה לפני האיפוס הכספי: הסכום בארכיון
  openDialog('✏️ עריכת עבודה', `
    <label class="f">שם העבודה</label><input class="in" name="title" required value="${esc(i.title)}">
    <label class="f">תיאור (לא חובה)</label><input class="in" name="desc" value="${esc(i.description || '')}">
    <label class="f">סכום (₪)</label><input class="in" name="price" inputmode="decimal" required value="${fmtNum(i.price_cents)}" ${locked ? 'readonly' : ''}>
    ${locked ? '<p class="note">העבודה מלפני האיפוס הכספי, ולכן אפשר לשנות רק שם ותיאור.</p>' : ''}
    ${appr && inc ? `<div class="banner b-warn small" style="margin-top:8px">העבודה כבר אושרה${inc.paid_cents ? ` ושולמו עליה ${money(inc.paid_cents)}` : ''}.
      שינוי סכום יירשם כתיקון ביומן ו"מגיע" יתעדכן. תשלום שכבר התקבל לא משתנה${inc.paid_cents ? `, לכן אי אפשר לרדת מתחת ל-${money(inc.paid_cents)}` : ''}.</div>
      <label class="f">סיבה (חובה כשמשנים סכום)</label><input class="in" name="reason">` : ''}
    ${isParent() ? '' : '<p class="note">אבא או אמא יאשרו את העבודה ואת הסכום.</p>'}`,
    async fd => {
      await rpc('edit_job', { p_request_id: this_rid(fd), p_instance_id: id, p_title: fd.get('title'), p_description: fd.get('desc'),
        p_price_cents: needMoney(fd.get('price')), p_reason: fd.get('reason') || null });
      return 'נשמר ✔';
    });
}

// ילד מוסיף עבודה קבועה לרשימה שלו: עבודה שכבר קיימת במשפחה או חדשה. ההורה מאשר עבודה ומחיר.
function dlgAddTpl() {
  const me = S.me.id;
  const avail = S.templates.filter(t => t.active && !t.assignees.some(a => a.child_id === me));
  const f = openDialog('🔁 הוספת עבודה קבועה', `
    ${avail.length ? `<label class="f">איזו עבודה?</label><select class="in" name="tpl" data-act="tplPick">
      <option value="">עבודה חדשה…</option>${avail.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}</select>` : ''}
    <div id="newTpl"><label class="f">שם העבודה</label><input class="in" name="title" placeholder="למשל: הוצאת הכלב">
      <label class="f">פרטים (לא חובה)</label><input class="in" name="desc"></div>
    <label class="f">כמה זה שווה בכל פעם? (₪)</label><input class="in" name="price" inputmode="decimal" required>
    <label class="f">מי משלם?</label>${payerSelect({})}
    <p class="note">אבא או אמא יאשרו את העבודה ואת המחיר. אחרי האישור מסמנים "סיימתי" בכל פעם שעושים אותה.</p>`,
    async fd => {
      const p = readPayer(fd);
      if (p.payer_member_id === null && !p.payer_name) throw new Error('כתבו מי משלם');
      const tpl = fd.get('tpl') || null;
      if (!tpl && !String(fd.get('title') || '').trim()) throw new Error('כתבו שם לעבודה');
      await rpc('propose_template', { p_request_id: this_rid(fd), p_child_id: me, p_template_id: tpl, p_title: fd.get('title'),
        p_description: fd.get('desc'), p_price_cents: needMoney(fd.get('price')), p_payer_member_id: p.payer_member_id, p_payer_name: p.payer_name });
      return 'נשלח לאישור הורה 👍';
    }, 'הוספה');
  f.querySelector('[name=tpl]')?.addEventListener('change', ev => { f.querySelector('#newTpl').hidden = !!ev.target.value; });
}

// הורה מאשר עבודה קבועה שילד הוסיף, במחיר אחר
function dlgAssignPrice(tplId, childId) {
  const t = S.templates.find(x => x.id === tplId), a = t.assignees.find(x => x.child_id === childId);
  openDialog('✔ אישור במחיר אחר', `<p><b>${nameOf(childId)} · ${esc(t.title)}</b> · הוצע ${money(a.price_cents)}</p>
    <label class="f">מחיר לכל ביצוע (₪)</label><input class="in" name="price" inputmode="decimal" required value="${fmtNum(a.price_cents)}">`,
    async fd => {
      await rpc('review_assignment', { p_request_id: this_rid(fd), p_template_id: tplId, p_child_id: childId, p_action: 'approve',
        p_price_cents: needMoney(fd.get('price')) });
      return 'אושר ✔';
    }, 'אישור');
}

// "קיבלתי כסף": תשלום על חוב, או כסף אחר (מתנה וכו')
function dlgMoneyIn(id) {
  const owed = mem(id).totals.owed;
  openPanel('💵 קיבלתי כסף', `<p class="note">ממה הכסף?</p>
    <p><button class="btn sky big" data-act="reportReceipt" ${owed ? '' : 'disabled'}>💰 תשלום על מה שמגיע לי</button></p>
    <p class="small muted" style="margin-top:-6px">${owed ? `עבודה או בונוס שאושרו ועוד לא שולמו (מגיע לך ${money(owed)})` : 'כרגע אין כסף שמגיע לך'}</p>
    <p><button class="btn ghost big" data-act="income" data-id="${id}">🎁 כסף אחר: מתנה, דמי כיס…</button></p>`);
}

// ילד: "קיבלתי תשלום" — ממי, כמה ועל אילו חובות. ההורה מאשר.
function dlgReportReceipt() {
  const me = S.me.id, groups = owedGroups(me);
  if (!groups.length) { toast('אין כרגע כסף שמגיע לך'); return; }
  const claimed = id => S.receipts.filter(r => r.status === 'pending').flatMap(r => r.allocations)
    .filter(a => a.income_id === id && a.status === 'pending').reduce((s, a) => s + a.amount_cents, 0);
  const recorded = S.receipts.filter(r => r.child_id === me && r.status === 'active' && r.child_ack === 'none');
  const f = openDialog('💰 קיבלתי תשלום', `
    ${recorded.length ? `<div class="banner b-info small">💌 אבא או אמא כבר רשמו ${recorded.length === 1 ? 'תשלום' : 'תשלומים'} אליך
      (${recorded.map(r => money(r.amount_cents)).join(', ')}). אם זה אותו כסף, רק אשרו במסך הבית, בלי לדווח שוב.</div>` : ''}
    <label class="f">ממי?</label><select class="in" name="grp">${groups.map((gr, i) => `<option value="${i}">${payerName(gr)} · מגיע ${moneyTxt(gr.total)}</option>`).join('')}</select>
    <label class="f">על מה?</label><div class="list" id="grpItems"></div>
    <label class="f">כמה קיבלת? (₪)</label><input class="in" name="amount" inputmode="decimal" required>
    <div class="row"><div class="grow"><label class="f">איך?</label><select class="in" name="method">${Object.entries(METHOD).map(([a, b]) => `<option value="${a}">${b}</option>`).join('')}</select></div>
    <div class="grow"><label class="f">מתי?</label><input class="in" type="date" name="date" value="${S.today}" max="${S.today}"></div></div>
    <p class="note">אפשר לדווח גם על חלק מהסכום. אבא או אמא יאשרו, ורק אז הכסף ייכנס ל"קיבלתי" ולקופה.</p>`,
    async fd => {
      const ids = [...f.querySelectorAll('[name=inc]:checked')].map(x => x.value);
      if (!ids.length) throw new Error('בחרו על מה קיבלתם את הכסף');
      await rpc('report_receipt', { p_request_id: this_rid(fd), p_child_id: me, p_income_ids: ids, p_amount_cents: needMoney(fd.get('amount')),
        p_date: fd.get('date') || null, p_method: fd.get('method'), p_note: null });
      return 'נשלח לאישור הורה 👍';
    }, 'שליחה לאישור');
  const box = f.querySelector('#grpItems'), amt = f.querySelector('[name=amount]');
  const sum = () => [...box.querySelectorAll('[name=inc]:checked')].reduce((a, x) => a + Number(x.dataset.out), 0);
  const fill = () => {
    const gr = groups[+f.querySelector('[name=grp]').value];
    box.innerHTML = gr.items.map(i => { const out = i.amount_cents - i.paid_cents - claimed(i.id);
      return `<label class="item" style="cursor:pointer"><input type="checkbox" name="inc" value="${i.id}" data-out="${Math.max(0, out)}" ${out > 0 ? 'checked' : 'disabled'} style="width:22px;height:22px">
      <div class="grow">${esc(i.description)}<div class="small muted">${fmtDate(i.income_date)} · נשאר ${money(i.amount_cents - i.paid_cents)}${claimed(i.id) ? ` · כבר דיווחת על ${money(claimed(i.id))}` : ''}</div></div></label>`; }).join('');
    amt.value = sum() ? fmtNum(sum()) : '';
  };
  f.querySelector('[name=grp]').addEventListener('change', fill);
  box.addEventListener('change', () => { amt.value = sum() ? fmtNum(sum()) : ''; });
  fill();
}

function dlgJob(tplId, preset) {
  const t = tplId ? S.templates.find(x => x.id === tplId) : null;
  const ks = kids();
  const title = t ? '✏️ עריכת עבודה קבועה' : preset === 'weekly' ? '🔁 עבודה קבועה חדשה' : preset === 'once' ? '⚡ עבודה מזדמנת חדשה' : '➕ עבודה חדשה';
  const f = openDialog(title, `
    ${t ? '' : preset ? `<input type="hidden" name="type" value="${preset}">`
      : `<label class="f">סוג</label><div class="seg"><label><input type="radio" name="type" value="once" checked>חד פעמית</label>
      <label><input type="radio" name="type" value="weekly">קבועה (חוזרת)</label></div>`}
    <label class="f">שם העבודה</label><input class="in" name="title" required value="${esc(t?.title || '')}" placeholder="${preset === 'once' ? 'למשל: סידור המחסן' : 'למשל: שטיפת רכב'}">
    <label class="f">תיאור קצר (לא חובה)</label><input class="in" name="desc" value="${esc(t?.description || '')}">
    <div id="dateBox" ${t || preset === 'weekly' ? 'hidden' : ''}><label class="f">תאריך</label><input class="in" type="date" name="date" value="${S.today}"></div>
    ${t ? `<label class="row" style="gap:10px;margin-top:12px"><input type="checkbox" name="active" ${t.active ? 'checked' : ''} style="width:22px;height:22px"> פעילה</label>` : ''}
    <label class="f">מי מבצע? (סכום נפרד לכל ילד)</label>
    ${ks.map(k => { const a = t?.assignees.find(x => x.child_id === k.id);
      return `<div class="card" style="padding:12px"><label class="row" style="gap:10px"><input type="checkbox" name="k_${k.id}" ${a || (!t && ks.length === 1) ? 'checked' : ''} style="width:22px;height:22px"><b>${avatar(k)} ${esc(k.display_name)}</b></label>
      <div class="row"><div class="grow"><label class="f">מחיר (₪)</label><input class="in" name="p_${k.id}" inputmode="decimal" value="${a ? fmtNum(a.price_cents) : ''}"></div>
      <div class="grow"><label class="f">מי משלם</label>${payerSelect(a || {}).replace(/name="payer"/, `name="${k.id}_payer"`).replace(/name="payer_name"/, `name="${k.id}_payer_name"`)}</div></div></div>`; }).join('')}
    ${t ? '<p class="note">שינוי מחיר משפיע רק על ביצועים עתידיים. עבודות שכבר אושרו נשארות במחיר שסוכם.</p>' : '<p class="note">בעבודה קבועה, כל ביצוע נרשם בנפרד כשהילד לוחץ "סיימתי". אין צבירה אוטומטית.</p>'}`,
    async fd => {
      const assignees = ks.filter(k => fd.get('k_' + k.id) === 'on').map(k => {
        const p = readPayer(fd, k.id + '_');
        if (p.payer_member_id === null && !p.payer_name) throw new Error('חסר שם המשלם עבור ' + k.display_name);
        return { child_id: k.id, price_cents: needMoney(fd.get('p_' + k.id)), ...p };
      });
      if (!assignees.length) throw new Error('בחרו לפחות ילד אחד');
      if (t || fd.get('type') === 'weekly') {
        await rpc('save_template', { p_request_id: this_rid(fd), p_template_id: t?.id || null, p_title: fd.get('title'), p_description: fd.get('desc'),
          p_active: t ? fd.get('active') === 'on' : true, p_assignees: assignees });
      } else {
        await rpc('create_job', { p_request_id: this_rid(fd), p_title: fd.get('title'), p_description: fd.get('desc'), p_date: fd.get('date') || null, p_assignees: assignees });
      }
      return 'העבודה נשמרה ✔';
    });
  f.querySelectorAll('[name=type]').forEach(r => r.addEventListener('change', () => { f.querySelector('#dateBox').hidden = f.querySelector('[name=type]:checked').value === 'weekly'; }));
}

// חלון בלי כפתור שמירה (לבחירה מתוך רשימה)
function openPanel(title, inner) {
  if ($dlg.open) $dlg.close();
  $dlg.innerHTML = `<div class="panel"><div class="row between"><h2 style="margin:0">${title}</h2>
    <button type="button" class="btn ghost sm" data-act="closeDlg" aria-label="סגירה">✕</button></div>${inner}</div>`;
  $dlg.showModal();
}

// ילד: איזו עבודה קבועה סיימת? (וגם הוספה לרשימה)
function dlgFixedPick() {
  const me = S.me.id;
  const tpls = S.templates.filter(t => t.active && t.assignees.some(a => a.child_id === me));
  openPanel('🔁 עבודה קבועה', `${tpls.length ? `<p class="note">איזו עבודה סיימת? ההורה יאשר, ורק אז הסכום ייכנס.</p>
    <div class="list">${tpls.map(t => { const a = t.assignees.find(x => x.child_id === me);
      return `<div class="item"><div class="emo">🔁</div><div class="grow"><b>${esc(t.title)}</b><div class="small muted">${money(a.price_cents)} · משלם: ${payerName(a)}</div></div>
      ${a.approved ? `<button class="btn mint sm" data-act="submit" data-tpl="${t.id}" data-rid="${uuid()}">סיימתי ✓</button>` : chip('c-pending', '⏳ מחכה לאישור')}</div>`; }).join('')}</div>`
    : '<p>עוד אין לך עבודות קבועות ברשימה.</p>'}
    <p><button class="btn sky" data-act="addTpl">➕ הוספת עבודה קבועה לרשימה שלי</button></p>`);
}

// ילד מוסיף עבודה מזדמנת בעצמו
function dlgPropose() {
  openDialog('⚡ עבודה מזדמנת', `
    <label class="f">מה העבודה?</label><input class="in" name="title" required placeholder="למשל: סידור המחסן">
    <label class="f">פרטים (לא חובה)</label><input class="in" name="desc">
    <label class="f">כמה זה שווה? (₪)</label><input class="in" name="price" inputmode="decimal" required>
    <label class="f">מי משלם?</label>${payerSelect({})}
    <label class="f">מה המצב?</label>
    <div class="seg"><label><input type="radio" name="done" value="1" checked>כבר עשיתי</label><label><input type="radio" name="done" value="0">אני רוצה לעשות</label></div>
    <label class="f">תאריך</label><input class="in" type="date" name="date" value="${S.today}">
    <p class="note">ההורה יאשר את העבודה ואת המחיר. רק אחרי אישור הסכום נכנס ל"הרווחתי".</p>`,
    async fd => {
      const p = readPayer(fd);
      if (p.payer_member_id === null && !p.payer_name) throw new Error('כתבו מי משלם');
      const r = await rpc('propose_job', { p_request_id: this_rid(fd), p_child_id: S.me.id, p_title: fd.get('title'), p_description: fd.get('desc'),
        p_price_cents: needMoney(fd.get('price')), p_payer_member_id: p.payer_member_id, p_payer_name: p.payer_name,
        p_date: fd.get('date') || null, p_done: fd.get('done') === '1' });
      return r.status === 'pending' ? 'נשלח לאישור הורה 👍' : 'נוסף לרשימה שלך 👍';
    }, 'הוספה');
}

// בונוס מאבא או מאמא: הורה רושם מיד, ילד שולח לאישור
function dlgBonus(childId) {
  const P = isParent(), ps = parents();
  openDialog('⭐ בונוס מאבא/אמא', `
    ${childId ? '' : `<label class="f">למי?</label><select class="in" name="child">${kids().map(k => `<option value="${k.id}">${esc(k.display_name)}</option>`).join('')}</select>`}
    <label class="f">ממי?</label>
    <div class="seg">${ps.map((p, i) => `<label><input type="radio" name="from" value="${p.id}" ${(P ? p.id === S.me.id : i === 0) ? 'checked' : ''}>${esc(p.display_name)}</label>`).join('')}</div>
    <label class="f">כמה? (₪)</label><input class="in" name="amount" inputmode="decimal" required>
    <label class="f">על מה?</label><input class="in" name="desc" required placeholder="למשל: תעודה טובה">
    <label class="f">${P ? 'הכסף כבר ניתן?' : 'הכסף כבר אצלי?'}</label>
    <div class="seg"><label><input type="radio" name="recv" value="1" checked>כן</label><label><input type="radio" name="recv" value="0">עוד לא (יירשם ב"מגיע לי")</label></div>
    <p class="note">${P ? 'בונוס לא נותן נקודות בתחרות העבודות.' : 'ההורה יאשר את הבונוס, ורק אז הוא ייכנס לסכומים.'}</p>`,
    async fd => {
      const r = await rpc('report_income', { p_request_id: this_rid(fd), p_child_id: childId || fd.get('child'), p_kind: 'bonus',
        p_amount_cents: needMoney(fd.get('amount')), p_date: null, p_source: null, p_payer_member_id: fd.get('from'),
        p_description: fd.get('desc'), p_received: fd.get('recv') === '1', p_method: 'cash' });
      return r.status === 'pending' ? 'נשלח לאישור הורה 👍' : 'הבונוס נרשם ⭐';
    }, P ? 'רישום' : 'שליחה לאישור');
}

function dlgReview(id, action) {
  const i = S.instances.find(x => x.id === id);
  const T = { approve: '✔ אישור עבודה', needs_fix: '🔧 בקשת תיקון', cancel: 'ביטול עבודה', edit_price: 'שינוי מחיר', reopen: '↩️ העבודה לא בוצעה' };
  openDialog(T[action], `<p><b>${nameOf(i.child_id)} · ${esc(i.title)}</b> · ${money(i.price_cents)}</p>
    ${action === 'approve' || action === 'edit_price' ? `<label class="f">מחיר (₪)</label><input class="in" name="price" inputmode="decimal" value="${fmtNum(i.price_cents)}" required>` : ''}
    <label class="f">${action === 'needs_fix' ? 'מה צריך לתקן?' : 'הערה (לא חובה)'}</label><input class="in" name="note" ${action === 'needs_fix' ? 'required' : ''}>
    ${action === 'approve' ? '<p class="note">אחרי האישור המחיר נשמר כפי שסוכם, והסכום נרשם כחוב לילד עד שישולם.</p>' : ''}
    ${action === 'reopen' ? `<p class="note">${i.template_id ? 'הסימון יבוטל. העבודה הקבועה נשארת, ואפשר לסמן אותה שוב כשתבוצע.' : 'העבודה תחזור ל"לביצוע".'} שום סכום לא נרשם.</p>` : ''}`,
    async fd => {
      await rpc('review_job', { p_request_id: this_rid(fd), p_instance_id: id, p_action: action, p_note: fd.get('note'),
        p_price_cents: fd.get('price') ? needMoney(fd.get('price')) : null });
      return action === 'approve' ? 'אושר ✔' : 'נשמר ✔';
    });
}

function dlgVoid(kind, id) {
  const o = (kind === 'income' ? S.incomes : kind === 'receipt' ? S.receipts : S.expenses).find(x => x.id === id);
  const paid = kind === 'income' ? o.paid_cents : 0;
  const L = { income: 'ביטול הכנסה', receipt: 'ביטול תשלום', expense: 'ביטול הוצאה' };
  openDialog('↩️ ' + L[kind], `<p>${money(o.amount_cents)} · ${esc(o.description || o.note || '')}</p>
    <p class="note">הרישום לא נמחק. הוא יסומן כמבוטל, ויישמר מי ביטל, מתי ולמה.</p>
    ${paid > 0 ? `<div class="banner b-warn small">על ההכנסה הזו כבר שולמו ${money(paid)}. מה לעשות בכסף?</div>
      <div class="seg"><label><input type="radio" name="mode" value="keep_as_gift" required>הכסף נשאר אצל הילד (יירשם כמתנה)</label>
      <label><input type="radio" name="mode" value="void_payments">גם התשלומים בוטלו (הכסף הוחזר או נרשם בטעות)</label></div>` : ''}
    ${kind === 'income' && o.job_instance_id ? '<p class="note">העבודה תחזור למצב "ממתין לאישור", והנקודה שלה בתחרות תוסר.</p>' : ''}
    <label class="f">למה?</label><input class="in" name="reason" required>`,
    async fd => {
      await rpc('void_record', { p_request_id: this_rid(fd), p_kind: kind, p_id: id, p_reason: fd.get('reason'), p_mode: fd.get('mode') || null });
      return 'בוטל ונשמר ביומן ✔';
    }, 'ביטול');
}

function dlgAckNo(id) {
  openDialog('✋ לא קיבלתי', `<p class="note">ההורים יראו שצריך לבדוק את התשלום הזה.</p><label class="f">רוצה להוסיף משהו?</label><input class="in" name="note">`,
    async fd => { await rpc('ack_receipt', { p_request_id: this_rid(fd), p_receipt_id: id, p_status: 'disputed', p_note: fd.get('note') }); return 'נשלח להורים'; }, 'שליחה');
}

function dlgMember(id) {
  const m = id ? mem(id) : null;
  openDialog(m ? 'עריכת בן משפחה' : '➕ בן משפחה חדש', `
    ${m ? '' : `<div class="banner b-info small">קודם יוצרים משתמש ב-Supabase (Authentication → Users → Add user), ואז מוסיפים אותו כאן עם אותו שם משתמש.</div>
      <label class="f">שם משתמש</label><input class="in" name="email" required dir="ltr" autocapitalize="off" placeholder="kid1">
      <label class="f">תפקיד</label><div class="seg"><label><input type="radio" name="role" value="child" checked>ילד/ה</label><label><input type="radio" name="role" value="parent">הורה</label></div>`}
    <label class="f">שם לתצוגה</label><input class="in" name="name" required value="${esc(m?.display_name || '')}">
    <label class="f">פנייה</label><div class="seg"><label><input type="radio" name="gender" value="f" ${!m || m.gender === 'f' ? 'checked' : ''}>נקבה</label><label><input type="radio" name="gender" value="m" ${m?.gender === 'm' ? 'checked' : ''}>זכר</label></div>
    ${m ? `<label class="row" style="gap:10px;margin-top:12px"><input type="checkbox" name="active" ${m.active ? 'checked' : ''} style="width:22px;height:22px"> פעיל</label>` : ''}`,
    async fd => {
      if (m) await rpc('update_member', { p_request_id: this_rid(fd), p_member_id: id, p_display_name: fd.get('name'), p_gender: fd.get('gender'), p_active: fd.get('active') === 'on' });
      else { let e = String(fd.get('email')).trim().toLowerCase(); if (!e.includes('@')) e += '@' + (CFG.LOGIN_DOMAIN || 'example.com');
        await rpc('add_member', { p_request_id: this_rid(fd), p_email: e, p_display_name: fd.get('name'), p_role: fd.get('role'), p_gender: fd.get('gender') }); }
      return 'נשמר ✔';
    });
}

// יתרת פתיחה נרשמת פעם אחת; אחר כך רק הורה מתקן, עם סיבה שנשמרת ביומן
function dlgOpening(id) {
  const m = mem(id), fix = m.opening_set, P = isParent();
  openDialog(fix ? '✏️ תיקון יתרה · ' + esc(m.display_name) : '🐷 יתרת פתיחה' + (P ? ' · ' + esc(m.display_name) : ''), `
    <p class="note">${fix ? `תיקון ידני של יתרת הפתיחה, למשל אם נספר לא נכון. התיקון נרשם ביומן עם הסיבה ומוצג בקופה.
      עכשיו בקופה: ${money(m.totals.balance)} (מתוכם יתרת פתיחה ${money(m.totals.opening)}).`
      : `כמה כסף היה ${P ? 'ל' + esc(m.display_name) : 'לך'} לפני שהתחלתם להשתמש באפליקציה? זו לא הכנסה חדשה ולא נותנת נקודות.
      כל תשלום מכאן והלאה יתווסף לסכום הזה.${P ? '' : ' אחרי השמירה, שינוי עושים רק אבא או אמא.'}`}</p>
    <label class="f">${fix ? 'יתרת פתיחה מתוקנת (₪)' : 'סכום (₪)'}</label><input class="in" name="amount" inputmode="decimal" required value="${fix ? fmtNum(m.totals.opening) : ''}">
    ${fix ? '<label class="f">למה מתקנים?</label><input class="in" name="reason" required>' : ''}`,
    async fd => {
      const v = String(fd.get('amount')).trim(); const c = /^0+([.,]0*)?$/.test(v) ? 0 : needMoney(v);
      await rpc('set_opening_balance', { p_request_id: this_rid(fd), p_member_id: id, p_cents: c, p_reason: fd.get('reason') || null });
      return fix ? 'היתרה תוקנה ✔' : 'נשמר 🐷';
    });
}

// ------------------------------------------------------- איפוס כספי
async function resetPreview() {
  const out = document.getElementById('resetOut');
  out.innerHTML = '<p>בודק…</p>';
  try {
    const p = await rpc('money_reset_preview');
    out.innerHTML = `<h3 style="margin-top:14px">מה יתאפס עכשיו</h3>
      <table class="mini"><tr><td><b>ילד</b></td><td>פתיחה</td><td>קיבל</td><td>הוצאות</td><td>מגיע</td><td>בקופה</td></tr>
      ${p.kids.map(k => `<tr><td><b>${esc(k.name)}</b></td><td>${money(k.opening)}</td><td>${money(k.received)}</td><td>${money(k.spent)}</td><td>${money(k.owed)}</td><td>${money(k.balance)}</td></tr>`).join('')}</table>
      <p class="small">כל הסכומים בטבלה יהיו 0. ${p.records} רישומים כספיים יעברו לארכיון${p.pending ? `, כולל ${p.pending} דיווחים שעוד ממתינים לאישור` : ''}.
      ${p.goals ? `${p.goals} יעדי חיסכון יישארו (שם וסכום), וההתקדמות שלהם תתחיל מאפס.` : ''}</p>
      ${p.open_jobs ? `<p class="small">🧹 ${p.open_jobs} עבודות פתוחות (לביצוע או ממתינות) יישארו. אם תאשרו אותן אחרי האיפוס, הן ייצרו חוב חדש.</p>` : ''}
      <label class="f" for="resetConfirm">כדי לאשר כתבו: איפוס</label><input class="in" id="resetConfirm" autocomplete="off">
      <p><button class="btn berry" data-act="resetMoney" data-rid="${uuid()}">איפוס הכסף עכשיו</button></p>`;
  } catch (e) { out.innerHTML = `<div class="banner b-err">${esc(errText(e))}</div>`; }
}

// ------------------------------------------------------- התראות פוש
// אנדרואיד: עובד בכרום בלי התקנה. אייפון (iOS 16.4+): רק אחרי "הוספה למסך הבית" ופתיחה משם.
const PUSH_URL = () => CFG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/push';
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function pushStatus() {
  if (!pushSupported()) return isIOS() && !isStandalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg && await reg.pushManager.getSubscription() ? 'on' : 'off';
  } catch { return 'off'; }
}
async function refreshPushCard() {
  const el = document.getElementById('pushCard'); if (!el) return;
  const st = await pushStatus(); if (!el.isConnected) return;
  const T = {
    on: ['🔔 התראות לטלפון פעילות', 'במכשיר הזה תגיע הודעה גם כשהאתר סגור.', '<button class="btn ghost sm" data-act="pushOff">כיבוי</button>'],
    off: ['🔔 התראות לטלפון', 'הודעה קצרה על עבודה שאושרה, תשלום שנרשם ועוד, גם כשהאתר סגור.', '<button class="btn sm" data-act="pushOn">הפעלת התראות</button>'],
    denied: ['🔕 ההתראות חסומות', 'ההתראות נחסמו בדפדפן. אפשר לאפשר אותן בהגדרות האתר בדפדפן ולחזור לכאן.', ''],
    'ios-install': ['🔔 התראות באייפון', 'באייפון ההתראות עובדות רק מהאייקון שבמסך הבית: בספארי לוחצים על כפתור השיתוף, בוחרים "הוספה למסך הבית", פותחים את האתר משם ומפעילים כאן. (צריך iOS 16.4 ומעלה)', ''],
    unsupported: ['🔔 התראות', 'הדפדפן הזה לא תומך בהתראות כשהאתר סגור. באנדרואיד נסו בכרום.', '']
  }[st];
  el.innerHTML = `<div class="card" style="margin-top:16px"><div class="row between"><h3 style="margin:0">${T[0]}</h3>${T[2]}</div>
    <p class="small muted" style="margin-bottom:0">${T[1]}</p></div>`;
}
const b64uBytes = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
async function pushOn() {
  if (!pushSupported()) throw new Error('הדפדפן הזה לא תומך בהתראות');
  const perm = await Notification.requestPermission();        // הבקשה מוצגת רק אחרי הלחיצה על "הפעלת התראות"
  if (perm !== 'granted') throw new Error('לא ניתנה הרשאה להתראות');
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const r = await fetch(PUSH_URL(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { publicKey } = await r.json().catch(() => ({}));
    if (!publicKey) throw new Error('שירות ההתראות לא זמין כרגע. נסו שוב מאוחר יותר.');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(publicKey) });
  }
  const j = sub.toJSON();
  await rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
  return 'ההתראות הופעלו 🔔';
}
async function pushOff() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) { await rpc('delete_push_subscription', { p_endpoint: sub.endpoint }); await sub.unsubscribe(); }
  return 'ההתראות כובו';
}

function dlgResetPw(id) {
  const m = mem(id);
  openDialog('🔑 איפוס סיסמה · ' + esc(m.display_name), `<p class="note">בחרו סיסמה חדשה (לפחות 6 תווים) ומסרו אותה ל${esc(m.display_name)} בעל פה.</p>
    <label class="f">סיסמה חדשה</label><input class="in" name="pw" type="password" autocomplete="new-password" minlength="6" required dir="ltr">
    <label class="f">שוב, לאימות</label><input class="in" name="pw2" type="password" autocomplete="new-password" minlength="6" required dir="ltr">`,
    async fd => {
      if (fd.get('pw') !== fd.get('pw2')) throw new Error('הסיסמאות לא זהות');
      await rpc('reset_child_password', { p_member_id: id, p_new_password: fd.get('pw') });
      return 'הסיסמה עודכנה ✔';
    }, 'איפוס');
}

// --------------------------------------------------------------- backup
async function doExport() {
  const data = await rpc('export_family');
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `kesef-backup-${todayJ()}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return data;
}
const countsTxt = c => Object.entries(c).map(([k, v]) => `${k}: ${v}`).join(' · ');
async function restoreFlow(file) {
  const out = document.getElementById('restoreOut');
  let data;
  try { data = JSON.parse(await file.text()); } catch { out.innerHTML = '<div class="banner b-err">הקובץ לא תקין</div>'; return; }
  out.innerHTML = '<p>בודק את הקובץ…</p>';
  try {
    const dry = await rpc('restore_family', { p_backup: data, p_dry_run: true });
    if (!dry.ok) { out.innerHTML = `<div class="banner b-err">הבדיקה נכשלה: ${esc((dry.mismatch || []).join(', '))}</div>`; return; }
    out.innerHTML = `<div class="banner b-ok">✔ ניסיון השחזור עבר (שום דבר עוד לא השתנה).<div class="small">${esc(countsTxt(dry.counts))}</div></div>
      <div class="banner b-warn">שחזור יחליף את כל הנתונים הנוכחיים בנתונים מהקובץ (מ-${esc(fmtDT(data.exported_at))}). עותק של המצב הנוכחי נשמר במסד.</div>
      <label class="f">כדי לאשר כתבו: שחזור</label><input class="in" id="restoreConfirm">
      <p><button class="btn berry" id="restoreGo">שחזור עכשיו</button></p>`;
    document.getElementById('restoreGo').onclick = async ev => {
      if (document.getElementById('restoreConfirm').value.trim() !== 'שחזור') return alert('כתבו "שחזור" כדי לאשר');
      ev.target.disabled = true;
      try {
        const r = await rpc('restore_family', { p_backup: data, p_dry_run: false });
        out.innerHTML = r.ok ? `<div class="banner b-ok">✔ השחזור הושלם ואומת מול הקובץ.<div class="small">${esc(countsTxt(r.counts))}</div>
          ${r.unlinked?.length ? `<div class="small">צריך לחבר מחדש משתמשים: ${esc(r.unlinked.join(', '))}</div>` : ''}</div>` : '<div class="banner b-err">השחזור נכשל ובוטל. הנתונים לא השתנו.</div>';
        await load();
      } catch (e) { out.innerHTML = `<div class="banner b-err">${esc(errText(e))}</div>`; }
    };
  } catch (e) { out.innerHTML = `<div class="banner b-err">${esc(errText(e))}</div>`; }
}
async function testRestore() {
  const out = document.getElementById('restoreOut');
  out.innerHTML = '<p>מייצא ובודק…</p>';
  try {
    const data = await rpc('export_family');
    const r = await rpc('restore_family', { p_backup: data, p_dry_run: true });
    out.innerHTML = r.ok ? `<div class="banner b-ok">✔ בדיקת שחזור עברה: הגיבוי שוחזר בניסיון והתאים לנתונים, ואז בוטל. שום דבר לא השתנה.<div class="small">${esc(countsTxt(r.counts))}</div></div>`
      : `<div class="banner b-err">בדיקת שחזור נכשלה: ${esc((r.mismatch || []).join(', '))}</div>`;
  } catch (e) { out.innerHTML = `<div class="banner b-err">${esc(errText(e))}</div>`; }
}

// --------------------------------------------------------- event wiring
// פעולה מכפתור: הצלחה = ענן קצר (אם יש מה להגיד) ורענון מיידי; כישלון = ענן שגיאה קצר
async function runBtn(btn, fn) {
  if (btn.disabled) return; btn.disabled = true;
  try { const msg = await fn(); if (msg) toast(msg); await loadQuiet(); }
  catch (e) { toastErr(e); btn.disabled = false; }
}

document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT' || b.type === 'radio') return;
  const d = b.dataset;
  switch (d.act) {
    case 'tab': view.tab = d.tab; if (S) render(); window.scrollTo(0, 0); break;
    case 'openChild': view = { tab: 'child', childId: d.id }; render(); window.scrollTo(0, 0); break;
    case 'logout': stopLive(); sb.auth.signOut(); break;
    case 'reload': location.reload(); break;
    case 'renderLogin': renderLogin(); break;
    case 'pickProfile': renderLogin(d.email); break;
    case 'forgetProfile': forgetProfile(d.email); renderLogin(); break;
    case 'closeDlg': $dlg.close(); break;
    case 'income': dlgIncome(d.id); break;
    case 'expense': dlgExpense(d.id); break;
    case 'goal': dlgGoal(d.id); break;
    case 'jobForm': dlgJob(d.id); break;
    case 'review': dlgReview(d.id, d.a); break;
    case 'void': dlgVoid(d.kind, d.id); break;
    case 'ackNo': dlgAckNo(d.id); break;
    case 'editMember': dlgMember(d.id); break;
    case 'addMember': dlgMember(null); break;
    case 'opening': dlgOpening(d.id); break;
    case 'resetPw': dlgResetPw(d.id); break;
    case 'sound': try { localStorage.setItem('kesef-sound', soundOn() ? 'off' : 'on'); } catch { }
      if (soundOn()) { audioCtx(); setTimeout(chime, 60); } render(); break;
    case 'addFixed': isParent() ? dlgJob(null, 'weekly') : dlgFixedPick(); break;
    case 'addOnce': isParent() ? dlgJob(null, 'once') : dlgPropose(); break;
    case 'addBonus': dlgBonus(isParent() ? (view.tab === 'child' ? view.childId : null) : S.me.id); break;
    case 'addTpl': dlgAddTpl(); break;
    case 'editJob': dlgEditJob(d.id); break;
    case 'moneyIn': dlgMoneyIn(d.id); break;
    case 'reportReceipt': dlgReportReceipt(); break;
    case 'assignPrice': dlgAssignPrice(d.tpl, d.child); break;
    case 'unassign': if (!armed(b, '✔ כן, להסיר')) break;
      runBtn(b, async () => {
        await rpc('remove_template_assignment', { p_request_id: d.rid, p_template_id: d.tpl, p_child_id: d.child }); return 'הוסר מהרשימה';
      }); break;
    case 'reviewAssign': runBtn(b, async () => {
      await rpc('review_assignment', { p_request_id: d.rid, p_template_id: d.tpl, p_child_id: d.child, p_action: d.a, p_price_cents: null });
      return d.a === 'approve' ? 'אושר ✔' : 'נדחה';
    }); break;
    case 'reviewReceipt': runBtn(b, async () => {
      await rpc('review_receipt', { p_request_id: d.rid, p_receipt_id: d.id, p_action: d.a, p_note: null });
      return d.a === 'approve' ? 'התשלום אושר 💰' : 'נדחה';
    }); break;
    case 'voidReceipt': if (!armed(b, '✔ כן, לבטל את התשלום')) break;
      runBtn(b, async () => {
        await rpc('void_record', { p_request_id: d.rid, p_kind: 'receipt', p_id: d.id, p_reason: 'התשלום בוטל על ידי הורה', p_mode: null });
        return null;                        // בלי הודעה: המסך מתעדכן מיד
      }); break;
    case 'resetPreview': resetPreview(); break;
    case 'resetMoney': { const v = (document.getElementById('resetConfirm')?.value || '').trim();
      if (v !== 'איפוס') { toast('כדי לאפס כתבו בתיבה: איפוס', 'err'); break; }
      runBtn(b, async () => {
        await doExport();
        await rpc('reset_money', { p_request_id: d.rid, p_confirm: v });
        return 'הכסף אופס ✔ עכשיו אפשר לרשום יתרת פתיחה לכל ילד';
      }); } break;
    case 'pushOn': runBtn(b, pushOn); break;
    case 'pushOff': runBtn(b, pushOff); break;
    case 'submit': if ($dlg.open) $dlg.close(); runBtn(b, async () => {
      await rpc('submit_job', { p_request_id: d.rid, p_instance_id: d.inst || null, p_template_id: d.tpl || null, p_child_id: d.child || null, p_note: null });
      return isParent() ? 'נרשם. אפשר לאשר במסך האישורים.' : 'כל הכבוד! 🎉 נשלח לאישור הורה';
    }); break;
    case 'withdraw': if (!armed(b, '✔ כן, לבטל')) break;
      runBtn(b, async () => {
        await rpc('withdraw_report', { p_request_id: d.rid, p_kind: d.kind, p_id: d.id }); return 'בוטל ✔';
      }); break;
    case 'approveJob': runBtn(b, async () => {
      await rpc('review_job', { p_request_id: d.rid, p_instance_id: d.id, p_action: 'approve', p_note: null, p_price_cents: null }); return 'אושר ✔';
    }); break;
    case 'reviewIncome': runBtn(b, async () => {
      await rpc('review_income', { p_request_id: d.rid, p_income_id: d.id, p_action: d.a, p_note: null }); return d.a === 'approve' ? 'אושר ✔' : 'נדחה';
    }); break;
    case 'reviewExpense': if (d.neg === '1' && !armed(b, '✔ כן, לאשר עם יתרה שלילית')) break;
      runBtn(b, async () => {
      await rpc('review_expense', { p_request_id: d.rid, p_expense_id: d.id, p_action: d.a, p_note: null, p_allow_negative: d.neg === '1' });
      return d.a === 'approve' ? 'אושר ✔' : 'נדחה';
    }); break;
    case 'ack': runBtn(b, async () => {
      await rpc('ack_receipt', { p_request_id: d.rid, p_receipt_id: d.id, p_status: d.st, p_note: null }); return 'תודה! ✔';
    }); break;
    case 'exportBackup': runBtn(b, async () => { await doExport(); return 'הגיבוי ירד למכשיר ✔'; }); break;
    case 'testRestore': testRestore(); break;
  }
});
document.addEventListener('change', ev => {
  const t = ev.target, a = t.dataset?.act;
  if (a === 'histFilter') { filters.histType = t.value; render(); }
  else if (a === 'compMonth') { filters.compMonth = t.value; render(); }
  else if (a === 'feedChild') { filters.feedChild = t.value; render(); }
  else if (a === 'feedMonth') { filters.feedMonth = t.value; render(); }
  else if (a === 'feedKind') { filters.feedKind = t.value; render(); }
  else if (a === 'payerSel') { const n = t.nextElementSibling; if (n) { n.hidden = t.value !== 'other'; n.required = t.value === 'other'; } }
  else if (t.id === 'restoreFile' && t.files[0]) restoreFlow(t.files[0]);
});

function bindForms() {
  document.querySelectorAll('form.payForm').forEach(form => {
    const sum = () => [...form.querySelectorAll('[name=inc]:checked')].reduce((a, x) => a + Number(x.dataset.out), 0);
    form.querySelectorAll('[name=inc]').forEach(c => c.addEventListener('change', () => { form.amount.value = fmtNum(sum()); }));
    form.onsubmit = async ev => {
      ev.preventDefault();
      const btn = form.querySelector('[type=submit]'); if (btn.disabled) return;
      const errBox = form.querySelector('.formErr'); errBox.innerHTML = '';
      try {
        const ids = [...form.querySelectorAll('[name=inc]:checked')].map(x => x.value);
        if (!ids.length) throw new Error('בחרו לפחות פריט אחד');
        const c = needMoney(form.amount.value);
        if (c > sum()) throw new Error('הסכום גבוה מהחוב שנבחר. כסף נוסף רשמו בנפרד כמתנה.');
        btn.disabled = true;
        await rpc('record_payment', { p_request_id: form.dataset.rid, p_child_id: form.dataset.child, p_income_ids: ids, p_amount_cents: c,
          p_date: form.date.value || null, p_method: form.method.value, p_note: null });
        toast('התשלום נרשם 💰'); await loadQuiet();
      } catch (e) { errBox.innerHTML = `<div class="banner b-err">${esc(errText(e))}</div>`; btn.disabled = false; }
    };
  });
  const sf = document.getElementById('settingsForm');
  if (sf) sf.onsubmit = async ev => {
    ev.preventDefault(); const btn = sf.querySelector('button'); btn.disabled = true;
    try {
      const pd = sf.payday.value;
      await rpc('update_settings', { p_request_id: sf.dataset.rid, p_competition_enabled: sf.comp.checked, p_payday: pd === '' ? null : Number(pd) });
      toast('נשמר ✔'); await load();
    } catch (e) { sf.querySelector('.formErr').innerHTML = `<div class="banner b-err">${esc(errText(e))}</div>`; btn.disabled = false; }
  };
}

start();
