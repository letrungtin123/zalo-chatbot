// companyInfo.js
import fs from "fs";
import path from "path";

/** Đọc JSON hồ sơ công ty, fallback an toàn nếu thiếu file/field */
export function loadCompanyInfo(baseDir = process.cwd()) {
  try {
    const p = path.join(baseDir, "companyInfo.json");
    const raw = fs.readFileSync(p, "utf8");
    const info = JSON.parse(raw);
    return sanitizeInfo(info);
  } catch {
    return sanitizeInfo({});
  }
}

function sanitizeInfo(info) {
  return {
    name: info.name || "",
    legal_name: info.legal_name || info.name || "",
    hotline: info.hotline || info.phone || "",
    phone: info.phone || "",
    email: info.email || "",
    website: info.website || "",
    address: info.address || "",
    hours: info.hours || "",
    services: Array.isArray(info.services) ? info.services : [],
    faqs: Array.isArray(info.faqs) ? info.faqs : []
  };
}

/** Tạo system prompt “nhúng kiến thức công ty” cho LLM */
export function buildCompanySystemPrompt(info) {
  const lines = [
    "Bạn là trợ lý OA của doanh nghiệp. Trả lời ngắn gọn, lịch sự, tiếng Việt.",
    "Chỉ dùng dữ liệu ở 'HỒ SƠ DOANH NGHIỆP' phía dưới; nếu người dùng hỏi ngoài phạm vi, hãy nói không chắc & đề nghị chuyển sang CSKH.",
    "",
    "HỒ SƠ DOANH NGHIỆP:",
    `- Tên: ${info.legal_name || info.name || "N/A"}`,
    info.address ? `- Địa chỉ: ${info.address}` : "",
    info.hours ? `- Giờ làm việc: ${info.hours}` : "",
    info.hotline ? `- Hotline: ${info.hotline}` : "",
    info.email ? `- Email: ${info.email}` : "",
    info.website ? `- Website: ${info.website}` : "",
    info.services?.length ? `- Dịch vụ: ${info.services.join(", ")}` : ""
  ].filter(Boolean);
  return lines.join("\n");
}

/** Trả lời nhanh bằng FAQ nếu match câu hỏi phổ biến */
export function answerFromFAQ(text, info) {
  const norm = normalize(text);
  for (const item of info.faqs || []) {
    for (const k of item.q || []) {
      if (norm.includes(normalize(k))) return item.a;
    }
  }
  return null;
}

function normalize(s = "") {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
