import { useEffect, useState } from 'react';
import { dash } from '../lib/api.js';
import { Button, Modal, Skeleton, toast } from '../ui/kit.jsx';

// ONB-12 · Import products from WooCommerce with a read-only REST API key, and sync them again later.
export default function WooDialog({ t, onClose, onDone }) {
  const [s, setS] = useState(null);
  const [f, setF] = useState({ url: '', key: '', secret: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dash('/catalog/woo').then(setS, (err) => setError(err.message)); }, []);

  const summary = (last) => t(last.more ? 'woo.resultMore' : 'woo.result', { a: t.num(last.added), u: t.num(last.updated), s: t.num(last.skipped) });
  async function run(path, body) {
    setBusy(true);
    setError('');
    try {
      const r = await dash(path, { method: 'POST', body });
      setS(r);
      toast(summary(r.last), 'green');
      onDone?.();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function disconnect() {
    setBusy(true);
    try { setS(await dash('/catalog/woo', { method: 'DELETE' })); setF({ url: '', key: '', secret: '' }); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const connected = s?.connected;
  return (
    <Modal title={t('woo.title')} subtitle={t('woo.sub')} onClose={busy ? undefined : onClose} width={520}
      footer={!s ? null : connected
        ? <><Button onClick={disconnect} disabled={busy}>{t('woo.disconnect')}</Button><Button variant="primary" busy={busy} onClick={() => run('/catalog/woo/sync')}>{t('woo.sync')}</Button></>
        : <><Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!f.url.trim() || !f.key.trim() || !f.secret.trim()} onClick={() => run('/catalog/woo', f)}>{t('woo.connect')}</Button></>}>
      {!s && !error ? <Skeleton h={160} r={10} /> : connected ? (
        <div className="woo-state">
          <p><strong>{s.url}</strong></p>
          <p className="small muted">{t('woo.keyEnd', { k: s.keyEnd })}</p>
          {s.lastSync && <p className="small">{t('woo.lastSync', { when: t.ago(s.lastSync) })}{s.last ? ` · ${summary(s.last)}` : ''}</p>}
          <p className="small muted">{t('woo.syncHow')}</p>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (f.url && f.key && f.secret) run('/catalog/woo', f); }}>
          <ol className="small woo-steps">
            <li>{t('woo.step1')}</li>
            <li>{t('woo.step2')}</li>
            <li>{t('woo.step3')}</li>
          </ol>
          <label className="field"><span>{t('woo.url')}</span><input className="input" value={f.url} onChange={set('url')} placeholder="https://myshop.com" autoComplete="url" inputMode="url" disabled={busy} /></label>
          <label className="field"><span>{t('woo.key')}</span><input className="input mono" value={f.key} onChange={set('key')} placeholder="ck_…" autoComplete="off" spellCheck={false} disabled={busy} /></label>
          <label className="field"><span>{t('woo.secret')}</span><input className="input mono" type="password" value={f.secret} onChange={set('secret')} placeholder="cs_…" autoComplete="off" spellCheck={false} disabled={busy} /></label>
          <p className="small muted">{t('woo.safe')}</p>
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
      {busy && <p className="small" role="status">{t('woo.working')}</p>}
      {error && <p className="small" role="alert" style={{ color: 'var(--red-text, #b42318)' }}>{error}</p>}
    </Modal>
  );
}
