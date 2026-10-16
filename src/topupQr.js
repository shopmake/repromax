// src/topupQr.js — QR top-up (Khalti / eSewa) with Telegram approval + fake-payment strikes.
//
// Flow: user picks Khalti or eSewa -> pays the QR -> sends the transaction ID ->
// POST /api/user/topup-qr stores a PENDING request and posts it to the owner's
// Telegram bot with two inline buttons:  [Load ✅]  [Cancel ❌]
//   Load   -> balance is credited right away (atomic, can only happen once)
//   Cancel -> request rejected + a FAKE-PAYMENT STRIKE:
//               strike 1 = warning on the user's account
//               strike 2 = 1 day ban
//               strike 3 = permanent ban
//
// Env (Render):
//   TELEGRAM_TOPUP_AUTO_BOT      token of the top-up bot (required)
//   TELEGRAM_TOPUP_AUTO_CHAT_ID  chat/group id(s), comma separated (falls back to TELEGRAM_LOAD_CHAT_ID, then TELEGRAM_CHAT_ID_1/2)
//   TELEGRAM_TOPUP_ADMIN_IDS     optional, Telegram user ids allowed to press buttons / use commands (recommended in groups)
//   PUBLIC_BACKEND_URL           public https URL of this backend (or Render's RENDER_EXTERNAL_URL) — webhook is registered on boot
import crypto from 'node:crypto';
import { db } from './firebase.js';
import { esc, formatNepaliDateTime } from './telegram.js';
import { makeBan } from './ban.js';
import { invalidateUserDoc } from './userCache.js';
import { depositUpdate } from './roles.js';

export const QR_MIN_AMOUNT = 100;
export const QR_MAX_AMOUNT = 100000;
export const QR_MAX_PENDING = 3;
export const QR_PENDING_WINDOW_MS = 30 * 60_000; // a QR request only counts as "pending" for 30 minutes
export const QR_METHODS = { khalti: 'KHALTI', esewa: 'ESEWA' };

export const botToken = () => process.env.TELEGRAM_TOPUP_AUTO_BOT || '';
export function chatIds() {
  const pick = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const own = pick(process.env.TELEGRAM_TOPUP_AUTO_CHAT_ID);
  if (own.length) return own;
  const load = pick(process.env.TELEGRAM_LOAD_CHAT_ID);
  if (load.length) return load;
  return [process.env.TELEGRAM_CHAT_ID_1, process.env.TELEGRAM_CHAT_ID_2, process.env.TELEGRAM_CHAT_ID].filter(Boolean).map(String);
}
export const adminIds = () => String(process.env.TELEGRAM_TOPUP_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);

/** Secret Telegram echoes back in X-Telegram-Bot-Api-Secret-Token — derived from the token, no extra setup. */
export function webhookSecret() {
  return process.env.TELEGRAM_TOPUP_WEBHOOK_SECRET
    || crypto.createHash('sha256').update('topup-webhook:' + botToken()).digest('hex').slice(0, 48);
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function tg(method, body) {
  const token = botToken();
  if (!token) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) console.warn(`[topup-bot] ${method} failed: ${j.description || r.status}`);
    return j;
  } catch (e) {
    console.warn(`[topup-bot] ${method} error: ${e?.name || 'unknown'}`);
    return null;
  } finally { clearTimeout(t); }
}
export const answerCallback = (id, text, alert = false) => tg('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert });
export const editMessage = (chat_id, message_id, text) =>
  tg('editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [] } });

/** Register the webhook + slash-command menu once on boot (best-effort). */
export async function registerTopupWebhook() {
  if (!botToken()) return;
  const base = String(process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (!base.startsWith('https://')) {
    console.warn('[topup-bot] Set PUBLIC_BACKEND_URL (https) so the Load/Cancel buttons can reach the server.');
    return;
  }
  const r = await tg('setWebhook', {
    url: `${base}/api/telegram/topup-webhook`, secret_token: webhookSecret(),
    allowed_updates: ['callback_query', 'message'], drop_pending_updates: false,
  });
  if (r?.ok) console.log('[topup-bot] webhook registered');
  await tg('setMyCommands', { commands: [
    { command: 'loadbalance', description: 'Load balance to a user' },
    { command: 'getinfo', description: "Get a user's info" },
    { command: 'mode', description: 'Change mode: user / reseller' },
    { command: 'creategiftcards', description: 'Create gift cards' },
    { command: 'cancel', description: 'Cancel the current command' },
  ] });
}

const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;
const LINE = '------------------------------------------';
const THIN = '---------------------';

export function buildRequestText(p, footer = '') {
  return [
    `<b>USER NAME</b> - ${esc(p.name || '—')}`,
    `<b>USER UID</b> - <code>${esc(p.uid)}</code>`,
    `<b>GMAIL</b> - ${esc(p.email || '—')}`,
    `<b>PHONE</b> - ${esc(p.phone || '—')}`,
    `<b>MODE</b> - ${esc(String(p.role || 'user').toUpperCase())}`,
    `<b>AVAILABLE BALANCE</b> - ${esc(nrp(p.balance))}`,
    LINE,
    `<b>REQUEST BALANCE</b> - <b>${esc(nrp(p.amount))}</b>`,
    `<b>PAID VIA</b> - <b>${esc(p.methodLabel || '—')}</b>`,
    THIN,
    `<b>TX CODE</b> - <code>${esc(p.txCode)}</code>`,
    THIN,
    `<b>DATE</b> - ${esc(formatNepaliDateTime(p.date))}`,
    `<b>IP ADDRESS</b> - <code>${esc(p.ip || '—')}</code>`,
    LINE,
    footer,
  ].filter((x) => x !== '').join('\n');
}

export async function sendRequestToBot(reqId, p) {
  const ids = chatIds();
  if (!botToken() || !ids.length) {
    console.warn('[topup-bot] TELEGRAM_TOPUP_AUTO_BOT / chat id not configured — request saved but not announced.');
    return [];
  }
  const keyboard = { inline_keyboard: [[
    { text: 'Load ✅', callback_data: `tq:L:${reqId}` },
    { text: 'Cancel ❌', callback_data: `tq:C:${reqId}` },
  ]] };
  const sent = [];
  await Promise.all(ids.map(async (chat_id) => {
    const r = await tg('sendMessage', { chat_id, text: buildRequestText(p), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard });
    if (r?.ok) sent.push({ chat_id: r.result.chat.id, message_id: r.result.message_id });
  }));
  return sent;
}

export function newReqId() { return crypto.randomBytes(6).toString('hex'); } // 12 chars -> callback_data stays tiny

export function isAllowedPress(cb) {
  const chat = cb.message?.chat?.id;
  if (!chat || !chatIds().map(String).includes(String(chat))) return false;
  const allow = adminIds();
  return allow.length === 0 || allow.includes(String(cb.from?.id));
}

// ---- strike ladder ----------------------------------------------------------
export const FAKE_LADDER = [
  { count: 1, action: 'warning', text: 'Warning 1/3 — fake payment detected. Next fake payment = 1 day ban.' },
  { count: 2, action: '1d',      text: 'Warning 2/3 — fake payment detected again. You were banned for 1 day. Next fake payment = permanent ban.' },
  { count: 3, action: 'permanent', text: 'Warning 3/3 — fake payment detected. Account permanently banned.' },
];
export const strikeStep = (count) => FAKE_LADDER[Math.min(count, FAKE_LADDER.length) - 1];

/**
 * Atomically resolve one QR request from the Telegram buttons (or the admin panel).
 * decision: 'load' | 'cancel'. Never double-credits: the PENDING -> APPROVED/REJECTED
 * flip happens inside one transaction.
 */
export async function resolveRequest(reqId, decision, by = 'telegram') {
  const idxRef = db().collection('topupQr').doc(reqId);
  const idx = await idxRef.get();
  if (!idx.exists) return { ok: false, reason: 'Request not found' };
  const { uid } = idx.data();
  const userRef = db().collection('users').doc(uid);
  const now = new Date().toISOString();

  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return { ok: false, reason: 'User not found' };
    const d = snap.data();
    const list = Array.isArray(d.topupRequests) ? d.topupRequests : [];
    const i = list.findIndex((r) => r.reqId === reqId);
    if (i < 0) return { ok: false, reason: 'Request not found' };
    const r = list[i];
    if (r.status !== 'PENDING') return { ok: false, reason: `Already ${r.status}`, status: r.status };

    const next = [...list];
    const upd = {};
    let result;
    if (decision === 'load') {
      const before = Number(d.balance || 0);
      const after = before + Number(r.amount || 0);
      next[i] = { ...r, status: 'APPROVED', reviewedAt: now, reviewedBy: by };
      upd.balance = after;
      const dep = depositUpdate(d, r.amount, after, now);
      Object.assign(upd, dep.fields);
      upd.adminLog = [...(d.adminLog || []), { delta: Number(r.amount), note: `${r.method || 'QR'} top-up approved (txCode: ${r.txCode})`, resultingBalance: after, at: now }, ...dep.log];
      result = { ok: true, decision, before, after, amount: Number(r.amount), txCode: r.txCode, method: r.method, upgraded: dep.upgraded };
    } else {
      const count = Number(d.fakePayment?.count || 0) + 1;
      const step = strikeStep(count);
      next[i] = { ...r, status: 'REJECTED', reviewedAt: now, reviewedBy: by, fake: true };
      upd.fakePayment = { count, lastAt: now, lastTx: r.txCode, text: step.text };
      const log = [...(d.adminLog || []), { delta: 0, note: `Fake payment strike ${Math.min(count, 3)}/3 (txCode: ${r.txCode})`, resultingBalance: Number(d.balance || 0), at: now }];
      if (step.action !== 'warning') {
        upd.ban = makeBan(step.action, 'topup-auto');
        upd.banned = true;
        log.push({ delta: 0, note: `Auto-ban — ${upd.ban.label} (fake payment)`, resultingBalance: Number(d.balance || 0), at: now });
      }
      upd.adminLog = log;
      result = { ok: true, decision, count, step, amount: Number(r.amount), txCode: r.txCode, method: r.method };
    }
    upd.topupRequests = next;
    tx.set(userRef, upd, { merge: true });
    tx.set(idxRef, { status: next[i].status, resolvedAt: now }, { merge: true });
    return result;
  });
  if (out.ok) invalidateUserDoc(uid);
  return { ...out, uid, messages: idx.data().messages || [], base: idx.data() };
}
