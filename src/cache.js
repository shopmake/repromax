// src/cache.js — one small, dependency-free cache primitive used by every
// "read a Firestore collection/doc and serve it to many users" path.
//
// WHY: the old code had ~8 hand-rolled `let xCache; let xCacheAt;` blocks
// with 20–30 SECOND lifetimes. A busy store re-read the whole `feedback`,
// `productStatus`, `customProducts` and `whatsappProducts` collections
// every 30s, which is what drained the free 50K reads/day quota.
//
// WHAT THIS GIVES YOU
//   • Long TTL (default 10 min, tunable via env) — data is re-read only
//     when it has genuinely expired…
//   • …or when a writer calls invalidate()/patch() because it KNOWS the
//     data changed. Changes made through this backend are visible at once.
//   • Single-flight: if 50 requests arrive while the cache is empty/expired
//     they share ONE Firestore read instead of firing 50.
//   • Stale-on-error: if Firestore fails (network blip, or quota
//     exhausted = RESOURCE_EXHAUSTED) the last good copy is served instead
//     of a 500. The storefront keeps working even when quota runs out.
//   • patch(fn): update just the changed part of a cached value in place
//     (e.g. one changed item) instead of dropping the cache and re-reading
//     the whole collection.

import { bump } from './versions.js';

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const MIN = 60 * 1000;

/** All lifetimes in one place. Override any of them on Render via env vars (milliseconds). */
export const TTL = {
  // Catalog-ish collections (products, maintenance flags). Writers
  // invalidate/patch explicitly, so a long TTL is safe.
  catalog: num('CATALOG_CACHE_TTL_MS', 10 * MIN),
  // Top-10 leaderboard (changes on every purchase, nobody needs it live).
  leaderboard: num('LEADERBOARD_CACHE_TTL_MS', 5 * MIN),
  // Active announcement list (admin writes invalidate it).
  announcement: num('ANNOUNCEMENT_CACHE_TTL_MS', 10 * MIN),
  // Terms & policy text (admin writes invalidate it).
  policy: num('POLICY_CACHE_TTL_MS', 30 * MIN),
  // One users/{uid} doc. Every writer calls invalidateUserDoc(); kept short
  // because it holds money fields and it is per-user (the browser cache is
  // what absorbs page-to-page navigation now).
  userDoc: num('USER_DOC_CACHE_TTL_MS', 60 * 1000),
};

/**
 * @param {() => Promise<any>} load  reads from Firestore and returns the value to cache
 * @param {{ttlMs:number, name?:string}} opts
 */
export function cachedLoader(load, { ttlMs, name = 'cache', versionKey = null }) {
  let value;
  let at = 0;          // 0 = nothing usable cached
  let inflight = null;
  let generation = 0;  // bumped by invalidate() so a read that started BEFORE a write can't re-cache old data

  async function get() {
    if (at && Date.now() - at < ttlMs) return value;
    if (inflight) return inflight;

    const startedIn = generation;
    inflight = (async () => {
      try {
        const v = await load();
        if (startedIn === generation) { value = v; at = Date.now(); }
        return v;
      } catch (e) {
        if (at) {
          console.error(`[cache:${name}] refresh failed, serving stale copy:`, e?.message || e);
          return value;
        }
        throw e;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    get,
    /** Drop the cached copy; the next get() re-reads Firestore. Use when you don't know exactly what changed. */
    invalidate() { generation++; at = 0; inflight = null; if (versionKey) bump(versionKey); },
    /** Change the cached value in place (only if one is cached). Use when you know exactly what changed. */
    patch(fn) { if (at) value = fn(value); if (versionKey) bump(versionKey); },
    /** Replace the cached value outright. */
    set(v) { value = v; at = Date.now(); if (versionKey) bump(versionKey); },
    peek() { return at ? value : undefined; },
  };
}

/**
 * Keyed variant (e.g. one entry per uid) with the same guarantees plus a
 * size cap so a long-running server can't grow without bound.
 */
export function cachedKeyedLoader(load, { ttlMs, name = 'keyed-cache', maxEntries = 5000 }) {
  const entries = new Map(); // key -> { value, at }
  const inflight = new Map();
  const generation = new Map(); // key -> n

  async function get(key) {
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    if (inflight.has(key)) return inflight.get(key);

    const startedIn = generation.get(key) || 0;
    const p = (async () => {
      try {
        const v = await load(key);
        if ((generation.get(key) || 0) === startedIn) {
          if (entries.size >= maxEntries) entries.delete(entries.keys().next().value); // oldest first
          entries.set(key, { value: v, at: Date.now() });
        }
        return v;
      } catch (e) {
        if (hit) {
          console.error(`[cache:${name}] refresh failed for ${key}, serving stale copy:`, e?.message || e);
          return hit.value;
        }
        throw e;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  return {
    get,
    invalidate(key) {
      generation.set(key, (generation.get(key) || 0) + 1);
      entries.delete(key);
      inflight.delete(key);
    },
    invalidateAll() { entries.clear(); inflight.clear(); generation.clear(); },
  };
}
