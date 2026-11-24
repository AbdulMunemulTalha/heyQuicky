import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { PLATFORM_LABEL } from '../format.js';
import { ErrorText, ImportStatus, useConnect, useSocketEvent } from './common.jsx';
import { Actions, Chips, Soon, StepHead, Toggle, useSubmit } from './onboarding/parts.jsx';

// The five onboarding steps. Step 1 is the sign-up form (signed out); the other four are
// saved as the workspace's onboardingStep. Products, courier & payments, team and the practice
// chat were taken out to make sign-up quicker; they live on in onboarding/parkedSteps.jsx.
export const STEPS = [
  { key: 'account', label: 'Create your account', min: 1 },
  { key: 'channels', label: 'Connect channels', min: 1 },
  { key: 'business', label: 'Business & delivery', min: 2 },
  { key: 'assistant', label: 'Your AI assistant', min: 1 },
  { key: 'live', label: 'Go live', min: 1 },
];
const KEYS = STEPS.map((s) => s.key);
// Shops that were partway through the longer onboarding resume at the step that now covers theirs.
const LEGACY_STEP = { shop: 'business', products: 'live', payments: 'live', team: 'live', test: 'live' };
// An unknown or missing step starts at connecting channels ('account' = editing the sign-up details).
export const currentStep = (key) => (KEYS.includes(key) ? key : LEGACY_STEP[key] ?? 'channels');
// 0-based position of the shop's current step among all five ("step N of 5" shows N = index + 1).
export const stepIndex = (key) => KEYS.indexOf(currentStep(key));

// ---------- Shared pieces ----------

// Sidebar, step header and the page frame every step shares.
export function OnboardingShell({ current, onGo, onSaveExit, onSignOut, support, children }) {
  const signingUp = current === 'account';
  const index = KEYS.indexOf(current);
  const minutesLeft = STEPS.slice(index).reduce((sum, s) => sum + s.min, 0);
  return (
    <div className="onb">
      <aside className="onb-side">
        <a href="/" className="brand-link brand">heyquicky</a>
        <div className="onb-progress">
          <div className="row"><span>Setup</span><span>{index} of {STEPS.length} done</span></div>
          <div className="bar"><span style={{ width: `${(index / STEPS.length) * 100}%` }} /></div>
        </div>
        <ol className="onb-nav">
          {STEPS.map((s, i) => {
            const state = i < index ? 'done' : i === index ? 'current' : 'todo';
            // Finished steps can be opened again to change them.
            const clickable = onGo && !signingUp && i < index;
            return (
              <li key={s.key} className={state}>
                <button type="button" disabled={!clickable} aria-label={`${s.label}: ${state === 'done' ? 'done' : state === 'current' ? 'current step' : 'to do'}`} onClick={() => clickable && onGo(s.key)}>
                  <span className="dot">{state === 'done' ? '✓' : i + 1}</span>
                  <span className="txt"><b>{s.label}</b><small>{state === 'done' ? 'Done' : `${s.min} min`}</small></span>
                </button>
              </li>
            );
          })}
        </ol>
        {support?.email && (
          <div className="onb-help">
            <b>Stuck? We'll set it up for you.</b>
            <span>Free setup and moving over from any other tool. Write to us and a real person gets back to you.</span>
            <a className="btn-ghost" href={`mailto:${support.email}?subject=${encodeURIComponent('Help me set up HeyQuicky')}`}>Email us</a>
          </div>
        )}
        <p className="onb-saved">Progress saves automatically{onSignOut && <> · <button type="button" className="link" onClick={onSignOut}>Sign out</button></>}</p>
      </aside>
      <main className="onb-main">
        <div className="onb-top">
          <span>{index === STEPS.length - 1 ? 'Last step' : `Step ${index + 1} of ${STEPS.length} · about ${minutesLeft} min left`}</span>
          {onSaveExit && <button type="button" className="ghost small-btn" onClick={onSaveExit}>Save &amp; exit</button>}
        </div>
        <div className="onb-body">{children}</div>
      </main>
    </div>
  );
}

// ---------- Step 1: account (signed out) ----------

const SURVEY = [
  ['messages_per_day', 'Messages a day across all pages', [['under_50', 'Under 50'], ['50_200', '50–200'], ['200_1000', '200–1,000'], ['1000_plus', '1,000+']]],
  ['team_size', 'Who answers messages now?', [['just_me', 'Just me'], ['1_2', '1–2 people'], ['3_plus', '3+ people']]],
  ['ad_spend', 'Monthly Facebook ad spend', [['none', 'None'], ['under_20k', 'Under ৳20k'], ['20k_1lakh', '৳20k–1 lakh'], ['1lakh_plus', '1 lakh+']]],
];

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_SURVEY = { messages_per_day: '50_200', team_size: 'just_me', ad_spend: 'none' };

// One id per visitor, so every save while typing updates the same lead.
function leadId() {
  let id = localStorage.getItem('quicky:lead-id');
  if (!id) {
    id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
    localStorage.setItem('quicky:lead-id', id);
  }
  return id;
}

// Saves the sign-up details as they're typed (never the password), so the team can follow up
// with people who don't finish. Waits for a pause in typing, and sends anything pending when the page closes.
function useLeadAutosave() {
  const timer = useRef(null);
  const pending = useRef(null);
  const send = useCallback((body, { beacon = false } = {}) => {
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/leads', new Blob([JSON.stringify(body)], { type: 'application/json' }));
      return;
    }
    api('/leads', { method: 'POST', body }).catch(() => {}); // best effort: never bother the visitor
  }, []);
  useEffect(() => {
    const flush = () => { if (pending.current) { send(pending.current, { beacon: true }); pending.current = null; } };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); clearTimeout(timer.current); };
  }, [send]);
  return useCallback((values) => {
    const phoneDigits = String(values.phone ?? '').replace(/\D/g, '');
    if (!EMAIL_OK.test(String(values.email ?? '').trim()) && phoneDigits.length < 11) return;
    const { password, ...rest } = values; // eslint-disable-line no-unused-vars
    pending.current = { id: leadId(), ...rest };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { send(pending.current); pending.current = null; }, 800);
  }, [send]);
}

// Step 1. Signed out it creates the account; signed in it edits the details given at sign-up.
function AccountForm({ initial, signedIn, onSubmit, onLogin, onValues }) {
  const [survey, setSurvey] = useState({ ...DEFAULT_SURVEY, ...(initial?.survey ?? {}) });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const formRef = useRef(null);
  const values = (nextSurvey = survey) => ({ ...Object.fromEntries(new FormData(formRef.current)), survey: nextSurvey });

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onSubmit(values());
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  const pickSurvey = (key, v) => {
    const next = { ...survey, [key]: v };
    setSurvey(next);
    onValues?.(values(next));
  };

  return (
    <div className="onb-split">
      <form ref={formRef} className="onb-card" onSubmit={submit} onInput={() => onValues?.(values())}>
        <div className="grid2">
          <label className="field">Your name<input name="name" required autoComplete="name" maxLength={80} defaultValue={initial?.name} /></label>
          <label className="field">Shop or page name<input name="businessName" required autoComplete="organization" maxLength={100} defaultValue={initial?.businessName} /></label>
          <label className="field">Email<input name="email" type="email" required autoComplete="email" placeholder="you@shop.com" defaultValue={initial?.email} /></label>
          <label className="field">Mobile<input name="phone" inputMode="tel" autoComplete="tel" placeholder="01XXX-XXXXXX" defaultValue={initial?.phone} />
            <small className="muted">If you get stuck, we'll call you on this number.</small></label>
          {!signedIn && (
            <label className="field wide">Password<input name="password" type="password" required minLength={8} autoComplete="new-password" placeholder="At least 8 characters" /></label>
          )}
        </div>
        {SURVEY.map(([key, label, options]) => (
          <div className="field" key={key}>
            <span>{label}</span>
            <Chips options={options} value={survey[key]} onChange={(v) => pickSurvey(key, v)} />
          </div>
        ))}
        {!signedIn && (
          <p className="muted small">We save these details as you type so our team can help you finish setting up.
            By continuing you agree to the <a href="/terms" target="_blank" rel="noreferrer">Terms</a> and <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.</p>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="onb-actions">
          {!signedIn && <span className="muted">Already have an account? <button type="button" className="link" onClick={onLogin}>Log in</button></span>}
          <span className="spacer" />
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : signedIn ? 'Save & continue' : 'Create account'}</button>
        </div>
      </form>
      <aside className="onb-dark">
        <h3>Live in about 6 minutes</h3>
        <ol>
          <li>Connect your page with Facebook's official login</li>
          <li>Tell us what you sell and how you deliver</li>
          <li>Give your AI assistant a name and a voice</li>
          <li>Go live when you're happy</li>
        </ol>
        <p>No card needed. Nothing reaches your customers until you go live.</p>
      </aside>
    </div>
  );
}

export function SignupStep({ onSubmit, onLogin, support }) {
  const autosave = useLeadAutosave();
  return (
    <OnboardingShell current="account" support={support}>
      <StepHead title="Start free — no card needed">
        Tell us a little about your shop. It takes a minute, and you can test everything before a single customer sees it.
      </StepHead>
      <AccountForm onLogin={onLogin} onValues={autosave}
        onSubmit={(v) => onSubmit({ ...v, leadId: leadId() }).then(() => localStorage.removeItem('quicky:lead-id'))} />
    </OnboardingShell>
  );
}

// Signed in, back on step 1: the details from sign-up, editable (the password is changed elsewhere).
function AccountStep({ save, setWorkspaceName }) {
  const [initial, setInitial] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/account').then(setInitial).catch((err) => setError(err.message)); }, []);
  return (
    <>
      <StepHead title="Your account">Check your details. Changes are saved when you continue.</StepHead>
      {initial ? (
        <AccountForm initial={initial} signedIn onSubmit={async (v) => {
          const { name, businessName, email, phone, survey } = v;
          const account = await api('/account', { method: 'PATCH', body: { name, businessName, email, phone, survey } });
          setWorkspaceName(account.businessName);
          await save({}, 'channels');
        }} />
      ) : <ErrorText>{error}</ErrorText>}
    </>
  );
}

// ---------- The wizard (signed in) ----------

function useSetupData() {
  const [channels, setChannels] = useState(null);
  const [team, setTeam] = useState(null);
  const [products, setProducts] = useState(null);
  const reload = useCallback(() => {
    api('/channels').then(setChannels).catch(() => {});
    api('/team').then(setTeam).catch(() => {});
    api('/products').then(setProducts).catch(() => {});
  }, []);
  useEffect(reload, [reload]);
  useSocketEvent('channels', reload);
  return { channels, team, products, reload };
}


export function Onboarding({ me, setWorkspace, onFinish, onSaveExit, onSignOut }) {
  const step = currentStep(me.workspace.onboardingStep);
  const data = useSetupData();
  const { resultVersion } = useConnect();
  const reloadData = data.reload;
  useEffect(() => { if (resultVersion) reloadData(); }, [resultVersion, reloadData]);

  // Saves fields and moves to `next`, so a refresh or the Facebook redirect resumes there.
  const save = useCallback(async (fields, next) => {
    const workspace = await api('/workspace', { method: 'PATCH', body: { ...fields, ...(next ? { onboardingStep: next } : {}) } });
    setWorkspace(workspace);
    window.scrollTo(0, 0);
    return workspace;
  }, [setWorkspace]);
  const go = useCallback((key) => save({}, key).catch((err) => alert(err.message)), [save]);
  const prev = KEYS[KEYS.indexOf(step) - 1];
  const back = prev ? () => go(prev) : null;
  const props = { ws: me.workspace, me, data, save, go, back };

  return (
    <OnboardingShell current={step} onGo={go} onSaveExit={onSaveExit} onSignOut={onSignOut} support={me.support}>
      {step === 'account' && <AccountStep {...props} setWorkspaceName={(name) => setWorkspace({ ...me.workspace, name })} />}
      {step === 'channels' && <ChannelsStep {...props} />}
      {step === 'business' && <BusinessStep {...props} />}
      {step === 'assistant' && <AssistantStep {...props} />}
      {step === 'live' && <LiveStep {...props} onFinish={onFinish} />}
    </OnboardingShell>
  );
}

// ---------- Step 1: channels ----------

const CHANNEL_HINT = {
  messenger: 'Private messages to your Facebook page',
  instagram: 'Instagram direct messages',
  whatsapp: 'Your WhatsApp Business number',
};

function ChannelsStep({ me, data, go, back }) {
  const { result, showResult, open } = useConnect();
  const channels = data.channels ?? [];
  const { facebook, whatsapp } = me.connect;

  async function setAi(c, aiEnabled) {
    try {
      await api(`/channels/${c.id}`, { method: 'PATCH', body: { aiEnabled } });
      data.reload();
    } catch (err) {
      alert(err.message);
    }
  }

  async function manualWhatsApp(e) {
    e.preventDefault();
    try {
      const channel = await api('/channels', { method: 'POST', body: { ...Object.fromEntries(new FormData(e.target)), platform: 'whatsapp' } });
      e.target.reset();
      showResult({ connected: [channel.name] });
    } catch (err) {
      showResult({ problems: [err.message] });
    }
  }

  return (
    <>
      <StepHead title="Connect your page and channels">
        Use Facebook's official login: we never see your password and never post without asking. Then pick which channels the AI should answer. You can change this any time.
      </StepHead>
      <div className="channel-tiles">
        {[
          ['messenger', 'fb', 'f', 'Facebook Page', 'Messenger messages', 'facebook', facebook],
          ['instagram', 'instagram', 'IG', 'Instagram', 'Linked to your page — no extra login', 'instagram', facebook],
          ['whatsapp', 'wa', 'WA', 'WhatsApp', 'Your existing business number', 'whatsapp', whatsapp],
        ].map(([platform, ico, letter, title, hint, kind, ready]) => {
          const count = channels.filter((c) => c.platform === platform).length;
          return (
            <button type="button" key={platform} className={`channel-tile${count ? ' connected' : ''}`} onClick={() => open(kind)}>
              <span className={`ch-ico ${ico}`}>{letter}</span>
              <b>{title}</b>
              <small>{hint}</small>
              {count ? <span className="tile-state ok">Connected{count > 1 ? ` · ${count}` : ''}</span>
                : ready ? <span className="tile-state">Connect →</span> : <Soon>Not set up on this server</Soon>}
            </button>
          );
        })}
      </div>
      <div className="onb-card">
        <details className="manual-connect">
          <summary className="muted small">Have a WhatsApp phone number ID and access token? Connect manually</summary>
          <form className="inline-form" onSubmit={manualWhatsApp}>
            <input name="name" placeholder="Name, e.g. Shop WhatsApp" required />
            <input name="externalId" placeholder="Phone number ID" required inputMode="numeric" />
            <input name="accessToken" placeholder="Access token" required />
            <button>Connect</button>
          </form>
        </details>
      </div>
      {result && <p className="notice rounded">{result}</p>}

      <h3 className="onb-sub">Pick what Quicky should answer</h3>
      <div className="onb-card list">
        {channels.map((c) => (
          <div className="connect-row" key={c.id}>
            <span className={`ch-ico ${c.platform}`}>{c.platform === 'messenger' ? 'FB' : c.platform === 'instagram' ? 'IG' : 'WA'}</span>
            <div className="grow">
              <b>{PLATFORM_LABEL[c.platform]} · {c.name}</b>
              <small>{CHANNEL_HINT[c.platform]}{c.needsReconnect ? ' · access expired, connect again' : ''}</small>
              <ImportStatus channel={c} />
            </div>
            <button type="button" className={`pill-toggle${c.aiEnabled ? ' on' : ''}`} aria-pressed={c.aiEnabled} onClick={() => setAi(c, !c.aiEnabled)}>
              {c.aiEnabled ? 'AI will answer' : 'Off'}
            </button>
          </div>
        ))}
        {data.channels && !channels.length && <p className="muted empty">Nothing connected yet. You can also do this later from Settings.</p>}
      </div>
      {!channels.length && <p className="muted small right">Connect at least one channel to continue.</p>}
      <Actions onBack={back} onNext={() => go('business')} disabled={!channels.length} />
    </>
  );
}

// ---------- Step 2: business & delivery ----------

const CATEGORIES = [
  ['clothing', 'Clothing', 'Products'], ['cosmetics', 'Cosmetics', 'Products'], ['electronics', 'Electronics', 'Products'],
  ['mobile_accessories', 'Mobile accessories', 'Products'], ['jewellery', 'Jewellery', 'Products'], ['shoes', 'Shoes', 'Products'],
  ['grocery', 'Grocery', 'Products'], ['food', 'Food & bakery', 'Products'], ['salon', 'Salon & parlour', 'Services'],
  ['clinic', 'Clinic', 'Services'], ['coaching', 'Coaching', 'Services'], ['other', 'Something else', 'Custom'],
];
const OLD_CATEGORY = { fashion: 'clothing', beauty: 'cosmetics', home: 'other', kids: 'other' };
const FIELDS = {
  clothing: [['Size', 'S, M, L, XL, XXL'], ['Colour', 'from product photos'], ['Size chart', 'chest, length, sleeve'], ['Fit', 'regular, loose']],
  cosmetics: [['Shade / colour', ''], ['Skin type', 'oily, dry, combination'], ['Quantity', '']],
  electronics: [['Model / variant', ''], ['Colour', ''], ['Quantity', '']],
  mobile_accessories: [['Phone model', 'e.g. iPhone 13, Galaxy A54'], ['Colour', ''], ['Quantity', '']],
  jewellery: [['Size', 'ring or bangle size'], ['Finish', 'gold, silver, rose gold'], ['Quantity', '']],
  shoes: [['Size', 'EU 36–45'], ['Colour', '']],
  grocery: [['Quantity / weight', 'e.g. 1 kg, 500 g'], ['Delivery time', 'morning, evening']],
  food: [['Flavour / item', ''], ['Quantity / pounds', ''], ['Delivery date & time', '']],
  salon: [['Service', ''], ['Preferred date & time', ''], ['Branch', '']],
  clinic: [['Service / doctor', ''], ['Preferred date & time', ''], ['Patient age', '']],
  coaching: [['Course / batch', ''], ["Student's class", ''], ['Preferred schedule', '']],
  other: [['Quantity', ''], ['Variant', 'size, colour or type']],
};
const fieldsFor = (category) => (FIELDS[category] ?? FIELDS.other).map(([label, hint]) => ({ label, hint, on: true }));

function BusinessStep({ ws, save, go, back }) {
  const initialCategory = OLD_CATEGORY[ws.category] ?? (FIELDS[ws.category] ? ws.category : '');
  const [category, setCategory] = useState(initialCategory);
  const [fields, setFields] = useState(() => (ws.orderFields?.length && initialCategory
    ? ws.orderFields.map((f) => ({ ...f, on: true }))
    : initialCategory ? fieldsFor(initialCategory) : []));
  const [custom, setCustom] = useState('');
  const [shop, setShop] = useState({
    address: ws.address, phone: ws.phone, sellsOffline: ws.sellsOffline,
    audience: ws.audience?.length ? ws.audience : [],
    deliveryInsideDhaka: ws.deliveryInsideDhaka, deliveryInsideDays: ws.deliveryInsideDays || '1–2',
    deliveryOutsideDhaka: ws.deliveryOutsideDhaka, deliveryOutsideDays: ws.deliveryOutsideDays || '2–3',
    cashOnDelivery: ws.cashOnDelivery, freeDelivery: Boolean(ws.freeDeliveryOver), freeDeliveryOver: ws.freeDeliveryOver || 3000,
  });
  const set = (key) => (value) => setShop((f) => ({ ...f, [key]: value?.target ? value.target.value : value }));
  const { busy, error, run } = useSubmit();
  const shopRef = useRef(null);

  function pick(c) {
    const first = !category;
    setCategory(c);
    setFields(fieldsFor(c));
    // The first pick reveals the shop & delivery questions below: bring them into view.
    if (first) setTimeout(() => shopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }
  function addCustom(e) {
    e.preventDefault();
    const label = custom.trim();
    if (!label) return;
    setFields((f) => [...f, { label, hint: '', on: true }]);
    setCustom('');
  }
  function submit(e) {
    e.preventDefault();
    const { freeDelivery, ...rest } = shop;
    run(() => save({
      category,
      orderFields: fields.filter((f) => f.on).map(({ label: l, hint }) => ({ label: l, hint })),
      ...rest,
      deliveryInsideDhaka: Number(shop.deliveryInsideDhaka),
      deliveryOutsideDhaka: Number(shop.deliveryOutsideDhaka),
      freeDeliveryOver: freeDelivery ? Number(shop.freeDeliveryOver) : null,
    }, 'assistant'));
  }
  const label = CATEGORIES.find(([v]) => v === category)?.[1];

  return (
    <form onSubmit={submit}>
      <StepHead title="What do you sell?">Pick the closest match, then tell us about your shop and delivery. The AI uses this to answer and quote charges correctly.</StepHead>
      <div className="onb-split">
        <div className="cat-grid">
          {CATEGORIES.map(([value, name, kind]) => (
            <button type="button" key={value} className={`cat${category === value ? ' on' : ''}`} onClick={() => pick(value)}>
              <span className="cat-ico">{name[0]}</span><b>{name}</b><small>{kind}</small>
            </button>
          ))}
        </div>
        <aside className="onb-card side-panel">
          {category ? (
            <>
              <b>We'll set up for {label.toLowerCase()}</b>
              {fields.map((f, i) => (
                <label key={`${f.label}-${i}`} className="field-check">
                  <span><b>{f.label}</b>{f.hint && <small>{f.hint}</small>}</span>
                  <input type="checkbox" checked={f.on} onChange={(e) => setFields((all) => all.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                </label>
              ))}
              <div className="add-field">
                <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Add your own question" maxLength={40}
                  onKeyDown={(e) => { if (e.key === 'Enter') addCustom(e); }} />
                <button type="button" className="ghost" onClick={addCustom}>Add</button>
              </div>
              <small className="muted">The AI asks for these, with name, phone and address, before handing an order to your team. You can change them any time.</small>
            </>
          ) : <p className="muted">Pick a category to see the order questions we'll set up, and your shop and delivery details.</p>}
        </aside>
      </div>

      {category && (
        <div ref={shopRef} className="reveal">
          <div className="onb-card">
            <b className="card-title">Your shop</b>
            <div className="grid2">
              <label className="field">Area / pickup address<input value={shop.address} onChange={set('address')} placeholder="e.g. Mirpur 10, Dhaka" maxLength={200} /></label>
              <label className="field">Customer support number<input value={shop.phone} onChange={set('phone')} inputMode="tel" placeholder="01XXX-XXXXXX" /></label>
            </div>
            <div className="field"><span>Where do you sell?</span>
              <Chips options={[[false, 'Online only'], [true, 'Online + physical shop']]} value={shop.sellsOffline} onChange={set('sellsOffline')} /></div>
            <div className="field"><span>Who do you sell to?</span>
              <Chips multi options={[['women', 'Women'], ['girls', 'Girls'], ['men', 'Men'], ['kids', 'Kids'], ['everyone', 'Everyone']]} value={shop.audience} onChange={set('audience')} /></div>
          </div>
          <div className="onb-card">
            <b className="card-title">Delivery</b>
            <div className="grid2">
              <fieldset className="zone"><legend>Inside Dhaka</legend>
                <label className="field">Charge (৳)<input type="number" min="0" step="1" required value={shop.deliveryInsideDhaka} onChange={set('deliveryInsideDhaka')} /></label>
                <label className="field">Days<input value={shop.deliveryInsideDays} onChange={set('deliveryInsideDays')} maxLength={20} /></label>
              </fieldset>
              <fieldset className="zone"><legend>Outside Dhaka</legend>
                <label className="field">Charge (৳)<input type="number" min="0" step="1" required value={shop.deliveryOutsideDhaka} onChange={set('deliveryOutsideDhaka')} /></label>
                <label className="field">Days<input value={shop.deliveryOutsideDays} onChange={set('deliveryOutsideDays')} maxLength={20} /></label>
              </fieldset>
            </div>
            <Toggle label="Accept cash on delivery" checked={shop.cashOnDelivery} onChange={set('cashOnDelivery')} />
            <div className="check-row">
              <span>Free delivery on orders over ৳
                <input className="inline-num" type="number" min="1" step="1" value={shop.freeDeliveryOver} disabled={!shop.freeDelivery} onChange={set('freeDeliveryOver')} aria-label="Free delivery amount" /></span>
              <input type="checkbox" checked={shop.freeDelivery} onChange={(e) => set('freeDelivery')(e.target.checked)} aria-label="Offer free delivery" />
            </div>
          </div>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      <Actions onBack={back} onSkip={() => go('assistant')} busy={busy} disabled={!category} type="submit" />
    </form>
  );
}

// ---------- Step 3: AI assistant ----------

const NAMES = ['Nusrat', 'Sadia', 'Tania', 'Karim', 'Rahim', 'Arif'];
const STYLES = [['banglish', 'Banglish, warm'], ['bangla', 'Bangla, polite'], ['english', 'English'], ['casual', 'Friendly & casual']];
const ADDRESS = [['auto', 'Auto'], ['apu', 'Apu'], ['bhaiya', 'Bhaiya'], ['sir_madam', 'Sir / Madam'], ['bondhu', 'Bondhu']];
const SALES = [['consultative', 'Consultative — helps them choose'], ['direct', 'Direct — straight to the order']];
const TITLE = { auto: { lat: 'apu', bn: 'আপু', en: '' }, apu: { lat: 'apu', bn: 'আপু', en: '' }, bhaiya: { lat: 'bhaiya', bn: 'ভাইয়া', en: '' },
  sir_madam: { lat: 'madam', bn: 'ম্যাডাম', en: ' Madam' }, bondhu: { lat: 'bondhu', bn: 'বন্ধু', en: '' } };

function previewText({ name, style, address, shop }) {
  const who = name || 'Your assistant';
  const t = TITLE[address];
  if (style === 'bangla') return `ওয়ালাইকুম আসসালাম ${t.bn}! আমি ${who}, ${shop}-এর মডারেটর। বলুন, কী খুঁজছেন?`;
  if (style === 'english') return `Walaikum assalam${t.en}! I'm ${who} from ${shop}. What are you looking for today?`;
  if (style === 'casual') return `Hi ${t.lat}! ${who} here from ${shop} 😊 Ki lagbe bolun?`;
  return `Walaikum assalam ${t.lat}! Ami ${who}, ${shop} er moderator. Bolun, ki khujchen?`;
}

function AssistantStep({ ws, save, go, back }) {
  const [name, setName] = useState(ws.aiName || 'Nusrat');
  const [style, setStyle] = useState(ws.aiStyle);
  const [address, setAddress] = useState(ws.aiAddress);
  const [sales, setSales] = useState(ws.aiSales);
  const { busy, error, run } = useSubmit();
  const custom = !NAMES.includes(name);
  const styleLabel = STYLES.find(([v]) => v === style)?.[1];
  const addressLabel = ADDRESS.find(([v]) => v === address)?.[1];

  return (
    <>
      <StepHead title="Meet your AI assistant">Give it a name and a voice. It answers as a moderator of your page.</StepHead>
      <div className="onb-split">
        <div className="onb-card">
          <div className="field"><span>Name your assistant</span>
            <Chips options={[...NAMES.map((n) => [n, n]), ['__custom', 'Other…']]} value={custom ? '__custom' : name}
              onChange={(v) => setName(v === '__custom' ? '' : v)} />
            {custom && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Type a name" maxLength={30} autoFocus />}
          </div>
          <div className="field"><span>How it writes</span><Chips options={STYLES} value={style} onChange={setStyle} />
            <small className="muted">Used when the customer's language isn't clear. Otherwise it always replies in the customer's own language.</small></div>
          <div className="field"><span>How it addresses customers</span><Chips options={ADDRESS} value={address} onChange={setAddress} />
            <small className="muted">Auto reads the customer's name and writing to choose Apu or Bhaiya.</small></div>
          <div className="field"><span>Sales style</span><Chips options={SALES} value={sales} onChange={setSales} /></div>
        </div>
        <aside className="onb-dark preview">
          <small className="eyebrow">Live preview</small>
          <div className="phone">
            <p className="b-out">Assalamu alaikum, ache?</p>
            <p className="b-in">{previewText({ name: name.trim(), style, address, shop: ws.name })}</p>
          </div>
          <small>{name.trim() || 'Unnamed'} · {styleLabel} · addresses customers: {addressLabel}</small>
          <small className="muted-dark">If a customer sincerely asks whether they're talking to a bot, it tells the truth and offers a person.</small>
        </aside>
      </div>
      <ErrorText>{error}</ErrorText>
      <Actions onBack={back} onSkip={() => go('live')} busy={busy} next="Looks good" disabled={!name.trim()}
        onNext={() => run(() => save({ aiName: name.trim(), aiStyle: style, aiAddress: address, aiSales: sales }, 'products'))} />
    </>
  );
}

// ---------- Step 4: go live ----------

const STYLE_LABEL = Object.fromEntries(STYLES);

function LiveStep({ ws, me, data, save, back, onFinish }) {
  const { busy, error, run } = useSubmit();
  const channels = data.channels ?? [];
  const aiChannels = channels.filter((c) => c.aiEnabled);
  const products = data.products ?? [];
  const finish = (aiMode) => run(async () => {
    await save({ aiMode }, 'done');
    onFinish();
  });
  const summary = [
    ['Channels', aiChannels.length ? aiChannels.map((c) => `${PLATFORM_LABEL[c.platform]} · ${c.name}`).join(', ') : 'None yet: connect in Settings'],
    ['Assistant', `${ws.aiName || 'Unnamed'} · ${STYLE_LABEL[ws.aiStyle] ?? ''}`],
    ['Business', CATEGORIES.find(([v]) => v === (OLD_CATEGORY[ws.category] ?? ws.category))?.[1] ?? 'Not set'],
    ['Delivery', `৳${ws.deliveryInsideDhaka} / ৳${ws.deliveryOutsideDhaka}${ws.cashOnDelivery ? ' · COD' : ''}`],
  ];
  return (
    <>
      <StepHead title="You're ready to go live">One switch and the AI starts answering real customers.</StepHead>
      <div className="onb-split">
        <div className="onb-card">
          <b className="card-title">{ws.name} is ready</b>
          <div className="summary-grid">
            {summary.map(([k, v]) => <div key={k}><small>{k}</small><b>{v}</b></div>)}
          </div>
          {!products.length && (
            <p className="notice rounded small">Next, add your products in <b>Settings → AI chat agent</b>. Until then the AI won't quote prices; it hands those questions to you.</p>
          )}
          <small className="muted">You can switch the AI off for any channel, or go back to drafts only, any time in Settings. Add your team, products and bKash/Nagad numbers there too.</small>
        </div>
        <aside className="onb-dark">
          <h3>Let Quicky answer tonight's messages.</h3>
          <p>{me.ai.available
            ? 'Live: the AI replies to customers itself and hands orders, payments and complaints to your team.'
            : 'The AI starts replying as soon as AI is switched on for this server. Everything else works now.'}</p>
          <button type="button" className="yellow" disabled={busy} onClick={() => finish('auto')}>Go live now</button>
          {me.features?.practice ? (
            <>
              <button type="button" className="dark-ghost" disabled={busy} onClick={() => finish('suggest')}>Stay in practice mode</button>
              <small>Practice mode: the AI only drafts replies; your team checks and sends them.</small>
            </>
          ) : (
            <>
              <button type="button" className="dark-ghost" disabled={busy} onClick={() => finish('off')}>Not yet — keep the AI off</button>
              <small>You can switch the AI live any time from the top bar.</small>
            </>
          )}
        </aside>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="onb-actions">{back && <button type="button" className="ghost" onClick={back}>Back</button>}</div>
    </>
  );
}
