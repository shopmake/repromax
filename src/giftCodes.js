// src/giftCodes.js — gift / redeem codes. Same documents the admin panel's
// "redeem codes" tab creates (redeemCodes/{CODE}); users redeem them with
// POST /api/user/redeem. Telegram /creategiftcards uses this too.
import crypto from 'crypto';
import { db } from './firebase.js';

export function generateRedeemCode() {
  // GIFT_XXXXX_YYYYY — no 0/O/1/I to avoid confusion. Change GIFT with CODE_PREFIX.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = (n) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');
  const prefix = String(process.env.CODE_PREFIX || 'GIFT').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'GIFT';
  return `${prefix}_${group(5)}_${group(5)}`;
}

export async function createRedeemCodeDoc({ amount, maxUses, expiresAt, code }) {
  amount = Number(amount);
  if (!amount || amount <= 0) throw Object.assign(new Error('Amount must be a positive number'), { status: 400 });

  if (maxUses === '' || maxUses === undefined || maxUses === null || String(maxUses).toLowerCase() === 'unlimited') {
    maxUses = null;
  } else {
    maxUses = Number(maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
      throw Object.assign(new Error('Max uses must be a whole number between 1 and 100, or unlimited'), { status: 400 });
    }
  }

  let expiresAtMs = null;
  if (expiresAt && String(expiresAt).toLowerCase() !== 'unlimited') {
    const t = new Date(expiresAt).getTime();
    if (Number.isNaN(t)) throw Object.assign(new Error('Invalid expiry date'), { status: 400 });
    expiresAtMs = t;
  }

  const finalCode = String(code || '').trim().toUpperCase() || generateRedeemCode();
  const ref = db().collection('redeemCodes').doc(finalCode);
  if ((await ref.get()).exists) throw Object.assign(new Error('That code already exists'), { status: 409 });

  const docData = {
    code: finalCode, amount, maxUses, expiresAt: expiresAtMs,
    active: true, usedCount: 0, redeemedBy: [], createdAt: Date.now(),
  };
  await ref.set(docData);
  return docData;
}
