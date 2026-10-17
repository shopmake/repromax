// src/firebase.js — the trust boundary. Verifies WHO is calling, and
// gives access to Firestore with full admin trust (bypassing Security
// Rules — which deny direct client access entirely, so this backend
// is the ONLY way in or out of your data).
//
// SETUP:
// 1. Firebase Console → Project Settings → Service Accounts →
//    Generate new private key (use the NEW project's key).
// 2. Render → your service → Environment → FIREBASE_SERVICE_ACCOUNT_JSON
//    = the entire contents of that JSON file.
//
// Nothing here needs a compiled extension — firebase-admin's Firestore
// client uses @grpc/grpc-js, a pure-JS gRPC implementation. No PECL,
// no build step, no 40-minute Render deploys.

import admin from 'firebase-admin';
import cors from 'cors';
import crypto from 'crypto';

let app = null;

export function getFirebaseApp() {
  if (app) return app;

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) {
    throw new Error('Server misconfigured: FIREBASE_SERVICE_ACCOUNT_JSON is not set');
  }
  let creds;
  try {
    creds = JSON.parse(json);
  } catch (e) {
    throw new Error('Server misconfigured: FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  app = admin.initializeApp({ credential: admin.credential.cert(creds) });
  return app;
}

export function db() {
  getFirebaseApp();
  return admin.firestore();
}

/**
 * Express middleware — verifies the Firebase ID token from the
 * Authorization header and attaches req.uid / req.email. Sends a 401
 * and stops the request if the token is missing or invalid.
 */
export async function requireFirebaseUid(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ success: false, error: 'Missing Authorization header' });
  }
  try {
    getFirebaseApp();
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.uid = decoded.uid;
    req.email = decoded.email || '';
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Invalid or expired login. Please refresh and try again.' });
  }
}

/**
 * Express middleware — checks the X-Admin-Secret header against
 * ADMIN_SECRET. Used on every /api/admin/* route. Uses a constant-time
 * comparison so a mismatch can't be timed character-by-character —
 * naive string !== returns faster the earlier the first wrong
 * character is, which is a real (if slow) side channel over a network.
 */
export function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_SECRET;
  const given = String(req.headers['x-admin-secret'] || '');

  if (!expected || !timingSafeStringEqual(given, expected)) {
    return res.status(401).json({ success: false, error: 'Not authorized' });
  }
  next();
}

/**
 * Same idea as requireAdmin, but checks X-Employee-Secret against
 * EMPLOYEE_SECRET. Only used by routes/employee.js. It is a completely
 * separate secret from ADMIN_SECRET and deliberately does NOT accept
 * the admin secret as a fallback: an employee key must never unlock
 * more than the employee router, and the owner's key isn't needed here.
 * Unset EMPLOYEE_SECRET => the employee router rejects everything.
 */
export function requireEmployee(req, res, next) {
  const expected = process.env.EMPLOYEE_SECRET;
  const given = String(req.headers['x-employee-secret'] || '');

  if (!expected || !timingSafeStringEqual(given, expected)) {
    return res.status(401).json({ success: false, error: 'Not authorized' });
  }
  next();
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Buffers of different lengths would throw in timingSafeEqual; padding
  // one to match keeps the whole check constant-time (the length check
  // itself is a much weaker signal than a per-character compare, and
  // still gated behind the full buffer comparison below).
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Browser CORS for the storefront. Calls are authenticated with a Firebase ID token
// in the Authorization header (no cookies), so CORS is a convenience, not the
// security boundary.
//   FRONTEND_ORIGINS  optional, comma-separated, e.g. "https://mystore.com,https://www.mystore.com"
//                     When set, ONLY those origins may call the API from a browser.
//                     When unset, any origin is allowed (so a fresh deploy just works).
const FRONTEND_ORIGINS = String(process.env.FRONTEND_ORIGINS || '')
  .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);

export const userCors = cors({
  origin(origin, cb) {
    if (!origin || FRONTEND_ORIGINS.length === 0) return cb(null, true); // server-to-server, or no allow-list configured
    cb(null, FRONTEND_ORIGINS.includes(origin));
  },
});

// Admin panel can be hosted anywhere — including a local dev server —
// it's gated by ADMIN_SECRET instead of by origin, so CORS here just
// reflects whatever origin asks rather than maintaining an allowlist.
export const adminCors = cors({ origin: true });