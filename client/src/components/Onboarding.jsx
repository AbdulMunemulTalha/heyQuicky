import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { PLATFORM_LABEL } from '../format.js';
import { ErrorText, FacebookButton, ImportStatus, WhatsAppButton, useConnect, useSocketEvent } from './common.jsx';

// The ten setup steps. 'account' is the sign-up form; the rest are saved as the workspace's onboardingStep.
export const STEPS = [
  { key: 'account', label: 'Create your account', min: 1 },
  { key: 'channels', label: 'Connect channels', min: 1 },
  { key: 'business', label: 'Business type', min: 1 },
  { key: 'shop', label: 'Shop & delivery', min: 1 },
  { key: 'assistant', label: 'Your AI assistant', min: 1 },
  { key: 'products', label: 'Products', min: 2 },
  { key: 'payments', label: 'Courier & payments', min: 1 },
  { key: 'team', label: 'Team & alerts', min: 1 },
  { key: 'test', label: 'Test it', min: 2 },
  { key: 'live', label: 'Go live', min: 1 },
];
const KEYS = STEPS.map((s) => s.key);
export const stepIndex = (key) => Math.max(1, KEYS.indexOf(key));

// ---------- Shared pieces ----------

function Chips({ options, value, onChange, multi = false }) {
  const selected = (v) => (multi ? value.includes(v) : value === v);
  const toggle = (v) => {
    if (!multi) return onChange(v);
    return onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };
  return (
    <div className="chips" role={multi ? 'group' : 'radiogroup'}>
      {options.map(([v, label]) => (
        <button key={v} type="button" className={`chip${selected(v) ? ' on' : ''}`} aria-pressed={selected(v)} onClick={() => toggle(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="check-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Soon({ children = 'Coming soon' }) {
  return <span className="soon">{children}</span>;
}

// Sidebar, step header and the page frame every step shares.
export function OnboardingShell({ current, onGo, onSaveExit, onSignOut, support, children }) {
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
            const clickable = onGo && i < index && i > 0;
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

function StepHead({ title, children }) {
  return (
    <header className="onb-head">
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </header>
  );
}

function Actions({ onBack, onSkip, next = 'Continue', busy, disabled, onNext, type = 'button' }) {
  return (
    <div className="onb-actions">
      {onBack && <button type="button" className="ghost" onClick={onBack}>Back</button>}
      <span className="spacer" />
      {onSkip && <button type="button" className="link" onClick={onSkip}>Skip for now</button>}
      <button type={type} className="primary" disabled={busy || disabled} onClick={onNext}>{busy ? 'Saving…' : next}</button>
    </div>
  );
}

// ---------- Step 1: account (signed out) ----------

const SURVEY = [
  ['messages_per_day', 'Messages a day across all pages', [['under_50', 'Under 50'], ['50_200', '50–200'], ['200_1000', '200–1,000'], ['1000_plus', '1,000+']]],
  ['team_size', 'Who answers messages now?', [['just_me', 'Just me'], ['1_2', '1–2 people'], ['3_plus', '3+ people']]],
  ['ad_spend', 'Monthly Facebook ad spend', [['none', 'None'], ['under_20k', 'Under ৳20k'], ['20k_1lakh', '৳20k–1 lakh'], ['1lakh_plus', '1 lakh+']]],
];

export function SignupStep({ onSubmit, onLogin, support }) {
  const [survey, setSurvey] = useState({ messages_per_day: '50_200', team_size: 'just_me', ad_spend: 'none' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const f = Object.fromEntries(new FormData(e.target));
      await onSubmit({ name: f.name, businessName: f.businessName, email: f.email, phone: f.phone, password: f.password, survey });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <OnboardingShell current="account" support={support}>
      <StepHead title="Start free — no card needed">
        Tell us a little about your shop. It takes a minute, and you can test everything before a single customer sees it.
      </StepHead>
      <div className="onb-split">
        <form className="onb-card" onSubmit={submit}>
          <div className="grid2">
            <label className="field">Your name<input name="name" required autoComplete="name" maxLength={80} /></label>
            <label className="field">Shop or page name<input name="businessName" required autoComplete="organization" maxLength={100} /></label>
            <label className="field">Email<input name="email" type="email" required autoComplete="email" placeholder="you@shop.com" /></label>
            <label className="field">Mobile<input name="phone" inputMode="tel" autoComplete="tel" placeholder="01XXX-XXXXXX" />
              <small className="muted">If you get stuck, we'll call you on this number.</small></label>
            <label className="field wide">Password<input name="password" type="password" required minLength={8} autoComplete="new-password" placeholder="At least 8 characters" /></label>
          </div>
          {SURVEY.map(([key, label, options]) => (
            <div className="field" key={key}>
              <span>{label}</span>
              <Chips options={options} value={survey[key]} onChange={(v) => setSurvey((s) => ({ ...s, [key]: v }))} />
            </div>
          ))}
          <p className="muted small">By continuing you agree to the <a href="/terms" target="_blank" rel="noreferrer">Terms</a> and <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.</p>
          <ErrorText>{error}</ErrorText>
          <div className="onb-actions">
            <span className="muted">Already have an account? <button type="button" className="link" onClick={onLogin}>Log in</button></span>
            <span className="spacer" />
            <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
          </div>
        </form>
        <aside className="onb-dark">
          <h3>Live in about 10 minutes</h3>
          <ol>
            <li>Connect your page with Facebook's official login</li>
            <li>Tell us what you sell — we set up the rest</li>
            <li>Test the AI in practice mode</li>
            <li>Go live when you're happy</li>
          </ol>
          <p>No card needed. Nothing reaches your customers until you go live.</p>
        </aside>
      </div>
    </OnboardingShell>
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

const practiceKey = (wsId) => `quicky:practice:${wsId}`;

export function Onboarding({ me, setWorkspace, onFinish, onSaveExit, onSignOut }) {
  const step = KEYS.includes(me.workspace.onboardingStep) && me.workspace.onboardingStep !== 'account' ? me.workspace.onboardingStep : 'channels';
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
  const back = prev && prev !== 'account' ? () => go(prev) : null;
  const props = { ws: me.workspace, me, data, save, go, back };

  return (
    <OnboardingShell current={step} onGo={go} onSaveExit={onSaveExit} onSignOut={onSignOut} support={me.support}>
      {step === 'channels' && <ChannelsStep {...props} />}
      {step === 'business' && <BusinessStep {...props} />}
      {step === 'shop' && <ShopStep {...props} />}
      {step === 'assistant' && <AssistantStep {...props} />}
      {step === 'products' && <ProductsStep {...props} />}
      {step === 'payments' && <PaymentsStep {...props} />}
      {step === 'team' && <TeamStep {...props} />}
      {step === 'test' && <TestStep {...props} />}
      {step === 'live' && <LiveStep {...props} onFinish={onFinish} />}
    </OnboardingShell>
  );
}

// Runs a save with a busy flag and an error message.
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

// ---------- Step 2: channels ----------

const CHANNEL_HINT = {
  messenger: 'Private messages to your Facebook page',
  instagram: 'Instagram direct messages',
  whatsapp: 'Your WhatsApp Business number',
};

function ChannelsStep({ me, data, go, back }) {
  const { result, showResult } = useConnect();
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
      <div className="onb-card">
        <div className="connect-row">
          <span className="ch-ico fb">f</span>
          <div className="grow"><b>Facebook Page &amp; Instagram</b><small>Log in with the Facebook account that manages your page.</small></div>
          {facebook ? <FacebookButton className="primary">{channels.some((c) => c.platform !== 'whatsapp') ? 'Connect more' : 'Connect with Facebook'}</FacebookButton>
            : <Soon>Not set up on this server</Soon>}
        </div>
        <div className="connect-row">
          <span className="ch-ico wa">WA</span>
          <div className="grow"><b>WhatsApp Business</b><small>Keep using the WhatsApp Business app on your phone; your chats can come along.</small></div>
          {whatsapp ? (
            <span className="row-actions">
              <WhatsAppButton mode="app" className="ghost">Connect my number</WhatsAppButton>
              <WhatsAppButton mode="new" className="link">Use a new number</WhatsAppButton>
            </span>
          ) : <Soon>Not set up on this server</Soon>}
        </div>
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
      <Actions onBack={back} onSkip={channels.length ? null : () => go('business')} onNext={() => go('business')} disabled={!channels.length} />
    </>
  );
}

// ---------- Step 3: business type ----------

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

function BusinessStep({ ws, save, back }) {
  const initialCategory = OLD_CATEGORY[ws.category] ?? (FIELDS[ws.category] ? ws.category : '');
  const [category, setCategory] = useState(initialCategory);
  const [fields, setFields] = useState(() => (ws.orderFields?.length && initialCategory
    ? ws.orderFields.map((f) => ({ ...f, on: true }))
    : initialCategory ? fieldsFor(initialCategory) : []));
  const [custom, setCustom] = useState('');
  const { busy, error, run } = useSubmit();

  function pick(c) {
    setCategory(c);
    setFields(fieldsFor(c));
  }
  function addCustom(e) {
    e.preventDefault();
    const label = custom.trim();
    if (!label) return;
    setFields((f) => [...f, { label, hint: '', on: true }]);
    setCustom('');
  }
  const label = CATEGORIES.find(([v]) => v === category)?.[1];

  return (
    <>
      <StepHead title="What do you sell?">Pick the closest match. We'll set up the order questions your customers usually need to answer.</StepHead>
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
              <form className="add-field" onSubmit={addCustom}>
                <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Add your own question" maxLength={40} />
                <button type="submit" className="ghost">Add</button>
              </form>
              <small className="muted">The AI asks for these, with name, phone and address, before handing an order to your team. You can change them any time.</small>
            </>
          ) : <p className="muted">Pick a category to see the order questions we'll set up.</p>}
        </aside>
      </div>
      <ErrorText>{error}</ErrorText>
      <Actions onBack={back} busy={busy} disabled={!category}
        onNext={() => run(() => save({ category, orderFields: fields.filter((f) => f.on).map(({ label: l, hint }) => ({ label: l, hint })) }, 'shop'))} />
    </>
  );
}

// ---------- Step 4: shop & delivery ----------

function ShopStep({ ws, save, back }) {
  const [form, setForm] = useState({
    address: ws.address, phone: ws.phone, sellsOffline: ws.sellsOffline,
    audience: ws.audience?.length ? ws.audience : [],
    deliveryInsideDhaka: ws.deliveryInsideDhaka, deliveryInsideDays: ws.deliveryInsideDays || '1–2',
    deliveryOutsideDhaka: ws.deliveryOutsideDhaka, deliveryOutsideDays: ws.deliveryOutsideDays || '2–3',
    cashOnDelivery: ws.cashOnDelivery, freeDelivery: Boolean(ws.freeDeliveryOver), freeDeliveryOver: ws.freeDeliveryOver || 3000,
  });
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value?.target ? value.target.value : value }));
  const { busy, error, run } = useSubmit();

  function submit(e) {
    e.preventDefault();
    const { freeDelivery, ...rest } = form;
    run(() => save({
      ...rest,
      deliveryInsideDhaka: Number(form.deliveryInsideDhaka),
      deliveryOutsideDhaka: Number(form.deliveryOutsideDhaka),
      freeDeliveryOver: freeDelivery ? Number(form.freeDeliveryOver) : null,
    }, 'assistant'));
  }

  return (
    <form onSubmit={submit}>
      <StepHead title="Your shop and delivery">The AI uses this to quote delivery charges and dates correctly in every order.</StepHead>
      <div className="onb-card">
        <b className="card-title">Your shop</b>
        <div className="grid2">
          <label className="field">Area / pickup address<input value={form.address} onChange={set('address')} placeholder="e.g. Mirpur 10, Dhaka" maxLength={200} /></label>
          <label className="field">Customer support number<input value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="01XXX-XXXXXX" /></label>
        </div>
        <div className="field"><span>Where do you sell?</span>
          <Chips options={[[false, 'Online only'], [true, 'Online + physical shop']]} value={form.sellsOffline} onChange={set('sellsOffline')} /></div>
        <div className="field"><span>Who do you sell to?</span>
          <Chips multi options={[['women', 'Women'], ['girls', 'Girls'], ['men', 'Men'], ['kids', 'Kids'], ['everyone', 'Everyone']]} value={form.audience} onChange={set('audience')} /></div>
      </div>
      <div className="onb-card">
        <b className="card-title">Delivery</b>
        <div className="grid2">
          <fieldset className="zone"><legend>Inside Dhaka</legend>
            <label className="field">Charge (৳)<input type="number" min="0" step="1" required value={form.deliveryInsideDhaka} onChange={set('deliveryInsideDhaka')} /></label>
            <label className="field">Days<input value={form.deliveryInsideDays} onChange={set('deliveryInsideDays')} maxLength={20} /></label>
          </fieldset>
          <fieldset className="zone"><legend>Outside Dhaka</legend>
            <label className="field">Charge (৳)<input type="number" min="0" step="1" required value={form.deliveryOutsideDhaka} onChange={set('deliveryOutsideDhaka')} /></label>
            <label className="field">Days<input value={form.deliveryOutsideDays} onChange={set('deliveryOutsideDays')} maxLength={20} /></label>
          </fieldset>
        </div>
        <Toggle label="Accept cash on delivery" checked={form.cashOnDelivery} onChange={set('cashOnDelivery')} />
        <div className="check-row">
          <span>Free delivery on orders over ৳
            <input className="inline-num" type="number" min="1" step="1" value={form.freeDeliveryOver} disabled={!form.freeDelivery} onChange={set('freeDeliveryOver')} aria-label="Free delivery amount" /></span>
          <input type="checkbox" checked={form.freeDelivery} onChange={(e) => set('freeDelivery')(e.target.checked)} aria-label="Offer free delivery" />
        </div>
      </div>
      <ErrorText>{error}</ErrorText>
      <Actions onBack={back} busy={busy} type="submit" />
    </form>
  );
}

// ---------- Step 5: AI assistant ----------

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

function AssistantStep({ ws, save, back }) {
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
      <Actions onBack={back} busy={busy} next="Looks good" disabled={!name.trim()}
        onNext={() => run(() => save({ aiName: name.trim(), aiStyle: style, aiAddress: address, aiSales: sales }, 'products'))} />
    </>
  );
}

// ---------- Step 6: products ----------

function ProductsStep({ data, go, back }) {
  const [method, setMethod] = useState('hand');
  const [message, setMessage] = useState('');
  const { busy, error, run, setError } = useSubmit();
  const products = data.products ?? [];
  const fileRef = useRef(null);

  function report({ added, skipped }) {
    const head = `Added ${added} product${added === 1 ? '' : 's'}.`;
    const tail = skipped.length
      ? ` Skipped ${skipped.length}: ${skipped.slice(0, 3).map((s) => `line ${s.line} (${s.reason})`).join(', ')}${skipped.length > 3 ? '…' : ''}`
      : '';
    setMessage(head + tail);
    data.reload();
  }

  const importSheet = (e) => {
    e.preventDefault();
    const sheetUrl = new FormData(e.target).get('sheetUrl');
    run(async () => { report(await api('/products/import', { method: 'POST', body: { sheetUrl } })); e.target.reset(); });
  };
  const importCsv = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) { setError('That file is too big (2 MB at most).'); return; }
    if (!/\.csv$/i.test(file.name)) { setError('Choose a .csv file. In Excel: File → Save As → CSV.'); return; }
    run(async () => { report(await api('/products/import', { method: 'POST', body: { csv: await file.text() } })); });
    e.target.value = '';
  };
  const addOne = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    run(async () => {
      await api('/products', { method: 'POST', body: { name: f.name, price: Number(f.price), variants: f.variants } });
      e.target.reset();
      e.target.name.focus();
      setMessage('');
      data.reload();
    });
  };
  async function remove(p) {
    await api(`/products/${p.id}`, { method: 'DELETE' }).catch((err) => alert(err.message));
    data.reload();
  }

  const methods = [
    ['sheet', 'Google Sheet', 'Paste a link. We read the Name and Price columns.'],
    ['csv', 'CSV or Excel', 'Upload a .csv file (Excel: Save As → CSV).'],
    ['shop', 'WooCommerce / Shopify', 'Products, stock and orders stay in sync.', true],
    ['facebook', 'From my Facebook posts', 'The AI reads your posts and drafts the catalog for you to check.', true],
    ['hand', 'Add by hand', 'Start with your top 10 sellers.'],
  ];

  return (
    <>
      <StepHead title="Add your products">The AI only offers what's in your catalog, with real prices and stock. Bring them in any way you like.</StepHead>
      <div className="method-grid">
        {methods.map(([key, title, hint, soon]) => (
          <button type="button" key={key} disabled={soon} className={`method${method === key ? ' on' : ''}`} onClick={() => setMethod(key)}>
            <b>{title}</b><small>{hint}</small>{soon && <Soon />}
          </button>
        ))}
      </div>
      <div className="onb-card">
        {method === 'sheet' && (
          <form className="inline-form" onSubmit={importSheet}>
            <input name="sheetUrl" required placeholder="https://docs.google.com/spreadsheets/d/…" />
            <button type="submit" disabled={busy}>{busy ? 'Importing…' : 'Import'}</button>
            <small className="muted wide">In the sheet: Share → General access → "Anyone with the link" (Viewer). Columns: Name, Price, and optionally Options/Size, Description, Stock.</small>
          </form>
        )}
        {method === 'csv' && (
          <div className="inline-form">
            <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={importCsv} hidden />
            <button type="button" onClick={() => fileRef.current.click()} disabled={busy}>{busy ? 'Importing…' : 'Choose CSV file'}</button>
            <small className="muted">First row: Name, Price, and optionally Options/Size, Description, Stock. Up to 500 products at once.</small>
          </div>
        )}
        {method === 'hand' && (
          <form className="inline-form" onSubmit={addOne}>
            <input name="name" required maxLength={120} placeholder="Product name, e.g. Red kurti" />
            <input name="price" required type="number" min="0" step="1" placeholder="Price (৳)" style={{ maxWidth: 130 }} />
            <input name="variants" maxLength={300} placeholder="Options, e.g. M, L, XL" />
            <button type="submit" disabled={busy}>Add</button>
          </form>
        )}
        {message && <p className="ok-text small">{message}</p>}
        <ErrorText>{error}</ErrorText>
      </div>

      <div className="onb-card">
        <div className="card-title-row"><b>Your catalog</b><span className="muted">{products.length} product{products.length === 1 ? '' : 's'}</span></div>
        {products.length ? (
          <table className="table">
            <tbody>
              {products.slice(0, 50).map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="num">৳{p.price.toLocaleString('en-IN')}</td>
                  <td className="muted">{p.variants}</td>
                  <td className="muted">{p.inStock ? 'In stock' : 'Out of stock'}</td>
                  <td><button type="button" className="link" onClick={() => remove(p)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted empty">No products yet. Without them, the AI won't quote any prices.</p>}
        {products.length > 50 && <p className="muted small">Showing 50 of {products.length}. See them all in Settings.</p>}
      </div>
      <Actions onBack={back} onSkip={products.length ? null : () => go('payments')} disabled={!products.length} onNext={() => go('payments')} />
    </>
  );
}

// ---------- Step 7: courier & payments ----------

function PaymentsStep({ ws, save, go, back }) {
  const [bkash, setBkash] = useState(ws.bkashNumber);
  const [nagad, setNagad] = useState(ws.nagadNumber);
  const { busy, error, run } = useSubmit();
  return (
    <>
      <StepHead title="Courier and payments">Add numbers for advance payments. You can skip this and do it later in Settings.</StepHead>
      <div className="grid2">
        {[['Steadfast', 'Book parcels automatically when an order is approved.'], ['Pathao', 'Book with your Pathao merchant account.']].map(([name, hint]) => (
          <div className="onb-card courier" key={name}>
            <div className="card-title-row"><b>{name}</b><Soon /></div>
            <small className="muted">{hint} Courier booking is on its way; we'll let you know when you can connect.</small>
          </div>
        ))}
      </div>
      <div className="onb-card">
        <b className="card-title">Advance payments</b>
        <div className="grid2">
          <label className="field">bKash number<input value={bkash} onChange={(e) => setBkash(e.target.value)} inputMode="tel" placeholder="01XXX-XXXXXX" /></label>
          <label className="field">Nagad number<input value={nagad} onChange={(e) => setNagad(e.target.value)} inputMode="tel" placeholder="Optional" /></label>
        </div>
        <small className="muted">The AI shares these only when a customer wants to pay in advance. When someone says they've paid, the chat goes to your team to check.</small>
      </div>
      <ErrorText>{error}</ErrorText>
      <Actions onBack={back} onSkip={() => go('team')} busy={busy}
        onNext={() => run(() => save({ bkashNumber: bkash, nagadNumber: nagad }, 'team'))} />
    </>
  );
}

// ---------- Step 8: team & alerts ----------

function TeamStep({ data, go, back }) {
  const { busy, error, run } = useSubmit();
  const [passwords, setPasswords] = useState({});
  const moderators = (data.team ?? []).filter((m) => m.role === 'moderator' && m.isActive);

  const add = (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    run(async () => {
      const { user, password } = await api('/team', { method: 'POST', body });
      setPasswords((p) => ({ ...p, [user.id]: password }));
      e.target.reset();
      data.reload();
    });
  };

  return (
    <>
      <StepHead title="Your team and alerts">Invite teammates for free. Each new customer goes to one on-duty moderator, and comes back to the same one.</StepHead>
      <div className="onb-split">
        <div className="onb-card">
          <div className="card-title-row"><b>Invite your team</b><span className="tag">Unlimited · free</span></div>
          <form className="inline-form" onSubmit={add}>
            <input name="name" required placeholder="Name" maxLength={80} />
            <input name="email" type="email" required placeholder="Email they'll log in with" />
            <button type="submit" disabled={busy}>Add</button>
          </form>
          <ErrorText>{error}</ErrorText>
          <ul className="onb-list">
            {moderators.map((m) => (
              <li key={m.id}><b>{m.name}</b> · {m.email}
                {passwords[m.id] && <span className="muted"> · password: <code>{passwords[m.id]}</code> (share it with them; shown once)</span>}</li>
            ))}
            {data.team && !moderators.length && <li className="muted">Running the shop alone? Skip this; you can add people later.</li>}
          </ul>
        </div>
        <aside className="onb-card side-panel">
          <b>When a person is needed</b>
          <div className="check-row"><span>Shown in your inbox with the reason</span><input type="checkbox" checked readOnly /></div>
          <div className="check-row soon-row"><span>Phone notifications</span><Soon /></div>
          <div className="check-row soon-row"><span>WhatsApp alert to your number</span><Soon /></div>
          <div className="check-row soon-row"><span>Daily summary by email</span><Soon /></div>
        </aside>
      </div>
      <Actions onBack={back} onSkip={moderators.length ? null : () => go('test')} onNext={() => go('test')} disabled={!moderators.length} />
    </>
  );
}

// ---------- Step 9: test it ----------

const PROMPTS = [
  ['Ask the price', 'Apnader best seller tar dam koto?'],
  ['Ask the delivery charge', 'Dhakar baire delivery charge koto? Koydin lagbe?'],
  ['Place an order', 'Ami order korte chai. Nusrat Jahan, 01811223344, House 12 Road 5 Dhanmondi'],
  ['Complain', 'Amar parcel ta chera eseche, taka ferot chai'],
];
export const CHECKS = [
  ['price', 'Answered a price question', (a) => ['price', 'stock', 'product_info'].includes(a.intent)],
  ['delivery', 'Quoted the delivery charge', (a) => a.intent === 'delivery'],
  ['order', 'Took a test order', (a) => a.intent === 'order'],
  ['complaint', 'Handed a complaint to you', (a) => a.intent === 'complaint' && a.handoff],
];

function TestStep({ ws, me, go, back }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [passed, setPassed] = useState(() => JSON.parse(localStorage.getItem(practiceKey(ws.id)) || '[]'));
  const endRef = useRef(null);
  const available = me.ai.available;

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages]);
  useEffect(() => { localStorage.setItem(practiceKey(ws.id), JSON.stringify(passed)); }, [passed, ws.id]);

  async function send(content) {
    const value = content.trim();
    if (!value || busy) return;
    const next = [...messages, { role: 'user', content: value }];
    setMessages(next);
    setText('');
    setBusy(true);
    setError('');
    try {
      const answer = await api('/ai/practice', { method: 'POST', body: { messages: next.filter((m) => m.role !== 'note').map(({ role, content: c }) => ({ role, content: c })) } });
      setMessages((m) => [...m,
        ...(answer.reply ? [{ role: 'assistant', content: answer.reply }] : []),
        ...(answer.handoff ? [{ role: 'note', content: `Handed to your team: ${answer.handoff_reason || 'needs a person'}` }] : [])]);
      const hits = CHECKS.filter(([, , test]) => test(answer)).map(([key]) => key);
      if (hits.length) setPassed((p) => [...new Set([...p, ...hits])]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <StepHead title="Test it like a customer">You're in practice mode: only you see these replies, and nothing goes to Meta. Try a few real situations before going live.</StepHead>
      {!available && (
        <p className="notice rounded">AI replies aren't switched on for this server yet (it needs an ANTHROPIC_API_KEY). You can finish setup now and test here later from Settings.</p>
      )}
      <div className="onb-split">
        <div className="onb-card chat-test">
          <div className="card-title-row"><b>Chat as a customer</b><span className="tag warn-tag">Practice mode · nothing is sent</span></div>
          <div className="test-msgs">
            {messages.map((m, i) => (
              m.role === 'note' ? <p key={i} className="test-note">{m.content}</p>
                : <p key={i} className={m.role === 'user' ? 'b-out' : 'b-in'}>{m.content}</p>
            ))}
            {busy && <p className="b-in typing">{ws.aiName || 'AI'} is typing…</p>}
            {!messages.length && <p className="muted empty">Write like a customer would, in Bangla, Banglish or English.</p>}
            <span ref={endRef} />
          </div>
          <div className="chips try">
            <span className="muted small">Try:</span>
            {PROMPTS.map(([label, sample]) => (
              <button key={label} type="button" className="chip small" disabled={!available || busy} onClick={() => send(sample)}>{label}</button>
            ))}
          </div>
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type like a customer…" disabled={!available} maxLength={1000} />
            <button type="submit" disabled={!available || busy || !text.trim()}>Send</button>
            {messages.length > 0 && <button type="button" className="ghost" onClick={() => setMessages([])}>Start over</button>}
          </form>
          <ErrorText>{error}</ErrorText>
        </div>
        <aside className="onb-card side-panel">
          <div className="card-title-row"><b>Checks</b><span className="ok-text small">{passed.length} of {CHECKS.length} passed</span></div>
          {CHECKS.map(([key, label]) => (
            <div key={key} className={`check-item${passed.includes(key) ? ' ok' : ''}`}><span className="tick">{passed.includes(key) ? '✓' : ''}</span>{label}</div>
          ))}
          <small className="muted">Something wrong? Add it to "About your shop" or your products in Settings, and the AI uses it from the next reply.</small>
        </aside>
      </div>
      <Actions onBack={back} next={passed.length ? 'Everything works' : 'Continue'} onNext={() => go('live')} />
    </>
  );
}

// ---------- Step 10: go live ----------

const STYLE_LABEL = Object.fromEntries(STYLES);

function LiveStep({ ws, me, data, save, back, onFinish }) {
  const { busy, error, run } = useSubmit();
  const channels = data.channels ?? [];
  const aiChannels = channels.filter((c) => c.aiEnabled);
  const moderators = (data.team ?? []).filter((m) => m.isActive);
  const passed = JSON.parse(localStorage.getItem(practiceKey(ws.id)) || '[]').length;
  const finish = (aiMode) => run(async () => {
    await save({ aiMode }, 'done');
    localStorage.removeItem(practiceKey(ws.id));
    onFinish();
  });
  const summary = [
    ['Channels', aiChannels.length ? aiChannels.map((c) => `${PLATFORM_LABEL[c.platform]} · ${c.name}`).join(', ') : 'None yet: connect in Settings'],
    ['Assistant', `${ws.aiName || 'Unnamed'} · ${STYLE_LABEL[ws.aiStyle] ?? ''}`],
    ['Catalog', `${(data.products ?? []).length} product${(data.products ?? []).length === 1 ? '' : 's'}`],
    ['Delivery', `৳${ws.deliveryInsideDhaka} / ৳${ws.deliveryOutsideDhaka}${ws.cashOnDelivery ? ' · COD' : ''}`],
    ['Team', moderators.map((m) => m.name).join(', ') || 'Just you'],
    ['Tests passed', `${passed} of ${CHECKS.length}`],
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
          <small className="muted">You can switch the AI off for any channel, or go back to drafts only, any time in Settings.</small>
        </div>
        <aside className="onb-dark">
          <h3>Let Quicky answer tonight's messages.</h3>
          <p>{me.ai.available
            ? 'Live: the AI replies to customers itself and hands orders, payments and complaints to your team.'
            : 'The AI starts replying as soon as AI is switched on for this server. Everything else works now.'}</p>
          <button type="button" className="yellow" disabled={busy} onClick={() => finish('auto')}>Go live now</button>
          <button type="button" className="dark-ghost" disabled={busy} onClick={() => finish('suggest')}>Stay in practice mode</button>
          <small>Practice mode: the AI only drafts replies; your team checks and sends them.</small>
        </aside>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="onb-actions">{back && <button type="button" className="ghost" onClick={back}>Back</button>}</div>
    </>
  );
}
