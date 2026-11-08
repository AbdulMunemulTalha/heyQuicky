import { useState } from 'react';
import { api, session } from '../api.js';
import { ErrorText } from './common.jsx';

// The landing page's "Start free" links to /app?signup=1.
function startsInSignup() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('signup')) return false;
  window.history.replaceState(null, '', window.location.pathname);
  return true;
}

export function Auth({ onSignedIn }) {
  const [signup, setSignup] = useState(startsInSignup);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = Object.fromEntries(new FormData(e.target));
      const { token } = await api(signup ? '/auth/signup' : '/auth/login', { method: 'POST', body });
      session.set(token);
      await onSignedIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth">
      <form className="card" onSubmit={submit}>
        <h1><a href="/" className="brand-link">Quicky</a></h1>
        <p className="muted">Messenger, Instagram and WhatsApp orders in one inbox.</p>
        {signup && (
          <div>
            <label>Business name<input name="businessName" autoComplete="organization" required /></label>
            <label>Your name<input name="name" autoComplete="name" required /></label>
          </div>
        )}
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} required minLength={8} /></label>
        <ErrorText>{error}</ErrorText>
        <button type="submit" disabled={busy}>{signup ? 'Create account' : 'Sign in'}</button>
        <button type="button" className="link" onClick={() => setSignup(!signup)}>
          {signup ? 'Already have an account? Sign in' : 'New business? Create an account'}
        </button>
        <p className="muted small legal-links"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/data-deletion">Data deletion</a></p>
      </form>
    </section>
  );
}
