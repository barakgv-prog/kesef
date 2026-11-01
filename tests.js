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
const kids2 = s => s.members.filter(m => m.role === 'child');
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
  await expectErr('ילד משנה יתרת פתיחה של אח', K1, 'set_opening_balance', { p_request_id: rid(), p_member_id: B, p_cents: 999999, p_reason: 'x' }, 'forbidden');
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

  // ---------------------------------------------------- טעויות של ילד
  head('תיקון טעויות: ילד או הורה מבטלים רישום שנעשה בטעות');
  const instOf = async (c, id) => (await call(c, 'get_state')).instances.find(i => i.id === id);
  const bW = await totals(K1, A);
  const oneOff = await newJob(A, 700, 'ניקיון חדר');
  await call(K1, 'submit_job', { p_request_id: rid(), p_instance_id: oneOff, p_template_id: null, p_child_id: null, p_note: null });
  await expectErr('ילד לא יכול לבטל סימון של אח', K2, 'withdraw_report', { p_request_id: rid(), p_kind: 'job', p_id: oneOff }, 'forbidden');
  const wr = rid();
  const [w1, w2] = await Promise.all([1, 2].map(() => tryCall(K1, 'withdraw_report', { p_request_id: wr, p_kind: 'job', p_id: oneOff })));
  check('לחיצה כפולה על "סימנתי בטעות": שתי הבקשות חזרו בלי שגיאה', !w1.error && !w2.error, JSON.stringify([w1.error?.message, w2.error?.message]));
  eq('עבודה חד-פעמית שסומנה בטעות חזרה ל"לביצוע"', (await instOf(K1, oneOff)).status, 'todo');
  const tplSub = (await call(K1, 'submit_job', { p_request_id: rid(), p_instance_id: null, p_template_id: tpl, p_child_id: null, p_note: null })).instance_id;
  await call(K1, 'withdraw_report', { p_request_id: rid(), p_kind: 'job', p_id: tplSub });
  eq('ביצוע של עבודה קבועה שסומן בטעות בוטל', (await instOf(K1, tplSub)).status, 'cancelled');
  const pInc = (await call(K1, 'report_income', { p_request_id: rid(), p_child_id: A, p_kind: 'gift', p_amount_cents: 3000, p_date: null,
    p_source: 'סבתא', p_payer_member_id: null, p_description: null, p_received: true, p_method: 'cash' })).income_id;
  await expectErr('ילד לא יכול לבטל דיווח הכנסה של אח', K2, 'withdraw_report', { p_request_id: rid(), p_kind: 'income', p_id: pInc }, 'forbidden');
  await call(K1, 'withdraw_report', { p_request_id: rid(), p_kind: 'income', p_id: pInc });
  const pExp = (await call(K1, 'report_expense', { p_request_id: rid(), p_child_id: A, p_amount_cents: 400, p_date: null,
    p_description: 'גלידה', p_allow_negative: false })).expense_id;
  await call(K1, 'withdraw_report', { p_request_id: rid(), p_kind: 'expense', p_id: pExp });
  const sW = await call(P, 'get_state');
  eq('דיווח הכנסה שבוטל לא ממתין יותר לאישור', sW.incomes.find(i => i.id === pInc)?.status, 'rejected');
  eq('דיווח הוצאה שבוטל לא ממתין יותר לאישור', sW.expenses.find(e => e.id === pExp)?.status, 'rejected');
  check('הביטולים נשמרו ביומן השינויים', ['withdraw_job', 'withdraw_income', 'withdraw_expense'].every(a => sW.audit.some(x => x.action === a)));
  const aW = await totals(K1, A);
  check('הסכומים לא השתנו מכל הסימונים והביטולים', aW.balance === bW.balance && aW.earned_work === bW.earned_work && aW.owed === bW.owed
    && aW.points_month === bW.points_month, JSON.stringify([bW, aW]));
  const someApproved = sW.incomes.find(i => i.child_id === A && i.status === 'active').id;
  await expectErr('ילד לא יכול לבטל בעצמו הכנסה שכבר אושרה', K1, 'withdraw_report', { p_request_id: rid(), p_kind: 'income', p_id: someApproved }, 'bad_status');
  await call(K1, 'submit_job', { p_request_id: rid(), p_instance_id: oneOff, p_template_id: null, p_child_id: null, p_note: null });
  await expectErr('ילד לא יכול להשתמש ב"לא בוצע" של הורה', K1, 'review_job', { p_request_id: rid(), p_instance_id: oneOff, p_action: 'reopen', p_note: null, p_price_cents: null }, 'forbidden');
  await call(P, 'review_job', { p_request_id: rid(), p_instance_id: oneOff, p_action: 'reopen', p_note: 'עוד לא סיים', p_price_cents: null });
  const rOne = await instOf(P, oneOff);
  check('הורה סימן "לא בוצע": העבודה חזרה ל"לביצוע" עם הסבר', rOne.status === 'todo' && rOne.note === 'עוד לא סיים', JSON.stringify(rOne));
  await call(P, 'review_job', { p_request_id: rid(), p_instance_id: inst10, p_action: 'approve', p_note: null, p_price_cents: null });
  await expectErr('"לא בוצע" על עבודה שכבר אושרה נחסם (מתקנים דרך ביטול האישור)', P, 'review_job', { p_request_id: rid(), p_instance_id: inst10, p_action: 'reopen', p_note: null, p_price_cents: null }, 'bad_status');

  // ---------------------------------------------------- עבודה מזדמנת, בונוס וקופה
  head('ילד מוסיף עבודה מזדמנת, בונוס מאבא/אמא');
  const bP = await totals(K1, A);
  const pj = await call(K1, 'propose_job', { p_request_id: rid(), p_child_id: A, p_title: 'סידור המחסן', p_description: null,
    p_price_cents: 1200, p_payer_member_id: PID, p_payer_name: null, p_date: null, p_done: true });
  eq('עבודה שהילד הוסיף ("כבר עשיתי") ממתינה לאישור', pj.status, 'pending');
  eq('עבודה שהילד הוסיף לא נכנסת לסכומים לפני אישור', (await totals(K1, A)).earned_work, bP.earned_work);
  const pj2 = await call(K1, 'propose_job', { p_request_id: rid(), p_child_id: A, p_title: 'שטיפת כלים', p_description: null,
    p_price_cents: 500, p_payer_member_id: null, p_payer_name: 'סבתא', p_date: null, p_done: false });
  eq('"אני רוצה לעשות" נכנס לרשימת העבודות לביצוע', pj2.status, 'todo');
  await expectErr('ילד לא יכול להוסיף עבודה בשם אח', K2, 'propose_job', { p_request_id: rid(), p_child_id: A, p_title: 'x', p_description: null,
    p_price_cents: 500, p_payer_member_id: PID, p_payer_name: null, p_date: null, p_done: true }, 'forbidden');
  await expectErr('עבודה בלי מחיר נחסמת', K1, 'propose_job', { p_request_id: rid(), p_child_id: A, p_title: 'x', p_description: null,
    p_price_cents: 0, p_payer_member_id: PID, p_payer_name: null, p_date: null, p_done: true }, 'bad_amount');
  await call(P, 'review_job', { p_request_id: rid(), p_instance_id: pj.instance_id, p_action: 'approve', p_note: null, p_price_cents: 1000 });
  let tP = await totals(K1, A);
  eq('הורה אישר במחיר אחר: הרווחתי עלה ב-10 ₪ (לא 12)', tP.earned_work - bP.earned_work, 1000);
  eq('עבודה מזדמנת שאושרה נותנת נקודה', tP.points_month - bP.points_month, 1);

  const bon = await call(K1, 'report_income', { p_request_id: rid(), p_child_id: A, p_kind: 'bonus', p_amount_cents: 2000, p_date: null,
    p_source: null, p_payer_member_id: PID, p_description: 'תעודה', p_received: true, p_method: 'cash' });
  eq('בונוס שהילד דיווח ממתין לאישור', bon.status, 'pending');
  await expectErr('בונוס חייב להגיע מאבא או מאמא', K1, 'report_income', { p_request_id: rid(), p_child_id: A, p_kind: 'bonus', p_amount_cents: 2000,
    p_date: null, p_source: 'השכן', p_payer_member_id: null, p_description: null, p_received: true, p_method: 'cash' }, 'bad_payer');
  await call(P, 'review_income', { p_request_id: rid(), p_income_id: bon.income_id, p_action: 'approve', p_note: null });
  const tBon = await totals(K1, A);
  eq('אחרי אישור הבונוס: קיבלתי עלה ב-20 ₪', tBon.received - tP.received, 2000);
  eq('בונוס לא נכנס ל"הרווחתי מעבודה"', tBon.earned_work, tP.earned_work);
  eq('בונוס לא נותן נקודה', tBon.points_month, tP.points_month);
  const pBon = await call(P, 'report_income', { p_request_id: rid(), p_child_id: B, p_kind: 'bonus', p_amount_cents: 1500, p_date: null,
    p_source: null, p_payer_member_id: PID, p_description: 'הפתעה', p_received: false, p_method: 'cash' });
  eq('בונוס שהורה רושם נכנס מיד', pBon.status, 'active');
  check('בונוס שעוד לא ניתן נרשם ב"מגיע לי"', (await totals(K2, B)).owed >= 1500);
  check('בונוס מאושר מופיע בפיד המשפחתי', (await call(K1, 'get_state')).feed.some(f => f.kind === 'bonus' && f.child_id === B));

  const memOf = async (c, id) => (await call(c, 'get_state')).members.find(m => m.id === id);
  const job = async (child, cents, title) => { const j = await newJob(child, cents, title); await approve(j); return { inst: j, inc: (await incomeOf(j))[0].id }; };

  // ---------------------------------------------------- קופה = יתרת פתיחה + תשלומים שהתקבלו − הוצאות
  head('הקופה: יתרת פתיחה ותשלומים מצטברים');
  eq('יתרת פתיחה עוד לא נרשמה', (await memOf(K1, A)).opening_set, false);
  const bal0 = (await totals(K1, A)).balance;
  await expectErr('ילד לא רושם יתרת פתיחה לאח', K2, 'set_opening_balance', { p_request_id: rid(), p_member_id: A, p_cents: 100, p_reason: null }, 'forbidden');
  await call(K1, 'set_opening_balance', { p_request_id: rid(), p_member_id: A, p_cents: 10000, p_reason: null });
  eq('הילד רשם יתרת פתיחה 100 ₪: הקופה עלתה ב-100 ₪ בדיוק', (await totals(K1, A)).balance - bal0, 10000);
  await expectErr('אחרי שנרשמה, הילד לא יכול לשנות אותה', K1, 'set_opening_balance', { p_request_id: rid(), p_member_id: A, p_cents: 99999, p_reason: 'x' }, 'opening_locked');
  await expectErr('תיקון של הורה בלי סיבה נחסם', P, 'set_opening_balance', { p_request_id: rid(), p_member_id: A, p_cents: 9000, p_reason: '' }, 'missing_reason');
  await call(P, 'set_opening_balance', { p_request_id: rid(), p_member_id: A, p_cents: 9000, p_reason: 'נספר לא נכון' });
  const mA1 = await memOf(K1, A);
  eq('תיקון הורה: יתרת פתיחה 90 ₪', mA1.totals.opening, 9000);
  check('התיקון מוצג בקופה עם הסיבה', mA1.balance_log.some(x => x.reason === 'נספר לא נכון' && x.new === 9000 && x.old === 10000), JSON.stringify(mA1.balance_log));
  check('התיקון נרשם ביומן', (await call(P, 'get_state')).audit.some(a => a.action === 'correct_balance' && a.entity_id === A));

  // הדוגמה מהבקשה, על ילד ב: פתיחה 100 ₪, תשלום של 10 ₪
  await call(P, 'set_opening_balance', { p_request_id: rid(), p_member_id: B, p_cents: 10000, p_reason: null });
  const tB0 = await totals(K2, B);
  const jB = await job(B, 1000, 'דוגמה 10 ₪');
  const tB1 = await totals(K2, B);
  eq('לפני התשלום: הקופה לא השתנתה (חוב לא נכנס לקופה)', tB1.balance, tB0.balance);
  eq('לפני התשלום: "מגיע לי" עלה ב-10 ₪', tB1.owed - tB0.owed, 1000);
  const pB = await pay(B, [jB.inc], 1000);
  const tB2 = await totals(K2, B);
  eq('אחרי התשלום: הקופה עלתה ב-10 ₪ (נוסף, לא מחליף)', tB2.balance - tB1.balance, 1000);
  eq('אחרי התשלום: "מגיע לי" ירד ב-10 ₪', tB1.owed - tB2.owed, 1000);
  eq('יתרת הפתיחה נשארה 100 ₪', tB2.opening, 10000);
  await call(P, 'void_record', { p_request_id: rid(), p_kind: 'receipt', p_id: pB.receipt_id, p_reason: 'בדיקה', p_mode: null });
  const tB3 = await totals(K2, B);
  check('ביטול התשלום החזיר את הקופה ואת החוב בדיוק למצב שלפני', tB3.balance === tB1.balance && tB3.owed === tB1.owed && tB3.received === tB1.received,
    JSON.stringify([tB1, tB3]));
  await pay(B, [jB.inc], 1000);

  // ---------------------------------------------------- "קיבלתי תשלום" מהילד, בלי כפילות
  head('הילד מדווח "קיבלתי תשלום" — ובלי לספור פעמיים');
  const jR = await job(B, 2000, 'דיווח תשלום');
  const tR0 = await totals(K2, B);
  const rep = await call(K2, 'report_receipt', { p_request_id: rid(), p_child_id: B, p_income_ids: [jR.inc], p_amount_cents: 500,
    p_date: null, p_method: 'cash', p_note: null });
  eq('דיווח חלקי של 5 ₪ נשמר כ"ממתין"', rep.status, 'pending');
  const tR1 = await totals(K2, B);
  check('דיווח ממתין לא משנה את הסכומים', tR1.received === tR0.received && tR1.owed === tR0.owed && tR1.balance === tR0.balance);
  await expectErr('ילד לא מדווח פעמיים על אותו כסף', K2, 'report_receipt', { p_request_id: rid(), p_child_id: B, p_income_ids: [jR.inc],
    p_amount_cents: 2000, p_date: null, p_method: 'cash', p_note: null }, 'already_reported');
  await expectErr('ילד לא מדווח על חוב של אח', K1, 'report_receipt', { p_request_id: rid(), p_child_id: A, p_income_ids: [jR.inc],
    p_amount_cents: 100, p_date: null, p_method: 'cash', p_note: null }, 'bad_income');
  await expectErr('הורה שרושם את אותו תשלום שהילד כבר דיווח — נחסם', P, 'record_payment', { p_request_id: rid(), p_child_id: B,
    p_income_ids: [jR.inc], p_amount_cents: 2000, p_date: null, p_method: 'cash', p_note: null }, 'child_reported');
  await pay(B, [jR.inc], 1500);
  eq('הורה יכול לשלם את היתרה (15 ₪)', (await totals(K2, B)).received - tR0.received, 1500);
  await call(P, 'review_receipt', { p_request_id: rid(), p_receipt_id: rep.receipt_id, p_action: 'approve', p_note: null });
  const tR2 = await totals(K2, B);
  eq('אחרי אישור הדיווח: התקבל 20 ₪ בסך הכול (לא יותר)', tR2.received - tR0.received, 2000);
  eq('החוב נסגר', tR2.owed - tR0.owed, -2000);
  eq('הקופה עלתה ב-20 ₪', tR2.balance - tR0.balance, 2000);
  await expectErr('אישור כפול של אותו דיווח נחסם', P, 'review_receipt', { p_request_id: rid(), p_receipt_id: rep.receipt_id, p_action: 'approve', p_note: null }, 'bad_status');
  // ההורה רשם קודם — הילד רק מאשר קבלה
  const jR2 = await job(B, 1000, 'הורה רשם קודם');
  const pR2 = await pay(B, [jR2.inc], 1000);
  const tR3 = await totals(K2, B);
  await expectErr('ההורה כבר רשם: דיווח הילד נחסם ומפנה לאישור קבלה', K2, 'report_receipt', { p_request_id: rid(), p_child_id: B,
    p_income_ids: [jR2.inc], p_amount_cents: 1000, p_date: null, p_method: 'cash', p_note: null }, 'already_recorded');
  await call(K2, 'ack_receipt', { p_request_id: rid(), p_receipt_id: pR2.receipt_id, p_status: 'confirmed', p_note: null });
  eq('אישור קבלה לא מוסיף כסף', (await totals(K2, B)).received, tR3.received);
  // דחייה וביטול עצמי
  const jR3 = await job(B, 800, 'דחייה');
  const rep2 = await call(K2, 'report_receipt', { p_request_id: rid(), p_child_id: B, p_income_ids: [jR3.inc], p_amount_cents: 800,
    p_date: null, p_method: 'bit', p_note: null });
  await call(P, 'review_receipt', { p_request_id: rid(), p_receipt_id: rep2.receipt_id, p_action: 'reject', p_note: 'לא קיבל עדיין' });
  const rep3 = await call(K2, 'report_receipt', { p_request_id: rid(), p_child_id: B, p_income_ids: [jR3.inc], p_amount_cents: 800,
    p_date: null, p_method: 'bit', p_note: null });
  check('אחרי דחייה אפשר לדווח מחדש', !!rep3.receipt_id);
  await call(K2, 'withdraw_report', { p_request_id: rid(), p_kind: 'receipt', p_id: rep3.receipt_id });
  const tR4 = await totals(K2, B);
  check('דיווח שנדחה ודיווח שבוטל לא שינו כלום', tR4.received === tR3.received && tR4.owed === tR3.owed + 800, JSON.stringify([tR3, tR4]));
  await expectErr('הורה לא משתמש ב"קיבלתי תשלום" של ילד', P, 'report_receipt', { p_request_id: rid(), p_child_id: B, p_income_ids: [jR3.inc],
    p_amount_cents: 100, p_date: null, p_method: 'cash', p_note: null }, 'forbidden');
  // שני מכשירים במקביל: הורה רושם וילד מדווח באותו רגע — נספר פעם אחת בלבד
  const jR4 = await job(B, 1000, 'במקביל');
  const tR5 = await totals(K2, B);
  const both = await Promise.allSettled([pay(B, [jR4.inc], 1000), call(K2, 'report_receipt', { p_request_id: rid(), p_child_id: B,
    p_income_ids: [jR4.inc], p_amount_cents: 1000, p_date: null, p_method: 'cash', p_note: null })]);
  for (const x of both) if (x.status === 'fulfilled' && x.value.status === 'pending')
    await tryCall(P, 'review_receipt', { p_request_id: rid(), p_receipt_id: x.value.receipt_id, p_action: 'approve', p_note: null });
  eq('הורה וילד במקביל על אותו תשלום: התקבל 10 ₪ פעם אחת', (await totals(K2, B)).received - tR5.received, 1000);

  // ---------------------------------------------------- עריכת עבודה מזדמנת
  head('עריכת עבודה מזדמנת');
  const e1 = await newJob(A, 1000, 'לפני עריכה');
  await call(P, 'edit_job', { p_request_id: rid(), p_instance_id: e1, p_title: 'אחרי עריכה', p_description: 'פרטים', p_price_cents: 1200, p_reason: null });
  const e1s = await instOf(K1, e1);
  check('הורה ערך שם, תיאור וסכום לפני אישור', e1s.title === 'אחרי עריכה' && e1s.description === 'פרטים' && e1s.price_cents === 1200, JSON.stringify(e1s));
  await expectErr('ילד לא עורך עבודה שההורה הוסיף', K1, 'edit_job', { p_request_id: rid(), p_instance_id: e1, p_title: 'x', p_description: null, p_price_cents: 99900, p_reason: null }, 'forbidden');
  const kp1 = await call(K1, 'propose_job', { p_request_id: rid(), p_child_id: A, p_title: 'שלי', p_description: null,
    p_price_cents: 900, p_payer_member_id: PID, p_payer_name: null, p_date: null, p_done: true });
  await call(K1, 'edit_job', { p_request_id: rid(), p_instance_id: kp1.instance_id, p_title: 'שלי, מתוקן', p_description: null, p_price_cents: 800, p_reason: null });
  const kp1s = await instOf(K1, kp1.instance_id);
  check('ילד ערך עבודה שהוסיף, והיא עדיין ממתינה לאישור הורה', kp1s.price_cents === 800 && kp1s.status === 'pending', JSON.stringify(kp1s));
  await expectErr('ילד לא עורך עבודה של אח', K2, 'edit_job', { p_request_id: rid(), p_instance_id: kp1.instance_id, p_title: 'x', p_description: null, p_price_cents: 100, p_reason: null }, 'forbidden');
  await approve(e1);
  const e1inc = (await incomeOf(e1))[0].id;
  await pay(A, [e1inc], 500);
  const tE0 = await totals(K1, A);
  await expectErr('אחרי תשלום של 5 ₪ אי אפשר להוריד את הסכום ל-4 ₪', P, 'edit_job', { p_request_id: rid(), p_instance_id: e1, p_title: 'אחרי עריכה', p_description: null, p_price_cents: 400, p_reason: 'x' }, 'below_paid');
  await expectErr('שינוי סכום של עבודה שאושרה דורש סיבה', P, 'edit_job', { p_request_id: rid(), p_instance_id: e1, p_title: 'אחרי עריכה', p_description: null, p_price_cents: 1500, p_reason: '' }, 'missing_reason');
  await call(P, 'edit_job', { p_request_id: rid(), p_instance_id: e1, p_title: 'אחרי עריכה', p_description: null, p_price_cents: 1500, p_reason: 'עבד יותר' });
  const tE1 = await totals(K1, A);
  check('תיקון סכום אחרי אישור: הרווחתי ומגיע עלו ב-3 ₪, התשלום שהתקבל לא השתנה',
    tE1.earned_work - tE0.earned_work === 300 && tE1.owed - tE0.owed === 300 && tE1.received === tE0.received && tE1.balance === tE0.balance, JSON.stringify([tE0, tE1]));
  check('התיקון נרשם ביומן עם הסיבה', (await call(P, 'get_state')).audit.some(a => a.action === 'edit_job' && a.entity_id === e1 && a.reason === 'עבד יותר'));
  eq('הניקוד לא השתנה מהעריכה', tE1.points_month, tE0.points_month);
  await expectErr('עבודה קבועה לא נערכת כעבודה מזדמנת', P, 'edit_job', { p_request_id: rid(), p_instance_id: inst10, p_title: 'x', p_description: null, p_price_cents: 100, p_reason: 'x' }, 'not_occasional');

  // ---------------------------------------------------- עבודות קבועות ברשימה האישית
  head('הוספה והסרה של עבודות קבועות');
  const pt = await call(K1, 'propose_template', { p_request_id: rid(), p_child_id: A, p_template_id: null, p_title: 'הוצאת הכלב', p_description: null,
    p_price_cents: 700, p_payer_member_id: PID, p_payer_name: null });
  eq('עבודה קבועה שהילד הוסיף ממתינה לאישור', pt.approved, false);
  await expectErr('אי אפשר לסמן "סיימתי" לפני שההורה אישר', K1, 'submit_job', { p_request_id: rid(), p_instance_id: null, p_template_id: pt.template_id, p_child_id: null, p_note: null }, 'not_approved');
  const k2t = (await call(K2, 'get_state')).templates.find(t => t.id === pt.template_id);
  check('אח רואה את העבודה (כדי להוסיף לעצמו) אבל לא את המחיר של אחיו', !!k2t && k2t.assignees.length === 0, JSON.stringify(k2t));
  await call(K2, 'propose_template', { p_request_id: rid(), p_child_id: B, p_template_id: pt.template_id, p_title: null, p_description: null,
    p_price_cents: 500, p_payer_member_id: PID, p_payer_name: null });
  await expectErr('אי אפשר להוסיף את אותה עבודה פעמיים', K2, 'propose_template', { p_request_id: rid(), p_child_id: B, p_template_id: pt.template_id,
    p_title: null, p_description: null, p_price_cents: 500, p_payer_member_id: PID, p_payer_name: null }, 'already_assigned');
  await expectErr('ילד לא מאשר לעצמו', K1, 'review_assignment', { p_request_id: rid(), p_template_id: pt.template_id, p_child_id: A, p_action: 'approve', p_price_cents: null }, 'forbidden');
  await call(P, 'review_assignment', { p_request_id: rid(), p_template_id: pt.template_id, p_child_id: A, p_action: 'approve', p_price_cents: 600 });
  const ptI = (await call(K1, 'submit_job', { p_request_id: rid(), p_instance_id: null, p_template_id: pt.template_id, p_child_id: null, p_note: null })).instance_id;
  eq('אחרי אישור במחיר אחר: הביצוע במחיר שההורה קבע (6 ₪)', (await instOf(K1, ptI)).price_cents, 600);
  await approve(ptI);
  const ptInc = (await incomeOf(ptI))[0].id;
  const tT0 = await totals(K1, A);
  await expectErr('ילד לא מסיר עבודה מהרשימה של אח', K2, 'remove_template_assignment', { p_request_id: rid(), p_template_id: pt.template_id, p_child_id: A }, 'forbidden');
  await call(K1, 'remove_template_assignment', { p_request_id: rid(), p_template_id: pt.template_id, p_child_id: A });
  const sT = await call(K1, 'get_state');
  check('העבודה ירדה מהרשימה של הילד', !sT.templates.find(t => t.id === pt.template_id)?.assignees.length);
  const tT1 = await totals(K1, A);
  check('ההסרה לא שינתה הכנסות, חובות או קופה', JSON.stringify(tT0) === JSON.stringify(tT1), JSON.stringify([tT0, tT1]));
  check('הביצוע וההכנסה הקודמים נשארו', sT.instances.some(i => i.id === ptI && i.status === 'approved') && sT.incomes.some(i => i.id === ptInc && i.status === 'active'));
  const sTP = await call(P, 'get_state');
  check('העבודה נשארה אצל האח (ממתינה לאישור)', sTP.templates.find(t => t.id === pt.template_id).assignees.some(a => a.child_id === B && !a.approved));
  await call(P, 'review_assignment', { p_request_id: rid(), p_template_id: pt.template_id, p_child_id: B, p_action: 'reject', p_price_cents: null });
  check('הורה דחה: העבודה ירדה גם מהאח', !(await call(P, 'get_state')).templates.find(t => t.id === pt.template_id).assignees.length);
  await call(P, 'remove_template_assignment', { p_request_id: rid(), p_template_id: tpl, p_child_id: A });
  check('הורה הסיר עבודה קבועה מהרשימה של ילד, והביצועים שלה נשמרו', (await call(P, 'get_state')).instances.some(i => i.template_id === tpl));

  // ---------------------------------------------------- יעדי חיסכון
  head('יעדי חיסכון: "כולל הקופה" ו"חיסכון חדש"');
  const gA0 = await totals(K1, A);
  await call(K1, 'set_goal', { p_request_id: rid(), p_member_id: A, p_name: 'אופניים', p_cents: 1000000, p_mode: 'total' });
  let mg = await memOf(K1, A);
  eq('"כולל הכסף שבקופה": ההתקדמות = הקופה', mg.goal_progress, Math.max(0, gA0.balance));
  eq('יצירת יעד לא שינתה את הקופה', mg.totals.balance, gA0.balance);
  await call(K1, 'set_goal', { p_request_id: rid(), p_member_id: A, p_name: 'אופניים', p_cents: 1000000, p_mode: 'fresh' });
  mg = await memOf(K1, A);
  eq('"חיסכון חדש מעכשיו": מתחיל מאפס', mg.goal_progress, 0);
  eq('גם עכשיו הקופה לא השתנתה', mg.totals.balance, gA0.balance);
  const gj = await job(A, 3000, 'לחיסכון');
  eq('חוב שעוד לא שולם לא נספר ביעד', (await memOf(K1, A)).goal_progress, 0);
  await pay(A, [gj.inc], 3000);
  eq('אחרי תשלום של 30 ₪: ההתקדמות 30 ₪', (await memOf(K1, A)).goal_progress, 3000);
  await call(P, 'report_expense', { p_request_id: rid(), p_child_id: A, p_amount_cents: 1000, p_date: null, p_description: 'ממתק', p_allow_negative: true });
  eq('הוצאה של 10 ₪ מורידה את ההתקדמות ל-20 ₪', (await memOf(K1, A)).goal_progress, 2000);
  await call(K1, 'set_goal', { p_request_id: rid(), p_member_id: A, p_name: 'אופניים חדשות', p_cents: 900000, p_mode: 'fresh' });
  eq('שינוי שם וסכום שומר את נקודת ההתחלה', (await memOf(K1, A)).goal_progress, 2000);
  await call(P, 'report_expense', { p_request_id: rid(), p_child_id: A, p_amount_cents: 5000, p_date: null, p_description: 'גדולה', p_allow_negative: true });
  eq('הוצאה גדולה: ההתקדמות לא יורדת מתחת לאפס', (await memOf(K1, A)).goal_progress, 0);
  const tGb = await totals(K2, B);
  await call(K2, 'set_goal', { p_request_id: rid(), p_member_id: B, p_name: 'משחק', p_cents: 50000, p_mode: 'total' });
  await call(P, 'report_expense', { p_request_id: rid(), p_child_id: B, p_amount_cents: 700, p_date: null, p_description: 'ספר', p_allow_negative: true });
  eq('"כולל הקופה" אחרי הוצאה: ההתקדמות ירדה כמו הקופה', (await memOf(K2, B)).goal_progress, Math.max(0, tGb.balance - 700));
  check('אח רואה רק אחוזים, לא סכומים', (await memOf(K2, A)).goal_progress === undefined && typeof (await memOf(K2, A)).goal_pct === 'number');

  // ---------------------------------------------------- סנכרון בין מכשירים
  head('סנכרון בין שני מכשירים');
  const K1b = mk('k1b');
  await K1b.auth.signInWithPassword({ email: `test-kid1@${DOMAIN}`, password: pw });
  let gotEvent = false;
  const ch = K1b.channel('t-' + fam.family_id).on('postgres_changes', { event: '*', schema: 'public', table: 'change_log',
    filter: 'family_id=eq.' + fam.family_id }, () => { gotEvent = true; });
  const subOk = await new Promise(res => { ch.subscribe(s => { if (s === 'SUBSCRIBED') res(true); if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') res(false); }); setTimeout(() => res(false), 10000); });
  check('המכשיר השני מחובר לעדכונים חיים', subOk);
  const syncJob = await newJob(A, 400, 'סנכרון');
  for (let i = 0; i < 20 && !gotEvent; i++) await new Promise(r => setTimeout(r, 250));
  check('המכשיר השני קיבל הודעת עדכון מיד אחרי שההורה הוסיף עבודה', gotEvent);
  check('המכשיר השני רואה את העבודה החדשה', (await call(K1b, 'get_state')).instances.some(i => i.id === syncJob));
  await K1b.removeChannel(ch);

  // ---------------------------------------------------- התראות פוש (רישום המכשיר)
  head('התראות פוש: רישום מכשיר');
  await expectErr('כתובת מנוי לא תקינה נדחית', K1, 'save_push_subscription', { p_endpoint: 'http://x', p_p256dh: 'a', p_auth: 'b' }, 'bad_subscription');
  const fakeEp = 'https://push.invalid/test-' + rid();
  const sv = await tryCall(K1, 'save_push_subscription', { p_endpoint: fakeEp, p_p256dh: 'BTest', p_auth: 'aTest' });
  check('מכשיר נרשם להתראות', !sv.error, sv.error?.message);
  const dl = await tryCall(K1, 'delete_push_subscription', { p_endpoint: fakeEp });
  check('מכשיר בוטל מהתראות', !dl.error, dl.error?.message);

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

  // ---------------------------------------------------- איפוס
  head('איפוס כספי חד-פעמי');
  await expectErr('ילד לא יכול לאפס', K1, 'reset_money', { p_request_id: rid(), p_confirm: 'איפוס' }, 'forbidden');
  await expectErr('איפוס בלי לכתוב "איפוס" נחסם', P, 'reset_money', { p_request_id: rid(), p_confirm: 'כן' }, 'confirm_required');
  await expectErr('ילד לא רואה את סיכום האיפוס', K1, 'money_reset_preview', {}, 'forbidden');
  const pv = await call(P, 'money_reset_preview');
  check('לפני האיפוס מוצג סיכום לכל ילד', pv.kids.length === 2 && pv.records > 0, JSON.stringify(pv).slice(0, 200));
  const s0 = await call(P, 'get_state');
  const oldInc = s0.incomes.find(i => i.status === 'active' && i.kind === 'job' && i.child_id === A);
  const oldOpen = s0.incomes.find(i => i.status === 'active' && i.amount_cents > i.paid_cents && i.child_id === A);
  const ptsA = s0.members.find(m => m.id === A).totals.points_month;
  const rr = rid();
  const [x1, x2] = await Promise.all([1, 2].map(() => tryCall(P, 'reset_money', { p_request_id: rr, p_confirm: 'איפוס' })));
  check('איפוס כפול עם אותו מזהה: שתי הבקשות חזרו בלי שגיאה', !x1.error && !x2.error, JSON.stringify([x1.error?.message, x2.error?.message]));
  const sR = await call(P, 'get_state');
  check('כל הסכומים של כל הילדים חזרו לאפס', kids2(sR).every(m => ['balance', 'owed', 'earned_work', 'received', 'spent', 'opening', 'earned_work_month']
    .every(k => m.totals[k] === 0)), JSON.stringify(kids2(sR).map(m => m.totals)));
  check('יתרות הפתיחה פתוחות להזנה מחדש', kids2(sR).every(m => m.opening_set === false));
  check('רשומות כספיות ישנות לא מוצגות (בארכיון)', !sR.incomes.length && !sR.receipts.length && !sR.expenses.length && !sR.feed.length);
  check('המשתמשים נשארו', sR.members.length === s0.members.length && sR.members.every(m => s0.members.some(x => x.id === m.id && x.role === m.role)));
  check('העבודות הקבועות והמחירים נשארו', JSON.stringify(sR.templates) === JSON.stringify(s0.templates));
  check('העבודות (היסטוריה לא כספית) נשארו', sR.instances.length === s0.instances.length);
  const gR = sR.members.find(m => m.id === A);
  check('יעד החיסכון נשאר (שם וסכום), וההתקדמות התאפסה', gR.goal_name === 'אופניים חדשות' && gR.goal_cents === 900000 && gR.goal_progress === 0, JSON.stringify(gR));
  eq('הניקוד בתחרות לא התאפס', gR.totals.points_month, ptsA);
  check('ההגדרות נשארו', sR.family.competition_enabled === s0.family.competition_enabled && sR.family.payday === s0.family.payday);
  check('האיפוס נרשם ביומן, וההיסטוריה הקודמת ביומן נשמרה', sR.audit.some(a => a.action === 'reset_money') && sR.audit.some(a => a.action === 'approve_job'));
  check('האיפוס מסומן בתאריך', !!sR.family.money_reset_at);
  await expectErr('הכנסה ישנה לא ניתנת לביטול (לא חוזרת לחישובים)', P, 'void_record', { p_request_id: rid(), p_kind: 'income', p_id: oldInc.id, p_reason: 'x', p_mode: 'keep_as_gift' }, 'not_found');
  await expectErr('חוב ישן שאופס לא ניתן לתשלום', P, 'record_payment', { p_request_id: rid(), p_child_id: A, p_income_ids: [oldOpen.id],
    p_amount_cents: 100, p_date: null, p_method: 'cash', p_note: null }, 'bad_income');
  await expectErr('עבודה ישנה שאושרה לא מאושרת שוב (לא יוצרת חוב מחדש)', P, 'review_job', { p_request_id: rid(), p_instance_id: oldInc.job_instance_id,
    p_action: 'approve', p_note: null, p_price_cents: null }, 'already_approved');
  eq('אחרי כל הניסיונות "מגיע" נשאר 0', (await totals(K1, A)).owed, 0);
  const kR = await call(K1, 'get_state');
  check('גם במכשיר של הילד הכול מאופס', kR.me.id === A && kR.members.find(m => m.id === A).totals.balance === 0 && !kR.incomes.length);
  await call(K1, 'set_opening_balance', { p_request_id: rid(), p_member_id: A, p_cents: 4200, p_reason: null });
  eq('אחרי האיפוס הילד רושם יתרת פתיחה חדשה', (await totals(K1, A)).balance, 4200);
  const fresh = await job(A, 1000, 'אחרי איפוס');
  await pay(A, [fresh.inc], 1000);
  const tF = await totals(K1, A);
  check('אחרי האיפוס החישוב מתחיל נקי: 42 + 10 = 52 ₪', tF.balance === 5200 && tF.received === 1000 && tF.owed === 0, JSON.stringify(tF));

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
