// subscribersStore.js
import fs from "fs/promises";

const FILE = "./subscribers.json";

export async function loadSubs() {
  try {
    const txt = await fs.readFile(FILE, "utf8");
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? Array.from(new Set(arr)) : [];
  } catch {
    return [];
  }
}

export async function saveSubs(list) {
  const unique = Array.from(new Set(list));
  await fs.writeFile(FILE, JSON.stringify(unique, null, 2));
  return unique;
}

export async function addSub(id) {
  if (!id) return;
  const list = await loadSubs();
  if (!list.includes(id)) {
    list.push(id);
    await saveSubs(list);
  }
}

export async function removeSub(id) {
  const list = await loadSubs();
  const next = list.filter((x) => x !== id);
  await saveSubs(next);
}
