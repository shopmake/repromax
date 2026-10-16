// src/catalog.js — the product catalog. Two price lists: user (price) and reseller (priceReseller, falls back to price).
//
// Products live in Firestore (`products/{sku}`), added from the admin panel,
// so adding or editing a product never needs a code deploy. The `products`
// collection is created automatically by the first product you add.
//
// Other collections used here (also auto-created on first write):
//   productStatus/{sku}   maintenance + out-of-stock flags
//   whatsappProducts/{id} "chat to buy" products (no instant checkout)

import { db } from './firebase.js';
import { cachedLoader, TTL } from './cache.js';
import { tierPrice } from './roles.js';

// ---------------------------------------------------------------
// Maintenance / out-of-stock flags (admin-controlled)
// ---------------------------------------------------------------
const overrides = cachedLoader(async () => {
  const snap = await db().collection('productStatus').get();
  const map = {};
  snap.forEach((d) => { map[d.id] = d.data(); });
  return map;
}, { ttlMs: TTL.catalog, name: 'productStatus', versionKey: 'catalog' });

export function getMaintenanceOverrides() { return overrides.get(); }
export function invalidateMaintenanceCache() { overrides.invalidate(); }

/** Fresh (uncached) flags for one sku — the purchase path uses this because it gates real money. */
export async function getMaintenanceForSku(sku) {
  const snap = await db().collection('productStatus').doc(sku).get();
  if (!snap.exists) return { maintenance: false, outOfStock: false };
  const d = snap.data();
  return {
    maintenance: !!d.maintenance,
    maintenanceMessage: d.maintenanceMessage || null,
    outOfStock: !!d.outOfStock,
    outOfStockMessage: d.outOfStockMessage || null,
  };
}

// ---------------------------------------------------------------
// Products (instant-delivery, bought through the upstream store)
// ---------------------------------------------------------------
const products = cachedLoader(async () => {
  const snap = await db().collection('products').get();
  const map = {};
  snap.forEach((d) => { map[d.id] = d.data(); });
  return map;
}, { ttlMs: TTL.catalog, name: 'products', versionKey: 'catalog' });

export function invalidateProductCache() { products.invalidate(); }

/** Fresh read of one product — used at checkout so the price and pid are never stale. */
export async function findProductFresh(sku, role = 'user') {
  if (!sku) return null; // a Firestore .doc() path can't be empty
  const snap = await db().collection('products').doc(sku).get();
  // `price` in the returned object is what THIS role pays (checkout debits it).
  return snap.exists ? { sku, ...snap.data(), price: tierPrice(snap.data(), role) } : null;
}

export async function getProductRaw(sku) {
  const snap = await db().collection('products').doc(sku).get();
  return snap.exists ? snap.data() : null;
}

export async function deleteProduct(sku) {
  await db().collection('products').doc(sku).delete();
  invalidateProductCache();
}

// ---------------------------------------------------------------
// "Chat to buy" products — never go through checkout.
// ---------------------------------------------------------------
const whatsappProducts = cachedLoader(async () => {
  const snap = await db().collection('whatsappProducts').get();
  const map = {};
  snap.forEach((d) => { map[d.id] = d.data(); });
  return map;
}, { ttlMs: TTL.catalog, name: 'whatsappProducts', versionKey: 'catalog' });

export function invalidateWhatsappProductCache() { whatsappProducts.invalidate(); }

export async function getWhatsappProductRaw(id) {
  const snap = await db().collection('whatsappProducts').doc(id).get();
  return snap.exists ? snap.data() : null;
}

export async function deleteWhatsappProduct(id) {
  await db().collection('whatsappProducts').doc(id).delete();
  invalidateWhatsappProductCache();
}

/**
 * The storefront catalog: products + chat-to-buy products, with the
 * maintenance / out-of-stock flags merged on top.
 * Fails OPEN on the flags: if that lookup breaks, products still show.
 */
export async function getLiveCatalog(role = 'user') {
  const base = {};

  try {
    for (const [sku, p] of Object.entries(await products.get())) base[sku] = { ...p, price: tierPrice(p, role) };
  } catch (e) {
    console.error('[catalog] products unavailable:', e?.message || e);
  }

  try {
    for (const [id, p] of Object.entries(await whatsappProducts.get())) {
      base[id] = { ...p, type: 'whatsapp', row: p.name, name: p.name };
    }
  } catch (e) {
    console.error('[catalog] chat-to-buy products unavailable:', e?.message || e);
  }

  let flags = {};
  try {
    flags = await getMaintenanceOverrides();
  } catch (e) {
    console.error('[catalog] maintenance lookup failed — showing the catalog without flags:', e?.message || e);
    return base;
  }

  const out = { ...base };
  for (const [sku, o] of Object.entries(flags)) {
    if (!out[sku]) continue;
    out[sku] = {
      ...out[sku],
      maintenance: !!o.maintenance,
      maintenanceMessage: o.maintenance ? (o.maintenanceMessage || 'This product is temporarily under maintenance.') : undefined,
      // Out of stock is its own flag so one duration can be off without touching its siblings.
      outOfStock: !!o.outOfStock,
      outOfStockMessage: o.outOfStock ? (o.outOfStockMessage || 'Out of stock — check back soon.') : undefined,
    };
  }
  return out;
}
