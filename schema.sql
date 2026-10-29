-- =====================================================================
-- "הכסף שלי" — מבנה מסד הנתונים, הרשאות ופונקציות שרת (גרסה 1)
-- להרצה פעם אחת ב-Supabase: SQL Editor -> הדבקה -> Run
-- הקובץ לא מכיל שום פרט אמיתי של המשפחה, סיסמה או מפתח סודי.
--
-- עקרונות:
-- * כל הסכומים באגורות (bigint).
-- * הדפדפן לא כותב ישירות לטבלאות. כל שינוי עובר דרך פונקציה שבודקת
--   מי המשתמש, מה התפקיד שלו ולאיזו משפחה הוא שייך.
-- * כל פעולה כותבת נושאת מזהה בקשה (request_id) — שליחה חוזרת לא מכפילה.
-- * אין מחיקה של רשומות כספיות. ביטול = סטטוס "voided" עם מי/מתי/למה.
-- * אזור זמן: Asia/Jerusalem.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists kp;           -- פונקציות עזר פנימיות (לא חשופות ל-API)
revoke all on schema kp from public, anon, authenticated;

-- ---------------------------------------------------------------- tables

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_test boolean not null default false,
  competition_enabled boolean not null default true,
  payday smallint check (payday between 0 and 6),          -- 0=ראשון ... 6=שבת
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id),
  user_id uuid unique,                                      -- auth.users.id
  login_email text not null,
  display_name text not null,
  role text not null check (role in ('parent','child')),
  gender text not null default 'f' check (gender in ('f','m')),
  opening_balance_cents bigint not null default 0 check (opening_balance_cents >= 0),
  goal_name text,
  goal_cents bigint check (goal_cents is null or goal_cents > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (family_id, login_email)
);

create table if not exists public.job_templates (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id),
  title text not null,
  description text,
  active boolean not null default true,
  created_by uuid references public.members(id),
  created_at timestamptz not null default now()
);

create table if not exists public.template_assignees (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id),
  template_id uuid not null references public.job_templates(id),
  child_id uuid not null references public.members(id),
  price_cents bigint not null check (price_cents > 0),
  payer_member_id uuid references public.members(id),
  payer_name text,
  created_at timestamptz not null default now(),
  unique (template_id, child_id),
  check ((payer_member_id is null) <> (payer_name is null))
);

create table if not exists public.job_instances (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id),
  template_id uuid references public.job_templates(id),
  group_id uuid,
  child_id uuid not null references public.members(id),
  title text not null,
  description text,
  price_cents bigint not null check (price_cents > 0),
  payer_member_id uuid references public.members(id),
  payer_name text,
  job_date date not null,
  status text not null check (status in ('todo','pending','approved','needs_fix','cancelled')),
  note text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.members(id),
  created_by uuid references public.members(id),
  created_at timestamptz not null default now(),
  check ((payer_member_id is null) <> (payer_name is null))
);

create table if not exists public.incomes (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id),
  child_id uuid not null references public.members(id),
  kind text not null check (kind in ('job','external_job','gift','allowance','other')),
  amount_cents bigint not null check (amount_cents > 0),
  income_date date not null,
  description text not null,
  payer_member_id uuid references public.members(id),
  payer_name text,
  job_instance_id uuid references public.job_instances(id),
  status text not null check (status in ('pending','active','rejected','voided')),
  reported_received boolean not null default false,
  reported_method text,
  created_by uuid references public.members(id),
  created_at timestamptz not null default now(),
  reviewed_by uuid references public.members(id),
  reviewed_at timestamptz,
  review_note text,
  voided_by uuid references public.members(id),
  voided_at timestamptz,
  void_reason text,
  check ((payer_member_id is null) <> (payer_name is null))
);
-- מופע עבודה יכול ליצור לכל היותר הכנסה פעילה אחת
create unique index if not exists incomes_one_active_per_job
  on public.incomes(job_instance_id) where status = 'active' and job_instance_id is not null;

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id),
  child_id uuid not null references public.members(id),
  amount_cents bigint not null check (amount_cents > 0),
  received_date date not null,
  method text not null check (method in ('cash','bit','transfer','other')),
  payer_member_id uuid references public.members(id),
  payer_name text,
  note text,
  recorded_by uuid references public.members(id),
  created_at timestamptz not null default now(),
  child_ack text not null default 'none' check (child_ack in ('none','confirmed','disputed')),
  ack_note text,
  ack_at timestamptz,
  status text not null default 'active' check (status in ('active','voided')),
  voided_by uuid references public.members(id),
  voided_at timestamptz,
  void_reason text
);

create table if not exists public.allocations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id),
  receipt_id uuid not null references public.receipts(id),
  income_id uuid not null references public.incomes(id),
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'active' check (status in ('active','voided')),
  created_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id),
  child_id uuid not null references public.members(id),
  amount_cents bigint not null check (amount_cents > 0),
  expense_date date not null,
  description text not null,
  status text not null check (status in ('pending','approved','rejected','voided')),
  negative_confirmed boolean not null default false,
  created_by uuid references public.members(id),
  created_at timestamptz not null default now(),
  reviewed_by uuid references public.members(id),
  reviewed_at timestamptz,
  review_note text,
  voided_by uuid references public.members(id),
  voided_at timestamptz,
  void_reason text
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id),
  actor_member_id uuid,
  action text not null,
  entity text,
  entity_id uuid,
  reason text,
  details jsonb,
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.requests (
  request_id uuid primary key,
  family_id uuid,
  member_id uuid,
  fn text not null,
  result jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.change_log (
  family_id uuid primary key references public.families(id),
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.restore_snapshots (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  data jsonb not null
);

create index if not exists idx_members_family on public.members(family_id);
create index if not exists idx_inst_family on public.job_instances(family_id, status);
create index if not exists idx_inc_child on public.incomes(child_id, status);
create index if not exists idx_rec_child on public.receipts(child_id, status);
create index if not exists idx_alloc_income on public.allocations(income_id);
create index if not exists idx_alloc_receipt on public.allocations(receipt_id);
create index if not exists idx_exp_child on public.expenses(child_id, status);
create index if not exists idx_audit_family on public.audit_log(family_id, created_at);

-- ------------------------------------------------- lock everything down
-- RLS פעיל בכל הטבלאות וללא מדיניות קריאה/כתיבה ישירה — הגישה רק דרך הפונקציות.
do $$
declare t text;
begin
  foreach t in array array['families','members','job_templates','template_assignees','job_instances',
    'incomes','receipts','allocations','expenses','audit_log','requests','change_log','restore_snapshots']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- change_log: מונה גרסה בלבד, כדי שהמכשירים ידעו לרענן (Realtime).
create or replace function public.my_family_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select family_id from public.members where user_id = auth.uid() and active limit 1
$$;

grant select on public.change_log to authenticated;
drop policy if exists change_log_family_read on public.change_log;
create policy change_log_family_read on public.change_log for select to authenticated
  using (family_id = public.my_family_id());

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname='supabase_realtime'
                     and schemaname='public' and tablename='change_log') then
    execute 'alter publication supabase_realtime add table public.change_log';
  end if;
end $$;

-- ------------------------------------------------------------ helpers

create or replace function kp.today() returns date language sql stable as $$
  select (now() at time zone 'Asia/Jerusalem')::date
$$;

create or replace function kp.shekel(p_cents bigint) returns text language sql immutable as $$
  select case when p_cents % 100 = 0 then (p_cents / 100)::text
              else to_char(p_cents / 100.0, 'FM999999990.00') end
$$;

create or replace function kp.fail(p_code text, p_msg text) returns void language plpgsql as $$
begin
  raise exception using message = p_msg, hint = p_code;
end $$;

-- המשתמש המחובר (חבר פעיל במשפחה) — או שגיאה
create or replace function kp.me() returns public.members language plpgsql stable as $$
declare v public.members;
begin
  if auth.uid() is null then perform kp.fail('not_authenticated','יש להתחבר'); end if;
  select * into v from public.members where user_id = auth.uid() and active;
  if not found then perform kp.fail('not_member','המשתמש לא משויך למשפחה'); end if;
  return v;
end $$;

create or replace function kp.require_parent(p_me public.members) returns void language plpgsql as $$
begin
  if p_me.role <> 'parent' then perform kp.fail('forbidden','רק הורה יכול לבצע פעולה זו'); end if;
end $$;

-- ילד במשפחה של המשתמש. ילד יכול לפעול רק על עצמו.
create or replace function kp.child_for(p_me public.members, p_child uuid) returns public.members
language plpgsql as $$
declare v public.members;
begin
  if p_me.role = 'child' and p_child is distinct from p_me.id then
    perform kp.fail('forbidden','אפשר לפעול רק על הנתונים שלך');
  end if;
  select * into v from public.members where id = p_child and family_id = p_me.family_id and role = 'child' and active;
  if not found then perform kp.fail('not_found','הילד לא נמצא'); end if;
  return v;
end $$;

-- מניעת כפילויות: אותו request_id מחזיר את התוצאה הקודמת
create or replace function kp.req_start(p_request_id uuid, p_me public.members, p_fn text) returns jsonb
language plpgsql as $$
declare v_n int; v_r public.requests;
begin
  if p_request_id is null then perform kp.fail('missing_request_id','חסר מזהה בקשה'); end if;
  insert into public.requests(request_id, family_id, member_id, fn)
  values (p_request_id, p_me.family_id, p_me.id, p_fn)
  on conflict (request_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 1 then return null; end if;
  select * into v_r from public.requests where request_id = p_request_id;
  if v_r.member_id is distinct from p_me.id or v_r.fn <> p_fn then
    perform kp.fail('bad_request_id','מזהה בקשה לא תקין');
  end if;
  return coalesce(v_r.result, '{}'::jsonb) || '{"duplicate":true}'::jsonb;
end $$;

create or replace function kp.req_done(p_request_id uuid, p_result jsonb) returns jsonb language plpgsql as $$
begin
  update public.requests set result = p_result where request_id = p_request_id;
  return p_result;
end $$;

create or replace function kp.touch(p_family uuid) returns void language sql as $$
  insert into public.change_log(family_id, version, updated_at) values (p_family, 1, now())
  on conflict (family_id) do update set version = public.change_log.version + 1, updated_at = now();
$$;

create or replace function kp.audit(p_me public.members, p_action text, p_entity text, p_id uuid,
  p_reason text default null, p_details jsonb default null) returns void language sql as $$
  insert into public.audit_log(family_id, actor_member_id, action, entity, entity_id, reason, details)
  values (p_me.family_id, p_me.id, p_action, p_entity, p_id, p_reason, p_details);
$$;

create or replace function kp.cents(p_amount bigint) returns bigint language plpgsql as $$
begin
  if p_amount is null or p_amount <= 0 then perform kp.fail('bad_amount','הסכום חייב להיות גדול מאפס'); end if;
  if p_amount > 100000000 then perform kp.fail('bad_amount','הסכום גדול מדי'); end if;
  return p_amount;
end $$;

-- משלם: הורה במשפחה, או שם של מקור אחר
create or replace function kp.check_payer(p_family uuid, p_member uuid, p_name text) returns text
language plpgsql as $$
begin
  if p_member is not null then
    if not exists (select 1 from public.members where id = p_member and family_id = p_family and role = 'parent') then
      perform kp.fail('bad_payer','המשלם חייב להיות הורה במשפחה או מקור אחר');
    end if;
    return null;
  end if;
  if nullif(trim(p_name), '') is null then perform kp.fail('bad_payer','צריך לבחור מי משלם'); end if;
  return trim(p_name);
end $$;

create or replace function kp.text_req(p_text text, p_what text) returns text language plpgsql as $$
begin
  if nullif(trim(p_text), '') is null then perform kp.fail('missing_text', 'חסר ' || p_what); end if;
  return left(trim(p_text), 300);
end $$;

-- כמה שולם בפועל על הכנסה (רק שיוכים פעילים של תקבולים פעילים)
create or replace function kp.paid(p_income uuid) returns bigint language sql stable as $$
  select coalesce(sum(a.amount_cents), 0)::bigint
  from public.allocations a join public.receipts r on r.id = a.receipt_id
  where a.income_id = p_income and a.status = 'active' and r.status = 'active'
$$;

create or replace function kp.balance(p_child uuid) returns bigint language sql stable as $$
  select m.opening_balance_cents
    + coalesce((select sum(amount_cents) from public.receipts where child_id = p_child and status = 'active'), 0)
    - coalesce((select sum(amount_cents) from public.expenses where child_id = p_child and status = 'approved'), 0)
  from public.members m where m.id = p_child
$$;

create or replace function kp.child_totals(p_child uuid, p_month text) returns jsonb language sql stable as $$
  with inc as (
    select i.kind, i.amount_cents, i.income_date, kp.paid(i.id) as paid
    from public.incomes i where i.child_id = p_child and i.status = 'active'
  ), t as (
    select
      coalesce((select sum(amount_cents) from inc where kind in ('job','external_job')), 0) as earned_work,
      coalesce((select sum(amount_cents) from inc where kind in ('job','external_job')
                and to_char(income_date,'YYYY-MM') = p_month), 0) as earned_work_month,
      coalesce((select sum(amount_cents - paid) from inc), 0) as owed,
      coalesce((select sum(amount_cents) from public.receipts where child_id = p_child and status = 'active'), 0) as received,
      coalesce((select sum(amount_cents) from public.expenses where child_id = p_child and status = 'approved'), 0) as spent,
      (select count(*) from inc where kind in ('job','external_job') and to_char(income_date,'YYYY-MM') = p_month) as points_month,
      (select opening_balance_cents from public.members where id = p_child) as opening
  )
  select jsonb_build_object(
    'earned_work', earned_work, 'earned_work_month', earned_work_month, 'owed', owed,
    'received', received, 'spent', spent, 'opening', opening,
    'balance', opening + received - spent, 'points_month', points_month)
  from t
$$;

-- יצירת תקבול ושיוך מלא להכנסה אחת (הכנסה שהתקבלה מיד)
create or replace function kp.receive_now(p_me public.members, p_income public.incomes, p_method text, p_date date)
returns uuid language plpgsql as $$
declare v_r uuid;
begin
  insert into public.receipts(family_id, child_id, amount_cents, received_date, method, payer_member_id, payer_name, note, recorded_by)
  values (p_income.family_id, p_income.child_id, p_income.amount_cents, coalesce(p_date, kp.today()),
          coalesce(nullif(p_method,''),'other'), p_income.payer_member_id, p_income.payer_name,
          'התקבל יחד עם ההכנסה', p_me.id)
  returning id into v_r;
  insert into public.allocations(family_id, receipt_id, income_id, amount_cents)
  values (p_income.family_id, v_r, p_income.id, p_income.amount_cents);
  return v_r;
end $$;

-- ---------------------------------------------------- export / restore

create or replace function kp.export_data(p_family uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'family', (select jsonb_build_object('name', name, 'competition_enabled', competition_enabled, 'payday', payday)
               from public.families where id = p_family),
    'members', coalesce((select jsonb_agg(to_jsonb(x) - 'family_id' - 'user_id' order by x.created_at, x.id)
               from public.members x where family_id = p_family), '[]'::jsonb),
    'job_templates', coalesce((select jsonb_agg(to_jsonb(x) - 'family_id' order by x.created_at, x.id)
               from public.job_templates x where family_id = p_family), '[]'::jsonb),
    'template_assignees', coalesce((select jsonb_agg(to_jsonb(x) - 'family_id' order by x.created_at, x.id)
               from public.template_assignees x where family_id = p_family), '[]'::jsonb),
    'job_instances', coalesce((select jsonb_agg(to_jsonb(x) - 'family_id' order by x.created_at, x.id)
               from public.job_instances x where family_id = p_family), '[]'::jsonb),
    'incomes', coalesce((select jsonb_agg(to_jsonb(x) - 'family_id' order by x.created_at, x.id)
               from public.incomes x where family_id = p_family), '[]'::jsonb),
    'receipts', coalesce((select jsonb_agg(to_jsonb(x) - 'family_id' order by x.created_at, x.id)
               from public.receipts x where family_id = p_family), '[]'::jsonb),
    'allocations', coalesce((select jsonb_agg(to_jsonb(x) - 'family_id' order by x.created_at, x.id)
               from public.allocations x where family_id = p_family), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(to_jsonb(x) - 'family_id' order by x.created_at, x.id)
               from public.expenses x where family_id = p_family), '[]'::jsonb),
    'audit_log', coalesce((select jsonb_agg(to_jsonb(x) - 'family_id' order by x.created_at, x.id)
               from public.audit_log x where family_id = p_family), '[]'::jsonb)
  )
$$;

create or replace function kp.wipe_family_data(p_family uuid) returns void language plpgsql as $$
begin
  delete from public.allocations where family_id = p_family;
  delete from public.receipts where family_id = p_family;
  delete from public.expenses where family_id = p_family;
  delete from public.incomes where family_id = p_family;
  delete from public.job_instances where family_id = p_family;
  delete from public.template_assignees where family_id = p_family;
  delete from public.job_templates where family_id = p_family;
  delete from public.audit_log where family_id = p_family;
  delete from public.members where family_id = p_family;
end $$;

create or replace function kp.restore_into(p_family uuid, d jsonb) returns void language plpgsql as $$
begin
  perform kp.wipe_family_data(p_family);
  update public.families set
    name = coalesce(d->'family'->>'name', name),
    competition_enabled = coalesce((d->'family'->>'competition_enabled')::boolean, true),
    payday = (d->'family'->>'payday')::smallint
  where id = p_family;

  insert into public.members
  select (jsonb_populate_record(null::public.members, r || jsonb_build_object(
    'family_id', p_family,
    'user_id', (select u.id from auth.users u where lower(u.email) = lower(r->>'login_email')
                and not exists (select 1 from public.members m2 where m2.user_id = u.id) limit 1)))).*
  from jsonb_array_elements(d->'members') r;

  insert into public.job_templates select (jsonb_populate_record(null::public.job_templates, r || jsonb_build_object('family_id', p_family))).* from jsonb_array_elements(d->'job_templates') r;
  insert into public.template_assignees select (jsonb_populate_record(null::public.template_assignees, r || jsonb_build_object('family_id', p_family))).* from jsonb_array_elements(d->'template_assignees') r;
  insert into public.job_instances select (jsonb_populate_record(null::public.job_instances, r || jsonb_build_object('family_id', p_family))).* from jsonb_array_elements(d->'job_instances') r;
  insert into public.incomes select (jsonb_populate_record(null::public.incomes, r || jsonb_build_object('family_id', p_family))).* from jsonb_array_elements(d->'incomes') r;
  insert into public.receipts select (jsonb_populate_record(null::public.receipts, r || jsonb_build_object('family_id', p_family))).* from jsonb_array_elements(d->'receipts') r;
  insert into public.allocations select (jsonb_populate_record(null::public.allocations, r || jsonb_build_object('family_id', p_family))).* from jsonb_array_elements(d->'allocations') r;
  insert into public.expenses select (jsonb_populate_record(null::public.expenses, r || jsonb_build_object('family_id', p_family))).* from jsonb_array_elements(d->'expenses') r;
  insert into public.audit_log select (jsonb_populate_record(null::public.audit_log, r || jsonb_build_object('family_id', p_family))).* from jsonb_array_elements(d->'audit_log') r;
end $$;

create or replace function kp.purge_family(p_family uuid) returns void language plpgsql as $$
begin
  if not exists (select 1 from public.families where id = p_family and is_test) then
    perform kp.fail('forbidden','אפשר למחוק רק משפחת בדיקה');
  end if;
  perform kp.wipe_family_data(p_family);
  delete from public.requests where family_id = p_family;
  delete from public.restore_snapshots where family_id = p_family;
  delete from public.change_log where family_id = p_family;
  delete from public.families where id = p_family;
end $$;

-- =================================================================== RPC
-- כל הפונקציות הציבוריות: security definer + בדיקת זהות ותפקיד בתוכן.

create or replace function public.setup_family(p_family_name text, p_display_name text, p_gender text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text; v_fam uuid; v_mem public.members;
begin
  if auth.uid() is null then perform kp.fail('not_authenticated','יש להתחבר'); end if;
  perform pg_advisory_xact_lock(hashtext('kesef_setup'));
  if exists (select 1 from public.families where not is_test) then
    perform kp.fail('already_setup','המשפחה כבר הוגדרה. בקשו מהורה להוסיף אתכם.');
  end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    perform kp.fail('already_member','המשתמש כבר משויך למשפחה');
  end if;
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email like 'test-%' then perform kp.fail('forbidden','משתמש בדיקה לא יכול ליצור משפחה אמיתית'); end if;
  insert into public.families(name) values (kp.text_req(p_family_name,'שם משפחה')) returning id into v_fam;
  insert into public.members(family_id, user_id, login_email, display_name, role, gender)
  values (v_fam, auth.uid(), v_email, kp.text_req(p_display_name,'שם'), 'parent', coalesce(p_gender,'f'))
  returning * into v_mem;
  perform kp.audit(v_mem, 'setup_family', 'family', v_fam);
  perform kp.touch(v_fam);
  return jsonb_build_object('family_id', v_fam, 'member_id', v_mem.id);
end $$;

create or replace function public.whoami() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.members;
begin
  if auth.uid() is null then return jsonb_build_object('authenticated', false); end if;
  select * into v from public.members where user_id = auth.uid() and active;
  return jsonb_build_object('authenticated', true, 'member', found,
    'family_exists', exists (select 1 from public.families where not is_test));
end $$;

-- ----------------------------------------------------------- state read
create or replace function public.get_state() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me public.members := kp.me();
  v_fam public.families;
  v_parent boolean := me.role = 'parent';
  v_month text := to_char(kp.today(), 'YYYY-MM');
  v_res jsonb;
begin
  select * into v_fam from public.families where id = me.family_id;

  select jsonb_build_object(
    'me', jsonb_build_object('id', me.id, 'display_name', me.display_name, 'role', me.role, 'gender', me.gender),
    'family', jsonb_build_object('id', v_fam.id, 'name', v_fam.name, 'is_test', v_fam.is_test,
              'competition_enabled', v_fam.competition_enabled, 'payday', v_fam.payday),
    'today', kp.today(),
    'month', v_month,
    'version', (select version from public.change_log where family_id = me.family_id),

    'members', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', m.id, 'display_name', m.display_name, 'role', m.role, 'gender', m.gender,
          'active', m.active, 'goal_name', m.goal_name, 'goal_cents', m.goal_cents)
        || case when m.role = 'child' then
             (case when v_parent or m.id = me.id
                then jsonb_build_object('totals', kp.child_totals(m.id, v_month))
                else jsonb_build_object('totals', (kp.child_totals(m.id, v_month)
                       - 'balance' - 'received' - 'spent' - 'opening' - 'earned_work'))
              end)
             || jsonb_build_object('goal_pct', case when m.goal_cents is null then null
                  else least(100, greatest(0, floor(kp.balance(m.id) * 100.0 / m.goal_cents)))::int end)
           else '{}'::jsonb end
        || case when v_parent then jsonb_build_object('login_email', m.login_email, 'linked', m.user_id is not null) else '{}'::jsonb end
        order by m.role desc, m.created_at)
      from public.members m where m.family_id = me.family_id and (m.active or v_parent)), '[]'::jsonb),

    -- הכנסות מאושרות: גלויות לכל המשפחה
    'feed', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'child_id', i.child_id, 'kind', i.kind,
        'amount_cents', i.amount_cents, 'income_date', i.income_date, 'description', i.description)
        order by i.income_date desc, i.created_at desc)
      from (select * from public.incomes where family_id = me.family_id and status = 'active'
            order by income_date desc, created_at desc limit 400) i), '[]'::jsonb),

    -- ניקוד לפי חודש (מופעי עבודה מאושרים בלבד)
    'points', coalesce((
      select jsonb_agg(jsonb_build_object('month', mo, 'child_id', child_id, 'points', n) order by mo desc)
      from (select to_char(income_date,'YYYY-MM') mo, child_id, count(*) n from public.incomes
            where family_id = me.family_id and status = 'active' and kind in ('job','external_job')
            group by 1, 2) p), '[]'::jsonb),

    -- פרטים מלאים: לילד רק שלו, להורה הכול
    'incomes', coalesce((
      select jsonb_agg(to_jsonb(i) - 'family_id' || jsonb_build_object('paid_cents', kp.paid(i.id))
        order by i.income_date desc, i.created_at desc)
      from public.incomes i where i.family_id = me.family_id and (v_parent or i.child_id = me.id)), '[]'::jsonb),

    'receipts', coalesce((
      select jsonb_agg(to_jsonb(r) - 'family_id' || jsonb_build_object('allocations',
        coalesce((select jsonb_agg(jsonb_build_object('income_id', a.income_id, 'amount_cents', a.amount_cents, 'status', a.status))
                  from public.allocations a where a.receipt_id = r.id), '[]'::jsonb))
        order by r.received_date desc, r.created_at desc)
      from public.receipts r where r.family_id = me.family_id and (v_parent or r.child_id = me.id)), '[]'::jsonb),

    'expenses', coalesce((
      select jsonb_agg(to_jsonb(e) - 'family_id' order by e.expense_date desc, e.created_at desc)
      from public.expenses e where e.family_id = me.family_id and (v_parent or e.child_id = me.id)), '[]'::jsonb),

    'templates', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'description', t.description, 'active', t.active,
        'assignees', coalesce((select jsonb_agg(jsonb_build_object('child_id', a.child_id, 'price_cents', a.price_cents,
                       'payer_member_id', a.payer_member_id, 'payer_name', a.payer_name) order by a.created_at)
                     from public.template_assignees a where a.template_id = t.id and (v_parent or a.child_id = me.id)), '[]'::jsonb))
        order by t.created_at)
      from public.job_templates t where t.family_id = me.family_id
        and (v_parent or (t.active and exists (select 1 from public.template_assignees a where a.template_id = t.id and a.child_id = me.id)))), '[]'::jsonb),

    'instances', coalesce((
      select jsonb_agg(to_jsonb(j) - 'family_id' order by j.created_at desc)
      from (select * from public.job_instances where family_id = me.family_id and (v_parent or child_id = me.id)
            and (status in ('todo','pending','needs_fix') or created_at > now() - interval '120 days')
            order by created_at desc limit 500) j), '[]'::jsonb),

    'audit', case when v_parent then coalesce((
      select jsonb_agg(to_jsonb(a) - 'family_id' order by a.created_at desc)
      from (select * from public.audit_log where family_id = me.family_id order by created_at desc limit 150) a), '[]'::jsonb)
      else '[]'::jsonb end
  ) into v_res;
  return v_res;
end $$;

-- ------------------------------------------------------------ members
create or replace function public.add_member(p_request_id uuid, p_email text, p_display_name text, p_role text, p_gender text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_email text := lower(trim(p_email)); v_uid uuid; v_m public.members;
begin
  perform kp.require_parent(me);
  v_dup := kp.req_start(p_request_id, me, 'add_member'); if v_dup is not null then return v_dup; end if;
  if p_role not in ('parent','child') then perform kp.fail('bad_role','תפקיד לא תקין'); end if;
  select id into v_uid from auth.users where lower(email) = v_email;
  if v_uid is null then
    perform kp.fail('user_not_found', 'לא נמצא משתמש ' || v_email || '. צרו אותו קודם ב-Supabase (Authentication → Add user).');
  end if;
  if exists (select 1 from public.members where user_id = v_uid) then
    perform kp.fail('already_member','המשתמש הזה כבר משויך');
  end if;
  select * into v_m from public.members where family_id = me.family_id and login_email = v_email;
  if found then    -- חבר קיים שעדיין לא חובר למשתמש (למשל אחרי שחזור)
    update public.members set user_id = v_uid where id = v_m.id returning * into v_m;
    perform kp.audit(me, 'link_member', 'member', v_m.id, null, jsonb_build_object('email', v_email));
  else
    insert into public.members(family_id, user_id, login_email, display_name, role, gender)
    values (me.family_id, v_uid, v_email, kp.text_req(p_display_name,'שם'), p_role, coalesce(p_gender,'f'))
    returning * into v_m;
    perform kp.audit(me, 'add_member', 'member', v_m.id, null, jsonb_build_object('email', v_email, 'role', p_role));
  end if;
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('member_id', v_m.id));
end $$;

create or replace function public.update_member(p_request_id uuid, p_member_id uuid, p_display_name text, p_gender text, p_active boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_old public.members;
begin
  perform kp.require_parent(me);
  v_dup := kp.req_start(p_request_id, me, 'update_member'); if v_dup is not null then return v_dup; end if;
  select * into v_old from public.members where id = p_member_id and family_id = me.family_id for update;
  if not found then perform kp.fail('not_found','לא נמצא'); end if;
  if v_old.id = me.id and not p_active then perform kp.fail('forbidden','אי אפשר להשבית את עצמך'); end if;
  update public.members set display_name = kp.text_req(p_display_name,'שם'), gender = coalesce(p_gender, gender),
    active = coalesce(p_active, active) where id = p_member_id;
  perform kp.audit(me, 'update_member', 'member', p_member_id, null,
    jsonb_build_object('old', jsonb_build_object('name', v_old.display_name, 'active', v_old.active),
                       'new', jsonb_build_object('name', p_display_name, 'active', p_active)));
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('ok', true));
end $$;

create or replace function public.set_opening_balance(p_request_id uuid, p_member_id uuid, p_cents bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_c public.members;
begin
  perform kp.require_parent(me);
  v_dup := kp.req_start(p_request_id, me, 'set_opening_balance'); if v_dup is not null then return v_dup; end if;
  select * into v_c from public.members where id = p_member_id and family_id = me.family_id and role = 'child' for update;
  if not found then perform kp.fail('not_found','הילד לא נמצא'); end if;
  if p_cents is null or p_cents < 0 then perform kp.fail('bad_amount','יתרת פתיחה לא יכולה להיות שלילית'); end if;
  if v_c.opening_balance_cents <> 0 and nullif(trim(p_reason),'') is null then
    perform kp.fail('missing_reason','שינוי יתרת פתיחה קיימת דורש סיבה');
  end if;
  update public.members set opening_balance_cents = p_cents where id = p_member_id;
  perform kp.audit(me, 'set_opening_balance', 'member', p_member_id, nullif(trim(p_reason),''),
    jsonb_build_object('old', v_c.opening_balance_cents, 'new', p_cents));
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('ok', true));
end $$;

create or replace function public.set_goal(p_request_id uuid, p_member_id uuid, p_name text, p_cents bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_c public.members;
begin
  v_dup := kp.req_start(p_request_id, me, 'set_goal'); if v_dup is not null then return v_dup; end if;
  v_c := kp.child_for(me, p_member_id);
  if nullif(trim(p_name),'') is null then
    update public.members set goal_name = null, goal_cents = null where id = v_c.id;
  else
    update public.members set goal_name = left(trim(p_name),80), goal_cents = kp.cents(p_cents) where id = v_c.id;
  end if;
  perform kp.audit(me, 'set_goal', 'member', v_c.id, null, jsonb_build_object('name', p_name, 'cents', p_cents));
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('ok', true));
end $$;

create or replace function public.update_settings(p_request_id uuid, p_competition_enabled boolean, p_payday smallint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb;
begin
  perform kp.require_parent(me);
  v_dup := kp.req_start(p_request_id, me, 'update_settings'); if v_dup is not null then return v_dup; end if;
  if p_payday is not null and (p_payday < 0 or p_payday > 6) then perform kp.fail('bad_day','יום לא תקין'); end if;
  update public.families set competition_enabled = coalesce(p_competition_enabled, true), payday = p_payday
  where id = me.family_id;
  perform kp.audit(me, 'update_settings', 'family', me.family_id, null,
    jsonb_build_object('competition_enabled', p_competition_enabled, 'payday', p_payday));
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('ok', true));
end $$;

-- איפוס סיסמה לילד על ידי הורה (לכתובות המדומות אין תיבת דואר)
create or replace function public.reset_child_password(p_member_id uuid, p_new_password text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_c public.members;
begin
  perform kp.require_parent(me);
  select * into v_c from public.members where id = p_member_id and family_id = me.family_id and role = 'child';
  if not found or v_c.user_id is null then perform kp.fail('not_found','הילד לא נמצא או שאין לו משתמש'); end if;
  if p_new_password is null or length(p_new_password) < 6 or length(p_new_password) > 72 then
    perform kp.fail('weak_password','הסיסמה צריכה להיות באורך 6 עד 72 תווים');
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf', 10)),
    updated_at = now() where id = v_c.user_id;
  perform kp.audit(me, 'reset_password', 'member', v_c.id);   -- הסיסמה עצמה לא נשמרת ביומן
  return jsonb_build_object('ok', true);
end $$;

-- --------------------------------------------------------------- jobs
create or replace function public.save_template(p_request_id uuid, p_template_id uuid, p_title text, p_description text,
  p_active boolean, p_assignees jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_id uuid; a jsonb; v_old jsonb; v_name text;
begin
  perform kp.require_parent(me);
  v_dup := kp.req_start(p_request_id, me, 'save_template'); if v_dup is not null then return v_dup; end if;
  if p_assignees is null or jsonb_typeof(p_assignees) <> 'array' or jsonb_array_length(p_assignees) = 0 then
    perform kp.fail('no_assignees','צריך לבחור לפחות ילד אחד');
  end if;
  if p_template_id is null then
    insert into public.job_templates(family_id, title, description, active, created_by)
    values (me.family_id, kp.text_req(p_title,'שם עבודה'), nullif(trim(p_description),''), coalesce(p_active,true), me.id)
    returning id into v_id;
  else
    select id into v_id from public.job_templates where id = p_template_id and family_id = me.family_id for update;
    if v_id is null then perform kp.fail('not_found','התבנית לא נמצאה'); end if;
    select jsonb_agg(to_jsonb(x) - 'family_id') into v_old from public.template_assignees x where template_id = v_id;
    update public.job_templates set title = kp.text_req(p_title,'שם עבודה'), description = nullif(trim(p_description),''),
      active = coalesce(p_active, true) where id = v_id;
    -- שינוי מחיר בתבנית משפיע רק על מופעים עתידיים; מופעים קיימים שומרים את המחיר שלהם
    delete from public.template_assignees where template_id = v_id;
  end if;
  for a in select * from jsonb_array_elements(p_assignees) loop
    perform kp.child_for(me, (a->>'child_id')::uuid);
    v_name := kp.check_payer(me.family_id, nullif(a->>'payer_member_id','')::uuid, a->>'payer_name');
    insert into public.template_assignees(family_id, template_id, child_id, price_cents, payer_member_id, payer_name)
    values (me.family_id, v_id, (a->>'child_id')::uuid, kp.cents((a->>'price_cents')::bigint),
            nullif(a->>'payer_member_id','')::uuid, v_name);
  end loop;
  perform kp.audit(me, case when p_template_id is null then 'create_template' else 'update_template' end,
    'template', v_id, null, jsonb_build_object('title', p_title, 'old_assignees', v_old, 'new_assignees', p_assignees));
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('template_id', v_id));
end $$;

create or replace function public.create_job(p_request_id uuid, p_title text, p_description text, p_date date, p_assignees jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_group uuid := gen_random_uuid(); a jsonb; v_name text; v_ids uuid[] := '{}'; v_id uuid;
begin
  perform kp.require_parent(me);
  v_dup := kp.req_start(p_request_id, me, 'create_job'); if v_dup is not null then return v_dup; end if;
  if p_assignees is null or jsonb_typeof(p_assignees) <> 'array' or jsonb_array_length(p_assignees) = 0 then
    perform kp.fail('no_assignees','צריך לבחור לפחות ילד אחד');
  end if;
  for a in select * from jsonb_array_elements(p_assignees) loop
    perform kp.child_for(me, (a->>'child_id')::uuid);
    v_name := kp.check_payer(me.family_id, nullif(a->>'payer_member_id','')::uuid, a->>'payer_name');
    insert into public.job_instances(family_id, group_id, child_id, title, description, price_cents, payer_member_id, payer_name,
      job_date, status, created_by)
    values (me.family_id, v_group, (a->>'child_id')::uuid, kp.text_req(p_title,'שם עבודה'), nullif(trim(p_description),''),
      kp.cents((a->>'price_cents')::bigint), nullif(a->>'payer_member_id','')::uuid, v_name,
      coalesce(p_date, kp.today()), 'todo', me.id)
    returning id into v_id;
    v_ids := v_ids || v_id;
    perform kp.audit(me, 'create_job', 'job_instance', v_id, null, a || jsonb_build_object('title', p_title));
  end loop;
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('instance_ids', to_jsonb(v_ids)));
end $$;

-- "סיימתי עבודה": מופע קיים, או מופע חדש מתבנית קבועה
create or replace function public.submit_job(p_request_id uuid, p_instance_id uuid, p_template_id uuid, p_child_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_i public.job_instances; v_t public.job_templates;
  v_a public.template_assignees; v_child public.members;
begin
  v_dup := kp.req_start(p_request_id, me, 'submit_job'); if v_dup is not null then return v_dup; end if;
  if p_instance_id is not null then
    select * into v_i from public.job_instances where id = p_instance_id and family_id = me.family_id for update;
    if not found then perform kp.fail('not_found','העבודה לא נמצאה'); end if;
    perform kp.child_for(me, v_i.child_id);
    if v_i.status not in ('todo','needs_fix') then perform kp.fail('bad_status','העבודה כבר סומנה או טופלה'); end if;
    update public.job_instances set status = 'pending', submitted_at = now(),
      note = coalesce(nullif(trim(p_note),''), note) where id = v_i.id;
  else
    v_child := kp.child_for(me, coalesce(p_child_id, me.id));
    select * into v_t from public.job_templates where id = p_template_id and family_id = me.family_id and active;
    if not found then perform kp.fail('not_found','העבודה לא נמצאה'); end if;
    select * into v_a from public.template_assignees where template_id = v_t.id and child_id = v_child.id;
    if not found then perform kp.fail('forbidden','העבודה הזו לא מוקצית לך'); end if;
    insert into public.job_instances(family_id, template_id, child_id, title, description, price_cents, payer_member_id,
      payer_name, job_date, status, note, submitted_at, created_by)
    values (me.family_id, v_t.id, v_child.id, v_t.title, v_t.description, v_a.price_cents, v_a.payer_member_id,
      v_a.payer_name, kp.today(), 'pending', nullif(trim(p_note),''), now(), me.id)
    returning * into v_i;
  end if;
  perform kp.audit(me, 'submit_job', 'job_instance', v_i.id);
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('instance_id', v_i.id));
end $$;

-- עבודה שסומנה בטעות: עבודה חד-פעמית חוזרת ל"לביצוע"; ביצוע של עבודה קבועה מבוטל (הוא נוצר רק בלחיצה)
create or replace function kp.reopen_instance(p_i public.job_instances, p_note text) returns void
language sql as $$
  update public.job_instances
     set status = case when p_i.template_id is null then 'todo' else 'cancelled' end,
         note = p_note, submitted_at = null, reviewed_at = now()
   where id = p_i.id;
$$;

-- ביטול דיווח שעוד לא אושר: הילד על הדיווחים שלו, או הורה. דיווח שאושר מתקנים דרך void_record.
create or replace function public.withdraw_report(p_request_id uuid, p_kind text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_i public.job_instances; v_inc public.incomes; v_e public.expenses;
  v_note text;
begin
  v_dup := kp.req_start(p_request_id, me, 'withdraw_report'); if v_dup is not null then return v_dup; end if;
  v_note := case when me.role = 'parent' then 'בוטל על ידי הורה: נרשם בטעות' else 'בוטל: נרשם בטעות' end;
  if p_kind = 'job' then
    select * into v_i from public.job_instances where id = p_id and family_id = me.family_id for update;
    if not found then perform kp.fail('not_found','העבודה לא נמצאה'); end if;
    perform kp.child_for(me, v_i.child_id);
    if v_i.status <> 'pending' then perform kp.fail('bad_status','אפשר לבטל רק סימון שעוד ממתין לאישור'); end if;
    perform kp.reopen_instance(v_i, v_note);
  elsif p_kind = 'income' then
    select * into v_inc from public.incomes where id = p_id and family_id = me.family_id for update;
    if not found then perform kp.fail('not_found','הרישום לא נמצא'); end if;
    perform kp.child_for(me, v_inc.child_id);
    if v_inc.status <> 'pending' then perform kp.fail('bad_status','אפשר לבטל רק דיווח שעוד ממתין לאישור'); end if;
    update public.incomes set status = 'rejected', reviewed_by = me.id, reviewed_at = now(), review_note = v_note where id = v_inc.id;
  elsif p_kind = 'expense' then
    select * into v_e from public.expenses where id = p_id and family_id = me.family_id for update;
    if not found then perform kp.fail('not_found','ההוצאה לא נמצאה'); end if;
    perform kp.child_for(me, v_e.child_id);
    if v_e.status <> 'pending' then perform kp.fail('bad_status','אפשר לבטל רק דיווח שעוד ממתין לאישור'); end if;
    update public.expenses set status = 'rejected', reviewed_by = me.id, reviewed_at = now(), review_note = v_note where id = v_e.id;
  else
    perform kp.fail('bad_kind','סוג לא מוכר');
  end if;
  perform kp.audit(me, 'withdraw_' || p_kind, case p_kind when 'job' then 'job_instance' else p_kind end, p_id, v_note);
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('ok', true));
end $$;

-- אישור / תיקון / ביטול / שינוי מחיר — הורה בלבד. רק אישור יוצר הכנסה.
create or replace function public.review_job(p_request_id uuid, p_instance_id uuid, p_action text, p_note text, p_price_cents bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_i public.job_instances; v_inc uuid;
begin
  perform kp.require_parent(me);
  v_dup := kp.req_start(p_request_id, me, 'review_job'); if v_dup is not null then return v_dup; end if;
  select * into v_i from public.job_instances where id = p_instance_id and family_id = me.family_id for update;
  if not found then perform kp.fail('not_found','העבודה לא נמצאה'); end if;

  if p_action = 'approve' then
    if v_i.status = 'approved' then perform kp.fail('already_approved','העבודה כבר אושרה'); end if;
    if v_i.status = 'cancelled' then perform kp.fail('bad_status','העבודה בוטלה'); end if;
    if p_price_cents is not null and p_price_cents <> v_i.price_cents then
      perform kp.audit(me, 'change_price', 'job_instance', v_i.id, nullif(trim(p_note),''),
        jsonb_build_object('old', v_i.price_cents, 'new', kp.cents(p_price_cents)));
      v_i.price_cents := p_price_cents;
    end if;
    update public.job_instances set status = 'approved', price_cents = v_i.price_cents, reviewed_at = now(),
      reviewed_by = me.id where id = v_i.id;
    insert into public.incomes(family_id, child_id, kind, amount_cents, income_date, description, payer_member_id, payer_name,
      job_instance_id, status, created_by, reviewed_by, reviewed_at)
    values (me.family_id, v_i.child_id, 'job', v_i.price_cents, kp.today(), v_i.title, v_i.payer_member_id, v_i.payer_name,
      v_i.id, 'active', me.id, me.id, now())
    returning id into v_inc;
    perform kp.audit(me, 'approve_job', 'job_instance', v_i.id, null, jsonb_build_object('income_id', v_inc, 'amount', v_i.price_cents));
  elsif p_action = 'needs_fix' then
    if v_i.status not in ('pending','todo') then perform kp.fail('bad_status','אי אפשר לבקש תיקון במצב הנוכחי'); end if;
    update public.job_instances set status = 'needs_fix', note = kp.text_req(p_note,'הסבר מה לתקן'),
      reviewed_at = now(), reviewed_by = me.id where id = v_i.id;
    perform kp.audit(me, 'needs_fix', 'job_instance', v_i.id, p_note);
  elsif p_action = 'cancel' then
    if v_i.status in ('approved','cancelled') then perform kp.fail('bad_status','אי אפשר לבטל במצב הנוכחי. לביטול אישור השתמשו בתיקון הכנסה.'); end if;
    update public.job_instances set status = 'cancelled', note = coalesce(nullif(trim(p_note),''), note),
      reviewed_at = now(), reviewed_by = me.id where id = v_i.id;
    perform kp.audit(me, 'cancel_job', 'job_instance', v_i.id, p_note);
  elsif p_action = 'reopen' then   -- "לא בוצע": סומן בטעות
    if v_i.status not in ('pending','needs_fix') then perform kp.fail('bad_status','אפשר להחזיר רק עבודה שממתינה לאישור'); end if;
    perform kp.reopen_instance(v_i, coalesce(nullif(trim(p_note),''), 'סומן בטעות'));
    perform kp.audit(me, 'reopen_job', 'job_instance', v_i.id, p_note);
  elsif p_action = 'edit_price' then
    if v_i.status in ('approved','cancelled') then perform kp.fail('price_locked','המחיר של עבודה שאושרה נשמר כפי שסוכם'); end if;
    update public.job_instances set price_cents = kp.cents(p_price_cents) where id = v_i.id;
    perform kp.audit(me, 'change_price', 'job_instance', v_i.id, p_note,
      jsonb_build_object('old', v_i.price_cents, 'new', p_price_cents));
  else
    perform kp.fail('bad_action','פעולה לא מוכרת');
  end if;
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('instance_id', v_i.id, 'income_id', v_inc));
end $$;

-- ------------------------------------------------------ other incomes
-- ילד: נרשם כ"ממתין" ולא משנה סיכומים. הורה: נרשם כמאושר מיד.
create or replace function public.report_income(p_request_id uuid, p_child_id uuid, p_kind text, p_amount_cents bigint,
  p_date date, p_source text, p_payer_member_id uuid, p_description text, p_received boolean, p_method text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_c public.members; v_inc public.incomes; v_name text; v_r uuid;
begin
  v_dup := kp.req_start(p_request_id, me, 'report_income'); if v_dup is not null then return v_dup; end if;
  v_c := kp.child_for(me, p_child_id);
  if p_kind not in ('external_job','gift','allowance','other') then perform kp.fail('bad_kind','סוג הכנסה לא תקין'); end if;
  v_name := kp.check_payer(me.family_id, p_payer_member_id, p_source);
  if p_method is not null and p_method not in ('cash','bit','transfer','other') then perform kp.fail('bad_method','אמצעי תשלום לא תקין'); end if;
  insert into public.incomes(family_id, child_id, kind, amount_cents, income_date, description, payer_member_id, payer_name,
    status, reported_received, reported_method, created_by, reviewed_by, reviewed_at)
  values (me.family_id, v_c.id, p_kind, kp.cents(p_amount_cents), coalesce(p_date, kp.today()),
    coalesce(nullif(trim(p_description),''), case p_kind when 'gift' then 'מתנה' when 'allowance' then 'דמי כיס'
      when 'external_job' then 'עבודה' else 'הכנסה' end),
    p_payer_member_id, v_name,
    case when me.role = 'parent' then 'active' else 'pending' end, coalesce(p_received,false), p_method, me.id,
    case when me.role = 'parent' then me.id end, case when me.role = 'parent' then now() end)
  returning * into v_inc;
  if me.role = 'parent' and coalesce(p_received,false) then
    v_r := kp.receive_now(me, v_inc, p_method, v_inc.income_date);
  end if;
  perform kp.audit(me, 'report_income', 'income', v_inc.id, null, jsonb_build_object('amount', p_amount_cents, 'kind', p_kind, 'received', p_received));
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('income_id', v_inc.id, 'receipt_id', v_r, 'status', v_inc.status));
end $$;

create or replace function public.review_income(p_request_id uuid, p_income_id uuid, p_action text, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_inc public.incomes; v_r uuid;
begin
  perform kp.require_parent(me);
  v_dup := kp.req_start(p_request_id, me, 'review_income'); if v_dup is not null then return v_dup; end if;
  select * into v_inc from public.incomes where id = p_income_id and family_id = me.family_id for update;
  if not found then perform kp.fail('not_found','הרישום לא נמצא'); end if;
  if v_inc.status <> 'pending' then perform kp.fail('bad_status','הרישום כבר טופל'); end if;
  if p_action = 'approve' then
    update public.incomes set status = 'active', reviewed_by = me.id, reviewed_at = now(), review_note = nullif(trim(p_note),'')
    where id = v_inc.id returning * into v_inc;
    if v_inc.reported_received then v_r := kp.receive_now(me, v_inc, v_inc.reported_method, v_inc.income_date); end if;
  elsif p_action = 'reject' then
    update public.incomes set status = 'rejected', reviewed_by = me.id, reviewed_at = now(), review_note = nullif(trim(p_note),'')
    where id = v_inc.id;
  else perform kp.fail('bad_action','פעולה לא מוכרת'); end if;
  perform kp.audit(me, p_action || '_income', 'income', v_inc.id, p_note);
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('income_id', v_inc.id, 'receipt_id', v_r));
end $$;

-- ----------------------------------------------------------- payments
-- תשלום אחד יכול לכסות כמה הכנסות של אותו ילד מול אותו משלם.
-- נעילת שורות (FOR UPDATE) מונעת ששני תשלומים במקביל יעברו את יתרת החוב.
create or replace function public.record_payment(p_request_id uuid, p_child_id uuid, p_income_ids uuid[], p_amount_cents bigint,
  p_date date, p_method text, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_c public.members; v_rows public.incomes[]; v_i public.incomes;
  v_total bigint := 0; v_left bigint; v_out bigint; v_r uuid; v_payers int; v_alloc jsonb := '[]'::jsonb; v_amount bigint;
begin
  perform kp.require_parent(me);
  v_dup := kp.req_start(p_request_id, me, 'record_payment'); if v_dup is not null then return v_dup; end if;
  v_c := kp.child_for(me, p_child_id);
  v_amount := kp.cents(p_amount_cents);
  if p_method not in ('cash','bit','transfer','other') then perform kp.fail('bad_method','אמצעי תשלום לא תקין'); end if;
  if p_income_ids is null or cardinality(p_income_ids) = 0 then perform kp.fail('no_incomes','צריך לבחור על מה התשלום'); end if;

  perform 1 from public.incomes where id = any(p_income_ids) order by income_date, created_at, id for update;
  select array_agg(x order by x.income_date, x.created_at, x.id) into v_rows
  from public.incomes x where x.id = any(p_income_ids);
  if coalesce(cardinality(v_rows),0) <> (select count(distinct x) from unnest(p_income_ids) x) then
    perform kp.fail('not_found','חלק מהרישומים לא נמצאו');
  end if;
  foreach v_i in array v_rows loop
    if v_i.family_id <> me.family_id or v_i.child_id <> v_c.id or v_i.status <> 'active' then
      perform kp.fail('bad_income','אפשר לשלם רק על הכנסות מאושרות של אותו ילד');
    end if;
    v_total := v_total + v_i.amount_cents - kp.paid(v_i.id);
  end loop;
  select count(distinct coalesce(x.payer_member_id::text, 'o:' || lower(x.payer_name))) into v_payers from unnest(v_rows) x;
  if v_payers <> 1 then perform kp.fail('mixed_payers','תשלום אחד יכול לכסות רק חובות של אותו משלם'); end if;
  if v_amount > v_total then
    perform kp.fail('overpay', format('הסכום גבוה מהחוב (%s ₪). כסף נוסף רשמו בנפרד, למשל כמתנה.', kp.shekel(v_total)));
  end if;

  insert into public.receipts(family_id, child_id, amount_cents, received_date, method, payer_member_id, payer_name, note, recorded_by)
  values (me.family_id, v_c.id, v_amount, coalesce(p_date, kp.today()), p_method, v_rows[1].payer_member_id, v_rows[1].payer_name,
          nullif(trim(p_note),''), me.id)
  returning id into v_r;
  v_left := v_amount;
  foreach v_i in array v_rows loop
    exit when v_left = 0;
    v_out := v_i.amount_cents - kp.paid(v_i.id);
    continue when v_out <= 0;
    insert into public.allocations(family_id, receipt_id, income_id, amount_cents)
    values (me.family_id, v_r, v_i.id, least(v_out, v_left));
    v_alloc := v_alloc || jsonb_build_object('income_id', v_i.id, 'amount_cents', least(v_out, v_left));
    v_left := v_left - least(v_out, v_left);
  end loop;
  perform kp.audit(me, 'record_payment', 'receipt', v_r, null, jsonb_build_object('amount', v_amount, 'allocations', v_alloc));
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('receipt_id', v_r, 'allocations', v_alloc));
end $$;

-- הילד מאשר קבלה או מסמן "לא קיבלתי". לא יוצר תקבול נוסף.
create or replace function public.ack_receipt(p_request_id uuid, p_receipt_id uuid, p_status text, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_r public.receipts;
begin
  v_dup := kp.req_start(p_request_id, me, 'ack_receipt'); if v_dup is not null then return v_dup; end if;
  select * into v_r from public.receipts where id = p_receipt_id and family_id = me.family_id for update;
  if not found or v_r.child_id <> me.id then perform kp.fail('forbidden','אפשר לאשר רק תשלום שלך'); end if;
  if p_status not in ('confirmed','disputed') then perform kp.fail('bad_status','מצב לא תקין'); end if;
  update public.receipts set child_ack = p_status, ack_note = nullif(trim(p_note),''), ack_at = now() where id = v_r.id;
  perform kp.audit(me, 'ack_receipt', 'receipt', v_r.id, p_note, jsonb_build_object('status', p_status));
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('ok', true));
end $$;

-- ----------------------------------------------------------- expenses
create or replace function public.report_expense(p_request_id uuid, p_child_id uuid, p_amount_cents bigint, p_date date,
  p_description text, p_allow_negative boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_c public.members; v_bal bigint; v_e uuid; v_amount bigint;
begin
  v_dup := kp.req_start(p_request_id, me, 'report_expense'); if v_dup is not null then return v_dup; end if;
  v_c := kp.child_for(me, p_child_id);
  v_amount := kp.cents(p_amount_cents);
  perform 1 from public.members where id = v_c.id for update;     -- סדרת בדיקות יתרה לאותו ילד
  v_bal := kp.balance(v_c.id);
  if me.role = 'parent' and v_bal - v_amount < 0 and not coalesce(p_allow_negative,false) then
    perform kp.fail('negative_balance', format('ההוצאה תיצור יתרה שלילית (%s ₪). צריך לאשר במפורש.',
      kp.shekel(v_bal - v_amount)));
  end if;
  insert into public.expenses(family_id, child_id, amount_cents, expense_date, description, status, negative_confirmed,
    created_by, reviewed_by, reviewed_at)
  values (me.family_id, v_c.id, v_amount, coalesce(p_date, kp.today()), kp.text_req(p_description,'תיאור'),
    case when me.role = 'parent' then 'approved' else 'pending' end,
    me.role = 'parent' and v_bal - v_amount < 0, me.id,
    case when me.role = 'parent' then me.id end, case when me.role = 'parent' then now() end)
  returning id into v_e;
  perform kp.audit(me, 'report_expense', 'expense', v_e, null, jsonb_build_object('amount', v_amount));
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('expense_id', v_e, 'balance_after', v_bal - v_amount,
    'would_be_negative', v_bal - v_amount < 0));
end $$;

create or replace function public.review_expense(p_request_id uuid, p_expense_id uuid, p_action text, p_note text, p_allow_negative boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_e public.expenses; v_bal bigint;
begin
  perform kp.require_parent(me);
  v_dup := kp.req_start(p_request_id, me, 'review_expense'); if v_dup is not null then return v_dup; end if;
  select * into v_e from public.expenses where id = p_expense_id and family_id = me.family_id;
  if not found then perform kp.fail('not_found','ההוצאה לא נמצאה'); end if;
  perform 1 from public.members where id = v_e.child_id for update;
  select * into v_e from public.expenses where id = p_expense_id for update;
  if v_e.status <> 'pending' then perform kp.fail('bad_status','ההוצאה כבר טופלה'); end if;
  if p_action = 'approve' then
    v_bal := kp.balance(v_e.child_id);
    if v_bal - v_e.amount_cents < 0 and not coalesce(p_allow_negative,false) then
      perform kp.fail('negative_balance', format('אישור ההוצאה ייצור יתרה שלילית (%s ₪). צריך לאשר במפורש.',
        kp.shekel(v_bal - v_e.amount_cents)));
    end if;
    update public.expenses set status = 'approved', reviewed_by = me.id, reviewed_at = now(), review_note = nullif(trim(p_note),''),
      negative_confirmed = v_bal - v_e.amount_cents < 0 where id = v_e.id;
  elsif p_action = 'reject' then
    update public.expenses set status = 'rejected', reviewed_by = me.id, reviewed_at = now(), review_note = nullif(trim(p_note),'')
    where id = v_e.id;
  else perform kp.fail('bad_action','פעולה לא מוכרת'); end if;
  perform kp.audit(me, p_action || '_expense', 'expense', v_e.id, p_note);
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('ok', true));
end $$;

-- ---------------------------------------------------------- corrections
-- ביטול מתועד. הכנסה ששולמה דורשת טיפול מפורש בתשלומים:
--   keep_as_gift  — הכסף נשאר אצל הילד ונרשם כמתנה
--   void_payments — התשלומים המשויכים מבוטלים (הכסף הוחזר / נרשם בטעות)
create or replace function public.void_record(p_request_id uuid, p_kind text, p_id uuid, p_reason text, p_mode text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); v_dup jsonb; v_reason text; v_inc public.incomes; v_paid bigint; v_gift uuid;
  v_rc record; v_affected jsonb := '[]'::jsonb; v_e public.expenses; v_r public.receipts;
begin
  perform kp.require_parent(me);
  v_dup := kp.req_start(p_request_id, me, 'void_record'); if v_dup is not null then return v_dup; end if;
  v_reason := kp.text_req(p_reason, 'סיבה לתיקון');

  if p_kind = 'income' then
    select * into v_inc from public.incomes where id = p_id and family_id = me.family_id for update;
    if not found then perform kp.fail('not_found','הרישום לא נמצא'); end if;
    if v_inc.status <> 'active' then perform kp.fail('bad_status','אפשר לבטל רק הכנסה מאושרת'); end if;
    v_paid := kp.paid(v_inc.id);
    if v_paid > 0 then
      if p_mode is null then
        perform kp.fail('has_payments', format('על ההכנסה הזו כבר שולמו %s ₪. בחרו מה לעשות בתשלומים.', kp.shekel(v_paid)));
      elsif p_mode = 'keep_as_gift' then
        insert into public.incomes(family_id, child_id, kind, amount_cents, income_date, description, payer_member_id, payer_name,
          status, created_by, reviewed_by, reviewed_at)
        values (me.family_id, v_inc.child_id, 'gift', v_paid, kp.today(), 'נשאר אצל הילד אחרי תיקון: ' || v_inc.description,
          v_inc.payer_member_id, v_inc.payer_name, 'active', me.id, me.id, now())
        returning id into v_gift;
        for v_rc in select a.* from public.allocations a join public.receipts r on r.id = a.receipt_id
                    where a.income_id = v_inc.id and a.status = 'active' and r.status = 'active' loop
          update public.allocations set status = 'voided' where id = v_rc.id;
          insert into public.allocations(family_id, receipt_id, income_id, amount_cents)
          values (me.family_id, v_rc.receipt_id, v_gift, v_rc.amount_cents);
        end loop;
      elsif p_mode = 'void_payments' then
        for v_rc in select distinct r.id from public.allocations a join public.receipts r on r.id = a.receipt_id
                    where a.income_id = v_inc.id and a.status = 'active' and r.status = 'active' loop
          update public.receipts set status = 'voided', voided_by = me.id, voided_at = now(),
            void_reason = 'בוטל עם תיקון הכנסה: ' || v_reason where id = v_rc.id;
          update public.allocations set status = 'voided' where receipt_id = v_rc.id;
          v_affected := v_affected || to_jsonb(v_rc.id);
        end loop;
      else perform kp.fail('bad_mode','אפשרות לא מוכרת'); end if;
    end if;
    update public.incomes set status = 'voided', voided_by = me.id, voided_at = now(), void_reason = v_reason where id = v_inc.id;
    if v_inc.job_instance_id is not null then   -- העבודה חוזרת להמתנה; הניקוד יורד אוטומטית
      update public.job_instances set status = 'pending', note = 'האישור בוטל: ' || v_reason where id = v_inc.job_instance_id;
    end if;
    perform kp.audit(me, 'void_income', 'income', v_inc.id, v_reason,
      jsonb_build_object('paid', v_paid, 'mode', p_mode, 'gift_income_id', v_gift, 'voided_receipts', v_affected));

  elsif p_kind = 'receipt' then
    select * into v_r from public.receipts where id = p_id and family_id = me.family_id for update;
    if not found or v_r.status <> 'active' then perform kp.fail('not_found','התשלום לא נמצא או כבר בוטל'); end if;
    update public.receipts set status = 'voided', voided_by = me.id, voided_at = now(), void_reason = v_reason where id = v_r.id;
    update public.allocations set status = 'voided' where receipt_id = v_r.id;
    perform kp.audit(me, 'void_receipt', 'receipt', v_r.id, v_reason, jsonb_build_object('amount', v_r.amount_cents));

  elsif p_kind = 'expense' then
    select * into v_e from public.expenses where id = p_id and family_id = me.family_id for update;
    if not found or v_e.status not in ('approved','pending') then perform kp.fail('not_found','ההוצאה לא נמצאה או כבר בוטלה'); end if;
    update public.expenses set status = 'voided', voided_by = me.id, voided_at = now(), void_reason = v_reason where id = v_e.id;
    perform kp.audit(me, 'void_expense', 'expense', v_e.id, v_reason, jsonb_build_object('amount', v_e.amount_cents));
  else
    perform kp.fail('bad_kind','סוג לא מוכר');
  end if;
  perform kp.touch(me.family_id);
  return kp.req_done(p_request_id, jsonb_build_object('ok', true, 'gift_income_id', v_gift, 'voided_receipts', v_affected));
end $$;

-- ------------------------------------------------------ export / restore
create or replace function public.export_family() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me();
begin
  perform kp.require_parent(me);
  perform kp.audit(me, 'export', 'family', me.family_id);
  return jsonb_build_object('app', 'kesef-sheli', 'version', 1, 'exported_at', now(), 'data', kp.export_data(me.family_id));
end $$;

-- שחזור: p_dry_run=true מבצע את כל השחזור ובדיקת התאמה ואז מחזיר הכול לאחור.
-- שחזור אמיתי: שומר קודם עותק של המצב הנוכחי (restore_snapshots), ומבטל הכול אם הבדיקה נכשלה.
create or replace function public.restore_family(p_backup jsonb, p_dry_run boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me(); d jsonb; v_before jsonb; v_after jsonb; v_ok boolean; v_bad text[] := '{}';
  k text; v_counts jsonb := '{}'::jsonb; v_unlinked jsonb; v_fam uuid := me.family_id; v_email text := me.login_email; v_me_id uuid;
begin
  perform kp.require_parent(me);
  if p_backup->>'app' is distinct from 'kesef-sheli' or (p_backup->>'version')::int is distinct from 1 then
    perform kp.fail('bad_file','זה לא קובץ גיבוי של האפליקציה');
  end if;
  d := p_backup->'data';
  if not exists (select 1 from jsonb_array_elements(d->'members') m
                 where lower(m->>'login_email') = v_email and m->>'role' = 'parent' and (m->>'active')::boolean) then
    perform kp.fail('no_self','בקובץ אין אותך כהורה פעיל, ולכן השחזור היה נועל אותך בחוץ');
  end if;
  perform pg_advisory_xact_lock(hashtext('kesef_restore_' || v_fam::text));
  v_before := kp.export_data(v_fam);
  foreach k in array array['members','job_templates','template_assignees','job_instances','incomes','receipts',
                           'allocations','expenses','audit_log'] loop
    v_counts := v_counts || jsonb_build_object(k, jsonb_array_length(coalesce(d->k,'[]'::jsonb)));
  end loop;

  begin
    perform kp.restore_into(v_fam, d);
    v_after := kp.export_data(v_fam);
    foreach k in array array['family','members','job_templates','template_assignees','job_instances','incomes','receipts',
                             'allocations','expenses','audit_log'] loop
      if (v_after->k) is distinct from (d->k) then v_bad := v_bad || k; end if;
    end loop;
    v_ok := cardinality(v_bad) = 0;
    select coalesce(jsonb_agg(login_email), '[]'::jsonb) into v_unlinked from public.members where family_id = v_fam and user_id is null;
    if p_dry_run or not v_ok then
      raise exception using errcode = 'KS001', message = 'rollback';
    end if;
  exception when sqlstate 'KS001' then
    null;   -- כל השינויים בתוך הבלוק בוטלו
  end;

  if not v_ok then
    return jsonb_build_object('ok', false, 'dry_run', p_dry_run, 'mismatch', to_jsonb(v_bad), 'counts', v_counts);
  end if;
  if p_dry_run then
    return jsonb_build_object('ok', true, 'dry_run', true, 'verified', true, 'counts', v_counts, 'unlinked', v_unlinked);
  end if;

  select id into v_me_id from public.members where family_id = v_fam and lower(login_email) = v_email;
  insert into public.restore_snapshots(family_id, created_by, data) values (v_fam, v_me_id, v_before);
  insert into public.audit_log(family_id, actor_member_id, action, entity, entity_id, reason, details)
  values (v_fam, v_me_id, 'restore', 'family', v_fam, 'שחזור מגיבוי',
    jsonb_build_object('exported_at', p_backup->>'exported_at', 'counts', v_counts));
  perform kp.touch(v_fam);
  return jsonb_build_object('ok', true, 'dry_run', false, 'verified', true, 'counts', v_counts, 'unlinked', v_unlinked);
end $$;

-- --------------------------------------------- test family (בדיקות בלבד)
-- משפחה נפרדת לגמרי (is_test) עבור דף הבדיקות. לא נוגעת בנתונים האמיתיים.
-- משתמשים: test-parent@<domain>, test-kid1@<domain>, test-kid2@<domain>
create or replace function public.setup_test_family() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text; v_domain text; v_fam uuid; v_p uuid; v_k1 uuid; v_k2 uuid; v_u1 uuid; v_u2 uuid; f record;
begin
  if auth.uid() is null then perform kp.fail('not_authenticated','יש להתחבר'); end if;
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email not like 'test-parent@%' then perform kp.fail('forbidden','רק משתמש test-parent יכול ליצור משפחת בדיקה'); end if;
  v_domain := split_part(v_email, '@', 2);
  select id into v_u1 from auth.users where lower(email) = 'test-kid1@' || v_domain;
  select id into v_u2 from auth.users where lower(email) = 'test-kid2@' || v_domain;
  if v_u1 is null or v_u2 is null then perform kp.fail('missing_users','חסרים המשתמשים test-kid1 ו-test-kid2'); end if;
  for f in select distinct m.family_id from public.members m where m.user_id in (auth.uid(), v_u1, v_u2) loop
    perform kp.purge_family(f.family_id);
  end loop;
  insert into public.families(name, is_test) values ('משפחת בדיקה', true) returning id into v_fam;
  insert into public.members(family_id, user_id, login_email, display_name, role, gender)
    values (v_fam, auth.uid(), v_email, 'הורה בדיקה', 'parent', 'm') returning id into v_p;
  insert into public.members(family_id, user_id, login_email, display_name, role, gender)
    values (v_fam, v_u1, 'test-kid1@' || v_domain, 'ילדה א', 'child', 'f') returning id into v_k1;
  insert into public.members(family_id, user_id, login_email, display_name, role, gender)
    values (v_fam, v_u2, 'test-kid2@' || v_domain, 'ילד ב', 'child', 'm') returning id into v_k2;
  perform kp.touch(v_fam);
  return jsonb_build_object('family_id', v_fam, 'parent_id', v_p, 'kid1_id', v_k1, 'kid2_id', v_k2);
end $$;

create or replace function public.purge_test_family() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.members := kp.me();
begin
  perform kp.require_parent(me);
  perform kp.purge_family(me.family_id);   -- נכשל אם זו לא משפחת בדיקה
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------- grants
do $$
declare f record;
begin
  -- שום פונקציה לא פתוחה כברירת מחדל
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public','kp') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
  -- רק פונקציות ה-API פתוחות למשתמשים מחוברים
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('setup_family','whoami','get_state','add_member','update_member',
             'set_opening_balance','set_goal','update_settings','reset_child_password','save_template','create_job',
             'submit_job','review_job','withdraw_report','report_income','review_income','record_payment','ack_receipt','report_expense',
             'review_expense','void_record','export_family','restore_family','setup_test_family','purge_test_family',
             'my_family_id') loop
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';

select 'ההתקנה הושלמה בהצלחה ✅' as result;
