// zaloOAuth.js
import "dotenv/config";
import axios from "axios";
import { loadTokens, saveTokens, isExpired } from "./tokenStore.js";

const OAUTH_BASE = process.env.ZALO_OAUTH_BASE || "https://oauth.zaloapp.com";
const APP_ID     = process.env.ZALO_APP_ID;
const SECRET     = process.env.ZALO_APP_SECRET;

function form(body) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) p.append(k, String(v));
  }
  return p;
}

async function postToken(bodyForm) {
  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const { data } = await axios.post(url, bodyForm, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "secret_key": SECRET,             // ✅ đúng theo docs mới
    },
  });
  if (!data?.access_token) {
    throw new Error(`No access_token in response: ${JSON.stringify(data)}`);
  }
  const expiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token, // ⚠️ RT mới, phải lưu thay thế RT cũ
    expires_at: expiresAt,
  };
  await saveTokens(tokens);
  return tokens;
}

export async function exchangeCode(code) {
  return postToken(
    form({
      app_id: APP_ID,
      grant_type: "authorization_code",
      code,
    })
  );
}

export async function refreshWith(refresh_token) {
  return postToken(
    form({
      app_id: APP_ID,
      grant_type: "refresh_token",
      refresh_token,
    })
  );
}

export async function ensureAccessToken() {
  // 1) Dùng token lưu trong store (Redis/file) nếu còn hạn
  let tokens = await loadTokens();
  if (tokens && !isExpired(tokens)) return tokens.access_token;

  // 2) Hết hạn: refresh bằng RT đang lưu trong store
  if (tokens?.refresh_token) {
    try {
      tokens = await refreshWith(tokens.refresh_token);
      return tokens.access_token;
    } catch (e) {
      console.error("[OAUTH] refresh with stored RT failed:", e.response?.data || e.message);
    }
  }

  // 3) Bootstrap bằng RT ở env (lần đầu deploy) → sẽ được lưu lại & xoay vòng tự động
  const envRT = process.env.ZALO_REFRESH_TOKEN;
  if (envRT) {
    const t = await refreshWith(envRT);
    return t.access_token;
  }

  // 4) Hoặc dùng OAUTH_CODE_ONCE để đổi code → token
  const code = process.env.OAUTH_CODE_ONCE;
  if (code) {
    const t = await exchangeCode(code);
    return t.access_token;
  }

  throw new Error("No tokens available. Set ZALO_REFRESH_TOKEN or OAUTH_CODE_ONCE.");
}
