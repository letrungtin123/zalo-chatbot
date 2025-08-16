// zaloOAuth.js
import "dotenv/config";
import axios from "axios";
import { loadTokens, saveTokens, isExpired } from "./tokenStore.js";

// Mặc định: chỉ xài refresh token đã lưu. (Exchange code làm thủ công ngoài luồng)
const OAUTH_BASE = process.env.ZALO_OAUTH_BASE || "https://oauth.zaloapp.com";
const APP_ID = (process.env.ZALO_APP_ID || "").trim();
const APP_SECRET = (process.env.ZALO_APP_SECRET || "").trim();

if (!APP_ID) console.warn("⚠️ Missing ZALO_APP_ID");
if (!APP_SECRET) console.warn("⚠️ Missing ZALO_APP_SECRET");

// --- Refresh token theo spec Zalo (header secret_key + form-urlencoded) ---
async function refreshToken() {
  const tokens = await loadTokens();
  if (!tokens?.refresh_token) {
    throw new Error("No refresh_token stored in tokens.json");
  }

  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const body = new URLSearchParams({
    app_id: APP_ID,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });

  const { data } = await axios.post(url, body, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // QUAN TRỌNG: secret_key trong header
      secret_key: APP_SECRET,
    },
    timeout: 10000,
  });

  if (!data?.access_token) {
    throw new Error("Refresh failed: no access_token");
  }

  const expiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at: expiresAt,
  };

  await saveTokens(newTokens);
  return newTokens;
}

export async function ensureAccessToken() {
  let tokens = await loadTokens();

  if (!tokens) {
    // Với flow hiện tại, bạn đã exchange code và lưu tokens.json sẵn.
    // Nếu chưa có, fail sớm để chủ động xử lý.
    throw new Error(
      "No tokens.json found. Exchange code trước rồi commit/đẩy RUN (hoặc mount secret)."
    );
  }

  if (isExpired(tokens, 120)) {
    tokens = await refreshToken();
  }

  return tokens.access_token;
}
