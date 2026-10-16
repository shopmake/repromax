// src/ban.js — admin bans.
//
// A ban lives on the user's own document:
//   users/{uid}.ban = { permanent, until (ms epoch | null), label, at, by }
//   users/{uid}.banned = true   (flag only so the admin panel can list bans)
//
// A timed ban ends by itself — nothing has to run when it expires, activeBan()
// simply compares `until` with the clock. "Unban" deletes both fields.
//
// Enforcement: requireFirebaseUid (src/firebase.js) calls activeBan() for every
// signed-in request, so a banned account is refused on EVERY user route
// (store, checkout, top-up, profile / photo upload, glory bot, reseller portal…).
// The reseller API and /api/keys check it too (see those routes).

export const BAN_DURATIONS = {
  '1h':        { ms: 1 * 3600_000,       label: '1 Hour' },
  '12h':       { ms: 12 * 3600_000,      label: '12 Hours' },
  '1d':        { ms: 24 * 3600_000,      label: '1 Day' },
  '3d':        { ms: 3 * 24 * 3600_000,  label: '3 Days' },
  '7d':        { ms: 7 * 24 * 3600_000,  label: '7 Days' },
  'permanent': { ms: null,               label: 'Permanent' },
};

/** The ban object if it is in force right now, otherwise null. */
export function activeBan(userData, now = Date.now()) {
  const b = userData && userData.ban;
  if (!b || typeof b !== 'object') return null;
  if (b.permanent === true) return { permanent: true, until: null, label: b.label || 'Permanent', at: b.at || null };
  const until = Number(b.until || 0);
  if (until > now) return { permanent: false, until, label: b.label || '', at: b.at || null };
  return null; // expired
}

export function makeBan(duration, by = 'admin', now = Date.now()) {
  const d = BAN_DURATIONS[duration];
  if (!d) return null;
  return {
    permanent: d.ms === null,
    until: d.ms === null ? null : now + d.ms,
    label: d.label,
    at: now,
    by,
  };
}

/** Body of the 403 a banned account gets. The storefront turns it into the ban screen. */
export function banBody(ban, user = {}) {
  return {
    success: false,
    code: 'BANNED',
    error: 'Your account has been banned by admin.',
    ban: { permanent: ban.permanent, until: ban.until, label: ban.label, serverNow: Date.now() },
    user: { name: String(user.name || ''), uid: String(user.uid || ''), email: String(user.email || '') },
  };
}
