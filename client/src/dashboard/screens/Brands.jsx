import { useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { Avatar, Badge, Button, Modal, Skeleton, toast } from '../ui/kit.jsx';
import './brands.css';

const TONES = ['peach', 'mint', 'lilac', 'sky', 'sand', 'rose'];

// UX-10 · Brand / page switcher (frame "Brand / page switcher") and Add a brand (frame "Add a brand").
export default function Brands({ onClose }) {
  const t = useT();
  const [d, setD] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null);
  useEffect(() => { dash('/brands').then(setD).catch((err) => { toast(err.message, 'red'); onClose(); }); }, [onClose]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !adding) onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [adding, onClose]);
  // Switching reloads the app so every screen and live update follows the new brand.
  async function pick(b) {
    if (b.current) { onClose(); return; }
    setBusy(b.id);
    try { await dash(`/brands/${b.id}/switch`, { method: 'POST' }); window.location.assign('/app/'); } catch (err) { toast(err.message, 'red'); setBusy(null); }
  }
  const status = (b) => {
    if (b.aiMode !== 'auto') return { text: b.aiMode === 'off' ? t('br.aiOff') : t('br.practice'), cls: 'practice' };
    const where = b.channels === 1 && b.platforms[0] ? t(`ag.ch.${b.platforms[0]}`) : t(b.channels === 1 ? 'shell.channel' : 'shell.channels', { n: b.channels });
    return { text: `${t('br.aiLive')} · ${where}`, cls: 'live' };
  };
  const current = d?.brands.find((b) => b.current);
  return (
    <>
      <div className="br-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="br-panel" role="dialog" aria-label={t('br.title')}>
        <small className="br-title">{t('br.title')}</small>
        {!d ? <Skeleton h={120} r={10} /> : (
          <ul className="br-list">
            {d.brands.map((b, i) => {
              const s = status(b);
              return (
                <li key={b.id}>
                  <button type="button" className={`br-item${b.current ? ' on' : ''}`} onClick={() => pick(b)} disabled={busy != null} aria-current={b.current}>
                    <Avatar name={b.name} size={30} tone={TONES[i % TONES.length]} />
                    <span className="br-name"><strong>{b.name}</strong><small className={s.cls}>{busy === b.id ? t('br.switching') : s.text}</small></span>
                    {b.current ? <span className="br-check" aria-hidden="true">✓</span> : b.waiting > 0 && <Badge count={b.waiting} tone="yellow" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {d?.canAdd && (
          <button type="button" className="br-add" onClick={() => setAdding(true)}><span aria-hidden="true">+</span>{t('br.add')}</button>
        )}
        <p className="br-note">{t('br.note')}</p>
      </div>
      {adding && <AddBrand t={t} current={current} onClose={() => setAdding(false)} />}
    </>
  );
}

function AddBrand({ t, current, onClose }) {
  const [name, setName] = useState('');
  const [copy, setCopy] = useState(Boolean(current));
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      await dash('/brands', { method: 'POST', body: { name, copy } });
      // The new brand opens on "connect its Facebook page" (setup step 02).
      window.location.assign('/app/');
    } catch (err) { toast(err.message, 'red'); setBusy(false); }
  }
  return (
    <Modal title={t('br.addTitle')} onClose={onClose} width={440} footer={null}>
      <div className="br-form">
        <label className="field"><span className="field-label">{t('br.name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('br.namePh')} maxLength={60} autoFocus /></label>
        <span className="field-label">{t('br.startFrom')}</span>
        <div className="br-choices" role="radiogroup" aria-label={t('br.startFrom')}>
          <button type="button" role="radio" aria-checked={!copy} className={`br-choice${!copy ? ' on' : ''}`} onClick={() => setCopy(false)}>
            <strong>{t('br.blank')}</strong><small className="muted">{t('br.blankHint')}</small>
          </button>
          {current && (
            <button type="button" role="radio" aria-checked={copy} className={`br-choice${copy ? ' on' : ''}`} onClick={() => setCopy(true)}>
              <strong>{t('br.copy', { n: current.name })}</strong><small className="muted">{t('br.copyHint')}</small>
            </button>
          )}
        </div>
        <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={create} className="br-go">{t('br.continue')}</Button>
      </div>
    </Modal>
  );
}
