// subscribersStore.js
import fs from 'fs-extra';

const FILE = './subscribers.json';

async function loadRaw() {
  try {
    const ok = await fs.pathExists(FILE);
    if (!ok) return [];
    const arr = await fs.readJSON(FILE);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveRaw(arr) {
  await fs.writeJSON(FILE, Array.from(new Set(arr)), { spaces: 2 });
}

export async function addSubscriber(userId) {
  if (!userId) return;
  const arr = await loadRaw();
  if (!arr.includes(userId)) {
    arr.push(userId);
    await saveRaw(arr);
  }
}

export async function removeSubscriber(userId) {
  const arr = await loadRaw();
  const next = arr.filter(id => id !== userId);
  await saveRaw(next);
}

export async function getSubscribers() {
  return await loadRaw();
}

export async function countSubscribers() {
  const arr = await loadRaw();
  return arr.length;
}
