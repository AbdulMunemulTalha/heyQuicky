import { createHash, randomBytes } from 'node:crypto';

// Every outside service the dashboard talks to sits behind an adapter with the same shape in
// real and fake mode. Fake mode is used when credentials are missing, when DRY_RUN is on, and in
// tests: it never calls the network and remembers what it "sent" (adapter.sent) so tests can check.
//
// Env vars are listed in .env.example. Per-shop accounts (courier keys, gateway merchants) are
// passed in by the caller from the encrypted workspace records, never read from here.

function fakeOutbox(name) {
  const sent = [];
  return { name, mode: 'fake', sent, record: (item) => { sent.push({ ...item, at: new Date() }); return item; } };
}

// ---------- Email (password reset codes, invites) ----------
function emailAdapter(env, fetchImpl, dry) {
  const key = env.RESEND_API_KEY;
  const from = env.MAIL_FROM || 'HeyQuicky <no-reply@heyquicky.com>';
  if (!key || dry) {
    const out = fakeOutbox('email');
    return { ...out, async send({ to, subject, text }) { out.record({ to, subject, text }); if (process.env.NODE_ENV !== 'test') console.log(`[fake email] to ${to}: ${text}`); return { id: `fake_${randomBytes(4).toString('hex')}` }; } };
  }
  return {
    name: 'email', mode: 'real', sent: [],
    async send({ to, subject, text }) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!res.ok) throw new Error(`Email failed (${res.status})`);
      return res.json();
    },
  };
}

// ---------- SMS (phone reset codes, 2-step login) ----------
// SMS_API_URL is the provider's send URL with {to}, {text} and {key} placeholders, e.g.
// https://bulksmsbd.net/api/smsapi?api_key={key}&type=text&number={to}&senderid=XXXX&message={text}
function smsAdapter(env, fetchImpl, dry) {
  const url = env.SMS_API_URL;
  if (!url || dry) {
    const out = fakeOutbox('sms');
    return { ...out, async send({ to, text }) { out.record({ to, text }); if (process.env.NODE_ENV !== 'test') console.log(`[fake sms] to ${to}: ${text}`); return { ok: true }; } };
  }
  return {
    name: 'sms', mode: 'real', sent: [],
    async send({ to, text }) {
      const target = url.replace('{to}', encodeURIComponent(`88${to}`)).replace('{text}', encodeURIComponent(text))
        .replace('{key}', encodeURIComponent(env.SMS_API_KEY || ''));
      const res = await fetchImpl(target);
      if (!res.ok) throw new Error(`SMS failed (${res.status})`);
      return { ok: true };
    },
  };
}

// ---------- Web push ----------
function pushAdapter(env, dry) {
  const configured = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY;
  const out = fakeOutbox('push');
  const fake = { ...out, publicKey: env.VAPID_PUBLIC_KEY || '', async send(subscription, payload) { out.record({ endpoint: subscription.endpoint, payload }); return { ok: true }; } };
  if (!configured || dry) return fake;
  let webpush;
  return {
    name: 'push', mode: 'real', sent: [], publicKey: env.VAPID_PUBLIC_KEY,
    async send(subscription, payload) {
      webpush ??= (await import('web-push')).default;
      webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:info@heyquicky.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      return { ok: true };
    },
  };
}

// ---------- Courier fraud check (cross-merchant delivery success, CRM-02) ----------
// Fake mode returns a stable made-up record per phone so the screens can be built and tested.
function fraudAdapter(env, fetchImpl, dry) {
  const fake = {
    name: 'fraudcheck', mode: 'fake',
    async check(phone) {
      const h = createHash('sha1').update(String(phone)).digest();
      const total = 3 + (h[0] % 30);
      const rate = 0.4 + (h[1] % 60) / 100;
      const delivered = Math.min(total, Math.round(total * rate));
      return { phone, total, delivered, returned: total - delivered, rate: delivered / total, couriers: ['Steadfast', 'Pathao', 'RedX'], source: 'sample' };
    },
  };
  if (!env.FRAUDCHECK_API_URL || dry) return fake;
  return {
    name: 'fraudcheck', mode: 'real',
    async check(phone) {
      const res = await fetchImpl(env.FRAUDCHECK_API_URL.replace('{phone}', phone), { headers: { authorization: `Bearer ${env.FRAUDCHECK_API_KEY || ''}` } });
      if (!res.ok) throw new Error(`Courier check failed (${res.status})`);
      const d = await res.json();
      const total = Number(d.total ?? d.total_parcel ?? 0);
      const delivered = Number(d.delivered ?? d.success_parcel ?? 0);
      return { phone, total, delivered, returned: total - delivered, rate: total ? delivered / total : null, couriers: d.couriers ?? [], source: 'api' };
    },
  };
}

// ---------- Google sign-in ----------
function googleAdapter(env, fetchImpl) {
  const clientId = env.GOOGLE_CLIENT_ID;
  return {
    name: 'google', mode: clientId ? 'real' : 'off', clientId: clientId || '',
    // Verifies an ID token from Google Identity Services and returns { sub, email, name }.
    async verify(idToken) {
      if (!clientId) throw new Error('Google sign-in is not set up yet');
      const res = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
      if (!res.ok) throw new Error('Google sign-in failed');
      const t = await res.json();
      if (t.aud !== clientId || t.email_verified === 'false') throw new Error('Google sign-in failed');
      return { sub: t.sub, email: String(t.email).toLowerCase(), name: t.name ?? '' };
    },
  };
}

export function createAdapters(env = process.env, { fetchImpl = fetch } = {}) {
  const dry = env.DRY_RUN === '1' || env.DRY_RUN === 'true' || env.ADAPTERS === 'fake';
  return {
    email: emailAdapter(env, fetchImpl, dry),
    sms: smsAdapter(env, fetchImpl, dry),
    push: pushAdapter(env, dry),
    fraud: fraudAdapter(env, fetchImpl, dry),
    google: googleAdapter(env, fetchImpl),
  };
}
