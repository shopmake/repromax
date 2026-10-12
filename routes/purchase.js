// routes/purchase.js — instant checkout.
//
// Flow (the upstream call is deliberately OUTSIDE any Firestore transaction —
// Firestore may retry a transaction, and a retried transaction that contained a
// paid upstream purchase could buy the same key twice):
//
//   1. check the request (product exists, not in maintenance / out of stock)
//   2. DEBIT the price atomically (one transaction, also writes the order record)
//   3. buy the key from the upstream store with a unique request_id
//   4. success -> save it to the buyer's history      failure -> REFUND the price
import express from 'express';
import crypto from 'crypto';
import admin from 'firebase-admin';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { findProductFresh, getMaintenanceForSku } from '../src/catalog.js';
import { telegramNotify, telegramFormat } from '../src/telegram.js';
import { fetchRealKey, UpstreamError } from '../src/upstream.js';
import { invalidateUserDoc } from '../src/userCache.js';
import { leaderboardCache } from '../src/sharedCaches.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

// ============================================================
//  In‑memory job tracker (the browser polls it for progress)
// ============================================================
const jobs = new Map();
const JOB_TTL_MS = 5 * 60 * 1000;

function setJob(jobId, patch) {
  jobs.set(jobId, { ...(jobs.get(jobId) || {}), ...patch });
}

/** Shared by the pre-check and the job: why can't this product be bought right now? (null = it can) */
async function unavailableReason(product, sku, androidId) {
  const live = await getMaintenanceForSku(sku);
  if (product.maintenance || live.maintenance) {
    return live.maintenanceMessage || product.maintenanceMessage || 'This product is currently under maintenance.';
  }
  if (product.outOfStock || live.outOfStock) {
    return live.outOfStockMessage || product.outOfStockMessage || 'This duration is currently out of stock.';
  }
  if (product.type === 'manual' || product.type === 'whatsapp') {
    return 'This product is ordered through chat, not instant checkout.';
  }
  if (product.requiresAndroidId && !androidId) return 'Android ID is required for this product';
  return null;
}

// ============================================================
//  POST /checkout/start
// ============================================================
router.post('/checkout/start', asyncHandler(async (req, res) => {
  const sku = String(req.body?.sku || '');
  const buyerName = String(req.body?.name || '').trim().slice(0, 80);
  const buyerWa = String(req.body?.waNum || '').trim().slice(0, 40);
  const androidId = req.body?.android_id ? String(req.body.android_id).trim().slice(0, 64) : null;

  if (!sku) {
    return res.status(400).json({ success: false, error: 'Missing product selection. Please pick a duration and try again.' });
  }
  if (androidId && !/^[A-Za-z0-9_\-:.]{1,64}$/.test(androidId)) {
    return res.status(400).json({ success: false, error: 'Android ID contains invalid characters' });
  }

  const product = await findProductFresh(sku);
  if (!product) return res.status(400).json({ success: false, error: 'Unknown product' });

  const blocked = await unavailableReason(product, sku, androidId);
  if (blocked) {
    const status = blocked.startsWith('Android ID') || blocked.includes('chat') ? 400 : 409;
    return res.status(status).json({ success: false, error: blocked });
  }

  // ------------------------------------------------------------------
  // Balance + temporary-ban pre-check, BEFORE a job is created, so a user
  // with too little balance never sees the key-fetch animation.
  // ------------------------------------------------------------------
  {
    const userSnap = await db().collection('users').doc(req.uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const balance = Number(userData.balance || 0);
    const price = Number(product.price);

    // An existing ban always wins ("stop trying for a while").
    const bannedUntil = Number(userData.checkoutBanUntil || 0);
    if (bannedUntil > Date.now()) {
      return res.status(403).json({
        success: false, code: 'CHECKOUT_BANNED',
        error: 'Too many purchase attempts with insufficient balance. Please wait before trying again.',
        bannedUntil,
      });
    }

    if (balance < price) {
      const strikes = Number(userData.lowBalanceStrikes || 0) + 1;
      const updates = { lowBalanceStrikes: strikes };

      // 2nd strike -> 1-hour checkout ban (no cron needed: it simply expires).
      let justBanned = false;
      if (strikes >= 2) {
        updates.checkoutBanUntil = Date.now() + 60 * 60 * 1000;
        updates.lowBalanceStrikes = 0;
        justBanned = true;
      }
      await db().collection('users').doc(req.uid).set(updates, { merge: true });
      invalidateUserDoc(req.uid);

      if (justBanned) {
        telegramNotify(telegramFormat('Checkout Banned (1h)', {
          username: userData.profileName || req.email, email: userData.email || req.email,
          phone: userData.profilePhone || '', product: product.name || sku,
          price, uid: req.uid, status: 'failed',
          others: `2nd insufficient-balance attempt — banned until ${new Date(updates.checkoutBanUntil).toISOString()}`,
        }));
        return res.status(403).json({
          success: false, code: 'CHECKOUT_BANNED',
          error: 'Too many purchase attempts with insufficient balance. Please wait before trying again.',
          bannedUntil: updates.checkoutBanUntil,
        });
      }

      return res.status(402).json({
        success: false, code: 'INSUFFICIENT_BALANCE',
        error: "You don't have enough balance for this product. Please top up first then try again.",
        balance, required: price,
      });
    }

    // Enough balance this time — clear any stale strike so an old one can't ban them later.
    if (Number(userData.lowBalanceStrikes || 0) > 0) {
      await db().collection('users').doc(req.uid).set({ lowBalanceStrikes: 0 }, { merge: true });
      invalidateUserDoc(req.uid);
    }
  }

  const jobId = crypto.randomUUID();
  setJob(jobId, { uid: req.uid, percent: 0, label: 'Queued...', done: false, createdAt: Date.now() });
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);

  res.json({ success: true, jobId });

  runCheckoutJob(jobId, req.uid, req.email, sku, buyerName, buyerWa, androidId);
}));

// ============================================================
//  GET /checkout/status/:jobId
// ============================================================
router.get('/checkout/status/:jobId', asyncHandler(async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or expired', done: true });
  }
  if (job.uid !== req.uid) {
    return res.status(403).json({ success: false, error: 'Not your job', done: true });
  }
  res.json({
    percent: job.percent, label: job.label, done: job.done,
    success: job.success ?? null, key: job.key, newBalance: job.newBalance,
    entry: job.entry, error: job.error,
  });
}));

// ============================================================
//  Background job runner
// ============================================================
async function runCheckoutJob(jobId, uid, email, sku, buyerName, buyerWa, androidId) {
  const userRef = db().collection('users').doc(uid);
  // One id per order: sent to the upstream store AND used as the order record's id.
  // It is reused if the upstream call has to be retried, so a key is never bought twice.
  const requestId = `ord-${jobId}`;
  const orderRef = db().collection('orders').doc(requestId);

  let product = null;
  let price = 0;
  let debited = false;
  let settled = false;

  // The step labels below match the delivery checklist in store.php — keep them in sync.
  setJob(jobId, { percent: 5, label: 'Checking request...' });

  try {
    product = await findProductFresh(sku);
    if (!product) throw new Error('Unknown product');
    price = Number(product.price);

    const blocked = await unavailableReason(product, sku, androidId);
    if (blocked) throw new Error(blocked);

    setJob(jobId, { percent: 20, label: 'Checking product...' });
    telegramNotify(telegramFormat('Purchase attempt', {
      username: buyerName || email, email, phone: buyerWa, product: product.name,
      duration: product.duration, price, uid, status: 'attempt',
    }));

    // ---- debit (atomic: two simultaneous orders can never spend the same money) ----
    setJob(jobId, { percent: 35, label: 'Checking balance...' });
    const { before, after } = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const current = snap.exists ? Number(snap.data().balance || 0) : 0;
      if (current < price) throw new Error('Please top up first then trying 🙏');
      tx.update(userRef, { balance: current - price });
      tx.set(orderRef, {
        orderId: requestId, uid, email, sku, pid: String(product.pid), name: product.name, row: product.row || product.name,
        duration: product.duration, price, androidId: androidId || null,
        status: 'processing', createdAt: Date.now(),
      });
      return { before: current, after: current - price };
    });
    debited = true;
    invalidateUserDoc(uid);

    // ---- buy the key (outside any transaction) ----
    setJob(jobId, { percent: 55, label: 'Connecting to server...' });
    const key = await fetchRealKey(product, { androidId, requestId });
    // Only fires once the upstream really returned a key — not a fake timed step.
    setJob(jobId, { percent: 80, label: 'Server connected...' });

    // ---- settle: save the key to history, update the stats ----
    setJob(jobId, { percent: 90, label: 'Finalizing order...' });
    const entry = {
      at: new Date().toISOString(), sku, row: product.row || product.name, name: product.name,
      duration: product.duration, price, key, buyerName, buyerWa,
    };
    try {
      const batch = db().batch();
      batch.update(userRef, {
        purchaseHistory: admin.firestore.FieldValue.arrayUnion(entry),
        totalKeysBought: admin.firestore.FieldValue.increment(1),
        totalSpent: admin.firestore.FieldValue.increment(price),
      });
      batch.update(orderRef, { status: 'completed', key, finishedAt: Date.now() });
      await batch.commit();
    } catch (e) {
      // The key was bought and paid for, so the customer still gets it — but this needs a human.
      console.error('[purchase] SAVE FAILED after key was bought', requestId, e);
      telegramNotify(`🚨 <b>PURCHASE NOT SAVED — needs manual check</b>\nOrder: <code>${requestId}</code>\nUID: <code>${uid}</code>\nKey: <code>${key}</code>`);
    }
    settled = true;
    invalidateUserDoc(uid);
    leaderboardCache.invalidate();

    setJob(jobId, { percent: 100, label: 'Delivered!', done: true, success: true, key, newBalance: after, entry });
    telegramNotify(telegramFormat('Purchase success', {
      username: buyerName || email, email, phone: buyerWa, product: product.name,
      duration: product.duration, price, key, uid, status: 'success',
      balanceBefore: before, balanceAfter: after,
    }));
  } catch (e) {
    const message = e instanceof UpstreamError || !debited ? e.message : 'Something went wrong. Please try again.';

    // The customer was charged but got no key -> give the money back.
    if (debited && !settled) {
      try {
        const batch = db().batch();
        batch.update(userRef, { balance: admin.firestore.FieldValue.increment(price) });
        batch.update(orderRef, { status: 'refunded', error: String(e?.detail || e?.message || e).slice(0, 300), finishedAt: Date.now() });
        await batch.commit();
        invalidateUserDoc(uid);
      } catch (refundErr) {
        console.error('[purchase] REFUND FAILED', requestId, refundErr);
        telegramNotify(`🚨 <b>REFUND FAILED — refund NRP ${price} manually</b>\nOrder: <code>${requestId}</code>\nUID: <code>${uid}</code>\nEmail: ${email}`);
      }
    }

    if (e instanceof UpstreamError) {
      console.error(`[purchase] upstream problem (${e.code}):`, e.detail || e.message);
      if (e.alertOwner) {
        telegramNotify(`⚠️ <b>UPSTREAM PROBLEM — customers can't buy</b>\nCode: ${e.code}\n${e.detail || e.message}`);
      }
    } else if (debited) {
      console.error('[purchase] unexpected error after debit:', e);
    }

    setJob(jobId, { percent: 100, done: true, success: false, error: message, label: 'Failed' });
    telegramNotify(telegramFormat('Purchase rejected', {
      username: buyerName || email, email, phone: buyerWa, product: product ? product.name : sku,
      duration: product ? product.duration : '', price, uid, status: 'failed',
      others: String(e?.detail || e?.message || e).slice(0, 300) + (debited ? ' (refunded)' : ''),
    }));
  }
}

export default router;
