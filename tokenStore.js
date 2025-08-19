// tokenStore.js
import fs from 'fs-extra';

const FILE = process.env.TOKEN_FILE || '/data/tokens.json';

// Upstash (free) – dùng nếu có REST_URL/REST_TOKEN
const REST_URL  = process.env.UPSTASH_REST_URL;
const REST_TOKEN= process.env.UPSTASH_REST_TOKEN;
const TOKEN_KEY = process.env.TOKEN_KEY || 'zalo_tokens_v1';

async function kvGet() {
  const res = await fetch(`${REST_URL}/get/${encodeURIComponent(TOKEN_KEY)}`, {
    headers: { Authorization: `Bearer ${REST_TOKEN}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function kvSet(obj) {
  const value = encodeURIComponent(JSON.stringify(obj));
  const res = await fetch(`${REST_URL}/set/${encodeURIComponent(TOKEN_KEY)}/${value}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}` }
  });
  // optional: check res.json()
}

export async function loadTokens() {
  try {
    if (REST_URL && REST_TOKEN) return await kvGet();
    // fallback FS (chỉ dùng nếu có Disk)
    const ok = await fs.pathExists(FILE);
    if (!ok) return null;
    return await fs.readJSON(FILE);
  } catch (e) {
    console.error('loadTokens error', e);
    return null;
  }
}

export async function saveTokens(tokens) {
  const data = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at, // ms epoch
  };
  try {
    if (REST_URL && REST_TOKEN) return await kvSet(data);
    await fs.ensureFile(FILE);
    await fs.writeJSON(FILE, data, { spaces: 2 });
  } catch (e) {
    console.error('saveTokens error', e);
  }
}

export function isExpired(tokens, skewSec = 120) {
  if (!tokens?.expires_at) return true;
  return Date.now() >= (tokens.expires_at - skewSec * 1000);
}
