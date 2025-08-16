// zaloOauth.js
import "dotenv/config";
import axios from "axios";
import { loadTokens, saveTokens, isExpired } from "./tokenStore.js";
import { fileURLToPath } from "url";
import path from "path";

const OAUTH_BASE = process.env.ZALO_OAUTH_BASE || "https://oauth.zaloapp.com";
const APP_ID = process.env.ZALO_APP_ID;
const APP_SECRET = process.env.ZALO_APP_SECRET; // sẽ đi trong header: secret_key
const REDIRECT_URI = process.env.ZALO_REDIRECT_URI;

if (!APP_ID || !APP_SECRET) {
  console.warn("⚠️ Missing ZALO_APP_ID or ZALO_APP_SECRET in .env");
}

async function exchangeCode(code) {
  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const form = new URLSearchParams();
  form.append("app_id", String(APP_ID));
  form.append("code", code);
  form.append("grant_type", "authorization_code");
  form.append("redirect_uri", REDIRECT_URI);

  const { data } = await axios.post(url, form.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      secret_key: APP_SECRET,
    },
  });

  if (!data?.access_token) {
    throw new Error(`Exchange failed: ${JSON.stringify(data)}`);
  }

  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
  };
  await saveTokens(tokens);
  return tokens;
}

async function refreshToken() {
  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const tokens = await loadTokens();
  if (!tokens?.refresh_token) throw new Error("No refresh_token stored");

  const form = new URLSearchParams();
  form.append("app_id", String(APP_ID));
  form.append("grant_type", "refresh_token");
  form.append("refresh_token", tokens.refresh_token);

  const { data } = await axios.post(url, form.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      secret_key: APP_SECRET,
    },
  });

  if (!data?.access_token) {
    throw new Error(`Refresh failed: ${JSON.stringify(data)}`);
  }

  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
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
    const code = process.env.OAUTH_CODE_ONCE;
    if (!code)
      throw new Error(
        "No tokens found. Provide OAUTH_CODE_ONCE or run CLI to exchange code"
      );
    tokens = await exchangeCode(code);
  }
  if (isExpired(tokens)) tokens = await refreshToken();
  return tokens.access_token;
}

// --- CLI mode ---
const __filename = fileURLToPath(import.meta.url);
const isDirect =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

async function runCli() {
  const flag = process.argv[2];
  try {
    if (flag === "--exchange") {
      const code = process.env.OAUTH_CODE_ONCE || process.argv[3];
      if (!code) throw new Error("Provide code via OAUTH_CODE_ONCE or argv");
      const tokens = await exchangeCode(code);
      console.log(
        "✅ Exchanged. Saved to tokens.json. Expires at:",
        new Date(tokens.expires_at).toISOString()
      );
    } else if (flag === "--refresh") {
      const tokens = await refreshToken();
      console.log(
        "✅ Refreshed. Expires at:",
        new Date(tokens.expires_at).toISOString()
      );
    } else {
      console.log("Usage: node zaloOauth.js --exchange <code> | --refresh");
    }
  } catch (e) {
    console.error("❌", e.message);
    process.exit(1);
  }
}
if (isDirect) runCli();
