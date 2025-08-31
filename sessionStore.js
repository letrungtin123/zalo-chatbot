// sessionStore.js
import "dotenv/config";

const TTL_MIN = Number(process.env.TOPIC_FLOW_TTL_MINUTES || 20);
const TTL_MS  = TTL_MIN * 60 * 1000;

const store = new Map(); // userId -> { stage, data, expiresAt }

function now() { return Date.now(); }
function gc() {
  const t = now();
  for (const [k, v] of store.entries()) {
    if (!v?.expiresAt || v.expiresAt <= t) store.delete(k);
  }
}

export function setState(userId, obj) {
  gc();
  const prev = store.get(userId) || {};
  store.set(userId, {
    ...prev,
    ...obj,
    expiresAt: now() + TTL_MS,
  });
}

export function getState(userId) {
  gc();
  const s = store.get(userId);
  if (!s || s.expiresAt <= now()) return null;
  return s;
}

export function clearState(userId) {
  store.delete(userId);
}
