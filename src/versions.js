// src/versions.js — "what changed?" stamps, held purely in memory.
//
// Every time a writer invalidates a cache (admin loads balance, product edited,
// review posted, avatar changed…) a counter here is bumped. Browsers poll
// GET /api/user/sync (a few bytes, ZERO Firestore reads) and compare the stamps
// with the ones they saw last; only the datasets whose stamp changed are
// refetched. That is what makes an admin top-up appear within seconds instead of
// after the browser cache's 30-minute lifetime.
//
// Stamps include a per-process bootId, so after a server restart every client
// sees "changed" once and refreshes — safe default.
const bootId = Date.now().toString(36);
const counters = new Map();      // global dataset -> n
const userCounters = new Map();  // uid -> n   (user doc: balance, profile, history…)
let userEpoch = 0;               // bumped when ALL user docs may have changed

export const GLOBAL_KEYS = ['catalog', 'leaderboard', 'announcement', 'policy'];

export function bump(key) { counters.set(key, (counters.get(key) || 0) + 1); }
export function bumpUser(uid) {
  if (userCounters.size > 50000) userCounters.clear(); // safety valve; clearing only forces a one-time refresh
  userCounters.set(uid, (userCounters.get(uid) || 0) + 1);
}
export function bumpAllUsers() { userEpoch++; }

export function getVersions(uid) {
  const out = { user: `${bootId}.${userEpoch}.${userCounters.get(uid) || 0}` };
  for (const k of GLOBAL_KEYS) out[k] = `${bootId}.${counters.get(k) || 0}`;
  return out;
}
