// tokenStore.js
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const FILE = path.join(__dirname, "tokens.json");

// Ưu tiên dùng Upstash Redis nếu có
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REST_TOKEN || "";
const TOKENS_KEY    = process.env.ZALO_TOKENS_KEY || "zalo:oa:tokens";

async function redisGetString(key) {
  const url = `${UPSTASH_URL}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  const j = await r.json();
  return j?.result ?? null;
}
async function redisSetString(key, val) {
  const url = `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}`;
  await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
}

export async function loadTokens() {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const s = await redisGetString(TOKENS_KEY);
      if (s) return JSON.parse(s);
    } catch (e) {
      console.error("[TOKENS] upstash get error:", e.message);
    }
  }
  try {
    const raw = await fs.readFile(FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveTokens(tokens) {
  const data = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at, // ms epoch
  };
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      await redisSetString(TOKENS_KEY, JSON.stringify(data));
      return;
    } catch (e) {
      console.error("[TOKENS] upstash set error:", e.message);
    }
  }
  try {
    await fs.writeFile(FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("[TOKENS] file write error:", e.message);
  }
}

export function isExpired(tokens, skewSec = 60) {
  if (!tokens?.expires_at) return true;
  return Date.now() >= (tokens.expires_at - skewSec * 1000);
}
