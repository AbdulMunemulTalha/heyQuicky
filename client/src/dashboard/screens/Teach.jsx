import { useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { Button, Modal, Skeleton, toast } from '../ui/kit.jsx';
import './agent.css';

const REASONS = ['wrong_info', 'missing_info', 'tone', 'should_hand_off', 'other'];

// Teach popup (TRN-02): from an AI reply in a chat (what was wrong → the right answer → tested &
// published), or from an unanswered question on the Training screen (right answer → published).
export default function Teach({ messageId, unanswered, onDone, onClose }) {
  const t = useT();
  const [src, setSrc] = useState(unanswered ? { asked: unanswered.question, replied: null } : null);
  const [step, setStep] = useState(unanswered ? 'fix' : 'reason');
  const [reason, setReason] = useState('');
  const [answer, setAnswer] = useState('');
  const [when, setWhen] = useState([]);
  const [whenText, setWhenText] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    if (!messageId) return;
    dash(`/training/teach/${messageId}`).then(setSrc, (err) => { toast(err.message, 'red'); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  // "Preview on the customer's phone": the AI answers the question with this answer added (nothing saved).
  useEffect(() => {
    if (step !== 'fix' || !answer.trim() || !src?.asked) { setPreview(null); return undefined; }
    const timer = setTimeout(() => dash('/agent/preview', { method: 'POST', body: { question: src.asked, answer } }).then(setPreview).catch(() => {}), 700);
    return () => clearTimeout(timer);
  }, [answer, step, src]);

  function addWhen() {
    const w = whenText.trim();
    if (w && !when.includes(w) && when.length < 5) setWhen([...when, w]);
    setWhenText('');
  }
  async function publish() {
    setBusy(true);
    try {
      const out = unanswered
        ? await dash(`/agent/unanswered/${unanswered.id}/teach`, { method: 'POST', body: { answer, when } })
        : await dash(`/training/teach/${messageId}`, { method: 'POST', body: { reason, answer, when } });
      setDone({ version: out.version, tested: out.tested ?? preview?.reply ?? null });
      setStep('done');
      onDone?.();
    } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  async function undo() {
    try { const r = await dash('/agent/undo', { method: 'POST' }); toast(t('ag.undone', { n: r.restored }), 'green'); onDone?.(); onClose(); } catch (err) { toast(err.message, 'red'); }
  }

  const steps = unanswered ? ['fix', 'done'] : ['reason', 'fix', 'done'];
  const footer = step === 'reason' ? (
    <><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!reason} onClick={() => setStep('fix')}>{t('tc.next')}</Button></>
  ) : step === 'fix' ? (
    <>{!unanswered && <Button onClick={() => setStep('reason')}>{t('tc.back')}</Button>}<Button variant="primary" busy={busy} disabled={!answer.trim()} onClick={publish}>{t('tc.publish')}</Button></>
  ) : (
    <><Button variant="ghost" onClick={undo}>{t('ag.undo')}</Button><Button variant="primary" onClick={onClose}>{t('common.done')}</Button></>
  );

  return (
    <Modal title={t('tc.title')} subtitle={t('tc.step', { n: t.num(steps.indexOf(step) + 1), of: t.num(steps.length) })} onClose={onClose} footer={footer} width={720} className="teach">
      {!src ? <Skeleton h={220} r={12} /> : (
        <div className="tc-grid">
          <div className="tc-main">
            {step === 'reason' && (
              <>
                <div className="tc-pair">
                  <span className="small muted">{t('tc.asked')}</span><div className="bubble cust bn-ok">{src.asked || '—'}</div>
                  <span className="small muted">{t('tc.replied')}</span><div className="bubble shop bn-ok">{src.replied}</div>
                </div>
                <fieldset className="tc-reasons">
                  <legend className="small"><strong>{t('tc.wrong')}</strong></legend>
                  {REASONS.map((r) => (
                    <label key={r} className={`tc-reason${reason === r ? ' on' : ''}`}>
                      <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
                      <span><strong>{t(`tc.reason.${r}`)}</strong><small className="muted">{t(`tc.reasonHint.${r}`)}</small></span>
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            {step === 'fix' && (
              <>
                <span className="small muted">{t('tc.asked')}</span><div className="bubble cust bn-ok tc-asked">{src.asked}</div>
                <label className="small" htmlFor="tc-answer"><strong>{t('tc.right')}</strong></label>
                <textarea id="tc-answer" className="input" rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('tc.rightPlaceholder')} maxLength={2000} autoFocus />
                <label className="small" htmlFor="tc-when"><strong>{t('tc.when')}</strong></label>
                <div className="tc-when">
                  {when.map((w) => <button key={w} type="button" className="chip on" onClick={() => setWhen(when.filter((x) => x !== w))} aria-label={t('tc.removeWhen', { w })}>{w} ×</button>)}
                  <input id="tc-when" className="input" value={whenText} onChange={(e) => setWhenText(e.target.value)} placeholder={t('tc.whenPlaceholder')}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addWhen(); } }} onBlur={addWhen} maxLength={80} />
                </div>
                {reason === 'should_hand_off' && <p className="small muted">{t('tc.handoffNote')}</p>}
              </>
            )}
            {step === 'done' && (
              <div className="tc-done">
                <span className="tc-check" aria-hidden="true">✓</span>
                <h3>{t('tc.doneTitle', { n: t.num(done.version) })}</h3>
                <p className="muted small">{t('tc.doneSub')}</p>
              </div>
            )}
          </div>
          <aside className="tr-phone tc-phone" aria-live="polite">
            <span className="small muted">{step === 'done' ? t('tc.tested') : t('tc.phone')}</span>
            <div className="bubble cust bn-ok">{src.asked || '—'}</div>
            {step === 'reason' && <div className="bubble shop bn-ok tc-old">{src.replied}</div>}
            {step === 'fix' && (preview ? <div className="bubble shop bn-ok">{preview.reply}</div> : <small className="faint">{t('tc.typeToPreview')}</small>)}
            {step === 'done' && (done.tested ? <div className="bubble shop bn-ok">{done.tested}</div> : <small className="faint">{t('tr.noAiPreview')}</small>)}
          </aside>
        </div>
      )}
    </Modal>
  );
}
