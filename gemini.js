// gemini.js
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY   = process.env.GOOGLE_API_KEY;
const MODELNAME = process.env.GEMINI_MODEL || "gemini-1.5-flash";
if (!API_KEY) console.warn("⚠️ Missing GOOGLE_API_KEY in .env");

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: MODELNAME });

// ——— Utils
function normalize(s = "") {
  return s.toLowerCase().normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}
function stripHtml(html = "") {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<p[\s\S]*?>/gi, "")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ——— Trả lời nhanh bằng FAQ cục bộ (companyInfo.json)
function answerFromCompanyFAQ(userText, companyInfo) {
  if (!companyInfo?.faq) return null;
  const q = normalize(userText);

  // duyệt mảng faq: q có thể là string hoặc array
  for (const item of companyInfo.faq) {
    const triggers = Array.isArray(item.q) ? item.q : [item.q];
    for (const t of triggers) {
      if (!t) continue;
      const key = normalize(String(t));
      if (q.includes(key)) return item.a;
    }
  }

  // fallback thêm 1 số pattern phổ biến
  if (/tên (công ty|doanh nghiệp)|bên bạn tên gì/.test(q)) {
    return `Tên công ty: ${companyInfo.name || "—"}`;
  }
  if (/địa chỉ|ở đâu|văn phòng|trụ sở/.test(q)) {
    return `Địa chỉ: ${companyInfo.address || "—"}`;
  }
  if (/giờ làm|giờ mở cửa|thời gian làm việc/.test(q)) {
    return `Giờ làm việc: ${companyInfo.working_hours || "—"}`;
  }
  if (/liên hệ|hotline|số điện thoại|email/.test(q)) {
    const hotline = companyInfo.hotline ? `Hotline: ${companyInfo.hotline}` : "";
    const email   = companyInfo.email   ? `Email: ${companyInfo.email}`   : "";
    return [hotline, email].filter(Boolean).join(" — ") || null;
  }
  if (/dịch vụ|cung cấp gì/.test(q) && Array.isArray(companyInfo.services)) {
    return `Bên mình cung cấp: ${companyInfo.services.join(", ")}`;
  }
  if (/vat|hóa đơn/.test(q)) {
    return "Có, bên mình hỗ trợ xuất hoá đơn VAT.";
  }

  return null;
}

// ——— Tìm trong KB (API Introduce) để trả lời
function answerFromKB(userText, kbDocs) {
  if (!Array.isArray(kbDocs) || kbDocs.length === 0) return null;
  const q = normalize(userText);

  // chấm điểm cực đơn giản theo số từ khóa khớp
  const tokens = q.split(/[^a-z0-9áàảãạăắằẳẵặâấầẩẫậđéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữự]+/i)
                  .filter(t => t.length >= 2);
  function score(text) {
    const T = normalize(text);
    let s = 0;
    for (const t of tokens) if (T.includes(t)) s++;
    return s;
  }

  let best = null;
  for (const d of kbDocs) {
    const s = score(`${d.title}\n${d.contentText}`);
    if (!best || s > best.s) best = { s, doc: d };
  }
  if (!best || best.s === 0) return null;

  // cắt gọn đoạn phù hợp
  const excerpt = best.doc.contentText.length > 1200
    ? best.doc.contentText.slice(0, 1200) + "…"
    : best.doc.contentText;

  // nếu title có ích thì thêm
  const title = best.doc.title ? `**${best.doc.title}**\n` : "";
  return `${title}${excerpt}`;
}

// ——— Kêu Gemini tổng hợp (có context) — dùng khi 2 phương án trên không đủ
async function answerWithGemini(history, userText, companyInfo, kbDocs) {
  const sys = [
    "Bạn là trợ lý hỗ trợ khách hàng của một doanh nghiệp. Trả lời ngắn gọn, lịch sự, ưu tiên tiếng Việt.",
    "Nếu câu hỏi liên quan đến thông tin công ty, ưu tiên dữ liệu trong `companyInfo` và `kb` trước khi suy luận.",
    "Nếu không có thông tin, hãy nói không có sẵn và gợi ý khách để lại thông tin liên hệ."
  ].join("\n");

  const ctx = {
    companyInfo: companyInfo || {},
    kb: (kbDocs || []).slice(0, 6).map(d => ({
      id: d.id, title: d.title, content: d.contentText?.slice(0, 2000) || ""
    }))
  };

  const parts = [
    { text: `SYSTEM:\n${sys}\n\nCONTEXT(JSON):\n${JSON.stringify(ctx, null, 2)}` },
    { text: (history || []).map(m => `${(m.role || "user").toUpperCase()}: ${m.content}`).join("\n").slice(0, 4000) },
    { text: `USER: ${userText}` }
  ];

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts }]
    });
    const txt = result?.response?.text?.() || result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return (txt || "Xin lỗi, hiện chưa có thông tin phù hợp.").trim();
  } catch (e) {
    console.error("Gemini error:", e);
    return "Xin lỗi, hiện chưa có thông tin phù hợp.";
  }
}

// ——— API chính: tổng hợp 3 tầng trả lời
export async function generateReply(history, userText, companyInfo, kbDocs) {
  // 1) FAQ cục bộ
  const local = answerFromCompanyFAQ(userText, companyInfo);
  if (local) return local;

  // 2) Tìm trong KB (API)
  const kb = answerFromKB(userText, kbDocs);
  if (kb) return kb;

  // 3) Gọi Gemini để tổng hợp (có context)
  return await answerWithGemini(history, userText, companyInfo, kbDocs);
}
