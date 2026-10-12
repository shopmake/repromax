// src/employeeLimits.js — the spending rules for employee balance loads.
//
// Kept free of any Firebase import on purpose so the rules can be
// tested on their own. routes/employee.js calls these inside the same
// Firestore transaction that credits the balance, so two simultaneous
// loads can't both slip under a limit.
//
// Three limits, all optional, all set from Render env vars.
// Setting any of them to 0 turns THAT limit off:
//
//   EMPLOYEE_MAX_LOAD        max NRP in ONE load              (default 5000)
//   EMPLOYEE_USER_DAILY_LIMIT max NRP to ONE user per day     (default 10000)
//   EMPLOYEE_DAILY_LIMIT      max NRP across ALL users per day (default 30000)
//
// "Day" = calendar day in Nepal time (Asia/Kathmandu, UTC+5:45), so the
// counters reset at midnight in Nepal, not at midnight UTC.

export const DEFAULTS = { perLoad: 5000, perUserDay: 10000, perDay: 30000 };

// Env var text -> number. Unset/blank/invalid -> fallback. "0" -> 0 (off).
export function envLimit(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

// 0 means "no limit" -> Infinity internally so the maths below is uniform.
const cap = (n) => (n === 0 ? Infinity : n);

export function resolveLimits(env = process.env) {
  return {
    perLoad: cap(envLimit(env.EMPLOYEE_MAX_LOAD, DEFAULTS.perLoad)),
    perUserDay: cap(envLimit(env.EMPLOYEE_USER_DAILY_LIMIT, DEFAULTS.perUserDay)),
    perDay: cap(envLimit(env.EMPLOYEE_DAILY_LIMIT, DEFAULTS.perDay)),
  };
}

// 'YYYY-MM-DD' for the given moment, in Nepal time.
export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

const fmt = (n) => Number(n).toLocaleString('en-US');
const orNull = (n) => (Number.isFinite(n) ? n : null); // Infinity can't go over JSON

// What is left right now, given what's already been loaded today.
// Everything returned is JSON-safe (null = no limit on that axis).
export function remaining({ userLoadedToday = 0, dayLoadedToday = 0, limits }) {
  const userLeft = Math.max(0, limits.perUserDay - userLoadedToday);
  const dayLeft = Math.max(0, limits.perDay - dayLoadedToday);
  const maxNow = Math.max(0, Math.min(limits.perLoad, userLeft, dayLeft));
  return {
    userLoadedToday,
    dayLoadedToday,
    userLeftToday: orNull(userLeft),
    dayLeft: orNull(dayLeft),
    maxNow: orNull(maxNow),
  };
}

// The gatekeeper. Returns { ok:true } or { ok:false, error }.
// The order matters only for which message the employee sees first.
export function checkLoadLimits({ amount, userLoadedToday = 0, dayLoadedToday = 0, limits }) {
  const userLeft = Math.max(0, limits.perUserDay - userLoadedToday);
  const dayLeft = Math.max(0, limits.perDay - dayLoadedToday);

  if (amount > limits.perLoad) {
    return { ok: false, error: `Limit per load is NRP ${fmt(limits.perLoad)}. Ask the owner for larger amounts.` };
  }
  if (amount > userLeft) {
    return {
      ok: false,
      error: userLeft === 0
        ? `This user already got the daily maximum (NRP ${fmt(limits.perUserDay)}). Try again tomorrow or ask the owner.`
        : `Only NRP ${fmt(userLeft)} left for this user today (limit NRP ${fmt(limits.perUserDay)} per user per day).`,
    };
  }
  if (amount > dayLeft) {
    return {
      ok: false,
      error: dayLeft === 0
        ? `Team daily limit reached (NRP ${fmt(limits.perDay)}). Try again tomorrow or ask the owner.`
        : `Only NRP ${fmt(dayLeft)} left in today's team limit (NRP ${fmt(limits.perDay)} per day).`,
    };
  }
  return { ok: true };
}
