// A thin client over Supabase's HTTP APIs (auth, PostgREST, storage) using
// plain fetch, so there is no dependency to vendor. Only what sync.js needs.

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { getMeta, setMeta } from './db.js';

export class RelayError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind; // 'offline' | 'paused' | 'auth' | 'request'
    this.status = status;
  }
}

let base = SUPABASE_URL;
let key = SUPABASE_KEY;

// Lets tests point the client at a mock server.
export function configure({ url, apiKey }) {
  if (url) base = url.replace(/\/$/, '');
  if (apiKey) key = apiKey;
}

async function request(path, { method = 'GET', headers = {}, body, token, raw = false } = {}) {
  const init = { method, headers: { apikey: key, ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    if (body instanceof Blob) {
      init.body = body;
      init.headers['Content-Type'] = body.type || 'application/octet-stream';
    } else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
  }
  let res;
  try {
    res = await fetch(`${base}${path}`, init);
  } catch (err) {
    throw new RelayError('offline', `Can't reach the relay: ${err.message}`);
  }
  if (res.ok) {
    if (raw) return res;
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  const text = await res.text();
  let detail = text;
  try { detail = JSON.parse(text); } catch { /* not json */ }
  const message = detail?.msg ?? detail?.message ?? detail?.error_description ?? detail?.error ?? text ?? res.statusText;
  if (res.status === 540 || res.status === 503 || /paused/i.test(String(message))) {
    throw new RelayError('paused', 'Relay is paused. Open the Supabase dashboard and restore the project.', res.status);
  }
  if (res.status === 401 || res.status === 403) throw new RelayError('auth', String(message), res.status);
  if (res.status >= 500) throw new RelayError('offline', `Relay error ${res.status}: ${message}`, res.status);
  throw new RelayError('request', `${res.status}: ${message}`, res.status);
}

// ---- auth -----------------------------------------------------------------
// The session (with its refresh token) lives in IndexedDB, so a device signs
// in once and the access token is renewed silently afterwards.

const saveSession = (data) => {
  const session = {
    access: data.access_token,
    refresh: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    userId: data.user?.id ?? null,
    email: data.user?.email ?? null,
  };
  return setMeta('session', session).then(() => session);
};

export const auth = {
  async signIn(email, password) {
    const data = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    return saveSession(data);
  },

  async signOut() {
    const session = await getMeta('session');
    await setMeta('session', null);
    if (session) await request('/auth/v1/logout', { method: 'POST', token: session.access }).catch(() => {});
  },

  // Sends the reset email. The link lands on `redirectTo` (the hosted app)
  // with #type=recovery, where setPassword() finishes the job.
  recover(email, redirectTo) {
    const query = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
    return request(`/auth/v1/recover${query}`, { method: 'POST', body: { email } });
  },

  // Called from a recovery link: the tokens arrive in the URL fragment.
  async setPassword(password, { access_token, refresh_token }) {
    const data = await request('/auth/v1/user', { method: 'PUT', token: access_token, body: { password } });
    const session = await saveSession({ access_token, refresh_token, expires_in: 3600, user: data });
    return session;
  },

  current: () => getMeta('session'),

  // A valid access token, refreshing if it is about to expire. Null if signed out.
  async token() {
    const session = await getMeta('session');
    if (!session) return null;
    if (session.expiresAt - Date.now() > 60 * 1000) return session.access;
    refreshing ??= request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: session.refresh },
    })
      .then(saveSession)
      .catch(async (err) => {
        if (err.kind === 'auth' || err.kind === 'request') {
          await setMeta('session', null);
          throw new RelayError('auth', 'Signed out. Please sign in again.');
        }
        throw err;
      })
      .finally(() => { refreshing = null; });
    return (await refreshing).access;
  },
};

let refreshing = null;

const authed = async (path, options = {}) => {
  const token = await auth.token();
  if (!token) throw new RelayError('auth', 'Not signed in');
  return request(path, { ...options, token });
};

// ---- rest (PostgREST) -----------------------------------------------------

export const rest = {
  select: (table, query) => authed(`/rest/v1/${table}?${query}`),

  insert: (table, rows, { onConflict, ignoreDuplicates = false, merge = false } = {}) => {
    const prefer = ['return=minimal'];
    if (ignoreDuplicates) prefer.push('resolution=ignore-duplicates');
    if (merge) prefer.push('resolution=merge-duplicates');
    const query = onConflict ? `?on_conflict=${onConflict}` : '';
    return authed(`/rest/v1/${table}${query}`, { method: 'POST', body: rows, headers: { Prefer: prefer.join(',') } });
  },

  delete: (table, query) => authed(`/rest/v1/${table}?${query}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),

  rpc: (fn, args) => authed(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args }),
};

// ---- storage --------------------------------------------------------------

const BUCKET = 'media';

export const storage = {
  async upload(path, blob) {
    try {
      await authed(`/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', body: blob, headers: { 'x-upsert': 'true' } });
    } catch (err) {
      if (err.status !== 409) throw err; // already there from an earlier attempt
    }
  },

  async download(path) {
    const res = await authed(`/storage/v1/object/authenticated/${BUCKET}/${path}`, { raw: true });
    return res.blob();
  },

  remove: (paths) => (paths.length
    ? authed(`/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: { prefixes: paths } })
    : Promise.resolve()),
};
