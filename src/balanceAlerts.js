// src/balanceAlerts.js — ONE place that builds the Telegram message for
// any balance change made by staff, so admin, employee and approved
// top-up alerts all look the same and always say WHO did it.
//
// Sent on the dedicated 'load' channel (TELEGRAM_LOAD_BOT_TOKEN +
// TELEGRAM_LOAD_CHAT_ID — see src/telegram.js). Best-effort: it never
// throws and never delays the API response, so a Telegram outage can't
// block a real balance load.
import { telegramNotify, esc } from './telegram.js';

const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;

// e.g. "28 Sep 2026, 9:12 AM" in Nepal time
function nepalTime(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kathmandu', day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
}

// Builds the message text (exported so it can be tested without sending).
export function buildBalanceAlert({
  actor,               // 'ADMIN' | 'EMPLOYEE'
  kind = 'load',       // 'load' (added) | 'deduct' (removed)
  title,               // optional override, e.g. 'TOP-UP APPROVED'
  uid, email, amount, before, after, note, extraLines = [],
}) {
  const isLoad = kind !== 'deduct';
  const heading = title || (isLoad ? 'BALANCE LOAD' : 'BALANCE DEDUCTION');
  const icon = isLoad ? '💰' : '➖';
  const sign = isLoad ? '+' : '−';

  const lines = [
    `${icon} <b>${esc(actor)} ${esc(heading)}</b>`,
    `👤 ${esc(email || '—')}`,
    `🆔 <code>${esc(uid || '—')}</code>`,
    `💵 Amount: <b>${sign}${nrp(amount)}</b>`,
  ];
  if (before !== undefined && after !== undefined) {
    lines.push(`📊 Balance: ${nrp(before)} → <b>${nrp(after)}</b>`);
  }
  for (const l of extraLines) lines.push(l);
  lines.push(`📝 Note: ${esc(note || '—')}`);
  lines.push(`🕒 ${esc(nepalTime())} (Nepal)`);
  return lines.join('\n');
}

// Fire-and-forget. Returns the promise only so tests can await it.
export function notifyBalanceChange(args) {
  try {
    return telegramNotify(buildBalanceAlert(args), 'load').catch(() => {});
  } catch (e) {
    console.warn('[balanceAlerts] could not build alert:', e?.name || 'error');
    return Promise.resolve();
  }
}
