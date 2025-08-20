// zaloOAuth.js
import 'dotenv/config';
import axios from 'axios';
import { loadTokens, saveTokens } from './tokenStore.js';

const OAUTH_BASE = process.env.ZALO_OAUTH_BASE || 'https://oauth.zaloapp.com';
const APP_ID     = process.env.ZALO_APP_ID;
const APP_SECRET = process.env.ZALO_APP_SECRET;

// Skew 60s để làm mới sớm một chút
const SKEW_MS = 60 * 1000;

function calcExpiresAt(expires_in) {
  const sec = parseInt(expires_in || '90000', 10); // Zalo ~25h
  return Date.now() + sec * 1000;
}

async function exchangeCode(code) {
  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'secret_key': APP_SECRET,
  };
  const body = new URLSearchParams({
    app_id: String(APP_ID),
    grant_type: 'authorization_code',
    code,
  });

  const { data } = await axios.post(url, body, { headers });
  if (!data?.access_token) throw new Error('Exchange failed: no access_token');

  const tokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    calcExpiresAt(data.expires_in),
  };
  await saveTokens(tokens);
  return tokens;
}

async function refreshToken(useEnvFirst = true) {
  const stored = await loadTokens();
  const refresh =
    (useEnvFirst && process.env.ZALO_REFRESH_TOKEN) ||
    process.env.ZALO_REFRESH_TOKEN ||
    stored?.refresh_token;

  if (!refresh) throw new Error('No refresh token');

  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'secret_key': APP_SECRET,
  };
  const body = new URLSearchParams({
    app_id: String(APP_ID),
    grant_type: 'refresh_token',
    refresh_token: refresh,
  });

  const { data } = await axios.post(url, body, { headers });
  if (!data?.access_token) {
    throw new Error(`Refresh failed: ${JSON.stringify(data)}`);
  }

  const out = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || refresh, // Zalo đôi khi trả refresh_token mới
    expires_at:    calcExpiresAt(data.expires_in),
  };
  await saveTokens(out);
  return out;
}

/**
 * ensureAccessToken({force})
 * - Đọc tokens từ store
 * - Nếu thiếu/hết hạn (hoặc force) => refresh
 */
export async function ensureAccessToken(opts = {}) {
  const force = !!opts.force;

  let t = await loadTokens();

  const expired =
    !t?.access_token ||
    !t?.expires_at ||
    Date.now() + SKEW_MS >= t.expires_at;

  if (force || expired) {
    t = await refreshToken(true);
  }

  return t.access_token;
}

// Tùy chọn: export exchangeCode nếu muốn chạy 1 lần từ CLI
export { exchangeCode, refreshToken };
