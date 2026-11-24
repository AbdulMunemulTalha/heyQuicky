import { useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate, useLocation } from '../lib/router.jsx';
import { Button, Drawer, Skeleton, Tabs, toast } from '../ui/kit.jsx';
import { WhatsNewList } from './WhatsNew.jsx';
import Requests from './Requests.jsx';
import './help.css';

// Phase 2 · Help (UX-03) with "Stuck? We'll call you" (ONB-11), frame "Help videos & help bot".
export default function Help({ onClose, tab: startTab = 'help' }) {
  const t = useT();
  const { me } = useDash();
  const [tab, setTab] = useState(['new', 'requests'].includes(startTab) ? startTab : 'help');
  const unread = me?.badges?.whatsNew ?? 0;
  const { path } = useLocation();
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(null); // an article being read
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [calling, setCalling] = useState(false);
  useEffect(() => {
    dash(`/help?path=${encodeURIComponent(path)}&lang=${t.lang}`).then(setD).catch((err) => toast(err.message, 'red'));
  }, [path, t.lang]);
  async function ask(e) {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    try { setAsked({ q: q.trim(), ...(await dash('/help/ask', { method: 'POST', body: { question: q.trim(), lang: t.lang } })) }); setQ(''); } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  const go = (link) => { onClose(); navigate(link); };
  const overview = d?.popular[0];
  const wa = d?.support.whatsapp ? `https://wa.me/${d.support.whatsapp.replace(/\D/g, '').replace(/^0/, '880')}` : '';
  return (
    <Drawer title={t('hp.title')} onClose={onClose} width={400} className="help-drawer">
      {/* UX-04 / UX-05: Help · What's new · Requests. */}
      <Tabs label={t('hp.title')} value={tab} onChange={setTab} className="hp-tabs"
        items={[{ key: 'help', label: t('hp.tabHelp') }, { key: 'new', label: t('wn.tab'), ...(unread && tab !== 'new' ? { count: unread } : {}) }, { key: 'requests', label: t('rq.tab') }]} />
      {tab === 'new' ? <WhatsNewList t={t} onGo={go} /> : tab === 'requests' ? <Requests t={t} onClose={onClose} /> : !d ? <Skeleton h={300} r={12} /> : open ? (
        <article className="hp-article">
          <button type="button" className="hp-back" onClick={() => setOpen(null)}>← {t('hp.back')}</button>
          <h3 className="bn-ok">{open.title}</h3>
          <p className="bn-ok">{open.body}</p>
          <Button variant="primary" onClick={() => go(open.link)}>{t('hp.openIt')}</Button>
        </article>
      ) : (
        <div className="hp-body">
          {overview && (
            <button type="button" className="hp-hero" onClick={() => setOpen(overview)}>
              <span className="hp-play" aria-hidden="true">📖</span>
              <span className="hp-herotext"><strong className="bn-ok">{t('hp.inOneMinute', { t: overview.title })}</strong><small>{t('hp.read', { n: t.num(overview.minutes) })}</small></span>
            </button>
          )}
          <section>
            <small className="hp-label">{t('hp.popular')}</small>
            <ul className="hp-list">
              {d.popular.map((a) => (
                <li key={a.id}><button type="button" onClick={() => setOpen(a)}><span className="bn-ok">{a.title}</span><small className="muted">{t('hp.min', { n: t.num(a.minutes) })}</small></button></li>
              ))}
            </ul>
          </section>

          <section className="hp-ask">
            <div className="hp-askhead"><span className="hp-bot" aria-hidden="true">⚡</span><strong>{t('hp.askTitle')}</strong>{d.aiReady && <span className="hp-ai">AI</span>}</div>
            {asked && (
              <div className="hp-chat">
                <div className="hp-q bn-ok">{asked.q}</div>
                <div className="hp-a bn-ok">
                  {asked.none ? t('hp.noAnswer') : asked.answer}
                  {asked.link && <> <button type="button" className="hp-link" onClick={() => go(asked.link)}>{t('hp.openForMe')}</button></>}
                </div>
              </div>
            )}
            <form className="hp-askform" onSubmit={ask}>
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('hp.askPh')} maxLength={300} aria-label={t('hp.askTitle')} />
              <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!q.trim()}>{t('hp.ask')}</Button>
            </form>
          </section>

          <div className="hp-support">
            {d.support.phone ? <a className="btn" href={`tel:${d.support.phone}`}>{t('hp.callUs')}</a>
              : <Button onClick={() => setCalling(true)}>{t('hp.callMe')}</Button>}
            {wa && <a className="btn" href={wa} target="_blank" rel="noreferrer">{t('hp.whatsapp')}</a>}
          </div>
          {calling && <CallMe t={t} defaultPhone={me?.user.phone ?? ''} path={path} onDone={() => setCalling(false)} />}
        </div>
      )}
    </Drawer>
  );
}

// "Stuck? We'll call you."
function CallMe({ t, defaultPhone, path, onDone }) {
  const [phone, setPhone] = useState(defaultPhone);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function send(e) {
    e.preventDefault();
    setBusy(true);
    try { await dash('/help/callback', { method: 'POST', body: { phone, note, path } }); toast(t('hp.callAsked'), 'green'); onDone(); } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  return (
    <form className="hp-callme" onSubmit={send}>
      <strong className="small">{t('hp.stuck')}</strong>
      <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="01XXXXXXXXX" aria-label={t('hp.yourNumber')} />
      <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('hp.notePh')} maxLength={500} aria-label={t('hp.note')} />
      <div className="hp-callrow"><Button size="sm" onClick={onDone}>{t('common.cancel')}</Button><Button size="sm" type="submit" variant="primary" busy={busy}>{t('hp.requestCall')}</Button></div>
    </form>
  );
}
