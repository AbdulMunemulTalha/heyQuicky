import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { PLATFORM_LABEL } from '../format.js';
import { ErrorText, FacebookButton, ImportStatus, WhatsAppButton, useConnect, useSocketEvent } from './common.jsx';

const STEPS = [
  ['business', 'Your business'],
  ['channels', 'Connect channels'],
  ['team', 'Your team'],
  ['done', 'Ready'],
];
const STEP_KEYS = STEPS.map(([key]) => key);

const CATEGORIES = [
  ['fashion', 'Fashion & clothing'], ['beauty', 'Cosmetics & beauty'], ['electronics', 'Electronics & gadgets'],
  ['food', 'Food & grocery'], ['home', 'Home & lifestyle'], ['kids', 'Kids & toys'], ['other', 'Something else'],
];

// Channels and team, kept fresh as imports progress in the background.
function useSetupData() {
  const [channels, setChannels] = useState(null);
  const [team, setTeam] = useState(null);
  const reload = useCallback(() => {
    api('/channels').then(setChannels).catch(() => {});
    api('/team').then(setTeam).catch(() => {});
  }, []);
  useEffect(reload, [reload]);
  useSocketEvent('channels', reload);
  return { channels, team, reload };
}

export function Onboarding({ me, setWorkspace, onFinish, onSignOut }) {
  const step = STEP_KEYS.includes(me.workspace.onboardingStep) ? me.workspace.onboardingStep : 'business';
  const data = useSetupData();
  const { result, resultVersion } = useConnect();
  const reloadData = data.reload;
  // A finished connection adds channels.
  useEffect(() => { if (resultVersion) reloadData(); }, [resultVersion, reloadData]);

  // Saves the step (and any fields) so a refresh or the Facebook redirect resumes here.
  async function goTo(next, fields = {}) {
    setWorkspace(await api('/workspace', { method: 'PATCH', body: { ...fields, onboardingStep: next } }));
    window.scrollTo(0, 0);
  }
  const go = (next) => () => goTo(next).catch((err) => alert(err.message));

  const index = STEP_KEYS.indexOf(step);
  return (
    <section className="onboarding">
      <header className="onb-header">
        <strong>Quicky</strong>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={onSignOut}>Sign out</button>
      </header>
      <div className="onb-wrap">
        <ol className="onb-steps">
          {STEPS.map(([key, label], i) => (
            <li key={key} className={`${i === index ? 'current' : ''} ${i < index ? 'complete' : ''}`}><span>{i + 1}</span> {label}</li>
          ))}
        </ol>
        {step === 'business' && <BusinessStep workspace={me.workspace} goTo={goTo} />}
        {step === 'channels' && <ChannelsStep connect={me.connect} channels={data.channels} result={result} go={go} />}
        {step === 'team' && <TeamStep team={data.team} reload={data.reload} go={go} />}
        {step === 'done' && <DoneStep workspace={me.workspace} channels={data.channels} team={data.team} go={go} onFinish={onFinish} />}
      </div>
    </section>
  );
}

function BusinessStep({ workspace: ws, goTo }) {
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    const f = e.target;
    setError('');
    try {
      await goTo('channels', {
        name: f.name.value,
        phone: f.phone.value,
        category: f.category.value,
        deliveryInsideDhaka: Number(f.deliveryInsideDhaka.value),
        deliveryOutsideDhaka: Number(f.deliveryOutsideDhaka.value),
      });
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <form className="onb-card" onSubmit={submit}>
      <h1>Tell us about your business</h1>
      <p className="muted">We use this to set up your inbox and order form. You can change it later in Settings.</p>
      <label className="field">Business name<input name="name" required maxLength={100} autoComplete="organization" defaultValue={ws.name} /></label>
      <label className="field">Business phone (optional)<input name="phone" inputMode="tel" placeholder="01XXXXXXXXX" defaultValue={ws.phone} /></label>
      <label className="field">What do you sell?
        <select name="category" required defaultValue={ws.category}>
          <option value="">Choose one</option>
          {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <div className="onb-two">
        <label className="field">Delivery inside Dhaka (৳)<input name="deliveryInsideDhaka" type="number" min="0" step="1" required defaultValue={ws.deliveryInsideDhaka} /></label>
        <label className="field">Delivery outside Dhaka (৳)<input name="deliveryOutsideDhaka" type="number" min="0" step="1" required defaultValue={ws.deliveryOutsideDhaka} /></label>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="onb-actions"><span className="spacer" /><button type="submit">Continue</button></div>
    </form>
  );
}

function ChannelsStep({ connect, channels, result, go }) {
  const { showResult } = useConnect();
  async function manualWhatsApp(e) {
    e.preventDefault();
    const body = { ...Object.fromEntries(new FormData(e.target)), platform: 'whatsapp' };
    try {
      const channel = await api('/channels', { method: 'POST', body });
      e.target.reset();
      showResult({ connected: [channel.name] });
    } catch (err) {
      showResult({ problems: [err.message] });
    }
  }
  const hasChannels = Boolean(channels?.length);
  return (
    <section className="onb-card">
      <h1>Connect where your customers message you</h1>
      <p className="muted">Messages from every account you connect arrive in one inbox, and your replies go back on the same app.</p>
      <div className="channel-cards">
        <div className="channel-card">
          <div><span className="badge messenger">Messenger</span> <span className="badge instagram">Instagram</span></div>
          <h3>Facebook Page &amp; Instagram</h3>
          <p className="muted small">Log in with the Facebook account that manages your Page. Instagram business accounts linked to the Page can be connected at the same time.</p>
          {connect.facebook
            ? <FacebookButton>Connect with Facebook</FacebookButton>
            : <p className="muted small">Facebook connection isn't set up on this server yet.</p>}
        </div>
        <div className="channel-card">
          <div><span className="badge whatsapp">WhatsApp</span></div>
          <h3>WhatsApp Business</h3>
          <p className="muted small">Already selling on the WhatsApp Business app? Connect that number: you can keep using the app
            on your phone, and your existing chats and contacts can come along.</p>
          {connect.whatsapp ? (
            <>
              <WhatsAppButton mode="app" className="brand-whatsapp">Connect my WhatsApp Business app</WhatsAppButton>
              <WhatsAppButton mode="new" className="link">Use a new number instead</WhatsAppButton>
            </>
          ) : <p className="muted small">WhatsApp sign-up isn't switched on yet. You can connect it later from Settings, or manually below.</p>}
          <details className="manual-connect">
            <summary className="muted small">Have a Phone number ID and access token? Connect manually</summary>
            <form className="inline-form" onSubmit={manualWhatsApp}>
              <input name="name" placeholder="Name, e.g. Shop WhatsApp" required />
              <input name="externalId" placeholder="Phone number ID" required inputMode="numeric" />
              <input name="accessToken" placeholder="Access token" required />
              <button>Connect</button>
            </form>
          </details>
        </div>
      </div>
      {result && <p className="notice">{result}</p>}
      <h3 className="onb-subhead">Connected</h3>
      <ul className="onb-list">
        {channels?.map((c) => (
          <li key={c.id}><span className={`badge ${c.platform}`}>{PLATFORM_LABEL[c.platform]}</span> {c.name}<ImportStatus channel={c} /></li>
        ))}
        {channels && !hasChannels && <li className="muted">Nothing connected yet.</li>}
      </ul>
      <div className="onb-actions">
        <button type="button" className="ghost" onClick={go('business')}>Back</button>
        <span className="spacer" />
        {hasChannels
          ? <button type="button" onClick={go('team')}>Continue</button>
          : <button type="button" className="link" onClick={go('team')}>Skip for now</button>}
      </div>
    </section>
  );
}

function TeamStep({ team, reload, go }) {
  const [error, setError] = useState('');
  // Passwords are shown once, right after a moderator is added.
  const [passwords, setPasswords] = useState({});
  const moderators = (team ?? []).filter((m) => m.role === 'moderator' && m.isActive);

  async function add(e) {
    e.preventDefault();
    setError('');
    try {
      const { user, password } = await api('/team', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      setPasswords((p) => ({ ...p, [user.id]: password }));
      e.target.reset();
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="onb-card">
      <h1>Add your moderators</h1>
      <p className="muted">Each new customer goes to one on-duty moderator, and comes back to the same moderator every time.
        Running the shop alone? Skip this, you can reply to everyone yourself.</p>
      <form className="inline-form" onSubmit={add}>
        <input name="name" placeholder="Moderator name" required />
        <input name="email" type="email" placeholder="Email they will log in with" required />
        <input name="password" placeholder="Password (optional)" />
        <button>Add</button>
      </form>
      <ErrorText>{error}</ErrorText>
      <ul className="onb-list">
        {moderators.map((m) => (
          <li key={m.id}>
            <strong>{m.name}</strong> · {m.email}
            {passwords[m.id] && <span className="muted"> · password: {passwords[m.id]}</span>}
          </li>
        ))}
        {team && !moderators.length && <li className="muted">No moderators yet.</li>}
      </ul>
      <div className="onb-actions">
        <button type="button" className="ghost" onClick={go('channels')}>Back</button>
        <span className="spacer" />
        <button type="button" onClick={go('done')}>{moderators.length ? 'Continue' : 'Skip for now'}</button>
      </div>
    </section>
  );
}

function DoneStep({ workspace: ws, channels = [], team = [], go, onFinish }) {
  const moderators = (team ?? []).filter((m) => m.role === 'moderator' && m.isActive);
  const list = channels ?? [];
  const importing = list.filter((c) => c.importStatus === 'running');
  const total = list.reduce((sum, c) => sum + c.conversationCount, 0);
  const items = [
    [true, `${ws.name}: delivery ৳${ws.deliveryInsideDhaka} inside Dhaka, ৳${ws.deliveryOutsideDhaka} outside`],
    [list.length > 0, list.length
      ? `Connected: ${list.map((c) => `${PLATFORM_LABEL[c.platform]} (${c.name})`).join(', ')}`
      : 'No channels connected yet: connect them in Settings → Connected channels'],
    [moderators.length > 0, moderators.length
      ? `${moderators.length} moderator${moderators.length > 1 ? 's' : ''}: ${moderators.map((m) => m.name).join(', ')}`
      : 'No moderators: you will answer every customer yourself'],
  ];
  if (importing.length) {
    items.push([false, `Bringing in your past chats from ${importing.map((c) => c.name).join(', ')}… ${total} so far. `
      + 'You can open your inbox now; they keep arriving in the background.']);
  } else if (total) {
    items.push([true, `${total} existing conversation${total === 1 ? '' : 's'} brought in. They are all in your inbox.`]);
  }

  return (
    <section className="onb-card">
      <h1>You're ready 🎉</h1>
      <p className="muted">Here's your setup. You can change any of it later in Settings.</p>
      <ul className="onb-checklist">
        {items.map(([ok, text]) => <li key={text} className={ok ? 'ok' : 'todo'}>{ok ? '✓' : '○'} {text}</li>)}
      </ul>
      <div className="onb-tips">
        <strong>Tips for your first day</strong>
        <ul>
          <li>Switch <strong>On duty</strong> at the top when you start answering; customers wait in <strong>Unassigned</strong> when nobody is on duty.</li>
          <li>Add <strong>saved replies</strong> for price, delivery charge and bKash steps in Settings, then type <code>/</code> in the reply box.</li>
          <li>Click <strong>New order</strong> in a chat to take an order and send the customer a summary.</li>
        </ul>
      </div>
      <div className="onb-actions">
        <button type="button" className="ghost" onClick={go('team')}>Back</button>
        <span className="spacer" />
        <button type="button" onClick={onFinish}>Open my inbox</button>
      </div>
    </section>
  );
}
