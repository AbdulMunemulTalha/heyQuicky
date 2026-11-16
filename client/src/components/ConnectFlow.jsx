import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { connectWhatsApp, facebookPopup } from '../connect.js';
import { useSocketEvent } from './common.jsx';

// The "Connect channels" popup: Facebook login (in its own window), picking a Page,
// setting it up, and WhatsApp through Meta's sign-up window. Every step reflects
// what actually happened on the server; nothing advances on a timer alone.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

function Step({ state, title, detail }) {
  return (
    <div className={`cf-step ${state}`}>
      <span className="cf-dot">{state === 'done' ? '✓' : state === 'failed' ? '!' : state === 'skipped' ? '–' : ''}</span>
      <div><b>{title}</b><small>{detail}</small></div>
    </div>
  );
}

function Shell({ title, onClose, children }) {
  return (
    <div className="cf-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cf-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="cf-head">
          <span className="brand-mark" aria-hidden="true" />
          <span>{title}</span>
          <button type="button" className="cf-x" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="cf-body">{children}</div>
      </div>
    </div>
  );
}

function Bar({ step }) {
  return <div className="cf-bar">{[1, 2, 3].map((i) => <span key={i} className={i <= step ? 'on' : ''} />)}</div>;
}

// `start` = { kind: 'facebook' | 'instagram' | 'whatsapp', mode?, pendingId? }.
export function ConnectFlow({ start, me, onClose, onContinueSetup, onboarding }) {
  const [screen, setScreen] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null); // { id, userName, permissions, pages }
  const [steps, setSteps] = useState({});
  const [pageId, setPageId] = useState(null);
  const [opts, setOpts] = useState({ messenger: true, instagram: true });
  const [search, setSearch] = useState('');
  const [result, setResult] = useState(null); // POST result for the chosen page
  const [channels, setChannels] = useState([]);
  const [wa, setWa] = useState({ number: '', mode: 'app', result: null, from: null });
  const popup = useRef(null);
  const connect = me.connect;

  const loadChannels = useCallback(() => api('/channels').then(setChannels).catch(() => {}), []);
  useSocketEvent('channels', loadChannels);

  // Opening the popup decides the first screen.
  useEffect(() => {
    if (!start) return;
    setError('');
    setResult(null);
    setPending(null);
    setSearch('');
    loadChannels();
    const local = (me.workspace.phone || '').replace(/^\+?880|^0/, '');
    setWa({ number: local, mode: start.mode ?? 'app', result: null, from: null });
    if (start.pendingId) receive({ id: start.pendingId });
    else if (start.kind === 'whatsapp') setScreen('wa-number');
    else setScreen('start');
  }, [start]); // eslint-disable-line react-hooks/exhaustive-deps

  function close() {
    popup.current?.cancel();
    popup.current = null;
    setScreen(null);
    onClose();
  }

  // ---- Facebook ----

  function openFacebook({ rerequest = false } = {}) {
    setError('');
    popup.current?.cancel();
    const p = facebookPopup({ rerequest });
    popup.current = p;
    if (p.blocked) { setScreen('redirecting'); return; }
    setScreen('fb-wait');
    p.promise.then((r) => {
      if (popup.current !== p) return; // replaced by "Try again"
      popup.current = null;
      if (r.closed) { setScreen('start'); setError('The Facebook window was closed before you finished.'); return; }
      receive(r);
    });
  }

  async function receive(r) {
    if (r.error) { setScreen('start'); setError(r.error); return; }
    setScreen('connecting');
    setSteps({ login: 'done', secure: 'active', pages: 'todo' });
    // The server exchanged the login for a secure token before reporting back.
    await wait(350);
    setSteps({ login: 'done', secure: 'done', pages: 'active' });
    try {
      const data = await api(`/connect/facebook/${encodeURIComponent(r.id)}`);
      setSteps({ login: 'done', secure: 'done', pages: 'done' });
      await wait(300);
      setPending({ id: r.id, ...data });
      const first = data.pages.find((p) => !p.messengerConnected) ?? data.pages[0];
      choosePage(first, data.permissions);
      const missing = (data.permissions ?? []).filter((p) => !p.allowed);
      setScreen(missing.length ? 'permissions' : 'pages');
    } catch (err) {
      setSteps({ login: 'done', secure: 'done', pages: 'failed' });
      setError(err.message);
    }
  }

  const allowed = (key) => !pending?.permissions || pending.permissions.find((p) => p.key === key)?.allowed !== false;

  function choosePage(page, permissions = pending?.permissions) {
    if (!page) return;
    setPageId(page.id);
    const igAllowed = !permissions || permissions.find((p) => p.key === 'instagram')?.allowed !== false;
    setOpts({ messenger: true, instagram: Boolean(page.instagram) && igAllowed });
  }

  const page = pending?.pages.find((p) => p.id === pageId) ?? null;
  const shownPages = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (pending?.pages ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.instagram?.username?.toLowerCase().includes(q));
  }, [pending, search]);

  async function connectPage() {
    if (!page || (!opts.messenger && !opts.instagram)) return;
    setError('');
    setScreen('setup');
    setSteps({ subscribe: 'active', instagram: opts.instagram ? 'todo' : 'skipped', history: 'todo' });
    try {
      const body = { messenger: opts.messenger ? [page.id] : [], instagram: opts.instagram && page.instagram ? [page.instagram.id] : [] };
      const r = await api(`/connect/facebook/${encodeURIComponent(pending.id)}`, { method: 'POST', body });
      setResult(r);
      setSteps({
        subscribe: r.steps?.messages ? 'done' : 'failed',
        instagram: !opts.instagram ? 'skipped' : r.steps?.instagram ? 'done' : 'failed',
        history: r.importingIds?.length ? 'active' : 'skipped',
      });
      if (!r.connected.length) setError(r.problems.join(' ') || 'Nothing was connected.');
      loadChannels();
    } catch (err) {
      setSteps((s) => ({ ...s, subscribe: 'failed' }));
      setError(err.message);
    }
  }

  // Past chats arrive in the background; the import status on each channel says how far it is.
  const imported = channels.filter((c) => result?.importingIds?.includes(c.id));
  const stillImporting = imported.some((c) => c.importStatus === 'running');
  const importedCount = imported.reduce((n, c) => n + (c.conversationCount ?? 0), 0);
  useEffect(() => {
    if (screen === 'setup' && steps.history === 'active' && imported.length && !stillImporting) {
      setSteps((s) => ({ ...s, history: 'done' }));
    }
  }, [screen, steps.history, imported.length, stillImporting]);
  // Everything finished: show "All set" after a short pause so the last tick is seen.
  useEffect(() => {
    if (screen !== 'setup' || steps.history !== 'done' || steps.subscribe !== 'done') return undefined;
    const t = setTimeout(() => setScreen('done'), 900);
    return () => clearTimeout(t);
  }, [screen, steps.history, steps.subscribe]);

  // ---- WhatsApp ----

  async function startWhatsApp(e) {
    e.preventDefault();
    setError('');
    const digits = wa.number.replace(/\D/g, '').replace(/^880/, '').replace(/^0/, '');
    if (!/^1[3-9]\d{8}$/.test(digits)) { setError('Enter a Bangladeshi mobile number, e.g. 1712-345678.'); return; }
    setScreen('wa-wait');
    try {
      const r = await connectWhatsApp(connect, wa.mode, `0${digits}`);
      if (!r.connected?.length) {
        setScreen('wa-number');
        setError(r.problems?.join(' ') || 'WhatsApp was not connected.');
        return;
      }
      setWa((w) => ({ ...w, result: r }));
      setScreen('wa-done');
      loadChannels();
    } catch (err) {
      setScreen('wa-number');
      setError(err.message);
    }
  }

  if (!start || !screen) return null;

  const percent = (() => {
    const list = Object.values(steps).filter((s) => s !== 'skipped');
    return list.length ? Math.round((list.filter((s) => s === 'done').length / list.length) * 100) : 0;
  })();
  const waChannel = channels.find((c) => c.platform === 'whatsapp');
  const fbNotSetUp = !connect?.facebook;
  const waNotSetUp = !connect?.whatsapp;

  // ---- Screens ----

  if (screen === 'start') {
    return (
      <Shell title="Connect channels" onClose={close}>
        <div className="cf-tiles"><span className="t fb">FB</span><span className="t ig">IG</span><span className="t wa">WA</span></div>
        <h2>Connect your page in one click</h2>
        <p className="muted">Log in with Facebook, pick your page, and Quicky sets up Messenger and the linked Instagram for you.</p>
        <ul className="cf-checks">
          <li>Reads and replies to your page's messages</li>
          <li>Never posts on your page without asking</li>
          <li>Never sees your Facebook password</li>
        </ul>
        {error && <p className="cf-error">{error}</p>}
        <button type="button" className="cf-primary fb" disabled={fbNotSetUp} onClick={() => openFacebook()}>Continue with Facebook</button>
        {fbNotSetUp && <p className="muted small center">Facebook login isn't set up on this server yet (META_APP_ID and META_APP_SECRET).</p>}
        <button type="button" className="cf-link" disabled={waNotSetUp} onClick={() => { setError(''); setScreen('wa-number'); }}>Only connect WhatsApp</button>
        <p className="muted small center">Uses Facebook's official login. You can disconnect any time in Settings.</p>
      </Shell>
    );
  }

  if (screen === 'redirecting') {
    return (
      <Shell title="Facebook login" onClose={close}>
        <p className="muted">Your browser blocked the Facebook window, so we're opening Facebook in this tab instead. You'll come straight back here.</p>
      </Shell>
    );
  }

  if (screen === 'fb-wait') {
    return (
      <Shell title="Facebook login" onClose={close}>
        <p className="muted center small">A Facebook window is open. Quicky waits here until you finish.</p>
        <div className="cf-fbframe">
          <div className="cf-fbbar"><i /><i /><i /> facebook.com · login</div>
          <div className="cf-fbcontent">
            <b>In the Facebook window:</b>
            <ol>
              <li>Log in, or continue as yourself</li>
              <li>Tick your shop's Page (and its Instagram account)</li>
              <li>Keep "Manage and access Page messages" switched on, then tap Continue / Save</li>
            </ol>
            <button type="button" className="ghost" onClick={() => popup.current?.focus()}>Show the Facebook window</button>
          </div>
        </div>
        <p className="cf-waiting"><span className="spin" /> Waiting for Facebook…</p>
        <button type="button" className="cf-link" onClick={() => openFacebook()}>Window didn't open? Try again</button>
      </Shell>
    );
  }

  if (screen === 'connecting') {
    return (
      <Shell title="Connecting" onClose={close}>
        <h2>Connecting to Facebook</h2>
        <p className="muted">This takes a few seconds.</p>
        <div className="cf-steps">
          <Step state={steps.login} title="Logged in with Facebook" detail={steps.login === 'done' ? 'Done' : 'Waiting for Facebook…'} />
          <Step state={steps.secure} title="Securing your connection" detail={steps.secure === 'done' ? 'Done' : steps.secure === 'active' ? 'Working…' : 'Next'} />
          <Step state={steps.pages} title="Finding your pages" detail={steps.pages === 'done' ? 'Done' : steps.pages === 'active' ? 'Working…' : steps.pages === 'failed' ? 'Failed' : 'Next'} />
        </div>
        {error && <><p className="cf-error">{error}</p><button type="button" className="cf-primary fb" onClick={() => openFacebook()}>Try again</button></>}
      </Shell>
    );
  }

  if (screen === 'permissions') {
    const perms = pending.permissions;
    const missingLabels = perms.filter((p) => !p.allowed).map((p) => p.label);
    const canContinue = allowed('pages') && allowed('messages');
    return (
      <Shell title="Needs attention" onClose={close}>
        <span className="cf-warn-ico" aria-hidden="true">⚠</span>
        <h2>{missingLabels.length === 1 ? 'One permission is missing' : `${missingLabels.length} permissions are missing`}</h2>
        <p className="muted">Quicky can't use {missingLabels.join(' or ')}: {missingLabels.length === 1 ? 'it was' : 'they were'} switched off in the Facebook window.</p>
        <div className="cf-perms">
          {perms.map((p) => (
            <div key={p.key}><span>{p.label}</span><b className={p.allowed ? 'ok' : 'no'}>{p.allowed ? 'Allowed' : 'Not allowed'}</b></div>
          ))}
        </div>
        <button type="button" className="cf-primary fb" onClick={() => openFacebook({ rerequest: true })}>Allow it in Facebook</button>
        {canContinue && (
          <button type="button" className="cf-secondary" onClick={() => setScreen('pages')}>
            Continue without {missingLabels.join(' and ')}
          </button>
        )}
      </Shell>
    );
  }

  if (screen === 'pages') {
    return (
      <Shell title="Choose your page" onClose={close}>
        <div className="cf-titlerow"><h2>Choose your page</h2><span className="cf-badge">Access granted</span></div>
        <p className="muted">
          {pending.userName ? `Logged in as ${pending.userName}. ` : ''}We found {pending.pages.length} page{pending.pages.length === 1 ? '' : 's'} you manage.
        </p>
        {pending.pages.length > 4 && (
          <input className="cf-search" type="search" placeholder="Search your pages" value={search} onChange={(e) => setSearch(e.target.value)} />
        )}
        <div className="cf-pages" role="radiogroup">
          {shownPages.map((p) => {
            const on = p.id === pageId;
            return (
              <div key={p.id} className={`cf-page${on ? ' on' : ''}`}>
                <label className="cf-page-head">
                  <input type="radio" name="page" checked={on} onChange={() => choosePage(p)} />
                  <span className="cf-avatar">{initials(p.name)}</span>
                  <span className="grow"><b>{p.name}</b>
                    <small>{[p.category, p.followers != null && `${compact(p.followers)} followers`].filter(Boolean).join(' · ') || 'Facebook Page'}</small></span>
                  {p.instagram ? <span className="cf-ig">Instagram @{p.instagram.username || 'linked'}</span> : <span className="cf-noig">No Instagram</span>}
                </label>
                {on && (
                  <div className="cf-opts">
                    <label><input type="checkbox" checked={opts.messenger} onChange={(e) => setOpts((o) => ({ ...o, messenger: e.target.checked }))} />
                      <span className="badge messenger">Messenger</span> Page messages{p.messengerConnected ? ' · already connected (reconnect)' : ''}</label>
                    <label className="disabled"><input type="checkbox" disabled checked={false} readOnly />
                      <span className="badge comments">Comments</span> Replies on your posts <span className="soon">Coming soon</span></label>
                    {p.instagram && (
                      <label className={allowed('instagram') ? '' : 'disabled'}>
                        <input type="checkbox" disabled={!allowed('instagram')} checked={opts.instagram} onChange={(e) => setOpts((o) => ({ ...o, instagram: e.target.checked }))} />
                        <span className="badge instagram">Instagram</span> @{p.instagram.username || 'linked account'} DMs
                        {!allowed('instagram') && <span className="soon">Not allowed in Facebook</span>}
                        {p.instagram.connected ? ' · already connected' : ''}
                      </label>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {!shownPages.length && <p className="muted empty">No page matches "{search}".</p>}
        </div>
        {error && <p className="cf-error">{error}</p>}
        <button type="button" className="cf-primary" disabled={!page || (!opts.messenger && !opts.instagram)} onClick={connectPage}>
          Connect {page?.name ?? 'page'}
        </button>
        <p className="muted small center">Have more than one brand? Connect other pages afterwards with "Add another page".</p>
      </Shell>
    );
  }

  if (screen === 'setup') {
    const failed = Object.values(steps).includes('failed');
    return (
      <Shell title="Setting up" onClose={close}>
        <h2>Setting up {page?.name}</h2>
        <p className="muted">Quicky is connecting your page and bringing in your recent chats.</p>
        <div className="cf-progress"><div className="cf-track"><span style={{ width: `${percent}%` }} /></div><b>{percent}%</b></div>
        <div className="cf-steps">
          <Step state={steps.subscribe} title="Turning on messages" detail={steps.subscribe === 'done' ? 'Messages now reach Quicky' : steps.subscribe === 'failed' ? 'Facebook refused' : 'Subscribing to your page…'} />
          {steps.instagram !== 'skipped' && (
            <Step state={steps.instagram} title={`Linking Instagram @${page?.instagram?.username ?? ''}`}
              detail={steps.instagram === 'done' ? 'Done' : steps.instagram === 'failed' ? 'Not linked' : 'Next'} />
          )}
          <Step state={steps.history} title="Reading your past chats"
            detail={steps.history === 'done' ? `${importedCount} conversation${importedCount === 1 ? '' : 's'} brought in`
              : steps.history === 'active' ? `${importedCount} so far…` : steps.history === 'skipped' ? 'Skipped: new messages still arrive' : 'Next'} />
        </div>
        {error && <p className="cf-error">{error}</p>}
        {failed && !result?.connected?.length
          ? <button type="button" className="cf-primary" onClick={() => setScreen('pages')}>Back to pages</button>
          : <button type="button" className="cf-secondary" disabled={!result} onClick={() => setScreen('done')}>
            {stillImporting ? 'Continue setup while this finishes' : 'Continue'}
          </button>}
        <p className="muted small center">Bringing in past chats can take a minute. You can keep going — it finishes in the background.</p>
      </Shell>
    );
  }

  if (screen === 'done') {
    const fbConnected = result?.connected?.length;
    return (
      <Shell title="All set" onClose={close}>
        <span className="cf-badge">Connected</span>
        <h2>{fbConnected ? `${page?.name} is connected` : 'Your channels'}</h2>
        <p className="muted">Messages from these channels now arrive in your Quicky inbox.{onboarding ? ' The AI only drafts replies until you go live.' : ''}</p>
        <div className="cf-list">
          {result?.steps?.messages && <Step state="done" title="Messenger" detail={`${page?.name} · page messages`} />}
          {opts.instagram && result?.steps?.instagram && <Step state="done" title={`Instagram @${page?.instagram?.username ?? ''}`} detail="Direct messages" />}
          <div className="cf-step-row">
            <Step state={waChannel ? 'done' : 'todo'} title="WhatsApp" detail={waChannel ? waChannel.name : 'Optional · use your existing number'} />
            {!waChannel && <button type="button" className="ghost small-btn" disabled={waNotSetUp} onClick={() => { setError(''); setWa((w) => ({ ...w, from: 'done' })); setScreen('wa-number'); }}>Connect</button>}
          </div>
          {fbConnected && result?.importingIds?.length > 0 && (
            <Step state={stillImporting ? 'active' : 'done'} title={stillImporting ? 'Bringing in your past chats' : 'Past chats brought in'}
              detail={`${importedCount} conversation${importedCount === 1 ? '' : 's'}${stillImporting ? ' so far · keeps going in the background' : ''}`} />
          )}
        </div>
        {result?.problems?.length > 0 && <p className="cf-error">{result.problems.join(' ')}</p>}
        <button type="button" className="cf-primary" onClick={() => { close(); onContinueSetup?.(); }}>{onboarding ? 'Continue setup' : 'Done'}</button>
        <div className="cf-two">
          <button type="button" className="cf-secondary" disabled={fbNotSetUp} onClick={() => openFacebook()}>Add another page</button>
        </div>
      </Shell>
    );
  }

  if (screen === 'wa-number') {
    return (
      <Shell title="WhatsApp" onClose={close}>
        <div className="cf-wahead"><span className="t wa">WA</span><div><h2>Connect WhatsApp</h2><p className="muted">Use the number your customers already message.</p></div></div>
        <Bar step={1} />
        <form onSubmit={startWhatsApp} className="cf-form">
          <label className="field">WhatsApp number
            <div className="cf-phone"><span>+880</span><input inputMode="tel" autoComplete="tel-national" value={wa.number} placeholder="1712-345678"
              onChange={(e) => setWa((w) => ({ ...w, number: e.target.value }))} required autoFocus /></div>
          </label>
          <div className="cf-choice">
            <label><input type="radio" checked={wa.mode === 'app'} onChange={() => setWa((w) => ({ ...w, mode: 'app' }))} />
              <span><b>It's on the WhatsApp Business app</b><small>The app keeps working on your phone, and your chats can come along.</small></span></label>
            <label><input type="radio" checked={wa.mode === 'new'} onChange={() => setWa((w) => ({ ...w, mode: 'new' }))} />
              <span><b>A new number</b><small>Not used on WhatsApp yet. Quicky becomes its only WhatsApp.</small></span></label>
          </div>
          <div className="cf-note">
            <p>WhatsApp Business app numbers work. A personal WhatsApp number must be switched to WhatsApp Business first.</p>
            <p>Next, Meta opens its own window and sends a 6-digit code to this number on WhatsApp (or shows a QR code in your WhatsApp Business app). Meta doesn't let other apps take that code, so you enter it there.</p>
          </div>
          {error && <p className="cf-error">{error}</p>}
          <button type="submit" className="cf-primary wa" disabled={waNotSetUp}>Continue with Meta</button>
          {waNotSetUp && <p className="muted small center">WhatsApp sign-up isn't set up on this server yet (META_WHATSAPP_CONFIG_ID).</p>}
        </form>
      </Shell>
    );
  }

  if (screen === 'wa-wait') {
    const pretty = `+880 ${wa.number.replace(/\D/g, '').replace(/^880|^0/, '').replace(/^(\d{4})(\d+)/, '$1-$2')}`;
    return (
      <Shell title="WhatsApp" onClose={close}>
        <div className="cf-wahead"><span className="t wa">WA</span><div><h2>Connect WhatsApp</h2><p className="muted">Use the number your customers already message.</p></div></div>
        <Bar step={2} />
        <p>Finish in Meta's window for <b>{pretty}</b>:</p>
        <ol className="cf-ol">
          <li>Log in with Facebook and choose (or create) your business</li>
          <li>{wa.mode === 'app' ? 'Scan the QR code with your WhatsApp Business app' : 'Enter the 6-digit code Meta sends to this number on WhatsApp'}</li>
          <li>Tap Finish. This window updates by itself.</li>
        </ol>
        <p className="cf-waiting"><span className="spin" /> Waiting for Meta…</p>
        <p className="muted small center">Closed it by mistake? Cancel here and start again.</p>
        <button type="button" className="cf-secondary" onClick={() => setScreen('wa-number')}>Cancel</button>
      </Shell>
    );
  }

  if (screen === 'wa-done') {
    const r = wa.result;
    return (
      <Shell title="WhatsApp" onClose={close}>
        <div className="cf-wahead"><span className="t wa">WA</span><div><h2>Connect WhatsApp</h2><p className="muted">Use the number your customers already message.</p></div></div>
        <Bar step={3} />
        <p className="cf-success">✓ WhatsApp {r.displayNumber || r.connected[0]} connected</p>
        <p className="muted">New WhatsApp messages now arrive in your Quicky inbox.{r.importing ? ' Your chats are being copied in: keep the WhatsApp Business app open on your phone until it finishes.' : ''}</p>
        {r.pin && <p className="cf-note">Two-step verification PIN: <b>{r.pin}</b>. Write it down; Meta asks for it if the number is ever moved.</p>}
        {r.problems?.filter((p) => !/being copied/.test(p)).length > 0 && <p className="cf-error">{r.problems.filter((p) => !/being copied/.test(p)).join(' ')}</p>}
        <button type="button" className="cf-primary" onClick={() => (wa.from === 'done' ? setScreen('done') : close())}>Done</button>
      </Shell>
    );
  }

  return null;
}
