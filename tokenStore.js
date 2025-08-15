import fs from 'fs-extra';
const FILE = './tokens.json';

export async function loadTokens() {
  try {
    const ok = await fs.pathExists(FILE);
    if (!ok) return null;
    const data = await fs.readJSON(FILE);
    return data;
  } catch (e) {
    console.error('loadTokens error', e);
    return null;
  }
}

export async function saveTokens(tokens) {
  const data = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at // ms epoch
  };
  await fs.writeJSON(FILE, data, { spaces: 2 });
}

export function isExpired(tokens, skewSec = 120) {
  if (!tokens?.expires_at) return true;
  const now = Date.now();
  return now >= (tokens.expires_at - skewSec * 1000);
}
