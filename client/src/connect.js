import { api } from './api.js';

// Facebook Page / Instagram: the server sends back a Facebook login URL; Facebook
// later redirects to /app?connect=<id> (or ?connect_error=...).
export async function startFacebookConnect() {
  const { url } = await api('/connect/facebook/start');
  window.location.assign(url);
}

// Facebook login in a popup window, so the dashboard can show progress while it's open.
// Resolves to { id } (a pending connection to pick pages from), { error } or { closed: true }.
// If the browser blocks popups, falls back to a full-page redirect (the page then comes back to /app?connect=…).
export function facebookPopup({ rerequest = false } = {}) {
  const width = 600;
  const height = 720;
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  // Opened straight from the click (before any await) so popup blockers allow it.
  const win = window.open('', 'quicky-facebook', `width=${width},height=${height},left=${left},top=${top}`);
  let cleanup = () => {};
  const promise = new Promise((resolve) => {
    const query = `?popup=${win ? 1 : 0}${rerequest ? '&rerequest=1' : ''}`;
    api(`/connect/facebook/start${query}`).then(({ url }) => {
      if (!win) { window.location.assign(url); return; }
      win.location.href = url;
    }).catch((err) => { win?.close(); resolve({ error: err.message }); });
    if (!win) return;
    const onMessage = (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'quicky-facebook-connect') return;
      cleanup();
      resolve(event.data.id ? { id: event.data.id } : { error: event.data.error || 'Facebook did not complete the login.' });
    };
    // A closed window with no message means the person gave up (wait a moment for a late message).
    const timer = setInterval(() => {
      if (win.closed) { clearInterval(timer); setTimeout(() => { cleanup(); resolve({ closed: true }); }, 800); }
    }, 500);
    window.addEventListener('message', onMessage);
    cleanup = () => { clearInterval(timer); window.removeEventListener('message', onMessage); };
  });
  return { promise, cancel: () => { cleanup(); win?.close(); }, focus: () => win?.focus(), blocked: !win };
}

// Reads (and clears) the result of a Facebook login redirect from the URL.
export function takeFacebookRedirect() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('connect');
  const error = params.get('connect_error');
  if (!id && !error) return null;
  window.history.replaceState(null, '', window.location.pathname);
  return { id, error };
}

// WhatsApp uses Meta's Embedded Signup popup from the Facebook JavaScript SDK.
function loadFacebookSdk({ appId, graphVersion }) {
  if (window.FB) return Promise.resolve(window.FB);
  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion });
      resolve(window.FB);
    };
    const script = Object.assign(document.createElement('script'), {
      src: 'https://connect.facebook.net/en_US/sdk.js', async: true, crossOrigin: 'anonymous',
    });
    script.onerror = () => reject(new Error('Could not load Facebook. Check the internet connection or turn off ad blockers.'));
    document.body.append(script);
  });
}

// The popup reports which account and number were chosen through postMessage.
let embeddedSignup = null;
window.addEventListener('message', (event) => {
  let host;
  try { host = new URL(event.origin).hostname; } catch { return; }
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return;
  let data;
  try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
  if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
  embeddedSignup = { event: data.event, phoneNumberId: data.data?.phone_number_id, wabaId: data.data?.waba_id };
});

// Meta's note can arrive a little after the window closes, or not at all; the server can find the account without it.
async function waitForSignupInfo() {
  for (let i = 0; i < 100 && !embeddedSignup; i += 1) await new Promise((r) => setTimeout(r, 100));
  return embeddedSignup;
}

// Meta reports how the popup ended. Business app numbers finish with their own event,
// and newer flows may report only the WhatsApp account (the server then finds the number).
const SIGNUP_FINISHED = ['FINISH', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', 'FINISH_ONLY_WABA'];

async function finishWhatsApp(code, mode, expectedNumber) {
  const info = await waitForSignupInfo();
  // A note that says the person stopped part-way (CANCEL / an error) means there is nothing to connect.
  if (info && !SIGNUP_FINISHED.includes(info.event)) {
    return { problems: ['WhatsApp signup was not finished. Please try again and complete every step.'] };
  }
  const finished = info && SIGNUP_FINISHED.includes(info.event);
  const coexistence = mode === 'app' || info?.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
  try {
    const result = await api('/connect/whatsapp', {
      method: 'POST',
      body: { code, wabaId: finished ? info.wabaId || null : null, phoneNumberId: finished ? info.phoneNumberId || null : null, coexistence, expectedNumber },
    });
    if (result.importing) {
      result.problems.push('Your WhatsApp chats are being copied in now. Keep the WhatsApp Business app open on your phone until it finishes.');
    }
    return result;
  } catch (err) {
    return { problems: [err.message] };
  }
}

// mode "app": the number the business already uses in the WhatsApp Business app
// (keeps the app working and can bring its chats along). mode "new": a fresh number.
// Resolves to a { connected, problems, pin } result for the dashboard to show.
export async function connectWhatsApp(connectSettings, mode, expectedNumber = '') {
  embeddedSignup = null;
  const FB = await loadFacebookSdk(connectSettings);
  return new Promise((resolve) => {
    FB.login((response) => {
      const code = response.authResponse?.code;
      resolve(code ? finishWhatsApp(code, mode, expectedNumber) : { problems: ['WhatsApp signup was cancelled.'] });
    }, {
      config_id: connectSettings.whatsappConfigId,
      response_type: 'code',
      override_default_response_type: true,
      // The login configuration decides the sign-up version (v4); extras only pick the Business app flow.
      extras: mode === 'app' ? { featureType: 'whatsapp_business_app_onboarding' } : {},
    });
  });
}

export function describeConnectResult({ connected = [], problems = [], pin = null }) {
  const parts = [];
  if (connected.length) parts.push(`Connected: ${connected.join(', ')}.`);
  if (pin) parts.push(`WhatsApp two-step verification PIN: ${pin}. Write it down; Meta asks for it if the number is moved.`);
  parts.push(...problems);
  return parts.join(' ');
}
