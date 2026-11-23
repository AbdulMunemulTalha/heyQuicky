import { Router } from 'express';
import { randomBytes } from 'node:crypto';

// INT-02 · Website chat widget: one script tag puts the shop's HeyQuicky chat on their own website.
// Messages land in the Inbox as the "web" channel and the AI answers them like Messenger chats.
//   <script src="https://heyquicky.com/w/<token>.js" async></script>
// Public, no login: a visitor gets a random id on their first message and reads only their own chat.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLOUR = /^#[0-9a-f]{6}$/i;

export function widgetSettings(ws) {
  const w = ws?.settings?.widget ?? {};
  return { colour: COLOUR.test(w.colour) ? w.colour : '#2B4BFF', greeting: w.greeting || 'Assalamu alaikum! 👋 How can we help?', position: w.position === 'left' ? 'left' : 'right' };
}

function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 50_000) hits.clear();
    return recent.length <= max;
  };
}

export function widgetRoutes(db, config, inbox) {
  const router = Router();
  const sendLimit = limiter(20, 60_000);
  const channelFor = async (token) => {
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(token)) return null;
    return db.channels.findOne({ platform: 'web', external_id: token }).lean();
  };
  const cors = (res) => { res.set('access-control-allow-origin', '*'); res.set('access-control-allow-headers', 'content-type'); };

  // The embed script: a floating button that opens the chat in a small frame.
  router.get('/w/:token.js', async (req, res) => {
    const channel = await channelFor(req.params.token);
    res.type('application/javascript').set('cache-control', 'public, max-age=300');
    if (!channel) return res.send('/* HeyQuicky chat: this widget is not set up */');
    const ws = await db.workspaces.findById(channel.workspace_id, { settings: 1, name: 1 }).lean();
    if (ws?.settings?.widget?.off) return res.send('/* HeyQuicky chat is turned off */');
    const w = widgetSettings(ws);
    const base = (config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const side = w.position === 'left' ? 'left' : 'right';
    res.send(`(function(){if(window.__heyquicky)return;window.__heyquicky=1;
var b=document.createElement('button');b.setAttribute('aria-label','Chat with ${esc(ws?.name ?? 'us').replace(/\\/g, '')}');
b.style.cssText='position:fixed;bottom:20px;${side}:20px;width:56px;height:56px;border-radius:28px;border:0;cursor:pointer;z-index:2147483646;background:${w.colour};color:#fff;font-size:24px;box-shadow:0 6px 20px rgba(0,0,0,.2)';
b.textContent='💬';var f=null;
b.onclick=function(){if(!f){f=document.createElement('iframe');f.src='${base}/w/${channel.external_id}';f.title='Chat';
f.style.cssText='position:fixed;bottom:88px;${side}:20px;width:360px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 120px);border:0;border-radius:16px;z-index:2147483647;box-shadow:0 16px 48px rgba(0,0,0,.25);background:#fff';
document.body.appendChild(f);}else{f.style.display=f.style.display==='none'?'block':'none';}};
document.body.appendChild(b);})();`);
  });

  // The chat inside the frame (plain HTML and a little script, no build step).
  router.get('/w/:token', async (req, res) => {
    const channel = await channelFor(req.params.token);
    if (!channel) return res.status(404).type('html').send('<p style="font-family:sans-serif">This chat is not set up.</p>');
    const ws = await db.workspaces.findById(channel.workspace_id, { settings: 1, name: 1 }).lean();
    const w = widgetSettings(ws);
    res.type('html').set('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src * data:; connect-src 'self'; frame-ancestors *");
    res.send(`<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(ws?.name)}</title>
<style>*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Bengali",sans-serif;display:flex;flex-direction:column;height:100vh;background:#f6f7f9}
header{background:${w.colour};color:#fff;padding:14px 16px}header strong{display:block;font-size:15px}header small{opacity:.85}
#log{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px}.m{max-width:80%;padding:8px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}
.in{align-self:flex-end;background:${w.colour};color:#fff;border-bottom-right-radius:4px}.out{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px}
.out a{color:${w.colour};font-weight:600}form{display:flex;gap:8px;padding:10px;background:#fff;border-top:1px solid #e5e7eb}
input{flex:1;padding:10px 12px;border:1px solid #d1d5db;border-radius:20px;font:inherit}button{border:0;border-radius:20px;padding:0 16px;background:${w.colour};color:#fff;font:inherit;font-weight:600;cursor:pointer}
.by{font-size:11px;color:#9ca3af;text-align:center;padding:4px}</style></head><body>
<header><strong>${esc(ws?.name)}</strong><small>Usually replies in a few seconds</small></header>
<div id="log" aria-live="polite"><div class="m out">${esc(w.greeting)}</div></div>
<form id="f"><input id="t" maxlength="1000" placeholder="Write a message…" aria-label="Message" autocomplete="off"><button>Send</button></form>
<div class="by">Chat by HeyQuicky</div>
<script>(function(){var T=${JSON.stringify(channel.external_id)},K='hq_v_'+T,v=localStorage.getItem(K)||'',last=0,log=document.getElementById('log');
function add(m){var d=document.createElement('div');d.className='m '+(m.direction==='in'?'in':'out');d.textContent=m.text;
(m.links||[]).forEach(function(l){d.appendChild(document.createElement('br'));var a=document.createElement('a');a.href=l.url;a.target='_blank';a.rel='noopener';a.textContent=l.title;d.appendChild(a);});
log.appendChild(d);log.scrollTop=log.scrollHeight;}
function poll(){if(!v)return;fetch('/api/widget/'+T+'/messages?visitor='+encodeURIComponent(v)+'&after='+last).then(function(r){return r.json()}).then(function(d){(d.messages||[]).forEach(function(m){add(m);last=Math.max(last,m.id)})}).catch(function(){});}
document.getElementById('f').onsubmit=function(e){e.preventDefault();var i=document.getElementById('t'),text=i.value.trim();if(!text)return;i.value='';
fetch('/api/widget/'+T+'/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({visitor:v,text:text})}).then(function(r){return r.json()}).then(function(d){if(d.visitor&&!v){v=d.visitor;localStorage.setItem(K,v);}poll();});};
poll();setInterval(poll,3000);})();</script></body></html>`);
  });

  router.options('/api/widget/:token/messages', (_req, res) => { cors(res); res.sendStatus(204); });

  router.post('/api/widget/:token/messages', async (req, res) => {
    cors(res);
    const channel = await channelFor(req.params.token);
    if (!channel) return res.status(404).json({ error: 'This chat is not set up' });
    const owner = await db.workspaces.findById(channel.workspace_id, { 'settings.widget': 1 }).lean();
    if (owner?.settings?.widget?.off) return res.status(403).json({ error: 'This chat is turned off' });
    if (!sendLimit(`${req.ip}|${req.params.token}`)) return res.status(429).json({ error: 'Too many messages — wait a moment' });
    const text = String(req.body?.text ?? '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'Write a message' });
    let visitor = String(req.body?.visitor ?? '');
    if (!/^v_[A-Za-z0-9_-]{16,40}$/.test(visitor)) visitor = `v_${randomBytes(15).toString('base64url')}`;
    const name = String(req.body?.name ?? '').trim().slice(0, 60) || null;
    await inbox.ingestMessage({ platform: 'web', channelExternalId: channel.external_id, contactExternalId: visitor, contactName: name, direction: 'in',
      messageId: `web_${randomBytes(9).toString('hex')}`, text, attachments: [], timestamp: new Date().toISOString() });
    res.status(201).json({ visitor });
  });

  // The visitor's own chat, newest after the last id they have.
  router.get('/api/widget/:token/messages', async (req, res) => {
    cors(res);
    const channel = await channelFor(req.params.token);
    const visitor = String(req.query.visitor ?? '');
    if (!channel || !/^v_[A-Za-z0-9_-]{16,40}$/.test(visitor)) return res.json({ messages: [] });
    const contact = await db.contacts.findOne({ channel_id: channel._id, external_id: visitor }, { _id: 1 }).lean();
    const conv = contact ? await db.conversations.findOne({ contact_id: contact._id }, { _id: 1 }).lean() : null;
    if (!conv) return res.json({ messages: [] });
    const after = Number(req.query.after) || 0;
    const list = await db.messages.find({ conversation_id: conv._id, _id: { $gt: after } }).sort({ _id: 1 }).limit(100).lean();
    res.json({
      messages: list.map((m) => ({
        id: m._id, direction: m.direction, text: m.text, at: m.created_at,
        links: (m.payload?.buttons ?? []).filter((b) => b.type === 'url' && /^https:\/\//.test(b.value)).map((b) => ({ title: b.title, url: b.value })),
      })),
    });
  });

  return router;
}
