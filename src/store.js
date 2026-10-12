// src/store.js — the store's display name, in ONE place.
// Change it from Render → Environment → STORE_NAME (no code edit needed).
// Left as the literal placeholder until you set it.
export const STORE_NAME = process.env.STORE_NAME || 'YOUR_STORE_NAME';

// The label the storefront sends with a top-up request ("who was paid").
// store.php / owner.php build the same string from the same STORE_NAME.
export const OWNER_ACCOUNT = `${STORE_NAME} (OWNER)`;
