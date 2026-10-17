// src/stats.js — the headline numbers for the admin panel AND the Telegram /stats command.
//
//   totalUsers / totalKeysSold / totalRevenue   lifetime (from each user's counters)
//   totalBalance                                 sum of EVERY user's available balance
//   revenue7d / revenue30d                       money from completed orders in the last 7 / 30 days
//
// The windows come from the `orders` collection (purchase.js writes one per order and
// stamps finishedAt when it completes), so they are real server-side numbers — they do
// not depend on any browser, and a user clearing their purchase history does not touch
// them. Refunded / failed orders are not counted. One single-field range query: no index.
import { db } from './firebase.js';

const DAY = 24 * 60 * 60 * 1000;
let memo = null; // { at, value } — a few seconds is plenty; protects Firestore reads from refresh-spam

export async function computeStats({ fresh = false } = {}) {
  if (!fresh && memo && Date.now() - memo.at < 15_000) return memo.value;
  const now = Date.now();

  const [usersSnap, ordersSnap] = await Promise.all([
    db().collection('users').get(),
    db().collection('orders').where('finishedAt', '>=', now - 30 * DAY).get(),
  ]);

  let totalRevenue = 0, totalKeysSold = 0, totalBalance = 0, resellers = 0;
  usersSnap.forEach((d) => {
    const u = d.data();
    totalRevenue += Number(u.totalSpent || 0);
    totalKeysSold += Number(u.totalKeysBought || 0);
    totalBalance += Number(u.balance || 0);
    if (u.role === 'reseller') resellers++;
  });

  let revenue7d = 0, revenue30d = 0, orders7d = 0, orders30d = 0;
  ordersSnap.forEach((d) => {
    const o = d.data();
    if (o.status !== 'completed') return;
    const price = Number(o.price || 0);
    const at = Number(o.finishedAt || 0);
    revenue30d += price; orders30d++;
    if (at >= now - 7 * DAY) { revenue7d += price; orders7d++; }
  });

  const value = {
    totalUsers: usersSnap.size, resellers, totalRevenue, totalKeysSold, totalBalance,
    revenue7d, revenue30d, orders7d, orders30d, at: now,
  };
  memo = { at: now, value };
  return value;
}
