// src/turnstile.js — server-side Cloudflare Turnstile verification.
// The SECRET key lives only in the environment (.env locally, or Render →
// Environment). It is never sent to the browser.
//
//   TURNSTILE_SECRET_KEY   from Cloudflare Dashboard → Turnstile → your widget

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 8000;

export function turnstileConfigured() {
  return !!process.env.TURNSTILE_SECRET_KEY;
}

/**
 * @returns {Promise<{ok:boolean, reason?:'missing-token'|'not-configured'|'unreachable'|'rejected', codes?:string[]}>}
 */
export async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: false, reason: 'not-configured' };

  const t = typeof token === 'string' ? token.trim() : '';
  // Cloudflare tokens are at most 2048 chars; reject junk before spending a request.
  if (!t || t.length > 2048) return { ok: false, reason: 'missing-token' };

  const body = new URLSearchParams({ secret, response: t });
  if (remoteIp) body.set('remoteip', remoteIp);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(VERIFY_URL, { method: 'POST', body, signal: ctrl.signal });
    const data = await r.json().catch(() => ({}));
    if (data && data.success === true) return { ok: true };
    return { ok: false, reason: 'rejected', codes: data?.['error-codes'] || [] };
  } catch (e) {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
