import { useMemo, useRef, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { navigate } from '../lib/router.jsx';
import { Button, Empty, ErrorState, Field, Modal, Pill, Skeleton, toast, useLoad } from '../ui/kit.jsx';
import './watemplates.css';

const TONE = { APPROVED: 'green', PENDING: 'yellow', IN_APPEAL: 'yellow', REJECTED: 'red', PAUSED: 'gray', DISABLED: 'gray' };
const BLANK = { name: '', category: 'UTILITY', language: 'bn', header: '', body: '', footer: '', buttons: ['', '', ''], examples: [] };
// A known label, or Meta's own word for anything newer.
const tt = (t, key, fallback) => { const s = t(key); return s === key ? fallback : s; };
const blanksIn = (body) => [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);

// Settings → WhatsApp templates: the pre-approved messages WhatsApp needs for anything sent outside the
// 24-hour window. Lists the shop's templates with Meta's review status; "New template" sends one for review.
export default function WaTemplates({ query }) {
  const t = useT();
  const channelId = Number(query?.channel) || null;
  const { data: d, error, reload } = useLoad(() => dash(`/whatsapp/templates${channelId ? `?channelId=${channelId}` : ''}`), [channelId]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState('');

  async function remove(tpl) {
    if (!window.confirm(t('wt.deleteConfirm', { name: tpl.name }))) return;
    setBusy(tpl.name);
    try {
      await dash(`/whatsapp/templates/${encodeURIComponent(tpl.name)}${d.channelId ? `?channelId=${d.channelId}` : ''}`, { method: 'DELETE' });
      toast(t('wt.deleted'), 'green');
      reload();
    } catch (err) { toast(err.message, 'red'); }
    setBusy('');
  }

  const head = (
    <>
      <button type="button" className="wt-back" onClick={() => navigate('/settings/channels')}>← {t('settingsNav.channels')}</button>
      <header className="page-head">
        <div><h1>{t('wt.title')}</h1><p className="page-sub">{t('wt.sub')}</p></div>
        {d?.channels?.length > 0 && !d.reconnect && <div className="page-actions"><Button variant="dark" icon="plus" onClick={() => setCreating(true)}>{t('wt.new')}</Button></div>}
      </header>
    </>
  );

  if (error) return <div className="watemplates">{head}<ErrorState thing={t('wt.title')} error={error} onRetry={reload} /></div>;
  if (!d) return <div className="watemplates">{head}<Skeleton h={320} r={12} /></div>;
  if (!d.channels.length) {
    return (
      <div className="watemplates">{head}
        <Empty icon="chat" title={t('wt.noNumber')} actions={<Button variant="dark" onClick={() => navigate('/settings/channels')}>{t('wt.connect')}</Button>}>{t('wt.noNumberBody')}</Empty>
      </div>
    );
  }
  return (
    <div className="watemplates">
      {head}
      {d.channels.length > 1 && (
        <label className="wt-channel">
          <span className="small muted">{t('wt.number')}</span>
          <select className="input input-sm" value={d.channelId ?? ''} onChange={(e) => navigate(`/settings/whatsapp-templates?channel=${e.target.value}`)}>
            {d.channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      {d.reconnect && (
        <div className="wt-notice" role="status">
          <span className="grow">{t('wt.reconnect')}</span>
          <Button size="sm" variant="dark" onClick={() => navigate('/settings/channels')}>{t('wt.connect')}</Button>
        </div>
      )}
      {d.offline && <p className="small muted">{t('wt.offline')}</p>}
      {d.reconnect ? null : d.templates.length === 0 ? (
        <Empty icon="chat" title={t('wt.none')}>{t('wt.noneBody')}</Empty>
      ) : (
        <ul className="wt-list">
          {d.templates.map((tpl) => (
            <li key={`${tpl.name}-${tpl.language}`} className="wt-item card">
              <div className="wt-item-head">
                <div className="grow">
                  <strong className="wt-name">{tpl.name}</strong>
                  <span className="small muted"> · {tt(t, `wt.cat.${tpl.category}`, tpl.category)} · {tpl.language}</span>
                </div>
                <Pill tone={TONE[tpl.status] ?? 'gray'}>{tt(t, `wt.status.${tpl.status}`, tpl.status)}</Pill>
                <Button size="sm" variant="ghost" busy={busy === tpl.name} onClick={() => remove(tpl)} aria-label={t('wt.delete', { name: tpl.name })}>{t('wt.deleteShort')}</Button>
              </div>
              {tpl.header && <p className="wt-header">{tpl.header}</p>}
              <p className="wt-body">{tpl.body}</p>
              {tpl.footer && <p className="small muted">{tpl.footer}</p>}
              {tpl.buttons.length > 0 && <div className="wt-buttons">{tpl.buttons.map((b) => <span key={b} className="wt-btn">{b}</span>)}</div>}
              {tpl.reason && <p className="error-text small">{t('wt.rejected', { reason: tpl.reason })}</p>}
            </li>
          ))}
        </ul>
      )}
      {creating && <NewTemplate t={t} d={d} onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
    </div>
  );
}

function NewTemplate({ t, d, onClose, onDone }) {
  const [f, setF] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const bodyRef = useRef(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const blanks = useMemo(() => blanksIn(f.body), [f.body]);
  const filled = useMemo(() => f.body.replace(/\{\{(\d+)\}\}/g, (m, n) => f.examples[Number(n) - 1] || m), [f.body, f.examples]);

  function addBlank() {
    const n = (blanks.at(-1) ?? 0) + 1;
    const el = bodyRef.current;
    const at = el ? el.selectionStart : f.body.length;
    setF((x) => ({ ...x, body: `${x.body.slice(0, at)}{{${n}}}${x.body.slice(at)}` }));
    setTimeout(() => el?.focus(), 0);
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await dash('/whatsapp/templates', { method: 'POST', body: { ...f, channelId: d.channelId, buttons: f.buttons.filter(Boolean) } });
      toast(t('wt.sent', { name: r.name }), 'green');
      onDone();
    } catch (error) { setErr(error.message); }
    setBusy(false);
  }

  return (
    <Modal title={t('wt.new')} subtitle={t('wt.newSub')} onClose={onClose} width={760}
      footer={<><Button onClick={onClose}>{t('wt.cancel')}</Button><Button variant="dark" type="submit" form="wt-form" busy={busy}>{t('wt.send')}</Button></>}>
      <div className="wt-new">
        <form id="wt-form" className="stack" onSubmit={submit}>
          <Field label={t('wt.name')} hint={t('wt.nameHint')}>
            {(id) => <input id={id} className="input" value={f.name} maxLength={60} onChange={(e) => setF((x) => ({ ...x, name: e.target.value.toLowerCase().replace(/[\s-]+/g, '_') }))} placeholder="order_update" required />}
          </Field>
          <div className="row wt-two">
            <Field label={t('wt.category')} hint={t(`wt.catHint.${f.category}`)}>
              {(id) => <select id={id} className="input" value={f.category} onChange={set('category')}>{d.categories.map((c) => <option key={c} value={c}>{tt(t, `wt.cat.${c}`, c)}</option>)}</select>}
            </Field>
            <Field label={t('wt.language')}>
              {(id) => <select id={id} className="input" value={f.language} onChange={set('language')}>{d.languages.map((l) => <option key={l} value={l}>{tt(t, `wt.lang.${l}`, l)}</option>)}</select>}
            </Field>
          </div>
          <Field label={t('wt.header')} hint={t('wt.optional')}>
            {(id) => <input id={id} className="input" value={f.header} maxLength={60} onChange={set('header')} />}
          </Field>
          <Field label={t('wt.body')} hint={t('wt.bodyHint')}>
            {(id) => (
              <>
                <textarea id={id} ref={bodyRef} className="input" rows={5} maxLength={1024} value={f.body} onChange={set('body')} placeholder={t('wt.bodyPlaceholder')} required />
                <Button size="sm" className="wt-add-blank" onClick={addBlank}>{t('wt.addBlank')}</Button>
              </>
            )}
          </Field>
          {blanks.map((n) => (
            <Field key={n} label={t('wt.sample', { n })} hint={t('wt.sampleHint')}>
              {(id) => <input id={id} className="input" value={f.examples[n - 1] ?? ''} maxLength={200} required
                onChange={(e) => setF((x) => { const examples = [...x.examples]; examples[n - 1] = e.target.value; return { ...x, examples }; })} />}
            </Field>
          ))}
          <Field label={t('wt.footer')} hint={t('wt.optional')}>
            {(id) => <input id={id} className="input" value={f.footer} maxLength={60} onChange={set('footer')} />}
          </Field>
          <fieldset className="wt-btns">
            <legend>{t('wt.buttons')} <span className="small muted">{t('wt.buttonsHint')}</span></legend>
            {f.buttons.map((b, i) => (
              <input key={i} className="input input-sm" value={b} maxLength={25} aria-label={t('wt.buttonN', { n: i + 1 })} placeholder={t('wt.buttonN', { n: i + 1 })}
                onChange={(e) => setF((x) => { const buttons = [...x.buttons]; buttons[i] = e.target.value; return { ...x, buttons }; })} />
            ))}
          </fieldset>
          {err && <p className="error-text" role="alert">{err}</p>}
        </form>
        <aside className="wt-preview" aria-label={t('wt.preview')}>
          <span className="small muted">{t('wt.preview')}</span>
          <div className="wt-phone">
            <div className="wt-bubble">
              {f.header && <strong>{f.header}</strong>}
              <p>{filled || <span className="muted">{t('wt.bodyPlaceholder')}</span>}</p>
              {f.footer && <small>{f.footer}</small>}
            </div>
            {f.buttons.filter(Boolean).map((b, i) => <div key={i} className="wt-bubble-btn">{b}</div>)}
          </div>
          <p className="small muted">{t('wt.reviewNote')}</p>
        </aside>
      </div>
    </Modal>
  );
}
