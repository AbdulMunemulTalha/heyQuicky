import { useState } from 'react';

// Small building blocks shared by the onboarding steps (and the parked ones in parkedSteps.jsx).

export function Chips({ options, value, onChange, multi = false }) {
  const selected = (v) => (multi ? value.includes(v) : value === v);
  const toggle = (v) => {
    if (!multi) return onChange(v);
    return onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };
  return (
    <div className="chips" role={multi ? 'group' : 'radiogroup'}>
      {options.map(([v, label]) => (
        <button key={v} type="button" className={`chip${selected(v) ? ' on' : ''}`} aria-pressed={selected(v)} onClick={() => toggle(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }) {
  return (
    <label className="check-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Soon({ children = 'Coming soon' }) {
  return <span className="soon">{children}</span>;
}

export function StepHead({ title, children }) {
  return (
    <header className="onb-head">
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </header>
  );
}

export function Actions({ onBack, onSkip, next = 'Continue', busy, disabled, onNext, type = 'button' }) {
  return (
    <div className="onb-actions">
      {onBack && <button type="button" className="ghost" onClick={onBack}>Back</button>}
      <span className="spacer" />
      {onSkip && <button type="button" className="link" onClick={onSkip}>Skip for now</button>}
      <button type={type} className="primary" disabled={busy || disabled} onClick={onNext}>{busy ? 'Saving…' : next}</button>
    </div>
  );
}

// Runs a save with a busy flag and an error message.
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}
