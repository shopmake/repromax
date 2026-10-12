// src/imageUpload.js — uploads a profile picture to imgbb and returns its URL.
//
// ENV (set on Render):
//   IMGBB_API_KEY   required — your key from https://api.imgbb.com/
//   IMGBB_ENDPOINT  optional — defaults to https://api.imgbb.com/1/upload
//
// The key stays on the server; the browser only ever sees the final URL.

const MAX_BASE64_CHARS = 700_000; // ~512 KB of image — the browser sends a small cropped square, far below this

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Accepts a data URL or raw base64; returns raw base64 after checking it really is PNG/JPEG/WebP. */
function normalizeImage(input) {
  const raw = String(input || '').trim();
  if (!raw) throw httpError(400, 'No image received.');

  const m = raw.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
  const b64 = (m ? m[2] : raw).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw httpError(400, 'Image data is not valid base64.');
  if (b64.length > MAX_BASE64_CHARS) throw httpError(413, 'Image is too large. Pick a smaller size.');

  // Don't trust the declared type — check the file's magic bytes.
  const head = Buffer.from(b64.slice(0, 24), 'base64');
  const isPng = head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isJpg = head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isWebp = head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
  if (!isPng && !isJpg && !isWebp) throw httpError(400, 'Only PNG, JPG or WebP images are allowed.');
  return b64;
}

export async function uploadAvatar(imageInput, uid) {
  const key = process.env.IMGBB_API_KEY;
  if (!key) throw httpError(500, 'Image upload is not configured (IMGBB_API_KEY missing on the server).');
  const endpoint = process.env.IMGBB_ENDPOINT || 'https://api.imgbb.com/1/upload';

  const image = normalizeImage(imageInput);

  const body = new URLSearchParams();
  body.set('key', key);
  body.set('image', image);
  body.set('name', `avatar_${String(uid).slice(0, 12)}_${Date.now()}`);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw httpError(504, e?.name === 'TimeoutError' ? 'Image host timed out. Please try again.' : 'Could not reach the image host. Please try again.');
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok || !json || json.success === false) {
    const reason = json?.error?.message || json?.status_txt || `HTTP ${res.status}`;
    console.error('[image-upload] upload failed:', res.status, String(reason).slice(0, 200));
    throw httpError(502, 'Image upload failed. Please try a different image or try again later.');
  }

  const url = json?.data?.display_url || json?.data?.url;
  if (!url || !/^https:\/\//i.test(url)) {
    console.error('[image-upload] no usable URL in response');
    throw httpError(502, 'Image host returned an unexpected response.');
  }
  return url;
}
