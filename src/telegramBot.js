// src/telegramBot.js — admin slash-commands on the top-up bot.
//
//   /loadbalance      bot: "send user UID or email" -> amount -> [Confirm ✅]/[Cancel ❌]
//   /getinfo          bot: "send user UID or email" -> user info
//   /mode             bot: "send user UID or email" -> [👤 User] [🛒 Reseller]
//   /creategiftcards  bot: amount per card -> how many cards -> [Create ✅]/[Cancel ❌]
//   /cancel           forget the current command
//
// Old names /addbalance and /getdetail still work. Same security as the Load/Cancel
// buttons: only the configured chat(s) and, when set, only TELEGRAM_TOPUP_ADMIN_IDS.
// Conversation state lives in memory for 5 minutes.
import { chatIds, adminIds, newReqId, tg, answerCallback, editMessage } from './topupQr.js';
import { findUser, creditUser, setUserRole, userDetailText, MAX_BOT_LOAD } from './adminOps.js';
import { normalizeRole, ROLE_LABEL, roleOf } from './roles.js';
import { createRedeemCodeDoc } from './giftCodes.js';
import { esc } from './telegram.js';

const TTL = 5 * 60_000;
const MAX_GIFT_CARDS = 20;
const sessions = new Map(); // `${chat}:${user}` -> { cmd, step, ... , exp }
const pending = new Map();  // token -> { kind, ..., exp }
const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;
const ALIAS = { addbalance: 'loadbalance', getdetail: 'getinfo', giftcards: 'creategiftcards', creategiftcard: 'creategiftcards' };
const COMMANDS = ['loadbalance', 'getinfo', 'mode', 'creategiftcards'];

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
const posInt = (text) => { const n = Number(String(text).replace(/[, ]/g, '').replace(/^nrp/i, '')); return Number.isInteger(n) && n > 0 ? n : 0; };

const HELP =
  '🤖 <b>Admin commands</b>\n' +
  '/loadbalance — load balance to a user\n' +
  '/getinfo — get a user\'s info\n' +
  '/mode — change mode (user / reseller)\n' +
  '/creategiftcards — create gift cards\n' +
  '/cancel — cancel current command';

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
    cmd = ALIAS[cmd] || cmd;
    const arg = (m[2] || '').trim();
    if (cmd === 'start' || cmd === 'help') return void (await say(chat, HELP));
    if (cmd === 'cancel') { sessions.delete(key); return void (await say(chat, '❎ Cancelled.')); }
    if (!COMMANDS.includes(cmd)) return;

    if (cmd === 'creategiftcards') {
      sessions.set(key, { cmd, step: 'gamount', exp: Date.now() + TTL });
      if (arg) return giftAmount(chat, key, arg);
      return void (await say(chat, 'Send the amount for EACH gift card (NRP) 🎁'));
    }
    sessions.set(key, { cmd, step: 'identify', exp: Date.now() + TTL });
    if (arg) return identify(chat, key, arg);               // "/getinfo someone@gmail.com"
    return void (await say(chat, 'Send user UID or email ✉️'));
  }

  const st = sessions.get(key);
  if (!st || st.exp < Date.now()) return;                   // ordinary chatter — ignore
  if (st.step === 'identify') return identify(chat, key, text);
  if (st.step === 'amount') return amountStep(chat, key, st, text);
  if (st.step === 'gamount') return giftAmount(chat, key, text);
  if (st.step === 'gcount') return giftCount(chat, key, st, text);
}

async function identify(chat, key, idf) {
  const st = sessions.get(key);
  const u = await findUser(idf);
  if (!u) return void (await say(chat, '❌ No user found with that UID / email. Send another one, or /cancel.'));

  if (st.cmd === 'getinfo') {
    sessions.delete(key);
    return void (await say(chat, userDetailText(u.uid, u.data)));
  }

  if (st.cmd === 'loadbalance') {
    sessions.set(key, { ...st, step: 'amount', uid: u.uid, exp: Date.now() + TTL });
    return void (await say(chat,
      `👤 <b>${esc(u.data.profileName || '—')}</b> · ${esc(u.data.email || '—')}\n🆔 <code>${esc(u.uid)}</code>\n` +
      `🎭 Mode: <b>${esc(ROLE_LABEL[roleOf(u.data)])}</b>\n💰 Balance: <b>${esc(nrp(u.data.balance))}</b>\n\nSend amount to load (NRP) 💵`));
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
  const amount = posInt(text);
  if (!amount || amount > MAX_BOT_LOAD) return void (await say(chat, `Send a whole number between 1 and ${MAX_BOT_LOAD}, or /cancel.`));
  sessions.delete(key);
  const tok = newReqId();
  pending.set(tok, { kind: 'add', uid: st.uid, amount, exp: Date.now() + TTL });
  await say(chat, `Load <b>${esc(nrp(amount))}</b> to <code>${esc(st.uid)}</code>?`, {
    inline_keyboard: [[{ text: 'Confirm ✅', callback_data: `ab:Y:${tok}` }, { text: 'Cancel ❌', callback_data: `ab:N:${tok}` }]],
  });
}

async function giftAmount(chat, key, text) {
  const amount = posInt(text);
  if (!amount || amount > MAX_BOT_LOAD) return void (await say(chat, `Send a whole number between 1 and ${MAX_BOT_LOAD}, or /cancel.`));
  sessions.set(key, { cmd: 'creategiftcards', step: 'gcount', amount, exp: Date.now() + TTL });
  await say(chat, `${esc(nrp(amount))} per card. How many cards? (1 – ${MAX_GIFT_CARDS}) 🎁`);
}

async function giftCount(chat, key, st, text) {
  const count = posInt(text);
  if (!count || count > MAX_GIFT_CARDS) return void (await say(chat, `Send a number between 1 and ${MAX_GIFT_CARDS}, or /cancel.`));
  sessions.delete(key);
  const tok = newReqId();
  pending.set(tok, { kind: 'gift', amount: st.amount, count, exp: Date.now() + TTL });
  await say(chat, `Create <b>${count}</b> gift card(s) of <b>${esc(nrp(st.amount))}</b> each (single use)?`, {
    inline_keyboard: [[{ text: 'Create ✅', callback_data: `gc:Y:${tok}` }, { text: 'Cancel ❌', callback_data: `gc:N:${tok}` }]],
  });
}

/** Buttons from /loadbalance (ab:), /mode (md:) and /creategiftcards (gc:). Authorisation is checked by the caller. */
export async function handleBotCallback(cb) {
  sweep();
  const m = String(cb.data).match(/^(ab:[YN]|gc:[YN]|md:[ur]):([a-f0-9]{12})$/);
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
    if (action === 'ab:N' || action === 'gc:N') {
      await answerCallback(cb.id, 'Cancelled');
      return editMessage(chat, mid, `${base}\n\n❌ <b>Cancelled</b> by ${esc(who(cb.from))}`);
    }
    if (action === 'ab:Y') {
      const r = await creditUser(p.uid, p.amount, { note: `Telegram /loadbalance by ${who(cb.from)}`, actor: 'TELEGRAM', by });
      await answerCallback(cb.id, `Loaded ${nrp(p.amount)}`);
      return editMessage(chat, mid, `${base}\n\n✅ <b>LOADED</b> by ${esc(who(cb.from))}\n${esc(nrp(r.before))} ➝ <b>${esc(nrp(r.after))}</b>` +
        (r.upgraded ? '\n🛒 <b>Upgraded to RESELLER</b> (requirement reached)' : ''));
    }
    if (action === 'gc:Y') {
      const codes = [];
      for (let i = 0; i < p.count; i++) codes.push((await createRedeemCodeDoc({ amount: p.amount, maxUses: 1 })).code);
      await answerCallback(cb.id, `${codes.length} card(s) created`);
      return editMessage(chat, mid, `${base}\n\n✅ <b>${codes.length} GIFT CARD(S) CREATED</b> by ${esc(who(cb.from))}\n` +
        codes.map((c) => `<code>${esc(c)}</code>`).join('\n') + `\n\n${esc(nrp(p.amount))} each · single use`);
    }
    // md:u / md:r
    const role = normalizeRole(action.slice(3));
    const r = await setUserRole(p.uid, role, by);
    await answerCallback(cb.id, `Mode → ${ROLE_LABEL[role]}`);
    return editMessage(chat, mid, `${base}\n\n✅ <b>MODE CHANGED</b> by ${esc(who(cb.from))}\n${esc(ROLE_LABEL[r.from])} ➝ <b>${esc(ROLE_LABEL[role])}</b>`);
  } catch (e) {
    await answerCallback(cb.id, `Failed: ${String(e.message).slice(0, 150)}`, true);
    return editMessage(chat, mid, `${base}\n\n⚠️ <b>Failed:</b> ${esc(e.message)}`);
  }
}
