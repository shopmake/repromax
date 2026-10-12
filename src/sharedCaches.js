// src/sharedCaches.js — caches for data that is IDENTICAL for every caller
// (leaderboard, active announcements, policy text). One Firestore read
// serves every user until the TTL expires or an admin write invalidates it.
import { db } from './firebase.js';
import { cachedLoader, TTL } from './cache.js';
import { DEFAULT_POLICY, ensurePolicyDoc } from './bootstrap.js';

// Top 10 by lifetime keys bought. Only name/counts/avatar are exposed,
// never email/phone/balance, since every logged-in user can see this list.
export const leaderboardCache = cachedLoader(async () => {
  const snap = await db().collection('users')
    .orderBy('totalKeysBought', 'desc')
    .limit(10)
    .get();
  return snap.docs
    .map((doc) => {
      const d = doc.data();
      return {
        uid: doc.id,
        name: d.profileName || (d.email ? d.email.split('@')[0] : 'Anonymous'),
        avatarUrl: d.avatarUrl || '',
        totalKeysBought: Number(d.totalKeysBought || 0),
        totalSpent: Number(d.totalSpent || 0),
      };
    })
    .filter((row) => row.totalKeysBought > 0);
}, { ttlMs: TTL.leaderboard, name: 'leaderboard', versionKey: 'leaderboard' });

// Active announcements. Deliberately NOT .where('active').orderBy('createdAt')
// together — that needs a composite index that was never created; the
// newest is picked in memory by the route instead.
export const announcementCache = cachedLoader(async () => {
  const snap = await db().collection('announcements').where('active', '==', true).limit(20).get();
  return snap.empty ? [] : snap.docs.map((d) => d.data());
}, { ttlMs: TTL.announcement, name: 'announcements', versionKey: 'announcement' });

// config/policy — edited only through the admin panel. If the document is
// missing (brand-new Firebase project, or deleted by mistake) it is written
// again automatically with a sensible default instead of failing.
export const policyCache = cachedLoader(async () => {
  const ref = db().collection('config').doc('policy');
  let snap = await ref.get();
  if (!snap.exists) {
    await ensurePolicyDoc();
    snap = await ref.get();
  }
  const data = snap.exists ? snap.data() : {};
  return {
    title: data.title || DEFAULT_POLICY.title,
    body: data.body || DEFAULT_POLICY.body,
    updatedAt: data.updatedAt || null,
  };
}, { ttlMs: TTL.policy, name: 'policy', versionKey: 'policy' });
