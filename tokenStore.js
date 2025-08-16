// tokenStore.js
import fs from "fs-extra";
const FILE = "./tokens.json";

export async function loadTokens() {
  try {
    if (!(await fs.pathExists(FILE))) return null;
    return await fs.readJSON(FILE);
  } catch (e) {
    console.error("loadTokens error", e);
    return null;
  }
}

export async function saveTokens(tokens) {
  const data = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at, // ms epoch
  };
  await fs.writeJSON(FILE, data, { spaces: 2 });
}

export function isExpired(tokens, skewSec = 120) {
  if (!tokens?.expires_at) return true;
  return Date.now() >= tokens.expires_at - skewSec * 1000;
}
