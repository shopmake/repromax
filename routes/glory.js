import express from 'express';
import { recordRevenue } from '../src/revenue.js';
import admin from 'firebase-admin';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { telegramNotify, esc } from '../src/telegram.js';
import { invalidateUserDoc } from '../src/userCache.js';
import { getStock, reserveSlot, invalidateStock } from '../src/gloryStock.js';
import { gloryCall, gloryConfigured, serialized, getRegions, nrpPriceForTier, GloryError } from '../src/glory.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

const COL = 'gloryGroups';
const maxGroups = () => Math.max(1, Number(process.env.GLORY_MAX_GROUPS_PER_USER || 5));

// One launch at a time per user — stops a double-click / double-tab from
// charging NRP twice.
const launching = new Set();

// Be tolerant about how the upstream names the new group's id.
function pickId(o) {
  if (!o || typeof o !== 'object') return '';
  const v = o.group_id || o.groupId || o.id
    || (o.group && (o.group.group_id || o.group.id))
    || (o.data && (o.data.group_id || o.data.id));
  return v ? String(v) : '';
}

// Fallback: newest upstream group for this clan that we haven't recorded yet.
async function findNewGroup(clanId) {
  const list = await gloryCall('GET', '/api/client/my-groups');
  const cands = (Array.isArray(list) ? list : [])
    .filter((g) => String(g.clan_id) === clanId)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  for (const g of cands) {
    const known = await db().collection(COL).doc(String(g.group_id)).get();
    if (!known.exists) return String(g.group_id);
  }
  return '';
}

function fail(res, e) {
  if (e instanceof GloryError) return res.status(e.status >= 400 && e.status < 600 ? e.status : 502).json({ success: false, error: e.message });
  throw e;
}


// ---- Live details (clan name, level, members, captain, glory) ----
// The upstream docs don't show the exact reply shape of get-glory /
// get-clan-info, so the fields are looked up under several common names.
function dig(o, keys, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 3) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && typeof v !== 'object') return v;
  }
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const r = dig(v, keys, depth + 1);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}
// Turn any reply into a flat { key: primitive } map for the Details / Squad Info popups.
function flat(o, prefix = '', out = {}, depth = 0) {
  if (o === null || o === undefined) return out;
  if (typeof o !== 'object') { out[prefix || 'value'] = o; return out; }
  if (depth > 2) return out;
  for (const [k, v] of Object.entries(o)) {
    if (Object.keys(out).length >= 40) break;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) out[prefix + k] = v.every((x) => typeof x !== 'object') ? v.join(', ') : `${v.length} items`;
    else if (typeof v === 'object') flat(v, prefix + k + '.', out, depth + 1);
    else out[prefix + k] = v;
  }
  return out;
}

const detailsCache = new Map(); // groupId -> { at, data }
const DETAILS_TTL = 40_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every call to the upstream group-action endpoint goes through ONE queue
// (the reseller account is shared; parallel calls give 409 "operation in
// progress"). A 409 is retried twice after a short pause.
function groupAction(action, groupId, timeoutMs = 30000) {
  return serialized(async () => {
    for (let i = 0; ; i++) {
      try {
        const out = await gloryCall('POST', '/api/client/group-action', { body: { action, group_id: groupId }, timeoutMs });
        if (out && typeof out === 'object' && (out.success === false || (out.error && out.success !== true))) {
          throw new GloryError(String(out.error || 'Service returned an error.'), { status: 502 });
        }
        return out;
      } catch (e) {
        if (e instanceof GloryError && e.status === 409 && i < 2) { await sleep(1500); continue; }
        throw e;
      }
    }
  });
}
const errText = (e) => (e instanceof GloryError ? `${e.message}${e.status ? ` (HTTP ${e.status})` : ''}` : 'Unexpected error');


// ---- "Last match" ----------------------------------------------------
// The upstream never documents a last-match field, so we work it out from
// the best source available (in this order):
//   1. an explicit timestamp in the get-glory / get-clan-info / my-groups reply
//   2. we saw the glory number go UP between two polls (a match just ended)
//   3. the newest glory-progression snapshot where glory grew
const LAST_MATCH_KEYS = [
  'last_match_at', 'last_match_time', 'last_match', 'lastMatchAt', 'lastMatchTime', 'lastMatch',
  'last_match_ts', 'last_game_at', 'last_game_time', 'last_game', 'last_played', 'last_played_at',
  'last_active', 'last_activity',
];
const GAMES_KEYS = ['games', 'games_played', 'matches', 'match_count', 'matches_played', 'total_games', 'total_matches', 'game_count'];

// Accept ISO strings, "2026-03-28 10:00:00", epoch seconds or epoch millis.
function toIso(v) {
  if (v === undefined || v === null || v === '') return null;
  let d;
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) {
    const n = Number(v);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    let str = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str)) str = str.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(str)) str += 'Z'; // no zone = UTC
    d = new Date(str);
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const gloryMemory = new Map(); // groupId -> { glory, changedAt }
function noteGlory(groupId, glory) {
  const n = Number(glory);
  if (!Number.isFinite(n)) return null;
  const prev = gloryMemory.get(groupId);
  if (!prev) { gloryMemory.set(groupId, { glory: n, changedAt: null }); return null; }
  if (n > prev.glory) { gloryMemory.set(groupId, { glory: n, changedAt: new Date().toISOString() }); }
  else if (n !== prev.glory) { gloryMemory.set(groupId, { ...prev, glory: n }); }
  return gloryMemory.get(groupId).changedAt;
}

// Newest snapshot where total glory grew compared with the one before it.
async function lastGrowthFromSnapshots(groupId) {
  try {
    const out = await groupAction_progress(groupId);
    const snaps = (Array.isArray(out?.snapshots) ? out.snapshots : [])
      .map((x) => ({ at: toIso(x.captured_at), glory: Number(x.total_glory) }))
      .filter((x) => x.at && Number.isFinite(x.glory))
      .sort((a, b) => a.at.localeCompare(b.at));
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i].glory > snaps[i - 1].glory) return { at: snaps[i].at, gain: snaps[i].glory - snaps[i - 1].glory };
    }
  } catch (_) { /* optional */ }
  return null;
}
const groupAction_progress = (groupId) => serialized(() => gloryCall('GET', '/api/client/glory-progression', {
  query: { group_id: groupId }, timeoutMs: 15000,
}));

async function loadDetails(groupId, fresh = false, listRow = null) {
  const hit = detailsCache.get(groupId);
  if (!fresh && hit && Date.now() - hit.at < DETAILS_TTL) return hit.data;

  const errors = {};
  let g = null; let c = null;
  try { g = await groupAction('get-glory', groupId); } catch (e) { errors.glory = errText(e); }
  try { c = await groupAction('get-clan-info', groupId); } catch (e) { errors.clan = errText(e); }

  if (g === null && c === null) {
    if (hit) return { ...hit.data, stale: true, errors };
    const err = new GloryError(`Live info unavailable — ${Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; ')}`, { status: 502 });
    throw err;
  }

  const gloryVal = typeof g === 'number' ? g : dig(g, ['glory', 'total_glory', 'points', 'score', 'clan_glory']);
  const data = {
    clanName: dig(c, ['clan_name', 'clanName', 'name', 'guild_name']) ?? dig(g, ['clan_name', 'clanName']),
    level: dig(c, ['clan_level', 'clanLevel', 'level']),
    members: dig(c, ['member_num', 'member_count', 'memberCount', 'members', 'current_members']),
    capacity: dig(c, ['capacity', 'member_capacity', 'max_members', 'maxMembers', 'max_member']),
    captain: dig(c, ['captain_id', 'captainId', 'captain', 'leader_id', 'leader']),
    glory: gloryVal ?? dig(c, ['glory', 'total_glory', 'clan_glory']),
    games: dig(g, GAMES_KEYS) ?? dig(c, GAMES_KEYS),
    clan: flat(c),
    gloryInfo: flat(typeof g === 'object' ? g : { glory: g }),
    errors,
    updatedAt: new Date().toISOString(),
    raw: JSON.stringify({ glory: g, clan: c }).slice(0, 800),
  };
  // Last match: explicit field > glory just went up > newest growth snapshot.
  let lastMatchAt = toIso(dig(g, LAST_MATCH_KEYS) ?? dig(c, LAST_MATCH_KEYS) ?? (listRow && dig(listRow, LAST_MATCH_KEYS)));
  let lastMatchSource = lastMatchAt ? 'upstream' : '';
  const seen = noteGlory(groupId, data.glory);
  if (!lastMatchAt && seen) { lastMatchAt = seen; lastMatchSource = 'live'; }
  if (!lastMatchAt) {
    const snap = await lastGrowthFromSnapshots(groupId);
    if (snap) { lastMatchAt = snap.at; lastMatchSource = 'history'; data.lastMatchGain = snap.gain; }
  }
  data.lastMatchAt = lastMatchAt;
  data.lastMatchSource = lastMatchSource;
  detailsCache.set(groupId, { at: Date.now(), data });
  return data;
}

async function ownGroup(req, res) {
  const gid = String(req.query.group_id || '').trim();
  if (!gid) { res.status(400).json({ success: false, error: 'Missing group_id.' }); return null; }
  const doc = await db().collection(COL).doc(gid).get();
  if (!doc.exists || doc.data().uid !== req.uid || doc.data().status === 'deleted') {
    res.status(404).json({ success: false, error: 'Group not found.' });
    return null;
  }
  return doc.data();
}

// GET /api/glory/regions — enabled regions with the NRP price for each.
router.get('/regions', asyncHandler(async (req, res) => {
  try {
    const p = await getRegions();
    const regions = (p.regions || [])
      .filter((r) => r.enabled && r.tier !== 'premium')
      .map((r) => ({
        id: r.id, name: r.region_name, code: r.region_code, tier: r.tier,
        priceNrp: nrpPriceForTier(r.tier),
      }));
    let stock = null;
    try { stock = await getStock(); } catch (_) { /* stock is optional */ }
    res.json({ success: true, configured: gloryConfigured(), regions, maxGroups: maxGroups(), stock });
  } catch (e) { return fail(res, e); }
}));

// "8h goal" = 480 minutes of uptime. Parses upstream uptime like "7h 40m", "1d 2h", "7h14m0s".
function uptimeMinutes(str) {
  if (!str) return 0;
  const m = String(str).match(/(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i) || [];
  return (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
}
const ARCHIVE_GRACE_MS = 3 * 60 * 1000; // never archive a group that was only just launched

// GET /api/glory/groups — only THIS user's LIVE groups, merged with live status.
// Groups that have ENDED upstream (or finished their 8h goal and stopped) are
// archived here: removed from this list, kept for the History page, and their
// stock slot is freed.
router.get('/groups', asyncHandler(async (req, res) => {
  const snap = await db().collection(COL).where('uid', '==', req.uid).get();
  const mine = snap.docs.map((d) => d.data()).filter((g) => g.status === 'running' || g.status === 'stopped');

  let live = new Map();
  let liveOk = false;
  if (mine.length && gloryConfigured()) {
    try {
      const list = await gloryCall('GET', '/api/client/my-groups');
      if (Array.isArray(list)) { live = new Map(list.map((g) => [g.group_id, g])); liveOk = true; }
    } catch (_) { /* show stored data if the upstream is down */ }
  }

  const groups = [];
  const toArchive = [];
  const toSaveBots = []; // remember the real bot count so History can show it later
  for (const g of mine) {
    const l = live.get(g.groupId);
    if (l && l.container_count && Number(g.botCount || 0) !== Number(l.container_count)) toSaveBots.push({ id: g.groupId, n: Number(l.container_count) });
    const old = Date.now() - new Date(g.createdAt || 0).getTime() > ARCHIVE_GRACE_MS;
    const status = l ? l.status : (liveOk ? 'ended' : (g.status || 'unknown'));
    const finished = status === 'ended' || (status === 'stopped' && l && uptimeMinutes(l.uptime) >= 480);
    if (finished && old && liveOk) { toArchive.push({ g, uptime: l ? l.uptime : '' }); continue; }
    groups.push({
      groupId: g.groupId, clanId: g.clanId, region: g.regionName || g.region,
      price: g.price, createdAt: g.createdAt, status,
      uptime: l ? l.uptime : '',
      botCount: l ? l.container_count : (g.botCount || 0),
      running: l ? l.running_count : 0,
    });
  }

  if (toArchive.length || toSaveBots.length) {
    try {
      const batch = db().batch();
      for (const t of toSaveBots) batch.set(db().collection(COL).doc(t.id), { botCount: t.n }, { merge: true });
      for (const { g, uptime } of toArchive) {
        batch.set(db().collection(COL).doc(g.groupId), {
          status: 'ended', endedAt: new Date().toISOString(), lastUptime: uptime || '',
          botCount: g.botCount || 0,
        }, { merge: true });
      }
      await batch.commit();
      if (toArchive.length) invalidateStock(); // ended groups free their slot
    } catch (e) { console.error('[glory] archive failed', e); }
  }

  groups.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ success: true, groups });
}));

// GET /api/glory/history — this user's finished launches (ended / deleted).
router.get('/history', asyncHandler(async (req, res) => {
  const snap = await db().collection(COL).where('uid', '==', req.uid).get();
  const items = snap.docs.map((d) => d.data())
    .filter((g) => (g.status === 'ended' || g.status === 'deleted') && !g.hiddenHistory)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((g) => ({
      groupId: g.groupId, clanId: g.clanId, region: g.regionName || g.region,
      price: Number(g.price || 0), botCount: Number(g.botCount || 0),
      status: g.status, createdAt: g.createdAt, endedAt: g.endedAt || g.deletedAt || null,
    }));
  res.json({ success: true, history: items });
}));

// POST /api/glory/history-clear — hides this user's finished launches from their history.
router.post('/history-clear', asyncHandler(async (req, res) => {
  const snap = await db().collection(COL).where('uid', '==', req.uid).get();
  const batch = db().batch();
  let n = 0;
  for (const d of snap.docs) {
    const g = d.data();
    if ((g.status === 'ended' || g.status === 'deleted') && !g.hiddenHistory) { batch.set(d.ref, { hiddenHistory: true }, { merge: true }); n++; }
  }
  if (n) await batch.commit();
  res.json({ success: true, cleared: n });
}));

// POST /api/glory/launch { region, clan_id }
router.post('/launch', rateLimit({ windowMs: 60_000, max: 6, name: 'glory-launch' }), asyncHandler(async (req, res) => {
  const regionId = String(req.body?.region || '').trim();
  const clanId = String(req.body?.clan_id || '').trim();
  if (!/^\d{5,15}$/.test(clanId)) {
    return res.status(400).json({ success: false, error: 'Enter a valid Clan ID (numbers only).' });
  }
  if (!gloryConfigured()) {
    return res.status(503).json({ success: false, error: 'FF Glory is not available right now.' });
  }
  if (launching.has(req.uid)) {
    return res.status(409).json({ success: false, error: 'A launch is already in progress.' });
  }
  launching.add(req.uid);
  let releaseSlot = () => {};

  try {
    let region;
    try {
      region = ((await getRegions()).regions || []).find((r) => r.id === regionId && r.enabled && r.tier !== 'premium');
    } catch (e) { return fail(res, e); }
    if (!region) return res.status(400).json({ success: false, error: 'Invalid or disabled region.' });

    const price = nrpPriceForTier(region.tier);

    // Per-user group cap
    const existing = await db().collection(COL).where('uid', '==', req.uid).get();
    const active = existing.docs.filter((d) => d.data().status === 'running').length;
    if (active >= maxGroups()) {
      return res.status(403).json({ success: false, error: `You can run up to ${maxGroups()} groups at once. Stop or delete one first.` });
    }

    // Stock: admin-set number of Glory Bot slots (off = unlimited).
    const slot = await reserveSlot();
    if (!slot.ok) {
      return res.status(409).json({
        success: false, code: 'OUT_OF_STOCK', stock: slot.stock,
        error: 'FF Glory Bot is out of stock right now. Please check back soon.',
      });
    }
    releaseSlot = slot.release;

    // 1) Charge NRP atomically (before calling upstream).
    const userRef = db().collection('users').doc(req.uid);
    const charged = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};
      const balance = Number(data.balance || 0);
      if (balance < price) return { ok: false, balance };
      tx.set(userRef, {
        balance: balance - price,
        totalSpent: admin.firestore.FieldValue.increment(price),
      }, { merge: true });
      return { ok: true, balance, newBalance: balance - price, label: data.profileName || req.email };
    });
    if (!charged.ok) {
      return res.status(402).json({
        success: false, code: 'INSUFFICIENT_BALANCE',
        error: `You need NRP ${price} to launch this group. Please top up first.`,
        balance: charged.balance, required: price,
      });
    }
    invalidateUserDoc(req.uid);
    recordRevenue(price);

    const refund = async () => {
      recordRevenue(-price);
      await userRef.set({
        balance: admin.firestore.FieldValue.increment(price),
        totalSpent: admin.firestore.FieldValue.increment(-price),
      }, { merge: true });
      invalidateUserDoc(req.uid);
    };

    // 2) Launch upstream (one at a time across all users).
    let out;
    try {
      out = await serialized(async () => {
        const r = await gloryCall('POST', '/api/client/auto-clan-group', {
          body: { region: region.id, clan_id: clanId },
        });
        let id = pickId(r);
        if (!id && !(r && r.success === false)) {
          // Upstream said OK but we couldn't read the id — find the new group by clan.
          console.error('[glory] launch reply had no group id:', JSON.stringify(r).slice(0, 500));
          id = await findNewGroup(clanId);
        }
        if (!id) {
          const err = new GloryError('FF Glory service returned an unexpected reply.', { status: 502 });
          err.detail = JSON.stringify(r).slice(0, 300);
          throw err;
        }
        return { ...(r || {}), group_id: id };
      });
    } catch (e) {
      if (e instanceof GloryError && e.timeout) {
        // The group may have been created — do NOT auto-refund; flag for manual review.
        telegramNotify(`⚠️ <b>Glory launch TIMEOUT</b>\nUser: <code>${esc(req.uid)}</code>\nClan: ${esc(clanId)} · ${esc(region.id)}\nCharged NRP ${price} — check ffglory.pro and refund if no group exists.`);
        return res.status(504).json({ success: false, error: 'The service took too long. Your NRP was held — contact support if no group appears shortly.' });
      }
      await refund();
      telegramNotify(`❌ <b>Glory launch failed</b> (refunded)\nUser: <code>${esc(req.uid)}</code>\nClan: ${esc(clanId)} · ${esc(region.id)}\n${esc(e.message)}${e.detail ? '\nReply: <code>' + esc(e.detail) + '</code>' : ''}`);
      return fail(res, e);
    }

    // 3) Remember who owns the group.
    const record = {
      uid: req.uid, groupId: out.group_id, clanId, region: region.id, regionName: region.region_name,
      tier: region.tier, price, botCount: out.bot_count || 0, status: 'running',
      createdAt: new Date().toISOString(),
    };
    try {
      await db().collection(COL).doc(out.group_id).set(record);
    } catch (e) {
      console.error('[glory] failed to save ownership record', out.group_id, e);
      telegramNotify(`🚨 <b>Glory group launched but NOT saved</b>\nGroup: <code>${esc(out.group_id)}</code>\nUser: <code>${esc(req.uid)}</code>`);
    }

    telegramNotify(`🤖 <b>Glory launched</b>\n${esc(charged.label)}\nClan: ${esc(clanId)} · ${esc(region.id)} (${esc(region.tier)})\nNRP ${price} → balance ${charged.newBalance}`);
    res.json({ success: true, groupId: out.group_id, newBalance: charged.newBalance, group: record });
  } finally {
    releaseSlot();
    launching.delete(req.uid);
  }
}));

// POST /api/glory/action { group_id, action }
const ACTIONS = new Set(['restart', 'stop', 'delete', 'get-glory', 'get-clan-info']);
router.post('/action', rateLimit({ windowMs: 60_000, max: 40, name: 'glory-action' }), asyncHandler(async (req, res) => {
  const groupId = String(req.body?.group_id || '').trim();
  const action = String(req.body?.action || '').trim();
  if (!groupId || !ACTIONS.has(action)) {
    return res.status(400).json({ success: false, error: 'Invalid request.' });
  }
  const ref = db().collection(COL).doc(groupId);
  const doc = await ref.get();
  // Ownership check — a user can only touch their own groups.
  if (!doc.exists || doc.data().uid !== req.uid || doc.data().status === 'deleted') {
    return res.status(404).json({ success: false, error: 'Group not found.' });
  }

  try {
    const run = () => gloryCall('POST', '/api/client/group-action', { body: { action, group_id: groupId } });
    const mutating = action === 'restart' || action === 'stop' || action === 'delete';
    const out = mutating ? await serialized(run) : await run();

    if (action === 'stop') await ref.set({ status: 'stopped' }, { merge: true });
    if (action === 'restart') await ref.set({ status: 'running' }, { merge: true });
    if (action === 'delete') { await ref.set({ status: 'deleted', deletedAt: new Date().toISOString() }, { merge: true }); invalidateStock(); }

    res.json({ success: true, result: out });
  } catch (e) { return fail(res, e); }
}));

// GET /api/glory/details?group_id=X[&fresh=1] — live glory + clan info for ONE of your groups.
router.get('/details', rateLimit({ windowMs: 60_000, max: 60, name: 'glory-details' }), asyncHandler(async (req, res) => {
  if (!(await ownGroup(req, res))) return;
  try {
    const details = await loadDetails(String(req.query.group_id), req.query.fresh === '1');
    res.json({ success: true, details });
  } catch (e) { return fail(res, e); }
}));

// GET /api/glory/progress?group_id=X — glory timeline (documented endpoint).
router.get('/progress', rateLimit({ windowMs: 60_000, max: 30, name: 'glory-progress' }), asyncHandler(async (req, res) => {
  if (!(await ownGroup(req, res))) return;
  try {
    const out = await serialized(() => gloryCall('GET', '/api/client/glory-progression', {
      query: { group_id: String(req.query.group_id) }, timeoutMs: 20000,
    }));
    const snaps = Array.isArray(out?.snapshots) ? out.snapshots : [];
    res.json({
      success: true,
      clanId: out?.clan_id, gloryFarmed: out?.glory_farmed,
      snapshots: snaps.slice(-12).map((x) => ({ at: x.captured_at, glory: x.total_glory, hours: x.uptime_hours })),
    });
  } catch (e) { return fail(res, e); }
}));

export default router;
