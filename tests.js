'use strict';
// בדיקות קבלה מקצה לקצה: בקשות HTTP אמיתיות לשרת, עם שלושה משתמשים נפרדים (הורה + שני ילדים).
const CFG = window.KESEF_CONFIG;
const DOMAIN = CFG.LOGIN_DOMAIN || 'example.com';
const out = document.getElementById('out');
const results = [];
let section = '';

const mk = key => supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'kesef-test-' + key } });
const rid = () => crypto.randomUUID();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function head(t) { section = t; out.insertAdjacentHTML('beforeend', `<h2>${esc(t)}</h2>`); }
function check(name, ok, detail = '') {
  results.push({ section, name, ok });
  out.insertAdjacentHTML('beforeend', `<div class="r"><span class="s ${ok ? 'ok' : 'bad'}">${ok ? '✅ עבר' : '❌ נכשל'}</span>
    <div><div>${esc(name)}</div>${detail ? `<div class="d">${esc(detail)}</div>` : ''}</div></div>`);
}
const eq = (name, actual, expected) => check(name, actual === expected, `expected ${expected}, got ${actual}`);

async function call(c, fn, args) { const { data, error } = await c.rpc(fn, args || {}); if (error) throw error; return data; }
async function tryCall(c, fn, args) { const { data, error } = await c.rpc(fn, args || {}); return { data, error }; }
async function expectErr(name, c, fn, args, hint) {
  const { data, error } = await tryCall(c, fn, args);
  const ok = !!error && (!hint || error.hint === hint || error.code === hint);
  check(name, ok, error ? `${error.code || ''} ${error.hint || ''} ${error.message}` : 'הבקשה הצליחה למרות שהייתה צריכה להיחסם: ' + JSON.stringify(data));
}
async function totals(c, childId) {
  const s = await call(c, 'get_state');
  return s.members.find(m => m.id === childId).totals;
}

async function run() {
  const pw = document.getElementById('pw').value;
  out.innerHTML = ''; results.length = 0; document.getElementById('sum').textContent = 'רץ…';
  const P = mk('p'), K1 = mk('k1'), K2 = mk('k2'), ANON = mk('anon');
  head('התחברות והכנה');
  for (const [c, u] of [[P, 'test-parent'], [K1, 'test-kid1'], [K2, 'test-kid2']]) {
    const { error } = await c.auth.signInWithPassword({ email: `${u}@${DOMAIN}`, password: pw });
    check('התחברות ' + u, !error, error?.message);
    if (error) return finish();
  }
  const fam = await call(P, 'setup_test_family');
  const A = fam.kid1_id, B = fam.kid2_id, PID = fam.parent_id;
  check('נוצרה משפחת בדיקה נפרדת', !!fam.family_id);
  const payerP = { payer_member_id: PID, payer_name: null };

  const newJob = async (child, cents, title = 'עבודה') => (await call(P, 'create_job', {
    p_request_id: rid(), p_title: title, p_description: null, p_date: null,
    p_assignees: [{ child_id: child, price_cents: cents, ...payerP }] })).instance_ids[0];
  const approve = (inst, r = rid()) => call(P, 'review_job', { p_request_id: r, p_instance_id: inst, p_action: 'approve', p_note: null, p_price_cents: null });
  const incomeOf = async inst => (await call(P, 'get_state')).incomes.filter(i => i.job_instance_id === inst && i.status === 'active');
  const pay = (child, ids, cents, r = rid()) => call(P, 'record_payment', { p_request_id: r, p_child_id: child, p_income_ids: ids,
    p_amount_cents: cents, p_date: null, p_method: 'cash', p_note: null });

  // ---------------------------------------------------- תרחישים 1-3
  head('תרחיש 1: שטיפת רכב 10 ₪ — לפני ואחרי אישור');
  const tpl = (await call(P, 'save_template', { p_request_id: rid(), p_template_id: null, p_title: 'שטיפת רכב', p_description: 'שבועי',
    p_active: true, p_assignees: [{ child_id: A, price_cents: 1000, ...payerP }] })).template_id;
  const inst1 = (await call(K1, 'submit_job', { p_request_id: rid(), p_instance_id: null, p_template_id: tpl, p_child_id: null, p_note: null })).instance_id;
  let t = await totals(K1, A);
  eq('לפני אישור: הרווחתי 0', t.earned_work, 0); eq('לפני אישור: מגיע לי 0', t.owed, 0); eq('לפני אישור: קיבלתי 0', t.received, 0);
  await approve(inst1);
  t = await totals(K1, A);
  eq('אחרי אישור: הרווחתי 10 ₪', t.earned_work, 1000); eq('אחרי אישור: מגיע לי 10 ₪', t.owed, 1000); eq('אחרי אישור: קיבלתי 0', t.received, 0);
  eq('נקודה אחת לעבודה שאושרה', t.points_month, 1);
  const inc1 = (await incomeOf(inst1))[0].id;

  head('תרחיש 2: תשלום חלקי של 5 ₪');
  await pay(A, [inc1], 500);
  t = await totals(K1, A);
  eq('מגיע לי 5 ₪', t.owed, 500); eq('קיבלתי 5 ₪', t.received, 500); eq('ההכנסה נשארת 10 ₪', t.earned_work, 1000);
  eq('תשלום לא מוסיף נקודה', t.points_month, 1);
  const st = await call(K1, 'get_state');
  eq('מצב תשלום: שולם חלקית (שולם 5 מתוך 10)', st.incomes.find(i => i.id === inc1).paid_cents, 500);

  head('תרחיש 3: עוד 5 ₪ — החוב נסגר');
  await expectErr('תשלום מעבר ליתרת החוב (6 ₪ על חוב של 5 ₪) נחסם', P, 'record_payment', { p_request_id: rid(), p_child_id: A,
    p_income_ids: [inc1], p_amount_cents: 600, p_date: null, p_method: 'cash', p_note: null }, 'overpay');
  await pay(A, [inc1], 500);
  t = await totals(K1, A);
  eq('מגיע לי 0', t.owed, 0); eq('קיבלתי 10 ₪', t.received, 1000); eq('ההכנסה נשארת 10 ₪', t.earned_work, 1000);

  // ---------------------------------------------------- תרחיש 4
  head('תרחיש 4: ילד ב מקבל מתנה של 50 ₪');
  let tb = await totals(K2, B);
  await call(P, 'report_income', { p_request_id: rid(), p_child_id: B, p_kind: 'gift', p_amount_cents: 5000, p_date: null,
    p_source: 'סבתא', p_payer_member_id: null, p_description: 'יום הולדת', p_received: true, p_method: 'cash' });
  let tb2 = await totals(K2, B);
  eq('התקבולים גדלו ב-50 ₪', tb2.received - tb.received, 5000); eq('היתרה גדלה ב-50 ₪', tb2.balance - tb.balance, 5000);
  eq('הכנסה מעבודה לא השתנתה', tb2.earned_work, tb.earned_work); eq('אין ניקוד על מתנה', tb2.points_month, tb.points_month);
  eq('אין חוב (הכנסה ותקבול באותה פעולה, בלי ספירה כפולה)', tb2.owed, tb.owed);
  // דיווח של ילד ממתין ולא נספר
  const pend = await call(K2, 'report_income', { p_request_id: rid(), p_child_id: B, p_kind: 'gift', p_amount_cents: 2000, p_date: null,
    p_source: 'סבא', p_payer_member_id: null, p_description: null, p_received: true, p_method: 'cash' });
  eq('דיווח של ילד נשמר כ"ממתין"', pend.status, 'pending');
  let tb3 = await totals(K2, B);
  eq('דיווח ממתין לא משנה את הסיכומים', tb3.received, tb2.received);
  const fd = (await call(K1, 'get_state')).feed;
  check('דיווח ממתין לא מופיע בפיד המשפחתי', !fd.some(f => f.id === pend.income_id));
  await call(P, 'review_income', { p_request_id: rid(), p_income_id: pend.income_id, p_action: 'reject', p_note: 'בדיקה' });

  // ---------------------------------------------------- תרחיש 5
  head('תרחיש 5: תשלום אחד מכסה שלוש עבודות');
  const three = [];
  for (let i = 0; i < 3; i++) { const id = await newJob(A, 1000, 'עבודה ' + (i + 1)); await approve(id); three.push((await incomeOf(id))[0].id); }
  t = await totals(K1, A);
  eq('אחרי 3 אישורים: מגיע 30 ₪', t.owed, 3000); eq('הרווחתי 40 ₪', t.earned_work, 4000);
  const p5 = await pay(A, three, 3000);
  eq('תשלום אחד שויך ל-3 עבודות', p5.allocations.length, 3);
  t = await totals(K1, A);
  eq('החוב נסגר', t.owed, 0); eq('ההכנסה לא גדלה בגלל התשלום (40 ₪)', t.earned_work, 4000); eq('קיבלתי 40 ₪', t.received, 4000);
  eq('ניקוד: 4 עבודות = 4 נקודות', t.points_month, 4);
  const jX = await newJob(A, 1000, 'מול הורה'); await approve(jX);
  const jY = (await call(P, 'create_job', { p_request_id: rid(), p_title: 'אצל השכן', p_description: null, p_date: null,
    p_assignees: [{ child_id: A, price_cents: 1000, payer_member_id: null, payer_name: 'השכן' }] })).instance_ids[0];
  await approve(jY);
  const iX = (await incomeOf(jX))[0].id, iY = (await incomeOf(jY))[0].id;
  await expectErr('תשלום אחד לא יכול לערבב משלמים שונים', P, 'record_payment', { p_request_id: rid(), p_child_id: A,
    p_income_ids: [iX, iY], p_amount_cents: 100, p_date: null, p_method: 'cash', p_note: null }, 'mixed_payers');
  const sO = await call(K1, 'get_state');
  const owedOther = sO.incomes.filter(i => i.status === 'active' && i.payer_name === 'השכן').reduce((a, i) => a + i.amount_cents - i.paid_cents, 0);
  eq('חוב של מקור אחר מוצג בנפרד (השכן חייב 10 ₪)', owedOther, 1000);

  // ---------------------------------------------------- תרחיש 6
  head('תרחיש 6: הוצאה מאושרת');
  const before6 = await totals(K1, A);
  await call(P, 'report_expense', { p_request_id: rid(), p_child_id: A, p_amount_cents: 1500, p_date: null, p_description: 'גלידה', p_allow_negative: false });
  t = await totals(K1, A);
  eq('היתרה ירדה ב-15 ₪', before6.balance - t.balance, 1500);
  eq('ההכנסות לא השתנו', t.earned_work, before6.earned_work); eq('החובות לא השתנו', t.owed, before6.owed);
  const kexp = await call(K1, 'report_expense', { p_request_id: rid(), p_child_id: A, p_amount_cents: 999900, p_date: null, p_description: 'גדולה', p_allow_negative: true });
  check('הוצאה של ילד: מוצג שהיתרה תהיה שלילית', kexp.would_be_negative === true);
  eq('הוצאה ממתינה לא מורידה מהיתרה', (await totals(K1, A)).balance, t.balance);
  await expectErr('אישור הוצאה שיוצרת יתרה שלילית דורש אישור מפורש', P, 'review_expense', { p_request_id: rid(), p_expense_id: kexp.expense_id,
    p_action: 'approve', p_note: null, p_allow_negative: false }, 'negative_balance');
  await call(P, 'review_expense', { p_request_id: rid(), p_expense_id: kexp.expense_id, p_action: 'reject', p_note: null, p_allow_negative: false });

  // ---------------------------------------------------- תרחיש 7
  head('תרחיש 7: לחיצה כפולה ובקשות במקביל');
  const before7 = await totals(K1, A);
  const j7 = await newJob(A, 1000, 'כפולה');
  const sameRid = rid();
  const [a1, a2] = await Promise.allSettled([approve(j7, sameRid), approve(j7, sameRid)]);
  check('אישור כפול עם אותו מזהה: שתי הבקשות חזרו בלי שגיאה', a1.status === 'fulfilled' && a2.status === 'fulfilled',
    JSON.stringify([a1.reason?.message, a2.reason?.message]));
  eq('נוצרה הכנסה אחת בלבד', (await incomeOf(j7)).length, 1);
  const j7b = await newJob(A, 1000, 'מקבילה');
  const r7 = await Promise.allSettled([approve(j7b), approve(j7b), approve(j7b)]);
  eq('3 אישורים במקביל עם מזהים שונים: רק אחד הצליח', r7.filter(x => x.status === 'fulfilled').length, 1);
  eq('נוצרה הכנסה אחת בלבד', (await incomeOf(j7b)).length, 1);
  t = await totals(K1, A);
  eq('הניקוד עלה ב-2 בדיוק (שתי עבודות)', t.points_month - before7.points_month, 2);
  eq('ההכנסה עלתה ב-20 ₪ בדיוק', t.earned_work - before7.earned_work, 2000);
  const i7 = (await incomeOf(j7))[0].id, i7b = (await incomeOf(j7b))[0].id;
  const payRid = rid();
  const pp = await Promise.allSettled([pay(A, [i7], 1000, payRid), pay(A, [i7], 1000, payRid)]);
  check('תשלום כפול עם אותו מזהה: שתי הבקשות חזרו', pp.every(x => x.status === 'fulfilled'));
  check('שתי התשובות מצביעות על אותו תקבול', pp[0].value?.receipt_id && pp[0].value.receipt_id === pp[1].value?.receipt_id);
  const t7 = await totals(K1, A);
  eq('התקבל 10 ₪ אחד בלבד', t7.received - t.received, 1000);
  const par = await Promise.allSettled([pay(A, [i7b], 1000), pay(A, [i7b], 1000)]);
  eq('שני תשלומים שונים במקביל על אותו חוב: רק אחד עבר', par.filter(x => x.status === 'fulfilled').length, 1);
  const rej = par.find(x => x.status === 'rejected');
  check('התשלום השני נחסם כ"מעבר לחוב"', rej?.reason?.hint === 'overpay', rej?.reason?.message);
  const j7c = await newJob(A, 1000, 'חלקי במקביל'); await approve(j7c); const i7c = (await incomeOf(j7c))[0].id;
  const par2 = await Promise.allSettled([pay(A, [i7c], 600), pay(A, [i7c], 600)]);
  eq('שני תשלומים חלקיים של 6 ₪ במקביל על חוב של 10 ₪: רק אחד עבר', par2.filter(x => x.status === 'fulfilled').length, 1);
  const t7b = await totals(K1, A);
  eq('סך הכסף שהתקבל עלה ב-16 ₪ בלבד (10 + 6)', t7b.received - t7.received, 1600);
  check('החוב לא שלילי', t7b.owed >= 0, 'owed=' + t7b.owed);

  // ---------------------------------------------------- תרחיש 8
  head('תרחיש 8: ילד לא יכול לשנות נתונים של אחיו או לאשר לעצמו (בקשות ישירות לשרת)');
  const j8 = await newJob(A, 1000, 'ניסיון');
  await call(K1, 'submit_job', { p_request_id: rid(), p_instance_id: j8, p_template_id: null, p_child_id: null, p_note: null });
  await expectErr('ילד מאשר לעצמו עבודה', K1, 'review_job', { p_request_id: rid(), p_instance_id: j8, p_action: 'approve', p_note: null, p_price_cents: null }, 'forbidden');
  await expectErr('ילד משנה מחיר של עבודה', K1, 'review_job', { p_request_id: rid(), p_instance_id: j8, p_action: 'edit_price', p_note: null, p_price_cents: 99999 }, 'forbidden');
  await expectErr('ילד רושם לעצמו תשלום', K1, 'record_payment', { p_request_id: rid(), p_child_id: A, p_income_ids: [inc1], p_amount_cents: 100, p_date: null, p_method: 'cash', p_note: null }, 'forbidden');
  await expectErr('ילד רושם הוצאה לאח', K1, 'report_expense', { p_request_id: rid(), p_child_id: B, p_amount_cents: 100, p_date: null, p_description: 'x', p_allow_negative: true }, 'forbidden');
  await expectErr('ילד רושם הכנסה לאח', K1, 'report_income', { p_request_id: rid(), p_child_id: B, p_kind: 'gift', p_amount_cents: 100, p_date: null, p_source: 'x', p_payer_member_id: null, p_description: null, p_received: true, p_method: 'cash' }, 'forbidden');
  await expectErr('ילד משנה יעד של אח', K1, 'set_goal', { p_request_id: rid(), p_member_id: B, p_name: 'x', p_cents: 100 }, 'forbidden');
  await expectErr('ילד מסמן עבודה בשם אח', K1, 'submit_job', { p_request_id: rid(), p_instance_id: null, p_template_id: tpl, p_child_id: B, p_note: null }, 'forbidden');
  await expectErr('ילד מאשר הכנסה שדיווח', K1, 'review_income', { p_request_id: rid(), p_income_id: pend.income_id, p_action: 'approve', p_note: null }, 'forbidden');
  await expectErr('ילד מבטל רישום כספי', K1, 'void_record', { p_request_id: rid(), p_kind: 'income', p_id: inc1, p_reason: 'x', p_mode: null }, 'forbidden');
  await expectErr('ילד משנה יתרת פתיחה', K1, 'set_opening_balance', { p_request_id: rid(), p_member_id: A, p_cents: 999999, p_reason: 'x' }, 'forbidden');
  await expectErr('ילד מאפס סיסמה לאח', K1, 'reset_child_password', { p_member_id: B, p_new_password: 'hacked123' }, 'forbidden');
  await expectErr('ילד מייצא את נתוני המשפחה', K1, 'export_family', {}, 'forbidden');
  await expectErr('ילד מנסה שחזור', K1, 'restore_family', { p_backup: {}, p_dry_run: true }, 'forbidden');
  await expectErr('ילד מוסיף בן משפחה', K1, 'add_member', { p_request_id: rid(), p_email: 'x@x', p_display_name: 'x', p_role: 'parent', p_gender: 'f' }, 'forbidden');
  await expectErr('ילד מדווח "עבודה בבית" (רק אישור הורה יוצר כזו)', K1, 'report_income', { p_request_id: rid(), p_child_id: A, p_kind: 'job', p_amount_cents: 100, p_date: null, p_source: 'x', p_payer_member_id: null, p_description: null, p_received: false, p_method: null }, 'bad_kind');
  const stB = await call(P, 'get_state');
  const recB = stB.receipts.find(r => r.child_id === B);
  await expectErr('ילד מאשר קבלה של תשלום של אח', K1, 'ack_receipt', { p_request_id: rid(), p_receipt_id: recB.id, p_status: 'confirmed', p_note: null }, 'forbidden');
  // כתיבה וקריאה ישירה לטבלאות
  const ins = await K1.from('incomes').insert({ family_id: fam.family_id, child_id: A, kind: 'job', amount_cents: 100000, income_date: '2026-01-01', description: 'hack', payer_name: 'x', status: 'active' });
  check('כתיבה ישירה לטבלת הכנסות נחסמה', !!ins.error, ins.error?.message);
  const upd = await K1.from('members').update({ opening_balance_cents: 99999999 }).eq('id', A).select();
  check('עדכון ישיר של יתרת פתיחה נחסם', !!upd.error || (upd.data || []).length === 0, upd.error?.message || JSON.stringify(upd.data));
  const sel = await K1.from('expenses').select('*');
  check('קריאה ישירה של הוצאות נחסמה', !!sel.error || (sel.data || []).length === 0, sel.error?.message || `rows=${sel.data?.length}`);
  const del = await K1.from('receipts').delete().neq('id', '00000000-0000-0000-0000-000000000000').select();
  check('מחיקה ישירה של תקבולים נחסמה', !!del.error || (del.data || []).length === 0, del.error?.message);
  // מה הילד רואה
  const s1 = await call(K1, 'get_state');
  check('ילד לא מקבל הוצאות של אח', !s1.expenses.some(e => e.child_id === B));
  check('ילד לא מקבל פירוט תקבולים של אח', !s1.receipts.some(r => r.child_id === B));
  check('ילד לא מקבל דיווחים ממתינים/נדחים של אח', !s1.incomes.some(i => i.child_id === B));
  check('ילד לא רואה את יתרת האח', s1.members.find(m => m.id === B).totals.balance === undefined);
  check('ילד כן רואה הכנסות מאושרות של אח בפיד', s1.feed.some(f => f.child_id === B));
  check('ילד לא מקבל יומן שינויים', s1.audit.length === 0);
  await expectErr('משתמש לא מחובר לא מקבל נתונים', ANON, 'get_state', {});
  t = await totals(K1, A);
  check('אחרי כל הניסיונות הסכומים לא השתנו', t.balance === t7b.balance && t.earned_work === t7b.earned_work, JSON.stringify(t));

  // ---------------------------------------------------- תיקונים
  head('תיקונים, ביטולים ושמירת מחיר');
  await expectErr('ביטול הכנסה ששולמה בלי טיפול בתשלומים נחסם', P, 'void_record', { p_request_id: rid(), p_kind: 'income', p_id: inc1, p_reason: 'טעות', p_mode: null }, 'has_payments');
  await expectErr('ביטול בלי סיבה נחסם', P, 'void_record', { p_request_id: rid(), p_kind: 'income', p_id: inc1, p_reason: '', p_mode: 'keep_as_gift' }, 'missing_text');
  const b9 = await totals(K1, A);
  await call(P, 'void_record', { p_request_id: rid(), p_kind: 'income', p_id: inc1, p_reason: 'אושר בטעות', p_mode: 'keep_as_gift' });
  t = await totals(K1, A);
  eq('אחרי ביטול: הכנסה מעבודה ירדה ב-10 ₪', b9.earned_work - t.earned_work, 1000);
  eq('הניקוד ירד בנקודה', b9.points_month - t.points_month, 1);
  eq('היתרה לא השתנתה (הכסף נשאר כמתנה)', t.balance, b9.balance);
  eq('לא נוצר חוב חדש', t.owed, b9.owed);
  const s9 = await call(P, 'get_state');
  eq('הרישום המבוטל נשמר עם סיבה (לא נמחק)', s9.incomes.find(i => i.id === inc1)?.void_reason, 'אושר בטעות');
  check('יש רשומה ביומן השינויים', s9.audit.some(a => a.action === 'void_income' && a.entity_id === inc1));
  eq('העבודה חזרה ל"ממתין לאישור"', s9.instances.find(i => i.id === inst1)?.status, 'pending');
  await call(P, 'save_template', { p_request_id: rid(), p_template_id: tpl, p_title: 'שטיפת רכב', p_description: 'שבועי', p_active: true,
    p_assignees: [{ child_id: A, price_cents: 1500, ...payerP }] });
  const s10 = await call(P, 'get_state');
  check('שינוי מחיר בתבנית לא שינה הכנסה שכבר אושרה', three.every(id => s10.incomes.find(i => i.id === id).amount_cents === 1000));
  const inst10 = (await call(K1, 'submit_job', { p_request_id: rid(), p_instance_id: null, p_template_id: tpl, p_child_id: null, p_note: null })).instance_id;
  eq('ביצוע חדש מקבל את המחיר החדש', (await call(P, 'get_state')).instances.find(i => i.id === inst10).price_cents, 1500);
  const rA = s10.receipts.find(r => r.child_id === A && r.status === 'active');
  const bAck = await totals(K1, A);
  await call(K1, 'ack_receipt', { p_request_id: rid(), p_receipt_id: rA.id, p_status: 'confirmed', p_note: null });
  eq('אישור קבלה של הילד לא יוצר תקבול נוסף', (await totals(K1, A)).received, bAck.received);

  // ---------------------------------------------------- סיסמה
  head('איפוס סיסמה על ידי הורה');
  const tmp = 'Tmp-' + Math.random().toString(36).slice(2, 10);
  await call(P, 'reset_child_password', { p_member_id: B, p_new_password: tmp });
  const K2b = mk('k2b');
  let lg = await K2b.auth.signInWithPassword({ email: `test-kid2@${DOMAIN}`, password: tmp });
  check('הילד נכנס עם הסיסמה החדשה', !lg.error, lg.error?.message);
  await call(P, 'reset_child_password', { p_member_id: B, p_new_password: pw });
  lg = await mk('k2c').auth.signInWithPassword({ email: `test-kid2@${DOMAIN}`, password: pw });
  check('הסיסמה הוחזרה לסיסמת הבדיקה', !lg.error, lg.error?.message);
  await expectErr('סיסמה קצרה מדי נחסמת', P, 'reset_child_password', { p_member_id: B, p_new_password: '123' }, 'weak_password');

  // ---------------------------------------------------- גיבוי ושחזור
  head('ייצוא ושחזור');
  const E1 = await call(P, 'export_family');
  const tA1 = await totals(P, A), tB1 = await totals(P, B);
  check('הייצוא כולל את כל הטבלאות', ['members', 'incomes', 'receipts', 'allocations', 'expenses', 'job_instances', 'audit_log'].every(k => Array.isArray(E1.data[k])));
  check('הייצוא לא כולל מזהי משתמש של מערכת ההזדהות', !JSON.stringify(E1).includes('"user_id"'));
  await call(P, 'report_income', { p_request_id: rid(), p_child_id: B, p_kind: 'gift', p_amount_cents: 777, p_date: null, p_source: 'אחרי גיבוי',
    p_payer_member_id: null, p_description: null, p_received: true, p_method: 'cash' });
  const tB2 = await totals(P, B);
  eq('נוסף רישום אחרי הגיבוי', tB2.received - tB1.received, 777);
  const dry = await call(P, 'restore_family', { p_backup: E1, p_dry_run: true });
  check('ניסיון שחזור (dry run) עבר ואומת', dry.ok && dry.verified, JSON.stringify(dry));
  eq('ניסיון השחזור לא שינה כלום', (await totals(P, B)).received, tB2.received);
  const bad = JSON.parse(JSON.stringify(E1)); bad.data.members = bad.data.members.filter(m => m.role !== 'parent');
  await expectErr('קובץ שלא כולל את ההורה נדחה (מניעת נעילה)', P, 'restore_family', { p_backup: bad, p_dry_run: true }, 'no_self');
  await expectErr('קובץ לא תקין נדחה', P, 'restore_family', { p_backup: { hello: 1 }, p_dry_run: true }, 'bad_file');
  const real = await call(P, 'restore_family', { p_backup: E1, p_dry_run: false });
  check('שחזור אמיתי הושלם ואומת מול הקובץ', real.ok && real.verified, JSON.stringify(real));
  const tA3 = await totals(P, A), tB3 = await totals(P, B);
  check('אחרי שחזור: הסכומים של ילדה א זהים לרגע הגיבוי', JSON.stringify(tA3) === JSON.stringify(tA1), JSON.stringify([tA1, tA3]));
  check('אחרי שחזור: הרישום שנוסף אחרי הגיבוי נעלם', JSON.stringify(tB3) === JSON.stringify(tB1), JSON.stringify([tB1, tB3]));
  const E2 = await call(P, 'export_family');
  const same = ['members', 'job_templates', 'template_assignees', 'job_instances', 'incomes', 'receipts', 'allocations', 'expenses']
    .every(k => JSON.stringify(E2.data[k]) === JSON.stringify(E1.data[k]));
  check('ייצוא אחרי שחזור זהה לגיבוי בכל הטבלאות הכספיות', same);
  const kAfter = await call(K1, 'get_state');
  check('הילדים עדיין מחוברים אחרי שחזור', kAfter.me.id === A);

  if (document.getElementById('purge').checked) {
    head('ניקוי');
    const pg = await tryCall(P, 'purge_test_family');
    check('משפחת הבדיקה נמחקה', !pg.error, pg.error?.message);
  }
  finish();
}

function finish() {
  const bad = results.filter(r => !r.ok).length;
  document.getElementById('sum').innerHTML = bad ? `<span class="bad">❌ ${bad} מתוך ${results.length} בדיקות נכשלו</span>`
    : `<span class="ok">✅ כל ${results.length} הבדיקות עברו</span>`;
  document.getElementById('run').disabled = false;
  window.__results = results;
}

document.getElementById('run').onclick = async ev => {
  ev.target.disabled = true;
  try { await run(); } catch (e) { check('שגיאה לא צפויה בבדיקות', false, (e.message || e) + ' ' + (e.hint || '')); finish(); }
};
