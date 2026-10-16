// POST /api/telegram/topup-webhook — everything the admin bot (TELEGRAM_TOPUP_AUTO_BOT) receives:
//   * [Load ✅] / [Cancel ❌]   Khalti / eSewa top-up approval   (callback tq:)
//   * /loadbalance /getinfo /mode /creategiftcards + their buttons (message, ab:, md:, gc:)
// Authenticated by Telegram's secret header AND by checking the chat / admin ids.
import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { esc } from '../src/telegram.js';
import { webhookSecret, safeEqual, isAllowedPress, resolveRequest, answerCallback, editMessage, strikeStep } from '../src/topupQr.js';
import { handleMessage, handleBotCallback } from '../src/telegramBot.js';

const router = express.Router();
const whoIs = (cb) => (cb.from?.username ? `@${cb.from.username}` : String(cb.from?.first_name || cb.from?.id || 'admin'));

async function onQrCallback(cb, m) {
  const decision = m[1] === 'L' ? 'load' : 'cancel';
  const who = whoIs(cb);
  const r = await resolveRequest(m[2], decision, `telegram:${cb.from?.id}`);

  if (!r.ok) {
    await answerCallback(cb.id, `Not processed: ${r.reason}`, true);
    if (r.status && cb.message) {
      const icon = r.status === 'APPROVED' ? '✅' : '❌';
      await editMessage(cb.message.chat.id, cb.message.message_id, `${esc(cb.message.text)}\n\n${icon} <b>Already ${esc(r.status)}</b>`);
    }
    return;
  }

  let footer;
  if (decision === 'load') {
    footer = `✅ <b>LOADED</b> by ${esc(who)}\nNRP ${r.before} ➝ <b>NRP ${r.after}</b>`;
    if (r.upgraded) footer += '\n🛒 <b>Upgraded to RESELLER</b> (requirement reached)';
    await answerCallback(cb.id, `Loaded NRP ${r.amount}`);
  } else {
    const step = strikeStep(r.count);
    const sentence = step.action === 'warning' ? '⚠️ warning sent to user' : step.action === '1d' ? '⛔ banned for 1 day' : '⛔ banned permanently';
    footer = `❌ <b>CANCELLED</b> by ${esc(who)}\nFake payment strike <b>${Math.min(r.count, 3)}/3</b> — ${sentence}`;
    await answerCallback(cb.id, `Cancelled — strike ${Math.min(r.count, 3)}/3`);
  }
  // Edit EVERY copy of this request (several chats may have received it).
  const original = cb.message?.text || '';
  for (const msg of (r.messages.length ? r.messages : [{ chat_id: cb.message.chat.id, message_id: cb.message.message_id }])) {
    await editMessage(msg.chat_id, msg.message_id, `${esc(original)}\n\n${footer}`);
  }
}

router.post('/topup-webhook', asyncHandler(async (req, res) => {
  const given = req.headers['x-telegram-bot-api-secret-token'];
  if (!given || !safeEqual(given, webhookSecret())) return res.sendStatus(401);
  res.sendStatus(200); // answer Telegram immediately; the work below is idempotent

  try {
    if (req.body?.message) return await handleMessage(req.body.message);

    const cb = req.body?.callback_query;
    if (!cb || typeof cb.data !== 'string') return;
    if (!isAllowedPress(cb)) return await answerCallback(cb.id, 'Not allowed', true);

    let m;
    if ((m = cb.data.match(/^tq:([LC]):([a-f0-9]{12})$/))) return await onQrCallback(cb, m);
    if (/^(ab|md|gc):/.test(cb.data)) return await handleBotCallback(cb);
    return await answerCallback(cb.id, 'Unknown action');
  } catch (e) {
    console.warn('[telegram-webhook] handler error:', e?.message || e);
  }
}));

export default router;
