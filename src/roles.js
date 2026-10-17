// src/roles.js — account modes. Two only:
//
//   'user'      retail prices (the default for every new account)
//   'reseller'  reseller prices (products[].priceReseller; falls back to retail)
//
// How a user becomes a reseller:
//   * themselves, from the dashboard: 8+ keys bought AND balance >= NRP 1500
//     (both re-checked on the server — POST /api/user/apply-reseller), or
//   * the owner, any time: Telegram /mode  or  admin panel -> Role manager.
//
// Pure functions, no imports, so they can run inside a Firestore transaction.

const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
export const RESELLER_MIN_KEYS = num(process.env.RESELLER_MIN_KEYS, 8);
export const RESELLER_MIN_BALANCE = num(process.env.RESELLER_MIN_BALANCE, 1500);

export const ROLES = ['user', 'reseller'];
export const ROLE_LABEL = { user: 'USER', reseller: 'RESELLER' };

export const isReseller = (role) => role === 'reseller';
export const roleOf = (data) => (data && data.role === 'reseller' ? 'reseller' : 'user');

/** "Reseller", "reseller", "r" -> 'reseller'; "user", "u" -> 'user'; anything else -> null. */
export function normalizeRole(input) {
  const t = String(input || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (t === 'user' || t === 'u') return 'user';
  if (t === 'reseller' || t === 'r') return 'reseller';
  return null;
}

/** Price a role pays for a product doc: reseller -> priceReseller (if set), everyone else -> price. */
export function tierPrice(p, role) {
  if (!p) return 0;
  if (isReseller(role) && Number(p.priceReseller) > 0) return Number(p.priceReseller);
  return Number(p.price);
}

/** Fields + admin-log line for a manual role change (Telegram /mode, admin panel). */
export function roleChangeUpdate(data, role, by, nowIso = new Date().toISOString()) {
  return {
    fields: { role },
    log: [{ delta: 0, note: `Role changed to "${role}" (by ${by})`, resultingBalance: Number((data && data.balance) || 0), at: nowIso }],
  };
}

/** Eligibility numbers for the dashboard progress bar + the apply endpoint. */
export function resellerProgress(data) {
  const totalKeysBought = Number((data && data.totalKeysBought) || 0);
  const balance = Number((data && data.balance) || 0);
  const role = roleOf(data);
  return {
    role, totalKeysBought, balance,
    minKeys: RESELLER_MIN_KEYS, minBalance: RESELLER_MIN_BALANCE,
    eligible: role === 'user' && totalKeysBought >= RESELLER_MIN_KEYS && balance >= RESELLER_MIN_BALANCE,
  };
}
