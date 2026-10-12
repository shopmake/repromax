// Telegram notification router.
// Configure the bot tokens on Render (all optional):
// TELEGRAM_USER_BOT_TOKEN
// TELEGRAM_BALANCE_BOT_TOKEN
// TELEGRAM_BUG_BOT_TOKEN
// And two destination chat IDs:
// TELEGRAM_CHAT_ID_1
// TELEGRAM_CHAT_ID_2
//
// Every notification is sent only to the selected bot(s) and both chat IDs.
// Notifications are best-effort and never block the actual API operation.
//
// STAFF BALANCE-LOAD ALERTS have their OWN bot + chat (purpose 'load'):
//   TELEGRAM_LOAD_BOT_TOKEN   the new bot's token
//   TELEGRAM_LOAD_CHAT_ID     the new chat/group/channel id (comma-separate
//                             for more than one destination)
// Used whenever an admin or employee adds/removes balance. If either is
// unset it falls back to the old balance bot / shared chat IDs, so alerts
// are never lost while you are still setting this up.

const BOT_ENV = {
  user: 'TELEGRAM_USER_BOT_TOKEN',
  balance: 'TELEGRAM_BALANCE_BOT_TOKEN',
  bug: 'TELEGRAM_BUG_BOT_TOKEN',
  security: 'TELEGRAM_USER_BOT_TOKEN',
  legacy: 'TELEGRAM_BOT_TOKEN',
};

function botToken(purpose='user') {
  if (purpose === 'load') {
    return process.env.TELEGRAM_LOAD_BOT_TOKEN || process.env.TELEGRAM_BALANCE_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
  }
  return process.env[BOT_ENV[purpose] || BOT_ENV.user] || process.env.TELEGRAM_BOT_TOKEN || '';
}
function chatIds(purpose='user') {
  if (purpose === 'load') {
    const own = String(process.env.TELEGRAM_LOAD_CHAT_ID || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (own.length) return own;
  }
  return [process.env.TELEGRAM_CHAT_ID_1, process.env.TELEGRAM_CHAT_ID_2, process.env.TELEGRAM_CHAT_ID].filter(Boolean);
}

// A new bot token with an OLD chat id (or the reverse) is the classic
// setup mistake: the new bot isn't a member of the old chat, so Telegram
// silently refuses. Say so once in the logs instead of failing quietly.
let warnedMixedLoadConfig = false;
function warnIfMixedLoadConfig() {
  if (warnedMixedLoadConfig) return;
  const hasTok = !!process.env.TELEGRAM_LOAD_BOT_TOKEN;
  const hasChat = !!process.env.TELEGRAM_LOAD_CHAT_ID;
  if (hasTok !== hasChat) {
    warnedMixedLoadConfig = true;
    console.warn('[telegram:load] Only one of TELEGRAM_LOAD_BOT_TOKEN / TELEGRAM_LOAD_CHAT_ID is set. Set BOTH, or alerts will go to the old bot/chat.');
  }
}

export async function telegramNotify(text, purpose='user') {
  if (purpose === 'load') warnIfMixedLoadConfig();
  const token = botToken(purpose);
  const ids = chatIds(purpose);
  if (!token || !ids.length) {
    if (purpose === 'load') console.warn('[telegram:load] No bot token / chat id configured — balance alert not sent.');
    return;
  }
  await Promise.all(ids.map(async (chatId) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML',disable_web_page_preview:true}),
        signal:controller.signal,
      });
      clearTimeout(timeout);
      // fetch() does NOT throw on a 4xx from Telegram (wrong chat id, bot
      // not in the chat, bad token...) — it just resolves. Log the reason
      // so a misconfiguration shows up in Render's logs. Never log the
      // URL or token, only Telegram's own explanation.
      if (!r.ok) {
        let why = '';
        try { why = (await r.json()).description || ''; } catch (_) {}
        console.warn(`[telegram:${purpose}] send failed (HTTP ${r.status}) ${why}`.trim());
      }
    } catch (e) {
      console.warn(`[telegram:${purpose}] send error: ${e?.name || 'unknown'}`);
    }
  }));
}

export function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Nepal has no DST, so this is a fixed +5:45 offset — Intl.DateTimeFormat
// with timeZone:'Asia/Kathmandu' handles that correctly (unlike a manual
// getTime()+offset hack, which breaks around year/month boundaries).
// Output looks like: 28 Sep 2026, 6:34:58 pm (Nepal Time)
export function formatNepaliDateTime(input) {
  const d = input ? new Date(input) : new Date();
  if (isNaN(d.getTime())) return String(input ?? '—');
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kathmandu',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(d).replace(',', ',');
  return `${formatted} (Nepal Time)`;
}

const STATUS_EMOJI={success:'✅',failed:'❌',cancelled:'🚫',pending:'⏳',attempt:'🛒'};
export function telegramFormat(title,f={}) {
  const status=String(f.status||'').toLowerCase();
  const emoji=STATUS_EMOJI[status]||'ℹ️';
  const lines=[`${emoji} <b>${esc(title)}</b>`,`👤 ${esc(f.username||'—')}`,`✉️ ${esc(f.email||'—')}`];
  // Phone is optional — only purchase flows collect it, balance-load and
  // other notifications don't have one, so this line is skipped for those.
  if(f.phone)lines.push(`📱 Number - ${esc(f.phone)}`);
  lines.push(`📦 ${esc(f.product||'—')}`);
  if(f.duration)lines.push(`⏱ ${esc(f.duration)}`);
  lines.push(`💰 Rs ${esc(f.price??'0')}`);
  if(f.key)lines.push(`🔑 <code>${esc(f.key)}</code>`);
  // Dates stored/passed as ISO (f.date) are now rendered as Nepal local
  // time instead of raw UTC ISO — easier to read at a glance in the chat.
  lines.push(`📅 ${esc(formatNepaliDateTime(f.date))}`,`🆔 <code>${esc(f.uid||'—')}</code>`);
  // Balance before/after is optional too — only present once the
  // transaction has actually debited the user (i.e. on success).
  if(f.balanceBefore!==undefined && f.balanceAfter!==undefined){
    lines.push(`NRP :- ${esc(f.balanceBefore)} ➝ ${esc(f.balanceAfter)}`);
  }
  if(status)lines.push(`📊 Status: <b>${esc(status.charAt(0).toUpperCase()+status.slice(1))}</b>`);
  if(f.others)lines.push(`📝 ${esc(f.others)}`);
  return lines.join('\n');
}
