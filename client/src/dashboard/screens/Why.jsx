import { useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { Button, Drawer, Skeleton, toast } from '../ui/kit.jsx';
import './why.css';

// Phase 3 · "Why did the AI say this?" (TRN-09), frame "Why did the AI say this?". Opened from an AI reply in the inbox.
const TYPE_TONE = { catalog: 'purple', post: 'blue', delivery: 'green', payment: 'yellow', memory: 'orange', order: 'blue', booking: 'green', offer: 'yellow', coupon: 'yellow',
  knowledge: 'gray', saved_reply: 'gray', taught: 'purple', rule: 'red', shop_notes: 'gray' };

export default function Why({ conversationId, messageId, onClose }) {
  const t = useT();
  const { can, openOverlay } = useDash();
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [rating, setRating] = useState(null);
  useEffect(() => {
    dash(`/inbox/${conversationId}/why/${messageId}`).then((x) => { setD(x); setRating(x.rating); }, (err) => setError(err.message));
  }, [conversationId, messageId]);
  async function good() {
    try { await dash(`/inbox/${conversationId}/why/${messageId}/rate`, { method: 'POST', body: { rating: 'good' } }); setRating('good'); toast(t('why.thanks'), 'green'); } catch (err) { toast(err.message, 'red'); }
  }
  function teach() {
    if (!can('teach_ai')) { toast(t('tc.askOwner')); return; }
    dash(`/inbox/${conversationId}/why/${messageId}/rate`, { method: 'POST', body: { rating: 'bad' } }).catch(() => {});
    openOverlay('teach', { messageId: d?.messageId ?? messageId });
  }
  return (
    <Drawer title={<span className="why-title"><span className="why-q" aria-hidden="true">?</span>{t('why.title')}</span>} onClose={onClose} width={420} className="why"
      footer={d && <><Button onClick={good} aria-pressed={rating === 'good'} disabled={rating === 'good'}>👍 {t(rating === 'good' ? 'why.rated' : 'why.good')}</Button><Button variant="primary" onClick={teach}>✋ {t('why.teach')}</Button></>}>
      {error ? <p className="small muted">{error}</p> : !d ? <Skeleton h={300} r={10} /> : (
        <>
          <small className="muted">{t('why.reply')} · {t.time(d.at)}{d.customer ? ` · ${d.customer}` : ''}</small>
          <p className="why-reply bn-ok">{d.text}</p>
          {d.steps.length > 0 && (
            <>
              <h3>{t('why.steps')}</h3>
              <ol className="why-steps">
                {d.steps.map((s, i) => <li key={i}><span className="why-n" aria-hidden="true">{i + 1}</span><span><strong>{s.title}</strong><small>{s.detail}</small></span></li>)}
              </ol>
            </>
          )}
          {d.sources.length > 0 && (
            <>
              <h3>{t('why.sources')}</h3>
              <ul className="why-sources">
                {d.sources.map((s, i) => (
                  <li key={i}><span className={`why-chip tone-${TYPE_TONE[s.type] ?? 'gray'}`}>{t(`why.type.${s.type}`)}</span><span className="grow bn-ok">{s.label}</span>{s.note && <small className="muted">{t(`why.note.${s.note}`)}</small>}</li>
                ))}
              </ul>
            </>
          )}
          {!d.steps.length && !d.sources.length && <p className="small muted">{t('why.none')}</p>}
          <div className="why-meta">
            <span>{t('why.cost', { n: t.money(d.cost) })}{d.cached ? ` · ${t('why.cached')}` : ''}</span>
            {d.tookMs != null && <span>{t('why.took', { s: (d.tookMs / 1000).toFixed(1) })}</span>}
            {d.version != null && <span>{t('why.version', { n: d.version })}</span>}
          </div>
        </>
      )}
    </Drawer>
  );
}
