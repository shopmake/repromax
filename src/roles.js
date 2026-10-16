// src/roles.js — account modes. Only TWO now: 'user' and 'reseller'.
//
//   user      retail price (product.price)
//   reseller  product.priceReseller when the admin set one, otherwise retail
//
// Reseller requirement (shown to the user as a progress bar, applied by the
// admin with Telegram /mode or the admin panel — or automatically when
// RESELLER_AUTO_UPGRADE=1 is set on Render):
//   • 8 keys bought   (RESELLER_MIN_KEYS)
//   • NRP 1500 total deposited   (RESELLER_MIN_DEPOSIT)

const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
export const RESELLER_MIN_KEYS = num(process.env.RESELLER_MIN_KEYS, 8);
export const RESELLER_MIN_DEPOSIT = num(process.env.RESELLER_MIN_DEPOSIT, 1500);
export const RESELLER_AUTO_UPGRADE = process.env.RESELLER_AUTO_UPGRADE === '1';

export const ROLES = ['user', 'reseller'];
export const ROLE_LABEL = { user: 'USER', reseller: 'RESELLER' };

/** Anything unknown (old 'pro_reseller', typos, missing) counts as a normal user. */
export const roleOf = (data) => (data && data.role === 'reseller' ? 'reseller' : 'user');

/** "Reseller", "r", "USER", "u" -> 'reseller' | 'user'; unknown -> null. */
export function normalizeRole(input) {
  const t = String(input || '').trim().toLowerCase();
  if (t === 'user' || t === 'u') return 'user';
  if (t === 'reseller' || t === 'r') return 'reseller';
  return null;
}

/** Price a given role pays for a stored product doc. */
export function tierPrice(p, role) {
  const retail = Number(p.price);
  const rs = Number(p.priceReseller);
  return role === 'reseller' && rs > 0 ? rs : retail;
}

/** Total money the user has ever had loaded (field kept up to date on every load; falls back to approved requests for old accounts). */
export function totalDeposited(data) {
  if (data && data.totalDeposited !== undefined) return Number(data.totalDeposited) || 0;
  const list = Array.isArray(data?.topupRequests) ? data.topupRequests : [];
  return list.filter((t) => t.status === 'APPROVED').reduce((s, t) => s + Number(t.amount || 0), 0);
}

export function resellerProgress(data) {
  const keys = Number(data?.totalKeysBought || 0);
  const deposited = totalDeposited(data);
  return {
    keys, requiredKeys: RESELLER_MIN_KEYS,
    deposited, requiredDeposit: RESELLER_MIN_DEPOSIT,
    eligible: keys >= RESELLER_MIN_KEYS && deposited >= RESELLER_MIN_DEPOSIT,
  };
}

/**
 * Fields to merge into the SAME transaction that credits `amount` to a user:
 * keeps totalDeposited current and (optionally) auto-upgrades to reseller.
 * Returns { fields, log, upgraded }.
 */
export function depositUpdate(data, amount, balanceAfter, nowIso = new Date().toISOString()) {
  const amt = Number(amount);
  if (!(amt > 0)) return { fields: {}, log: [], upgraded: false };
  const next = { ...data, totalDeposited: totalDeposited(data) + amt };
  const fields = { totalDeposited: next.totalDeposited };
  const log = [];
  let upgraded = false;
  if (RESELLER_AUTO_UPGRADE && roleOf(data) === 'user' && resellerProgress(next).eligible) {
    fields.role = 'reseller';
    upgraded = true;
    log.push({ delta: 0, note: `Auto-upgraded to RESELLER (${RESELLER_MIN_KEYS} keys + NRP ${RESELLER_MIN_DEPOSIT} deposit)`, resultingBalance: balanceAfter, at: nowIso });
  }
  return { fields, log, upgraded };
}

/** Manual mode change (Telegram /mode, admin panel). */
export function roleChangeUpdate(data, role, by, nowIso = new Date().toISOString()) {
  return {
    fields: { role },
    log: [{ delta: 0, note: `Mode changed to "${role}" (by ${by})`, resultingBalance: Number(data?.balance || 0), at: nowIso }],
  };
}
