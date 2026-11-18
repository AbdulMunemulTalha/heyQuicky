// Frame 19 / INB-12: the dashboard installs as an app on phones and opens offline.
// client/index.html stays untouched (onboarding depends on it), so the manifest and
// theme colour are added here, when the dashboard starts.

let started = false;
let installPrompt = null;
const listeners = new Set();

export function startPwa() {
  if (started || typeof document === 'undefined') return;
  started = true;
  const head = document.head;
  const add = (tag, attrs) => {
    if (head.querySelector(`${tag}[${Object.keys(attrs)[0]}="${Object.values(attrs)[0]}"]`)) return;
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    head.appendChild(el);
  };
  add('link', { rel: 'manifest', href: '/app/manifest.webmanifest' });
  add('meta', { name: 'theme-color', content: '#2B4BFF' });
  add('link', { rel: 'apple-touch-icon', href: '/app/icons/apple-touch-icon.png' });
  add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
  add('meta', { name: 'apple-mobile-web-app-title', content: 'HeyQuicky' });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    listeners.forEach((fn) => fn(true));
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; listeners.forEach((fn) => fn(false)); });
}

export const canInstall = () => Boolean(installPrompt);
export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export async function installApp() {
  if (!installPrompt) return false;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  listeners.forEach((fn) => fn(false));
  return outcome === 'accepted';
}
