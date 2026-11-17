import { session } from '../../api.js';

// Dashboard API helper. Same session token as the rest of the app, but errors keep the HTTP status
// and the server's error code (e.g. wrong_password, forbidden) so screens can show the right state.
export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function dash(path, { method = 'GET', body, auth = true } = {}) {
  let res;
  try {
    res = await fetch(`/api/dash${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(auth && session.token ? { authorization: `Bearer ${session.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("You're offline or the server can't be reached.", 0, 'offline');
  }
  if (res.status === 401 && auth && session.token) {
    onUnauthorized();
    throw new ApiError('Session expired', 401, 'expired');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.code);
  return data;
}

export async function downloadFile(path, filename) {
  const res = await fetch(`/api/dash${path}`, { headers: { authorization: `Bearer ${session.token}` } });
  if (!res.ok) throw new ApiError('Download failed', res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export { session };
