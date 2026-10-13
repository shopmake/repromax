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
