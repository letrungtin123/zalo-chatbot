// zaloOAuth.js (ESM)
import 'dotenv/config';
import axios from 'axios';
import { loadTokens, saveTokens, isExpired } from './tokenStore.js';

const OAUTH_BASE = process.env.ZALO_OAUTH_BASE || 'https://oauth.zaloapp.com';
const APP_ID     = process.env.ZALO_APP_ID;
const APP_SECRET = process.env.ZALO_APP_SECRET;

// TTL mặc định cho access token lấy từ ENV (23h) – an toàn với chuẩn 25h của Zalo
const ENV_ACCESS_TTL_MS = Number(process.env.ZALO_ACCESS_TTL_MS || 23 * 3600 * 1000);

// Cache trong RAM (sống theo lifecycle của process trên Render)
let inMem = {
  access_token: '',
  refresh_token: '',
  expires_at: 0, // ms epoch
};

function must(v, name) {
  if (!v) throw new Error(`Missing ${name} in environment`);
  return v;
}

function form(data) {
  const p = new URLSearchParams();
  Object.entries(data).forEach(([k, v]) => p.append(k, v));
  return p;
}

async function postOAuth(path, body) {
  const url = `${OAUTH_BASE}${path}`;
  const { data } = await axios.post(url, form(body), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'secret_key': must(APP_SECRET, 'ZALO_APP_SECRET'),
    },
    timeout: 15000,
  });
  return data;
}

export async function exchangeCode(code) {
  must(APP_ID, 'ZALO_APP_ID');
  must(APP_SECRET, 'ZALO_APP_SECRET');
  if (!code) throw new Error('exchangeCode: missing code');

  const data = await postOAuth('/v4/oa/access_token', {
    app_id: APP_ID,
    grant_type: 'authorization_code',
    code,
  });

  if (!data?.access_token) throw new Error(`Exchange failed: ${JSON.stringify(data)}`);

  const expiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
  };

  try { await saveTokens(tokens); } catch {}
  // update RAM cache
  inMem = { ...tokens };
  return tokens;
}

export async function refreshToken(refreshTokenStr) {
  must(APP_ID, 'ZALO_APP_ID');
  must(APP_SECRET, 'ZALO_APP_SECRET');
  if (!refreshTokenStr) throw new Error('No refresh_token provided');

  const data = await postOAuth('/v4/oa/access_token', {
    app_id       : APP_ID,
    grant_type   : 'refresh_token',
    refresh_token: refreshTokenStr,
  });

  if (!data?.access_token) throw new Error(`Refresh failed: ${JSON.stringify(data)}`);

  const expiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshTokenStr,
    expires_at: expiresAt,
  };

  try { await saveTokens(tokens); } catch {}
  inMem = { ...tokens };
  return tokens;
}

/**
 * Lấy access_token an toàn:
 * - Nếu ENV có ACCESS mà KHÔNG có REFRESH -> dùng ACCESS, KHÔNG refresh, cache 23h.
 * - Nếu ENV có cả ACCESS + REFRESH -> thử refresh khi cache hết hạn; nếu fail => Fallback dùng ACCESS.
 * - Nếu không có ENV -> đọc tokens.json (local); chỉ refresh khi gần/đã hết hạn.
 */
export async function ensureAccessToken() {
  const now = Date.now();

  // 0) Có cache và chưa hết hạn -> dùng luôn
  if (inMem.access_token && now < inMem.expires_at - 10_000) {
    return inMem.access_token;
  }

  const envAccess  = (process.env.ZALO_ACCESS_TOKEN || '').trim();
  const envRefresh = (process.env.ZALO_REFRESH_TOKEN || '').trim();

  // 1) ENV: có ACCESS nhưng KHÔNG có REFRESH -> KHÔNG BAO GIỜ refresh
  if (envAccess && !envRefresh) {
    inMem = {
      access_token: envAccess,
      refresh_token: '',
      expires_at: now + ENV_ACCESS_TTL_MS,
    };
    return inMem.access_token;
  }

  // 2) ENV: có cả ACCESS + REFRESH
  if (envAccess && envRefresh) {
    // Nếu chưa có cache, set tạm TTL ngắn rồi thử refresh
    if (!inMem.access_token) {
      inMem = {
        access_token: envAccess,
        refresh_token: envRefresh,
        expires_at: now + 5 * 60 * 1000, // 5 phút
      };
    }

    try {
      const t = await refreshToken(envRefresh);
      return t.access_token;
    } catch (e) {
      console.warn('[OAUTH] refresh failed, fallback to env access token:', e.message);
      // Fallback dùng envAccess thêm TTL ngắn để không spam refresh
      inMem = {
        access_token: envAccess,
        refresh_token: envRefresh,
        expires_at: now + 60 * 60 * 1000, // 1h
      };
      return inMem.access_token;
    }
  }

  // 3) Local: đọc tokens.json
  let fileTokens = await loadTokens();
  if (!fileTokens) {
    const code = (process.env.OAUTH_CODE_ONCE || '').trim();
    if (code) {
      fileTokens = await exchangeCode(code);
    } else {
      throw new Error('No tokens found (set ZALO_ACCESS_TOKEN on Render or run exchange locally)');
    }
  }

  if (!fileTokens.access_token) {
    if (!fileTokens.refresh_token) throw new Error('No access_token/refresh_token available');
    fileTokens = await refreshToken(fileTokens.refresh_token);
  } else if (isExpired(fileTokens) && fileTokens.refresh_token) {
    fileTokens = await refreshToken(fileTokens.refresh_token);
  }

  inMem = { ...fileTokens };
  return inMem.access_token;
}
