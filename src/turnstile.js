// src/turnstile.js — server-side Cloudflare Turnstile verification.
// The SECRET key lives only in the environment (.env locally, or Render →
// Environment). It is never sent to the browser.
//
//   TURNSTILE_SECRET_KEY   from Cloudflare Dashboard → Turnstile → your widget

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 80// routes/auth.js — PUBLIC (signed-out) endpoints used by login.php.
import express from 'express';
import { asyncH// src/turnstile.js — server-side Cloudflare Turnstile verification.
// The SECRET key lives only in the environment (.env locally, or Render →
// Environme// src/turnstile.js — server-side Cloudflare Turnstile verification.
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
nt). It is never sent to the browser.
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
andler } from '../src/asyncHandler.js';
import { userCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { verifyTurnstile } from '../src/turnstile.js';
// routes/auth.js — PUBLIC (signed-out) endpoints used by login.php.
import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { userCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { verifyTurnstile } from '../src/turnstile.js';

const router = express.Router();
router.use(userCors);

// POST /api/auth/turnstile   Body: { token }
// The login page calls this as soon as the visitor passes the Turnstile
// challenge. The token is checked with Cloudflare using TURNSTILE_SECRET_KEY.
router.post('/turnstile', rateLimit({ windowMs: 60_000, max: 30, name: 'turnstile' }), asyncHandler(async (req, res) => {
  const result = await verifyTurnstile(req.body?.token, req.ip);
  if (result.ok) return res.json({ success: true });

  if (result.reason === 'not-configured') {
    console.error('[turnstile] TURNSTILE_SECRET_KEY is not set on the server');
    return res.status(503).json({ success: false, error: 'Security check is not configured on the server.' });
  }
  if (result.reason === 'unreachable') {
    return res.status(503).json({ success: false, error: 'Could not reach the security service. Please try again.' });
  }
  if (result.reason === 'rejected') console.warn('[turnstile] rejected:', (result.codes || []).join(','));
  return res.status(403).json({ success: false, error: 'Security check failed. Please try again.' });
}));

export default router;

const router = express.Router();
router.use(userCors);

// POST /api/auth/turnstile   Body: { token }
// The login page calls this as soon as the visitor passes the Turnstile
// challenge. The token is checked with Cloudflare using TURNSTILE_SECRET_KEY.
router.post('/turnstile', rateLimit({ windowMs: 60_000, max: 30, name: 'turnstile' }), asyncHandler(async (req, res) => {
  const result = await verifyTurnstile(req.body?.token, req.ip);
  if (result.ok) return res.json({ success: true });

  if (result.reason === 'not-configured') {
    console.error('[turnstile] TURNSTILE_SECRET_KEY is not set on the server');
    return res.status(503).json({ success: false, error: 'Security check is not configured on the server.' });
  }
  if (result.reason === 'unreachable') {
    return res.status(503).json({ success: false, error: 'Could not reach the security service. Please try again.' });
  }
  if (result.reason === 'rejected') console.warn('[turnstile] rejected:', (result.codes || []).join(','));
  return res.status(403).json({ success: false, error: 'Security check failed. Please try again.' });
}));

export default router;
00;

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
