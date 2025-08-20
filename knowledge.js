// knowledge.js
import { fetchIntroduceList } from "./apiClient.js";
import { htmlToText } from "html-to-text";

const TTL = Number(process.env.INTRO_CACHE_TTL || 600000); // 10 phút
let cache = { at: 0, docs: [] };

/**
 * Chuyển 1 bài (title + content HTML) => plain text ngắn gọn.
 */
function normalizeDoc(item) {
  const title = (item?.title || "").trim();
  const html = item?.content || "";
  const text = htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: false } },
      { selector: "img", format: "skip" },
    ],
  }).replace(/\n{3,}/g, "\n\n");

  // Giữ bản đầy đủ + bản rút gọn 1200 ký tự cho Zalo
  const short = text.length > 1200 ? text.slice(0, 1150) + "… (rút gọn)" : text;

  return {
    id: item?.id,
    title,
    short,
    full: text,
    type: item?.introduceTypeId || item?.type,
  };
}

/** Refresh cache từ API nếu đã quá TTL */
export async function refreshIntroduceCache(force = false) {
  const now = Date.now();
  if (!force && now - cache.at < TTL && cache.docs.length) return cache.docs;

  try {
    const items = await fetchIntroduceList();
    cache = {
      at: now,
      docs: (items || []).map(normalizeDoc),
    };
  } catch (e) {
    // nếu lỗi, giữ cache cũ
    console.warn("[KB] refresh error:", e.message);
  }
  return cache.docs;
}

/** Lấy docs (đảm bảo đã có cache) */
export async function getDocs() {
  await refreshIntroduceCache(false);
  return cache.docs;
}

/** Tìm nhanh theo keyword: trả top N doc phù hợp */
export async function searchDocs(query, limit = 3) {
  const q = (query || "").toLowerCase();
  const docs = await getDocs();
  if (!q || !docs.length) return [];

  // heuristics: match theo title trước, sau đó tới content
  const scored = docs.map((d) => {
    let score = 0;
    if (d.title?.toLowerCase().includes(q)) score += 5;
    if (d.full?.toLowerCase().includes(q)) score += 1;

    // boost theo “từ điển” đơn giản
    const rules = [
      { k: ["bảo hành", "warranty"], t: /bảo\s*hành|warranty/i, w: 3 },
      { k: ["giới thiệu", "introduce"], t: /giới\s*thiệu|introduce/i, w: 2 },
      { k: ["trung tâm", "địa chỉ"], t: /địa\s*chỉ|trung\s*tâm/i, w: 2 },
    ];
    for (const r of rules) {
      if (r.t.test(q)) score += r.w;
    }
    return { d, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.d);
}
