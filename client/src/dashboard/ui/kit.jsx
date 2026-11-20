import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { useT } from '../lib/i18n.js';
import { useDash } from '../lib/context.js';
import { dash } from '../lib/api.js';
import { navigate as navigateTo } from '../lib/router.jsx';

// Dashboard-only building blocks. Onboarding has its own (components/onboarding/parts.jsx) and is left alone.

export function Button({ variant = 'default', size, icon, children, className = '', busy, type = 'button', ...rest }) {
  return (
    <button type={type} className={`btn btn-${variant}${size ? ` btn-${size}` : ''} ${className}`} disabled={busy || rest.disabled} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Card({ title, action, children, className = '', pad = true, ...rest }) {
  return (
    <section className={`card${pad ? '' : ' card-flush'} ${className}`} {...rest}>
      {(title || action) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

// Coloured pill: tone = blue | green | yellow | orange | red | gray | dark | purple.
export function Pill({ tone = 'gray', children, className = '', ...rest }) {
  return <span className={`pill pill-${tone} ${className}`} {...rest}>{children}</span>;
}

export function Badge({ count, tone = 'yellow' }) {
  if (!count) return null;
  return <span className={`badge badge-${tone}`}>{count > 99 ? '99+' : count}</span>;
}

export function Avatar({ name = '', src, size = 32, tone }) {
  const letters = String(name).replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  // Two letters: first and last name, or the first two letters of a one-word name ("Talha" → TA).
  const second = letters.length > 1 ? letters[letters.length - 1][0] : (/^\p{L}$/u.test(letters[0]?.[1] ?? '') ? letters[0][1] : '');
  const text = letters.length ? (letters[0][0] + second).toUpperCase() : '?';
  const tones = ['peach', 'sky', 'mint', 'lilac', 'sand', 'rose'];
  const pick = tone ?? tones[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % tones.length];
  return src
    ? <img className="avatar" src={src} alt="" width={size} height={size} />
    : <span className={`avatar avatar-${pick}`} style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden="true">{text}</span>;
}

// Tabs with counts. items: [{ key, label, count }]
export function Tabs({ items, value, onChange, label, className = '' }) {
  return (
    <div className={`tabs ${className}`} role="tablist" aria-label={label}>
      {items.map((it) => (
        <button key={it.key} type="button" role="tab" aria-selected={value === it.key} className={value === it.key ? 'on' : ''}
          onClick={() => onChange(it.key)}>
          {it.label}{it.count !== undefined && <span className="tab-count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

// Filter chips (rounded, dark when selected).
export function Chips({ items, value, onChange, label, multi = false }) {
  const on = (k) => (multi ? value.includes(k) : value === k);
  const toggle = (k) => (multi ? onChange(on(k) ? value.filter((v) => v !== k) : [...value, k]) : onChange(k));
  return (
    <div className="chips" role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.key} type="button" className={`chip${on(it.key) ? ' on' : ''}`} aria-pressed={on(it.key)} onClick={() => toggle(it.key)}>
          {it.label}{it.count !== undefined && <span className="chip-count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented({ items, value, onChange, label }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {items.map((it) => (
        <button key={it.key} type="button" role="radio" aria-checked={value === it.key} className={value === it.key ? 'on' : ''} onClick={() => onChange(it.key)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled, size }) {
  return (
    <button type="button" role="switch" aria-checked={Boolean(checked)} aria-label={label} disabled={disabled}
      className={`toggle${checked ? ' on' : ''}${size === 'sm' ? ' toggle-sm' : ''}`} onClick={() => onChange(!checked)}>
      <span className="knob" />
    </button>
  );
}

export function Field({ label, hint, error, children, className = '', htmlFor }) {
  const auto = useId();
  const id = htmlFor ?? auto;
  const child = typeof children === 'function' ? children(id) : children;
  return (
    <div className={`field${error ? ' has-error' : ''} ${className}`}>
      {label && <label htmlFor={id}>{label}</label>}
      {child}
      {error ? <p className="field-error" role="alert">{error}</p> : hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={`check${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="check-box" aria-hidden="true"><Icon name="check" size={12} /></span>
      <span className="check-text">{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

// Accessible dialog: focus moves in, Esc and the backdrop close it, focus returns afterwards.
export function Modal({ title, subtitle, onClose, children, footer, width = 520, className = '', labelledBy }) {
  const ref = useRef(null);
  const t = useT();
  const titleId = useId();
  useEffect(() => {
    const before = document.activeElement;
    const el = ref.current;
    (el.querySelector('[autofocus], input, select, textarea, button:not(.modal-x)') ?? el).focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); }
      if (e.key === 'Tab') {
        const items = [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    };
    el.addEventListener('keydown', onKey);
    return () => { el.removeEventListener('keydown', onKey); before?.focus?.(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div ref={ref} className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? titleId} style={{ width }} tabIndex={-1}>
        {title && (
          <header className="modal-head">
            <div>
              <h2 id={titleId}>{title}</h2>
              {subtitle && <p className="muted small">{subtitle}</p>}
            </div>
            {onClose && <button type="button" className="modal-x" aria-label={t('common.close')} onClick={onClose}><Icon name="x" size={16} /></button>}
          </header>
        )}
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

// Side panel from the right (coupons, notifications, help…).
export function Drawer({ title, onClose, children, footer, width = 400, className = '' }) {
  const ref = useRef(null);
  const t = useT();
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); before?.focus?.(); };
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <aside ref={ref} className={`drawer ${className}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} style={{ width }} tabIndex={-1}>
        {title && (
          <header className="drawer-head">
            <h2>{title}</h2>
            <button type="button" className="modal-x" aria-label={t('common.close')} onClick={onClose}><Icon name="x" size={16} /></button>
          </header>
        )}
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </aside>
    </div>
  );
}

export function Skeleton({ w = '100%', h = 14, r = 6, className = '' }) {
  return <span className={`skeleton ${className}`} style={{ width: w, height: h, borderRadius: r }} aria-hidden="true" />;
}

// Frame 17: friendly empty screen with one clear next step.
export function Empty({ icon = 'inbox', tone = 'blue', title, children, actions }) {
  return (
    <div className="empty">
      <span className={`empty-icon tone-${tone}`}><Icon name={icon} size={22} /></span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

// Frame 17: what went wrong, said plainly, with one next step.
// back: { to, label } for "Back to orders" on a 404.
export function ErrorState({ thing, error, onRetry, supportEmail, back }) {
  const t = useT();
  const dashCtx = useDash();
  const [asked, setAsked] = useState(false);
  if (error?.code === 'forbidden' || error?.status === 403) {
    const me = dashCtx?.me?.user;
    async function ask() {
      try { await dash('/access-requests', { method: 'POST', body: { what: thing, path: window.location.pathname.replace(/^\/app/, '') || '/' } }); setAsked(true); } catch (e) { toast(e.message, 'red'); }
    }
    return (
      <Empty icon="lock" tone="yellow" title={t('state.forbidden.title', { thing })}
        actions={asked ? <span className="small muted">{t('state.forbidden.asked')}</span> : <Button onClick={ask}>{t('state.forbidden.ask')}</Button>}>
        {me ? t('state.forbidden.you', { name: me.name, role: t(`role.${me.role}`) }) : error.message}
      </Empty>
    );
  }
  if (error?.status === 404) {
    return (
      <div className="empty state-404">
        <strong className="big-404">404</strong>
        <h3>{t('state.notFound.title', { thing })}</h3>
        <p>{t('state.notFound.body')}</p>
        {back && <div className="empty-actions"><Button onClick={() => navigateTo(back.to)}>{back.label}</Button></div>}
      </div>
    );
  }
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline) return <Empty icon="wifiOff" tone="gray" title={t('state.offline.title')}>{t('state.offline.body')}</Empty>;
  const support = supportEmail ?? dashCtx?.me?.support?.email ?? 'info@heyquicky.com';
  return (
    <Empty icon="alert" tone="red" title={t('state.error.title', { thing })}
      actions={<>
        {onRetry && <Button variant="primary" onClick={onRetry}>{t('state.error.retry')}</Button>}
        <Button onClick={() => window.open(`mailto:${support}?subject=${encodeURIComponent(`${thing} didn't load (${error?.status ?? 'network'})`)}`)}>{t('state.error.contact')}</Button>
      </>}>
      {t('state.error.body')}
      <small className="error-code">{t('state.error.code', { code: error?.status ? `HTTP ${error.status}` : 'NETWORK', time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) })}</small>
    </Empty>
  );
}

// Loads data for a screen with loading / error / retry handled the same way everywhere.
export function useLoad(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    loader().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error) => live && setState({ data: null, error, loading: false }),
    );
    return () => { live = false; };
  }, [...deps, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: () => setVersion((v) => v + 1), setData: (fn) => setState((s) => ({ ...s, data: typeof fn === 'function' ? fn(s.data) : fn })) };
}

// Small toast at the bottom ("Saved", errors from quick actions).
let pushToast = () => {};
export const toast = (text, tone = 'dark') => pushToast({ text, tone, id: Math.random() });
export function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    pushToast = (item) => {
      setItems((list) => [...list, item]);
      setTimeout(() => setItems((list) => list.filter((i) => i.id !== item.id)), 3500);
    };
    return () => { pushToast = () => {}; };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((i) => <div key={i.id} className={`toast toast-${i.tone}`}>{i.text}</div>)}
    </div>
  );
}

export function PageHead({ title, sub, actions, back }) {
  return (
    <header className="page-head">
      <div>
        {back}
        <h1>{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Kpi({ label, value, sub, tone, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`kpi${tone ? ` kpi-${tone}` : ''}`} onClick={onClick}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {sub && <span className="kpi-sub">{sub}</span>}
    </Tag>
  );
}
