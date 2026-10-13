import express from 'express';
import crypto from 'crypto';
import { import express from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireAdmin, adminCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { getMaintenanceOverrides, invalidateMaintenanceCache, getLiveCatalog, invalidateProductCache, findProductFresh, getProductRaw, deleteProduct, invalidateWhatsappProductCache, getWhatsappProductRaw, deleteWhatsappProduct } from '../src/catalog.js';
import { telegramNotify, telegramFormat } from '../src/telegram.js';
import { notifyBalanceChange } from '../src/balanceAlerts.js';
import { OWNER_ACCOUNT } from '../src/store.js';
import { invalidateUserDoc, invalidateAllUserDocs } from '../src/userCache.js';
import { announcementCache, policyCache, leaderboardCache } from '../src/sharedCaches.js';
import { normalizeUrlField, RuleError } from '../src/profileRules.js';
import { getStock, setStock } from '../src/gloryStock.js';

const router = express.Router();
router.use(adminCors);
// Tighter than the generic 180/min API-wide limit — this whole router
// moves money and account state, so it's worth its own ceiling. The
// real defense is still ADMIN_SECRET's own entropy (no rate limit makes
// guessing a long random secret feasible); this mainly bounds the blast
// radius of a leaked/compromised admin client going haywire.
router.use(rateLimit({ windowMs: 60_000, max: 90, name: 'admin' }));
router.use(requireAdmin);

const EMPTY_USER = (uid, email = '') => ({
  success: true, uid, found: false,
  balance: 0, email, adminLog: [], purchases: [],
  topupRequests: [], requestStatus: 'Active', adminMessage: '',
  profileName: '', profilePhone: '',
});

// GET /api/admin/lookup?uid=... or ?email=...
router.get('/lookup', asyncHandler(async (req, res) => {
  const uidParam = String(req.query.uid || '').trim();
  const emailParam = String(req.query.email || '').trim();
  if (!uidParam && !emailParam) {
    return res.status(400).json({ success: false, error: 'Provide a uid or email' });
  }

  let uid = uidParam;
  let snap;

  if (uid) {
    snap = await db().collection('users').doc(uid).get();
  } else {
    const q = await db().collection('users').where('email', '==', emailParam).limit(1).get();
    if (q.empty) return res.json(EMPTY_USER('', emailParam));
    snap = q.docs[0];
    uid = snap.id;
  }

  if (!snap.exists) return res.json(EMPTY_USER(uid));

  const data = snap.data();
  res.json({
    success: true, uid, found: true,
    balance: Number(data.balance || 0),
    email: data.email || '',
    adminLog: [...(data.adminLog || [])].reverse().slice(0, 50),
    purchases: [...(data.purchaseHistory || [])].reverse().slice(0, 50),
    topupRequests: [...(data.topupRequests || [])].reverse().slice(0, 50),
    requestStatus: data.requestStatus || 'Active',
    adminMessage: data.adminMessage || '',
    profileName: data.profileName || '',
    profilePhone: data.profilePhone || '',
  });
}));

// POST /api/admin/adjust-balance  { uid, amount, direction: "add"|"deduct", note }
router.post('/adjust-balance', asyncHandler(async (req, res) => {
  const uid = String(req.body?.uid || '').trim();
  const amount = parseInt(req.body?.amount, 10);
  const direction = String(req.body?.direction || 'add');
  const note = String(req.body?.note || '').trim();

  if (!uid) return res.status(400).json({ success: false, error: 'Provide a uid' });
  if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Enter a valid amount' });
  if (!['add', 'deduct'].includes(direction)) {
    return res.status(400).json({ success: false, error: 'direction must be "add" or "deduct"' });
  }

  const userRef = db().collection('users').doc(uid);
  try {
    let beforeBalance = 0;
    let userEmail = '';
    const newBalance = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const current = snap.exists ? Number(snap.data().balance || 0) : 0;
      const delta = direction === 'add' ? amount : -amount;
      const updated = current + delta;
      if (updated < 0) throw new Error('That would take the balance negative');

      const log = snap.exists ? (snap.data().adminLog || []) : [];
      log.push({ delta, note, resultingBalance: updated, at: new Date().toISOString() });

      tx.set(userRef, { balance: updated, adminLog: log }, { merge: true });
      beforeBalance = current;
      userEmail = snap.exists ? (snap.data().email || '') : '';
      return updated;
    });
    invalidateUserDoc(uid);
    res.json({ success: true, newBalance });

    // Telegram alert on the dedicated balance-load channel (after the
    // response, so a slow/failed Telegram call can never delay or fail
    // the actual balance change).
    notifyBalanceChange({
      actor: 'ADMIN', kind: direction === 'add' ? 'load' : 'deduct',
      uid, email: userEmail, amount, before: beforeBalance, after: newBalance, note,
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
}));

// POST /api/admin/set-status  { uid, requestStatus?, adminMessage? }
router.post('/set-status', asyncHandler(async (req, res) => {
  const uid = String(req.body?.uid || '').trim();
  if (!uid) return res.status(400).json({ success: false, error: 'Provide a uid' });

  const allowed = ['Active', 'Pending', 'Rejected', 'Banned'];
  const update = {};

  if (Object.prototype.hasOwnProperty.call(req.body, 'requestStatus')) {
    if (!allowed.includes(req.body.requestStatus)) {
      return res.status(400).json({ success: false, error: `requestStatus must be one of: ${allowed.join(', ')}` });
    }
    update.requestStatus = req.body.requestStatus;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'adminMessage')) {
    update.adminMessage = String(req.body.adminMessage);
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ success: false, error: 'Nothing to update' });
  }

  await db().collection('users').doc(uid).set(update, { merge: true });
  invalidateUserDoc(uid);
  res.json({ success: true });
}));

// POST /api/admin/topup-review  { uid, txCode, action: "approve"|"reject" }
router.post('/topup-review', asyncHandler(async (req, res) => {
  const uid = String(req.body?.uid || '').trim();
  const txCode = String(req.body?.txCode || '').trim().toUpperCase();
  const action = String(req.body?.action || '');

  if (!uid || !txCode) return res.status(400).json({ success: false, error: 'Provide uid and txCode' });
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ success: false, error: 'action must be "approve" or "reject"' });
  }

  const userRef = db().collection('users').doc(uid);
  let approvedAmount = 0;
  try {
    const newBalance = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error('User not found');
      const data = snap.data();
      const requests = data.topupRequests || [];

      let found = false;
      let amount = 0;
      const updatedRequests = requests.map((r) => {
        if (!found && r.txCode === txCode && r.status === 'PENDING') {
          found = true;
          amount = Number(r.amount || 0);
          approvedAmount = amount;
          return { ...r, status: action === 'approve' ? 'APPROVED' : 'REJECTED', reviewedAt: new Date().toISOString() };
        }
        return r;
      });

      if (!found) throw new Error('No matching PENDING request with that transaction code');

      const update = { topupRequests: updatedRequests };
      let balance = Number(data.balance || 0);

      if (action === 'approve') {
        balance += amount;
        const log = data.adminLog || [];
        log.push({
          delta: amount, note: `Top-up approved (txCode: ${txCode})`,
          resultingBalance: balance, at: new Date().toISOString(),
        });
        update.balance = balance;
        update.adminLog = log;
      }

      tx.set(userRef, update, { merge: true });
      return balance;
    });
    invalidateUserDoc(uid);
    res.json({ success: true, newBalance });
    if (action === 'approve') {
      // Admin credited a customer's top-up: same dedicated channel as
      // every other staff balance load.
      notifyBalanceChange({
        actor: 'ADMIN', kind: 'load', title: 'TOP-UP APPROVED',
        uid, amount: approvedAmount, before: newBalance - approvedAmount, after: newBalance,
        note: `TX code: ${txCode}`,
      });
    } else {
      // Rejections aren't a balance load — left exactly as before.
      telegramNotify(telegramFormat('Balance Load Rejected', { username: uid, product: OWNER_ACCOUNT, price: 0, uid, status: 'failed', others: `TX code: ${txCode}` }), 'balance');
    }
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
}));

// POST /api/admin/backfill-stats — one-time (safe to re-run) job that
// recomputes totalKeysBought/totalSpent for every user from their
// existing purchaseHistory array, for users who bought keys before
// the leaderboard feature started tracking these fields going forward.
router.post('/backfill-stats', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').get();
  let updated = 0;
  const batchSize = 400;
  let batch = db().batch();
  let inBatch = 0;

  for (const doc of snap.docs) {
    const history = doc.data().purchaseHistory || [];
    const totalKeysBought = history.length;
    const totalSpent = history.reduce((sum, h) => sum + (Number(h.price) || 0), 0);
    batch.set(doc.ref, { totalKeysBought, totalSpent }, { merge: true });
    inBatch++;
    updated++;
    if (inBatch >= batchSize) {
      await batch.commit();
      batch = db().batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) await batch.commit();
  invalidateAllUserDocs();
  leaderboardCache.invalidate();

  res.json({ success: true, usersUpdated: updated });
}));

// ---------------------------------------------------------------
// Products / maintenance — products live in Firestore (products/{sku}); the
// maintenance / out-of-stock flags live in productStatus/{sku}, so toggling
// one never needs a code deploy — see src/catalog.js for how they are merged
// into what the storefront sees. One price per product (no roles).
// ---------------------------------------------------------------

// GET /api/admin/products — every product with its current live
// maintenance/stock status, for the admin panel's product manager.
router.get('/products', asyncHandler(async (req, res) => {
  const liveCatalog = await getLiveCatalog();
  const skus = Object.keys(liveCatalog).filter((sku) => liveCatalog[sku].type !== 'whatsapp'); // chat-to-buy products have their own list below

  const products = skus.map((sku) => {
    const p = liveCatalog[sku];
    return {
      sku, pid: p.pid, row: p.row, name: p.name, duration: p.duration, image: p.image,
      price: p.price,
      downloadLink: p.downloadLink || '',
      tags: Array.isArray(p.tags) ? p.tags : [],
      maintenance: !!p.maintenance,
      maintenanceMessage: p.maintenance ? (p.maintenanceMessage || 'This product is temporarily under maintenance.') : null,
      outOfStock: !!p.outOfStock,
      outOfStockMessage: p.outOfStock ? (p.outOfStockMessage || 'Out of stock — check back soon.') : null,
    };
  });

  res.json({ success: true, products });
}));

// POST /api/admin/products/:sku/maintenance
// Body: { maintenance: boolean, message?: string }
router.post('/products/:sku/maintenance', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  const liveCatalog = await getLiveCatalog();
  if (!liveCatalog[sku]) {
    return res.status(404).json({ success: false, error: 'Unknown sku' });
  }

  const maintenance = !!req.body?.maintenance;
  const message = String(req.body?.message || '').trim();
  if (message.length > 300) return res.status(400).json({ success: false, error: 'Keep the message under 300 characters' });

  await db().collection('productStatus').doc(sku).set({
    maintenance,
    maintenanceMessage: maintenance ? (message || 'This product is temporarily under maintenance.') : null,
    updatedAt: Date.now(),
  }, { merge: true });

  invalidateMaintenanceCache(); // so this takes effect immediately, not after TTL.catalog (10 min)
  res.json({ success: true, sku, maintenance });
}));

// POST /api/admin/products/:sku/out-of-stock
// Body: { outOfStock: boolean, message?: string }
// Deliberately a separate field from maintenance: toggling this for one
// duration/sku (e.g. a 3-day variant) never disables sibling skus (7-day,
// 15-day) that just happen to share the same product "row".
router.post('/products/:sku/out-of-stock', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  if (!(await findProductFresh(sku))) {
    return res.status(404).json({ success: false, error: 'Unknown sku' });
  }

  const outOfStock = !!req.body?.outOfStock;
  const message = String(req.body?.message || '').trim();
  if (message.length > 300) return res.status(400).json({ success: false, error: 'Keep the message under 300 characters' });

  await db().collection('productStatus').doc(sku).set({
    outOfStock,
    outOfStockMessage: outOfStock ? (message || 'Out of stock — check back soon.') : null,
    updatedAt: Date.now(),
  }, { merge: true });

  invalidateMaintenanceCache();
  res.json({ success: true, sku, outOfStock });
}));

// Valid product tags. A product can carry more than one at once — e.g.
// a build that works on both rooted and non-rooted devices gets
// tags: ["ROOT","NONROOT"], and the storefront renders one badge per
// tag instead of squeezing it into a single derived category.
const VALID_TAGS = ['NONROOT', 'ROOT', 'IOS', 'PC'];

function normalizeTags(input) {
  const arr = Array.isArray(input) ? input : [];
  return [...new Set(arr.map((t) => String(t || '').trim().toUpperCase()))].filter((t) => VALID_TAGS.includes(t));
}

// POST /api/admin/products/create — add a brand new product without a code
// deploy. One product ("row") can have several duration variants created
// together; each gets its own auto-generated sku but shares one admin-chosen
// pid (the product id on the UPSTREAM store you buy from) and one tag set.
// Body: {
//   image, pid: "151", row: "My Product", tags: ["NONROOT","IOS"],
//   downloadLink: "https://example.com/app.apk", // optional — falls back to /allupdate.php
//   durations: [
//     { name: "My Product 12 hours", duration: "12 Hours", price: 150 },
//     ...
//   ]
// }
// `duration` must match the duration text listed on the upstream store EXACTLY
// (e.g. "12 Hours"): it is what gets sent to the upstream when a key is bought.
router.post('/products/create', asyncHandler(async (req, res) => {
  const image = String(req.body?.image || '').trim();
  const row = String(req.body?.row || '').trim();
  const pid = String(req.body?.pid || '').trim();
  const tags = normalizeTags(req.body?.tags);
  const durations = Array.isArray(req.body?.durations) ? req.body.durations : [];

  if (!image) return res.status(400).json({ success: false, error: 'Image link is required' });
  if (!row) return res.status(400).json({ success: false, error: 'Product full name is required' });
  if (!pid) return res.status(400).json({ success: false, error: 'Pid is required' });
  if (!tags.length) return res.status(400).json({ success: false, error: `Select at least one tag (${VALID_TAGS.join(', ')})` });
  if (!durations.length) return res.status(400).json({ success: false, error: 'Add at least one duration + price' });
  if (durations.length > 20) return res.status(400).json({ success: false, error: 'Too many durations in one go — split it up' });

  // Optional — the storefront falls back to the generic /allupdate.php page
  // when a product has none set. One link per product row.
  let downloadLink;
  try {
    downloadLink = normalizeUrlField(req.body?.downloadLink, 'Download link', { maxLen: 500 });
  } catch (e) {
    if (e instanceof RuleError) return res.status(e.status).json({ success: false, error: e.message });
    throw e;
  }

  const batch = db().batch();
  const created = [];

  for (let i = 0; i < durations.length; i++) {
    const d = durations[i];
    const name = String(d?.name || '').trim();
    const duration = String(d?.duration || '').trim();
    const price = Number(d?.price);
    if (!name || !duration) return res.status(400).json({ success: false, error: `Duration #${i + 1}: name and duration label are required` });
    if (!price || price <= 0) return res.status(400).json({ success: false, error: `Duration #${i + 1}: price must be a positive number` });

    const sku = `p_${pid}_${i + 1}_${Date.now().toString(36)}`;
    const product = { pid, row, name, duration, price, image, tags, createdAt: Date.now(), ...(downloadLink ? { downloadLink } : {}) };
    batch.set(db().collection('products').doc(sku), product);
    created.push({ sku, ...product });
  }

  await batch.commit();
  invalidateProductCache();
  res.json({ success: true, row, products: created });
}));

// POST /api/admin/products/:sku/edit
// Body: any of { image, name, duration, price, pid, tags, downloadLink } —
// only the fields provided are changed.
router.post('/products/:sku/edit', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  const fields = {};
  for (const key of ['image', 'name', 'duration', 'pid']) {
    if (req.body?.[key] !== undefined) {
      const v = String(req.body[key]).trim();
      if (!v) return res.status(400).json({ success: false, error: `${key} can't be empty` });
      fields[key] = v;
    }
  }
  if (req.body?.price !== undefined) {
    const v = Number(req.body.price);
    if (!v || v <= 0) return res.status(400).json({ success: false, error: 'Price must be a positive number' });
    fields.price = v;
  }
  if (req.body?.tags !== undefined) {
    const v = normalizeTags(req.body.tags);
    if (!v.length) return res.status(400).json({ success: false, error: `Select at least one tag (${VALID_TAGS.join(', ')})` });
    fields.tags = v;
  }
  // downloadLink may be blank — clearing it falls back to the generic /allupdate.php page.
  if (req.body?.downloadLink !== undefined) {
    try {
      fields.downloadLink = normalizeUrlField(req.body.downloadLink, 'Download link', { maxLen: 500 });
    } catch (e) {
      if (e instanceof RuleError) return res.status(e.status).json({ success: false, error: e.message });
      throw e;
    }
  }
  if (!Object.keys(fields).length) return res.status(400).json({ success: false, error: 'Nothing to update' });

  if (!(await getProductRaw(sku))) return res.status(404).json({ success: false, error: 'Unknown sku' });

  await db().collection('products').doc(sku).set(fields, { merge: true });
  invalidateProductCache();
  res.json({ success: true, sku, updated: fields });
}));

// POST /api/admin/products/:sku/delete
router.post('/products/:sku/delete', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  if (!(await getProductRaw(sku))) return res.status(404).json({ success: false, error: 'Unknown sku' });

  await deleteProduct(sku);
  await db().collection('productStatus').doc(sku).delete().catch(() => {}); // clean up any maintenance/stock flag too
  invalidateMaintenanceCache();
  res.json({ success: true, sku });
}));

// ---------------------------------------------------------------
// Chat-to-buy products — no duration, no automated checkout, no key
// delivery. The card's "buy" action opens your WhatsApp link (set once in the
// storefront's includes/config.php as WHATSAPP_LINK). See src/catalog.js.
// ---------------------------------------------------------------

// GET /api/admin/products/whatsapp
router.get('/products/whatsapp', asyncHandler(async (req, res) => {
  const snap = await db().collection('whatsappProducts').get();
  const products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  res.json({ success: true, products });
}));

// POST /api/admin/products/create-whatsapp
// Body: { image, name, price, whatsappMessage, viewDetails }
router.post('/products/create-whatsapp', asyncHandler(async (req, res) => {
  const image = String(req.body?.image || '').trim();
  const name = String(req.body?.name || '').trim();
  const price = Number(req.body?.price);
  const whatsappMessage = String(req.body?.whatsappMessage || '').trim().slice(0, 400);
  const viewDetails = String(req.body?.viewDetails || '').trim().slice(0, 1000);

  if (!image) return res.status(400).json({ success: false, error: 'Image link is required' });
  if (!name) return res.status(400).json({ success: false, error: 'Product name is required' });
  if (!price || price <= 0) return res.status(400).json({ success: false, error: 'Price must be a positive number' });

  const id = `wa_${Date.now().toString(36)}`;
  const product = { image, name, price, whatsappMessage, viewDetails, createdAt: Date.now() };
  await db().collection('whatsappProducts').doc(id).set(product);
  invalidateWhatsappProductCache();
  res.json({ success: true, id, ...product });
}));

// POST /api/admin/products/whatsapp/:id/edit
router.post('/products/whatsapp/:id/edit', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();
  const existing = await getWhatsappProductRaw(id);
  if (!existing) return res.status(404).json({ success: false, error: 'Unknown product' });

  const fields = {};
  for (const key of ['image', 'name', 'whatsappMessage', 'viewDetails']) {
    if (req.body?.[key] !== undefined) fields[key] = String(req.body[key]).trim();
  }
  if (req.body?.price !== undefined) {
    const v = Number(req.body.price);
    if (!v || v <= 0) return res.status(400).json({ success: false, error: 'Price must be a positive number' });
    fields.price = v;
  }
  if (!Object.keys(fields).length) return res.status(400).json({ success: false, error: 'Nothing to update' });

  await db().collection('whatsappProducts').doc(id).set(fields, { merge: true });
  invalidateWhatsappProductCache();
  res.json({ success: true, id, updated: fields });
}));

// POST /api/admin/products/whatsapp/:id/delete
router.post('/products/whatsapp/:id/delete', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();
  const existing = await getWhatsappProductRaw(id);
  if (!existing) return res.status(404).json({ success: false, error: 'Unknown product' });
  await deleteWhatsappProduct(id);
  res.json({ success: true, id });
}));

// ---------------------------------------------------------------
// Redeem codes — admin creates gift/promo codes worth a fixed Rs
// amount, optionally capped by an expiry date and/or a max number
// of redemptions. Stored in the `redeemCodes` collection, doc ID =
// the code itself. Redemption itself happens via POST /api/user/redeem.
// ---------------------------------------------------------------

function generateRedeemCode() {
  // GIFT_XXXXX_YYYYY — two 5-char groups, no 0/O/1/I to avoid confusion.
  // Change the GIFT part with the CODE_PREFIX environment variable.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = (n) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');
  const prefix = String(process.env.CODE_PREFIX || 'GIFT').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'GIFT';
  return `${prefix}_${group(5)}_${group(5)}`;
}

// Shared by POST /redeem-codes and the announcement gift flow below, so a
// gift attached to a broadcast is a completely normal redeem code — same
// validation, same collection, same redemption path.
async function createRedeemCodeDoc({ amount, maxUses, expiresAt, code }) {
  amount = Number(amount);
  if (!amount || amount <= 0) throw Object.assign(new Error('Amount must be a positive number'), { status: 400 });

  if (maxUses === '' || maxUses === undefined || maxUses === null || String(maxUses).toLowerCase() === 'unlimited') {
    maxUses = null;
  } else {
    maxUses = Number(maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
      throw Object.assign(new Error('Max uses must be a whole number between 1 and 100, or unlimited'), { status: 400 });
    }
  }

  let expiresAtMs = null;
  if (expiresAt && String(expiresAt).toLowerCase() !== 'unlimited') {
    const t = new Date(expiresAt).getTime();
    if (Number.isNaN(t)) throw Object.assign(new Error('Invalid expiry date'), { status: 400 });
    expiresAtMs = t;
  }

  const finalCode = String(code || '').trim().toUpperCase() || generateRedeemCode();
  const ref = db().collection('redeemCodes').doc(finalCode);
  const existing = await ref.get();
  if (existing.exists) throw Object.assign(new Error('That code already exists'), { status: 409 });

  const docData = {
    code: finalCode, amount, maxUses, expiresAt: expiresAtMs,
    active: true, usedCount: 0, redeemedBy: [],
    createdAt: Date.now(),
  };
  await ref.set(docData);
  return docData;
}

// POST /api/admin/redeem-codes
// Body: { amount, maxUses (1-100, or null/omit for unlimited), expiresAt (ISO date string, or null/omit for unlimited), code (optional custom code) }
router.post('/redeem-codes', asyncHandler(async (req, res) => {
  try {
    const result = await createRedeemCodeDoc(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ success: false, error: e.message });
  }
}));

// GET /api/admin/redeem-codes — list all codes, newest first
router.get('/redeem-codes', asyncHandler(async (req, res) => {
  const snap = await db().collection('redeemCodes').orderBy('createdAt', 'desc').limit(200).get();
  const codes = snap.docs.map((d) => d.data());
  res.json({ success: true, codes });
}));

// POST /api/admin/redeem-codes/:code/deactivate — stop a code from being used again
router.post('/redeem-codes/:code/deactivate', asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const ref = db().collection('redeemCodes').doc(code);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, error: 'Code not found' });
  await ref.set({ active: false }, { merge: true });
  res.json({ success: true });
}));

// ---------------------------------------------------------------
// Stats + rankings — both read only the fields purchase.js actually
// keeps up to date (balance, totalSpent, totalKeysBought via
// FieldValue.increment), not the older per-order `history` array the
// admin panel used to scan directly. 185 users is nothing for a plain
// full-collection read, same approach /backfill-stats already uses.
// ---------------------------------------------------------------

// GET /api/admin/stats — headline numbers for the dashboard cards
router.get('/stats', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').get();
  let totalRevenue = 0, totalKeysSold = 0;
  snap.forEach((d) => {
    const data = d.data();
    totalRevenue += Number(data.totalSpent || 0);
    totalKeysSold += Number(data.totalKeysBought || 0);
  });
  res.json({ success: true, totalUsers: snap.size, totalRevenue, totalKeysSold });
}));

// GET /api/admin/rankings — top users by spend
router.get('/rankings', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').orderBy('totalSpent', 'desc').limit(100).get();
  const rankings = snap.docs.map((d) => {
    const data = d.data();
    return {
      uid: d.id,
      email: data.email || '',
      profileName: data.profileName || '',
      balance: Number(data.balance || 0),
      totalSpent: Number(data.totalSpent || 0),
      totalKeysBought: Number(data.totalKeysBought || 0),
    };
  });
  res.json({ success: true, rankings });
}));

// ---------------------------------------------------------------
// Announcements — a broadcast message shown to every user as a popup
// on their next login, optionally bundled with a gift redeem code.
// "Seen" is tracked per-user (users/{uid}.lastSeenAnnouncementId), not
// as a growing array on the announcement doc, so this stays cheap
// regardless of user count. See GET/POST /api/user/announcement*.
// ---------------------------------------------------------------

// POST /api/admin/announcements
// Body: { message, giftAmount?, giftMaxUses?, giftExpiresAt? }
// If giftAmount is provided, a normal redeem code is created (default
// unlimited uses, since it's meant for every user) and attached.
router.post('/announcements', asyncHandler(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ success: false, error: 'Write a message first' });
  if (message.length > 500) return res.status(400).json({ success: false, error: 'Keep the message under 500 characters' });

  let gift = null;
  const giftAmount = req.body?.giftAmount;
  if (giftAmount !== undefined && giftAmount !== null && giftAmount !== '') {
    try {
      gift = await createRedeemCodeDoc({
        amount: giftAmount,
        maxUses: req.body?.giftMaxUses ?? null,
        expiresAt: req.body?.giftExpiresAt ?? null,
      });
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, error: `Gift code: ${e.message}` });
    }
  }

  const id = `ann_${Date.now()}`;
  const docData = {
    id, message,
    giftCode: gift?.code || null,
    giftAmount: gift?.amount || null,
    active: true,
    createdAt: Date.now(),
  };

  // Deactivate any previously-active announcements first, so there's
  // only ever one live at a time (also keeps the /announcement read
  // above cheap — it only ever has to scan a handful of docs).
  const prevActive = await db().collection('announcements').where('active', '==', true).limit(20).get();
  if (!prevActive.empty) {
    const batch = db().batch();
    prevActive.docs.forEach((d) => batch.set(d.ref, { active: false }, { merge: true }));
    await batch.commit();
  }

  await db().collection('announcements').doc(id).set(docData);
  announcementCache.invalidate();
  res.json({ success: true, announcement: docData });
}));

// GET /api/admin/announcements — list, newest first
router.get('/announcements', asyncHandler(async (req, res) => {
  const snap = await db().collection('announcements').orderBy('createdAt', 'desc').limit(50).get();
  res.json({ success: true, announcements: snap.docs.map((d) => d.data()) });
}));

// POST /api/admin/announcements/:id/deactivate
router.post('/announcements/:id/deactivate', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();
  const ref = db().collection('announcements').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, error: 'Announcement not found' });
  await ref.set({ active: false }, { merge: true });
  announcementCache.invalidate();
  res.json({ success: true });
}));

// ---------------------------------------------------------------
// GET /api/admin/users — full user directory for the admin panel.
//
// Query params (all optional):
//   topupDays=7 | 30    only users whose most recent APPROVED topup
//                       falls within the last N days
//   q=<text>           case-insensitive match on name/email/phone/uid
//   limit=<n>           default 200, max 500
//
// Returns exactly the fields the panel's user-list table needs — name,
// whatsapp, email, balance, keys bought, total spent, last topup date,
// computed from real fields already on each user doc (no new
// fields invented, nothing stored twice).
// ---------------------------------------------------------------
router.get('/users', asyncHandler(async (req, res) => {
  const topupDays = req.query.topupDays ? parseInt(req.query.topupDays, 10) : null;
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));

  const cutoff = topupDays ? Date.now() - topupDays * 24 * 60 * 60 * 1000 : null;

  const snap = await db().collection('users').get();
  const rows = [];

  snap.forEach((doc) => {
    const d = doc.data();
    const topups = Array.isArray(d.topupRequests) ? d.topupRequests : [];

    // "Last topup" means the most recent APPROVED one — a pending or
    // rejected request never added real balance, so it shouldn't count
    // as the user's last successful top-up.
    const approved = topups.filter((t) => t.status === 'APPROVED');
    const lastTopup = approved.length
      ? approved.reduce((latest, t) => (new Date(t.date) > new Date(latest.date) ? t : latest))
      : null;
    const lastTopupAt = lastTopup ? new Date(lastTopup.date).getTime() : null;

    if (cutoff !== null && (!lastTopupAt || lastTopupAt < cutoff)) return; // outside the window -> skip

    const row = {
      uid: doc.id,
      name: d.profileName || (d.email ? d.email.split('@')[0] : 'Unknown'),
      whatsapp: d.profilePhone || '',
      email: d.email || '',
      balance: Number(d.balance || 0),
      totalKeysBought: Number(d.totalKeysBought || 0),
      totalSpent: Number(d.totalSpent || 0),
      lastTopupAt,
      lastTopupAmount: lastTopup ? Number(lastTopup.amount || 0) : null,
    };

    if (q) {
      const hay = `${row.name} ${row.email} ${row.whatsapp} ${row.uid}`.toLowerCase();
      if (!hay.includes(q)) return;
    }

    rows.push(row);
  });

  // Most recent top-up first when filtering by topup window (that's the
  // point of the view); otherwise highest lifetime spend first, so the
  // full directory opens with your best customers on top.
  rows.sort((a, b) => (topupDays ? (b.lastTopupAt || 0) - (a.lastTopupAt || 0) : b.totalSpent - a.totalSpent));

  res.json({ success: true, total: rows.length, users: rows.slice(0, limit) });
}));

// ---------------------------------------------------------------
// POLICY — the admin-only write side of the public GET /api/policy
// (defined in server.js, not here, since it has to be reachable
// without an admin secret). Stored as a single Firestore doc
// (config/policy), which is the one and only place this text lives —
// there is no way to edit it except through this endpoint, so a
// devtools edit to what a page displays never persists past that one
// page load.
// ---------------------------------------------------------------
router.get('/policy', asyncHandler(async (req, res) => {
  const p = await policyCache.get(); // writes the default policy automatically if the doc is missing
  res.json({ success: true, title: p.title || '', body: p.body || '', updatedAt: p.updatedAt || null });
}));

router.post('/policy', asyncHandler(async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!title) return res.status(400).json({ success: false, error: 'Title is required' });
  if (!body) return res.status(400).json({ success: false, error: 'Policy text is required' });
  if (body.length > 20000) return res.status(400).json({ success: false, error: 'Policy text is too long (max 20,000 characters)' });

  await db().collection('config').doc('policy').set({ title, body, updatedAt: Date.now() }, { merge: true });
  policyCache.invalidate();
  res.json({ success: true });
}));

// ---------------------------------------------------------------
// FF GLORY BOT stock — how many glory groups can be running at once.
// enabled=false means unlimited. Each live (running/stopped) group uses
// one slot; deleting a group frees it.
// ---------------------------------------------------------------
router.get('/glory-stock', asyncHandler(async (req, res) => {
  res.json({ success: true, ...(await getStock({ fresh: true })) });
}));

router.post('/glory-stock', asyncHandler(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'enabled must be true or false' });
  }
  const total = Number(req.body?.total);
  if (req.body.enabled && (!Number.isInteger(total) || total < 0 || total > 10000)) {
    return res.status(400).json({ success: false, error: 'Stock must be a whole number from 0 to 10000' });
  }
  const stock = await setStock({ enabled: req.body.enabled, total: Number.isInteger(total) ? total : 0 });
  telegramNotify(`🤖 <b>Glory Bot stock</b> set: ${stock.enabled ? `${stock.available} available of ${stock.total}` : 'unlimited'} (admin panel)`);
  res.json({ success: true, ...stock });
}));

export default router;
asyncHandler } from '../src/asyncHandler.js';
import { db, requireAdmin, adminCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { getMaintenanceOverrides, invalidateMaintenanceCache, getLiveCatalog, invalidateProductCache, findProductFresh, getProductRaw, deleteProduct, invalidateWhatsappProductCache, getWhatsappProductRaw, deleteWhatsappProduct } from '../src/catalog.js';
import { telegramNotify, telegramFormat } from '../src/telegram.js';
import { notifyBalanceChange } from '../src/balanceAlerts.js';
import { OWNER_ACCOUNT } from '../src/store.js';
import { invalidateUserDoc, invalidateAllUserDocs } from '../src/userCache.js';
import { announcementCache, policyCache, leaderboardCache } from '../src/sharedCaches.js';
import { normalizeUrlField, RuleError } from '../src/profileRules.js';

const router = express.Router();
router.use(adminCors);
// Tighter than the generic 180/min API-wide limit — this whole router
// moves money and account state, so it's worth its own ceiling. The
// real defense is still ADMIN_SECRET's own entropy (no rate limit makes
// guessing a long random secret feasible); this mainly bounds the blast
// radius of a leaked/compromised admin client going haywire.
router.use(rateLimit({ windowMs: 60_000, max: 90, name: 'admin' }));
router.use(requireAdmin);

const EMPTY_USER = (uid, email = '') => ({
  success: true, uid, found: false,
  balance: 0, email, adminLog: [], purchases: [],
  topupRequests: [], requestStatus: 'Active', adminMessage: '',
  profileName: '', profilePhone: '',
});

// GET /api/admin/lookup?uid=... or ?email=...
router.get('/lookup', asyncHandler(async (req, res) => {
  const uidParam = String(req.query.uid || '').trim();
  const emailParam = String(req.query.email || '').trim();
  if (!uidParam && !emailParam) {
    return res.status(400).json({ success: false, error: 'Provide a uid or email' });
  }

  let uid = uidParam;
  let snap;

  if (uid) {
    snap = await db().collection('users').doc(uid).get();
  } else {
    const q = await db().collection('users').where('email', '==', emailParam).limit(1).get();
    if (q.empty) return res.json(EMPTY_USER('', emailParam));
    snap = q.docs[0];
    uid = snap.id;
  }

  if (!snap.exists) return res.json(EMPTY_USER(uid));

  const data = snap.data();
  res.json({
    success: true, uid, found: true,
    balance: Number(data.balance || 0),
    email: data.email || '',
    adminLog: [...(data.adminLog || [])].reverse().slice(0, 50),
    purchases: [...(data.purchaseHistory || [])].reverse().slice(0, 50),
    topupRequests: [...(data.topupRequests || [])].reverse().slice(0, 50),
    requestStatus: data.requestStatus || 'Active',
    adminMessage: data.adminMessage || '',
    profileName: data.profileName || '',
    profilePhone: data.profilePhone || '',
  });
}));

// POST /api/admin/adjust-balance  { uid, amount, direction: "add"|"deduct", note }
router.post('/adjust-balance', asyncHandler(async (req, res) => {
  const uid = String(req.body?.uid || '').trim();
  const amount = parseInt(req.body?.amount, 10);
  const direction = String(req.body?.direction || 'add');
  const note = String(req.body?.note || '').trim();

  if (!uid) return res.status(400).json({ success: false, error: 'Provide a uid' });
  if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Enter a valid amount' });
  if (!['add', 'deduct'].includes(direction)) {
    return res.status(400).json({ success: false, error: 'direction must be "add" or "deduct"' });
  }

  const userRef = db().collection('users').doc(uid);
  try {
    let beforeBalance = 0;
    let userEmail = '';
    const newBalance = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const current = snap.exists ? Number(snap.data().balance || 0) : 0;
      const delta = direction === 'add' ? amount : -amount;
      const updated = current + delta;
      if (updated < 0) throw new Error('That would take the balance negative');

      const log = snap.exists ? (snap.data().adminLog || []) : [];
      log.push({ delta, note, resultingBalance: updated, at: new Date().toISOString() });

      tx.set(userRef, { balance: updated, adminLog: log }, { merge: true });
      beforeBalance = current;
      userEmail = snap.exists ? (snap.data().email || '') : '';
      return updated;
    });
    invalidateUserDoc(uid);
    res.json({ success: true, newBalance });

    // Telegram alert on the dedicated balance-load channel (after the
    // response, so a slow/failed Telegram call can never delay or fail
    // the actual balance change).
    notifyBalanceChange({
      actor: 'ADMIN', kind: direction === 'add' ? 'load' : 'deduct',
      uid, email: userEmail, amount, before: beforeBalance, after: newBalance, note,
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
}));

// POST /api/admin/set-status  { uid, requestStatus?, adminMessage? }
router.post('/set-status', asyncHandler(async (req, res) => {
  const uid = String(req.body?.uid || '').trim();
  if (!uid) return res.status(400).json({ success: false, error: 'Provide a uid' });

  const allowed = ['Active', 'Pending', 'Rejected', 'Banned'];
  const update = {};

  if (Object.prototype.hasOwnProperty.call(req.body, 'requestStatus')) {
    if (!allowed.includes(req.body.requestStatus)) {
      return res.status(400).json({ success: false, error: `requestStatus must be one of: ${allowed.join(', ')}` });
    }
    update.requestStatus = req.body.requestStatus;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'adminMessage')) {
    update.adminMessage = String(req.body.adminMessage);
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ success: false, error: 'Nothing to update' });
  }

  await db().collection('users').doc(uid).set(update, { merge: true });
  invalidateUserDoc(uid);
  res.json({ success: true });
}));

// POST /api/admin/topup-review  { uid, txCode, action: "approve"|"reject" }
router.post('/topup-review', asyncHandler(async (req, res) => {
  const uid = String(req.body?.uid || '').trim();
  const txCode = String(req.body?.txCode || '').trim().toUpperCase();
  const action = String(req.body?.action || '');

  if (!uid || !txCode) return res.status(400).json({ success: false, error: 'Provide uid and txCode' });
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ success: false, error: 'action must be "approve" or "reject"' });
  }

  const userRef = db().collection('users').doc(uid);
  let approvedAmount = 0;
  try {
    const newBalance = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error('User not found');
      const data = snap.data();
      const requests = data.topupRequests || [];

      let found = false;
      let amount = 0;
      const updatedRequests = requests.map((r) => {
        if (!found && r.txCode === txCode && r.status === 'PENDING') {
          found = true;
          amount = Number(r.amount || 0);
          approvedAmount = amount;
          return { ...r, status: action === 'approve' ? 'APPROVED' : 'REJECTED', reviewedAt: new Date().toISOString() };
        }
        return r;
      });

      if (!found) throw new Error('No matching PENDING request with that transaction code');

      const update = { topupRequests: updatedRequests };
      let balance = Number(data.balance || 0);

      if (action === 'approve') {
        balance += amount;
        const log = data.adminLog || [];
        log.push({
          delta: amount, note: `Top-up approved (txCode: ${txCode})`,
          resultingBalance: balance, at: new Date().toISOString(),
        });
        update.balance = balance;
        update.adminLog = log;
      }

      tx.set(userRef, update, { merge: true });
      return balance;
    });
    invalidateUserDoc(uid);
    res.json({ success: true, newBalance });
    if (action === 'approve') {
      // Admin credited a customer's top-up: same dedicated channel as
      // every other staff balance load.
      notifyBalanceChange({
        actor: 'ADMIN', kind: 'load', title: 'TOP-UP APPROVED',
        uid, amount: approvedAmount, before: newBalance - approvedAmount, after: newBalance,
        note: `TX code: ${txCode}`,
      });
    } else {
      // Rejections aren't a balance load — left exactly as before.
      telegramNotify(telegramFormat('Balance Load Rejected', { username: uid, product: OWNER_ACCOUNT, price: 0, uid, status: 'failed', others: `TX code: ${txCode}` }), 'balance');
    }
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
}));

// POST /api/admin/backfill-stats — one-time (safe to re-run) job that
// recomputes totalKeysBought/totalSpent for every user from their
// existing purchaseHistory array, for users who bought keys before
// the leaderboard feature started tracking these fields going forward.
router.post('/backfill-stats', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').get();
  let updated = 0;
  const batchSize = 400;
  let batch = db().batch();
  let inBatch = 0;

  for (const doc of snap.docs) {
    const history = doc.data().purchaseHistory || [];
    const totalKeysBought = history.length;
    const totalSpent = history.reduce((sum, h) => sum + (Number(h.price) || 0), 0);
    batch.set(doc.ref, { totalKeysBought, totalSpent }, { merge: true });
    inBatch++;
    updated++;
    if (inBatch >= batchSize) {
      await batch.commit();
      batch = db().batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) await batch.commit();
  invalidateAllUserDocs();
  leaderboardCache.invalidate();

  res.json({ success: true, usersUpdated: updated });
}));

// ---------------------------------------------------------------
// Products / maintenance — products live in Firestore (products/{sku}); the
// maintenance / out-of-stock flags live in productStatus/{sku}, so toggling
// one never needs a code deploy — see src/catalog.js for how they are merged
// into what the storefront sees. One price per product (no roles).
// ---------------------------------------------------------------

// GET /api/admin/products — every product with its current live
// maintenance/stock status, for the admin panel's product manager.
router.get('/products', asyncHandler(async (req, res) => {
  const liveCatalog = await getLiveCatalog();
  const skus = Object.keys(liveCatalog).filter((sku) => liveCatalog[sku].type !== 'whatsapp'); // chat-to-buy products have their own list below

  const products = skus.map((sku) => {
    const p = liveCatalog[sku];
    return {
      sku, pid: p.pid, row: p.row, name: p.name, duration: p.duration, image: p.image,
      price: p.price,
      downloadLink: p.downloadLink || '',
      tags: Array.isArray(p.tags) ? p.tags : [],
      maintenance: !!p.maintenance,
      maintenanceMessage: p.maintenance ? (p.maintenanceMessage || 'This product is temporarily under maintenance.') : null,
      outOfStock: !!p.outOfStock,
      outOfStockMessage: p.outOfStock ? (p.outOfStockMessage || 'Out of stock — check back soon.') : null,
    };
  });

  res.json({ success: true, products });
}));

// POST /api/admin/products/:sku/maintenance
// Body: { maintenance: boolean, message?: string }
router.post('/products/:sku/maintenance', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  const liveCatalog = await getLiveCatalog();
  if (!liveCatalog[sku]) {
    return res.status(404).json({ success: false, error: 'Unknown sku' });
  }

  const maintenance = !!req.body?.maintenance;
  const message = String(req.body?.message || '').trim();
  if (message.length > 300) return res.status(400).json({ success: false, error: 'Keep the message under 300 characters' });

  await db().collection('productStatus').doc(sku).set({
    maintenance,
    maintenanceMessage: maintenance ? (message || 'This product is temporarily under maintenance.') : null,
    updatedAt: Date.now(),
  }, { merge: true });

  invalidateMaintenanceCache(); // so this takes effect immediately, not after TTL.catalog (10 min)
  res.json({ success: true, sku, maintenance });
}));

// POST /api/admin/products/:sku/out-of-stock
// Body: { outOfStock: boolean, message?: string }
// Deliberately a separate field from maintenance: toggling this for one
// duration/sku (e.g. a 3-day variant) never disables sibling skus (7-day,
// 15-day) that just happen to share the same product "row".
router.post('/products/:sku/out-of-stock', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  if (!(await findProductFresh(sku))) {
    return res.status(404).json({ success: false, error: 'Unknown sku' });
  }

  const outOfStock = !!req.body?.outOfStock;
  const message = String(req.body?.message || '').trim();
  if (message.length > 300) return res.status(400).json({ success: false, error: 'Keep the message under 300 characters' });

  await db().collection('productStatus').doc(sku).set({
    outOfStock,
    outOfStockMessage: outOfStock ? (message || 'Out of stock — check back soon.') : null,
    updatedAt: Date.now(),
  }, { merge: true });

  invalidateMaintenanceCache();
  res.json({ success: true, sku, outOfStock });
}));

// Valid product tags. A product can carry more than one at once — e.g.
// a build that works on both rooted and non-rooted devices gets
// tags: ["ROOT","NONROOT"], and the storefront renders one badge per
// tag instead of squeezing it into a single derived category.
const VALID_TAGS = ['NONROOT', 'ROOT', 'IOS', 'PC'];

function normalizeTags(input) {
  const arr = Array.isArray(input) ? input : [];
  return [...new Set(arr.map((t) => String(t || '').trim().toUpperCase()))].filter((t) => VALID_TAGS.includes(t));
}

// POST /api/admin/products/create — add a brand new product without a code
// deploy. One product ("row") can have several duration variants created
// together; each gets its own auto-generated sku but shares one admin-chosen
// pid (the product id on the UPSTREAM store you buy from) and one tag set.
// Body: {
//   image, pid: "151", row: "My Product", tags: ["NONROOT","IOS"],
//   downloadLink: "https://example.com/app.apk", // optional — falls back to /allupdate.php
//   durations: [
//     { name: "My Product 12 hours", duration: "12 Hours", price: 150 },
//     ...
//   ]
// }
// `duration` must match the duration text listed on the upstream store EXACTLY
// (e.g. "12 Hours"): it is what gets sent to the upstream when a key is bought.
router.post('/products/create', asyncHandler(async (req, res) => {
  const image = String(req.body?.image || '').trim();
  const row = String(req.body?.row || '').trim();
  const pid = String(req.body?.pid || '').trim();
  const tags = normalizeTags(req.body?.tags);
  const durations = Array.isArray(req.body?.durations) ? req.body.durations : [];

  if (!image) return res.status(400).json({ success: false, error: 'Image link is required' });
  if (!row) return res.status(400).json({ success: false, error: 'Product full name is required' });
  if (!pid) return res.status(400).json({ success: false, error: 'Pid is required' });
  if (!tags.length) return res.status(400).json({ success: false, error: `Select at least one tag (${VALID_TAGS.join(', ')})` });
  if (!durations.length) return res.status(400).json({ success: false, error: 'Add at least one duration + price' });
  if (durations.length > 20) return res.status(400).json({ success: false, error: 'Too many durations in one go — split it up' });

  // Optional — the storefront falls back to the generic /allupdate.php page
  // when a product has none set. One link per product row.
  let downloadLink;
  try {
    downloadLink = normalizeUrlField(req.body?.downloadLink, 'Download link', { maxLen: 500 });
  } catch (e) {
    if (e instanceof RuleError) return res.status(e.status).json({ success: false, error: e.message });
    throw e;
  }

  const batch = db().batch();
  const created = [];

  for (let i = 0; i < durations.length; i++) {
    const d = durations[i];
    const name = String(d?.name || '').trim();
    const duration = String(d?.duration || '').trim();
    const price = Number(d?.price);
    if (!name || !duration) return res.status(400).json({ success: false, error: `Duration #${i + 1}: name and duration label are required` });
    if (!price || price <= 0) return res.status(400).json({ success: false, error: `Duration #${i + 1}: price must be a positive number` });

    const sku = `p_${pid}_${i + 1}_${Date.now().toString(36)}`;
    const product = { pid, row, name, duration, price, image, tags, createdAt: Date.now(), ...(downloadLink ? { downloadLink } : {}) };
    batch.set(db().collection('products').doc(sku), product);
    created.push({ sku, ...product });
  }

  await batch.commit();
  invalidateProductCache();
  res.json({ success: true, row, products: created });
}));

// POST /api/admin/products/:sku/edit
// Body: any of { image, name, duration, price, pid, tags, downloadLink } —
// only the fields provided are changed.
router.post('/products/:sku/edit', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  const fields = {};
  for (const key of ['image', 'name', 'duration', 'pid']) {
    if (req.body?.[key] !== undefined) {
      const v = String(req.body[key]).trim();
      if (!v) return res.status(400).json({ success: false, error: `${key} can't be empty` });
      fields[key] = v;
    }
  }
  if (req.body?.price !== undefined) {
    const v = Number(req.body.price);
    if (!v || v <= 0) return res.status(400).json({ success: false, error: 'Price must be a positive number' });
    fields.price = v;
  }
  if (req.body?.tags !== undefined) {
    const v = normalizeTags(req.body.tags);
    if (!v.length) return res.status(400).json({ success: false, error: `Select at least one tag (${VALID_TAGS.join(', ')})` });
    fields.tags = v;
  }
  // downloadLink may be blank — clearing it falls back to the generic /allupdate.php page.
  if (req.body?.downloadLink !== undefined) {
    try {
      fields.downloadLink = normalizeUrlField(req.body.downloadLink, 'Download link', { maxLen: 500 });
    } catch (e) {
      if (e instanceof RuleError) return res.status(e.status).json({ success: false, error: e.message });
      throw e;
    }
  }
  if (!Object.keys(fields).length) return res.status(400).json({ success: false, error: 'Nothing to update' });

  if (!(await getProductRaw(sku))) return res.status(404).json({ success: false, error: 'Unknown sku' });

  await db().collection('products').doc(sku).set(fields, { merge: true });
  invalidateProductCache();
  res.json({ success: true, sku, updated: fields });
}));

// POST /api/admin/products/:sku/delete
router.post('/products/:sku/delete', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  if (!(await getProductRaw(sku))) return res.status(404).json({ success: false, error: 'Unknown sku' });

  await deleteProduct(sku);
  await db().collection('productStatus').doc(sku).delete().catch(() => {}); // clean up any maintenance/stock flag too
  invalidateMaintenanceCache();
  res.json({ success: true, sku });
}));

// ---------------------------------------------------------------
// Chat-to-buy products — no duration, no automated checkout, no key
// delivery. The card's "buy" action opens your WhatsApp link (set once in the
// storefront's includes/config.php as WHATSAPP_LINK). See src/catalog.js.
// ---------------------------------------------------------------

// GET /api/admin/products/whatsapp
router.get('/products/whatsapp', asyncHandler(async (req, res) => {
  const snap = await db().collection('whatsappProducts').get();
  const products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  res.json({ success: true, products });
}));

// POST /api/admin/products/create-whatsapp
// Body: { image, name, price, whatsappMessage, viewDetails }
router.post('/products/create-whatsapp', asyncHandler(async (req, res) => {
  const image = String(req.body?.image || '').trim();
  const name = String(req.body?.name || '').trim();
  const price = Number(req.body?.price);
  const whatsappMessage = String(req.body?.whatsappMessage || '').trim().slice(0, 400);
  const viewDetails = String(req.body?.viewDetails || '').trim().slice(0, 1000);

  if (!image) return res.status(400).json({ success: false, error: 'Image link is required' });
  if (!name) return res.status(400).json({ success: false, error: 'Product name is required' });
  if (!price || price <= 0) return res.status(400).json({ success: false, error: 'Price must be a positive number' });

  const id = `wa_${Date.now().toString(36)}`;
  const product = { image, name, price, whatsappMessage, viewDetails, createdAt: Date.now() };
  await db().collection('whatsappProducts').doc(id).set(product);
  invalidateWhatsappProductCache();
  res.json({ success: true, id, ...product });
}));

// POST /api/admin/products/whatsapp/:id/edit
router.post('/products/whatsapp/:id/edit', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();
  const existing = await getWhatsappProductRaw(id);
  if (!existing) return res.status(404).json({ success: false, error: 'Unknown product' });

  const fields = {};
  for (const key of ['image', 'name', 'whatsappMessage', 'viewDetails']) {
    if (req.body?.[key] !== undefined) fields[key] = String(req.body[key]).trim();
  }
  if (req.body?.price !== undefined) {
    const v = Number(req.body.price);
    if (!v || v <= 0) return res.status(400).json({ success: false, error: 'Price must be a positive number' });
    fields.price = v;
  }
  if (!Object.keys(fields).length) return res.status(400).json({ success: false, error: 'Nothing to update' });

  await db().collection('whatsappProducts').doc(id).set(fields, { merge: true });
  invalidateWhatsappProductCache();
  res.json({ success: true, id, updated: fields });
}));

// POST /api/admin/products/whatsapp/:id/delete
router.post('/products/whatsapp/:id/delete', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();
  const existing = await getWhatsappProductRaw(id);
  if (!existing) return res.status(404).json({ success: false, error: 'Unknown product' });
  await deleteWhatsappProduct(id);
  res.json({ success: true, id });
}));

// ---------------------------------------------------------------
// Redeem codes — admin creates gift/promo codes worth a fixed Rs
// amount, optionally capped by an expiry date and/or a max number
// of redemptions. Stored in the `redeemCodes` collection, doc ID =
// the code itself. Redemption itself happens via POST /api/user/redeem.
// ---------------------------------------------------------------

function generateRedeemCode() {
  // GIFT_XXXXX_YYYYY — two 5-char groups, no 0/O/1/I to avoid confusion.
  // Change the GIFT part with the CODE_PREFIX environment variable.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = (n) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');
  const prefix = String(process.env.CODE_PREFIX || 'GIFT').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'GIFT';
  return `${prefix}_${group(5)}_${group(5)}`;
}

// Shared by POST /redeem-codes and the announcement gift flow below, so a
// gift attached to a broadcast is a completely normal redeem code — same
// validation, same collection, same redemption path.
async function createRedeemCodeDoc({ amount, maxUses, expiresAt, code }) {
  amount = Number(amount);
  if (!amount || amount <= 0) throw Object.assign(new Error('Amount must be a positive number'), { status: 400 });

  if (maxUses === '' || maxUses === undefined || maxUses === null || String(maxUses).toLowerCase() === 'unlimited') {
    maxUses = null;
  } else {
    maxUses = Number(maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
      throw Object.assign(new Error('Max uses must be a whole number between 1 and 100, or unlimited'), { status: 400 });
    }
  }

  let expiresAtMs = null;
  if (expiresAt && String(expiresAt).toLowerCase() !== 'unlimited') {
    const t = new Date(expiresAt).getTime();
    if (Number.isNaN(t)) throw Object.assign(new Error('Invalid expiry date'), { status: 400 });
    expiresAtMs = t;
  }

  const finalCode = String(code || '').trim().toUpperCase() || generateRedeemCode();
  const ref = db().collection('redeemCodes').doc(finalCode);
  const existing = await ref.get();
  if (existing.exists) throw Object.assign(new Error('That code already exists'), { status: 409 });

  const docData = {
    code: finalCode, amount, maxUses, expiresAt: expiresAtMs,
    active: true, usedCount: 0, redeemedBy: [],
    createdAt: Date.now(),
  };
  await ref.set(docData);
  return docData;
}

// POST /api/admin/redeem-codes
// Body: { amount, maxUses (1-100, or null/omit for unlimited), expiresAt (ISO date string, or null/omit for unlimited), code (optional custom code) }
router.post('/redeem-codes', asyncHandler(async (req, res) => {
  try {
    const result = await createRedeemCodeDoc(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ success: false, error: e.message });
  }
}));

// GET /api/admin/redeem-codes — list all codes, newest first
router.get('/redeem-codes', asyncHandler(async (req, res) => {
  const snap = await db().collection('redeemCodes').orderBy('createdAt', 'desc').limit(200).get();
  const codes = snap.docs.map((d) => d.data());
  res.json({ success: true, codes });
}));

// POST /api/admin/redeem-codes/:code/deactivate — stop a code from being used again
router.post('/redeem-codes/:code/deactivate', asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const ref = db().collection('redeemCodes').doc(code);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, error: 'Code not found' });
  await ref.set({ active: false }, { merge: true });
  res.json({ success: true });
}));

// ---------------------------------------------------------------
// Stats + rankings — both read only the fields purchase.js actually
// keeps up to date (balance, totalSpent, totalKeysBought via
// FieldValue.increment), not the older per-order `history` array the
// admin panel used to scan directly. 185 users is nothing for a plain
// full-collection read, same approach /backfill-stats already uses.
// ---------------------------------------------------------------

// GET /api/admin/stats — headline numbers for the dashboard cards
router.get('/stats', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').get();
  let totalRevenue = 0, totalKeysSold = 0;
  snap.forEach((d) => {
    const data = d.data();
    totalRevenue += Number(data.totalSpent || 0);
    totalKeysSold += Number(data.totalKeysBought || 0);
  });
  res.json({ success: true, totalUsers: snap.size, totalRevenue, totalKeysSold });
}));

// GET /api/admin/rankings — top users by spend
router.get('/rankings', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').orderBy('totalSpent', 'desc').limit(100).get();
  const rankings = snap.docs.map((d) => {
    const data = d.data();
    return {
      uid: d.id,
      email: data.email || '',
      profileName: data.profileName || '',
      balance: Number(data.balance || 0),
      totalSpent: Number(data.totalSpent || 0),
      totalKeysBought: Number(data.totalKeysBought || 0),
    };
  });
  res.json({ success: true, rankings });
}));

// ---------------------------------------------------------------
// Announcements — a broadcast message shown to every user as a popup
// on their next login, optionally bundled with a gift redeem code.
// "Seen" is tracked per-user (users/{uid}.lastSeenAnnouncementId), not
// as a growing array on the announcement doc, so this stays cheap
// regardless of user count. See GET/POST /api/user/announcement*.
// ---------------------------------------------------------------

// POST /api/admin/announcements
// Body: { message, giftAmount?, giftMaxUses?, giftExpiresAt? }
// If giftAmount is provided, a normal redeem code is created (default
// unlimited uses, since it's meant for every user) and attached.
router.post('/announcements', asyncHandler(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ success: false, error: 'Write a message first' });
  if (message.length > 500) return res.status(400).json({ success: false, error: 'Keep the message under 500 characters' });

  let gift = null;
  const giftAmount = req.body?.giftAmount;
  if (giftAmount !== undefined && giftAmount !== null && giftAmount !== '') {
    try {
      gift = await createRedeemCodeDoc({
        amount: giftAmount,
        maxUses: req.body?.giftMaxUses ?? null,
        expiresAt: req.body?.giftExpiresAt ?? null,
      });
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, error: `Gift code: ${e.message}` });
    }
  }

  const id = `ann_${Date.now()}`;
  const docData = {
    id, message,
    giftCode: gift?.code || null,
    giftAmount: gift?.amount || null,
    active: true,
    createdAt: Date.now(),
  };

  // Deactivate any previously-active announcements first, so there's
  // only ever one live at a time (also keeps the /announcement read
  // above cheap — it only ever has to scan a handful of docs).
  const prevActive = await db().collection('announcements').where('active', '==', true).limit(20).get();
  if (!prevActive.empty) {
    const batch = db().batch();
    prevActive.docs.forEach((d) => batch.set(d.ref, { active: false }, { merge: true }));
    await batch.commit();
  }

  await db().collection('announcements').doc(id).set(docData);
  announcementCache.invalidate();
  res.json({ success: true, announcement: docData });
}));

// GET /api/admin/announcements — list, newest first
router.get('/announcements', asyncHandler(async (req, res) => {
  const snap = await db().collection('announcements').orderBy('createdAt', 'desc').limit(50).get();
  res.json({ success: true, announcements: snap.docs.map((d) => d.data()) });
}));

// POST /api/admin/announcements/:id/deactivate
router.post('/announcements/:id/deactivate', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();
  const ref = db().collection('announcements').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, error: 'Announcement not found' });
  await ref.set({ active: false }, { merge: true });
  announcementCache.invalidate();
  res.json({ success: true });
}));

// ---------------------------------------------------------------
// GET /api/admin/users — full user directory for the admin panel.
//
// Query params (all optional):
//   topupDays=7 | 30    only users whose most recent APPROVED topup
//                       falls within the last N days
//   q=<text>           case-insensitive match on name/email/phone/uid
//   limit=<n>           default 200, max 500
//
// Returns exactly the fields the panel's user-list table needs — name,
// whatsapp, email, balance, keys bought, total spent, last topup date,
// computed from real fields already on each user doc (no new
// fields invented, nothing stored twice).
// ---------------------------------------------------------------
router.get('/users', asyncHandler(async (req, res) => {
  const topupDays = req.query.topupDays ? parseInt(req.query.topupDays, 10) : null;
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));

  const cutoff = topupDays ? Date.now() - topupDays * 24 * 60 * 60 * 1000 : null;

  const snap = await db().collection('users').get();
  const rows = [];

  snap.forEach((doc) => {
    const d = doc.data();
    const topups = Array.isArray(d.topupRequests) ? d.topupRequests : [];

    // "Last topup" means the most recent APPROVED one — a pending or
    // rejected request never added real balance, so it shouldn't count
    // as the user's last successful top-up.
    const approved = topups.filter((t) => t.status === 'APPROVED');
    const lastTopup = approved.length
      ? approved.reduce((latest, t) => (new Date(t.date) > new Date(latest.date) ? t : latest))
      : null;
    const lastTopupAt = lastTopup ? new Date(lastTopup.date).getTime() : null;

    if (cutoff !== null && (!lastTopupAt || lastTopupAt < cutoff)) return; // outside the window -> skip

    const row = {
      uid: doc.id,
      name: d.profileName || (d.email ? d.email.split('@')[0] : 'Unknown'),
      whatsapp: d.profilePhone || '',
      email: d.email || '',
      balance: Number(d.balance || 0),
      totalKeysBought: Number(d.totalKeysBought || 0),
      totalSpent: Number(d.totalSpent || 0),
      lastTopupAt,
      lastTopupAmount: lastTopup ? Number(lastTopup.amount || 0) : null,
    };

    if (q) {
      const hay = `${row.name} ${row.email} ${row.whatsapp} ${row.uid}`.toLowerCase();
      if (!hay.includes(q)) return;
    }

    rows.push(row);
  });

  // Most recent top-up first when filtering by topup window (that's the
  // point of the view); otherwise highest lifetime spend first, so the
  // full directory opens with your best customers on top.
  rows.sort((a, b) => (topupDays ? (b.lastTopupAt || 0) - (a.lastTopupAt || 0) : b.totalSpent - a.totalSpent));

  res.json({ success: true, total: rows.length, users: rows.slice(0, limit) });
}));

// ---------------------------------------------------------------
// POLICY — the admin-only write side of the public GET /api/policy
// (defined in server.js, not here, since it has to be reachable
// without an admin secret). Stored as a single Firestore doc
// (config/policy), which is the one and only place this text lives —
// there is no way to edit it except through this endpoint, so a
// devtools edit to what a page displays never persists past that one
// page load.
// ---------------------------------------------------------------
router.get('/policy', asyncHandler(async (req, res) => {
  const p = await policyCache.get(); // writes the default policy automatically if the doc is missing
  res.json({ success: true, title: p.title || '', body: p.body || '', updatedAt: p.updatedAt || null });
}));

router.post('/policy', asyncHandler(async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!title) return res.status(400).json({ success: false, error: 'Title is required' });
  if (!body) return res.status(400).json({ success: false, error: 'Policy text is required' });
  if (body.length > 20000) return res.status(400).json({ success: false, error: 'Policy text is too long (max 20,000 characters)' });

  await db().collection('config').doc('policy').set({ title, body, updatedAt: Date.now() }, { merge: true });
  policyCache.invalidate();
  res.json({ success: true });
}));

export default router;
