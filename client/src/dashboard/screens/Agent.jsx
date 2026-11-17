import { useCallback, useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate } from '../lib/router.jsx';
import { Button, Card, Empty, ErrorState, Modal, Pill, Skeleton, toast } from '../ui/kit.jsx';
import { TestChat } from './TestChat.jsx';
import './agent.css';

const STYLES = ['banglish', 'bangla', 'english', 'casual'];
const SALES = ['consultative', 'direct'];
const ADDRESS = ['auto', 'apu', 'bhaiya', 'sir_madam', 'bondhu'];
const DELAYS = ['instant', '1-3', '3-6', '6-10'];
const RETURNS = [0, 15, 30, 60, 120, 720];

// Screen 07: the AI agent — persona, channel switches, what it knows, questions it couldn't answer, test chat.
export default function Agent() {
  const t = useT();
  const { can, socket } = useDash();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => dash('/agent').then(setD, setError), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return undefined;
    socket.on('unanswered', load);
    return () => socket.off('unanswered', load);
  }, [socket, load]);

  async function toggle(ch) {
    try {
      await dash(`/agent/channels/${ch.id}`, { method: 'PATCH', body: { on: !ch.on } });
      setD((x) => ({ ...x, channels: x.channels.map((c) => (c.id === ch.id ? { ...c, on: !c.on } : c)) }));
    } catch (err) { toast(err.message, 'red'); }
  }
  async function undo() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('ag.undoConfirm', { n: d.version.number }))) return;
    try { const r = await dash('/agent/undo', { method: 'POST' }); toast(t('ag.undone', { n: r.restored }), 'green'); load(); } catch (err) { toast(err.message, 'red'); }
  }

  if (error) return <ErrorState thing={t('nav.agent')} error={error} onRetry={load} />;
  if (!d) return <Skeleton h={400} r={12} />;
  const p = d.persona;
  const teach = can('teach_ai');
  return (
    <div className="agent">
      <header className="page-head">
        <div><h1>{t('nav.agent')}</h1><p className="page-sub">{t('ag.sub')}</p></div>
        <div className="page-actions">
          {d.version && <Pill tone="green" className="ag-version">{t('ag.versionLive', { n: d.version.number, when: t.agoLong(d.version.at), by: d.version.by })}</Pill>}
          {teach && d.version?.canUndo && <Button onClick={undo}>{t('ag.undo')}</Button>}
          <Button onClick={() => navigate('/agent/training')}>{t('ag.training')}</Button>
        </div>
      </header>
      {!d.available && <div className="alert-bar alert-yellow"><strong>{t('ag.notSetUp')}</strong> {t('ag.notSetUpBody')}</div>}

      <div className="ag-grid">
        <div className="od-col">
          <Card title={t('ag.persona')} action={teach && <Button size="sm" onClick={() => setEditing(true)}>{t('common.edit')}</Button>}>
            <dl className="ag-persona">
              <div><dt>{t('ag.nameRole')}</dt><dd>{p.name || '—'}{p.role && ` · ${p.role}`}</dd></div>
              <div><dt>{t('ag.tone')}</dt><dd>{t(`ag.style.${p.style}`)}</dd></div>
              <div><dt>{t('ag.sales')}</dt><dd>{t(`ag.salesStyle.${p.sales}`)}</dd></div>
              <div><dt>{t('ag.calls')}</dt><dd>{t(`ag.address.${p.address}`)}</dd></div>
              <div><dt>{t('ag.delay')}</dt><dd>{t(`ag.delayOpt.${p.delay}`)}</dd></div>
              <div><dt>{t('ag.returns')}</dt><dd>{p.autoReturnMin ? t('ag.returnAfter', { n: p.autoReturnMin }) : t('ag.returnNever')}</dd></div>
            </dl>
            <div className="ag-channels">
              {d.channels.map((c) => (
                <button key={c.id} type="button" className={`ag-ch${c.on ? ' on-c' : ''}`} disabled={!teach} onClick={() => toggle(c)} aria-pressed={c.on}>
                  <span className={`dot${c.on ? '' : ' gray'}`} />{t(`ag.ch.${c.platform}`)} · {c.on ? t('ag.aiOn') : t('ag.aiOff')}
                </button>
              ))}
            </div>
          </Card>

          <Card title={t('ag.unanswered')} action={d.unanswered.length > 0 && <Pill tone="yellow">{t('ag.newCount', { n: d.unanswered.length })}</Pill>} pad={false}>
            {d.unanswered.length === 0 ? <Empty icon="check" tone="green" title={t('ag.allAnswered')}>{t('ag.allAnsweredSub')}</Empty> : (
              <ul className="ag-unanswered">{d.unanswered.map((u, i) => <Question key={u.id} t={t} u={u} open={i === 0} teach={teach} onDone={load} />)}</ul>
            )}
          </Card>

          <Knowledge t={t} items={d.knowledge} teach={teach} onChange={load} />

          <Card title={t('ag.week')}>
            <div className="ag-week">
              <div><strong>{t.num(d.week.replies)}</strong><small>{t('ag.wk.replies')}</small></div>
              <div><strong>{t.num(d.week.saved)}</strong><small>{t('ag.wk.saved')}</small></div>
              <div><strong>{t.num(d.week.handed)}</strong><small>{t('ag.wk.handed')}</small></div>
              <div><strong>{t.money(d.week.cost, 2)}</strong><small>{t('ag.wk.cost')}</small></div>
            </div>
          </Card>
        </div>
        <Card title={t('shell.testChat')} className="ag-test">
          <p className="small muted">{t('ag.testSub')}</p>
          <TestChat compact />
        </Card>
      </div>
      {editing && <PersonaDialog t={t} p={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
    </div>
  );
}

function Question({ t, u, open: startOpen, teach, onDone }) {
  const [open, setOpen] = useState(startOpen);
  const [answer, setAnswer] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!answer.trim()) { setPreview(null); return undefined; }
    const timer = setTimeout(() => dash('/agent/preview', { method: 'POST', body: { question: u.question, answer } }).then(setPreview).catch(() => {}), 700);
    return () => clearTimeout(timer);
  }, [answer, u.question]);

  async function act(path, body, ok) {
    setBusy(true);
    try { await dash(`/agent/unanswered/${u.id}/${path}`, { method: 'POST', body }); toast(ok, 'green'); onDone(); } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  return (
    <li className={`ag-q${open ? ' open' : ''}`}>
      <div className="row">
        <strong className="grow bn-ok">{u.question}</strong>
        <span className="small muted">{t('ag.asked', { n: u.count })}</span>
        {teach && <Button size="sm" onClick={() => act('hide', {}, t('ag.hidden'))}>{t('ag.hide')}</Button>}
        {teach && <Button size="sm" variant="dark" onClick={() => setOpen(!open)}>{t('ag.teach')}</Button>}
      </div>
      {open && teach && (
        <div className="ag-teach">
          <label className="small" htmlFor={`ans-${u.id}`}>{t('ag.writeAnswer')}</label>
          <textarea id={`ans-${u.id}`} className="input" rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('ag.answerPlaceholder')} />
          {preview && (
            <div className="ag-preview">
              <span className="small muted">{t('ag.previewTitle')}</span>
              <div className="bubble bn-ok">{preview.reply}</div>
              {!preview.ai && <small className="faint">{t('ag.previewPlain')}</small>}
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => { setAnswer(''); setOpen(false); }}>{t('ag.discard')}</Button>
            <Button size="sm" variant="primary" disabled={!answer.trim()} busy={busy} onClick={() => act('teach', { answer }, t('ag.taught'))}>{t('ag.turnOn')}</Button>
          </div>
        </div>
      )}
    </li>
  );
}

function Knowledge({ t, items, teach, onChange }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  async function add() {
    try { await dash('/agent/knowledge', { method: 'POST', body: { title, text } }); setText(''); setTitle(''); setAdding(false); toast(t('ag.published'), 'green'); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  async function remove(k) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('ag.removeKnowledge'))) return;
    try { await dash(`/agent/knowledge/${k.id}`, { method: 'DELETE' }); onChange(); } catch (err) { toast(err.message, 'red'); }
  }
  return (
    <Card title={t('ag.knows')} action={teach && <Button size="sm" onClick={() => setAdding(!adding)}>+ {t('ag.addKnowledge')}</Button>}>
      {adding && (
        <div className="ag-add">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('ag.kTitle')} aria-label={t('ag.kTitle')} />
          <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('ag.kText')} aria-label={t('ag.kText')} />
          <div className="row" style={{ justifyContent: 'flex-end' }}><Button size="sm" onClick={() => setAdding(false)}>{t('common.cancel')}</Button><Button size="sm" variant="primary" disabled={!text.trim()} onClick={add}>{t('ag.publish')}</Button></div>
        </div>
      )}
      {items.length === 0 && !adding ? <p className="small muted">{t('ag.noKnowledge')}</p> : (
        <ul className="ag-knowledge">
          {items.map((k) => (
            <li key={k.id}><span className="grow bn-ok">{k.title && <strong>{k.title}: </strong>}{k.text}</span>{teach && <button type="button" className="btn btn-link small" onClick={() => remove(k)}>{t('common.delete')}</button>}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PersonaDialog({ t, p, onClose, onSaved }) {
  const [v, setV] = useState({ ...p });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.value }));
  async function save() {
    setBusy(true);
    try {
      const r = await dash('/agent/persona', { method: 'PATCH', body: { ...v, autoReturnMin: Number(v.autoReturnMin) } });
      toast(t('ag.publishedV', { n: r.version }), 'green');
      onSaved();
    } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  const sel = (k, opts, prefix) => (
    <select id={`p-${k}`} value={v[k]} onChange={set(k)}>{opts.map((o) => <option key={o} value={o}>{t(`${prefix}.${o}`)}</option>)}</select>
  );
  return (
    <Modal title={t('ag.editPersona')} subtitle={t('ag.editSub')} onClose={onClose} width={520}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} onClick={save}>{t('ag.publish')}</Button></>}>
      <div className="of-two">
        <div className="field"><label htmlFor="p-name">{t('ag.name')}</label><input id="p-name" value={v.name} onChange={set('name')} maxLength={30} /></div>
        <div className="field"><label htmlFor="p-role">{t('ag.role')}</label><input id="p-role" value={v.role} onChange={set('role')} maxLength={40} placeholder="Page moderator" /></div>
        <div className="field"><label htmlFor="p-style">{t('ag.tone')}</label>{sel('style', STYLES, 'ag.style')}</div>
        <div className="field"><label htmlFor="p-sales">{t('ag.sales')}</label>{sel('sales', SALES, 'ag.salesStyle')}</div>
        <div className="field"><label htmlFor="p-address">{t('ag.calls')}</label>{sel('address', ADDRESS, 'ag.address')}</div>
        <div className="field"><label htmlFor="p-delay">{t('ag.delay')}</label>{sel('delay', DELAYS, 'ag.delayOpt')}</div>
        <div className="field"><label htmlFor="p-ret">{t('ag.returns')}</label>
          <select id="p-ret" value={v.autoReturnMin} onChange={set('autoReturnMin')}>{RETURNS.map((m) => <option key={m} value={m}>{m ? t('ag.returnAfter', { n: m }) : t('ag.returnNever')}</option>)}</select></div>
      </div>
    </Modal>
  );
}
