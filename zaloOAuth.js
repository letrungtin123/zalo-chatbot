// zaloOAuth.js
import 'dotenv/config';
import axios from 'axios';
import { loadTokens, saveTokens, isExpired } from './tokenStore.js';

const OAUTH_BASE = process.env.ZALO_OAUTH_BASE || 'https://oauth.zaloapp.com';
const APP_ID     = process.env.ZALO_APP_ID;
const APP_SECRET = process.env.ZALO_APP_SECRET;

// TTL cho access token lấy từ ENV (23 giờ)
const ENV_ACCESS_TTL_MS = Number(process.env.ZALO_ACCESS_TTL_MS || 23 * 3600 * 1000);

let inMem = { access_token: '', refresh_token: '', expires_at: 0 };

function form(data) {
  const p = new URLSearchParams();
  Object.entries(data).forEach(([k, v]) => p.append(k, v));
  return p;
}

async function oauthPost(body) {
  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const { data } = await axios.post(url, form(body), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'secret_key': process.env.ZALO_APP_SECRET
    },
    timeout: 15000,
  });
  return data;
}

export async function exchangeCode(code) {
  const data = await oauthPost({ app_id: APP_ID, grant_type: 'authorization_code', code });
  if (!data?.access_token) throw new Error('Exchange failed: no access_token');
  const expiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
  const tokens = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expiresAt };
  try { await saveTokens(tokens); } catch {}
  inMem = { ...tokens };
  return tokens;
}

export async function refreshToken(refreshToken) {
  const data = await oauthPost({ app_id: APP_ID, grant_type: 'refresh_token', refresh_token: refreshToken });
  if (!data?.access_token) throw new Error(`Refresh failed: ${JSON.stringify(data)}`);
  const expiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
  const tokens = { access_token: data.access_token, refresh_token: data.refresh_token || refreshToken, expires_at: expiresAt };
  try { await saveTokens(tokens); } catch {}
  inMem = { ...tokens };
  return tokens;
}

export async function ensureAccessToken() {
  const now = Date.now();

  // cache hợp lệ
  if (inMem.access_token && now < inMem.expires_at - 10_000) return inMem.access_token;

  const envAccess  = (process.env.ZALO_ACCESS_TOKEN || '').trim();
  const envRefresh = (process.env.ZALO_REFRESH_TOKEN || '').trim();

  // CHẾ ĐỘ KHÔNG REFRESH: chỉ có ACCESS
  if (envAccess && !envRefresh) {
    inMem = { access_token: envAccess, refresh_token: '', expires_at: now + ENV_ACCESS_TTL_MS };
    return inMem.access_token;
  }

  // Có cả ACCESS + REFRESH
  if (envAccess && envRefresh) {
    try {
      const t = await refreshToken(envRefresh);
      return t.access_token;
    } catch (e) {
      console.warn('[OAUTH] refresh failed, fallback env access:', e.message);
      inMem = { access_token: envAccess, refresh_token: envRefresh, expires_at: now + 60 * 60 * 1000 };
      return inMem.access_token;
    }
  }

  // Local tokens.json
  let tokens = await loadTokens();
  if (!tokens) throw new Error('No tokens found. Set ZALO_ACCESS_TOKEN or run exchange locally.');
  if (!tokens.access_token) {
    if (!tokens.refresh_token) throw new Error('No access_token/refresh_token available');
    tokens = await refreshToken(tokens.refresh_token);
  } else if (isExpired(tokens) && tokens.refresh_token) {
    tokens = await refreshToken(tokens.refresh_token);
  }
  inMem = { ...tokens };
  return inMem.access_token;
}
