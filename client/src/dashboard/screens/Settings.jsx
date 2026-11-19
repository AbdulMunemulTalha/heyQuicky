import { useCallback, useContext, useEffect, useState } from 'react';
import { dash, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { Link } from '../lib/router.jsx';
import { ConnectContext } from '../../components/common.jsx';
import { Button, Card, Checkbox, ErrorState, Modal, Pill, Skeleton, Toggle, toast } from '../ui/kit.jsx';
import './settings.css';

const TABS = [['billing', '/settings'], ['channels', '/settings/channels'], ['courier', '/settings/courier'], ['payments', '/settings/payments'], ['team', '/settings/team']];
const tabOf = (path) => (TABS.find(([, to]) => to !== '/settings' && path.startsWith(to)) ?? TABS[0])[0];
const digitsOnly = (s) => String(s ?? '').replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d)).replace(/[^\d.]/g, '');

// Screen 10: Settings & billing — Billing & AI credit, Channels, Delivery & courier, Payments, Team.
export default function Settings({ path }) {
  const t = useT();
  const tab = tabOf(path);
  const Body = { billing: Billing, channels: Channels, courier: Delivery, payments: Payments, team: Team }[tab];
  return (
    <div className="settings">
      <header className="page-head"><div><h1>{t('set.title')}</h1></div></header>
      <div className="set-layout">
        <nav className="set-tabs" aria-label={t('set.title')}>
          {TABS.map(([key, to]) => <Link key={key} to={to} className={`set-tab${tab === key ? ' on' : ''}`} aria-current={tab === key ? 'page' : undefined}>{t(`set.tab.${key}`)}</Link>)}
        </nav>
        <div className="set-body"><Body t={t} /></div>
      </div>
    </div>
  );
}

function useData(path) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => dash(path).then(setD, setError), [path]);
  useEffect(() => { load(); }, [load]);
  return { d, setD, error, load };
}

// ---------- Billing & AI credit ----------
function Billing({ t }) {
  const { can } = useDash();
  const { d, error, load } = useData('/settings/billing');
  const [topup, setTopup] = useState(null);
  if (!can('billing')) return <Card><ErrorState thing={t('set.billingThing')} error={{ status: 403 }} /></Card>;
  if (error) return <ErrorState thing={t('set.tab.billing')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={420} r={12} />;
  const m = d.topup.methods;
  return (
    <div className="set-col">
      <div className="set-billing-top">
        <section className="set-balance">
          <span className="small">{t('set.balance')}</span>
          <strong>{t.money(d.balance, 2)}</strong>
          <p className="small">{d.repliesLeft === null ? t('set.freeNote') : t('set.repliesLeft', { n: t.num(d.repliesLeft) })}</p>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn set-bkash" disabled={!m.bkash} title={m.bkash ? undefined : t('set.methodSoon')} onClick={() => setTopup('bkash')}>{t('set.topupBkash')}</button>
            <button type="button" className="btn set-dark-btn" disabled={!m.nagad} title={m.nagad ? undefined : t('set.methodSoon')} onClick={() => setTopup('nagad')}>{t('set.nagad')}</button>
            <button type="button" className="btn set-dark-btn" disabled title={t('set.cardSoon')}>{t('set.card')}</button>
          </div>
          {!m.bkash && !m.nagad && <p className="small set-soon">{d.topup.support ? t('set.topupSupport', { n: d.topup.support }) : t('set.topupNone')}</p>}
          {d.pending.length > 0 && (
            <ul className="set-pending">{d.pending.map((p) => <li key={p.id} className="small">{t('set.pendingLine', { m: t.money(p.amount), by: t(`set.method.${p.method}`), trx: p.trxId })}</li>)}</ul>
          )}
        </section>
        <Card title={t('set.month')} className="set-month">
          <dl className="set-dl">
            <div><dt>{t('set.aiReplies', { n: t.num(d.month.aiReplies) })}</dt><dd>{t.money(d.month.aiCost, 2)}</dd></div>
            <div><dt>{t('set.savedReplies', { n: t.num(d.month.savedReplies) })}</dt><dd className="ok">{t('set.free')}</dd></div>
            <div><dt>{t('set.cache')}</dt><dd className="ok">−{t.money(d.month.cacheSavings, 2)}</dd></div>
          </dl>
          <Caps t={t} caps={d.caps} />
        </Card>
      </div>
      <Card title={t('set.costs')} action={<Button size="sm" onClick={() => downloadCsv('/settings/billing/replies.csv', 'heyquicky-ai-replies.csv', t)}>{t('set.downloadCsv')}</Button>}>
        {d.replies.length === 0 ? <p className="small muted">{t('set.noReplies')}</p> : (
          <table className="set-table">
            <thead><tr><th>{t('set.col.time')}</th><th>{t('set.col.customer')}</th><th>{t('set.col.what')}</th><th className="r">{t('set.col.cost')}</th></tr></thead>
            <tbody>{d.replies.map((r) => (
              <tr key={r.id}><td className="muted">{t.time(r.at)}</td><td>{r.customer || '—'}</td><td>{r.summary || '—'}</td>
                <td className="r">{r.cost > 0 ? <strong>{t.money(r.cost, 2)}</strong> : <span className="ok">{t('set.free')}</span>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {topup && <TopupDialog t={t} method={topup} number={m[topup]} min={d.topup.min} max={d.topup.max} onClose={() => setTopup(null)} onDone={() => { setTopup(null); load(); }} />}
    </div>
  );
}

function Caps({ t, caps }) {
  const [v, setV] = useState({ monthly: caps.monthly ?? '', alertBelow: caps.alertBelow ?? '' });
  async function save(key) {
    if (String(v[key]) === String(key === 'monthly' ? caps.monthly ?? '' : caps.alertBelow ?? '')) return;
    try { await dash('/settings/billing/caps', { method: 'PATCH', body: { [key]: v[key] === '' ? null : v[key] } }); toast(t('common.saved'), 'green'); } catch (e) { toast(e.message, 'red'); }
  }
  return (
    <div className="set-caps">
      {[['monthly', 'set.cap'], ['alertBelow', 'set.alert']].map(([k, label]) => (
        <label key={k} className="row"><span className="grow small">{t(label)}</span>
          <span className="set-money"><span>৳</span><input inputMode="decimal" value={v[k]} onChange={(e) => setV((x) => ({ ...x, [k]: digitsOnly(e.target.value) }))} onBlur={() => save(k)} aria-label={t(label)} /></span>
        </label>
      ))}
      <p className="small faint">{t('set.capsNote')}</p>
    </div>
  );
}

function TopupDialog({ t, method, number, min, max, onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [trx, setTrx] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function send() {
    setBusy(true);
    setErr('');
    try {
      await dash('/settings/billing/topup', { method: 'POST', body: { method, amount, trxId: trx } });
      toast(t('set.topupSent'), 'green');
      onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={t('set.topupTitle', { m: t(`set.method.${method}`) })} subtitle={t('set.topupSub')} onClose={onClose} width={440}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!amount || !trx.trim()} onClick={send}>{t('set.topupSend')}</Button></>}>
      <ol className="set-steps">
        <li>{t('set.step1', { m: t(`set.method.${method}`) })} <strong className="set-number">{number}</strong></li>
        <li>{t('set.step2')}</li>
      </ol>
      <div className="of-two">
        <div className="field"><label htmlFor="tp-amt">{t('set.amount')}</label><input id="tp-amt" inputMode="numeric" value={amount} onChange={(e) => setAmount(digitsOnly(e.target.value))} placeholder={t('set.amountHint', { min: t.money(min) })} /></div>
        <div className="field"><label htmlFor="tp-trx">{t('set.trx')}</label><input id="tp-trx" value={trx} onChange={(e) => setTrx(e.target.value.toUpperCase())} maxLength={12} placeholder="BKH8X2K9QP" /></div>
      </div>
      {err && <p className="error-text small" role="alert">{err}</p>}
      <p className="small muted">{t('set.topupWhen', { max: t.money(max) })}</p>
    </Modal>
  );
}

async function downloadCsv(path, name, t) {
  try {
    const res = await fetch(`/api/dash${path}`, { headers: { authorization: `Bearer ${session.token}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
  } catch (e) { toast(e.message || t('common.retry'), 'red'); }
}

// ---------- Channels ----------
const PLATFORM_HINT = { messenger: 'set.ch.messengerHint', instagram: 'set.ch.instagramHint', whatsapp: 'set.ch.whatsappHint' };
function Channels({ t }) {
  const { can } = useDash();
  const connect = useContext(ConnectContext);
  const { d, setD, error, load } = useData('/settings/channels');
  const [widget, setWidget] = useState(false);
  useEffect(() => { if (connect?.resultVersion) load(); }, [connect?.resultVersion, load]);
  if (error) return <ErrorState thing={t('set.tab.channels')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={260} r={12} />;
  const teach = can('teach_ai');
  async function toggle(c) {
    try {
      await dash(`/agent/channels/${c.id}`, { method: 'PATCH', body: { on: !c.aiOn } });
      setD((x) => ({ ...x, channels: x.channels.map((y) => (y.id === c.id ? { ...y, aiOn: !y.aiOn } : y)) }));
    } catch (e) { toast(e.message, 'red'); }
  }
  const missing = ['messenger', 'instagram', 'whatsapp'].filter((p) => !d.channels.some((c) => c.platform === p));
  return (
    <Card pad={false}>
      <ul className="set-list">
        {d.channels.map((c) => (
          <li key={c.id}>
            <div className="grow"><strong>{t(`set.ch.${c.platform}`, { name: c.name })}</strong><small className="muted">{t(PLATFORM_HINT[c.platform] ?? 'set.ch.otherHint')}</small></div>
            <button type="button" className={`set-pill${c.aiOn ? ' on' : ''}`} disabled={!teach} onClick={() => toggle(c)} aria-pressed={c.aiOn} title={teach ? t('set.ch.toggle') : undefined}>
              {t('set.ch.connected')} · {c.aiOn ? t('ag.aiOn') : t('ag.aiOff')}
            </button>
          </li>
        ))}
        {missing.map((p) => (
          <li key={p}>
            <div className="grow"><strong>{t(`set.ch.add.${p}`)}</strong><small className="muted">{t(PLATFORM_HINT[p])}</small></div>
            {d.canConnect && connect ? <Button size="sm" variant="dark" onClick={() => connect.open(p === 'whatsapp' ? 'whatsapp' : p === 'instagram' ? 'instagram' : 'facebook')}>{t('set.connect')}</Button>
              : <span className="small muted">{t('set.ch.ownerConnects')}</span>}
          </li>
        ))}
        <li>
          <div className="grow"><strong>{t('set.ch.widget')}</strong><small className="muted">{t('set.ch.widgetHint')}</small></div>
          <Button size="sm" onClick={() => setWidget(true)}>{t('set.getCode')}</Button>
        </li>
      </ul>
      {widget && <Modal title={t('set.ch.widget')} onClose={() => setWidget(false)} footer={<Button onClick={() => setWidget(false)}>{t('common.close')}</Button>}><p>{t('set.ch.widgetSoon')}</p></Modal>}
    </Card>
  );
}

// ---------- Delivery & courier ----------
function Delivery({ t }) {
  const { me } = useDash();
  const { d, setD, error, load } = useData('/settings/delivery');
  const [keysFor, setKeysFor] = useState(null);
  if (error) return <ErrorState thing={t('set.tab.courier')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={320} r={12} />;
  const edit = ['owner', 'admin'].includes(me?.user?.role);
  async function saveZone(key, patch) {
    const z = d.zones.find((x) => x.key === key);
    const next = { ...z, ...patch };
    if (String(next.charge) === String(z.charge) && next.days === z.days) return;
    try { const r = await dash('/settings/delivery/zones', { method: 'PATCH', body: { [key]: { charge: next.charge, days: next.days } } }); setD((x) => ({ ...x, zones: r.zones })); toast(t('common.saved'), 'green'); } catch (e) { toast(e.message, 'red'); load(); }
  }
  async function autoBook(c) {
    try { await dash(`/settings/couriers/${c.key}`, { method: 'PATCH', body: { autoBook: !c.autoBook } }); load(); } catch (e) { toast(e.message, 'red'); }
  }
  async function toggleUpdates() {
    try { const r = await dash('/settings/delivery/updates', { method: 'PATCH', body: { on: !d.updates } }); setD((x) => ({ ...x, updates: r.updates })); toast(t('common.saved'), 'green'); } catch (e) { toast(e.message, 'red'); }
  }
  async function disconnect(c) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('set.disconnectConfirm', { c: c.name }))) return;
    try { await dash(`/settings/couriers/${c.key}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, 'red'); }
  }
  return (
    <div className="set-col">
      <Card title={t('set.zones')}>
        <div className="set-zones">
          {d.zones.map((z) => <Zone key={z.key} t={t} z={z} edit={edit} onSave={(patch) => saveZone(z.key, patch)} />)}
        </div>
      </Card>
      <Card pad={false}>
        <ul className="set-list">
          {d.couriers.map((c) => (
            <li key={c.key}>
              <div className="grow"><strong>{c.name}</strong>
                <small className="muted">{c.connected ? (c.autoBook ? t('set.autoBookOn') : t('set.connectedHint')) : t('set.addKeys')}</small></div>
              {c.connected ? (
                <div className="row" style={{ gap: 6 }}>
                  <Pill tone="green">{t('set.ch.connected')}</Pill>
                  {c.testMode && <Pill tone="yellow">{t('set.testMode')}</Pill>}
                  {edit && <button type="button" className={`set-pill${c.autoBook ? ' on blue' : ''}`} onClick={() => autoBook(c)} aria-pressed={c.autoBook}>{t('set.autoBook')} · {c.autoBook ? t('common.on') : t('common.off')}</button>}
                  {edit && <Button size="sm" onClick={() => setKeysFor(c)}>{t('set.keys')}</Button>}
                  {edit && <Button size="sm" variant="ghost" onClick={() => disconnect(c)}>{t('set.disconnect')}</Button>}
                </div>
              ) : edit && <Button size="sm" variant="dark" onClick={() => setKeysFor(c)}>{t('set.connect')}</Button>}
            </li>
          ))}
        </ul>
      </Card>
      <Card pad={false}>
        <ul className="set-list">
          <li>
            <div className="grow"><strong>{t('set.updates')}</strong><small className="muted">{t('set.updatesHint')}</small></div>
            {edit ? <button type="button" className={`set-pill${d.updates ? ' on blue' : ''}`} onClick={toggleUpdates} aria-pressed={d.updates}>{d.updates ? t('common.on') : t('common.off')}</button>
              : <Pill tone={d.updates ? 'green' : 'gray'}>{d.updates ? t('common.on') : t('common.off')}</Pill>}
          </li>
        </ul>
      </Card>
      {keysFor && <CourierKeys t={t} c={keysFor} onClose={() => setKeysFor(null)} onDone={() => { setKeysFor(null); load(); }} />}
    </div>
  );
}

function Zone({ t, z, edit, onSave }) {
  const [charge, setCharge] = useState(String(z.charge));
  const [days, setDays] = useState(z.days);
  return (
    <fieldset className="set-zone" disabled={!edit}>
      <legend>{t(`zone.${z.key}`)}</legend>
      <label className="row"><span className="grow small">{t('set.charge')}</span>
        <span className="set-money"><span>৳</span><input inputMode="numeric" value={charge} onChange={(e) => setCharge(digitsOnly(e.target.value))} onBlur={() => onSave({ charge })} aria-label={`${t(`zone.${z.key}`)} — ${t('set.charge')}`} /></span></label>
      <label className="row"><span className="grow small">{t('set.days')}</span>
        <input className="input input-sm set-days" value={days} onChange={(e) => setDays(e.target.value)} onBlur={() => onSave({ days })} maxLength={20} aria-label={`${t(`zone.${z.key}`)} — ${t('set.days')}`} /></label>
    </fieldset>
  );
}

function CourierKeys({ t, c, onClose, onDone }) {
  const [v, setV] = useState(Object.fromEntries(c.fields.map((f) => [f, ''])));
  const [autoBook, setAutoBook] = useState(c.autoBook);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setBusy(true);
    setErr('');
    try { await dash(`/settings/couriers/${c.key}`, { method: 'PUT', body: { credentials: v, autoBook } }); toast(t('set.courierSaved', { c: c.name }), 'green'); onDone(); } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={t('set.connectCourier', { c: c.name })} subtitle={c.hasKeys ? t('set.replaceKeys') : t('set.keysWhere', { c: c.name })} onClose={onClose} width={460}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={c.fields.some((f) => !v[f].trim())} onClick={save}>{t('set.saveKeys')}</Button></>}>
      {c.fields.map((f) => (
        <div key={f} className="field"><label htmlFor={`ck-${f}`}>{t(`set.field.${f}`)}</label>
          <input id={`ck-${f}`} type={/password|secret|key|token/.test(f) ? 'password' : 'text'} autoComplete="off" value={v[f]} onChange={(e) => setV((x) => ({ ...x, [f]: e.target.value }))} /></div>
      ))}
      <Checkbox checked={autoBook} onChange={setAutoBook} label={t('set.autoBookLabel')} hint={t('set.autoBookHint')} />
      {err && <p className="error-text small" role="alert">{err}</p>}
      <p className="small faint">{t('set.keysSafe')}</p>
    </Modal>
  );
}

// ---------- Payments ----------
function Payments({ t }) {
  const { me } = useDash();
  const { d, setD, error, load } = useData('/settings/payments');
  if (error) return <ErrorState thing={t('set.tab.payments')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={300} r={12} />;
  const edit = ['owner', 'admin'].includes(me?.user?.role);
  async function save(body, local) {
    try { await dash('/settings/payments', { method: 'PATCH', body }); setD((x) => ({ ...x, ...local })); toast(t('common.saved'), 'green'); } catch (e) { toast(e.message, 'red'); load(); }
  }
  const adv = d.advance;
  return (
    <Card title={t('set.howPay')}>
      <fieldset className="set-fieldset" disabled={!edit}>
        <div className="of-two">
          <NumberField t={t} id="pay-bkash" label={t('set.bkashNumber')} value={d.bkash} onSave={(bkash) => save({ bkash }, { bkash })} />
          <NumberField t={t} id="pay-nagad" label={t('set.nagadNumber')} value={d.nagad} onSave={(nagad) => save({ nagad }, { nagad })} />
        </div>
        <div className="set-box">
          <Checkbox checked={d.screenshotsToWhatsapp} onChange={(on) => save({ screenshotsToWhatsapp: on }, { screenshotsToWhatsapp: on })} label={t('set.screenshots')} />
        </div>
        <h3 className="set-h3">{t('set.askAdvance')}</h3>
        <Checkbox checked={adv.highRisk} onChange={(on) => save({ advance: { highRisk: on } }, { advance: { ...adv, highRisk: on } })} label={t('set.advHighRisk')} />
        <div className="row set-adv-row">
          <Checkbox checked={adv.outsideOver !== null} onChange={(on) => save({ advance: { outsideOver: on ? 3000 : null } }, { advance: { ...adv, outsideOver: on ? 3000 : null } })} label={t('set.advOutside')} />
          {adv.outsideOver !== null && <MoneyInline value={adv.outsideOver} label={t('set.advOutside')} onSave={(n) => save({ advance: { outsideOver: n } }, { advance: { ...adv, outsideOver: Number(n) } })} />}
        </div>
        <label className="row set-adv-amount"><span className="small">{t('set.advAmount')}</span>
          <MoneyInline value={adv.amount} label={t('set.advAmount')} onSave={(n) => save({ advance: { amount: n } }, { advance: { ...adv, amount: Number(n) } })} /></label>
        <p className="small faint">{t('set.advNote')}</p>
      </fieldset>
    </Card>
  );
}

function NumberField({ t, id, label, value, onSave }) {
  const [v, setV] = useState(value);
  return (
    <div className="field"><label htmlFor={id}>{label}</label>
      <input id={id} inputMode="tel" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} placeholder="01712-345678" />
    </div>
  );
}

function MoneyInline({ value, label, onSave }) {
  const [v, setV] = useState(String(value ?? ''));
  return <span className="set-money"><span>৳</span><input inputMode="numeric" value={v} onChange={(e) => setV(digitsOnly(e.target.value))} onBlur={() => v && v !== String(value) && onSave(v)} aria-label={label} /></span>;
}

// ---------- Team ----------
const ROLE_HINT = { owner: 'set.role.ownerHint', admin: 'set.role.adminHint', moderator: 'set.role.moderatorHint', agent: 'set.role.agentHint' };
function Team({ t }) {
  const { d, error, load } = useData('/settings/team');
  const [invite, setInvite] = useState(false);
  const [created, setCreated] = useState(null);
  if (error) return <ErrorState thing={t('set.tab.team')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={260} r={12} />;
  async function patch(m, body, ok) {
    try { await dash(`/settings/team/${m.id}`, { method: 'PATCH', body }); toast(ok, 'green'); load(); } catch (e) { toast(e.message, 'red'); }
  }
  return (
    <Card pad={false}>
      <ul className="set-list">
        {d.members.map((m) => (
          <li key={m.id} className={m.active ? '' : 'inactive'}>
            <div className="grow"><strong>{m.name}{m.you && <span className="muted"> · {t('set.you')}</span>}</strong>
              <small className="muted">{t(`role.${m.role}`)} · {t(ROLE_HINT[m.role])}{!m.active && ` · ${t('set.removed')}`}</small></div>
            {d.canInvite && !m.you && m.role !== 'owner' && (
              <div className="row" style={{ gap: 6 }}>
                {m.active && (
                  <select className="input input-sm" value={m.role} onChange={(e) => patch(m, { role: e.target.value }, t('common.saved'))} aria-label={t('set.roleFor', { n: m.name })}>
                    {['admin', 'moderator', 'agent'].map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}
                  </select>
                )}
                <Button size="sm" variant="ghost" onClick={() => patch(m, { active: !m.active }, m.active ? t('set.removedToast', { n: m.name }) : t('set.restored'))}>{m.active ? t('set.remove') : t('set.restore')}</Button>
              </div>
            )}
            {m.active && <Pill tone={m.onDuty ? 'green' : 'gray'}>{m.onDuty ? t('set.onDuty') : t('set.away')}</Pill>}
          </li>
        ))}
        <li className="set-team-foot">
          <span className="grow small muted">{t('set.unlimited')}</span>
          {d.canInvite && <Button variant="primary" onClick={() => setInvite(true)}>+ {t('set.invite')}</Button>}
        </li>
      </ul>
      {invite && <InviteDialog t={t} onClose={() => setInvite(false)} onDone={(r) => { setInvite(false); setCreated(r); load(); }} />}
      {created && (
        <Modal title={t('set.invited', { n: created.name })} onClose={() => setCreated(null)} width={440} footer={<Button variant="primary" onClick={() => setCreated(null)}>{t('common.done')}</Button>}>
          <p>{created.emailed ? t('set.invitedEmailed', { e: created.email }) : t('set.invitedShare')}</p>
          <div className="set-cred"><span>{created.email}</span><code>{created.password}</code></div>
          <p className="small muted">{t('set.invitedOnce')}</p>
        </Modal>
      )}
    </Card>
  );
}

function InviteDialog({ t, onClose, onDone }) {
  const { me } = useDash();
  const [v, setV] = useState({ name: '', email: '', role: 'moderator' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function send() {
    setBusy(true);
    setErr('');
    try { const r = await dash('/settings/team', { method: 'POST', body: v }); onDone({ ...r, name: v.name, email: v.email }); } catch (e) { setErr(e.message); setBusy(false); }
  }
  const roles = me?.user?.role === 'owner' ? ['admin', 'moderator', 'agent'] : ['moderator', 'agent'];
  return (
    <Modal title={t('set.invite')} subtitle={t('set.inviteSub')} onClose={onClose} width={460}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!v.name.trim() || !v.email.trim()} onClick={send}>{t('set.inviteSend')}</Button></>}>
      <div className="field"><label htmlFor="iv-name">{t('set.name')}</label><input id="iv-name" value={v.name} onChange={(e) => setV((x) => ({ ...x, name: e.target.value }))} maxLength={60} /></div>
      <div className="field"><label htmlFor="iv-email">{t('set.email')}</label><input id="iv-email" type="email" value={v.email} onChange={(e) => setV((x) => ({ ...x, email: e.target.value }))} /></div>
      <div className="field"><label htmlFor="iv-role">{t('set.role')}</label>
        <select id="iv-role" value={v.role} onChange={(e) => setV((x) => ({ ...x, role: e.target.value }))}>{roles.map((r) => <option key={r} value={r}>{t(`role.${r}`)} — {t(ROLE_HINT[r])}</option>)}</select></div>
      {err && <p className="error-text small" role="alert">{err}</p>}
    </Modal>
  );
}
