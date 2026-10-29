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
const KIND = { job: '🏠 עבודה בבית', external_job: '🧰 עבודה בחוץ', gift: '🎁 מתנה', allowance: '🪙 דמי כיס', other: '✨ אחר' };
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

async function load() {
  if (loading) return; loading = true;
  try {
    S = await rpc('get_state');
    if (!view.tab) view.tab = isParent() ? 'approvals' : 'home';
    render();
  } finally { loading = false; }
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
const TABS_PARENT = [['approvals', '✅', 'אישורים'], ['pay', '💸', 'תשלומים'], ['jobs', '🧹', 'עבודות'], ['family', '👨‍👩‍👧', 'משפחה'], ['admin', '⚙️', 'ניהול']];

function pendingCount() {
  if (!isParent()) return 0;
  return S.instances.filter(i => i.status === 'pending').length + S.incomes.filter(i => i.status === 'pending').length
    + S.expenses.filter(e => e.status === 'pending').length + S.receipts.filter(r => r.status === 'active' && r.child_ack === 'disputed').length;
}

function render() {
  const tabs = isParent() ? TABS_PARENT : TABS_CHILD;
  const pc = pendingCount();
  $tabs.hidden = false;
  $tabs.innerHTML = tabs.map(([k, ic, l]) => `<button data-act="tab" data-tab="${k}" class="${view.tab === k ? 'on' : ''}" aria-current="${view.tab === k ? 'page' : 'false'}">
    <span aria-hidden="true">${ic}</span>${l}${k === 'approvals' && pc ? `<b class="badge">${pc}</b>` : ''}</button>`).join('');
  const top = `<div class="top"><div class="who">${esc(S.family.name)}${S.family.is_test ? ' · 🧪 משפחת בדיקה' : ''}</div>
    <div class="row"><span class="who">${avatar(S.me)} ${esc(S.me.display_name)}</span>
    <button class="btn ghost sm" data-act="logout">החלפת משתמש</button></div></div>`;
  let body = '';
  const t = view.tab;
  if (t === 'home') body = renderChildHome(S.me.id);
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
    <div class="stat s-left"><div class="ic" aria-hidden="true">🐷</div><div class="lbl">נשאר לי</div><div class="val">${money(t.balance)}</div><div class="sub">פתיחה + קיבלתי − הוצאות</div></div>
  </div>
  <p class="note">ℹ️ "נשאר לי" הוא סכום לפי הרישומים באפליקציה. האפליקציה אינה חשבון בנק ואינה מעבירה כסף.</p>`;
}

function goalCard(m, canEdit) {
  if (!m.goal_name) return canEdit ? `<div class="card row between"><div>🎯 עוד אין יעד חיסכון</div>
    <button class="btn sm" data-act="goal" data-id="${m.id}">הגדרת יעד</button></div>` : '';
  const bal = m.totals?.balance;
  return `<div class="card"><div class="row between"><h3>🎯 ${esc(m.goal_name)}</h3>${canEdit ? `<button class="btn ghost sm" data-act="goal" data-id="${m.id}">שינוי</button>` : ''}</div>
    <div class="bar" role="progressbar" aria-valuenow="${m.goal_pct}" aria-valuemin="0" aria-valuemax="100" aria-label="התקדמות ליעד"><i style="width:${m.goal_pct}%"></i></div>
    <div class="row between small" style="margin-top:6px"><span><b>${m.goal_pct}%</b> מהיעד</span>
    <span>${bal !== undefined ? `${money(Math.max(0, bal))} מתוך ` : 'יעד: '}${money(m.goal_cents)}</span></div>
    <p class="note">ההתקדמות לפי מה שנשאר לך בפועל, בלי כסף שעדיין חייבים לך.</p></div>`;
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
    + S.instances.filter(i => i.child_id === id && i.status === 'pending').length;
  return `<h1>${g(m, 'היי', 'היי')} ${esc(m.display_name)} 👋</h1>
    ${ackList(id)}
    ${statCards(m)}
    ${pend ? `<div class="banner b-info">⏳ יש ${pend} ${pend === 1 ? 'רישום שממתין' : 'רישומים שממתינים'} לאישור הורה. הם עוד לא נספרים בסכומים.</div>` : ''}
    <div class="actions">
      <button class="btn mint" data-act="tab" data-tab="jobs"><span aria-hidden="true">✅</span>סיימתי עבודה</button>
      <button class="btn sky" data-act="income" data-id="${id}"><span aria-hidden="true">💵</span>קיבלתי כסף</button>
      <button class="btn berry" data-act="expense" data-id="${id}"><span aria-hidden="true">🛒</span>הוצאתי כסף</button>
    </div><h2>היעד שלי</h2>${goalCard(m, true)}`;
}

// --------------------------------------------------------------- jobs
function renderChildJobs() {
  const me = S.me.id;
  const tpls = S.templates.filter(t => t.active && t.assignees.some(a => a.child_id === me));
  const inst = S.instances.filter(i => i.child_id === me);
  const open = inst.filter(i => i.status === 'todo' || i.status === 'needs_fix');
  const pend = inst.filter(i => i.status === 'pending');
  const done = inst.filter(i => i.status === 'approved' || i.status === 'cancelled').slice(0, 15);
  return `<h1>🧹 עבודות</h1>
    ${open.length ? `<h2>לביצוע</h2>${open.map(i => `<div class="card"><div class="row between"><h3>${esc(i.title)}</h3>${jobChip(i.status)}</div>
      ${i.description ? `<div class="muted small">${esc(i.description)}</div>` : ''}
      ${i.status === 'needs_fix' && i.note ? `<div class="banner b-warn small" style="margin-top:8px">🔧 ${esc(i.note)}</div>` : ''}
      <div class="row between" style="margin-top:8px"><span>${money(i.price_cents)} · משלם: ${payerName(i)}</span>
      <button class="btn mint" data-act="submit" data-inst="${i.id}" data-rid="${uuid()}">סיימתי ✓</button></div></div>`).join('')}` : ''}
    <h2>עבודות קבועות</h2>
    ${tpls.length ? tpls.map(t => { const a = t.assignees.find(x => x.child_id === me); const waiting = pend.filter(p => p.template_id === t.id).length;
      return `<div class="card"><div class="row between"><h3>🔁 ${esc(t.title)}</h3><span>${money(a.price_cents)}</span></div>
      ${t.description ? `<div class="muted small">${esc(t.description)}</div>` : ''}
      <div class="row between" style="margin-top:8px"><span class="small muted">משלם: ${payerName(a)}${waiting ? ` · ${waiting} ממתין לאישור` : ''}</span>
      <button class="btn mint" data-act="submit" data-tpl="${t.id}" data-rid="${uuid()}">סיימתי ✓</button></div></div>`; }).join('')
      : '<p class="muted">אין כרגע עבודות קבועות.</p>'}
    ${pend.length ? `<h2>ממתין לאישור</h2><div class="card list">${pend.map(i => instRow(i) + withdrawBtn('job', i.id, 'סימנתי בטעות')).join('')}</div>` : ''}
    ${done.length ? `<h2>לאחרונה</h2><div class="card list">${done.map(instRow).join('')}</div>` : ''}`;
}
const withdrawBtn = (kind, id, label) => `<div class="row" style="padding-bottom:10px">
  <button class="btn ghost sm" data-act="withdraw" data-kind="${kind}" data-id="${id}" data-rid="${uuid()}">↩️ ${label}</button></div>`;
const instRow = i => `<div class="item"><div class="emo">${JOB[i.status][0]}</div><div class="grow"><b>${esc(i.title)}</b>
  ${isParent() ? ` · ${nameOf(i.child_id)}` : ''}<div class="small muted">${fmtDate(i.job_date)} · ${money(i.price_cents)}</div>
  ${i.note ? `<div class="small muted">💬 ${esc(i.note)}</div>` : ''}</div>${jobChip(i.status)}</div>`;

function renderParentJobs() {
  const open = S.instances.filter(i => i.status === 'todo' || i.status === 'needs_fix');
  const recent = S.instances.filter(i => i.status === 'approved' || i.status === 'cancelled').slice(0, 20);
  return `<h1>🧹 עבודות</h1>
    <button class="btn big mint" data-act="jobForm">➕ עבודה חדשה</button>
    <h2>עבודות קבועות</h2>
    ${S.templates.length ? S.templates.map(t => `<div class="card"><div class="row between"><h3>🔁 ${esc(t.title)} ${t.active ? '' : chip('c-cancel', 'מושבת')}</h3>
      <button class="btn ghost sm" data-act="jobForm" data-id="${t.id}">עריכה</button></div>
      ${t.description ? `<div class="muted small">${esc(t.description)}</div>` : ''}
      <div class="list">${t.assignees.map(a => `<div class="item"><div class="emo">${avatar(mem(a.child_id) || {})}</div><div class="grow">${nameOf(a.child_id)} · ${money(a.price_cents)}
        <div class="small muted">משלם: ${payerName(a)}</div></div>
        ${t.active ? `<button class="btn sm" data-act="submit" data-tpl="${t.id}" data-child="${a.child_id}" data-rid="${uuid()}">רישום ביצוע</button>` : ''}</div>`).join('')}</div>
    </div>`).join('') : '<p class="muted">עוד אין עבודות קבועות.</p>'}
    <h2>לביצוע / נדרש תיקון</h2>
    ${open.length ? `<div class="card list">${open.map(i => `${instRow(i)}<div class="row" style="padding-bottom:10px">
      <button class="btn sm mint" data-act="review" data-id="${i.id}" data-a="approve">אישור</button>
      <button class="btn sm ghost" data-act="review" data-id="${i.id}" data-a="edit_price">שינוי מחיר</button>
      <button class="btn sm ghost" data-act="review" data-id="${i.id}" data-a="cancel">ביטול</button></div>`).join('')}</div>` : '<p class="muted">אין.</p>'}
    <h2>לאחרונה</h2>${recent.length ? `<div class="card list">${recent.map(i => { const inc = jobIncome(i);
      return instRow(i) + (inc ? `<div class="row" style="padding-bottom:10px">
        <button class="btn ghost sm" data-act="void" data-kind="income" data-id="${inc.id}">↩️ ביטול אישור</button></div>` : ''); }).join('')}</div>` : '<p class="muted">אין.</p>'}`;
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
  return `<h1>⏳ מגיע ${g(m, 'לי', 'לי')}</h1>
    <div class="stat s-owed card"><div class="lbl">סך הכול מגיע</div><div class="val">${money(m.totals.owed)}</div>
      <div class="sub">הכנסות שאושרו ועוד לא שולמו</div></div>
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
    ${o.child_ack === 'confirmed' ? '<div class="small">✔ הילד אישר קבלה</div>' : o.child_ack === 'disputed' ? `<div class="small" style="color:var(--berry)">✋ סומן "לא קיבלתי"${o.ack_note ? ': ' + esc(o.ack_note) : ''}</div>` : ''}
    ${o.void_reason ? `<div class="small muted">סיבת ביטול: ${esc(o.void_reason)}</div>` : ''}
    ${P && o.status === 'active' ? `<button class="btn ghost sm" data-act="void" data-kind="receipt" data-id="${o.id}">ביטול תשלום</button>` : ''}</div>
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
  const none = !inst.length && !inc.length && !exp.length && !disp.length;
  return `<h1>✅ אישורים</h1>
    ${none ? '<div class="banner b-ok">🎉 אין כרגע מה לאשר.</div>' : ''}
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
      <button class="btn ghost sm" data-act="void" data-kind="receipt" data-id="${r.id}">ביטול התשלום</button></div>`).join('')}` : ''}
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
  return `<button class="btn ghost sm" data-act="tab" data-tab="approvals">→ חזרה</button>
    <h1>${avatar(m)} ${esc(m.display_name)}</h1>${statCards(m)}
    <div class="actions"><button class="btn sky" data-act="income" data-id="${id}"><span>💵</span>הכנסה / מתנה</button>
    <button class="btn berry" data-act="expense" data-id="${id}"><span>🛒</span>הוצאה</button>
    <button class="btn grape" data-act="tab" data-tab="pay"><span>💸</span>תשלום</button></div>
    <h2>יעד</h2>${goalCard(m, true)}
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
  withdraw_income: 'ביטול דיווח הכנסה', withdraw_expense: 'ביטול דיווח הוצאה', export: 'ייצוא גיבוי', restore: 'שחזור מגיבוי'
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
      ${m.role === 'child' ? `<div class="small">יתרת פתיחה: ${money(m.totals.opening)}</div>` : '<div class="small">הורה</div>'}
      <div class="row" style="margin-top:6px"><button class="btn ghost sm" data-act="editMember" data-id="${m.id}">עריכה</button>
      ${m.role === 'child' ? `<button class="btn ghost sm" data-act="opening" data-id="${m.id}">יתרת פתיחה</button>
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

    <h2>📒 יומן שינויים</h2>
    <div class="card list">${S.audit.length ? S.audit.slice(0, 60).map(a => `<div class="item"><div class="grow"><b>${ACTION_LBL[a.action] || esc(a.action)}</b>
      · ${a.actor_member_id && mem(a.actor_member_id) ? nameOf(a.actor_member_id) : ''}
      ${a.reason ? `<div class="small">סיבה: ${esc(a.reason)}</div>` : ''}<div class="small muted">${fmtDT(a.created_at)}</div></div></div>`).join('') : '<p class="muted">ריק</p>'}</div>`;
}

// ---------------------------------------------------------------- dialogs
function openDialog(title, inner, onSubmit, submitLabel = 'שמירה') {
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
      $dlg.close(); if (msg) toast(msg); await load();
    } catch (e) {
      document.getElementById('dlgErr').innerHTML = `<div class="banner b-err">${esc(errText(e))}</div>`;
      btn.disabled = false;
    }
  };
  $dlg.showModal();
  form.querySelector('input:not([type=hidden]),select,textarea')?.focus();
  return form;
}
function toast(msg) {
  const d = document.createElement('div'); d.className = 'banner b-ok';
  d.style.cssText = 'position:fixed;top:12px;inset-inline:12px;z-index:50;max-width:600px;margin:auto';
  d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 3500);
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
  const m = mem(id);
  openDialog('🎯 יעד חיסכון', `<label class="f">למה חוסכים?</label><input class="in" name="name" value="${esc(m.goal_name || '')}" placeholder="למשל: אופניים">
    <label class="f">כמה צריך? (₪)</label><input class="in" name="amount" inputmode="decimal" value="${m.goal_cents ? fmtNum(m.goal_cents) : ''}">
    <p class="note">כדי למחוק יעד, השאירו את השם ריק.</p>`,
    async fd => {
      const name = String(fd.get('name') || '').trim();
      await rpc('set_goal', { p_request_id: this_rid(fd), p_member_id: id, p_name: name, p_cents: name ? needMoney(fd.get('amount')) : null });
      return 'היעד נשמר 🎯';
    });
}

function dlgJob(tplId) {
  const t = tplId ? S.templates.find(x => x.id === tplId) : null;
  const ks = kids();
  const f = openDialog(t ? '✏️ עריכת עבודה קבועה' : '➕ עבודה חדשה', `
    ${t ? '' : `<label class="f">סוג</label><div class="seg"><label><input type="radio" name="type" value="once" checked>חד פעמית</label>
      <label><input type="radio" name="type" value="weekly">קבועה (חוזרת)</label></div>`}
    <label class="f">שם העבודה</label><input class="in" name="title" required value="${esc(t?.title || '')}" placeholder="למשל: שטיפת רכב">
    <label class="f">תיאור קצר (לא חובה)</label><input class="in" name="desc" value="${esc(t?.description || '')}">
    <div id="dateBox" ${t ? 'hidden' : ''}><label class="f">תאריך</label><input class="in" type="date" name="date" value="${S.today}"></div>
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

function dlgOpening(id) {
  const m = mem(id);
  openDialog('יתרת פתיחה · ' + esc(m.display_name), `<p class="note">כמה כסף היה ל${esc(m.display_name)} לפני שהתחלנו להשתמש באפליקציה. זו לא הכנסה חדשה ולא נותנת נקודות.</p>
    <label class="f">סכום (₪)</label><input class="in" name="amount" inputmode="decimal" value="${fmtNum(m.totals.opening)}" required>
    <label class="f">סיבה${m.totals.opening ? '' : ' (לא חובה)'}</label><input class="in" name="reason" ${m.totals.opening ? 'required' : ''}>`,
    async fd => {
      const v = String(fd.get('amount')).trim(); const c = v === '0' ? 0 : needMoney(v);
      await rpc('set_opening_balance', { p_request_id: this_rid(fd), p_member_id: id, p_cents: c, p_reason: fd.get('reason') });
      return 'נשמר ✔';
    });
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
async function runBtn(btn, fn) {
  if (btn.disabled) return; btn.disabled = true;
  try { const msg = await fn(); if (msg) toast(msg); await load(); }
  catch (e) { alert(errText(e)); btn.disabled = false; }
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
    case 'submit': runBtn(b, async () => {
      await rpc('submit_job', { p_request_id: d.rid, p_instance_id: d.inst || null, p_template_id: d.tpl || null, p_child_id: d.child || null, p_note: null });
      return isParent() ? 'נרשם. אפשר לאשר במסך האישורים.' : 'כל הכבוד! 🎉 נשלח לאישור הורה';
    }); break;
    case 'withdraw': if (confirm('לבטל את הרישום הזה? הוא לא יימחק, רק יסומן כמבוטל.')) runBtn(b, async () => {
      await rpc('withdraw_report', { p_request_id: d.rid, p_kind: d.kind, p_id: d.id }); return 'בוטל ✔';
    }); break;
    case 'approveJob': runBtn(b, async () => {
      await rpc('review_job', { p_request_id: d.rid, p_instance_id: d.id, p_action: 'approve', p_note: null, p_price_cents: null }); return 'אושר ✔';
    }); break;
    case 'reviewIncome': runBtn(b, async () => {
      await rpc('review_income', { p_request_id: d.rid, p_income_id: d.id, p_action: d.a, p_note: null }); return d.a === 'approve' ? 'אושר ✔' : 'נדחה';
    }); break;
    case 'reviewExpense': runBtn(b, async () => {
      if (d.neg === '1' && !confirm('ההוצאה תיצור יתרה שלילית. לאשר בכל זאת?')) throw new Error('האישור בוטל');
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
        toast('התשלום נרשם ✔'); await load();
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
