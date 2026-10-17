// src/adminOps.js — account operations shared by the Telegram bot commands
// (/loadbalance, /deductbalance, /getinfo, /mode). Same rules as the admin panel:
// balance changes are transactional and written to the user's adminLog.
import { db } from './firebase.js';
import { invalidateUserDoc } from './userCache.js';
import { notifyBalanceChange } from './balanceAlerts.js';
import { roleChangeUpdate, ROLE_LABEL, roleOf } from './roles.js';
import { esc } from './telegram.js';

export const MAX_BOT_LOAD = 100000;
const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;

/** Find a user by Firebase UID or e-mail. Returns { uid, data } or null. */
export async function findUser(identifier) {
  const idf = String(identifier || '').trim();
  if (!idf || idf.length > 200) return null;
  if (idf.includes('@')) {
    for (const e of new Set([idf, idf.toLowerCase()])) {
      const q = await db().collection('users').where('email', '==', e).limit(1).get();
      if (!q.empty) return { uid: q.docs[0].id, data: q.docs[0].data() };
    }
    return null;
  }
  if (idf.includes('/')) return null; // invalid Firestore doc path
  const snap = await db().collection('users').doc(idf).get();
  return snap.exists ? { uid: snap.id, data: snap.data() } : null;
}

/** Add (kind 'load') or remove (kind 'deduct') balance. Returns { before, after, email }. */
export async function changeBalance(uid, amount, kind, { note = '', by = 'telegram', actor = 'TELEGRAM' } = {}) {
  const amt = Math.floor(Number(amount));
  if (!(amt > 0) || amt > MAX_BOT_LOAD) throw new Error(`Amount must be 1 – ${MAX_BOT_LOAD}`);
  const userRef = db().collection('users').doc(uid);
  const now = new Date().toISOString();
  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const d = snap.data();
    const before = Number(d.balance || 0);
    const after = kind === 'load' ? before + amt : before - amt;
    if (after < 0) throw new Error('That would take the balance negative');
    const log = [...(d.adminLog || []), { delta: kind === 'load' ? amt : -amt, note: `[${by}] ${note || (kind === 'load' ? 'Balance load' : 'Balance deduction')}`, resultingBalance: after, at: now }];
    tx.set(userRef, { balance: after, adminLog: log }, { merge: true });
    return { before, after, email: d.email || '' };
  });
  invalidateUserDoc(uid);
  notifyBalanceChange({ actor, kind, uid, email: out.email, amount: amt, before: out.before, after: out.after, note });
  return out;
}

/** Change a user's mode: 'user' | 'reseller'. */
export async function setUserRole(uid, role, by = 'telegram') {
  const userRef = db().collection('users').doc(uid);
  const now = new Date().toISOString();
  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const d = snap.data();
    const upd = roleChangeUpdate(d, role, by, now);
    tx.set(userRef, { ...upd.fields, adminLog: [...(d.adminLog || []), ...upd.log] }, { merge: true });
    return { from: roleOf(d), to: role, email: d.email || '' };
  });
  invalidateUserDoc(uid);
  return out;
}

/** HTML text for /getinfo. */
export function userDetailText(uid, d) {
  const reqs = (d.topupRequests || []).slice(-3).reverse()
    .map((t) => `  • ${esc(nrp(t.amount))} — ${esc(t.status || '—')} (${esc(String(t.date || '').slice(0, 10))})`).join('\n');
  const lines = [
    '👤 <b>USER DETAILS</b>',
    `Name - ${esc(d.profileName || '—')}`,
    `Gmail - ${esc(d.email || '—')}`,
    `UID - <code>${esc(uid)}</code>`,
    `Phone - ${esc(d.profilePhone || '—')}`,
    `TikTok - ${esc(d.tiktokUser || d.tiktokName || '—')}`,
    '_________________________',
    `Mode - <b>${esc(ROLE_LABEL[roleOf(d)])}</b>`,
    `Balance - <b>${esc(nrp(d.balance))}</b>`,
    `Keys bought - ${Number(d.totalKeysBought || 0)}   Spent - ${esc(nrp(d.totalSpent))}`,
    `Status - ${esc(d.requestStatus || 'Active')}`,
  ];
  if (reqs) lines.push('_________________________', '<b>Last top-ups</b>', reqs);
  return lines.join('\n');
}
