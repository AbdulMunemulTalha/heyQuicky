import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dash } from '../lib/api.js';
import { Button, Modal, Skeleton, toast } from '../ui/kit.jsx';
import './teamnotes.css';

// INB-09 · Team notes & @mentions (frame "Team notes & @mentions"). Private to the team: the whole
// thread for the chat and the customer, with an @ picker that shows who is on duty.
const initials = (name) => String(name ?? '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Splits a note into text and @mention chips for the people it actually mentions.
export function NoteText({ text, mentions = [] }) {
  if (!mentions.length) return <>{text}</>;
  const names = [...mentions].sort((a, b) => b.name.length - a.name.length).map((m) => escapeRe(m.name));
  const re = new RegExp(`(@(?:${names.join('|')}))(?![\\p{L}\\p{M}\\p{N}])`, 'giu');
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i} className="tn-mention">{part}</mark> : part))}</>;
}

export default function TeamNotes({ t, id, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(null); // { query, start, index }
  const input = useRef(null);
  const end = useRef(null);
  const load = useCallback(() => dash(`/inbox/${id}/notes`).then(setD, (err) => toast(err.message, 'red')), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [d?.notes.length]);

  const matches = useMemo(() => {
    if (!picker || !d) return [];
    const q = picker.query.toLowerCase();
    return d.team.filter((u) => !u.me && u.name.toLowerCase().includes(q)).slice(0, 6);
  }, [picker, d]);

  function onType(e) {
    const value = e.target.value;
    setText(value);
    // An "@" at the start or after a space opens the picker, until a second space or the end of the word.
    const caret = e.target.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const m = /(?:^|\s)@([^\s@]{0,20})$/u.exec(before);
    setPicker(m ? { query: m[1], start: caret - m[1].length - 1, index: 0 } : null);
  }

  function pick(u) {
    const caret = input.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, picker.start)}@${u.name} ${text.slice(caret)}`;
    setText(next);
    setPicker(null);
    requestAnimationFrame(() => { const pos = picker.start + u.name.length + 2; input.current?.focus(); input.current?.setSelectionRange(pos, pos); });
  }

  function onKey(e) {
    if (picker && matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPicker({ ...picker, index: (picker.index + 1) % matches.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPicker({ ...picker, index: (picker.index - 1 + matches.length) % matches.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[picker.index]); return; }
    }
    if (e.key === 'Escape' && picker) { e.stopPropagation(); setPicker(null); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); }
  }

  async function add() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const note = await dash(`/inbox/${id}/notes`, { method: 'POST', body: { text } });
      setD((x) => ({ ...x, notes: [...x.notes, note] }));
      setText('');
      setPicker(null);
      const away = note.mentions.map((m) => d.team.find((u) => u.id === m.id)).filter((u) => u && !u.onDuty);
      if (away.length) toast(t('tn.awayToast', { names: away.map((u) => u.name).join(', ') }), 'yellow');
      onChanged?.();
    } catch (err) { toast(err.message, 'red'); } finally { setBusy(false); }
  }

  async function remove(n) {
    try {
      await dash(`/inbox/${id}/notes/${n.id}`, { method: 'DELETE' });
      setD((x) => ({ ...x, notes: x.notes.filter((y) => y.id !== n.id) }));
      onChanged?.();
    } catch (err) { toast(err.message, 'red'); }
  }

  const listId = `tn-list-${id}`;
  return (
    <Modal className="tn-modal" width={540} onClose={onClose}
      title={<span className="tn-title"><span className="tn-ico" aria-hidden="true">🗒️</span>{d ? t('tn.title', { name: d.customer }) : t('inbox.teamNote')}</span>}
      subtitle={t('tn.sub')}>
      <div className="tn-thread" aria-live="polite">
        {!d ? <Skeleton h={120} r={10} /> : d.notes.length === 0 ? <p className="small muted tn-empty">{t('tn.empty')}</p> : d.notes.map((n) => (
          <div key={n.id} className="tn-note">
            <span className="tn-av" aria-hidden="true">{initials(n.by) || '?'}</span>
            <div className="tn-body">
              <div className="tn-meta"><strong>{n.by || t('tn.someone')}</strong><span className="muted"> · {t.ago(n.at)}</span>
                {n.mine && <button type="button" className="tn-del" onClick={() => remove(n)} aria-label={t('tn.delete')}>{t('common.delete')}</button>}
              </div>
              <p className="bn-ok"><NoteText text={n.text} mentions={n.mentions} /></p>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="tn-compose">
        <div className="tn-field">
          <input ref={input} className="input bn-ok" value={text} onChange={onType} onKeyDown={onKey} maxLength={1000}
            placeholder={t('tn.placeholder')} aria-label={t('tn.placeholder')}
            role="combobox" aria-expanded={Boolean(picker && matches.length)} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={picker && matches.length ? `${listId}-${matches[picker.index].id}` : undefined} />
          {picker && matches.length > 0 && (
            <div className="tn-picker">
              <small className="muted">{t('tn.mention')}</small>
              <ul id={listId} role="listbox" aria-label={t('tn.mention')}>
                {matches.map((u, i) => (
                  <li key={u.id} id={`${listId}-${u.id}`} role="option" aria-selected={i === picker.index} className={i === picker.index ? 'on' : ''}
                    onMouseDown={(e) => { e.preventDefault(); pick(u); }}>
                    <span className="tn-av sm" aria-hidden="true">{initials(u.name)}</span>
                    <span className="grow">{u.name}</span>
                    <span className={`tn-status${u.onDuty ? (u.online ? ' on' : '') : ' away'}`}>{u.onDuty ? (u.online ? t('tn.online') : t('tn.onDuty')) : t('tn.offDuty')}</span>
                    <span className="muted tn-role">{t(`role.${u.role}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <Button variant="primary" busy={busy} onClick={add} disabled={!text.trim()}>{t('tn.add')}</Button>
      </div>
      <p className="small muted tn-hint">{t('tn.hint')}</p>
    </Modal>
  );
}
