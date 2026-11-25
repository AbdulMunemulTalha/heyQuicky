// HeyQuicky panel inside Meta Business Suite's inbox (frame "HND-05 · Business Suite Chrome extension").
// Finds the HeyQuicky chat for the conversation open in Business Suite and shows: who is replying
// (Take over / Give back to AI), the summary, a suggested reply (Copy · Shorter · Send size chart),
// "Ask about this customer", the courier check and orders. Badges show each chat's status in the list.
(() => {
  if (window.__heyquicky) return;
  window.__heyquicky = true;

  const T = {
    en: {
      you: "You're replying", teammate: (n) => `${n || 'A teammate'} is replying`, needs_you: 'Needs you', ai: 'AI replying', order: 'AI · order taken', off: 'AI off',
      takeOver: 'Take over', giveBack: 'Give back to AI', summary: 'Summary', suggested: 'Suggested reply', suggest: 'Suggest a reply', copy: 'Copy', copied: 'Copied — paste it in the reply box',
      shorter: 'Shorter', sizeChart: 'Send size chart', sent: 'Size chart sent', which: 'Which product?', ask: 'Ask about this customer', askPh: 'e.g. did he order before?', customer: 'Customer',
      courier: 'Courier check', safe: (r) => `Safe · ${r}%`, risky: (r) => `Risky · ${r}%`, notChecked: 'Not checked', orders: 'Orders with you', open: 'Open in HeyQuicky',
      tip: 'Tip: type . in any chat to take over, . again to give it back.', connect: 'Connect HeyQuicky: click the HeyQuicky button in your browser toolbar.', openChat: 'Open a chat to see HeyQuicky here.',
      otherPage: "This Page isn't connected to your HeyQuicky shop.", pick: 'Which HeyQuicky chat is this?', search: 'Search by name', none: 'No chats found', loading: 'Loading…', error: "Can't reach HeyQuicky",
      hide: 'Hide HeyQuicky', show: 'HeyQuicky', noAi: 'The AI is not set up yet', fromSaved: 'From your saved replies', noSuggestion: 'No suggestion yet.', reason: 'Why',
    },
    bn: {
      you: 'আপনি উত্তর দিচ্ছেন', teammate: (n) => `${n || 'একজন সহকর্মী'} উত্তর দিচ্ছেন`, needs_you: 'আপনাকে দরকার', ai: 'AI উত্তর দিচ্ছে', order: 'AI · অর্ডার নিয়েছে', off: 'AI বন্ধ',
      takeOver: 'নিজের হাতে নিন', giveBack: 'AI-কে ফেরত দিন', summary: 'সারাংশ', suggested: 'প্রস্তাবিত উত্তর', suggest: 'উত্তর প্রস্তাব করুন', copy: 'কপি', copied: 'কপি হয়েছে — উত্তরের বক্সে পেস্ট করুন',
      shorter: 'ছোট করুন', sizeChart: 'সাইজ চার্ট পাঠান', sent: 'সাইজ চার্ট পাঠানো হয়েছে', which: 'কোন প্রোডাক্ট?', ask: 'এই কাস্টমার সম্পর্কে জিজ্ঞেস করুন', askPh: 'যেমন উনি আগে অর্ডার করেছেন?', customer: 'কাস্টমার',
      courier: 'কুরিয়ার চেক', safe: (r) => `নিরাপদ · ${r}%`, risky: (r) => `ঝুঁকি · ${r}%`, notChecked: 'চেক হয়নি', orders: 'আপনার কাছে অর্ডার', open: 'HeyQuicky-তে খুলুন',
      tip: 'টিপ: যেকোনো চ্যাটে . লিখলে আপনি নেবেন, আবার . লিখলে AI-কে ফেরত।', connect: 'HeyQuicky কানেক্ট করুন: ব্রাউজারের টুলবারে HeyQuicky বাটনে ক্লিক করুন।', openChat: 'একটি চ্যাট খুললে এখানে HeyQuicky দেখাবে।',
      otherPage: 'এই পেজটি আপনার HeyQuicky শপের সাথে যুক্ত নয়।', pick: 'এটা কোন HeyQuicky চ্যাট?', search: 'নাম দিয়ে খুঁজুন', none: 'কোনো চ্যাট পাওয়া যায়নি', loading: 'লোড হচ্ছে…', error: 'HeyQuicky-তে পৌঁছানো যাচ্ছে না',
      hide: 'HeyQuicky লুকান', show: 'HeyQuicky', noAi: 'AI এখনো চালু হয়নি', fromSaved: 'আপনার সেভ করা উত্তর থেকে', noSuggestion: 'এখনো কোনো প্রস্তাব নেই।', reason: 'কারণ',
    },
  };
  const TONE = { you: 'orange', teammate: 'orange', needs_you: 'red', ai: 'blue', order: 'blue', off: 'gray' };
  let lang = 'en';
  const t = (k, ...a) => { const v = T[lang][k] ?? T.en[k]; return typeof v === 'function' ? v(...a) : v; };

  const api = (method, path, body) => chrome.runtime.sendMessage({ type: 'api', method, path: `/api/dash${path}`, body });

  // ---- The panel (in a shadow root so Business Suite's styles don't touch it, and ours don't touch it) ----
  const host = document.createElement('div');
  host.id = 'heyquicky-panel';
  host.style.cssText = 'position:fixed;top:56px;right:0;bottom:0;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{all:initial}*{box-sizing:border-box}
    .p{width:300px;height:100%;background:#fff;border-left:1px solid #e4e4e0;font:13px/1.45 system-ui,-apple-system,"Segoe UI","Noto Sans Bengali",sans-serif;color:#101217;display:flex;flex-direction:column;box-shadow:-4px 0 16px rgba(0,0,0,.04)}
    .hd{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #f0f0ec}.logo{width:22px;height:22px;border-radius:6px;flex:none}
    .hd strong{flex:1;font-size:14px}.x{all:unset;cursor:pointer;color:#6b7280;padding:2px 6px;border-radius:6px}.x:hover{background:#f3f3f0}
    .bd{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px}
    .pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600}.orange{background:#fff1e0;color:#9a4b00}.red{background:#fdecec;color:#b42318}.blue{background:#e8eeff;color:#1c3a99}.gray{background:#f0f0ee;color:#4b5160}.green{background:#e5f5ea;color:#14532d}
    .big{all:unset;box-sizing:border-box;cursor:pointer;width:100%;text-align:center;padding:10px;border-radius:9px;background:#101217;color:#fff;font-weight:700}.big.blue{background:#2B4BFF}
    h4{margin:0 0 4px;font-size:12px;color:#6b7280;font-weight:600}p{margin:0}
    .sug{background:#eef2ff;border:1px solid #d7defc;border-radius:10px;padding:10px;white-space:pre-wrap}
    .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.btn{all:unset;box-sizing:border-box;cursor:pointer;padding:5px 10px;border:1px solid #d9d9d2;border-radius:8px;font-size:12.5px;font-weight:600;background:#fff}
    .btn:hover,.big:hover{filter:brightness(.96)}.btn[disabled]{opacity:.5;cursor:default}
    .btn:focus-visible,.big:focus-visible,.x:focus-visible,input:focus-visible,.pick:focus-visible{outline:2px solid #2B4BFF;outline-offset:2px}
    input{font:inherit;width:100%;padding:8px 10px;border:1px solid #d9d9d2;border-radius:8px}
    .kv{display:flex;justify-content:space-between;align-items:center;padding:3px 0}.muted{color:#6b7280}.small{font-size:12px}
    .ans{background:#f7f7f5;border-radius:8px;padding:8px 10px}
    .pick{all:unset;box-sizing:border-box;cursor:pointer;display:block;width:100%;padding:8px 10px;border:1px solid #e4e4e0;border-radius:8px;margin-top:6px}.pick:hover{background:#f7f7f5}
    .ft{padding:10px 14px;border-top:1px solid #f0f0ec;color:#6b7280;font-size:11.5px}
    .toast{position:absolute;left:14px;right:14px;bottom:46px;background:#101217;color:#fff;border-radius:8px;padding:8px 10px;font-size:12px}
    .tab[hidden]{display:none}.tab{all:unset;cursor:pointer;position:fixed;right:0;top:120px;background:#2B4BFF;color:#fff;font:700 12px system-ui;padding:8px 6px;border-radius:8px 0 0 8px;writing-mode:vertical-rl}
  </style><div class="p" role="complementary" aria-label="HeyQuicky"><div class="hd"><svg class="logo" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="22" height="22"><rect width="1024" height="1024" rx="200" fill="#2B4BFF"/><g transform="translate(370.0 432.0) scale(4.0000)" fill="#FFFFFF" style="color:#FFFFFF"><path d="M0 100V20A18 18 0 0 1 36 20V100Z"/><path d="M33 26L60 -30" fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round"/><circle cx="18" cy="-28" r="20" fill="#FF7A3D"/></g></svg><strong>HeyQuicky</strong><span id="pill"></span><button class="x" id="hide">×</button></div>
  <div class="bd" id="bd" aria-live="polite"></div><div class="ft" id="ft"></div></div>`;
  const panel = root.querySelector('.p');
  const bd = root.getElementById('bd');
  const tab = document.createElement('button');
  tab.className = 'tab';
  root.appendChild(tab);
  tab.hidden = true;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let toastTimer = null;
  function toast(text) {
    root.querySelector('.toast')?.remove();
    const el = document.createElement('div');
    el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = text;
    panel.appendChild(el);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.remove(), 2600);
  }
  function setHidden(h) {
    panel.style.display = h ? 'none' : 'flex';
    tab.hidden = !h;
    host.style.width = h ? '0' : '';
    chrome.storage.local.set({ hidden: h });
  }
  root.getElementById('hide').addEventListener('click', () => setHidden(true));
  tab.addEventListener('click', () => setHidden(false));

  // ---- Which chat is open ----
  function context() {
    const u = new URL(location.href);
    const name = (document.querySelector('[role="main"] [role="heading"], [role="main"] h2, [role="main"] h3')?.textContent || '').trim().slice(0, 80);
    return { page: u.searchParams.get('asset_id') || '', thread: u.searchParams.get('selected_item_id') || '', name };
  }

  let current = { key: '', id: null, data: null, suggestion: '' };
  async function resolve() {
    const c = context();
    if (!c.thread) return { state: 'nochat' };
    const key = `${c.page}:${c.thread}`;
    const { links = {} } = await chrome.storage.local.get(['links']);
    if (links[key]) return { state: 'chat', id: links[key], key, c };
    const r = await api('GET', `/ext/find?${new URLSearchParams(c)}`);
    if (r.status === 401) return { state: 'signedout' };
    if (!r.ok) return { state: 'error' };
    if (r.data.conversationId) return { state: 'chat', id: r.data.conversationId, key, c };
    if (r.data.otherPage) return { state: 'otherpage' };
    return { state: 'pick', key, c, candidates: r.data.candidates };
  }

  async function refresh(force = false) {
    const r = await resolve();
    root.getElementById('ft').textContent = t('tip');
    if (r.state !== 'chat') {
      current = { key: '', id: null, data: null, suggestion: '' };
      root.getElementById('pill').innerHTML = '';
      if (r.state === 'pick') return renderPick(r);
      bd.innerHTML = `<p class="muted">${esc({ nochat: t('openChat'), signedout: t('connect'), otherpage: t('otherPage'), error: t('error') }[r.state])}</p>`;
      return;
    }
    if (!force && current.id === r.id && current.data) return;
    if (current.id !== r.id) { current = { key: r.key, id: r.id, data: null, suggestion: '' }; bd.innerHTML = `<p class="muted">${t('loading')}</p>`; }
    const d = await api('GET', `/ext/chat/${r.id}`);
    if (!d.ok) { bd.innerHTML = `<p class="muted">${esc(d.status === 401 ? t('connect') : d.data?.error || t('error'))}</p>`; return; }
    // Nothing changed, or they're typing a question: leave the panel as it is.
    if (current.data && JSON.stringify(current.data) === JSON.stringify(d.data)) return;
    if (current.data && root.activeElement?.id === 'ask') return;
    current.data = d.data;
    if (!current.suggestion || current.suggestionFrom !== 'edited') { current.suggestion = d.data.suggestion; current.suggestionFrom = d.data.suggestionFrom; }
    render();
  }

  function renderPick(r) {
    bd.innerHTML = `<h4>${t('pick')}</h4><input id="q" placeholder="${esc(t('search'))}" aria-label="${esc(t('search'))}" value="${esc(r.c.name)}"><div id="list"></div>`;
    const list = root.getElementById('list');
    const show = (items) => { list.innerHTML = items.length ? items.map((x) => `<button class="pick" data-id="${x.id}">${esc(x.name)}</button>`).join('') : `<p class="muted small" style="margin-top:6px">${t('none')}</p>`; };
    show(r.candidates ?? []);
    let timer = null;
    root.getElementById('q').addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(async () => { const x = await api('GET', `/ext/find?${new URLSearchParams({ page: r.c.page, q: e.target.value })}`); if (x.ok) show(x.data.candidates ?? []); }, 300);
    });
    list.addEventListener('click', async (e) => {
      const id = Number(e.target.closest('.pick')?.dataset.id);
      if (!id) return;
      const { links = {} } = await chrome.storage.local.get(['links']);
      links[r.key] = id; // remembered for this Business Suite thread
      await chrome.storage.local.set({ links });
      refresh(true);
    });
  }

  function render() {
    const d = current.data;
    const human = d.status === 'you' || d.status === 'teammate' || d.status === 'needs_you';
    root.getElementById('pill').innerHTML = `<span class="pill ${TONE[d.status]}">${esc(t(d.status, d.takenBy))}</span>`;
    bd.innerHTML = `
      <button class="big${human ? '' : ' blue'}" id="toggle">${human ? t('giveBack') : t('takeOver')}</button>
      ${d.status === 'needs_you' && d.reason ? `<p class="small"><span class="muted">${t('reason')}:</span> ${esc(d.reason)}</p>` : ''}
      ${d.summary ? `<section><h4>${t('summary')}</h4><p>${esc(d.summary)}</p></section>` : ''}
      <section><h4>${t('suggested')}</h4>
        ${current.suggestion ? `<div class="sug" id="sug">${esc(current.suggestion)}</div>${current.suggestionFrom === 'saved' ? `<p class="muted small">${t('fromSaved')}</p>` : ''}` : `<p class="muted small">${t('noSuggestion')}</p>`}
        <div class="row" style="margin-top:8px">
          ${current.suggestion ? `<button class="btn" id="copy">${t('copy')}</button><button class="btn" id="shorter" ${d.aiReady ? '' : 'disabled'}>${t('shorter')}</button>` : `<button class="btn" id="suggest" ${d.aiReady ? '' : `disabled title="${esc(t('noAi'))}"`}>${t('suggest')}</button>`}
          <button class="btn" id="size">${t('sizeChart')}</button>
        </div><div id="choices"></div></section>
      <section><h4>${t('ask')}</h4><form id="askf"><input id="ask" placeholder="${esc(t('askPh'))}" aria-label="${esc(t('ask'))}" ${d.aiReady ? '' : 'disabled'}></form><div id="ans"></div></section>
      <section><h4>${t('customer')}</h4>
        <div class="kv"><span>${t('courier')}</span>${d.courier ? `<span class="pill ${d.courier.safe ? 'green' : 'red'}">${esc(d.courier.safe ? t('safe', d.courier.rate) : t('risky', d.courier.rate))}</span>` : `<span class="muted small">${t('notChecked')}</span>`}</div>
        <div class="kv"><span>${t('orders')}</span><strong>${Number(d.orders) || 0}</strong></div>
        <div class="row" style="margin-top:6px"><a class="btn" id="open" href="${esc(d.open)}" target="_blank" rel="noopener">${t('open')}</a></div>
      </section>`;
    const on = (id, fn) => root.getElementById(id)?.addEventListener('click', fn);
    on('toggle', async () => {
      const r = await api('POST', `/inbox/${d.id}/${human ? 'release' : 'takeover'}`);
      if (!r.ok) return toast(r.data?.error || t('error'));
      refresh(true);
    });
    on('copy', async () => { await navigator.clipboard.writeText(current.suggestion).catch(() => {}); toast(t('copied')); });
    on('shorter', async () => {
      const r = await api('POST', `/ext/chat/${d.id}/shorter`, { text: current.suggestion });
      if (!r.ok) return toast(r.data?.error || t('error'));
      current.suggestion = r.data.text; current.suggestionFrom = 'edited'; render();
    });
    on('suggest', async () => {
      root.getElementById('suggest').disabled = true;
      const r = await api('POST', `/inbox/${d.id}/draft`);
      if (!r.ok) { toast(r.data?.error || t('error')); root.getElementById('suggest').disabled = false; return; }
      current.suggestion = r.data.text; current.suggestionFrom = 'ai'; render();
    });
    const sendSize = async (productId) => {
      const r = await api('POST', `/ext/chat/${d.id}/size-chart`, productId ? { productId } : {});
      const box = root.getElementById('choices');
      if (r.status === 409 && r.data?.choices) {
        box.innerHTML = `<p class="small" style="margin-top:8px">${t('which')}</p>${r.data.choices.map((c) => `<button class="pick" data-p="${c.id}">${esc(c.name)}</button>`).join('')}`;
        box.onclick = (e) => { const p = Number(e.target.closest('.pick')?.dataset.p); if (p) sendSize(p); };
        return;
      }
      if (!r.ok) return toast(r.data?.error || t('error'));
      box.innerHTML = ''; toast(t('sent'));
    };
    on('size', () => sendSize());
    root.getElementById('askf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = root.getElementById('ask').value.trim();
      if (!q) return;
      root.getElementById('ans').innerHTML = `<p class="muted small" style="margin-top:6px">${t('loading')}</p>`;
      const r = await api('POST', `/inbox/${d.id}/ask`, { question: q });
      root.getElementById('ans').innerHTML = `<div class="ans" style="margin-top:6px">${esc(r.ok ? r.data.answer : r.data?.error || t('error'))}</div>`;
    });
  }

  // ---- Badges on the Business Suite chat list ----
  async function badges() {
    const page = new URL(location.href).searchParams.get('asset_id') || '';
    const r = await api('GET', `/ext/statuses?${new URLSearchParams({ page })}`);
    if (!r.ok) return;
    const byName = new Map(r.data.chats.map((c) => [c.name.trim().toLowerCase(), c]));
    document.querySelectorAll('[data-hq-badge]').forEach((b) => b.remove());
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walker.nextNode(), i = 0; n && i < 20000; n = walker.nextNode(), i++) {
      const chat = byName.get(n.nodeValue.trim().toLowerCase());
      if (chat && !n.parentElement.closest('[role="main"], [data-hq-badge]')) hits.push([n.parentElement, chat]);
    }
    for (const [el, chat] of hits) {
      const b = document.createElement('span');
      b.dataset.hqBadge = '1';
      b.textContent = t(chat.status, '');
      const c = { orange: ['#fff1e0', '#9a4b00'], red: ['#fdecec', '#b42318'], blue: ['#e8eeff', '#1c3a99'], gray: ['#f0f0ee', '#4b5160'] }[TONE[chat.status]];
      b.style.cssText = `display:inline-block;margin-left:6px;padding:0 7px;border-radius:999px;font:600 10.5px/17px system-ui,sans-serif;background:${c[0]};color:${c[1]};vertical-align:middle`;
      el.after(b);
    }
  }

  // ---- Start ----
  chrome.storage.local.get(['lang', 'hidden']).then((s) => {
    lang = s.lang || (navigator.language.startsWith('bn') ? 'bn' : 'en');
    tab.textContent = t('show');
    root.getElementById('hide').setAttribute('aria-label', t('hide'));
    document.documentElement.appendChild(host);
    setHidden(Boolean(s.hidden));
    refresh(true);
    badges();
  });
  let lastUrl = location.href;
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; refresh(); } }, 700);
  setInterval(() => { if (!document.hidden) refresh(true); }, 15000);
  setInterval(() => { if (!document.hidden) badges(); }, 20000);
  chrome.storage.onChanged.addListener((ch) => { if (ch.token || ch.lang) { if (ch.lang) lang = ch.lang.newValue || 'en'; refresh(true); } });
})();
