// src/profileRules.js — how often each profile field may be changed, plus
// input cleaning. Enforced on the SERVER (the browser only mirrors it).
//
//   photo        1 change / 7 days
//   name         1 change / 7 days
//   WhatsApp no. 1 change / 2 days
//
// Filling a field for the very first time (signup / "complete your profile")
// never starts the name/phone cooldown, so a typo at signup isn't locked in.
const DAY = 24 * 60 * 60 * 1000;

export const LIMITS_MS = { avatar: 7 * DAY, name: 7 * DAY, phone: 2 * DAY };
export const LABELS = { avatar: 'profile photo', name: 'name', phone: 'WhatsApp number' };

/** Timestamps (ms) when each field unlocks again; 0 = free to change now. */
export function computeLocks(data, now = Date.now()) {
  const at = (data && data.profileChangeAt) || {};
  const out = {};
  for (const f of Object.keys(LIMITS_MS)) {
    const next = at[f] ? Number(at[f]) + LIMITS_MS[f] : 0;
    out[f] = next > now ? next : 0;
  }
  return out;
}

export function formatWait(ms) {
  const m = Math.ceil(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${mm}m`;
  return `${Math.max(1, mm)}m`;
}

export class RuleError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

/** Throws a 429 RuleError if `field` is still cooling down. */
export function assertUnlocked(data, field, now = Date.now()) {
  const next = computeLocks(data, now)[field];
  if (next) {
    throw new RuleError(
      `You can change your ${LABELS[field]} again in ${formatWait(next - now)}.`,
      429, { code: 'LOCKED', field, nextAt: next },
    );
  }
}

/**
 * "xxxxxxx.com" / "https://x.com/path" -> "https://x.com/path". '' clears it.
 * Generic so any "paste a link, we'll clean it up" field (an admin-set product
 * download link, ...) can share one real
 * implementation instead of each growing its own copy. `label` only
 * affects the wording of thrown errors.
 */
export function normalizeUrlField(input, label, { maxLen = 200 } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  if (raw.length > maxLen) throw new RuleError(`${label} is too long (max ${maxLen} characters).`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) throw new RuleError(`${label} must start with https:// (or just be a domain like example.com).`);
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try { u = new URL(withScheme); } catch { throw new RuleError(`That ${label.toLowerCase()} is not a valid website address.`); }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) throw new RuleError(`${label} must be a real domain, e.g. example.com`);
  return u.toString().replace(/\/$/, '');
}

/** "myname" / "@myname" -> "@myname". */
export function normalizeTikTokUser(input) {
  const raw = String(input ?? '').trim().replace(/^@+/, '');
  if (!raw) return '';
  if (!/^[A-Za-z0-9._]{2,24}$/.test(raw)) throw new RuleError('TikTok username can only use letters, numbers, dots and underscores (2–24 characters).');
  return `@${raw}`;
}

export function normalizeTikTokName(input) {
  const v = String(input ?? '').trim();
  if (v.length > 60) throw new RuleError('TikTok name is too long (max 60 characters).');
  return v;
}
