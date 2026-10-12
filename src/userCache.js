// src/userCache.js — read-through cache for the tiny users/{uid} document.
//
// Display routes (balance, history, reseller-progress, policy-ack,
// announcement…) call getUserDoc(uid) instead of hitting Firestore
// directly. Within the TTL they share one real read, and concurrent
// callers share a single in-flight read.
//
// EVERY code path that WRITES users/{uid} must call invalidateUserDoc(uid)
// right after (profile save, admin balance edits, employee top-ups,
// completed purchases, reseller-API orders, policy-ack, …) so the very
// next read sees the new value instead of a stale one.
//
// NOT used for anything money-critical: checkout, admin/employee balance
// edits, and redeem read through tx.get(ref) inside a
// transaction (or an explicit fresh .get()), so they never see this cache.
import { db } from './firebase.js';
import { cachedKeyedLoader, TTL } from './cache.js';
import { bumpUser, bumpAllUsers } from './versions.js';

const users = cachedKeyedLoader(async (uid) => {
  const snap = await db().collection('users').doc(uid).get();
  return { exists: snap.exists, data: snap.exists ? snap.data() : null, at: Date.now() };
}, { ttlMs: TTL.userDoc, name: 'userDoc' });

export function getUserDoc(uid) {
  return users.get(uid);
}

/** Call right after writing to a user's doc anywhere in the app. */
export function invalidateUserDoc(uid) {
  users.invalidate(uid);
  bumpUser(uid); // tells the user's open browsers to refetch balance/profile/history
}

/** For bulk writers (e.g. backfill-stats) that touch many users at once. */
export function invalidateAllUserDocs() {
  users.invalidateAll();
  bumpAllUsers();
}
