// zaloOAuth.js (ESM)
import 'dotenv/config';
import axios from 'axios';
import { loadTokens, saveTokens, isExpired } from './tokenStore.js';

const OAUTH_BASE = process.env.ZALO_OAUTH_BASE || 'https://oauth.zaloapp.com';
const APP_ID     = process.env.ZALO_APP_ID;
const APP_SECRET = process.env.ZALO_APP_SECRET;

function must(v, name) {
  if (!v) throw new Error(`Missing ${name} in environment`);
  return v;
}

function toForm(data) {
  // x-www-form-urlencoded
  const p = new URLSearchParams();
  Object.entries(data).forEach(([k, v]) => p.append(k, v));
  return p;
}

async function postOAuth(path, form) {
  // Zalo yêu cầu secret_key ở HEADER
  const url = `${OAUTH_BASE}${path}`;
  const { data } = await axios.post(url, toForm(form), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'secret_key': must(APP_SECRET, 'ZALO_APP_SECRET'),
    },
    timeout: 15000,
  });
  return data;
}

/** Lần đầu đổi code -> access_token + refresh_token */
export async function exchangeCode(code) {
  must(APP_ID, 'ZALO_APP_ID');
  must(APP_SECRET, 'ZALO_APP_SECRET');
  if (!code) throw new Error('exchangeCode: missing code');

  const data = await postOAuth('/v4/oa/access_token', {
    app_id: APP_ID,
    grant_type: 'authorization_code',
    code,
  });

  if (!data?.access_token) {
    throw new Error(`Exchange failed: ${JSON.stringify(data)}`);
  }

  const expiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at  : expiresAt,
  };

  // Lưu file khi chạy local (Render không cần lưu)
  try { await saveTokens(tokens); } catch {}
  return tokens;
}

/** Refresh access_token từ refresh_token */
export async function refreshToken(refreshTokenStr) {
  must(APP_ID, 'ZALO_APP_ID');
  must(APP_SECRET, 'ZALO_APP_SECRET');
  if (!refreshTokenStr) throw new Error('No refresh_token provided');

  const data = await postOAuth('/v4/oa/access_token', {
    app_id       : APP_ID,
    grant_type   : 'refresh_token',
    refresh_token: refreshTokenStr,
  });

  if (!data?.access_token) {
    throw new Error(`Refresh failed: ${JSON.stringify(data)}`);
  }

  const expiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshTokenStr,
    expires_at  : expiresAt,
  };

  // Lưu file khi chạy local (Render không cần lưu)
  try { await saveTokens(tokens); } catch {}
  return tokens;
}

/** Lấy access_token “an toàn” cho mọi môi trường */
export async function ensureAccessToken() {
  // 1) Ưu tiên ENV trên Render
  const envAccess  = (process.env.ZALO_ACCESS_TOKEN || '').trim();
  const envRefresh = (process.env.ZALO_REFRESH_TOKEN || '').trim();

  let tokens = null;

  if (envAccess || envRefresh) {
    // ép expired để buộc refresh khi có refresh token
    tokens = {
      access_token: envAccess,
      refresh_token: envRefresh,
      expires_at: Date.now() - 1,
    };
  } else {
    // 2) Local: đọc file tokens.json
    tokens = await loadTokens();
    if (!tokens) {
      // 3) Cho phép cấp bằng OAUTH_CODE_ONCE (nếu có)
      const code = (process.env.OAUTH_CODE_ONCE || '').trim();
      if (code) {
        tokens = await exchangeCode(code);
      } else {
        throw new Error('No tokens found (please set ZALO_REFRESH_TOKEN on Render or run exchange locally)');
      }
    }
  }

  // Hết hạn hoặc chưa có access_token -> refresh
  if (!tokens.access_token || isExpired(tokens)) {
    if (!tokens.refresh_token) {
      throw new Error('No refresh_token available to refresh access token');
    }
    tokens = await refreshToken(tokens.refresh_token);
  }

  return tokens.access_token;
}
