// apiClient.js
import "dotenv/config";

const BASE = process.env.INTRO_API_BASE || "";
const PATH = process.env.INTRO_API_PATH || "/api/Introduce/list";
const TIMEOUT = Number(process.env.INTRO_API_TIMEOUT || 8000);

export async function fetchIntroduceList() {
  const url = `${BASE}${PATH}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);

  const headers = {
    Accept: "application/json",
    // Nếu có khóa:
    // "Authorization": `Bearer ${process.env.INTRO_API_KEY}`
  };

  const res = await fetch(url, { headers, signal: ctrl.signal });
  clearTimeout(t);

  if (!res.ok) throw new Error(`API ${url} ${res.status}`);
  const json = await res.json();
  if (!json || !Array.isArray(json.data)) return [];
  return json.data; // mảng các bài như bạn gửi
}
