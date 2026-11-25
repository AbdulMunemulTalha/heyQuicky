import { useState } from 'react';
import { api, session } from '../api.js';
import { ErrorText } from './common.jsx';
import { SignupStep } from './Onboarding.jsx';

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

  // Sign-up is step 1 of onboarding, in the same layout as the other steps.
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

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = Object.fromEntries(new FormData(e.target));
      const { token } = await api('/auth/login', { method: 'POST', body });
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
        <h1><a href="/" className="brand-link brand"><img src="/brand/quicky-color.svg" alt="Quicky" height="36" /></a></h1>
        <p className="muted">Log in to your shop's inbox.</p>
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required minLength={8} /></label>
        <ErrorText>{error}</ErrorText>
        <button type="submit" disabled={busy}>Log in</button>
        <button type="button" className="link" onClick={() => setSignup(true)}>New business? Start free</button>
        <p className="muted small legal-links"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/data-deletion">Data deletion</a></p>
      </form>
    </section>
  );
}
