// src/glory.js — server-side client for the ffglory.pro reseller API.
// The API key + master key come ONLY from environment variables and are
// never sent to the browser.

const BASE = ()// src/glory.js — server-side client for the ffglory.pro reseller API.
// The API key + master key come ONLY from environment variables and are
// never sent to the browser.

const BASE = () => String(process.env.GLORY_BASE_URL || 'https://ffglory.pro').replace(/\/+$/, '');

export class GloryError extends Error {
  constructor(message, { status = 502, timeout = false } = {}) {
    super(message);
    this.status = status;
    this.timeout = timeout;
  }
}

export function gloryConfigured() {
  return !!(process.env.GLORY_API_KEY && process.env.GLORY_MASTER_KEY);
}

// The reseller account is ONE account shared by all your users, and the
// upstream answers 409 if two operations hit it at once — so every call
// that changes something runs one at a time through this queue.
let chain = Promise.resolve();
export function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function friendly(status, upstreamMsg) {
  if (status === 402) return 'FF Glory service is temporarily out of capacity. Please try again later.';
  if (status === 403) return upstreamMsg || 'Limit reached for this clan or service.';
  if (status === 404) return 'Group not found.';
  if (status === 409) return 'Another operation is in progress. Please wait a few seconds and try again.';
  if (status === 429) return 'Too many requests. Please wait a moment.';
  if (status === 400) return upstreamMsg || 'Invalid request.';
  return 'FF Glory service error. Please try again.';
}

export async function gloryCall(method, path, { body, query, auth = true, timeoutMs = 25000 } = {}) {
  if (auth && !gloryConfigured()) {
    throw new GloryError('FF Glory is not configured on the server.', { status: 503 });
  }
  const url = new URL(BASE() + path);
  if (auth) url.searchParams.set('api_key', process.env.GLORY_API_KEY);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

  const headers = { Accept: 'application/json' };
  if (auth) headers['x-api-key'] = process.env.GLORY_MASTER_KEY;
  if (body) headers['Content-Type'] = 'application/json';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new GloryError('FF Glory service timed out.', { status: 504, timeout: true });
    throw new GloryError('Could not reach the FF Glory service.', { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await r.json(); } catch (_) { /* non-JSON body */ }
  if (!r.ok) {
    console.error('[glory] upstream', method, path, r.status, data && data.error);
    throw new GloryError(friendly(r.status, data && data.error), { status: r.status });
  }
  return data;
}

// ---- Region list (public endpoint), cached 10 minutes ----
let pricingCache = { at: 0, data: null };
export async function getRegions() {
  if (pricingCache.data && Date.now() - pricingCache.at < 10 * 60 * 1000) return pricingCache.data;
  try {
    const data = await gloryCall('GET', '/api/pricing', { auth: false, timeoutMs: 10000 });
    pricingCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (pricingCache.data) return pricingCache.data; // stale on error
    throw e;
  }
}

export function nrpPriceForTier() {
  // Only Basic groups are sold — one price, set by GLORY_PRICE_BASIC_NRP.
  return Number(process.env.GLORY_PRICE_BASIC_NRP || 250);
}
 => String(process.env.GLORY_BASE_URL || 'https://ffglory.pro').replace(/\/+$/, '');

export class GloryError extends Error {
  constructor(message, { status = 502, timeout = false } = {}) {
    super(message);
    this.status = status;
    this.timeout = timeout;
  }
}

export function gloryConfigured() {
  return !!(process.env.GLORY_API_KEY && process.env.GLORY_MASTER_KEY);
}

// The reseller account is ONE account shared by all your users, and the
// upstream answers 409 if two operations hit it at once — so every call
// that changes something runs one at a time through this queue.
let chain = Promise.resolve();
export function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function friendly(status, upstreamMsg) {
  if (status === 402) return 'FF Glory service is temporarily out of capacity. Please try again later.';
  if (status === 403) return upstreamMsg || 'Limit reached for this clan or service.';
  if (status === 404) return 'Group not found.';
  if (status === 409) return 'Another operation is in progress. Please wait a few seconds and try again.';
  if (status === 429) return 'Too many requests. Please wait a moment.';
  if (status === 400) return upstreamMsg || 'Invalid request.';
  return 'FF Glory service error. Please try again.';
}

export async function gloryCall(method, path, { body, query, auth = true, timeoutMs = 25000 } = {}) {
  if (auth && !gloryConfigured()) {
    throw new GloryError('FF Glory is not configured on the server.', { status: 503 });
  }
  const url = new URL(BASE() + path);
  if (auth) url.searchParams.set('api_key', process.env.GLORY_API_KEY);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

  const headers = { Accept: 'application/json' };
  if (auth) headers['x-api-key'] = process.env.GLORY_MASTER_KEY;
  if (body) headers['Content-Type'] = 'application/json';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new GloryError('FF Glory service timed out.', { status: 504, timeout: true });
    throw new GloryError('Could not reach the FF Glory service.', { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await r.json(); } catch (_) { /* non-JSON body */ }
  if (!r.ok) {
    console.error('[glory] upstream', method, path, r.status, data && data.error);
    throw new GloryError(friendly(r.status, data && data.error), { status: r.status });
  }
  return data;
}

// ---- Region list (public endpoint), cached 10 minutes ----
let pricingCache = { at: 0, data: null };
export async function getRegions() {
  if (pricingCache.data && Date.now() - pricingCache.at < 10 * 60 * 1000) return pricingCache.data;
  try {
    const data = await gloryCall('GET', '/api/pricing', { auth: false, timeoutMs: 10000 });
    pricingCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (pricingCache.data) return pricingCache.data; // stale on error
    throw e;
  }
}

export function nrpPriceForTier() {
  // Only Basic groups are sold — one price, set by GLORY_PRICE_BASIC_NRP.
  return Number(process.env.GLORY_PRICE_BASIC_NRP || 250);
}
