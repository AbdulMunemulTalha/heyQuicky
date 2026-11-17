import { useEffect, useRef, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { Button, Drawer } from '../ui/kit.jsx';

// Test chat (TRN-08): chat as a customer. Nothing is stored or sent to anyone.
export function TestChat({ compact = false }) {
  const t = useT();
  const [turns, setTurns] = useState([]); // { role, content, meta }
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = useRef(null);
  useEffect(() => { list.current?.scrollTo(0, list.current.scrollHeight); }, [turns.length, busy]);

  async function send(e) {
    e?.preventDefault();
    const content = text.trim();
    if (!content || busy) return;
    const next = [...turns, { role: 'user', content }];
    setTurns(next);
    setText('');
    setBusy(true);
    setError('');
    try {
      const out = await dash('/agent/test', { method: 'POST', body: { turns: next.map(({ role, content: c }) => ({ role, content: c })) } });
      setTurns([...next, { role: 'assistant', content: out.reply || '…', meta: out.handoff ? t('ag.wouldHandOff', { r: out.handoff_reason }) : out.intent ? t('ag.intent', { i: out.intent }) : '' }]);
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  return (
    <div className={`testchat${compact ? ' compact' : ''}`}>
      <ol className="msgs tc-msgs" ref={list}>
        {turns.length === 0 && <li className="tc-hint">{t('ag.testHint')}</li>}
        {turns.map((m, i) => (
          <li key={i} className={`msg ${m.role === 'user' ? 'out' : 'in'}`}>
            <div className="bubble bn-ok">{m.content}</div>
            {m.meta && <small className="tc-meta">{m.meta}</small>}
          </li>
        ))}
        {busy && <li className="msg in"><div className="bubble tc-typing">…</div></li>}
      </ol>
      {error && <p className="error-text small" role="alert">{error}</p>}
      <form className="tc-form" onSubmit={send}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('ag.typeLike')} aria-label={t('ag.typeLike')} />
        <Button type="submit" variant="primary" disabled={!text.trim()} busy={busy}>{t('inbox.send')}</Button>
      </form>
      {turns.length > 0 && <button type="button" className="btn btn-link small" onClick={() => { setTurns([]); setError(''); }}>{t('ag.reset')}</button>}
    </div>
  );
}

// The top bar's "Test chat" button opens this panel from anywhere.
export default function TestChatOverlay({ onClose }) {
  const t = useT();
  return <Drawer title={t('shell.testChat')} onClose={onClose} width={420}><p className="small muted">{t('ag.testSub')}</p><TestChat /></Drawer>;
}
