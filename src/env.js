// src/env.js — loads secrets from a local `.env` file (dependency-free).
//
// Import this FIRST in server.js so every other module sees the values.
// Rules:
//   * Real environment variables (e.g. set in the Render dashboard) always win,
//     so on Render you can keep using the dashboard and skip the file entirely.
//   * `.env` is only a convenience for local runs / self-hosting.
//   * `.env` is li// src/env.js — loads secrets from a local `.env` file (dependency-free).
//
// Import this FIRST in server.js so every other module sees the values.
// Rules:
//   * Real environment variables (e.g. set in the Render dashboard) always win,
//     so on Render you can keep using the dashboard and skip the file entirely.
//   * `.env` is only a convenience for local runs / self-hosting.
//   * `.env` is listed in .gitignore — never commit it.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, ''); // trailing comment on unquoted values
    }
    if (key) out[key] = val;
  }
  return out;
}

try {
  if (fs.existsSync(file)) {
    for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
} catch (e) {
  console.error('[env] could not read .env:', e.message);
}
sted in .gitignore — never commit it.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, ''); // trailing comment on unquoted values
    }
    if (key) out[key] = val;
  }
  return out;
}

try {
  if (fs.existsSync(file)) {
    for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
} catch (e) {
  console.error('[env] could not read .env:', e.message);
}
