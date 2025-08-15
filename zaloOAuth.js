import 'dotenv/config';
import axios from 'axios';
import { loadTokens, saveTokens, isExpired } from './tokenStore.js';

const OAUTH_BASE = process.env.ZALO_OAUTH_BASE || 'https://oauth.zaloapp.com';
const APP_ID = process.env.ZALO_APP_ID;
const APP_SECRET = process.env.ZALO_APP_SECRET;
const REDIRECT_URI = process.env.ZALO_REDIRECT_URI;

async function exchangeCode(code) {
  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const body = { app_id: APP_ID, app_secret: APP_SECRET, code, redirect_uri: REDIRECT_URI };
  const { data } = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' }});
  if (!data?.access_token) throw new Error('Exchange failed: no access_token');
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  const tokens = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expiresAt };
  await saveTokens(tokens);
  return tokens;
}

async function refreshToken() {
  const tokens = await loadTokens();
  if (!tokens?.refresh_token) throw new Error('No refresh_token stored');
  const url = `${OAUTH_BASE}/v4/oa/access_token`;
  const body = { app_id: APP_ID, app_secret: APP_SECRET, grant_type: 'refresh_token', refresh_token: tokens.refresh_token };
  const { data } = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' }});
  if (!data?.access_token) throw new Error('Refresh failed: no access_token');
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  const newTokens = { access_token: data.access_token, refresh_token: data.refresh_token || tokens.refresh_token, expires_at: expiresAt };
  await saveTokens(newTokens);
  return newTokens;
}

export async function ensureAccessToken() {
  let tokens = await loadTokens();
  if (!tokens) {
    const code = process.env.OAUTH_CODE_ONCE;
    if (!code) throw new Error('No tokens found. Provide OAUTH_CODE_ONCE or run npm run exchange:code');
    tokens = await exchangeCode(code);
  }
  if (isExpired(tokens)) tokens = await refreshToken();
  return tokens.access_token;
}
