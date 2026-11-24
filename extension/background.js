// HeyQuicky for Business Suite — talks to the shop's HeyQuicky server. Requests go from here (not the page),
// so Business Suite never sees the sign-in token.
importScripts('config.js');

const get = (keys) => chrome.storage.local.get(keys);

async function server() {
  const { server: saved } = await get(['server']);
  return String(saved || self.HQ_SERVER || '').replace(/\/+$/, '');
}

async function api({ method = 'GET', path, body }) {
  const [{ token }, base] = await Promise.all([get(['token']), server()]);
  if (!base || !token) return { ok: false, status: 401, data: { error: 'Not connected' } };
  if (!/^\/api\/dash\//.test(path)) return { ok: false, status: 400, data: { error: 'Bad path' } };
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) await chrome.storage.local.remove(['token']); // signed out on the server
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: "Can't reach HeyQuicky" } };
  }
}

async function connect({ server: base, code }) {
  const url = String(base || '').replace(/\/+$/, '');
  try {
    const res = await fetch(`${url}/api/ext/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || 'Could not connect' };
    await chrome.storage.local.set({ server: url, token: data.token, name: data.name, shop: data.shop });
    return { ok: true, name: data.name, shop: data.shop };
  } catch {
    return { ok: false, error: `Can't reach ${url}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'api') { api(msg).then(reply); return true; }
  if (msg?.type === 'connect') { connect(msg).then(reply); return true; }
  if (msg?.type === 'server') { server().then(reply); return true; }
  if (msg?.type === 'signout') { chrome.storage.local.remove(['token', 'name', 'shop']).then(() => reply({ ok: true })); return true; }
  return false;
});
