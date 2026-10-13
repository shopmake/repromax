// routes/auth.js — PUBLIC (signed-out) endpoints used by login.php and passfor.php.
import express from 'express';
import crypto from 'crypto';
import admin from 'firebase-admin';
import { asyncHandler } from '../src/asyncHandler.js';
import { getFirebaseApp, db, userCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { verifyTurnstile } from '../src/turnstile.js';
import { STORE_NAME } from '../src/store.js';

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

// ===================================================================
// FORGOT PASSWORD (email OTP)  — used by passfor.php
//   1. send-otp   (Turnstile-gated) → emails a 6-digit code via Brevo
//   2. verify-otp                    → returns a short-lived resetToken
//   3. reset                         → sets the new password
// OTPs and reset tokens are stored only as HMAC hashes in Firestore
// (collection `passwordResetOtps`). Needs in the environment:
//   BREVO_API_KEY, BREVO_SENDER_EMAIL, (BREVO_SENDER_NAME), PASSWORD_RESET_SECRET
// ===================================================================
const OTP_TTL_MS = 10 * 60 * 1000;
const RESET_TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MIN_PASSWORD = 8;
const COL = 'passwordResetOtps';

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function secret() { return process.env.PASSWORD_RESET_SECRET || process.env.ADMIN_SECRET || 'change-this-secret'; }
function hash(value) { return crypto.createHmac('sha256', secret()).update(String(value)).digest('hex'); }
function randomOtp() { return String(crypto.randomInt(100000, 1000000)); }
function randomToken() { return crypto.randomBytes(32).toString('hex'); }
function docId(email) { return hash(`email:${email}`); }
function htmlEsc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Same Turnstile check as the login page, but as middleware (the token
// travels in the request body as `turnstileToken`).
async function requireTurnstile(req, res, next) {
  const result = await verifyTurnstile(req.body?.turnstileToken, req.ip);
  if (result.ok) return next();
  if (result.reason === 'not-configured') {
    console.error('[turnstile] TURNSTILE_SECRET_KEY is not set — refusing the request.');
    return res.status(503).json({ success: false, error: 'Security check is not configured on the server.' });
  }
  if (result.reason === 'missing-token') {
    return res.status(400).json({ success: false, error: 'Verification check missing. Please refresh the page and try again.' });
  }
  if (result.reason === 'unreachable') {
    return res.status(503).json({ success: false, error: 'Could not reach the security service. Please try again.' });
  }
  console.warn('[turnstile] rejected:', (result.codes || []).join(','));
  return res.status(403).json({ success: false, error: 'Verification failed. Please try again.' });
}

async function sendOtpEmail(email, otp) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || STORE_NAME;
  if (!apiKey) throw new Error('BREVO_API_KEY is not configured');
  if (!senderEmail) throw new Error('BREVO_SENDER_EMAIL is not configured');
  const name = htmlEsc(STORE_NAME);

  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email }],
      subject: `${STORE_NAME} — Password Reset OTP`,
      textContent: `Your ${STORE_NAME} password reset OTP is: ${otp}\n\nThis OTP expires in 10 minutes.\n\nIf you did not request a password reset, ignore this email.`,
      htmlContent: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;background:#111;color:#fff;border-radius:14px"><h2>${name}</h2><p>Your password reset OTP is:</p><div style="font-size:32px;font-weight:800;letter-spacing:8px;text-align:center;padding:18px;background:#1d1730;border-radius:12px">${otp}</div><p>This OTP expires in <b>10 minutes</b>.</p><p>If you did not request a password reset, ignore this email.</p></div>`,
    }),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Brevo send failed (${r.status}): ${body.slice(0, 300)}`);
  }
}

// POST /api/auth/forgot-password/send-otp   Body: { email, turnstileToken }
// Turnstile-gated: it is the one unauthenticated action that triggers a real
// outbound email, which is exactly what bots target for email-bombing.
router.post('/forgot-password/send-otp', rateLimit({ windowMs: 60_000, max: 10, name: 'forgot-send' }), requireTurnstile, asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!validEmail(email)) return res.status(400).json({ success: false, error: 'Enter a valid email address.' });

  const GENERIC = 'If this email belongs to an account, an OTP has been sent. Check Gmail and Spam.';
  const ref = db().collection(COL).doc(docId(email));
  const old = await ref.get();
  if (old.exists) {
    const sentAt = Number((old.data() || {}).sentAtMs || 0);
    if (sentAt && Date.now() - sentAt < RESEND_MS) return res.json({ success: true, message: GENERIC });
  }

  // Do not reveal whether an email exists.
  let user;
  try { getFirebaseApp(); user = await admin.auth().getUserByEmail(email); }
  catch (e) {
    if (e?.code === 'auth/user-not-found') return res.json({ success: true, message: GENERIC });
    console.error('[forgot-password] lookup failed:', e);
    return res.status(500).json({ success: false, error: 'Unable to process the request right now.' });
  }

  const otp = randomOtp();
  const now = Date.now();
  try {
    await sendOtpEmail(email, otp);
    await ref.set({
      email, uid: user.uid, otpHash: hash(`otp:${otp}`), sentAtMs: now,
      expiresAtMs: now + OTP_TTL_MS, attempts: 0, verifiedUntilMs: 0, resetTokenHash: '',
    });
  } catch (e) {
    console.error('[forgot-password] mail failed:', e);
    return res.status(500).json({ success: false, error: 'Could not send the OTP email. Please try again later.' });
  }

  res.json({ success: true, message: 'OTP sent. Check your Gmail Inbox and Spam folder.' });
}));

// POST /api/auth/forgot-password/verify-otp   Body: { email, otp }
router.post('/forgot-password/verify-otp', rateLimit({ windowMs: 60_000, max: 20, name: 'forgot-verify' }), asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || '').trim();
  if (!validEmail(email) || !/^\d{6}$/.test(otp)) return res.status(400).json({ success: false, error: 'Enter the email and 6-digit OTP.' });

  const ref = db().collection(COL).doc(docId(email));
  const snap = await ref.get();
  if (!snap.exists) return res.status(400).json({ success: false, error: 'OTP expired or not found. Request a new OTP.' });
  const data = snap.data() || {};
  if (Date.now() > Number(data.expiresAtMs || 0)) {
    await ref.delete();
    return res.status(400).json({ success: false, error: 'OTP expired. Request a new OTP.' });
  }
  const attempts = Number(data.attempts || 0);
  if (attempts >= MAX_ATTEMPTS) return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Request a new OTP.' });
  if (hash(`otp:${otp}`) !== data.otpHash) {
    await ref.set({ attempts: attempts + 1 }, { merge: true });
    return res.status(400).json({ success: false, error: `Incorrect OTP. ${Math.max(0, MAX_ATTEMPTS - attempts - 1)} attempts remaining.` });
  }

  const resetToken = randomToken();
  await ref.set({ verifiedUntilMs: Date.now() + RESET_TTL_MS, resetTokenHash: hash(`reset:${resetToken}`), attempts: 0 }, { merge: true });
  res.json({ success: true, resetToken });
}));

// POST /api/auth/forgot-password/reset   Body: { email, resetToken, password }
router.post('/forgot-password/reset', rateLimit({ windowMs: 60_000, max: 10, name: 'forgot-reset' }), asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const resetToken = String(req.body?.resetToken || '');
  const password = String(req.body?.password || '');
  if (!validEmail(email) || !resetToken || password.length < MIN_PASSWORD) {
    return res.status(400).json({ success: false, error: 'Invalid reset request.' });
  }

  const ref = db().collection(COL).doc(docId(email));
  const snap = await ref.get();
  if (!snap.exists) return res.status(400).json({ success: false, error: 'Reset session expired. Start again.' });
  const data = snap.data() || {};
  if (Date.now() > Number(data.verifiedUntilMs || 0) || hash(`reset:${resetToken}`) !== data.resetTokenHash) {
    return res.status(400).json({ success: false, error: 'Reset session expired or invalid. Start again.' });
  }

  try {
    getFirebaseApp();
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(user.uid, { password });
    await ref.delete();
    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (e) {
    console.error('[forgot-password] reset failed:', e);
    res.status(500).json({ success: false, error: 'Could not change the password. Please try again.' });
  }
}));

export default router;
