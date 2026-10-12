// src/upstream.js — the ONE place that talks to the upstream store you buy keys from.
//
// It is the same call as the PHP example you were given:
//   POST  <RESELLER_ENDPOINT>            (form-urlencoded)
//   header  x-master-key: <RESELLER_MASTER_KEY>
//   body    api_key, action=buy, product_id, duration, quantity, android_id, request_id
//
// Environment variables (Render → Environment):
//   RESELLER_API_KEY      your api_key on the upstream store
//   RESELLER_MASTER_KEY   your master key on the upstream store
//   RESELLER_ENDPOINT     optional — defaults to https://repromax5.onrender.com/api/reseller/v1
//
// request_id is unique per order and is REUSED when a request is retried, so
// a network hiccup can never buy (and charge for) the same key twice.

const DEFAULT_ENDPOINT = 'https://repromax5.onrender.com/api/reseller/v1';
const CALL_TIMEOUT_MS = 90_000;   // big orders can take a while (same as the PHP example)
const TOTAL_BUDGET_MS = 150_000;  // never keep a customer waiting longer than this overall
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An error whose `message` is safe to show to the customer. `alertOwner` = something on YOUR side needs fixing. */
export class UpstreamError extends Error {
  constructor(message, { code = 'UPSTREAM_ERROR', status = 0, detail = '', alertOwner = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;       // raw reason, for logs / the owner's Telegram — never shown to customers
    this.alertOwner = alertOwner;
  }
}

const OUT_OF_STOCK_MSG = 'This product is out of stock or under maintenance right now. You were not charged.';

function explain(status, data) {
  const code = String(data?.code || '').toUpperCase();
  const raw = String(data?.error || data?.message || `HTTP ${status}`).slice(0, 300);

  if (code === 'INSUFFICIENT_BALANCE' || status === 402) {
    return new UpstreamError('This product is temporarily unavailable. You were not charged — please try again later.',
      { code, status, detail: `Upstream balance too low: ${raw}`, alertOwner: true });
  }
  if (status === 401 || status === 403 || ['INVALID_CREDENTIALS', 'AUTH_REQUIRED', 'API_DISABLED', 'ACCOUNT_SUSPENDED', 'NOT_RESELLER', 'API_OFFLINE'].includes(code)) {
    return new UpstreamError('The store could not reach its key provider. You were not charged — please try again later.',
      { code, status, detail: `Upstream credentials/account problem: ${raw}`, alertOwner: true });
  }
  if (['OUT_OF_STOCK', 'PRODUCT_MAINTENANCE', 'PROVIDER_UNAVAILABLE'].includes(code)) {
    return new UpstreamError(OUT_OF_STOCK_MSG, { code, status, detail: raw });
  }
  if (code === 'PRODUCT_NOT_FOUND' || code === 'PRODUCT_UNAVAILABLE') {
    return new UpstreamError('This product is not available right now. You were not charged.',
      { code, status, detail: `Product id/duration does not match the upstream store: ${raw}`, alertOwner: true });
  }
  if (code === 'RATE_LIMITED' || status === 429) {
    return new UpstreamError('The server is busy. Please try again in a minute. You were not charged.', { code, status, detail: raw });
  }
  return new UpstreamError(`Could not get your key right now (${raw}). You were not charged.`, { code, status, detail: raw });
}

/** One HTTP call. Returns { status, data } or throws a plain Error for network failures/timeouts. */
async function callOnce(endpoint, masterKey, fields) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-master-key': masterKey },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    redirect: 'follow',
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON — handled by the caller */ }
  return { status: res.status, data, text };
}

/**
 * Buy ONE key. Returns the key string, or throws UpstreamError.
 * @param product     { pid, duration, requiresAndroidId, ... } from the products collection
 * @param androidId   only for device-locked products
 * @param requestId   unique per order; the SAME id is reused on every retry
 */
export async function fetchRealKey(product, { androidId = null, requestId } = {}) {
  const apiKey = process.env.RESELLER_API_KEY;
  const masterKey = process.env.RESELLER_MASTER_KEY;
  const endpoint = process.env.RESELLER_ENDPOINT || DEFAULT_ENDPOINT;

  if (!apiKey || !masterKey) {
    throw new UpstreamError('The store is not fully set up yet. You were not charged — please contact support.',
      { code: 'NOT_CONFIGURED', detail: 'RESELLER_API_KEY and/or RESELLER_MASTER_KEY is not set on the server.', alertOwner: true });
  }
  if (!requestId) throw new Error('fetchRealKey needs a requestId');

  const fields = {
    api_key: apiKey,
    action: 'buy',
    product_id: String(product.pid),
    duration: String(product.duration),   // exactly as listed on the upstream store
    quantity: '1',
    request_id: requestId,
  };
  if (androidId) fields.android_id = androidId;

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let networkFailures = 0;
  let inProgress = 0;

  for (;;) {
    let r;
    try {
      r = await callOnce(endpoint, masterKey, fields);
    } catch (e) {
      // Network error / timeout. The order may or may not have reached the upstream —
      // retrying with the SAME request_id is safe: the upstream replays it instead of re-charging.
      networkFailures++;
      if (networkFailures >= 3 || Date.now() > deadline) {
        throw new UpstreamError('The key server did not answer in time. If you were charged you will be refunded automatically — please try again.',
          { code: 'TIMEOUT', detail: String(e?.message || e) });
      }
      await sleep(2000 * networkFailures);
      continue;
    }

    const { status, data, text } = r;
    if (!data || typeof data !== 'object') {
      // Anything that is not JSON (an HTML error page, a gateway timeout…) is a failed attempt.
      networkFailures++;
      if (networkFailures >= 3 || Date.now() > deadline) {
        throw new UpstreamError('The key server returned an unexpected answer. You were not charged — please try again.',
          { code: 'BAD_RESPONSE', status, detail: String(text || '').slice(0, 200) });
      }
      await sleep(2000 * networkFailures);
      continue;
    }

    const code = String(data.code || '').toUpperCase();
    if (code === 'ORDER_IN_PROGRESS' && Date.now() < deadline && ++inProgress <= 8) {
      await sleep(3000); // the upstream is still working on this exact request_id — ask again
      continue;
    }

    if (status >= 200 && status < 300 && data.success !== false) {
      const raw = Array.isArray(data.keys) ? data.keys[0] : (data.key ?? data.data?.key ?? data.result?.key);
      const key = Array.isArray(raw) ? raw.join('') : String(raw ?? '').trim();
      if (key) return key;
      throw new UpstreamError(OUT_OF_STOCK_MSG, { code: 'NO_KEY', status, detail: 'Upstream answered success but returned no key.' });
    }

    throw explain(status, data);
  }
}
