// routes/employee.js — a deliberately NARROW API for staff accounts.
//
// Why this exists as a separate router instead of just hiding buttons in
// the admin panel: anyone holding ADMIN_SECRET can call EVERY
// /api/admin/* endpoint straight from the browser console, no matter
// what the panel's HTML shows. So the restriction has to be enforced
// here, server-side. This router is gated by its own EMPLOYEE_SECRET and
// exposes exactly four things:
//
//   1. find a user            (balance + name only — no keys, no history)
//   2. ADD balance            (no deduct, no negative amounts, daily limits)
//   3. list products          (name/duration/state only — no prices)
//   4. maintenance / restore  (one flag on one product)
//
// Deliberately NOT available here: price edits, duration edits, product
// create/delete, out-of-stock, redeem codes, announcements,
// rankings, purchase history, deducting balance. Rotating or deleting
// EMPLOYEE_SECRET on Render cuts the employee off instantly without
// touching your own ADMIN_SECRET.
import express from 'express';
import { invalidateUserDoc } from '../src/userCache.js';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireEmployee, adminCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { getMaintenanceOverrides, invalidateMaintenanceCache, getLiveCatalog } from '../src/catalog.js';
import { telegramNotify, esc } from '../src/telegram.js';
import { resolveLimits, dayKey, remaining, checkLoadLimits } from '../src/employeeLimits.js';
import { notifyBalanceChange } from '../src/balanceAlerts.js';

const router = express.Router();
router.use(adminCors);
router.use(rateLimit({ windowMs: 60_000, max: 60, name: 'employee' }));
router.use(requireEmployee);

// Spending limits (per load / per user per day / whole team per day).
// See src/employeeLimits.js. Set on Render; 0 turns a limit off.
const LIMITS = resolveLimits();

// One Firestore doc per Nepal-time day: { total, byUser: { [uid]: n } }.
const dayRef = () => db().collection('employeeLoads').doc(dayKey());

async function loadedToday(uid) {
  const snap = await dayRef().get();
  const d = snap.exists ? snap.data() : {};
  return { dayLoadedToday: Number(d.total || 0), userLoadedToday: Number(d.byUser?.[uid] || 0) };
}

// GET /api/employee/ping — lets the panel verify the key on connect,
// and tells it the per-load limit so the UI can show it.
router.get('/ping', asyncHandler(async (req, res) => {
  const { dayLoadedToday } = await loadedToday('');
  res.json({
    success: true, role: 'employee',
    maxLoad: Number.isFinite(LIMITS.perLoad) ? LIMITS.perLoad : null,
    ...remaining({ dayLoadedToday, limits: LIMITS }),
  });
}));

// GET /api/employee/lookup?q=<uid or email>
// Returns the bare minimum needed to load balance safely: who they are
// and their current balance. Unlike /api/admin/lookup it does NOT return
// purchase history (which contains delivered license keys), top-up
// requests, admin logs, or phone numbers.
router.get('/lookup', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ success: false, error: 'Enter a UID or email' });

  let snap;
  if (q.includes('@')) {
    const found = await db().collection('users').where('email', '==', q).limit(1).get();
    if (found.empty) return res.json({ success: true, found: false });
    snap = found.docs[0];
  } else {
    snap = await db().collection('users').doc(q).get();
    if (!snap.exists) return res.json({ success: true, found: false });
  }

  const d = snap.data();
  const today = await loadedToday(snap.id);
  res.json({
    success: true,
    found: true,
    uid: snap.id,
    email: d.email || '',
    profileName: d.profileName || '',
    balance: Number(d.balance || 0),
    ...remaining({ ...today, limits: LIMITS }),
  });
}));

// POST /api/employee/load-balance  { uid, amount, note? }
// ADD-ONLY. There is intentionally no direction field and no way to
// pass a negative amount — employees can credit an account but never
// remove money from one.
router.post('/load-balance', asyncHandler(async (req, res) => {
  const uid = String(req.body?.uid || '').trim();
  const amount = Number(req.body?.amount);
  const note = String(req.body?.note || '').trim().slice(0, 120);

  if (!uid) return res.status(400).json({ success: false, error: 'Missing user' });
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Enter a whole number greater than 0' });
  }
  // Cheap early exit for the obvious case; the real (race-safe) check
  // for all three limits happens inside the transaction below.
  if (amount > LIMITS.perLoad) {
    const v = checkLoadLimits({ amount, limits: LIMITS });
    return res.status(400).json({ success: false, error: v.error });
  }

  const userRef = db().collection('users').doc(uid);
  const todayRef = dayRef();
  const result = await db().runTransaction(async (tx) => {
    // All reads first (Firestore requires reads before writes).
    const [snap, daySnap] = await Promise.all([tx.get(userRef), tx.get(todayRef)]);
    if (!snap.exists) throw new Error('User not found');

    const day = daySnap.exists ? daySnap.data() : {};
    const dayLoadedToday = Number(day.total || 0);
    const userLoadedToday = Number(day.byUser?.[uid] || 0);
    const verdict = checkLoadLimits({ amount, userLoadedToday, dayLoadedToday, limits: LIMITS });
    if (!verdict.ok) throw new Error(verdict.error);

    const data = snap.data();
    const before = Number(data.balance || 0);
    const after = before + amount;

    const log = data.adminLog || [];
    log.push({
      delta: amount,
      note: `[employee] ${note || 'Balance load'}`,
      resultingBalance: after,
      at: new Date().toISOString(),
    });

    tx.set(userRef, { balance: after, adminLog: log }, { merge: true });
    tx.set(todayRef, {
      total: dayLoadedToday + amount,
      byUser: { [uid]: userLoadedToday + amount },
      updatedAt: Date.now(),
    }, { merge: true });

    return {
      before, after, email: data.email || '',
      ...remaining({ userLoadedToday: userLoadedToday + amount, dayLoadedToday: dayLoadedToday + amount, limits: LIMITS }),
    };
  }).catch((e) => ({ error: e.message }));

  if (result.error) return res.status(400).json({ success: false, error: result.error });
  invalidateUserDoc(uid); // balance changed — cached readers must not serve the old one

  // Audit trail to the owner's dedicated balance-load Telegram channel —
  // every employee load is visible to you in real time, and also stamped
  // "[employee]" in the user's adminLog so it shows in the owner panel too.
  notifyBalanceChange({
    actor: 'EMPLOYEE', kind: 'load',
    uid, email: result.email, amount, before: result.before, after: result.after, note,
    extraLines: [
      `📅 Loaded to this user today: NRP ${Number(result.userLoadedToday).toLocaleString('en-US')}`,
      `👥 Team total today: NRP ${Number(result.dayLoadedToday).toLocaleString('en-US')}`,
    ],
  });

  res.json({
    success: true, newBalance: result.after,
    userLoadedToday: result.userLoadedToday, dayLoadedToday: result.dayLoadedToday,
    userLeftToday: result.userLeftToday, dayLeft: result.dayLeft, maxNow: result.maxNow,
  });
}));

// GET /api/employee/products — names + maintenance state only. Prices,
// pids, images and tags are deliberately left out: the employee has no
// use for them and no way to change them.
router.get('/products', asyncHandler(async (req, res) => {
  const [overrides, catalog] = await Promise.all([getMaintenanceOverrides(), getLiveCatalog()]);

  const products = Object.keys(catalog)
    .filter((sku) => catalog[sku].type !== 'whatsapp')
    .map((sku) => {
      const p = catalog[sku];
      const o = overrides[sku];
      const maintenance = o ? !!o.maintenance : !!p.maintenance;
      return { sku, row: p.row, name: p.name, duration: p.duration, maintenance };
    });

  res.json({ success: true, products });
}));

// POST /api/employee/products/:sku/maintenance  { maintenance: boolean, message? }
// Same effect as the owner endpoint — one flag on productStatus/{sku} —
// but scoped to just this. Restoring (maintenance:false) is the same call.
router.post('/products/:sku/maintenance', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  const catalog = await getLiveCatalog();
  if (!catalog[sku]) return res.status(404).json({ success: false, error: 'Unknown product' });

  const maintenance = !!req.body?.maintenance;
  const message = String(req.body?.message || '').trim();
  if (message.length > 300) return res.status(400).json({ success: false, error: 'Keep the message under 300 characters' });

  await db().collection('productStatus').doc(sku).set({
    maintenance,
    maintenanceMessage: maintenance ? (message || 'This product is temporarily under maintenance.') : null,
    updatedAt: Date.now(),
  }, { merge: true });

  invalidateMaintenanceCache();

  telegramNotify(
    `🛠 <b>EMPLOYEE ${maintenance ? 'PUT IN MAINTENANCE' : 'RESTORED'}</b>\n` +
    `Product: ${esc(catalog[sku].name || sku)}\n` +
    `SKU: <code>${esc(sku)}</code>`
  );

  res.json({ success: true, sku, maintenance });
}));

export default router;
