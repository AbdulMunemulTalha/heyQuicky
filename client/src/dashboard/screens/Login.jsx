import { useEffect, useMemo, useRef, useState } from 'react';
import { api, session } from '../../api.js';
import { SignupStep } from '../../components/Onboarding.jsx';
import { dash } from '../lib/api.js';
import { I18n, makeT } from '../lib/i18n.js';
import { BrandMark, Icon } from '../ui/icons.jsx';
import { Button, Checkbox, Field } from '../ui/kit.jsx';
import '../dashboard.css';
import './login.css';

const LANG_KEY = 'quicky:lang';

// The landing page's "Start free" links to /app?signup=1; sign-up itself is onboarding step 1 (unchanged).
function startsInSignup() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('signup')) return false;
  window.history.replaceState(null, '', window.location.pathname);
  return true;
}

// Frame 18: log in, wrong password, forgot, code, new password, done.
export function Login({ onSignedIn }) {
  const [signup, setSignup] = useState(startsInSignup);
  const [lang, setLang] = useState(() => localStorage.getItem(LANG_KEY) || 'en');
  const t = useMemo(() => makeT(lang), [lang]);

  if (signup) {
    return (
      <SignupStep
        onLogin={() => setSignup(false)}
        onSubmit={async (body) => {
          const { token } = await api('/auth/signup', { method: 'POST', body });
          session.set(token);
          await onSignedIn();
        }}
      />
    );
  }

  const switchLang = () => {
    const next = lang === 'en' ? 'bn' : 'en';
    setLang(next);
    localStorage.setItem(LANG_KEY, next);
  };

  return (
    <I18n.Provider value={t}>
      <div id="dash" lang={lang} className="login-page">
        <div className="login-left">
          <header className="login-top">
            <a href="/" className="logo"><BrandMark size={28} />heyquicky</a>
            <button type="button" className="btn btn-sm" onClick={switchLang} lang={lang === 'en' ? 'bn' : 'en'}>{t('shell.otherLang')}</button>
          </header>
          <main className="login-main">
            <LoginFlow t={t} onSignedIn={onSignedIn} onSignup={() => setSignup(true)} />
          </main>
          <footer className="login-foot">{t('login.footer')} · <a href="/privacy">{t('login.privacy')}</a> · <a href="mailto:info@heyquicky.com">{t('login.help')}</a></footer>
        </div>
        <aside className="login-right" aria-hidden="true">
          <div className="login-blob" />
          <div className="login-pitch">
            <h2>{t('login.panelTitle')}<br />{t('login.panelWho')}<span className="hl">{t('login.panelOrders', { n: 14 })}</span></h2>
            <div className="login-chat">
              <p className="bubble in bn">{t('login.panelQ')}</p>
              <p className="bubble out bn">{t('login.panelA')}</p>
              <small>{t('login.panelMeta')}</small>
            </div>
            <div className="login-stats">
              <div><strong>{t.digits(6)} sec</strong><span>{t('login.statReply')}</span></div>
              <div><strong>{t.digits('24/7')}</strong><span>{t('login.statHours')}</span></div>
              <div><strong className="bn">বাংলা</strong><span>{t('login.statLang')}</span></div>
            </div>
          </div>
        </aside>
      </div>
    </I18n.Provider>
  );
}

function LoginFlow({ t, onSignedIn, onSignup }) {
  const [mode, setMode] = useState('login'); // login | forgot | code | reset | done
  const [login, setLogin] = useState('');
  const [reset, setReset] = useState(null); // { resetId, sentTo, code }
  const [error, setError] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  async function run(fn) {
    setError('');
    setBusy(true);
    try { await fn(); } catch (err) { setError(err.message); return err; } finally { setBusy(false); }
    return null;
  }

  async function finish(token, next = null) {
    session.set(token);
    if (next) setMode(next);
    else await onSignedIn();
  }

  if (mode === 'login') {
    return <LoginForm t={t} login={login} setLogin={setLogin} busy={busy} error={error} wrong={wrong} onSignup={onSignup}
      onForgot={() => { setError(''); setWrong(false); setMode('forgot'); }}
      onSubmit={async ({ password, remember }) => {
        setWrong(false);
        const err = await run(async () => finish((await dash('/auth/login', { method: 'POST', auth: false, body: { login, password, remember } })).token));
        if (err?.code === 'wrong_password') { setWrong(true); setError(''); }
      }} />;
  }

  if (mode === 'forgot') {
    return (
      <form className="login-form" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await dash('/auth/forgot', { method: 'POST', auth: false, body: { login } });
          setReset({ resetId: r.resetId, sentTo: r.sentTo, code: '' });
          setMode('code');
        });
      }}>
        <h1>{t('login.forgotTitle')}</h1>
        <p className="login-sub">{t('login.forgotSub')}</p>
        <Field label={t('login.login')} error={error}>{(id) => <input id={id} value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required autoFocus />}</Field>
        <Button type="submit" variant="primary" size="lg" className="btn-block" busy={busy}>{t('login.sendCode')}</Button>
        <button type="button" className="btn btn-link center" onClick={() => { setError(''); setMode('login'); }}>← {t('login.backToLogin')}</button>
      </form>
    );
  }

  if (mode === 'code') {
    return (
      <form className="login-form" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await dash('/auth/verify-code', { method: 'POST', auth: false, body: { resetId: reset.resetId, code: reset.code } });
          setMode('reset');
        });
      }}>
        <h1>{t('login.codeTitle')}</h1>
        <p className="login-sub">{t('login.codeSub', { to: reset.sentTo })}</p>
        <CodeInput value={reset.code} onChange={(code) => setReset((r) => ({ ...r, code }))} label={t('login.codeTitle')} />
        {error && <p className="error-text" role="alert">{error}</p>}
        {note && <p className="ok-text small" role="status">{note}</p>}
        <Button type="submit" variant="primary" size="lg" className="btn-block" busy={busy} disabled={reset.code.length !== 6}>{t('login.verify')}</Button>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="btn btn-link" onClick={() => setMode('forgot')}>← {t('common.back')}</button>
          <button type="button" className="btn btn-link" onClick={() => run(async () => {
            const r = await dash('/auth/forgot', { method: 'POST', auth: false, body: { login } });
            setReset({ resetId: r.resetId, sentTo: r.sentTo, code: '' });
            setNote(t('login.resent'));
          })}>{t('login.resend')}</button>
        </div>
      </form>
    );
  }

  if (mode === 'reset') {
    return <ResetForm t={t} busy={busy} error={error} setError={setError}
      onSubmit={(password) => run(async () => {
        const r = await dash('/auth/reset', { method: 'POST', auth: false, body: { resetId: reset.resetId, code: reset.code, password } });
        await finish(r.token, 'done');
      })} />;
  }

  return (
    <div className="login-form login-done">
      <span className="empty-icon tone-green"><Icon name="check" size={24} /></span>
      <h1>{t('login.doneTitle')}</h1>
      <p className="login-sub">{t('login.doneSub')}</p>
      <Button variant="primary" size="lg" className="btn-block" onClick={onSignedIn}>{t('login.goDashboard')}</Button>
    </div>
  );
}

function LoginForm({ t, login, setLogin, busy, error, wrong, onSubmit, onForgot, onSignup }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [googleNote, setGoogleNote] = useState('');
  const googleBox = useRef(null);
  const [googleId, setGoogleId] = useState(null);

  useEffect(() => { dash('/auth/config', { auth: false }).then((c) => setGoogleId(c.googleClientId)).catch(() => {}); }, []);

  // Google Identity Services: renders Google's own button when a client id is configured.
  useEffect(() => {
    if (!googleId) return;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => {
      window.google?.accounts.id.initialize({
        client_id: googleId,
        callback: async ({ credential }) => {
          try {
            const { token } = await dash('/auth/google', { method: 'POST', auth: false, body: { credential } });
            session.set(token);
            window.location.reload();
          } catch (err) { setGoogleNote(err.message); }
        },
      });
      window.google?.accounts.id.renderButton(googleBox.current, { theme: 'outline', size: 'large', width: 320, text: 'continue_with' });
    };
    document.head.append(s);
  }, [googleId]);

  return (
    <form className="login-form" onSubmit={(e) => { e.preventDefault(); onSubmit({ password, remember }); }}>
      <h1>{t('login.title')}</h1>
      <p className="login-sub">{t('login.sub')}</p>
      {googleId ? <div ref={googleBox} className="google-box" />
        : <button type="button" className="btn btn-lg btn-block" onClick={() => setGoogleNote(t('login.googleOff'))}><Icon name="google" size={18} />{t('login.google')}</button>}
      {googleNote && <p className="small muted center" role="status">{googleNote}</p>}
      <div className="login-or"><span>{t('login.or')}</span></div>
      <Field label={t('login.login')}>{(id) => <input id={id} value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required />}</Field>
      <div className={`field${wrong ? ' has-error' : ''}`}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label htmlFor="pw">{t('login.password')}</label>
          <button type="button" className="btn btn-link small" onClick={onForgot}>{t('login.forgot')}</button>
        </div>
        <div className="pw-wrap">
          <input id="pw" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required
            aria-invalid={wrong} aria-describedby={wrong ? 'pw-err' : undefined} />
          <button type="button" className="pw-show" onClick={() => setShow(!show)} aria-label={show ? t('login.hide') : t('login.show')}>{show ? t('login.hide') : t('login.show')}</button>
        </div>
        {wrong && <p id="pw-err" className="field-error" role="alert">{t('login.wrong')} <button type="button" className="btn btn-link" onClick={onForgot}>{t('login.resetIt')}</button>.</p>}
      </div>
      <Checkbox checked={remember} onChange={setRemember} label={t('login.remember')} />
      {error && <p className="error-text" role="alert">{error}</p>}
      <Button type="submit" variant="primary" size="lg" className="btn-block" busy={busy}>{t('login.submit')}</Button>
      <p className="center small muted">{t('login.new')} <button type="button" className="btn btn-link" onClick={onSignup}>{t('login.startFree')}</button></p>
    </form>
  );
}

function CodeInput({ value, onChange, label }) {
  const refs = useRef([]);
  const set = (i, ch) => {
    const digits = value.padEnd(6, ' ').split('');
    digits[i] = ch;
    const next = digits.join('').replace(/\s+$/, '');
    onChange(next.replace(/\s/g, ''));
  };
  return (
    <div className="code-input" role="group" aria-label={label}>
      {Array.from({ length: 6 }, (_, i) => (
        <input key={i} ref={(el) => { refs.current[i] = el; }} inputMode="numeric" maxLength={1} aria-label={`${i + 1}`} autoFocus={i === 0}
          value={value[i] ?? ''} autoComplete={i === 0 ? 'one-time-code' : 'off'}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text').replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d)).replace(/\D/g, '').slice(0, 6);
            if (text) { e.preventDefault(); onChange(text); refs.current[Math.min(text.length, 5)]?.focus(); }
          }}
          onKeyDown={(e) => { if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1]?.focus(); }}
          onChange={(e) => {
            const ch = e.target.value.replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d)).replace(/\D/g, '').slice(-1);
            set(i, ch);
            if (ch && i < 5) refs.current[i + 1]?.focus();
          }} />
      ))}
    </div>
  );
}

function ResetForm({ t, busy, error, setError, onSubmit }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [show, setShow] = useState(false);
  return (
    <form className="login-form" onSubmit={(e) => {
      e.preventDefault();
      if (a.length < 8) return setError(t('login.tooShort'));
      if (a !== b) return setError(t('login.mismatch'));
      onSubmit(a);
    }}>
      <h1>{t('login.resetTitle')}</h1>
      <p className="login-sub">{t('login.resetSub')}</p>
      <Field label={t('login.newPassword')}>{(id) => (
        <div className="pw-wrap">
          <input id={id} type={show ? 'text' : 'password'} value={a} onChange={(e) => setA(e.target.value)} autoComplete="new-password" minLength={8} required autoFocus />
          <button type="button" className="pw-show" onClick={() => setShow(!show)}>{show ? t('login.hide') : t('login.show')}</button>
        </div>
      )}</Field>
      <Field label={t('login.again')} error={error}>{(id) => <input id={id} type={show ? 'text' : 'password'} value={b} onChange={(e) => setB(e.target.value)} autoComplete="new-password" required />}</Field>
      <Button type="submit" variant="primary" size="lg" className="btn-block" busy={busy}>{t('login.saveAndLogin')}</Button>
    </form>
  );
}
