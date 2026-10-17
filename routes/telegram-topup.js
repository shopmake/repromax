// POST /api/telegram/topup-webhook — everything the admin bot receives:
//   * [Load ✅] / [Cancel ❌]   QR top-up approval           (callback tq:)
//   * /loadbalance /getinfo /mode /creategift ... + their buttons (message, ab:, md:)
// Not a user route: authenticated by Telegram's secret header AND by checking that the
// press / message came from the configured chat (and admin ids, when set).
import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { esc } from '../src/telegram.js';
import { webhookSecret, safeEqual, isAllowedPress, resolveRequest, answerCallback, editMessage } from '../src/topupBot.js';
import { handleMessage, handleBotCallback } from '../src/telegramBot.js';

const router = express.Router();
const whoIs = (cb) => (cb.from?.username ? `@${cb.from.username}` : String(cb.from?.first_name || cb.from?.id || 'admin'));
const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;

async function onQrCallback(cb, m) {
  const decision = m[1] === 'L' ? 'load' : 'cancel';
  const r = await resolveRequest(m[2], decision, `telegram:${cb.from?.id}`);

  if (!r.ok) {
    await answerCallback(cb.id, `Not processed: ${r.reason}`, true);
    // Already handled elsewhere (e.g. admin panel)? Strip the buttons so nobody presses twice.
    if (r.status && cb.message) {
      const icon = r.status === 'APPROVED' ? '✅' : '❌';
      await editMessage(cb.message.chat.id, cb.message.message_id, `${esc(cb.message.text)}\n\n${icon} <b>Already ${esc(r.status)}</b>`);
    }
    return;
  }

  let footer;
  if (decision === 'load') {
    footer = `✅ <b>LOADED</b> by ${esc(whoIs(cb))}\n${esc(nrp(r.before))} ➝ <b>${esc(nrp(r.after))}</b>`;
    await answerCallback(cb.id, `Loaded ${nrp(r.amount)}`);
  } else {
    footer = `❌ <b>CANCELLED</b> by ${esc(whoIs(cb))}\nNo balance was added.`;
    await answerCallback(cb.id, 'Cancelled');
  }
  // Edit EVERY copy of this request (several chats may have received it).
  const original = esc(cb.message?.text || '');
  const targets = r.messages.length ? r.messages : [{ chat_id: cb.message.chat.id, message_id: cb.message.message_id }];
  for (const msg of targets) await editMessage(msg.chat_id, msg.message_id, `${original}\n\n${footer}`);
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
    if (/^(ab|md):/.test(cb.data)) return await handleBotCallback(cb);
    return await answerCallback(cb.id, 'Unknown action');
  } catch (e) {
    console.warn('[telegram-webhook] handler error:', e?.message || e);
  }
}));

export default router;
