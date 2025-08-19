// zaloOAuth.js
import 'dotenv/config';
import axios from 'axios';
import { loadTokens, saveTokens, isExpired } from './tokenStore.js';

const OAUTH_BASE = process.env.ZALO_OAUTH_BASE || 'https://oauth.zaloapp.com';
const APP_ID     = process.env.ZALO_APP_ID;
const APP_SECRET = process.env.ZALO_APP_SECRET;

// Exchange code -> ít dùng sau khi chạy ổn
export async function exchangeCode(code, redirect_uri) {
  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'secret_key': APP_SECRET
  };
  const body = new URLSearchParams({
    app_id: APP_ID,
    grant_type: 'authorization_code',
    code,
    ...(redirect_uri ? { redirect_uri } : {})
  });

  const { data } = await axios.post(url, body, { headers });
  if (!data?.access_token) throw new Error(`Exchange failed: ${JSON.stringify(data)}`);

  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt
  };
  await saveTokens(tokens);
  return tokens;
}

async function refreshToken(refresh_token) {
  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'secret_key': APP_SECRET
  };
  const body = new URLSearchParams({
    app_id: APP_ID,
    grant_type: 'refresh_token',
    refresh_token
  });

  const { data } = await axios.post(url, body, { headers });
  if (!data?.access_token) {
    throw new Error(`Refresh failed: ${JSON.stringify(data)}`);
  }

  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refresh_token,
    expires_at: expiresAt
  };
  await saveTokens(newTokens);
  return newTokens;
}

export async function ensureAccessToken() {
  // 1) Ưu tiên tokens.json
  let tokens = await loadTokens();

  // 2) Nếu chưa có, thử lấy từ ENV (ZALO_ACCESS_TOKEN/ZALO_REFRESH_TOKEN)
  if (!tokens) {
    const envAccess  = process.env.ZALO_ACCESS_TOKEN || '';
    const envRefresh = process.env.ZALO_REFRESH_TOKEN || '';
    const expiresAt  = Date.now() + 10 * 60 * 1000; // 10 phút tạm
    if (envAccess || envRefresh) {
      tokens = {
        access_token: envAccess,
        refresh_token: envRefresh,
        expires_at: expiresAt
      };
      await saveTokens(tokens);
    }
  }

  // 3) Nếu có refresh token & token hết hạn/thiếu -> refresh
  if (!tokens?.access_token || isExpired(tokens)) {
    if (!tokens?.refresh_token) {
      throw new Error('No refresh_token available to refresh access token');
    }
    tokens = await refreshToken(tokens.refresh_token);
  }

  return tokens.access_token;
}
