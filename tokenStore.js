import fs from 'fs-extra';
const FILE = './tokens.json';

export async function loadTokens() {
  if (!await fs.pathExists(FILE)) return null;
  return await fs.readJSON(FILE);
}

export async function saveTokens(tokens) {
  await fs.writeJSON(FILE, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at
  }, { spaces: 2 });
}

export function isExpired(tokens, skewSec = 120) {
  if (!tokens?.expires_at) return true;
  return Date.now() >= (tokens.expires_at - skewSec * 1000);
}
