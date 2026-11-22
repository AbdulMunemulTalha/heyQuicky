import { useCallback, useEffect, useRef, useState } from 'react';
import { dash, session } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { navigate } from '../lib/router.jsx';
import { Avatar, Button, ErrorState, Modal, Pill, Skeleton, toast } from '../ui/kit.jsx';
import './profile.css';

const THEMES = ['light', 'dark', 'system'];
const chan = (t, e) => [e.app && t('pf.ch.app'), e.phone && t('pf.ch.phone'), e.whatsapp && t('pf.ch.whatsapp')].filter(Boolean).join(' · ') || t('pf.ch.off');

// Phase 2 · Profile & account (UX-11), frame "Profile & account".
export default function Profile() {
  const t = useT();
  const { setLanguage, setMe, reload } = useDash();
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState(false);
  const [askPw, setAskPw] = useState(false);
  const fileRef = useRef(null);
  const load = useCallback(() => dash('/profile').then((x) => { setD(x); setF({ name: x.name, displayName: x.displayName, phone: x.phone, email: x.email }); }, setError), []);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState thing={t('pf.title')} error={error} onRetry={load} />;
  if (!d || !f) return <Skeleton h={420} r={12} />;
  const dirty = f.name !== d.name || f.displayName !== d.displayName || f.phone !== d.phone || f.email !== d.email;
  const emailChanged = f.email.trim().toLowerCase() !== d.email;

  async function save(password) {
    setBusy(true);
    try {
      await dash('/profile', { method: 'PATCH', body: { ...f, ...(password ? { password } : {}) } });
      toast(t('common.saved'), 'green'); setAskPw(false); await load(); reload?.();
    } catch (err) {
      if (err.code === 'password_needed' || /current password/i.test(err.message)) setAskPw(true);
      else toast(err.message, 'red');
    }
    setBusy(false);
  }
  async function photo(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024 || !/^image\/(jpeg|png|webp)$/.test(file.type)) { toast(t('pf.badPhoto'), 'red'); return; }
    try {
      const res = await fetch('/api/dash/uploads', { method: 'POST', headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name), authorization: `Bearer ${session.token}` }, body: file });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      await dash('/profile', { method: 'PATCH', body: { avatar: r.url } });
      toast(t('pf.photoSaved'), 'green'); await load(); reload?.();
    } catch (err) { toast(err.message, 'red'); }
  }
  async function removePhoto() {
    try { await dash('/profile', { method: 'PATCH', body: { avatar: '' } }); await load(); reload?.(); } catch (err) { toast(err.message, 'red'); }
  }
  async function theme(v) {
    try {
      await dash('/prefs', { method: 'PATCH', body: { theme: v } });
      setD((x) => ({ ...x, theme: v }));
      setMe?.((m) => ({ ...m, user: { ...m.user, theme: v } }));
    } catch (err) { toast(err.message, 'red'); }
  }
  async function logout(s) {
    try { await dash(`/profile/sessions/${s.id}`, { method: 'DELETE' }); toast(t('pf.loggedOutDevice', { d: s.device })); load(); } catch (err) { toast(err.message, 'red'); }
  }
  async function logoutOthers() {
    try { const r = await dash('/profile/sessions/logout-others', { method: 'POST' }); toast(t('pf.loggedOutOthers', { n: t.num(r.loggedOut) }), 'green'); load(); } catch (err) { toast(err.message, 'red'); }
  }
  async function unlinkGoogle() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('pf.unlinkConfirm'))) return;
    try { await dash('/profile/google', { method: 'DELETE' }); load(); } catch (err) { toast(err.message, 'red'); }
  }
  const lang = t.lang;
  return (
    <div className="profile">
      <header className="page-head">
        <div><h1>{t('pf.title')}</h1><p className="page-sub">{t('pf.sub')}</p></div>
      </header>
      <div className="pf-cols">
        <div className="pf-col">
          <section className="card pf-card">
            <h3>{t('pf.personal')}</h3>
            <div className="pf-photo">
              {d.avatar ? <img src={d.avatar} alt="" className="pf-avatar" /> : <Avatar name={d.name} size={56} />}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={photo} />
              <Button size="sm" onClick={() => fileRef.current?.click()}>{t('pf.changePhoto')}</Button>
              {d.avatar && <Button size="sm" onClick={removePhoto}>{t('pf.removePhoto')}</Button>}
            </div>
            <div className="pf-grid">
              <label className="field"><span className="field-label">{t('pf.name')}</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} /></label>
              <label className="field"><span className="field-label">{t('pf.displayName')}</span><input className="input" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} placeholder={t('pf.displayHint', { n: f.name })} maxLength={60} /></label>
              <label className="field"><span className="field-label">{t('pf.phone')}</span><input className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="01XXXXXXXXX" maxLength={20} /></label>
              <label className="field"><span className="field-label">{t('pf.email')}</span><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={120} />
                {emailChanged && <small className="faint">{t('pf.emailNeedsPw')}</small>}</label>
            </div>
            <div><Button variant="primary" busy={busy} disabled={!dirty || !f.name.trim()} onClick={() => save()}>{t('common.save')}</Button></div>
          </section>

          <section className="card pf-card">
            <h3>{t('pf.security')}</h3>
            <ul className="pf-rows">
              <li>
                <span className="grow"><strong>{t('pf.password')}</strong><small className="muted">{d.passwordChangedAt ? t('pf.changedAgo', { w: t.agoLong(d.passwordChangedAt) }) : t('pf.neverChanged')}</small></span>
                <Button size="sm" onClick={() => setPw(true)}>{t('pf.change')}</Button>
              </li>
              <li>
                <span className="grow"><strong>{t('pf.google')}</strong><small className="muted">{d.google ? d.email : t('pf.googleHow')}</small></span>
                {d.google ? <><Pill tone="green">{t('pf.linked')}</Pill><button type="button" className="pf-link" onClick={unlinkGoogle}>{t('pf.unlink')}</button></> : <Pill tone="gray">{t('pf.notLinked')}</Pill>}
              </li>
            </ul>
          </section>

          <section className="card pf-card">
            <div className="pf-head"><h3>{t('pf.where')}</h3>{d.sessions.length > 1 && <Button size="sm" className="pf-danger" onClick={logoutOthers}>{t('pf.logoutOthers')}</Button>}</div>
            <ul className="pf-rows">
              {d.sessions.map((s) => (
                <li key={s.id}>
                  <span className="pf-dev" aria-hidden="true">{/app|android|iphone/i.test(s.device) ? '📱' : '💻'}</span>
                  <span className="grow"><strong>{s.device}</strong><small className="muted">{[s.location, s.current ? t('pf.now') : t.ago(s.lastSeen)].filter(Boolean).join(' · ')}</small></span>
                  {s.current ? <Pill tone="green">{t('pf.thisDevice')}</Pill> : <Button size="sm" onClick={() => logout(s)}>{t('pf.logout')}</Button>}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="pf-col">
          <section className="card pf-card">
            <h3>{t('pf.language')}</h3>
            <div className="pf-choices two" role="radiogroup" aria-label={t('pf.language')}>
              <button type="button" role="radio" aria-checked={lang === 'en'} className={`pf-choice${lang === 'en' ? ' on' : ''}`} onClick={() => setLanguage('en')}><strong>English</strong><small className="muted">{t('pf.langEn')}</small></button>
              <button type="button" role="radio" aria-checked={lang === 'bn'} className={`pf-choice${lang === 'bn' ? ' on' : ''}`} onClick={() => setLanguage('bn')} lang="bn"><strong>বাংলা</strong><small className="muted">পুরো অ্যাপ বাংলায়</small></button>
            </div>
          </section>

          <section className="card pf-card">
            <h3>{t('pf.theme')}</h3>
            <div className="pf-choices three" role="radiogroup" aria-label={t('pf.theme')}>
              {THEMES.map((v) => (
                <button key={v} type="button" role="radio" aria-checked={d.theme === v} className={`pf-choice pf-theme${d.theme === v ? ' on' : ''}`} onClick={() => theme(v)}>
                  <span className={`pf-thumb th-${v}`} aria-hidden="true"><i /><b /></span>
                  <strong>{t(`pf.th.${v}`)}</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="card pf-card">
            <h3>{t('pf.myNotifications')}</h3>
            <small className="muted">{t('pf.notifSub')}</small>
            <ul className="pf-rows tight">
              <li><span className="grow">{t('pf.n.order')}</span><small className="muted">{chan(t, d.notifications.order)}</small></li>
              <li><span className="grow">{t('pf.n.handoff')}</span><small className="muted">{chan(t, d.notifications.handoff)}</small></li>
              <li><span className="grow">{t('pf.n.mention')}</span><small className="muted">{chan(t, d.notifications.mention)}</small></li>
              <li><span className="grow">{t('pf.n.quiet')}</span><small className="muted">{d.notifications.quiet ? t('pf.quietOn') : t('pf.ch.off')}</small></li>
            </ul>
            <div><Button size="sm" onClick={() => navigate('/settings/notifications')}>{t('pf.editNotifications')}</Button></div>
          </section>
        </div>
      </div>
      {pw && <PasswordDialog t={t} onClose={() => setPw(false)} onDone={() => { setPw(false); load(); }} />}
      {askPw && <ConfirmPassword t={t} busy={busy} onClose={() => setAskPw(false)} onConfirm={(p) => save(p)} />}
    </div>
  );
}

function PasswordDialog({ t, onClose, onDone }) {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const mismatch = f.again && f.next !== f.again;
  async function save() {
    setBusy(true);
    try { const r = await dash('/profile/password', { method: 'POST', body: { current: f.current, next: f.next } }); toast(r.loggedOut ? t('pf.pwChangedOut', { n: t.num(r.loggedOut) }) : t('pf.pwChanged'), 'green'); onDone(); } catch (err) { toast(err.message, 'red'); }
    setBusy(false);
  }
  return (
    <Modal title={t('pf.changePassword')} onClose={onClose} width={420} footer={(
      <><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!f.current || f.next.length < 8 || f.next !== f.again} onClick={save}>{t('pf.changePassword')}</Button></>
    )}>
      <div className="pf-form">
        <label className="field"><span className="field-label">{t('pf.currentPw')}</span><input className="input" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoFocus /></label>
        <label className="field"><span className="field-label">{t('pf.newPw')}</span><input className="input" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /><small className="faint">{t('pf.pwRule')}</small></label>
        <label className="field"><span className="field-label">{t('pf.againPw')}</span><input className="input" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} />{mismatch && <small className="pf-err">{t('pf.pwMismatch')}</small>}</label>
        <small className="muted">{t('pf.pwOthersOut')}</small>
      </div>
    </Modal>
  );
}

function ConfirmPassword({ t, busy, onClose, onConfirm }) {
  const [p, setP] = useState('');
  return (
    <Modal title={t('pf.confirmTitle')} onClose={onClose} width={400} footer={(
      <><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={busy} disabled={!p} onClick={() => onConfirm(p)}>{t('common.save')}</Button></>
    )}>
      <div className="pf-form">
        <p className="small muted">{t('pf.confirmSub')}</p>
        <input className="input" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} aria-label={t('pf.currentPw')} autoFocus />
      </div>
    </Modal>
  );
}
