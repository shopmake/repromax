// src/gloryStock.js — "slots in stock" for the FF Glory Bot.
//
// The admin sets a TOTAL (config/gloryStock { enabled, total }). Every glory
// group that is still alive (status running / stopped — i.e. not deleted)
// uses one slot, so  available = total - used.  A slot is freed when the
// user deletes the group, or when the admin raises the total.
//
// enabled === false (the default) means "no limit" — nothing changes for
// stores that never touch this setting.
//
// Launches reserve a slot behind a small lock so two people pressing
// "Launch" at the same moment can never take the last slot twice.
import { db } from './firebase.js';

const COL = 'gloryGroups';
const CACHE_MS = 15_000;

let cache = { at: 0, data: null };
let reserved = 0; // launches currently in flight (not yet saved)

export function invalidateStock() { cache.at = 0; }

async function readConfig() {
  const snap = await db().collection('config').doc('gloryStock').get();
  const d = snap.exists ? snap.data() : {};
  return {
    enabled: d.enabled === true,
    total: Math.max(0, Math.floor(Number(d.total) || 0)),
    updatedAt: d.updatedAt || null,
  };
}

async function countUsed() {
  const q = db().collection(COL).where('status', 'in', ['running', 'stopped']);
  try {
    const agg = await q.count().get(); // 1 cheap aggregate read
    return agg.data().count;
  } catch (_) {
    return (await q.get()).size;
  }
}

function view(d) {
  const used = d.used + reserved;
  return {
    enabled: d.enabled,
    total: d.total,
    used,
    available: d.enabled ? Math.max(0, d.total - used) : null,
    updatedAt: d.updatedAt,
  };
}

export async function getStock({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < CACHE_MS) return view(cache.data);
  const cfg = await readConfig();
  const used = cfg.enabled ? await countUsed() : 0;
  cache = { at: Date.now(), data: { ...cfg, used } };
  return view(cache.data);
}

export async function setStock({ enabled, total }) {
  await db().collection('config').doc('gloryStock').set({
    enabled: !!enabled,
    total: Math.max(0, Math.floor(Number(total) || 0)),
    updatedAt: Date.now(),
  }, { merge: true });
  invalidateStock();
  return getStock({ fresh: true });
}

let lock = Promise.resolve();
// -> { ok:true, release() } or { ok:false, stock }
export function reserveSlot() {
  const run = lock.then(async () => {
    const s = await getStock({ fresh: true });
    if (!s.enabled) return { ok: true, release() {} };
    if (s.available <= 0) return { ok: false, stock: s };
    reserved++;
    let done = false;
    return {
      ok: true,
      release() {
        if (done) return;
        done = true;
        reserved = Math.max(0, reserved - 1);
        invalidateStock(); // the saved group is counted from now on
      },
    };
  });
  lock = run.catch(() => {});
  return run;
}
