// src/bootstrap.js — Firestore sets itself up. Nothing to create by hand.
//
// What "auto-create" means here:
//   * Firestore collections do not need creating — they appear the moment
//     the first document is written (users on first login, products when
//     you add one in the admin panel, orders on first purchase, …).
//   * The few documents the app READS before anyone has written them are
//     created automatically on server start (and again on demand if one is
//     ever deleted): config/policy and config/store.
//   * Every query used by this backend is a single-field query, so there are
//     no composite indexes to create either.
//
// The ONE thing code cannot do is create the Firestore *database* itself in a
// brand-new Firebase project (Firebase Console → Build → Firestore Database →
// Create database). If that is missing, this file says so clearly in the logs.

import { db } from './firebase.js';
import { STORE_NAME } from './store.js';

export const DEFAULT_POLICY = {
  title: 'Terms & Policy',
  body:
    `Welcome to ${STORE_NAME}.\n\n` +
    '1. Balance deposits are final and cannot be refunded once added to your account.\n' +
    '2. Keys are delivered instantly after purchase and cannot be refunded once delivered.\n' +
    '3. Do not share your account or your keys with other people.\n' +
    '4. Prices and product availability can change at any time.\n' +
    '5. For help, use the community link inside the app.\n\n' +
    'The store owner can edit this text any time from the admin panel → Policy.',
};

const ALREADY_EXISTS = (e) => e?.code === 6 || /ALREADY_EXISTS/i.test(String(e?.message || ''));
const NOT_FOUND = (e) => e?.code === 5 || /NOT_FOUND/i.test(String(e?.message || ''));

/** Creates a doc only if it does not exist yet. Never overwrites. Returns true if it created it. */
async function createIfMissing(ref, data) {
  try {
    await ref.create(data);
    return true;
  } catch (e) {
    if (ALREADY_EXISTS(e)) return false;
    throw e;
  }
}

/** Make sure the policy doc exists (also called by the policy cache if it ever finds it missing). */
export function ensurePolicyDoc() {
  return createIfMissing(db().collection('config').doc('policy'), { ...DEFAULT_POLICY, updatedAt: Date.now() });
}

export async function ensureFirestore() {
  const created = [];
  if (await ensurePolicyDoc()) created.push('config/policy');
  if (await createIfMissing(db().collection('config').doc('store'), { name: STORE_NAME, schemaVersion: 1, createdAt: Date.now() })) {
    created.push('config/store');
  }
  return created;
}

/** Fire-and-forget on server start. Retries a few times, never crashes the server. */
export async function startBootstrap() {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const created = await ensureFirestore();
      console.log(created.length ? `[bootstrap] Firestore ready — created: ${created.join(', ')}` : '[bootstrap] Firestore ready');
      return true;
    } catch (e) {
      if (NOT_FOUND(e)) {
        console.error('[bootstrap] Firestore database not found in this Firebase project. ' +
          'One-time step: Firebase Console → Build → Firestore Database → Create database. Then redeploy/restart.');
        return false;
      }
      console.error(`[bootstrap] attempt ${attempt} failed:`, e?.message || e);
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  return false;
}
