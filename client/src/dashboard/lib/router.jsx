import { useEffect, useState, useCallback } from 'react';

// A small history router for /app/... (the repo has no router and the dashboard only needs one level of paths).
const BASE = '/app';
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());
window.addEventListener('popstate', notify);

export function currentLocation() {
  const path = window.location.pathname.startsWith(BASE) ? window.location.pathname.slice(BASE.length) || '/' : '/';
  return { path: path.replace(/\/+$/, '') || '/', query: Object.fromEntries(new URLSearchParams(window.location.search)) };
}

export function navigate(to, { replace = false } = {}) {
  const url = to.startsWith('/app') ? to : `${BASE}${to === '/' ? '' : to}`;
  if (url === window.location.pathname + window.location.search) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', url || BASE);
  notify();
  window.scrollTo(0, 0);
}

// Changes query parameters on the current page (tabs, filters) without adding history entries.
export function setQuery(patch, { replace = true } = {}) {
  const params = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') params.delete(k);
    else params.set(k, v);
  }
  const qs = params.toString();
  window.history[replace ? 'replaceState' : 'pushState'](null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  notify();
}

export function useLocation() {
  const [loc, setLoc] = useState(currentLocation);
  useEffect(() => {
    const fn = () => setLoc(currentLocation());
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return loc;
}

// match('/orders/:n', '/orders/1051') → { n: '1051' } or null.
export function match(pattern, path) {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i += 1) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function Link({ to, children, onClick, ...rest }) {
  const go = useCallback((e) => {
    onClick?.(e);
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  }, [to, onClick]);
  return <a href={to.startsWith('/app') ? to : `${BASE}${to === '/' ? '' : to}`} onClick={go} {...rest}>{children}</a>;
}
