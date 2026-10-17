// src/telegramBot.js — admin slash-commands on the top-up bot.
//
//   /loadbalance    send UID/email -> amount -> [Confirm ✅] [Cancel ❌]
//   /deductbalance  send UID/email -> amount -> [Confirm ✅] [Cancel ❌]
//   /getinfo        send UID/email -> user details
//   /mode           send UID/email -> [User] [Reseller]
//   /creategift     amount -> max uses -> gift card (redeem code)
//   /stats          users, keys, revenue (total / 7d / 30d), all users' balance
//   /cancel         forget the current command
//
// Same security as the Load/Cancel buttons: only the configured chat(s) and, when
// set, only TELEGRAM_TOPUP_ADMIN_IDS. Conversation state lives in memory for 5
// minutes (a restart just means "send the command again").
import { tg, chatIds, adminIds, newReqId, answerCallback, editMessage } from './topupBot.js';
import { findUser, changeBalance, setUserRole, userDetailText, MAX_BOT_LOAD } from './adminOps.js';
import { normalizeRole, ROLE_LABEL, roleOf } from './roles.js';
import { createRedeemCodeDoc } from './giftCodes.js';
import { computeStats } from './stats.js';
import { esc } from './telegram.js';

const TTL = 5 * 60_000;
const sessions = new Map(); // `${chat}:${user}` -> { cmd, step, uid?, amount?, exp }
const pending = new Map();  // token -> { kind, uid, amount?, exp }
const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;

const ALIASES = { addbalance: 'loadbalance', getdetail: 'getinfo', creategiftcard: 'creategift', create_gift_cards: 'creategift', create_gift: 'creategift', load_balance: 'loadbalance', deduct_balance: 'deductbalance', get_info: 'getinfo' };
const COMMANDS = ['loadbalance', 'deductbalance', 'getinfo', 'mode', 'creategift', 'stats'];

function sweep() {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
}

export function isAllowedMessage(msg) {
  const chat = msg?.chat?.id;
  if (!chat || !chatIds().map(String).includes(String(chat))) return false;
  const allow = adminIds();
  return allow.length === 0 || allow.includes(String(msg.from?.id));
}

const say = (chat_id, text, reply_markup) =>
  tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) });
const who = (from) => (from?.username ? `@${from.username}` : String(from?.first_name || from?.id || 'admin'));

const HELP =
  '🤖 <b>Admin commands</b>\n' +
  '/loadbalance — add balance to a user\n' +
  '/deductbalance — remove balance from a user\n' +
  '/getinfo — get a user\'s details\n' +
  '/mode — change mode (user / reseller)\n' +
  '/creategift — create a gift card (redeem code)\n' +
  '/stats — users, revenue 7d / 30d, total balance\n' +
  '/cancel — cancel current command\n\n' +
  'Shortcut: <code>/getinfo someone@gmail.com</code>';

export async function handleMessage(msg) {
  if (!isAllowedMessage(msg)) return;
  const text = String(msg.text || '').trim();
  if (!text) return;
  sweep();
  const chat = msg.chat.id;
  const key = `${chat}:${msg.from?.id}`;

  const m = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]+))?$/);
  if (m) {
    let cmd = m[1].toLowerCase();
    cmd = ALIASES[cmd] || cmd;
    const arg = (m[2] || '').trim();
    if (cmd === 'start' || cmd === 'help') return void (await say(chat, HELP));
    if (cmd === 'cancel') { sessions.delete(key); return void (await say(chat, '❎ Cancelled.')); }
    if (!COMMANDS.includes(cmd)) return;

    if (cmd === 'stats') {
      sessions.delete(key);
      const s = await computeStats({ fresh: true });
      return void (await say(chat,
        '📊 <b>STORE STATS</b>\n' +
        `👥 Users: <b>${s.totalUsers}</b> (resellers: ${s.resellers})\n` +
        `🔑 Keys sold: <b>${s.totalKeysSold}</b>\n` +
        `💰 Revenue (all time): <b>${esc(nrp(s.totalRevenue))}</b>\n` +
        `📆 Revenue 7 days: <b>${esc(nrp(s.revenue7d))}</b> (${s.orders7d} orders)\n` +
        `📆 Revenue 30 days: <b>${esc(nrp(s.revenue30d))}</b> (${s.orders30d} orders)\n` +
        `🏦 All users' balance: <b>${esc(nrp(s.totalBalance))}</b>`));
    }

    if (cmd === 'creategift') {
      const parts = arg.split(/\s+/).filter(Boolean);
      sessions.set(key, { cmd, step: 'gift_amount', exp: Date.now() + TTL });
      if (parts[0]) return giftAmount(chat, key, parts[0], parts[1]);
      return void (await say(chat, '🎁 Send the gift card amount (NRP)'));
    }

    sessions.set(key, { cmd, step: 'identify', exp: Date.now() + TTL });
    if (arg) return identify(chat, key, arg);
    return void (await say(chat, 'Send user UID or email ✉️'));
  }

  const st = sessions.get(key);
  if (!st || st.exp < Date.now()) return; // ordinary chatter — ignore
  if (st.step === 'identify') return identify(chat, key, text);
  if (st.step === 'amount') return amountStep(chat, key, st, text);
  if (st.step === 'gift_amount') return giftAmount(chat, key, text);
  if (st.step === 'gift_uses') return giftUses(chat, key, st, text);
}

async function giftAmount(chat, key, text, usesArg) {
  const amount = Number(String(text).replace(/[, ]/g, '').replace(/^nrp/i, ''));
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_BOT_LOAD) {
    return void (await say(chat, `Send a whole number between 1 and ${MAX_BOT_LOAD}, or /cancel.`));
  }
  const st = { cmd: 'creategift', step: 'gift_uses', amount, exp: Date.now() + TTL };
  sessions.set(key, st);
  if (usesArg) return giftUses(chat, key, st, usesArg);
  await say(chat, `Gift card of <b>${esc(nrp(amount))}</b>.\nHow many people can use it? Send 1–100, or <code>unlimited</code>.`);
}

async function giftUses(chat, key, st, text) {
  try {
    const doc = await createRedeemCodeDoc({ amount: st.amount, maxUses: text.trim() });
    sessions.delete(key);
    await say(chat,
      `🎁 <b>GIFT CARD CREATED</b>\nCode: <code>${esc(doc.code)}</code>\nValue: <b>${esc(nrp(doc.amount))}</b>\nUses: ${doc.maxUses ?? 'unlimited'}\n\nUsers redeem it in the store → Redeem.`);
  } catch (e) {
    await say(chat, `⚠️ ${esc(e.message)}\nSend max uses again (1–100 or unlimited), or /cancel.`);
  }
}

async function identify(chat, key, idf) {
  const st = sessions.get(key);
  if (!st) return;
  const u = await findUser(idf);
  if (!u) return void (await say(chat, '❌ No user found with that UID / email. Send another one, or /cancel.'));

  if (st.cmd === 'getinfo') {
    sessions.delete(key);
    return void (await say(chat, userDetailText(u.uid, u.data)));
  }

  if (st.cmd === 'loadbalance' || st.cmd === 'deductbalance') {
    sessions.set(key, { ...st, step: 'amount', uid: u.uid, exp: Date.now() + TTL });
    return void (await say(chat,
      `👤 <b>${esc(u.data.profileName || '—')}</b> · ${esc(u.data.email || '—')}\n🆔 <code>${esc(u.uid)}</code>\n` +
      `💰 Balance: <b>${esc(nrp(u.data.balance))}</b>\n\nSend amount to ${st.cmd === 'loadbalance' ? 'add' : 'remove'} (NRP) 💵`));
  }

  // mode
  sessions.delete(key);
  const tok = newReqId();
  pending.set(tok, { kind: 'mode', uid: u.uid, exp: Date.now() + TTL });
  const cur = roleOf(u.data);
  return void (await say(chat,
    `👤 <b>${esc(u.data.profileName || '—')}</b> · ${esc(u.data.email || '—')}\n🆔 <code>${esc(u.uid)}</code>\n` +
    `Current mode: <b>${esc(ROLE_LABEL[cur])}</b>\n\nChoose the new mode:`,
    { inline_keyboard: [[
      { text: '👤 User', callback_data: `md:u:${tok}` },
      { text: '🛒 Reseller', callback_data: `md:r:${tok}` },
    ]] }));
}

async function amountStep(chat, key, st, text) {
  const amount = Number(text.replace(/[, ]/g, '').replace(/^nrp/i, ''));
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_BOT_LOAD) {
    return void (await say(chat, `Send a whole number between 1 and ${MAX_BOT_LOAD}, or /cancel.`));
  }
  sessions.delete(key);
  const load = st.cmd === 'loadbalance';
  const tok = newReqId();
  pending.set(tok, { kind: load ? 'add' : 'sub', uid: st.uid, amount, exp: Date.now() + TTL });
  await say(chat, `${load ? 'Add' : 'Remove'} <b>${esc(nrp(amount))}</b> ${load ? 'to' : 'from'} <code>${esc(st.uid)}</code>?`, {
    inline_keyboard: [[{ text: 'Confirm ✅', callback_data: `ab:Y:${tok}` }, { text: 'Cancel ❌', callback_data: `ab:N:${tok}` }]],
  });
}

/** Buttons from /loadbalance, /deductbalance (ab:) and /mode (md:). Authorisation is checked by the caller. */
export async function handleBotCallback(cb) {
  sweep();
  const m = String(cb.data).match(/^(ab:[YN]|md:[ur]):([a-f0-9]{12})$/);
  if (!m) return answerCallback(cb.id, 'Unknown action');
  const [action, tok] = [m[1], m[2]];
  const p = pending.get(tok);
  const chat = cb.message?.chat?.id, mid = cb.message?.message_id;
  if (!p) {
    await answerCallback(cb.id, 'Expired — send the command again', true);
    return editMessage(chat, mid, `${esc(cb.message?.text || '')}\n\n⌛ Expired`);
  }
  pending.delete(tok); // one press only
  const by = `telegram:${cb.from?.id}`;
  const base = esc(cb.message?.text || '');

  try {
    if (action === 'ab:N') {
      await answerCallback(cb.id, 'Cancelled');
      return editMessage(chat, mid, `${base}\n\n❌ <b>Cancelled</b> by ${esc(who(cb.from))}`);
    }
    if (action === 'ab:Y') {
      const kind = p.kind === 'add' ? 'load' : 'deduct';
      const r = await changeBalance(p.uid, p.amount, kind, { note: `Telegram ${kind === 'load' ? '/loadbalance' : '/deductbalance'} by ${who(cb.from)}`, by });
      await answerCallback(cb.id, `${kind === 'load' ? 'Loaded' : 'Removed'} ${nrp(p.amount)}`);
      return editMessage(chat, mid, `${base}\n\n✅ <b>${kind === 'load' ? 'LOADED' : 'DEDUCTED'}</b> by ${esc(who(cb.from))}\n${esc(nrp(r.before))} ➝ <b>${esc(nrp(r.after))}</b>`);
    }
    const role = normalizeRole(action.slice(3));
    const r = await setUserRole(p.uid, role, by);
    await answerCallback(cb.id, `Mode → ${ROLE_LABEL[role]}`);
    return editMessage(chat, mid, `${base}\n\n✅ <b>MODE CHANGED</b> by ${esc(who(cb.from))}\n${esc(ROLE_LABEL[r.from])} ➝ <b>${esc(ROLE_LABEL[role])}</b>`);
  } catch (e) {
    await answerCallback(cb.id, `Failed: ${String(e.message).slice(0, 150)}`, true);
    return editMessage(chat, mid, `${base}\n\n⚠️ <b>Failed:</b> ${esc(e.message)}`);
  }
}
