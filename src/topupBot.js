// src/topupBot.js — QR top-up approval through a Telegram bot.
//
// Flow: user pays a QR (Khalti or eSewa/PhonePay) -> sends the transaction ID ->
// POST /api/user/topup-qr stores a PENDING request and posts it to the owner's bot
// with two buttons:   [Load ✅]   [Cancel ❌]
//   Load   -> balance is credited at once (atomic; can only ever happen once)
//   Cancel -> request is rejected, no balance is added
//
// Env (Render):
//   TELEGRAM_TOPUP_AUTO_BOT      token of the admin bot (falls back to TELEGRAM_LOAD_BOT_TOKEN)
//   TELEGRAM_TOPUP_AUTO_CHAT_ID  chat/group id(s), comma separated (falls back to TELEGRAM_LOAD_CHAT_ID,
//                                then TELEGRAM_CHAT_ID_1/2)
//   TELEGRAM_TOPUP_ADMIN_IDS     optional, comma-separated Telegram user ids allowed to press buttons /
//                                run commands (strongly recommended if the chat is a group)
//   PUBLIC_BACKEND_URL           https URL of this server (defaults to RENDER_EXTERNAL_URL); used to
//                                register the webhook on boot
import crypto from 'node:crypto';
import { db } from './firebase.js';
import { esc, formatNepaliDateTime } from './telegram.js';
import { invalidateUserDoc } from './userCache.js';
import { notifyBalanceChange } from './balanceAlerts.js';

export const QR_MIN_AMOUNT = 100;
export const QR_MAX_AMOUNT = 100000;
export const QR_MAX_PENDING = 3;
export const QR_PENDING_WINDOW_MS = 30 * 60_000;
export const QR_METHOD = 'QR';
export const WALLETS = {
  khalti: { label: 'Khalti App' },
  esewa: { label: 'eSewa / PhonePay' },
};

export const botToken = () => process.env.TELEGRAM_TOPUP_AUTO_BOT || process.env.TELEGRAM_LOAD_BOT_TOKEN || '';
const pick = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
export function chatIds() {
  const own = pick(process.env.TELEGRAM_TOPUP_AUTO_CHAT_ID);
  if (own.length) return own;
  const load = pick(process.env.TELEGRAM_LOAD_CHAT_ID);
  if (load.length) return load;
  return [process.env.TELEGRAM_CHAT_ID_1, process.env.TELEGRAM_CHAT_ID_2, process.env.TELEGRAM_CHAT_ID].filter(Boolean).map(String);
}
export const adminIds = () => pick(process.env.TELEGRAM_TOPUP_ADMIN_IDS);

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
    { command: 'deductbalance', description: 'Remove balance from a user' },
    { command: 'getinfo', description: "Get a user's details" },
    { command: 'mode', description: 'Change mode: user / reseller' },
    { command: 'creategift', description: 'Create a gift card (redeem code)' },
    { command: 'stats', description: 'Users, revenue 7d/30d, total balance' },
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
    `<b>PAID VIA</b> - ${esc(p.walletLabel || '—')}`,
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
    console.warn('[topup-bot] bot token / chat id not configured — request saved but not announced.');
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

export const newReqId = () => crypto.randomBytes(6).toString('hex'); // 12 hex chars keeps callback_data tiny

export function isAllowedPress(cb) {
  const chat = cb.message?.chat?.id;
  if (!chat || !chatIds().map(String).includes(String(chat))) return false;
  const allow = adminIds();
  return allow.length === 0 || allow.includes(String(cb.from?.id));
}

/**
 * Atomically resolve one QR request. decision: 'load' | 'cancel'.
 * The PENDING -> APPROVED/REJECTED flip happens inside one transaction, so a
 * double press (or the admin panel racing the bot) can never credit twice.
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
      upd.adminLog = [...(d.adminLog || []), { delta: Number(r.amount), note: `QR top-up approved (txCode: ${r.txCode})`, resultingBalance: after, at: now }];
      result = { ok: true, decision, before, after, amount: Number(r.amount), txCode: r.txCode, email: d.email || '' };
    } else {
      next[i] = { ...r, status: 'REJECTED', reviewedAt: now, reviewedBy: by };
      upd.adminLog = [...(d.adminLog || []), { delta: 0, note: `QR top-up cancelled (txCode: ${r.txCode})`, resultingBalance: Number(d.balance || 0), at: now }];
      result = { ok: true, decision, amount: Number(r.amount), txCode: r.txCode };
    }
    upd.topupRequests = next;
    tx.set(userRef, upd, { merge: true });
    tx.set(idxRef, { status: next[i].status, resolvedAt: now }, { merge: true });
    return result;
  });
  if (out.ok) {
    invalidateUserDoc(uid);
    if (decision === 'load') {
      notifyBalanceChange({ actor: 'TELEGRAM', kind: 'load', title: 'QR TOP-UP APPROVED', uid, email: out.email, amount: out.amount, before: out.before, after: out.after, note: `TX code: ${out.txCode}` });
    }
  }
  return { ...out, uid, messages: idx.data().messages || [] };
}
