// src/revenue.js — revenue by day, so the admin panel can show real 7-day and
// 30-day numbers (no browser-side guessing).
//
//   revenueDaily/{YYYY-MM-DD}  { amount, keys }     (Nepal calendar day)
//
// recordRevenue() is called after every successful key sale / Glory Bot launch
// (negative amount on a refund). It never throws and never delays the sale.
import admin from 'firebase-admin';
import { db } from './firebase.js';

const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60_000;
export const dayKey = (t = Date.now()) => new Date(t + NEPAL_OFFSET_MS).toISOString().slice(0, 10);

export function recordRevenue(amount, keys = 0) {
  const n = Number(amount);
  if (!n) return Promise.resolve();
  const upd = { amount: admin.firestore.FieldValue.increment(n) };
  if (keys) upd.keys = admin.firestore.FieldValue.increment(keys);
  return db().collection('revenueDaily').doc(dayKey()).set(upd, { merge: true }).catch((e) => {
    console.warn('[revenue] could not record:', e?.message || e);
  });
}

/** { rev7, rev30, since } — sums the last 7 / 30 Nepal calendar days (today included). */
export async function revenueWindows() {
  const from30 = dayKey(Date.now() - 29 * 86_400_000);
  const from7 = dayKey(Date.now() - 6 * 86_400_000);
  const snap = await db().collection('revenueDaily')
    .where(admin.firestore.FieldPath.documentId(), '>=', from30).get();
  let rev7 = 0, rev30 = 0, first = null;
  snap.forEach((d) => {
    const a = Number(d.data().amount || 0);
    rev30 += a;
    if (d.id >= from7) rev7 += a;
    if (!first || d.id < first) first = d.id;
  });
  return { rev7, rev30, since: first };
}

/** One-time rebuild from the `orders` collection (completed orders). Safe to re-run: it SETS each day, not increments. */
export async function backfillRevenue() {
  const snap = await db().collection('orders').where('status', '==', 'completed').get();
  const days = new Map();
  let skipped = 0;
  snap.forEach((d) => {
    try {
      const o = d.data();
      const raw = o.finishedAt ?? o.createdAt;
      const t = typeof raw === 'number' ? raw : (raw && typeof raw.toMillis === 'function' ? raw.toMillis() : Date.parse(raw));
      if (!Number.isFinite(t) || t <= 0) { skipped++; return; }
      const k = dayKey(t);
      const cur = days.get(k) || { amount: 0, keys: 0 };
      cur.amount += Number(o.price || 0); cur.keys += 1;
      days.set(k, cur);
    } catch (_) { skipped++; }
  });
  if (days.size) {                       // an empty batch must never be committed
    let batch = db().batch(), n = 0;
    for (const [k, v] of days) {
      batch.set(db().collection('revenueDaily').doc(k), v);
      if (++n % 400 === 0) { await batch.commit(); batch = db().batch(); }
    }
    if (n % 400 !== 0) await batch.commit();
  }
  return { orders: snap.size, days: days.size, skipped };
}
