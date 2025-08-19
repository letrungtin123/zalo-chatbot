// zaloOAuth.js
import "dotenv/config";
import axios from "axios";
import fs from "fs-extra";

const OAUTH_BASE = process.env.ZALO_OAUTH_BASE || "https://oauth.zaloapp.com";
const APP_ID     = process.env.ZALO_APP_ID;
const SECRET_KEY = process.env.ZALO_APP_SECRET;                 // dùng làm secret_key ở header
const REDIRECT   = process.env.ZALO_REDIRECT_URI || "";
const TOK_FILE   = "./tokens.json";

// KHÁY KHUYẾN NGHỊ: đặt refresh token vào ENV để không mất khi redeploy
const REFRESH_ENV = process.env.ZALO_REFRESH_TOKEN || "";

// ---- utils ----
async function loadTokens() {
  try {
    if (!(await fs.pathExists(TOK_FILE))) return null;
    return await fs.readJSON(TOK_FILE);
  } catch {
    return null;
  }
}
async function saveTokens(tokens) {
  await fs.writeJSON(TOK_FILE, tokens, { spaces: 2 });
}
function isExpired(tokens, skewSec = 120) {
  if (!tokens?.expires_at) return true;
  return Date.now() >= tokens.expires_at - skewSec * 1000;
}

// ---- OAuth flows ----
async function exchangeCode(code) {
  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "secret_key": SECRET_KEY,               // <— BẮT BUỘC theo spec mới
  };
  const form = new URLSearchParams({
    app_id: String(APP_ID),
    grant_type: "authorization_code",
    code,
  });
  if (REDIRECT) form.set("redirect_uri", REDIRECT);

  const { data } = await axios.post(url, form.toString(), { headers });

  if (!data?.access_token) {
    throw new Error("Exchange failed: " + JSON.stringify(data));
  }
  const expiresAt = Date.now() + (Number(data.expires_in) || 90000) * 1000;
  const out = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
  };
  await saveTokens(out);
  return out;
}

async function refreshToken() {
  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "secret_key": SECRET_KEY,               // <— BẮT BUỘC theo spec mới
  };

  let stored = await loadTokens();
  let refresh = stored?.refresh_token || REFRESH_ENV;
  if (!refresh) throw new Error("No refresh_token available");

  const form = new URLSearchParams({
    app_id: String(APP_ID),
    grant_type: "refresh_token",
    refresh_token: refresh,
  });

  const { data } = await axios.post(url, form.toString(), { headers });

  if (!data?.access_token) {
    throw new Error("Refresh failed: " + JSON.stringify(data));
  }
  const expiresAt = Date.now() + (Number(data.expires_in) || 90000) * 1000;
  const out = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refresh,
    expires_at: expiresAt,
  };
  await saveTokens(out);
  return out;
}

export async function ensureAccessToken() {
  let t = await loadTokens();

  // Không có tokens.json => thử REFRESH ENV, nếu không có thì dùng OAUTH_CODE_ONCE
  if (!t) {
    if (REFRESH_ENV) {
      t = await refreshToken();
    } else if (process.env.OAUTH_CODE_ONCE) {
      t = await exchangeCode(process.env.OAUTH_CODE_ONCE);
    } else {
      throw new Error("No tokens found. Provide ZALO_REFRESH_TOKEN or OAUTH_CODE_ONCE.");
    }
  }

  if (isExpired(t)) t = await refreshToken();
  return t.access_token;
}
