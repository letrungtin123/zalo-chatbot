// knowledge.js
import "dotenv/config";

// ===== Config =====
const INTRO_API_URL_ENV = process.env.INTRO_API_URL || "";
const INTRO_API_BASE    = process.env.INTRO_API_BASE || "";
const INTRO_API_PATH    = process.env.INTRO_API_PATH || "/api/Introduce/list";
const REFRESH_SECONDS   = Number(process.env.KB_REFRESH_SECONDS || 1800); // 30'
let   lastFetchAt = 0;

function buildIntroduceUrl() {
  // Ưu tiên full URL
  if (INTRO_API_URL_ENV) return INTRO_API_URL_ENV.trim();

  // Nếu không có, ghép BASE + PATH
  if (!INTRO_API_BASE) {
    throw new Error(
      "Missing INTRO_API_URL or INTRO_API_BASE. Set INTRO_API_URL=https://host:port/api/Introduce/list " +
      "OR INTRO_API_BASE=https://host:port and INTRO_API_PATH=/api/Introduce/list"
    );
  }
  // new URL sẽ tự xử lý dấu '/'
  return new URL(INTRO_API_PATH, INTRO_API_BASE).toString();
}

// ===== In-memory cache =====
let DOCS = []; // { id, title, contentText, raw }

export async function refreshIntroduceCache(force = false) {
  const now = Date.now();
  if (!force && now - lastFetchAt < REFRESH_SECONDS * 1000) return DOCS;

  const url = buildIntroduceUrl();
  try {
    console.log("[KB] fetching:", url);
    const r = await fetch(url, { method: "GET" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const j = await r.json();

    const list = Array.isArray(j?.data) ? j.data : [];
    // Convert HTML -> text “thô” rất đơn giản
    const strip = (html) =>
      (html || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\u00a0/g, " ")
        .trim();

    DOCS = list.map((it) => ({
      id: it.id,
      title: it.title || "",
      contentText: strip(it.content || ""),
      raw: it,
    }));

    lastFetchAt = now;
    console.log(`[KB] refreshed. docs=${DOCS.length}`);
    return DOCS;
  } catch (e) {
    console.error("[KB] refresh error:", e.message);
    if (DOCS.length === 0) throw e; // lần đầu mà fail thì ném lỗi ra
    return DOCS; // có cache cũ thì cứ trả tạm
  }
}

export async function getDocs() {
  if (DOCS.length === 0) await refreshIntroduceCache(true);
  return DOCS;
}

// Search rất đơn giản: score theo số lần khớp từ
export async function searchDocs(query, topK = 3) {
  if (!query || !query.trim()) return [];
  await refreshIntroduceCache();
  const q = query.toLowerCase();

  const scored = DOCS.map((d) => {
    const hay = (d.title + " " + d.contentText).toLowerCase();
    // điểm = số lần xuất hiện các keyword chính
    let score = 0;
    for (const token of q.split(/\s+/).filter(Boolean)) {
      if (hay.includes(token)) score++;
    }
    return { d, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.d);

  return scored;
}
