const TOKEN_KEY = 'quicky_token';

let token = localStorage.getItem(TOKEN_KEY);
let onUnauthorized = () => {};

export const session = {
  get token() { return token; },
  set(value) {
    token = value;
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  },
  // Called when the server says the session is no longer valid.
  onUnauthorized(fn) { onUnauthorized = fn; },
};

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && token) {
    onUnauthorized();
    throw new Error('Session expired');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Downloads a file the API returns (e.g. the orders CSV).
export async function download(path, filename) {
  const res = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Download failed');
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
