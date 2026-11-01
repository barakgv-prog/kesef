// "הכסף שלי" — פונקציית שרת (Supabase Edge Function בשם push) ששולחת התראות פוש.
// מותקנת דרך לוח הבקרה של Supabase (Edge Functions → Deploy a new function → Via Editor),
// עם "Verify JWT" כבוי: הפונקציה לא מקבלת שום נתון מבחוץ, רק שולחת את מה שממתין בתור במסד.
// מפתחות VAPID נוצרים כאן בהרצה הראשונה ונשמרים במסד (kp.push_keys). אין בקוד הזה שום סוד.
// שליחה לפי התקנים RFC 8030 (Web Push), RFC 8291 (הצפנה aes128gcm) ו-RFC 8292 (VAPID).
import postgres from 'https://deno.land/x/postgresjs@v3.4.5/mod.js';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 1 });
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const SUBJECT = 'https://barakgv-prog.github.io/kesef/';

const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// HKDF עם בלוק פלט אחד (עד 32 בתים)
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);
}

type Keys = { vapid_public: string; vapid_private: JsonWebKey };
async function getKeys(): Promise<Keys> {
  let [row] = await sql`select vapid_public, vapid_private from kp.push_keys where id = 1`;
  if (!row) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
    await sql`insert into kp.push_keys (id, vapid_public, vapid_private) values (1, ${pub}, ${sql.json(priv)})
              on conflict (id) do nothing`;
    [row] = await sql`select vapid_public, vapid_private from kp.push_keys where id = 1`;
  }
  return row as Keys;
}

async function vapidHeader(endpoint: string, k: Keys) {
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT,
  })));
  const key = await crypto.subtle.importKey('jwk', { ...k.vapid_private, key_ops: ['sign'] },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body)));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${k.vapid_public}`;
}

async function encrypt(p256dh: string, auth: string, payload: Uint8Array) {
  const uaPub = unb64u(p256dh), secret = unb64u(auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(secret, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}

async function sendOne(s: { endpoint: string; p256dh: string; auth: string }, msg: object, k: Keys) {
  return fetch(s.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal',
      Authorization: await vapidHeader(s.endpoint, k),
    },
    body: await encrypt(s.p256dh, s.auth, enc.encode(JSON.stringify(msg))),
  });
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (o: object, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  try {
    const k = await getKeys();
    const items = await sql`select * from kp.push_claim()`;
    let sent = 0, failed = 0;
    for (const it of items) {
      const subs = await sql`select id, endpoint, p256dh, auth from public.push_subscriptions where member_id = ${it.member_id}`;
      for (const s of subs) {
        try {
          const r = await sendOne(s, { title: it.title, body: it.body, tag: it.id }, k);
          if (r.status === 404 || r.status === 410) await sql`delete from public.push_subscriptions where id = ${s.id}`;
          else if (r.ok) sent++;
          else { failed++; console.log('push failed', r.status, await r.text()); }
        } catch (e) { failed++; console.log('push error', String(e)); }
      }
    }
    return json({ publicKey: k.vapid_public, processed: items.length, sent, failed });
  } catch (e) {
    console.log('push function error', String(e));
    return json({ error: 'push_unavailable' }, 500);
  }
});
