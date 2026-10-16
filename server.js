import './src/env.js'; // MUST stay first: loads .env before any other module reads process.env
import express from 'express';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';
import purchaseRoutes from './routes/purchase.js';
import employeeRoutes from './routes/employee.js';
import gloryRoutes from './routes/glory.js';
import telegramTopupRoutes from './routes/telegram-topup.js';
import { registerTopupWebhook } from './src/topupQr.js';
import { getLiveCatalog } from './src/catalog.js';
import { userCors } from './src/firebase.js';
import { telegramNotify } from './src/telegram.js';
import { rateLimit, securityHeaders } from './src/security.js';
import { asyncHandler } from './src/asyncHandler.js';
import { policyCache } from './src/sharedCaches.js';
import { startBootstrap } from './src/bootstrap.js';
import { STORE_NAME } from './src/store.js';
import { turnstileConfigured } from './src/turnstile.js';

const app = express();
app.disable('x-powered-by');
// Render sits behind a proxy. Trust only the first proxy hop so attackers
// cannot freely spoof X-Forwarded-For and defeat IP-based rate limiting.
app.set('trust proxy', 1);

app.use(securityHeaders);
// The profile-picture upload carries a small base64 image (the browser sends a
// cropped square), so that ONE route gets a bigger body limit. It must be
// registered BEFORE the global 16kb parser, which would otherwise reject it.
app.use('/api/user/avatar', express.json({ limit: '800kb' }));
// Keep every other request body tiny. This API only accepts small JSON payloads.
app.use(express.json({ limit: '16kb' }));

// Baseline abuse protection for every API endpoint. Route-specific limits
// below are stricter for expensive/sensitive operations.
app.use('/api', rateLimit({ windowMs: 60_000, max: 180, name: 'api' }));

// Catch bad JSON bodies with a clean response instead of a stack trace.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Invalid JSON body' });
  }
  next(err);
});

// ---- Connection logger ----
// Always notifies on errors/unauthorized attempts (401/403/5xx) — the
// "who's poking at my backend" signal you actually want. Set
// NOTIFY_ALL_REQUESTS=true on Render if you also want a ping for
// every successful request too — off by default because your own
// store polls /api/user/balance every 20s per visitor, which would
// otherwise flood your phone with routine traffic, not just problems.
const NOTIFY_ALL_REQUESTS = process.env.NOTIFY_ALL_REQUESTS === 'true';
const securityAlertSeen = new Map();
const SECURITY_ALERT_TTL = 60_000;

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const isProblem = res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 429 || res.statusCode >= 500;
    if (!isProblem && !NOTIFY_ALL_REQUESTS) return;

    // Never let an attacker turn the alert logger into a Telegram spam cannon.
    const alertKey = `${req.ip}|${req.method}|${req.path}|${res.statusCode}`;
    const now = Date.now();
    if (isProblem) {
      const last = securityAlertSeen.get(alertKey) || 0;
      if (now - last < SECURITY_ALERT_TTL) return;
      securityAlertSeen.set(alertKey, now);
      for (const [k, t] of securityAlertSeen) {
        if (now - t > SECURITY_ALERT_TTL * 2) securityAlertSeen.delete(k);
      }
    }

    const origin = req.headers.origin || req.headers.referer || '—';
    const emoji = isProblem ? '🚨' : '📡';
    telegramNotify(
      `${emoji} <b>${req.method} ${req.path}</b>\n` +
      `IP: <code>${req.ip}</code>\n` +
      `Origin: ${origin}\n` +
      `Status: <b>${res.statusCode}</b>\n` +
      `${Date.now() - start}ms`
    );
  });
  next();
});

app.get('/', (req, res) => {
  res.status(200).json({ success: true, status: 'online', store: STORE_NAME });
});

// GET /health — a deliberately trivial endpoint (no Firebase call, no
// auth, no rate limit) for an external uptime pinger to hit every few
// minutes. Render's FREE tier spins the whole service down after ~15
// minutes with no traffic; the next real request then has to cold-boot
// Node + firebase-admin from scratch, which routinely takes long enough
// for Render's own proxy to give up and return 502 to the browser before
// the app finishes booting. That 502 is a platform-level timeout, not a
// bug in this code — nothing server-side can make a sleeping free
// instance wake up faster. The fix is to stop it from sleeping: point a
// free uptime monitor (UptimeRobot, cron-job.org, etc.) at this URL every
// 5-10 minutes so the service never goes cold in the first place.
app.get('/health', (req, res) => {
  res.status(200).json({ success: true, status: 'awake', uptime: process.uptime() });
});

// Public — the display catalog (one price list for everyone). Checkout always
// re-reads the price from Firestore server-side, so this is display only.
app.get('/api/catalog', userCors, asyncHandler(async (req, res) => {
  const catalog = await getLiveCatalog();
  res.json({ success: true, catalog });
}));

// GET /api/policy — public, unauthenticated, read-only. Powers the (!)
// button on login.php (which must work for signed-out visitors) and the
// forced first-login popup on dashboard.php. The text itself lives in
// one Firestore doc (config/policy) edited ONLY through the admin panel's
// POST /api/admin/policy — there's no way to change it from the browser:
// a devtools edit to this response is local to that one tab/session and
// is simply overwritten the next time any page calls this endpoint fresh.
app.get('/api/policy', userCors, asyncHandler(async (req, res) => {
  // Cached (admin edits invalidate it) — this is a public, unauthenticated
  // endpoint, so without a cache every visitor was one Firestore read.
  res.json({ success: true, ...(await policyCache.get()) });
}));

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/employee', employeeRoutes);
app.use('/api/purchase', purchaseRoutes);
app.use('/api/glory', gloryRoutes);
// Telegram bot: Load ✅ / Cancel ❌ for Khalti & eSewa top-ups + /loadbalance /getinfo /mode /creategiftcards.
app.use('/api/telegram', telegramTopupRoutes);

// Last-resort error handler — same job as firebase.php's shutdown
// handler: never let a raw stack trace leak to the client, always
// respond with clean JSON.
app.use((err, req, res, next) => {
  console.error('[store-backend] Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Internal server error. Please try again.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${STORE_NAME} backend listening on port ${PORT}`);
  // Creates the few documents the app reads before anyone has written them
  // (config/policy, config/store). Everything else is created on first use.
  startBootstrap();
  registerTopupWebhook().catch(() => {});
  if (!turnstileConfigured()) console.warn('[turnstile] TURNSTILE_SECRET_KEY is not set — the login page cannot verify visitors until you add it.');
});
