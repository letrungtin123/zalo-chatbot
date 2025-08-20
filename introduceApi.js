// introduceApi.js
import axios from "axios";

/** URL lấy dữ liệu giới thiệu/bài viết */
const INTRODUCE_API_URL =
  process.env.INTRODUCE_API_URL || process.env.INTRODUCE_LIST_URL || "";

/** Cache nhẹ để giảm số lần gọi API */
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 phút
let _cache = { ts: 0, items: [] };

/** Chuẩn hóa chuỗi để so khớp: bỏ dấu, thường hóa, gom khoảng trắng */
function normalize(s = "") {
  return s
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // bỏ ký tự đặc biệt
    .replace(/\s+/g, " ")
    .trim();
}

/** Chuyển HTML đơn giản -> Plain text (đủ dùng cho Zalo text) */
function htmlToPlain(html = "") {
  const replaced = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li)>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, "[Hình: $1]\n")
    .replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  return replaced.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Gọi API và trả về mảng item { title, content, ... } */
async function fetchIntroduceItems() {
  if (!INTRODUCE_API_URL) return [];
  const now = Date.now();
  if (_cache.items.length && now - _cache.ts < CACHE_TTL_MS) {
    return _cache.items;
  }
  try {
    const { data } = await axios.get(INTRODUCE_API_URL, { timeout: 15000 });
    const items = Array.isArray(data?.data) ? data.data : [];
    _cache = { ts: now, items };
    return items;
  } catch (e) {
    console.error("[IntroduceAPI] fetch error:", e?.message);
    return [];
  }
}

/**
 * Tìm câu trả lời theo tiêu đề:
 * - so khớp “bao gồm” hai chiều giữa câu hỏi đã chuẩn hóa và title đã chuẩn hóa
 * - trả về text đã strip HTML (rút gọn nếu quá dài)
 */
export async function findIntroduceAnswer(userText) {
  const q = normalize(userText);
  if (!q) return null;

  const items = await fetchIntroduceItems();
  if (!items.length) return null;

  // Ưu tiên match mạnh trước, sau đó match bao gồm
  let best = null;
  for (const it of items) {
    const t = normalize(it?.title || "");
    if (!t) continue;

    // match chính xác 100%
    if (q === t) {
      best = it;
      break;
    }

    // match chứa nhau (câu hỏi chứa title hoặc ngược lại)
    if (q.includes(t) || t.includes(q)) {
      // Lấy cái đầu tiên phù hợp
      if (!best) best = it;
    }
  }

  if (!best) return null;

  const plain = htmlToPlain(best.content || "");
  const MAX_LEN = 3500; // tránh vượt giới hạn tin nhắn
  const text =
    plain.length > MAX_LEN
      ? plain.slice(0, MAX_LEN - 30).trim() + "\n\n(Đã rút gọn…)"
      : plain;

  return {
    title: (best.title || "").trim(),
    answer: text,
  };
}
